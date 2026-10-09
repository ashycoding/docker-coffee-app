const express = require("express");
const os = require("os");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// Connection settings from environment variables
const pool = new Pool({
  host: process.env.DB_HOST || "db",
  port: 5432,
  user: process.env.DB_USER || "dockside",
  password: process.env.DB_PASSWORD || "dockside",
  database: process.env.DB_NAME || "dockside",
});

const STATUSES = ["placed", "packed", "shipped", "delivered"];
const FREE_SHIPPING_OVER = 499; // ₹ Indian Rupees
const SHIPPING_FEE = 60;

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("API error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

// ---------- Health & Container Diagnostics ----------
app.get("/api/health", wrap(async (req, res) => {
  let db = { ok: false, products: 0 };
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM products");
    db = { ok: true, products: r.rows[0].n };
  } catch (err) {
    console.error("Health check: database unreachable:", err.message);
  }
  res.json({
    api: { ok: true, host: os.hostname(), uptime: Math.round(process.uptime()), brand: "ROAST & RITUAL" },
    db,
  });
}));

// ---------- Products List with Smart Multi-Filtering ----------
app.get("/api/products", wrap(async (req, res) => {
  const { category, subcategory, q, sort, temperature, strength, sweetness, dietary, min_price, max_price } = req.query;
  const where = [];
  const params = [];

  if (category && category !== "All") {
    params.push(String(category));
    where.push(`category = $${params.length}`);
  }
  if (subcategory) {
    params.push(String(subcategory));
    where.push(`subcategory = $${params.length}`);
  }
  if (temperature && temperature !== "All") {
    params.push(String(temperature));
    where.push(`(temperature = $${params.length} OR temperature = 'Both')`);
  }
  if (strength && !isNaN(Number(strength))) {
    params.push(Number(strength));
    where.push(`strength = $${params.length}`);
  }
  if (sweetness && !isNaN(Number(sweetness))) {
    params.push(Number(sweetness));
    where.push(`sweetness = $${params.length}`);
  }
  if (dietary === "vegan") {
    where.push(`vegan = true`);
  }
  if (min_price && !isNaN(Number(min_price))) {
    params.push(Number(min_price));
    where.push(`price >= $${params.length}`);
  }
  if (max_price && !isNaN(Number(max_price))) {
    params.push(Number(max_price));
    where.push(`price <= $${params.length}`);
  }
  if (q) {
    const cleanQ = String(q).trim().slice(0, 80);
    params.push("%" + cleanQ + "%");
    const n = params.length;
    where.push(`(name ILIKE $${n} OR notes ILIKE $${n} OR origin ILIKE $${n} OR description ILIKE $${n} OR category ILIKE $${n})`);
  }

  const orderMap = {
    price_asc: "price ASC",
    price_desc: "price DESC",
    rating: "rating DESC, reviews DESC",
    name: "name ASC",
    newest: "id DESC",
  };
  const orderBy = orderMap[sort] || "featured DESC, rating DESC, id ASC";
  const sql = `SELECT * FROM products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

app.get("/api/products/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Product not found." });
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
  if (!rows.length) return res.status(404).json({ error: "Product not found." });
  res.json(rows[0]);
}));

// ---------- Orders & Checkout ----------
app.post("/api/orders", wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80);
  const email = str(b.email, 120);
  const phone = str(b.phone, 20);
  const address = str(b.address, 200);
  const city = str(b.city, 60);
  const pincode = str(b.pincode, 10);
  const notes = str(b.notes, 250);

  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !address || !city || !/^\d{6}$/.test(pincode)) {
    return res.status(400).json({
      error: "Please enter your full name, a valid email, delivery address, city, and 6-digit Indian PIN code.",
    });
  }

  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > 50) {
    return res.status(400).json({ error: "Your cart is empty." });
  }

  const itemMap = new Map();
  for (const it of items) {
    const id = Number(it.id);
    const qty = Number(it.qty);
    const custom = it.custom || {};
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return res.status(400).json({ error: "Invalid item in cart." });
    }
    itemMap.set(id, { qty, custom, extraPrice: Number(custom.extraPrice || 0) });
  }

  const { rows: products } = await pool.query(
    "SELECT id, name, price FROM products WHERE id = ANY($1::int[])",
    [[...itemMap.keys()]]
  );
  if (products.length !== itemMap.size) {
    return res.status(400).json({ error: "Some products in your order are currently unavailable." });
  }

  let subtotal = 0;
  for (const p of products) {
    const it = itemMap.get(p.id);
    const lineUnitPrice = p.price + (it.extraPrice || 0);
    subtotal += lineUnitPrice * it.qty;
  }

  const discount = b.discountCode === "ROAST10" ? Math.round(subtotal * 0.10) : (b.discountCode === "FIRSTCUP" ? 50 : 0);
  const adjustedSubtotal = Math.max(0, subtotal - discount);
  const shipping = adjustedSubtotal >= FREE_SHIPPING_OVER || adjustedSubtotal === 0 ? 0 : SHIPPING_FEE;
  const total = adjustedSubtotal + shipping;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query(
      `INSERT INTO orders (name, email, phone, address, city, pincode, subtotal, shipping, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'placed') RETURNING id`,
      [name, email, phone, address, city, pincode, subtotal, shipping, total]
    );
    const orderId = orderRes.rows[0].id;

    for (const p of products) {
      const it = itemMap.get(p.id);
      const lineUnitPrice = p.price + (it.extraPrice || 0);
      const customNotes = it.custom ? JSON.stringify(it.custom) : "";
      await client.query(
        "INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES ($1,$2,$3,$4,$5)",
        [orderId, p.id, `${p.name}${it.custom?.size ? ' (' + it.custom.size + ')' : ''}`, lineUnitPrice, it.qty]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ id: orderId, total });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}));

app.get("/api/orders", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, (SELECT COALESCE(SUM(qty), 0)::int FROM order_items WHERE order_id = o.id) AS items
     FROM orders o ORDER BY o.id DESC LIMIT 50`
  );
  res.json(rows);
}));

app.get("/api/orders/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Order not found." });
  const order = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (!order.rows.length) return res.status(404).json({ error: "Order not found." });
  const items = await pool.query(
    `SELECT oi.product_id, oi.name, oi.price, oi.qty, p.category, p.color, p.origin, p.roast, p.image_url
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY oi.id`,
    [id]
  );
  res.json({ ...order.rows[0], lines: items.rows });
}));

app.patch("/api/orders/:id", wrap(async (req, res) => {
  const status = req.body && req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status." });
  const r = await pool.query("UPDATE orders SET status = $1 WHERE id = $2 RETURNING id, status", [
    status,
    Number(req.params.id),
  ]);
  if (!r.rows.length) return res.status(404).json({ error: "Order not found." });
  res.json(r.rows[0]);
}));

// ---------- Contact Messages ----------
app.post("/api/messages", wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 120);
  const message = str(req.body.message, 1000);
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || message.length < 5) {
    return res.status(400).json({ error: "Please enter your name, email, and message." });
  }
  await pool.query("INSERT INTO messages (name, email, message) VALUES ($1,$2,$3)", [name, email, message]);
  res.status(201).json({ ok: true });
}));

app.get("/api/messages", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM messages ORDER BY id DESC LIMIT 50");
  res.json(rows);
}));

// ---------- Admin Summary ----------
app.get("/api/summary", wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COALESCE(SUM(total), 0)::int FROM orders) AS revenue,
      (SELECT COUNT(*)::int FROM messages) AS messages,
      (SELECT COUNT(*)::int FROM products) AS products
  `);
  res.json(rows[0]);
}));

// =========================================================================
// 42+ Premium Products (Hot Coffee, Cold Coffee, Specialty, Matcha, Beans, Gear)
// =========================================================================
const SEED_PRODUCTS = [
  // --- 1. Coffee Classics (Hot) ---
  [
    "Signature Single-Origin Espresso", "Coffee Classics", "Espresso", 140, 160, "Single (30ml)",
    "Chikmagalur, Karnataka", "Medium-Dark", "Dark Chocolate, Honey, Caramelized Walnut",
    "Extracted under 9 bars of pressure from single-estate Chikmagalur Arabica. Velvety golden-brown crema with a dense, syrupy body.",
    "#2c1d11", true, "https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?auto=format&fit=crop&w=800&q=80",
    4.9, 342, 5, 0, "High", "Hot", true, "None", "1 Shot Double Ristretto Espresso", "1 : 0", 2, "Bestseller"
  ],
  [
    "Classic Americano", "Coffee Classics", "Americano", 170, 190, "Regular (240ml)",
    "Western Ghats, India", "Medium", "Dark Cocoa, Roasted Almond, Clean Crisp Finish",
    "Double shot of single-estate espresso diluted with purified hot water. Strong, clean and coffee-forward without milky heaviness.",
    "#1e1510", false, "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=800&q=80",
    4.7, 218, 4, 0, "High", "Both", true, "None", "2 Shots Espresso, Hot Filtered Water", "1 : 2", 5, "Popular"
  ],
  [
    "Artisanal Cappuccino", "Coffee Classics", "Cappuccino", 220, 250, "Regular (200ml)",
    "Coorg, Karnataka", "Medium", "Rich, Velvety, Balanced Cocoa & Vanilla",
    "The quintessential balance of intense espresso, sweet steamed milk, and a dense, pillow-soft microfoam dome dusted with cocoa.",
    "#3d271d", true, "https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&w=800&q=80",
    4.8, 512, 4, 1, "Medium-High", "Hot", false, "Dairy / Plant Milk", "1 Shot Espresso, Steamed Whole Milk, Velvety Milk Foam", "1 : 1 : 1", 130, "Bestseller"
  ],
  [
    "Silky Café Latte", "Coffee Classics", "Latte", 240, 270, "Regular (280ml)",
    "Araku Valley, Andhra Pradesh", "Medium-Light", "Smooth Caramel, Sweet Butter, Light Spice",
    "Generous steamed milk poured smoothly over a rich espresso base with a delicate layer of microfoam. Milkier, gentler, and ultra-smooth.",
    "#4a3225", true, "https://images.unsplash.com/photo-1561882468-9110e03e0f78?auto=format&fit=crop&w=800&q=80",
    4.8, 430, 3, 2, "Medium", "Both", false, "Dairy / Plant Milk", "1 Shot Espresso, Steamed Milk, Microfoam", "1 : 3 : 1", 165, "Bestseller"
  ],
  [
    "Melbourne-Style Flat White", "Coffee Classics", "Flat White", 250, 280, "Regular (180ml)",
    "Nilgiris, Tamil Nadu", "Medium", "Bold Espresso, Nutty, Silky Microfoam",
    "Double ristretto combined with finely textured microfoam without stiff froth. Intensely coffee-forward yet luxurious and smooth.",
    "#341f17", false, "https://images.unsplash.com/photo-1577968897966-3d4325b36b61?auto=format&fit=crop&w=800&q=80",
    4.9, 189, 4, 1, "High", "Hot", false, "Dairy / Plant Milk", "2 Shots Ristretto Espresso, Steamed Microfoam", "1 : 2 : 0", 125, "Staff Pick"
  ],
  [
    "Belgian Dark Chocolate Mocha", "Coffee Classics", "Mocha", 280, 310, "Regular (260ml)",
    "Coorg & West Africa Cocoa", "Medium-Dark", "Rich 70% Dark Cocoa, Espresso, Sweet Cream",
    "A harmonious meeting of rich double espresso and artisanal melted dark Belgian chocolate, crowned with textured steamed milk and cocoa nibs.",
    "#23140e", true, "https://images.unsplash.com/photo-1578314675249-a6910f80cc4e?auto=format&fit=crop&w=800&q=80",
    4.9, 380, 3, 3, "Medium", "Both", false, "Dairy / Plant Milk", "1 Shot Espresso, 70% Belgian Chocolate, Steamed Milk, Foam", "1 : 1 : 2", 260, "Popular"
  ],
  [
    "Spanish Cortado", "Coffee Classics", "Cortado", 210, 230, "Small (120ml)",
    "Chikmagalur, Karnataka", "Medium-Dark", "Dark Cocoa, Roasted Hazelnut, Low Acidity",
    "Equal parts robust espresso and lightly steamed warm milk. Cuts the sharpness of espresso while preserving pure coffee strength.",
    "#2b1c13", false, "https://images.unsplash.com/photo-1534778101976-62847782c213?auto=format&fit=crop&w=800&q=80",
    4.8, 145, 4, 1, "High", "Hot", false, "Dairy / Plant Milk", "2 Shots Espresso, Warm Steamed Milk", "1 : 1 : 0", 70, "Classic"
  ],
  [
    "Espresso Macchiato", "Coffee Classics", "Macchiato", 190, 210, "Small (60ml)",
    "Shevaroy Hills, Tamil Nadu", "Dark", "Intense Dark Roasting, Molasses, Milk Stained",
    "A single shot of dark espresso 'marked' or stained with a single spoonful of velvety milk froth. Pure intensity with a soft edge.",
    "#1d120c", false, "https://images.unsplash.com/photo-1485808191679-5f86510681a2?auto=format&fit=crop&w=800&q=80",
    4.7, 98, 5, 0, "Very High", "Hot", false, "Dairy", "1 Shot Espresso, Dollop of Steamed Froth", "1 : 0.3", 25, "Classic"
  ],
  [
    "Traditional Kumbakonam Filter Kaapi", "Coffee Classics", "Filter Coffee", 150, 180, "Regular (150ml)",
    "Kumbakonam, Tamil Nadu", "Dark", "Chicory Blend, Caramelized Jaggery, Malty",
    "Brewed in brass gravity filters with 80:20 Plantation A Arabica & roasted chicory, frothed with boiled full-cream milk in a brass davarah.",
    "#3a2012", true, "https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=800&q=80",
    4.9, 620, 4, 2, "High", "Hot", false, "Full Cream Dairy", "Dark Brass Decoction, Frothy Boiled Milk, Sugar", "1 : 2 : 0", 150, "Heritage"
  ],

  // --- 2. Cold Coffee & Cold Brews ---
  [
    "Signature 18-Hour Single-Origin Cold Brew", "Cold Coffee", "Cold Brew", 260, 290, "Bottle (300ml)",
    "Wayanad & Coorg Estates", "Medium", "Dark Chocolate, Cherry, Mellow Malt, Zero Bitterness",
    "Steeped slowly in cold mountain-filtered water for 18 hours. Ultra-smooth, naturally sweet, and refreshing with low acidity.",
    "#120a06", true, "https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=800&q=80",
    4.9, 410, 4, 0, "High", "Cold", true, "None", "18-Hour Slow Steeped Arabica Coffee", "1 : 0", 10, "Bestseller"
  ],
  [
    "Nitro Cold Brew on Tap", "Cold Coffee", "Cold Brew", 295, 330, "Glass (330ml)",
    "Araku Valley, Andhra Pradesh", "Light-Medium", "Cascading Velvety Crema, Berry, Stout Creaminess",
    "Cold brew infused with pure nitrogen bubbles to create a silky, stout-like cascading microfoam head. Served chilled without ice.",
    "#160e0a", false, "https://images.unsplash.com/photo-1594631252845-29fc4cc8cde9?auto=format&fit=crop&w=800&q=80",
    4.8, 175, 5, 0, "Very High", "Cold", true, "None", "Nitrogen Infused Single-Origin Cold Brew", "1 : 0", 10, "Premium"
  ],
  [
    "Classic Iced Latte", "Cold Coffee", "Iced Latte", 250, 280, "Glass (350ml)",
    "Chikmagalur, Karnataka", "Medium", "Fresh Espresso, Chilled Milk, Ice Blocks",
    "Double espresso poured over chilled fresh dairy or plant milk and crystalline ice cubes. Crisp, milky, and instantly revitalizing.",
    "#3e2b20", false, "https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=800&q=80",
    4.7, 290, 3, 2, "Medium", "Cold", false, "Dairy / Plant Milk", "2 Shots Espresso, Chilled Milk, Clear Ice", "1 : 3 : 0", 145, "Popular"
  ],
  [
    "Iced Americano on the Rocks", "Cold Coffee", "Iced Americano", 190, 220, "Glass (350ml)",
    "Western Ghats, India", "Medium-Dark", "Bold, Crisp, Roasted Cocoa, Citrus Note",
    "Double shot espresso poured directly over iced mineral water. Crisp, bold, zero sugar, and deeply refreshing on warm afternoons.",
    "#180f0a", false, "https://images.unsplash.com/photo-1551030173-122aabc4489c?auto=format&fit=crop&w=800&q=80",
    4.7, 185, 4, 0, "High", "Cold", true, "None", "Double Espresso, Chilled Mineral Water, Ice", "1 : 2 : 0", 5, "Budget"
  ],
  [
    "Madagascar Vanilla Sweet Cream Cold Brew", "Cold Coffee", "Cold Brew", 310, 350, "Glass (350ml)",
    "Nilgiris & Madagascar", "Medium", "Bourbon Vanilla, Heavy Sweet Cream, Rich Cocoa",
    "Our signature 18-hour cold brew topped with a thick layer of house-whipped Madagascar vanilla sweet cream foam.",
    "#312017", true, "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=80",
    4.9, 360, 4, 3, "High", "Cold", false, "Sweet Vanilla Cream", "18-hr Cold Brew, Handcrafted Vanilla Cream Float", "2 : 1", 180, "Bestseller"
  ],
  [
    "Iced Dark Mocha Chiller", "Cold Coffee", "Iced Mocha", 295, 330, "Glass (350ml)",
    "Coorg, Karnataka", "Dark", "Bittersweet Chocolate, Espresso, Cream",
    "Chilled espresso blended with melted 70% dark cocoa, cold milk, and crushed ice, finished with shaved dark chocolate curls.",
    "#261811", false, "https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&w=800&q=80",
    4.8, 240, 3, 3, "Medium", "Cold", false, "Dairy / Plant Milk", "Espresso, Artisan Dark Cocoa, Chilled Milk, Ice", "1 : 1 : 2", 270, "Popular"
  ],
  [
    "Espresso Tonic Botanical Spritz", "Cold Coffee", "Specialty Cold", 280, 310, "Glass (300ml)",
    "Araku Valley, Andhra Pradesh", "Light", "Citrus, Quinine Fizz, Berry Notes",
    "Double shot of floral light-roast espresso layered over sparkling Indian craft tonic water and fresh orange wheel zest.",
    "#302118", false, "https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=800&q=80",
    4.8, 120, 4, 1, "High", "Cold", true, "None", "Light Roast Espresso, Artisanal Tonic Water, Fresh Orange", "1 : 2", 60, "Staff Pick"
  ],

  // --- 3. Specialty / Modern Lattes ---
  [
    "Spanish Latte (Café con Leche)", "Specialty / Modern", "Spanish Latte", 320, 360, "Regular (260ml)",
    "Chikmagalur, Karnataka", "Medium", "Sweet Condensed Milk, Cinnamon, Golden Honey",
    "Silky steamed milk combined with sweet condensed milk, layered beneath double shots of intense espresso and dusted with Ceylon cinnamon.",
    "#432b1e", true, "https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=800&q=80",
    4.9, 480, 4, 3, "Medium-High", "Both", false, "Dairy + Condensed Milk", "2 Shots Espresso, Condensed Milk, Steamed Whole Milk", "1 : 1 : 2", 240, "Bestseller"
  ],
  [
    "Roasted Pistachio Silk Latte", "Specialty / Modern", "Pistachio Latte", 360, 410, "Regular (260ml)",
    "Nilgiris & Iranian Pistachios", "Light-Medium", "Real Roasted Pistachio Paste, Cardamom, Sweet Cream",
    "Crafted with pure stone-ground roasted pistachio butter, double espresso, and micro-steamed milk, topped with crushed green pistachios.",
    "#384029", true, "https://images.unsplash.com/photo-1577968897966-3d4325b36b61?auto=format&fit=crop&w=800&q=80",
    4.9, 390, 3, 3, "Medium", "Both", false, "Dairy / Oat Milk", "Double Espresso, Stoneground Pistachio Paste, Steamed Milk", "1 : 1 : 2", 280, "Luxury"
  ],
  [
    "Sea Salt Caramel Velvet Latte", "Specialty / Modern", "Caramel Latte", 310, 340, "Regular (260ml)",
    "Coorg, Karnataka", "Medium", "Slow-Cooked Caramel, Fleur de Sel, Toffee",
    "Hand-crafted sea salt caramel sauce folded into fresh double espresso and velvety microfoam with a rich buttery finish.",
    "#4e321d", false, "https://images.unsplash.com/photo-1578314675249-a6910f80cc4e?auto=format&fit=crop&w=800&q=80",
    4.8, 310, 3, 3, "Medium", "Both", false, "Dairy / Plant Milk", "Double Espresso, Salted Caramel Sauce, Steamed Milk", "1 : 1 : 2", 250, "Popular"
  ],
  [
    "Hazelnut Praline Café Latte", "Specialty / Modern", "Hazelnut Latte", 300, 330, "Regular (260ml)",
    "Western Ghats, India", "Medium", "Toasted Hazelnut, Brown Sugar, Milk Chocolate",
    "Roasted hazelnut reduction blended with creamy steamed milk and fresh espresso. Warm, nutty, and comforting.",
    "#40281b", false, "https://images.unsplash.com/photo-1561882468-9110e03e0f78?auto=format&fit=crop&w=800&q=80",
    4.7, 215, 3, 3, "Medium", "Both", false, "Dairy / Plant Milk", "Double Espresso, Hazelnut Syrup, Steamed Milk", "1 : 1 : 2", 230, "Popular"
  ],
  [
    "Coconut Cardamom Cold Brew", "Specialty / Modern", "Coconut Cold Brew", 330, 370, "Glass (350ml)",
    "Malabar Coast & Kerala", "Medium-Dark", "Fresh Coconut Milk, Green Elaichi, Palm Jaggery",
    "18-hour Malabar cold brew shaken with fresh tender coconut milk and a whisper of hand-crushed green cardamom.",
    "#3c3228", false, "https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=800&q=80",
    4.8, 160, 4, 2, "High", "Cold", true, "Coconut Milk", "Cold Brew, Fresh Coconut Milk, Green Cardamom", "2 : 1", 140, "Staff Pick"
  ],

  // --- 4. Matcha & Botanical Teas (NOT COFFEE - Tea Powder) ---
  [
    "Ceremonial Uji Matcha Latte (Green Tea - No Coffee)", "Matcha & Tea", "Matcha Latte", 280, 320, "Regular (260ml)",
    "Kyoto, Japan (1st Harvest)", "N/A (Green Tea)", "Grassy, Umami, Sweet Floral, Creamy",
    "IMPORTANT: Matcha is 100% shade-grown finely ground green tea leaves, NOT a coffee bean. Whisked with bamboo chasen and folded with creamy steamed milk.",
    "#2e4a36", true, "https://images.unsplash.com/photo-1536256263959-770b48d82b0a?auto=format&fit=crop&w=800&q=80",
    4.9, 440, 2, 2, "Medium", "Both", false, "Dairy / Oat Milk", "Ceremonial Uji Matcha Powder, Steamed Milk, Honey", "1 : 3", 120, "Specialty Tea"
  ],
  [
    "The Dirty Matcha (Matcha + Espresso Fusion)", "Matcha & Tea", "Dirty Matcha", 320, 360, "Regular (280ml)",
    "Kyoto Matcha + Chikmagalur Espresso", "Medium", "Earthy Green Tea, Bold Espresso, Sweet Milk",
    "The best of both worlds: Vibrant ceremonial green tea matcha whisked with milk, topped with a floating double shot of rich Indian espresso.",
    "#3a4430", true, "https://images.unsplash.com/photo-1517256064527-09c73fc73e38?auto=format&fit=crop&w=800&q=80",
    4.9, 310, 4, 2, "High", "Both", false, "Dairy / Oat Milk", "Ceremonial Matcha, Steamed Milk, 1 Shot Espresso", "1 : 2 : 1", 150, "Bestseller"
  ],
  [
    "Iced Strawberry Cloud Matcha", "Matcha & Tea", "Iced Matcha", 350, 390, "Glass (350ml)",
    "Kyoto Matcha & Mahabaleshwar Berries", "N/A (Green Tea)", "Sweet Strawberry, Umami Green Tea, Silky Cold Foam",
    "Layered iced specialty beverage: Crushed Mahabaleshwar strawberry puree on bottom, chilled oat milk in center, vibrant green ceremonial matcha on top.",
    "#4c5c3e", false, "https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=800&q=80",
    4.8, 210, 2, 3, "Medium", "Cold", true, "Oat Milk", "Fresh Strawberry Puree, Oat Milk, Whisked Matcha", "1 : 2 : 1", 170, "Popular"
  ],

  // --- 5. Whole Bean Coffee & Estate Micro-Lots ---
  [
    "Chikmagalur Baba Budangiri Estate Arabica (250g)", "Coffee Beans", "Whole Bean", 549, 599, "250g Bag",
    "Chikmagalur, Karnataka (1400m)", "Medium", "Jasmine, Cardamom, Toasted Hazelnut, Cane Sugar",
    "Grown in the birthplace of Indian coffee under native silver oak canopy. Single-estate handpicked beans with a sparkling floral-chocolate profile.",
    "#2c1d11", true, "https://images.unsplash.com/photo-1587734195503-904fca47e0e9?auto=format&fit=crop&w=800&q=80",
    4.9, 420, 4, 1, "High", "Hot", true, "None", "100% Washed Plantation Arabica Beans", "Whole Beans", 0, "Estate Origin"
  ],
  [
    "Coorg Peaberry Heritage Reserve (250g)", "Coffee Beans", "Whole Bean", 499, 549, "250g Bag",
    "Coorg, Karnataka (1200m)", "Medium-Dark", "Caramel, Dark Cocoa, Ripe Plum, Thick Crema",
    "Rare single round peaberry beans that absorb intense nutrients from Kodagu volcanic soil. Delivers an unmatched dense body and golden crema.",
    "#342016", true, "https://images.unsplash.com/photo-1610632380989-680fe40816c6?auto=format&fit=crop&w=800&q=80",
    4.9, 390, 4, 1, "High", "Hot", true, "None", "100% Sun-Dried Peaberry Arabica", "Whole Beans", 0, "Bestseller"
  ],
  [
    "Araku Valley Tribal Organic Micro-Lot (250g)", "Coffee Beans", "Whole Bean", 649, 720, "250g Bag",
    "Eastern Ghats, Andhra Pradesh (1100m)", "Light-Medium", "Wild Berries, Honey, Citrus, Sugarcane",
    "Award-winning specialty coffee farmed organically by indigenous Adivasi cooperatives in Araku Valley. Naturally sweet with delicate fruit acidity.",
    "#3d2b1f", true, "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=800&q=80",
    4.8, 270, 3, 2, "Medium", "Both", true, "None", "100% Organic Naturally Processed Arabica", "Whole Beans", 0, "Organic"
  ],
  [
    "Nilgiri Blue Mountain Reserve (250g)", "Coffee Beans", "Whole Bean", 699, 780, "250g Bag",
    "Ooty & Coonoor, Tamil Nadu (1800m)", "Light", "Bergamot, Sweet Lime, Green Apple, Jasmine Tea",
    "Ultra-high-elevation coffee grown on mist-covered tea-and-coffee slopes of the Nilgiris. Clean, crisp acidity with an elegant floral tea finish.",
    "#432e22", false, "https://images.unsplash.com/photo-1511920170033-f8396924c348?auto=format&fit=crop&w=800&q=80",
    4.8, 180, 3, 1, "Medium", "Hot", true, "None", "100% High Elevation Washed Arabica", "Whole Beans", 0, "Specialty"
  ],
  [
    "Monsooned Malabar AA Aged Reserve (250g)", "Coffee Beans", "Whole Bean", 599, 660, "250g Bag",
    "Malabar Coast, Kerala (900m)", "Medium-Dark", "Malted Barley, Baker's Chocolate, Tobacco, Spice",
    "Unique monsoon-cured beans exposed to Arabian Sea winds for months. Swollen golden beans with zero acidity and heavy, syrupy mouthfeel.",
    "#483020", false, "https://images.unsplash.com/photo-1498804103079-a6351b050096?auto=format&fit=crop&w=800&q=80",
    4.7, 240, 4, 1, "Medium-High", "Both", true, "None", "100% Monsooned Processed Arabica", "Whole Beans", 0, "Heritage"
  ],
  [
    "Wayanad Kaapi Royale Dark Roast (250g)", "Coffee Beans", "Whole Bean", 449, 499, "250g Bag",
    "Wayanad, Kerala (1000m)", "Dark", "Molasses, Toasted Cacao, Black Pepper, Heavy Body",
    "Highest grade R-Robusta beans from the rain-drenched Western Ghats. Heavy-bodied and bold, formulated specifically for strong milk kaapi.",
    "#20120a", false, "https://images.unsplash.com/photo-1559056199-641a0ac8b55e?auto=format&fit=crop&w=800&q=80",
    4.6, 310, 5, 0, "Very High", "Hot", true, "None", "100% Estate Washed Robusta Kaapi Royale", "Whole Beans", 0, "Budget"
  ],
  [
    "Panama Boquete Geisha Grand Reserve (100g)", "Coffee Beans", "Luxury Specialty", 1450, 1650, "100g Tin",
    "Boquete, Panama (1900m)", "Ultra-Light", "Jasmine Blossoms, Bergamot, White Peach, Papaya",
    "The crown jewel of specialty coffee worldwide. Rare Geisha varietal with an intoxicating perfume aroma, sublime cup clarity, and lingering floral tea sweetness.",
    "#543825", true, "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=800&q=80",
    5.0, 95, 2, 2, "Medium", "Hot", true, "None", "100% Anaerobic Fermentation Geisha Varietal", "Whole Beans", 0, "Luxury"
  ],

  // --- 6. Artisanal Gear & Luxury Gift Boxes ---
  [
    "Traditional Kumbakonam Pure Brass Kaapi Filter Set", "Gear & Gifts", "Brewing Gear", 1499, 1799, "Set (2-Cup)",
    "Kumbakonam, Tamil Nadu", null, "Pure Solid Brass, 2-Cup Decoction Press, Traditional Davarah",
    "Authentic hand-cast heavy brass South Indian coffee filter with matching Davarah and Tumbler set. Yields the quintessential thick decoction.",
    "#c88d51", true, "https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=800&q=80",
    4.9, 290, 0, 0, "None", "Hot", true, "N/A", "Solid Heavy Brass Filter, Plunger, Davarah, Tumbler", "Gear", 0, "Heritage Gear"
  ],
  [
    "Precision CNC Steel Burr Manual Hand Grinder", "Gear & Gifts", "Brewing Gear", 2999, 3499, "Unit",
    "Engineered in India", null, "420 Stainless Steel Burrs, 40 Precision Clicks, Dual Bearings",
    "Ultra-uniform particle size from fine South Indian decoction and espresso to coarse cold brew. Solid aluminum unibody build with wood handle.",
    "#2b2b2b", true, "https://images.unsplash.com/photo-1517668808822-9ebb02f2a0e6?auto=format&fit=crop&w=800&q=80",
    4.9, 195, 0, 0, "None", "Both", true, "N/A", "Aircraft Grade Aluminum, CNC Stainless Burrs", "Gear", 0, "Barista Gear"
  ],
  [
    "Matte Black Gooseneck Pour-Over Kettle (1.0L)", "Gear & Gifts", "Brewing Gear", 2199, 2599, "1.0 Litre",
    "Precision Craft", null, "1.0L Capacity, Ergonomic Precision Spout, 304 Food-Grade Steel",
    "Counterbalanced handle and curved swan spout offer millimeter-precise water flow control for optimal coffee bloom and extraction.",
    "#1e1e1e", false, "https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=800&q=80",
    4.8, 140, 0, 0, "None", "Hot", true, "N/A", "304 Stainless Steel with Matte Heat-Resistant Coating", "Gear", 0, "Barista Gear"
  ],
  [
    "Khurja Studio Handcrafted Ceramic Artisan Mug (380ml)", "Gear & Gifts", "Drinkware", 649, 799, "380ml",
    "Khurja, Uttar Pradesh", null, "Studio Pottery, Reactive Glaze, Dishwasher & Microwave Safe",
    "Individually wheel-thrown and wood-fired by generational pottery masters of Khurja, UP. Thick ceramic walls retain coffee heat flawlessly.",
    "#463529", false, "https://images.unsplash.com/photo-1517256064527-09c73fc73e38?auto=format&fit=crop&w=800&q=80",
    4.9, 220, 0, 0, "None", "Both", true, "N/A", "Natural Ceramic Glaze Clay", "Mug", 0, "Artisan"
  ],
  [
    "The Grand Connoisseur Luxury Coffee Gift Box", "Gear & Gifts", "Gift Box", 2499, 2999, "Complete Set",
    "Curated Collection", null, "2 Single-Origin Coffees (500g), Pure Brass Filter, Khurja Mug",
    "The ultimate coffee lover's hamper: 250g Chikmagalur Arabica, 250g Coorg Peaberry, 1 Solid Brass Filter Set, and 1 Khurja Ceramic Mug in a luxury wooden gift case.",
    "#1b130e", true, "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=800&q=80",
    5.0, 115, 0, 0, "None", "Both", true, "N/A", "2 Estate Coffees, Brass Filter, Artisan Mug, Gift Box", "Gift Set", 0, "Luxury Gift"
  ]
];

async function initDb(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          subcategory TEXT NOT NULL DEFAULT '',
          price INTEGER NOT NULL,
          original_price INTEGER NOT NULL DEFAULT 0,
          unit TEXT NOT NULL DEFAULT '',
          origin TEXT,
          roast TEXT,
          notes TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#1b130e',
          featured BOOLEAN NOT NULL DEFAULT FALSE,
          image_url TEXT NOT NULL DEFAULT '',
          rating NUMERIC(3,1) NOT NULL DEFAULT 4.8,
          reviews INTEGER NOT NULL DEFAULT 120,
          strength INTEGER NOT NULL DEFAULT 3,
          sweetness INTEGER NOT NULL DEFAULT 1,
          caffeine TEXT NOT NULL DEFAULT 'Medium',
          temperature TEXT NOT NULL DEFAULT 'Hot',
          vegan BOOLEAN NOT NULL DEFAULT false,
          milk_info TEXT NOT NULL DEFAULT 'Dairy',
          ingredients TEXT NOT NULL DEFAULT '',
          ratio TEXT NOT NULL DEFAULT '',
          calories_approx INTEGER NOT NULL DEFAULT 120,
          badge TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          phone TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL,
          city TEXT NOT NULL,
          pincode TEXT NOT NULL,
          subtotal INTEGER NOT NULL,
          shipping INTEGER NOT NULL,
          total INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'placed',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id),
          name TEXT NOT NULL,
          price INTEGER NOT NULL,
          qty INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Ensure all extended columns exist
      await pool.query(`
        ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(3,1) NOT NULL DEFAULT 4.8;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS reviews INTEGER NOT NULL DEFAULT 120;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS strength INTEGER NOT NULL DEFAULT 3;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS sweetness INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS caffeine TEXT NOT NULL DEFAULT 'Medium';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS temperature TEXT NOT NULL DEFAULT 'Hot';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS vegan BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS milk_info TEXT NOT NULL DEFAULT 'Dairy';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS ingredients TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS ratio TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS calories_approx INTEGER NOT NULL DEFAULT 120;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS badge TEXT NOT NULL DEFAULT '';
      `);

      // Check current catalog count
      const countRes = await pool.query("SELECT COUNT(*)::int AS n FROM products");
      const sample = await pool.query("SELECT name FROM products WHERE name ILIKE '%Pistachio%' LIMIT 1");

      if (countRes.rows[0].n < 30 || sample.rows.length === 0) {
        console.log("Populating complete 40+ product catalog for ROAST & RITUAL...");
        await pool.query("TRUNCATE TABLE products RESTART IDENTITY CASCADE");

        for (const row of SEED_PRODUCTS) {
          await pool.query(
            `INSERT INTO products (
              name, category, subcategory, price, original_price, unit, origin, roast,
              notes, description, color, featured, image_url, rating, reviews,
              strength, sweetness, caffeine, temperature, vegan, milk_info,
              ingredients, ratio, calories_approx, badge
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
            )`,
            row
          );
        }
        console.log(`Seeded ${SEED_PRODUCTS.length} premium products.`);
      }

      console.log("ROAST & RITUAL Database Ready!");
      return;
    } catch (err) {
      console.log(`Database retry (${i}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error("Failed to connect to PostgreSQL database.");
  process.exit(1);
}

initDb().then(() => {
  app.listen(3000, () => console.log("ROAST & RITUAL API listening on port 3000"));
});

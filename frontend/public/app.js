(() => {
  "use strict";

  /* =====================================================
     HELPERS & UTILITIES
     ===================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const money = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  const when = (iso) =>
    new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

  const orderNo = (id) => "RR-" + String(id).padStart(4, "0");

  async function api(path, options = {}) {
    const res = await fetch("/api" + path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.error || "Request failed (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  let toastTimer;
  function toast(message, isError = false) {
    let el = $("#toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = "toast"), 2800);
  }

  function showError(err) {
    console.error(err);
    const app = $("#app");
    if (!app) return;
    app.innerHTML = `
      <div class="wrap section">
        <div style="background:#fee2e2; border:1px solid #f87171; padding:36px; border-radius:18px; text-align:center;">
          <h2 style="color:#991b1b; margin-bottom:8px; font-family:var(--font-serif);">Service Unavailable</h2>
          <p style="color:#7f1d1d;">Could not establish connection to the backend container. Run <code>docker compose start backend</code> and refresh.</p>
        </div>
      </div>`;
  }

  /* =====================================================
     CART & WISHLIST STORE (Persisted in localStorage)
     ===================================================== */
  const FREE_OVER = 499; // Free shipping over ₹499
  const SHIPPING_FEE = 60;

  const Cart = {
    key: "rr-coffee-cart",
    read() {
      try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; }
    },
    write(items) {
      localStorage.setItem(this.key, JSON.stringify(items));
      updateBadges();
    },
    add(id, qty = 1, custom = null) {
      const items = this.read();
      const customKey = custom ? JSON.stringify(custom) : "";
      const found = items.find((i) => i.id === id && (JSON.stringify(i.custom || "") === customKey));
      if (found) {
        found.qty = Math.min(20, found.qty + qty);
      } else {
        items.push({ id, qty: Math.min(20, qty), custom });
      }
      this.write(items);
    },
    setQty(index, qty) {
      const items = this.read();
      if (items[index]) {
        if (qty <= 0) items.splice(index, 1);
        else items[index].qty = Math.min(20, qty);
      }
      this.write(items);
    },
    remove(index) {
      const items = this.read();
      items.splice(index, 1);
      this.write(items);
    },
    clear() { this.write([]); },
    count() { return this.read().reduce((n, i) => n + i.qty, 0); },
  };

  const Wishlist = {
    key: "rr-coffee-wishlist",
    read() {
      try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; }
    },
    toggle(id) {
      let items = this.read();
      if (items.includes(id)) {
        items = items.filter(x => x !== id);
        toast("Item removed from saved list");
      } else {
        items.push(id);
        toast("Item saved to wishlist");
      }
      localStorage.setItem(this.key, JSON.stringify(items));
      updateBadges();
      return items.includes(id);
    },
    has(id) { return this.read().includes(id); },
    count() { return this.read().length; },
  };

  function updateBadges() {
    const cartEl = $("#cart-count");
    if (cartEl) {
      const n = Cart.count();
      cartEl.textContent = n;
      cartEl.hidden = n === 0;
    }
    const wishEl = $("#wish-count");
    if (wishEl) {
      const w = Wishlist.count();
      wishEl.textContent = w;
      wishEl.hidden = w === 0;
    }
  }

  /* =====================================================
     PRODUCT CARD BUILDER (Clean, Professional, Zero Emojis)
     ===================================================== */
  function renderStrengthBars(strength) {
    if (!strength || strength <= 0) return "";
    let bars = "";
    for (let i = 1; i <= 5; i++) {
      bars += `<span style="display:inline-block; width:6px; height:10px; border-radius:1px; margin-right:2px; background:${i <= strength ? 'var(--color-accent)' : 'var(--color-border)'};"></span>`;
    }
    return `
      <div class="strength-meter" title="Coffee Strength: ${strength}/5">
        <span style="color:var(--text-light); font-size:0.75rem; text-transform:uppercase; font-weight:700;">Strength</span>
        <span style="display:inline-flex; align-items:center; margin-left:4px;">${bars}</span>
        <small style="color:var(--text-muted); font-size:0.75rem;">(${strength}/5)</small>
      </div>`;
  }

  function renderRatingStars(rating) {
    const r = Number(rating) || 4.8;
    return `<span class="rating-stars" style="color:var(--color-gold);">&#9733;</span> <strong>${r.toFixed(1)}</strong>`;
  }

  function productCard(p) {
    const isWished = Wishlist.has(p.id);
    const badgeHtml = p.badge ? `<span class="badge-float ${p.badge.toLowerCase()}">${esc(p.badge)}</span>` : "";
    const tempHtml = p.temperature && p.temperature !== 'N/A' ? `<span class="temp-indicator">${p.temperature === 'Hot' ? 'Hot' : (p.temperature === 'Cold' ? 'Iced' : 'Hot / Iced')}</span>` : "";

    return `
      <article class="product-card" data-id="${p.id}">
        <a class="product-media" href="product.html?id=${p.id}" aria-label="View ${esc(p.name)}">
          <img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">
          ${badgeHtml}
          ${tempHtml}
        </a>
        <button class="wishlist-btn ${isWished ? 'active' : ''}" type="button" data-wish="${p.id}" aria-label="Add to wishlist">
          ${isWished ? '&#9829;' : '&#9825;'}
        </button>

        <div class="product-content">
          <div class="product-rating">
            ${renderRatingStars(p.rating)} <span style="color:var(--text-light);">(${p.reviews || 120})</span>
            ${p.vegan ? '<span style="margin-left:auto; color:#059669; font-size:0.75rem; font-weight:700; text-transform:uppercase;">Vegan</span>' : '<span style="margin-left:auto; color:#059669; font-size:0.75rem; font-weight:700; text-transform:uppercase;">Vegetarian</span>'}
          </div>

          <h3><a href="product.html?id=${p.id}">${esc(p.name)}</a></h3>
          
          <div class="product-specs-pills">
            ${p.origin ? `<span class="spec-pill">${esc(p.origin.split(',')[0])}</span>` : ''}
            ${p.roast ? `<span class="spec-pill">${esc(p.roast)} Roast</span>` : ''}
            ${p.caffeine && p.caffeine !== 'None' ? `<span class="spec-pill">${esc(p.caffeine)} Caffeine</span>` : ''}
          </div>

          ${renderStrengthBars(p.strength)}

          <div class="product-foot">
            <div class="product-price">
              ${money(p.price)}
              ${p.original_price > p.price ? `<span class="original">${money(p.original_price)}</span>` : ''}
            </div>
            <button class="btn accent small" type="button" data-customize="${p.id}">Customize / Add</button>
          </div>
        </div>
      </article>`;
  }

  /* =====================================================
     CUSTOMIZE DRINK MODAL
     ===================================================== */
  let currentCustomProduct = null;
  let customState = {
    size: "Regular",
    sizePrice: 0,
    temp: "Hot",
    milk: "Full Cream Dairy",
    milkPrice: 0,
    sweetness: "Normal (50%)",
    extras: [],
    extraTotal: 0,
    qty: 1
  };

  function openCustomizer(product) {
    currentCustomProduct = product;
    customState = {
      size: "Regular",
      sizePrice: 0,
      temp: product.temperature === "Cold" ? "Iced" : "Hot",
      milk: product.milk_info || "Full Cream Dairy",
      milkPrice: 0,
      sweetness: "Normal (50%)",
      extras: [],
      extraTotal: 0,
      qty: 1
    };

    let overlay = $("#customizer-modal-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "customizer-modal-overlay";
      overlay.className = "modal-overlay";
      document.body.appendChild(overlay);
    }

    renderCustomizerModal(overlay);
    overlay.classList.add("active");
  }

  function closeCustomizer() {
    const overlay = $("#customizer-modal-overlay");
    if (overlay) overlay.classList.remove("active");
  }

  function renderCustomizerModal(overlay) {
    const p = currentCustomProduct;
    if (!p) return;
    const basePrice = p.price;
    const unitPrice = basePrice + customState.sizePrice + customState.milkPrice + customState.extraTotal;
    const grandTotal = unitPrice * customState.qty;

    overlay.innerHTML = `
      <div class="customizer-modal" role="dialog" aria-modal="true">
        <button class="modal-close" type="button" id="modal-close-btn">&times;</button>
        
        <div style="display:flex; gap:20px; align-items:center; border-bottom:1px solid var(--color-border); padding-bottom:20px; margin-bottom:20px;">
          <img src="${esc(p.image_url)}" style="width:90px; height:90px; border-radius:14px; object-fit:cover; flex-shrink:0;">
          <div>
            <span class="eyebrow" style="margin-bottom:4px;">Custom Preparation</span>
            <h2 style="font-family:var(--font-serif); font-size:1.6rem; line-height:1.2; color:var(--color-primary);">${esc(p.name)}</h2>
            <p style="color:var(--text-muted); font-size:0.88rem;">${esc(p.notes || p.description)}</p>
          </div>
        </div>

        <!-- 1. Size Selection -->
        <h4 class="custom-section-title">1. Size Option</h4>
        <div class="custom-options-grid">
          <div class="custom-option ${customState.size === 'Regular' ? 'selected' : ''}" data-custom-type="size" data-val="Regular" data-price="0">
            <strong>Regular</strong><br><small>Standard</small>
          </div>
          <div class="custom-option ${customState.size === 'Medium' ? 'selected' : ''}" data-custom-type="size" data-val="Medium" data-price="30">
            <strong>Medium</strong><br><small>+₹30</small>
          </div>
          <div class="custom-option ${customState.size === 'Large' ? 'selected' : ''}" data-custom-type="size" data-val="Large" data-price="60">
            <strong>Large</strong><br><small>+₹60</small>
          </div>
        </div>

        <!-- 2. Temperature -->
        <h4 class="custom-section-title">2. Temperature</h4>
        <div class="custom-options-grid">
          <div class="custom-option ${customState.temp === 'Hot' ? 'selected' : ''}" data-custom-type="temp" data-val="Hot">
            <strong>Steamed Hot</strong>
          </div>
          <div class="custom-option ${customState.temp === 'Iced' ? 'selected' : ''}" data-custom-type="temp" data-val="Iced">
            <strong>Served Over Ice</strong>
          </div>
        </div>

        <!-- 3. Milk Choice -->
        <h4 class="custom-section-title">3. Milk and Plant Base</h4>
        <div class="custom-options-grid">
          <div class="custom-option ${customState.milk === 'Full Cream Dairy' ? 'selected' : ''}" data-custom-type="milk" data-val="Full Cream Dairy" data-price="0">
            <strong>Full Cream Dairy</strong><br><small>Classic</small>
          </div>
          <div class="custom-option ${customState.milk === 'Toned Milk' ? 'selected' : ''}" data-custom-type="milk" data-val="Toned Milk" data-price="0">
            <strong>Toned Milk</strong><br><small>Low Fat</small>
          </div>
          <div class="custom-option ${customState.milk === 'Oat Milk' ? 'selected' : ''}" data-custom-type="milk" data-val="Oat Milk" data-price="40">
            <strong>Oat Milk</strong><br><small>+₹40</small>
          </div>
          <div class="custom-option ${customState.milk === 'Almond Milk' ? 'selected' : ''}" data-custom-type="milk" data-val="Almond Milk" data-price="45">
            <strong>Almond Milk</strong><br><small>+₹45</small>
          </div>
          <div class="custom-option ${customState.milk === 'Lactose-Free' ? 'selected' : ''}" data-custom-type="milk" data-val="Lactose-Free" data-price="30">
            <strong>Lactose-Free</strong><br><small>+₹30</small>
          </div>
        </div>

        <!-- 4. Sweetness -->
        <h4 class="custom-section-title">4. Sweetness Level</h4>
        <div class="custom-options-grid">
          <div class="custom-option ${customState.sweetness === 'No Sugar (0%)' ? 'selected' : ''}" data-custom-type="sweetness" data-val="No Sugar (0%)">
            <strong>0% Sugar</strong>
          </div>
          <div class="custom-option ${customState.sweetness === 'Less Sweet (25%)' ? 'selected' : ''}" data-custom-type="sweetness" data-val="Less Sweet (25%)">
            <strong>25% Light</strong>
          </div>
          <div class="custom-option ${customState.sweetness === 'Normal (50%)' ? 'selected' : ''}" data-custom-type="sweetness" data-val="Normal (50%)">
            <strong>50% Balanced</strong>
          </div>
          <div class="custom-option ${customState.sweetness === 'Extra Sweet (100%)' ? 'selected' : ''}" data-custom-type="sweetness" data-val="Extra Sweet (100%)">
            <strong>100% Sweet</strong>
          </div>
        </div>

        <!-- 5. Extras -->
        <h4 class="custom-section-title">5. Additional Shots and Flavor Infusions</h4>
        <div class="custom-options-grid">
          <div class="custom-option ${customState.extras.includes('Extra Shot') ? 'selected' : ''}" data-custom-type="extra" data-val="Extra Shot" data-price="50">
            <strong>Extra Espresso Shot</strong><br><small>+₹50</small>
          </div>
          <div class="custom-option ${customState.extras.includes('Vanilla') ? 'selected' : ''}" data-custom-type="extra" data-val="Vanilla" data-price="30">
            <strong>Vanilla Extract</strong><br><small>+₹30</small>
          </div>
          <div class="custom-option ${customState.extras.includes('Caramel') ? 'selected' : ''}" data-custom-type="extra" data-val="Caramel" data-price="30">
            <strong>Salted Caramel</strong><br><small>+₹30</small>
          </div>
          <div class="custom-option ${customState.extras.includes('Hazelnut') ? 'selected' : ''}" data-custom-type="extra" data-val="Hazelnut" data-price="30">
            <strong>Roasted Hazelnut</strong><br><small>+₹30</small>
          </div>
        </div>

        <!-- Modal Footer -->
        <div style="margin-top:32px; padding-top:20px; border-top:2px solid var(--color-border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
          <div>
            <small style="color:var(--text-light); text-transform:uppercase; font-weight:700;">Total Payable</small>
            <div style="font-family:var(--font-display); font-size:1.6rem; font-weight:800; color:var(--color-primary);">${money(grandTotal)}</div>
          </div>
          <div style="display:flex; gap:12px; align-items:center;">
            <div style="display:flex; align-items:center; border:1px solid var(--color-border); border-radius:var(--radius-md); background:#fff;">
              <button type="button" id="modal-dec" style="padding:10px 14px; border:none; background:none; cursor:pointer; font-size:1.1rem;">&minus;</button>
              <span style="font-weight:800; padding:0 8px; font-size:1rem;">${customState.qty}</span>
              <button type="button" id="modal-inc" style="padding:10px 14px; border:none; background:none; cursor:pointer; font-size:1.1rem;">+</button>
            </div>
            <button class="btn accent" type="button" id="modal-confirm-add" style="padding:14px 28px;">Add to Cart</button>
          </div>
        </div>
      </div>`;

    $("#modal-close-btn").addEventListener("click", closeCustomizer);
    $("#modal-dec").addEventListener("click", () => {
      customState.qty = Math.max(1, customState.qty - 1);
      renderCustomizerModal(overlay);
    });
    $("#modal-inc").addEventListener("click", () => {
      customState.qty = Math.min(20, customState.qty + 1);
      renderCustomizerModal(overlay);
    });

    overlay.querySelectorAll(".custom-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const type = opt.dataset.customType;
        const val = opt.dataset.val;
        const pVal = Number(opt.dataset.price || 0);

        if (type === "size") {
          customState.size = val;
          customState.sizePrice = pVal;
        } else if (type === "temp") {
          customState.temp = val;
        } else if (type === "milk") {
          customState.milk = val;
          customState.milkPrice = pVal;
        } else if (type === "sweetness") {
          customState.sweetness = val;
        } else if (type === "extra") {
          if (customState.extras.includes(val)) {
            customState.extras = customState.extras.filter(x => x !== val);
          } else {
            customState.extras.push(val);
          }
          customState.extraTotal = customState.extras.length * 30 + (customState.extras.includes("Extra Shot") ? 20 : 0);
        }
        renderCustomizerModal(overlay);
      });
    });

    $("#modal-confirm-add").addEventListener("click", () => {
      const extraPrice = customState.sizePrice + customState.milkPrice + customState.extraTotal;
      Cart.add(p.id, customState.qty, {
        size: customState.size,
        temp: customState.temp,
        milk: customState.milk,
        sweetness: customState.sweetness,
        extras: customState.extras,
        extraPrice
      });
      closeCustomizer();
      toast(`Added ${customState.qty} item(s) to cart`);
    });
  }

  /* =====================================================
     GLOBAL HEADER & FOOTER (Minimal & Professional)
     ===================================================== */
  function renderChrome() {
    const page = document.body.dataset.page;
    const links = [
      ["index.html", "Home", "home"],
      ["shop.html", "Shop", "shop"],
      ["about.html", "About", "about"],
      ["contact.html", "Contact", "contact"],
      ["admin.html", "Console", "admin"],
    ];

    const navHtml = links
      .map(([href, label, key]) => `<a href="${href}"${key === page ? ' aria-current="page"' : ""}>${label}</a>`)
      .join("");

    const header = $("#site-header");
    if (header) {
      header.innerHTML = `
        <header class="site-header">
          <div class="wrap bar">
            <a class="brand-logo" href="index.html" aria-label="ROAST & RITUAL Home">
              <div class="brand-text">
                <span class="brand-name">ROAST &amp; RITUAL</span>
                <span class="brand-tagline">Specialty Coffee Roasters</span>
              </div>
            </a>
            
            <nav class="main-nav" aria-label="Main Navigation">${navHtml}</nav>

            <div class="header-tools">
              <a class="tool-btn" href="shop.html" aria-label="Search">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </a>
              <a class="tool-btn" href="cart.html" aria-label="Cart">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                <span class="badge-count" id="cart-count" hidden>0</span>
              </a>
            </div>
          </div>
        </header>`;
    }

    const footer = $("#site-footer");
    if (footer) {
      footer.innerHTML = `
        <footer class="site-footer">
          <div class="wrap">
            <div class="footer-top-grid">
              <div class="footer-brand">
                <h3>ROAST &amp; RITUAL</h3>
                <p style="margin-bottom:14px;">Every cup has a character. Artisanal micro-roastery and specialty coffee platform. Sourced directly from estate cooperatives with transparent lot identification.</p>
                <span style="display:inline-block; border:1px solid rgba(255,255,255,0.15); color:#d6c8bc; padding:4px 12px; border-radius:4px; font-size:0.8rem; font-weight:600;">Standard Complimentary Shipping on Orders Over ₹499</span>
              </div>

              <div class="footer-col">
                <h4>Coffee Selection</h4>
                <ul>
                  <li><a href="shop.html?cat=Coffee Classics">Espresso &amp; Classics</a></li>
                  <li><a href="shop.html?cat=Cold Coffee">Cold Brews &amp; Nitro</a></li>
                  <li><a href="shop.html?cat=Specialty / Modern">Specialty Lattes</a></li>
                  <li><a href="shop.html?cat=Matcha & Tea">Ceremonial Matcha</a></li>
                  <li><a href="shop.html?cat=Coffee Beans">Whole Estate Beans</a></li>
                </ul>
              </div>

              <div class="footer-col">
                <h4>Information</h4>
                <ul>
                  <li><a href="about.html">Architecture &amp; Founder</a></li>
                  <li><a href="index.html#guide">Coffee Guide</a></li>
                  <li><a href="index.html#compare">Comparison Matrix</a></li>
                  <li><a href="contact.html">Brewing Lab Inquiries</a></li>
                  <li><a href="admin.html">System Operations</a></li>
                </ul>
              </div>

              <div class="footer-col">
                <h4>Engineering &amp; Creator</h4>
                <p style="font-size:0.95rem; color:#ffffff; font-weight:700; margin-bottom:4px;">Ashok Gangwar</p>
                <p style="font-size:0.82rem; color:#a3958c; line-height:1.6; margin-bottom:14px;">
                  B.Tech CSE (AIML) &middot; 3rd Year<br>
                  KIET Deemed to be University, Ghaziabad (201206)
                </p>
                <div style="font-family:monospace; font-size:0.75rem; color:#85a89e;">Docker Containerized Stack</div>
              </div>
            </div>

            <div class="footer-bottom-bar">
              <span>&copy; ${new Date().getFullYear()} ROAST &amp; RITUAL &middot; All rights reserved</span>
              <span id="server-status-pill" style="font-family:monospace; color:#c88d51;"></span>
            </div>
          </div>
        </footer>`;
    }
    updateBadges();
  }

  async function checkServerStatus() {
    try {
      const h = await api("/health");
      const pill = $("#server-status-pill");
      if (pill) pill.textContent = `API Host: ${h.api.host} | Products: ${h.db.products}`;
    } catch { /* optional */ }
  }

  /* =====================================================
     PAGE CONTROLLERS
     ===================================================== */
  const pages = {};

  // ---------- 1. HOME PAGE ----------
  pages.home = async () => {
    const products = await api("/products");

    // Featured section
    const featured = products.filter(p => p.featured).slice(0, 8);
    const featGrid = $("#featured-grid");
    if (featGrid) {
      featGrid.innerHTML = (featured.length ? featured : products.slice(0, 8)).map(productCard).join("");
    }

    // Mood Recommendation click handlers
    const moodPills = $$(".mood-pill");
    moodPills.forEach(pill => {
      pill.addEventListener("click", () => {
        moodPills.forEach(p => p.classList.remove("active"));
        pill.classList.add("active");
        const mood = pill.dataset.mood;
        filterMoodProducts(products, mood);
      });
    });

    function filterMoodProducts(allProducts, mood) {
      const moodContainer = $("#mood-results");
      if (!moodContainer) return;
      let matched = [];

      if (mood === "energy") {
        matched = allProducts.filter(p => p.strength >= 4 || p.caffeine === "High" || p.caffeine === "Very High");
      } else if (mood === "sweet") {
        matched = allProducts.filter(p => p.sweetness >= 2 || p.name.includes("Mocha") || p.name.includes("Caramel") || p.name.includes("Vanilla") || p.name.includes("Spanish"));
      } else if (mood === "creamy") {
        matched = allProducts.filter(p => p.name.includes("Latte") || p.name.includes("Cappuccino") || p.name.includes("Flat White") || p.name.includes("Pistachio"));
      } else if (mood === "cold") {
        matched = allProducts.filter(p => p.temperature === "Cold" || p.category === "Cold Coffee");
      } else if (mood === "light") {
        matched = allProducts.filter(p => p.category === "Matcha & Tea" || p.roast === "Light" || p.strength <= 2);
      } else if (mood === "luxury") {
        matched = allProducts.filter(p => p.price >= 400 || p.badge === "Luxury" || p.name.includes("Geisha") || p.name.includes("Reserve"));
      }

      moodContainer.innerHTML = matched.slice(0, 4).map(productCard).join("");
    }

    filterMoodProducts(products, "energy");
  };

  // ---------- 2. SHOP PAGE ----------
  pages.shop = async () => {
    const params = new URLSearchParams(location.search);
    const state = {
      category: params.get("cat") || "All",
      temperature: params.get("temp") || "All",
      strength: params.get("str") || "",
      dietary: params.get("diet") || "",
      q: params.get("q") || "",
      sort: params.get("sort") || "featured",
      min_price: params.get("min") || "",
      max_price: params.get("max") || ""
    };

    const grid = $("#shop-grid");
    const searchInput = $("#shop-search");
    const sortSelect = $("#shop-sort");
    const countEl = $("#shop-count");

    if (searchInput) searchInput.value = state.q;
    if (sortSelect) sortSelect.value = state.sort;

    async function loadShop() {
      const qs = new URLSearchParams();
      if (state.category && state.category !== "All") qs.set("category", state.category);
      if (state.temperature && state.temperature !== "All") qs.set("temperature", state.temperature);
      if (state.strength) qs.set("strength", state.strength);
      if (state.dietary) qs.set("dietary", state.dietary);
      if (state.q) qs.set("q", state.q);
      if (state.sort) qs.set("sort", state.sort);
      if (state.min_price) qs.set("min_price", state.min_price);
      if (state.max_price) qs.set("max_price", state.max_price);

      history.replaceState(null, "", qs.toString() ? "?" + qs.toString() : location.pathname);

      $$("[data-filter-cat]").forEach(btn => btn.classList.toggle("active", btn.dataset.filterCat === state.category));
      $$("[data-filter-temp]").forEach(btn => btn.classList.toggle("active", btn.dataset.filterTemp === state.temperature));

      try {
        const items = await api("/products?" + qs.toString());
        if (countEl) countEl.textContent = `Showing ${items.length} product(s)`;
        if (grid) {
          grid.innerHTML = items.length
            ? items.map(productCard).join("")
            : `<div style="grid-column:1/-1; text-align:center; padding:80px 20px; background:#fff; border-radius:20px; border:1px solid var(--color-border);"><p style="font-size:1.2rem; color:var(--text-muted); font-family:var(--font-serif);">No items found matching your criteria.</p><button class="btn outline small" id="clear-filters-btn" style="margin-top:16px;">Clear Filters</button></div>`;

          const clearBtn = $("#clear-filters-btn");
          if (clearBtn) {
            clearBtn.addEventListener("click", () => {
              state.category = "All";
              state.temperature = "All";
              state.strength = "";
              state.dietary = "";
              state.q = "";
              state.min_price = "";
              state.max_price = "";
              if (searchInput) searchInput.value = "";
              loadShop();
            });
          }
        }
      } catch (err) {
        showError(err);
      }
    }

    $$("[data-filter-cat]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.category = btn.dataset.filterCat;
        loadShop();
      });
    });

    $$("[data-filter-temp]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.temperature = btn.dataset.filterTemp;
        loadShop();
      });
    });

    $$("[data-price-range]").forEach(btn => {
      btn.addEventListener("click", () => {
        const [min, max] = btn.dataset.priceRange.split("-");
        state.min_price = min || "";
        state.max_price = max || "";
        loadShop();
      });
    });

    let searchTimer;
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          state.q = searchInput.value.trim();
          loadShop();
        }, 250);
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        state.sort = sortSelect.value;
        loadShop();
      });
    }

    await loadShop();
  };

  // ---------- 3. PRODUCT DETAIL PAGE ----------
  pages.product = async () => {
    const id = new URLSearchParams(location.search).get("id");
    let p;
    try {
      p = await api("/products/" + encodeURIComponent(id));
    } catch (err) {
      if (err.status !== 404) throw err;
      $("#app").innerHTML = `
        <div class="wrap section">
          <div style="text-align:center; padding:80px; background:#fff; border-radius:20px;">
            <h2 style="font-family:var(--font-serif);">Product Not Found</h2>
            <p style="color:var(--text-muted); margin:12px 0 24px;">This selection may have been updated or retired.</p>
            <a href="shop.html" class="btn accent">Browse Collection</a>
          </div>
        </div>`;
      return;
    }

    document.title = `${p.name} | ROAST & RITUAL`;

    const detailBox = $("#product-detail-stage");
    if (detailBox) {
      const isMatcha = p.category.includes("Matcha");

      detailBox.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:56px; align-items:start;">
          <!-- Product Media Gallery -->
          <div style="position:relative; border-radius:var(--radius-lg); overflow:hidden; box-shadow:var(--shadow-md); border:1px solid var(--color-border); background:#fff;">
            <img src="${esc(p.image_url)}" alt="${esc(p.name)}" style="width:100%; height:500px; object-fit:cover;">
            ${p.badge ? `<span class="badge-float ${p.badge.toLowerCase()}">${esc(p.badge)}</span>` : ''}
          </div>

          <!-- Product Details & Actions -->
          <div>
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
              <span class="eyebrow" style="margin-bottom:0;">${esc(p.category)}</span>
              ${p.temperature ? `<span class="spec-pill">${p.temperature === 'Hot' ? 'Hot' : (p.temperature === 'Cold' ? 'Iced' : 'Hot / Iced')}</span>` : ''}
            </div>

            <h1 style="font-family:var(--font-serif); font-size:2.5rem; color:var(--color-primary); line-height:1.2; margin-bottom:12px;">${esc(p.name)}</h1>

            <div style="display:flex; align-items:center; gap:16px; margin-bottom:20px;">
              <div class="product-rating" style="margin-bottom:0; font-size:0.95rem;">
                ${renderRatingStars(p.rating)} <span>(${p.reviews} reviews)</span>
              </div>
              <span style="color:var(--color-border);">|</span>
              <span style="font-weight:700; color:#059669; font-size:0.9rem; text-transform:uppercase;">${p.vegan ? 'Vegan' : 'Vegetarian'}</span>
            </div>

            <div style="display:flex; align-items:baseline; gap:12px; margin-bottom:24px;">
              <span style="font-family:var(--font-display); font-size:2.2rem; font-weight:800; color:var(--color-primary);">${money(p.price)}</span>
              ${p.original_price > p.price ? `<span style="text-decoration:line-through; color:var(--text-light); font-size:1.1rem;">${money(p.original_price)}</span>` : ''}
              ${p.unit ? `<span style="color:var(--text-light); font-size:0.95rem;">/ ${esc(p.unit)}</span>` : ''}
            </div>

            <p style="color:var(--text-muted); font-size:1.05rem; line-height:1.7; margin-bottom:28px;">${esc(p.description)}</p>

            ${isMatcha ? `
              <div class="matcha-disclaimer-banner" style="margin:0 0 24px 0;">
                <div>
                  <h4>Matcha Botanical Specification</h4>
                  <p>Matcha is pure stone-ground Japanese green tea leaf powder. It contains natural tea polyphenols and no espresso unless ordered as a Dirty Matcha.</p>
                </div>
              </div>` : ''}

            <!-- Ingredients & Ratio Box -->
            <div style="background:var(--bg-tint); border:1px solid var(--color-border); border-radius:var(--radius-md); padding:20px; margin-bottom:28px;">
              <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                <strong style="font-size:0.95rem; color:var(--color-primary);">Ratio & Composition</strong>
                <span style="font-family:var(--font-display); font-weight:800; color:var(--color-accent);">${esc(p.ratio || '1 : 1 : 1')}</span>
              </div>
              <p style="font-size:0.9rem; color:var(--text-muted); margin-bottom:12px;"><strong>Ingredients:</strong> ${esc(p.ingredients || 'Specialty Coffee Extract')}</p>
              <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; font-size:0.82rem; color:var(--text-main);">
                <div><small style="color:var(--text-light); display:block; text-transform:uppercase;">Caffeine</small><strong>${esc(p.caffeine)}</strong></div>
                <div><small style="color:var(--text-light); display:block; text-transform:uppercase;">Calories</small><strong>~${p.calories_approx || 120} kcal</strong></div>
                <div><small style="color:var(--text-light); display:block; text-transform:uppercase;">Milk Profile</small><strong>${esc(p.milk_info || 'Dairy / Plant')}</strong></div>
              </div>
            </div>

            <!-- Action Buttons -->
            <div style="display:flex; gap:16px; align-items:center;">
              <button class="btn accent" type="button" id="pdp-customize-btn" style="flex:1; padding:16px 24px; font-size:1.1rem;">Customize &amp; Order</button>
              <button class="btn outline" type="button" id="pdp-wishlist-btn" style="padding:16px 20px;">${Wishlist.has(p.id) ? 'Saved' : 'Save to Wishlist'}</button>
            </div>
            <p style="margin-top:14px; font-size:0.85rem; color:var(--text-light);">Standard dispatch within 24-48 hours across India &middot; Free shipping over ₹499</p>
          </div>
        </div>`;

      $("#pdp-customize-btn").addEventListener("click", () => openCustomizer(p));
      $("#pdp-wishlist-btn").addEventListener("click", () => {
        const isNowWished = Wishlist.toggle(p.id);
        $("#pdp-wishlist-btn").textContent = isNowWished ? "Saved" : "Save to Wishlist";
      });
    }

    const related = (await api("/products?category=" + encodeURIComponent(p.category)))
      .filter((r) => r.id !== p.id)
      .slice(0, 4);
    const relBox = $("#related-grid");
    if (relBox) relBox.innerHTML = related.map(productCard).join("");
  };

  // ---------- 4. CART & CHECKOUT PAGE ----------
  pages.cart = async () => {
    const products = await api("/products");
    const byId = new Map(products.map((p) => [p.id, p]));
    const cartBox = $("#cart-root");
    if (!cartBox) return;

    let promoCode = "";

    function drawCart() {
      const items = Cart.read();
      if (!items.length) {
        cartBox.innerHTML = `
          <div style="text-align:center; padding:90px 20px; background:#fff; border-radius:24px; border:1px solid var(--color-border); max-width:640px; margin:0 auto;">
            <h2 style="font-family:var(--font-serif); font-size:2rem; margin-bottom:8px;">Your Cart is Empty</h2>
            <p style="color:var(--text-muted); margin-bottom:28px;">Explore our signature roast collection and hand-crafted beverages.</p>
            <a class="btn accent" href="shop.html">Browse Coffee Menu</a>
          </div>`;
        return;
      }

      let subtotal = 0;
      const cartLines = items.map((it, idx) => {
        const prod = byId.get(it.id);
        if (!prod) return null;
        const extraPrice = it.custom?.extraPrice || 0;
        const lineUnitPrice = prod.price + extraPrice;
        const lineTotal = lineUnitPrice * it.qty;
        subtotal += lineTotal;
        return { prod, it, idx, lineUnitPrice, lineTotal };
      }).filter(Boolean);

      const discountAmt = promoCode === "ROAST10" ? Math.round(subtotal * 0.10) : (promoCode === "FIRSTCUP" ? 50 : 0);
      const finalSubtotal = Math.max(0, subtotal - discountAmt);
      const shipping = finalSubtotal >= FREE_OVER || finalSubtotal === 0 ? 0 : SHIPPING_FEE;
      const grandTotal = finalSubtotal + shipping;
      const leftForFree = FREE_OVER - finalSubtotal;
      const progressPct = Math.min(100, Math.round((finalSubtotal / FREE_OVER) * 100));

      cartBox.innerHTML = `
        <div style="display:grid; grid-template-columns:1.5fr 1fr; gap:40px; align-items:start;">
          <!-- Left: Cart Items -->
          <div style="background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-lg); padding:32px; box-shadow:var(--shadow-sm);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; border-bottom:1px solid var(--color-border-light); padding-bottom:16px;">
              <h2 style="font-family:var(--font-serif); font-size:1.6rem; color:var(--color-primary);">Order Items (${items.length})</h2>
              <button id="clear-cart-btn" style="background:none; border:none; color:#dc2626; font-size:0.85rem; font-weight:700; cursor:pointer;">Clear Cart</button>
            </div>

            <div style="display:flex; flex-direction:column; gap:20px;">
              ${cartLines.map(({ prod, it, idx, lineUnitPrice, lineTotal }) => `
                <div style="display:flex; gap:20px; align-items:center; border-bottom:1px solid var(--color-border-light); padding-bottom:20px;">
                  <img src="${esc(prod.image_url)}" style="width:84px; height:84px; border-radius:12px; object-fit:cover; flex-shrink:0;">
                  <div style="flex:1;">
                    <h4 style="font-family:var(--font-display); font-size:1.1rem; font-weight:800;"><a href="product.html?id=${prod.id}">${esc(prod.name)}</a></h4>
                    <p style="color:var(--text-muted); font-size:0.82rem; margin:2px 0 6px;">
                      ${it.custom?.size ? `Size: <strong>${it.custom.size}</strong> &middot; ` : ''}
                      ${it.custom?.temp ? `${it.custom.temp} &middot; ` : ''}
                      ${it.custom?.milk ? `${it.custom.milk}` : ''}
                      ${it.custom?.extras?.length ? ` &middot; Extras: ${it.custom.extras.join(', ')}` : ''}
                    </p>
                    <span style="font-weight:700; color:var(--color-accent); font-size:0.95rem;">${money(lineUnitPrice)} each</span>
                  </div>

                  <div style="display:flex; align-items:center; border:1px solid var(--color-border); border-radius:8px; background:#fff;">
                    <button type="button" data-cart-dec="${idx}" style="padding:6px 12px; border:none; background:none; cursor:pointer; font-weight:700;">&minus;</button>
                    <span style="font-weight:800; padding:0 6px; font-size:0.95rem;">${it.qty}</span>
                    <button type="button" data-cart-inc="${idx}" style="padding:6px 12px; border:none; background:none; cursor:pointer; font-weight:700;">+</button>
                  </div>

                  <strong style="font-size:1.2rem; font-family:var(--font-display); color:var(--color-primary); min-width:80px; text-align:right;">${money(lineTotal)}</strong>
                  <button type="button" data-cart-rem="${idx}" style="color:#94a3b8; border:none; background:none; cursor:pointer; font-size:1.1rem; margin-left:8px;">&times;</button>
                </div>`).join("")}
            </div>
          </div>

          <!-- Right: Summary & Checkout Form -->
          <div>
            <aside style="background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-lg); padding:32px; box-shadow:var(--shadow-sm); margin-bottom:24px;">
              <h3 style="font-family:var(--font-serif); font-size:1.4rem; color:var(--color-primary); margin-bottom:20px;">Order Summary</h3>
              
              <div style="background:var(--bg-tint); padding:14px 18px; border-radius:12px; margin-bottom:20px;">
                <div style="height:6px; background:#e2d9cd; border-radius:4px; overflow:hidden; margin-bottom:8px;">
                  <div style="height:100%; background:var(--color-accent); width:${progressPct}%;"></div>
                </div>
                <p style="font-size:0.85rem; color:var(--text-main); font-weight:700;">
                  ${leftForFree > 0 ? `Add ${money(leftForFree)} more for Complimentary Shipping` : 'Complimentary Express Shipping Qualified'}
                </p>
              </div>

              <!-- Promo Code Input -->
              <div style="display:flex; gap:8px; margin-bottom:20px;">
                <input id="promo-input" placeholder="Promo code (ROAST10 / FIRSTCUP)" value="${promoCode}" style="flex:1; padding:10px 14px; border:1px solid var(--color-border); border-radius:var(--radius-md); font-family:inherit; font-size:0.88rem; outline:none;">
                <button class="btn primary small" id="apply-promo-btn" type="button">Apply</button>
              </div>

              <div style="display:flex; justify-content:space-between; margin-bottom:10px; color:var(--text-muted); font-size:0.95rem;"><span>Items Subtotal</span><span>${money(subtotal)}</span></div>
              ${discountAmt > 0 ? `<div style="display:flex; justify-content:space-between; margin-bottom:10px; color:#059669; font-weight:700; font-size:0.95rem;"><span>Promotional Discount</span><span>-${money(discountAmt)}</span></div>` : ''}
              <div style="display:flex; justify-content:space-between; margin-bottom:16px; color:var(--text-muted); font-size:0.95rem;"><span>Shipping</span><span>${shipping ? money(shipping) : '<strong style="color:#059669;">Free</strong>'}</span></div>
              <div style="display:flex; justify-content:space-between; border-top:2px solid var(--color-border); padding-top:16px; font-size:1.5rem; font-weight:800; font-family:var(--font-display); color:var(--color-primary); margin-bottom:28px;">
                <span>Total</span><span>${money(grandTotal)}</span>
              </div>

              <a class="btn accent" href="#checkout-step" style="width:100%; padding:15px; font-size:1.1rem;">Continue to Shipping</a>
            </aside>

            <!-- Delivery Form -->
            <form id="checkout-form" style="background:#fff; border:1px solid var(--color-border); border-radius:var(--radius-lg); padding:32px; box-shadow:var(--shadow-sm);">
              <h3 id="checkout-step" style="font-family:var(--font-serif); font-size:1.4rem; color:var(--color-primary); margin-bottom:6px;">Shipping Information</h3>
              <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:20px;">Provide recipient details for domestic courier delivery.</p>

              <div class="form-group" style="margin-bottom:14px;">
                <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:4px;">Full Name *</label>
                <input name="name" required placeholder="Ashok Gangwar" style="width:100%; padding:10px 14px; border:1px solid var(--color-border); border-radius:8px;">
              </div>

              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
                <div>
                  <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:4px;">Email Address *</label>
                  <input name="email" type="email" required placeholder="ashok@kiet.edu" style="width:100%; padding:10px 14px; border:1px solid var(--color-border); border-radius:8px;">
                </div>
                <div>
                  <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:4px;">Phone Number *</label>
                  <input name="phone" type="tel" placeholder="+91 9876543210" style="width:100%; padding:10px 14px; border:1px solid var(--color-border); border-radius:8px;">
                </div>
              </div>

              <div class="form-group" style="margin-bottom:14px;">
                <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:4px;">Street Address / Landmark *</label>
                <input name="address" required placeholder="Apartment / Campus Address" style="width:100%; padding:10px 14px; border:1px solid var(--color-border); border-radius:8px;">
              </div>

              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:20px;">
                <div>
                  <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:4px;">City / District *</label>
                  <input name="city" required placeholder="Ghaziabad" style="width:100%; padding:10px 14px; border:1px solid var(--color-border); border-radius:8px;">
                </div>
                <div>
                  <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:4px;">6-Digit Postal PIN *</label>
                  <input name="pincode" required maxlength="6" inputmode="numeric" placeholder="201206" style="width:100%; padding:10px 14px; border:1px solid var(--color-border); border-radius:8px;">
                </div>
              </div>

              <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:8px;">Payment Preference</label>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px;">
                <label style="border:1px solid var(--color-border); border-radius:8px; padding:10px; display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.85rem; font-weight:600;">
                  <input type="radio" name="pay_mode" value="upi" checked> UPI / Net Banking
                </label>
                <label style="border:1px solid var(--color-border); border-radius:8px; padding:10px; display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.85rem; font-weight:600;">
                  <input type="radio" name="pay_mode" value="cod"> Cash on Delivery
                </label>
              </div>

              <p id="checkout-error" style="color:#dc2626; background:#fef2f2; padding:10px; border-radius:8px; font-size:0.88rem; font-weight:600; margin-bottom:14px;" hidden></p>
              
              <button class="btn accent" type="submit" id="place-order-btn" style="width:100%; padding:16px; font-size:1.1rem;">
                Confirm Order &middot; ${money(grandTotal)}
              </button>
            </form>
          </div>
        </div>`;

      const clearBtn = $("#clear-cart-btn");
      if (clearBtn) clearBtn.addEventListener("click", () => { Cart.clear(); drawCart(); toast("Cart cleared"); });

      const promoBtn = $("#apply-promo-btn");
      if (promoBtn) {
        promoBtn.addEventListener("click", () => {
          const val = $("#promo-input").value.trim().toUpperCase();
          if (val === "ROAST10" || val === "FIRSTCUP") {
            promoCode = val;
            toast(`Promo code ${val} applied successfully`);
            drawCart();
          } else {
            toast("Invalid promotional code", true);
          }
        });
      }

      const form = $("#checkout-form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const errBox = $("#checkout-error");
          const btn = $("#place-order-btn");
          errBox.hidden = true;
          btn.disabled = true;

          try {
            const res = await api("/orders", {
              method: "POST",
              body: JSON.stringify({
                name: f.get("name"),
                email: f.get("email"),
                phone: f.get("phone"),
                address: f.get("address"),
                city: f.get("city"),
                pincode: f.get("pincode"),
                discountCode: promoCode,
                items: Cart.read()
              })
            });

            Cart.clear();
            location.href = "order.html?id=" + res.id;
          } catch (err) {
            errBox.textContent = err.message;
            errBox.hidden = false;
            btn.disabled = false;
          }
        });
      }
    }

    cartBox.addEventListener("click", (e) => {
      const inc = e.target.closest("[data-cart-inc]");
      const dec = e.target.closest("[data-cart-dec]");
      const rem = e.target.closest("[data-cart-rem]");
      if (inc) {
        const idx = Number(inc.dataset.cartInc);
        Cart.setQty(idx, Cart.read()[idx].qty + 1);
        drawCart();
      } else if (dec) {
        const idx = Number(dec.dataset.cartDec);
        Cart.setQty(idx, Cart.read()[idx].qty - 1);
        drawCart();
      } else if (rem) {
        const idx = Number(rem.dataset.cartRem);
        Cart.remove(idx);
        toast("Item removed from cart");
        drawCart();
      }
    });

    drawCart();
  };

  /* =====================================================
     GLOBAL INTERACTION HANDLERS & BOOTSTRAP
     ===================================================== */
  document.addEventListener("click", async (e) => {
    const customBtn = e.target.closest("[data-customize]");
    if (customBtn) {
      const id = Number(customBtn.dataset.customize);
      try {
        const prod = await api("/products/" + id);
        openCustomizer(prod);
      } catch (err) {
        toast("Unable to load product customizer", true);
      }
      return;
    }

    const wishBtn = e.target.closest("[data-wish]");
    if (wishBtn) {
      const id = Number(wishBtn.dataset.wish);
      const isNow = Wishlist.toggle(id);
      wishBtn.classList.toggle("active", isNow);
      wishBtn.innerHTML = isNow ? "&#9829;" : "&#9825;";
      return;
    }
  });

  renderChrome();
  checkServerStatus();
  const runner = pages[document.body.dataset.page];
  if (runner) runner().catch(showError);
})();

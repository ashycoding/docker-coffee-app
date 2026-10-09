/**
 * ROAST & RITUAL — Universal API Client Service (api.jsx)
 * Provides typed methods for products, orders, health check, custom cups, and metrics.
 */

const API_BASE_URL = typeof window !== 'undefined' && window.API_BASE_URL ? window.API_BASE_URL : '/api';

/**
 * Universal fetch wrapper with error handling
 * @param {string} endpoint 
 * @param {RequestInit} [options] 
 * @returns {Promise<any>}
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  try {
    const res = await fetch(url, config);
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error = new Error(errorData.error || `HTTP error ${res.status}: ${res.statusText}`);
      error.status = res.status;
      error.data = errorData;
      throw error;
    }
    return await res.json();
  } catch (err) {
    console.error(`API Error on [${config.method || 'GET'} ${url}]:`, err);
    throw err;
  }
}

export const api = {
  // --- Health & Cluster Status ---
  getHealth: () => request('/health'),
  getSummary: () => request('/summary'),

  // --- Products with Multi-Faceted Filters ---
  getProducts: (params = {}) => {
    const query = new URLSearchParams();
    if (params.category && params.category !== 'All') query.append('category', params.category);
    if (params.subcategory) query.append('subcategory', params.subcategory);
    if (params.temperature && params.temperature !== 'All') query.append('temperature', params.temperature);
    if (params.strength) query.append('strength', params.strength);
    if (params.sweetness) query.append('sweetness', params.sweetness);
    if (params.dietary) query.append('dietary', params.dietary);
    if (params.min_price) query.append('min_price', params.min_price);
    if (params.max_price) query.append('max_price', params.max_price);
    if (params.q) query.append('q', params.q);
    if (params.sort) query.append('sort', params.sort);
    const qs = query.toString();
    return request(`/products${qs ? `?${qs}` : ''}`);
  },

  getProductById: (id) => request(`/products/${encodeURIComponent(id)}`),

  // --- Orders & Checkout ---
  createOrder: (orderPayload) =>
    request('/orders', {
      method: 'POST',
      body: JSON.stringify(orderPayload),
    }),

  getOrders: () => request('/orders'),

  getOrderById: (id) => request(`/orders/${encodeURIComponent(id)}`),

  updateOrderStatus: (id, status) =>
    request(`/orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  // --- Contact Messages ---
  sendMessage: (messagePayload) =>
    request('/messages', {
      method: 'POST',
      body: JSON.stringify(messagePayload),
    }),

  getMessages: () => request('/messages'),
};

export default api;

// shopifyClient.js
const Shopify = require("shopify-api-node");

function createShopifyClient(shopDomain, accessToken) {
  return new Shopify({
    shopName: shopDomain,
    accessToken,
    apiVersion: "2025-10",
  });
}

// Version actuelle : 1 seul shop, lu depuis .env
function getShopifyClient() {
  const shopDomain = process.env.SHOP_NAME;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!shopDomain || !token) {
    throw new Error("SHOP_NAME ou SHOPIFY_ADMIN_TOKEN manquant dans .env");
  }

  return createShopifyClient(shopDomain, token);
}

/**
 * Recherche simple de produits pour l'UI import
 * @param {string} shop - ignoré en mono-shop (gardé pour compat multi-shop)
 * @param {{query?: string, limit?: number}} opts
 */
async function searchProducts(shop, opts = {}) {
  const client = getShopifyClient();
  const query = String(opts.query || "").trim();
  const limit = Math.max(1, Math.min(Number(opts.limit || 50), 250));

  // Shopify REST: product.list ne supporte pas une recherche "query" fiable
  // => on liste et on filtre côté serveur (suffisant pour commencer)
  const products = await client.product.list({ limit });

  if (!query) return products;

  const q = query.toLowerCase();
  return products.filter((p) => String(p.title || "").toLowerCase().includes(q));
}

/**
 * Récupère un produit complet (variants inclus)
 * @param {string} shop - ignoré en mono-shop (gardé pour compat multi-shop)
 * @param {string|number} productId
 */
async function fetchProduct(shop, productId) {
  const client = getShopifyClient();
  if (!productId) throw new Error("fetchProduct: productId manquant");
  return client.product.get(Number(productId));
}

module.exports = {
  createShopifyClient,
  getShopifyClient,
  searchProducts,
  fetchProduct,
};

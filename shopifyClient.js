// shopifyClient.js
const Shopify = require("shopify-api-node");

// Cache par shop pour éviter de recréer le client à chaque requête
const _clientCache = new Map();

function normalizeShopDomain(shop) {
  const raw = String(shop || "").trim();
  if (!raw) return "";

  // enlève protocole si jamais
  const noProto = raw.replace(/^https?:\/\//i, "").trim();

  // si déjà en .myshopify.com => ok
  if (noProto.includes(".myshopify.com")) return noProto;

  // sinon on considère que c'est un "shop name" => on complète
  return `${noProto}.myshopify.com`;
}

function createShopifyClient(shopDomain, accessToken) {
  return new Shopify({
    shopName: shopDomain, // accepte "xxx.myshopify.com"
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
  });
}

/**
 * ✅ IMPORTANT
 * Renvoie un client Shopify pour le shop demandé (query ?shop=...),
 * sinon fallback sur SHOP_NAME.
 */
function getShopifyClient(shop) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  // SHOP_NAME peut être "xxx" ou "xxx.myshopify.com"
  const envShop = normalizeShopDomain(process.env.SHOP_NAME || "");

  // shop passé (ex: e4vkqa-ea.myshopify.com)
  const reqShop = normalizeShopDomain(shop || "");

  const shopDomain = reqShop || envShop;

  if (!shopDomain || !token) {
    throw new Error("SHOP_NAME/SHOPIFY_ADMIN_TOKEN manquant, ou shop introuvable");
  }

  const key = shopDomain.toLowerCase();
  if (_clientCache.has(key)) return _clientCache.get(key);

  const client = createShopifyClient(shopDomain, token);
  _clientCache.set(key, client);
  return client;
}

/**
 * Recherche simple de produits pour l'UI import
 */
async function searchProducts(shop, opts = {}) {
  const client = getShopifyClient(shop);
  const query = String(opts.query || "").trim();
  const limit = Math.max(1, Math.min(Number(opts.limit || 50), 250));

  const products = await client.product.list({ limit });

  if (!query) return products;
  const q = query.toLowerCase();
  return products.filter((p) => String(p.title || "").toLowerCase().includes(q));
}

/**
 * Récupère un produit complet (variants inclus)
 */
async function fetchProduct(shop, productId) {
  const client = getShopifyClient(shop);
  if (!productId) throw new Error("fetchProduct: productId manquant");
  return client.product.get(Number(productId));
}

module.exports = {
  createShopifyClient,
  getShopifyClient,
  searchProducts,
  fetchProduct,
  normalizeShopDomain,
};

// shopifyClient.js — PRE-PROD / PROD SAFE
const Shopify = require("shopify-api-node");
const tokenStore = require("./utils/tokenStore");

// Cache par shop+token
const _clientCache = new Map();

// ==========================
// Utils
// ==========================
function normalizeShopDomain(shop) {
  const raw = String(shop || "").trim();
  if (!raw) return "";

  let noProto = raw.replace(/^https?:\/\//i, "").trim();
  noProto = noProto.split("/")[0].trim();
  noProto = noProto.replace(/\.+$/, "").trim();

  if (noProto.endsWith(".myshopify.com")) return noProto;
  return `${noProto}.myshopify.com`;
}

// shopify-api-node attend le SLUG (sans .myshopify.com)
function shopDomainToSlug(shopDomain) {
  const d = normalizeShopDomain(shopDomain);
  return d ? d.replace(/\.myshopify\.com$/i, "") : "";
}

// ==========================
// Token handling (OAuth ONLY)
// ==========================
function getAccessTokenForShop(shopDomain) {
  const shop = normalizeShopDomain(shopDomain);
  if (!shop) throw new Error("Shop invalide (token)");

  const token = tokenStore.loadToken(shop);
  if (!token) {
    throw new Error(
      `Aucun token OAuth pour ${shop}. Installe l'app ou relance /api/auth/start?shop=${shop}`
    );
  }
  return token;
}

// ==========================
// Client factory
// ==========================
function createShopifyClient(shopDomain, accessToken) {
  const domain = normalizeShopDomain(shopDomain);
  const shopName = shopDomainToSlug(domain);

  if (!shopName) throw new Error("Shop invalide pour Shopify client");

  return new Shopify({
    shopName,               // ex: "cloud-store-test"
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
  });
}

function getShopifyClient(shop) {
  const shopDomain = normalizeShopDomain(shop);
  if (!shopDomain) throw new Error("Shop manquant pour Shopify client");

  const token = getAccessTokenForShop(shopDomain);

  // cache par shop + token (rotation safe)
  const cacheKey = `${shopDomain.toLowerCase()}::${token.slice(0, 8)}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);

  const client = createShopifyClient(shopDomain, token);
  _clientCache.set(cacheKey, client);
  return client;
}

// ==========================
// Helpers API
// ==========================
async function searchProducts(shop, opts = {}) {
  const client = getShopifyClient(shop);
  const query = String(opts.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit || 50), 1), 250);

  const products = await client.product.list({ limit });
  if (!query) return products;

  return products.filter((p) =>
    String(p.title || "").toLowerCase().includes(query)
  );
}

async function fetchProduct(shop, productId) {
  if (!productId) throw new Error("fetchProduct: productId manquant");
  const client = getShopifyClient(shop);
  return client.product.get(Number(productId));
}

async function testShopifyConnection(shop) {
  const client = getShopifyClient(shop);
  const info = await client.shop.get();

  return {
    ok: true,
    shop: info?.myshopify_domain || info?.domain || "",
    name: info?.name || "",
    plan: info?.plan_name || "",
  };
}

module.exports = {
  getShopifyClient,
  searchProducts,
  fetchProduct,
  normalizeShopDomain,
  testShopifyConnection,
};

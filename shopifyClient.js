// shopifyClient.js
const Shopify = require("shopify-api-node");
const tokenStore = require("./utils/tokenStore");

// Cache par shop pour éviter de recréer le client à chaque requête
const _clientCache = new Map();

function normalizeShopDomain(shop) {
  const raw = String(shop || "").trim();
  if (!raw) return "";

  let noProto = raw.replace(/^https?:\/\//i, "").trim();
  noProto = noProto.split("/")[0].trim();
  noProto = noProto.replace(/\.+$/, "").trim();

  if (noProto.includes(".myshopify.com")) return noProto;
  return `${noProto}.myshopify.com`;
}

// ✅ shopify-api-node veut un "shopName" = slug (ex: "e4vkqa-ea"), pas le domaine complet.
function shopDomainToSlug(shopDomain) {
  const d = normalizeShopDomain(shopDomain);
  if (!d) return "";
  return d.replace(/\.myshopify\.com$/i, "");
}

function getEnvShopDomain() {
  return normalizeShopDomain(process.env.SHOP_NAME || "");
}

function getEnvShopSlug() {
  return shopDomainToSlug(process.env.SHOP_NAME || "");
}

function getEnvAdminToken() {
  return String(process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
}

/**
 * ✅ IMPORTANT
 * - Si on a un token OAuth sauvegardé pour CE shop => on l'utilise
 * - Sinon fallback sur SHOPIFY_ADMIN_TOKEN UNIQUEMENT si shop == SHOP_NAME
 */
function getAccessTokenForShop(shopDomain) {
  const shop = normalizeShopDomain(shopDomain || "");
  if (!shop) return "";

  const oauthToken = tokenStore.loadToken(shop);
  if (oauthToken) return oauthToken;

  const envShop = getEnvShopDomain();
  const envToken = getEnvAdminToken();
  if (envToken && envShop && shop.toLowerCase() === envShop.toLowerCase()) return envToken;

  return "";
}

function createShopifyClient(shopDomain, accessToken) {
  const domain = normalizeShopDomain(shopDomain);
  const shopName = shopDomainToSlug(domain); // ✅ slug attendu par shopify-api-node

  if (!shopName) throw new Error("Shop invalide pour createShopifyClient");

  return new Shopify({
    shopName, // ✅ "xxx" (pas "xxx.myshopify.com")
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
  });
}

function getShopifyClient(shop) {
  const shopDomain = normalizeShopDomain(shop || "") || getEnvShopDomain();
  if (!shopDomain) throw new Error("SHOP_NAME manquant, ou shop introuvable");

  const token = getAccessTokenForShop(shopDomain);
  if (!token) {
    throw new Error(
      `Aucun token Shopify pour ${shopDomain}. Lance l'OAuth (/api/auth/start?shop=${shopDomain}) ou configure SHOPIFY_ADMIN_TOKEN + SHOP_NAME (fallback).`
    );
  }

  // ✅ cache key = shop + token (au cas où tu changes de token)
  const key = `${shopDomain.toLowerCase()}::${token.slice(0, 8)}`;
  if (_clientCache.has(key)) return _clientCache.get(key);

  const client = createShopifyClient(shopDomain, token);
  _clientCache.set(key, client);
  return client;
}

// --- utilitaires existants ---
async function searchProducts(shop, opts = {}) {
  const client = getShopifyClient(shop);
  const query = String(opts.query || "").trim();
  const limit = Math.max(1, Math.min(Number(opts.limit || 50), 250));

  const products = await client.product.list({ limit });

  if (!query) return products;
  const q = query.toLowerCase();
  return products.filter((p) => String(p.title || "").toLowerCase().includes(q));
}

async function fetchProduct(shop, productId) {
  const client = getShopifyClient(shop);
  if (!productId) throw new Error("fetchProduct: productId manquant");
  return client.product.get(Number(productId));
}

async function testShopifyConnection(shop) {
  const client = getShopifyClient(shop);
  const shopInfo = await client.shop.get();
  return {
    ok: true,
    shop: String(shopInfo?.myshopify_domain || shopInfo?.domain || ""),
    name: String(shopInfo?.name || ""),
    plan: String(shopInfo?.plan_name || ""),
  };
}

module.exports = {
  createShopifyClient,
  getShopifyClient,
  searchProducts,
  fetchProduct,
  normalizeShopDomain,
  testShopifyConnection,
};

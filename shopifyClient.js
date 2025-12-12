// shopifyClient.js
const Shopify = require('shopify-api-node');

function createShopifyClient(shopDomain, accessToken) {
  return new Shopify({
    shopName: shopDomain,
    accessToken,
    apiVersion: '2025-10',
  });
}

// Version actuelle : 1 seul shop, lu depuis .env
function getShopifyClient() {
  const shopDomain = process.env.SHOP_NAME;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!shopDomain || !token) {
    throw new Error('SHOP_NAME ou SHOPIFY_ADMIN_TOKEN manquant dans .env');
  }

  return createShopifyClient(shopDomain, token);
}

module.exports = {
  createShopifyClient,
  getShopifyClient,
};

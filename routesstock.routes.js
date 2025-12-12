// routes/stock.routes.js
const express = require('express');
const router = express.Router();

const { apiLimiter } = require('../middleware/rateLimit');
const {
  restockValidation,
  setTotalStockValidation,
} = require('../middleware/validation');

const { getShopifyClient } = require('../shopifyClient');
const { restockProduct, getStockSnapshot, PRODUCT_CONFIG } = require('../stockManager');
const { addMovement } = require('../movementStore');
const { logEvent } = require('../utils/logger');

const shopify = getShopifyClient();

// GET /api/stock
router.get('/', apiLimiter, (req, res) => {
  const { sort = 'alpha', categoryId = '' } = req.query;

  const snapshot = getStockSnapshot();
  let products = Object.entries(snapshot).map(([productId, p]) => ({
    productId,
    ...p,
  }));

  if (categoryId) {
    products = products.filter((p) =>
      Array.isArray(p.categoryIds) && p.categoryIds.includes(String(categoryId))
    );
  }

  if (sort === 'alpha') {
    products.sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'fr', { sensitivity: 'base' })
    );
  }

  res.json({ count: products.length, data: products });
});

// POST /api/restock
router.post('/restock', apiLimiter, restockValidation, async (req, res) => {
  try {
    const { productId, grams } = req.body;
    const g = Number(grams);

    const updated = await restockProduct(String(productId), g);
    if (!updated) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }

    // Push Shopify
    for (const [label, v] of Object.entries(updated.variants || {})) {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: v.inventoryItemId,
        available: Number(v.canSell || 0),
      });
    }

    addMovement({
      ts: new Date().toISOString(),
      type: 'restock',
      source: 'manual_restock',
      productId: String(productId),
      productName: updated.name,
      deltaGrams: +Math.abs(g),
      gramsBefore: updated.totalGrams - g,
      gramsAfter: updated.totalGrams,
    });

    logEvent('restock_success', { productId, grams: g });

    return res.json({
      success: true,
      productId: String(productId),
      newTotal: updated.totalGrams,
    });
  } catch (e) {
    logEvent('restock_error', { message: e?.message }, 'error');
    return res.status(500).json({ error: e?.message || 'Erreur serveur' });
  }
});

// POST /api/set-total-stock
router.post('/set-total-stock', apiLimiter, setTotalStockValidation, async (req, res) => {
  try {
    const { productId, totalGrams } = req.body;
    const newTotal = Number(totalGrams);

    const current = PRODUCT_CONFIG[String(productId)]?.totalGrams ?? null;
    if (current === null) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }

    const diff = newTotal - Number(current || 0);
    const updated = await restockProduct(String(productId), diff);

    // Push Shopify
    for (const [label, v] of Object.entries(updated.variants || {})) {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: v.inventoryItemId,
        available: Number(v.canSell || 0),
      });
    }

    addMovement({
      ts: new Date().toISOString(),
      type: 'set_total',
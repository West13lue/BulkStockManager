// routes/webhooks.routes.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { webhookLimiter } = require('../middleware/rateLimit');
const { getShopifyClient } = require('../shopifyClient');
const { applyOrderToProduct } = require('../stockManager');
const { addMovement } = require('../movementStore');
const { parseGramsFromVariantTitle } = require('../services/parsingService');
const { logEvent } = require('../utils/logger');

const shopify = getShopifyClient();

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return false;
  const hash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

// ✅ CORRIGÉ: Meilleure gestion d'erreurs + retry Shopify
router.post(
  '/orders/create',
  webhookLimiter,
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    const isProduction = process.env.NODE_ENV === 'production';
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

    logEvent('webhook_received', { 
      mode: isProduction ? 'production' : 'dev',
      hasHmac: !!hmacHeader 
    });

    try {
      const rawBody = req.body;

      // ✅ HMAC obligatoire en production
      if (isProduction) {
        if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
          logEvent('webhook_no_secret', {}, 'error');
          return res.sendStatus(500);
        }

        if (!hmacHeader) {
          logEvent('webhook_hmac_missing', {}, 'warn');
          return res.sendStatus(401);
        }

        const isValid = verifyShopifyWebhook(rawBody, hmacHeader);
        if (!isValid) {
          logEvent('webhook_hmac_invalid', {}, 'warn');
          return res.sendStatus(401);
        }

        logEvent('webhook_hmac_valid');
      }

      let order;
      try {
        order = JSON.parse(rawBody.toString('utf8'));
      } catch (e) {
        logEvent('webhook_json_parse_error', { error: e.message }, 'warn');
        return res.sendStatus(400);
      }

      if (!order?.id || !Array.isArray(order?.line_items)) {
        logEvent('webhook_invalid_payload', { hasId: !!order?.id }, 'warn');
        return res.sendStatus(200);
      }

      const orderId = String(order.id);
      const orderName = String(order.name || '');

      logEvent('order_processing', {
        orderId,
        orderName,
        lineCount: order.line_items.length,
      });

      // ✅ CORRIGÉ: Wrappé dans try-catch pour retry Shopify
      for (const item of order.line_items) {
        if (!item?.product_id) continue;

        const productId = String(item.product_id);
        const variantTitle = String(item.variant_title || '');
        const quantity = Number(item.quantity || 0);

        const gramsPerUnit = parseGramsFromVariantTitle(variantTitle);
        if (!gramsPerUnit || gramsPerUnit <= 0) continue;

        const gramsDelta = gramsPerUnit * quantity;

        // Applique le changement (avec queue)
        const updated = await applyOrderToProduct(productId, gramsDelta);
        if (!updated) continue;

        // Push vers Shopify
        for (const [label, v] of Object.entries(updated.variants || {})) {
          const unitsAvailable = Number(v.canSell || 0);
          try {
            await shopify.inventoryLevel.set({
              location_id: process.env.LOCATION_ID,
              inventory_item_id: v.inventoryItemId,
              available: unitsAvailable,
            });

            logEvent('inventory_level_set', {
              productId,
              label,
              unitsAvailable,
            });
          } catch (e) {
            logEvent('inventory_level_set_error', {
              productId,
              label,
              message: e?.message,
            }, 'error');
          }
        }

        // Mouvement
        addMovement({
          ts: new Date().toISOString(),
          type: 'order',
          source: 'webhook_order',
          orderId,
          orderName,
          productId,
          productName: updated.name,
          deltaGrams: -Math.abs(gramsDelta),
          gramsBefore: updated.totalGrams + gramsDelta,
          gramsAfter: updated.totalGrams,
        });
      }

      logEvent('order_processed_success', { orderId });
      return res.sendStatus(200);

    } catch (e) {
      logEvent('webhook_error', { message: e?.message, stack: e?.stack }, 'error');
      // ✅ Retourne 500 pour que Shopify retry
      return res.sendStatus(500);
    }
  }
);

module.exports = router;
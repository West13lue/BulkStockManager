// server.js
// ============================================
// GESTIONNAIRE DE STOCK CBD POUR SHOPIFY
// PRÊT POUR RENDER (PORT + 0.0.0.0 + /health)
// + LOGS STRUCTURÉS JSON
// + HISTORIQUE DES MOUVEMENTS (rotation par JOUR)
// ============================================

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { getShopifyClient } = require("./shopifyClient");
const {
  PRODUCT_CONFIG,
  applyOrderToProduct,
  getStockSnapshot,
  restockProduct,
} = require("./stockManager");

const { addMovement, listMovements, purgeOld } = require("./movementStore");

// ============================================
// LOG JSON (Render-friendly)
// ============================================
function logEvent(event, data = {}, level = "info") {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    })
  );
}

// ============================================
// PLAN / RÉTENTION
// ============================================
const PLAN = (process.env.PLAN || "free").toLowerCase();
const RETENTION_BY_PLAN = {
  free: 7,
  starter: 30,
  pro: 90,
  unlimited: 365,
};
const RETENTION_DAYS = RETENTION_BY_PLAN[PLAN] ?? 7;

// Nettoyage des anciens fichiers de mouvements au boot
try {
  purgeOld(RETENTION_DAYS);
  logEvent("movements_purged_on_boot", { retentionDays: RETENTION_DAYS, plan: PLAN });
} catch (e) {
  logEvent("movements_purge_error", { message: e.message }, "warn");
}

// ============================================
// EXPRESS
// ============================================
const app = express();

// --------------------------------------------
// Static files
// --------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------
// Health
// --------------------------------------------
app.get("/health", (req, res) => res.status(200).send("ok"));

// --------------------------------------------
// CORS
// --------------------------------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Shopify-Hmac-Sha256"
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --------------------------------------------
// CSP pour Shopify Admin (embedded-safe)
// --------------------------------------------
app.use((req, res, next) => {
  const shopDomain = process.env.SHOP_NAME
    ? `https://${process.env.SHOP_NAME}.myshopify.com`
    : "*";
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://admin.shopify.com ${shopDomain};`
  );
  next();
});

// ============================================
// SHOPIFY CLIENT
// ============================================
const shopify = getShopifyClient();

// ============================================
// HMAC Verification
// ============================================
function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    logEvent("hmac_bypass_no_secret", {}, "warn");
    return true;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
    .digest("base64");

  return hash === hmacHeader;
}

// ============================================
// Update Shopify inventory from app state
// ============================================
async function updateProductStock(productId, gramsToSubtract, context = {}) {
  const before = PRODUCT_CONFIG?.[productId]?.totalGrams ?? null;

  const update = applyOrderToProduct(productId, gramsToSubtract);
  if (!update) {
    logEvent("product_not_configured", { productId, ...context }, "warn");
    return null;
  }

  // Écrase Shopify selon ton stock interne (source de vérité = app)
  for (const [label, variantCfg] of Object.entries(update.variants)) {
    const unitsAvailable = variantCfg.canSell;
    try {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: variantCfg.inventoryItemId,
        available: unitsAvailable,
      });
    } catch (error) {
      logEvent(
        "shopify_inventory_set_error",
        {
          productId,
          label,
          inventoryItemId: variantCfg.inventoryItemId,
          message: error.message,
          ...context,
        },
        "error"
      );
    }
  }

  const after = update.totalGrams;

  logEvent("stock_updated", {
    productId,
    productName: update.name,
    gramsDelta: -Number(gramsToSubtract || 0),
    gramsBefore: before,
    gramsAfter: after,
    ...context,
  });

  return { before, after, update };
}

// ============================================
// WEBHOOK orders/create
// ============================================
app.post("/webhooks/orders/create", (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === "true";
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  logEvent("webhook_received", {
    requestId,
    path: "/webhooks/orders/create",
    mode: isProduction ? "production" : "dev",
  });

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));

  req.on("end", async () => {
    try {
      if (chunks.length === 0) {
        logEvent("webhook_no_body", { requestId }, "warn");
        return res.sendStatus(400);
      }

      const rawBody = Buffer.concat(chunks);

      // HMAC validation in production
      if (isProduction && process.env.SHOPIFY_WEBHOOK_SECRET && !skipHmac) {
        if (!hmacHeader) {
          logEvent("webhook_hmac_missing", { requestId }, "warn");
          return res.sendStatus(401);
        }
        const isValid = verifyShopifyWebhook(rawBody, hmacHeader);
        if (!isValid) {
          logEvent("webhook_hmac_invalid", { requestId }, "warn");
          return res.sendStatus(401);
        }
        logEvent("webhook_hmac_valid", { requestId });
      } else {
        logEvent("webhook_hmac_skipped", { requestId, reason: skipHmac ? "SKIP_HMAC_VALIDATION" : "not_production_or_no_secret" }, "warn");
      }

      let order;
      try {
        order = JSON.parse(rawBody.toString("utf8"));
      } catch (e) {
        logEvent("webhook_json_parse_error", { requestId }, "warn");
        return res.sendStatus(400);
      }

      if (!order?.id || !Array.isArray(order?.line_items)) {
        logEvent("webhook_invalid_payload", { requestId }, "warn");
        return res.sendStatus(200);
      }

      logEvent("order_received", {
        requestId,
        orderId: String(order.id),
        orderName: order.name || null,
        lineItems: order.line_items.length,
      });

      for (const item of order.line_items) {
        const productId = item?.product_id ? String(item.product_id) : null;
        const variantTitle = item?.variant_title || "";
        const quantity = Number(item?.quantity || 0);

        if (!productId) continue;

        if (!PRODUCT_CONFIG[productId]) {
          logEvent("skip_line_item", {
            requestId,
            orderId: String(order.id),
            reason: "product_not_in_config",
            productId,
            title: item?.title || null,
          });
          continue;
        }

        if (!variantTitle) {
          logEvent("skip_line_item", {
            requestId,
            orderId: String(order.id),
            reason: "missing_variant_title",
            productId,
            title: item?.title || null,
          });
          continue;
        }

        const gramsMatch = variantTitle.match(/([\d.,]+)/);
        if (!gramsMatch) {
          logEvent("skip_line_item", {
            requestId,
            orderId: String(order.id),
            reason: "no_grams_in_variant_title",
            productId,
            variantTitle,
            title: item?.title || null,
          });
          continue;
        }

        const gramsPerUnit = parseFloat(gramsMatch[1].replace(",", "."));
        const totalGrams = gramsPerUnit * quantity;

        const ctx = {
          requestId,
          source: "shopify:webhook",
          orderId: String(order.id),
          orderName: order.name || null,
          lineTitle: item?.title || null,
          variantTitle,
        };

        // Update app state + overwrite Shopify inventory
        const result = await updateProductStock(productId, totalGrams, ctx);

        // Movement log (rotation par jour)
        if (result?.update) {
          addMovement({
            ts: new Date().toISOString(),
            type: "order",
            source: "shopify:webhook",
            requestId,
            orderId: String(order.id),
            orderName: order.name || null,
            productId,
            productName: result.update.name,
            deltaGrams: -Number(totalGrams),
            gramsBefore: result.before,
            gramsAfter: result.after,
            lineTitle: item?.title || null,
            variantTitle,
          });

          logEvent("movement_recorded", {
            requestId,
            orderId: String(order.id),
            productId,
            deltaGrams: -Number(totalGrams),
          });
        }
      }

      return res.sendStatus(200);
    } catch (err) {
      logEvent("webhook_error", { requestId, message: err.message }, "error");
      if (!res.headersSent) return res.sendStatus(500);
    }
  });

  req.on("error", (err) => {
    logEvent("webhook_stream_error", { requestId, message: err.message }, "error");
    if (!res.headersSent) return res.sendStatus(500);
  });
});

// ============================================
// API: server info
// ============================================
app.get("/api/server-info", (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || "development",
    port: process.env.PORT || 3000,
    hmacEnabled: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    productCount: Object.keys(PRODUCT_CONFIG).length,
    plan: PLAN,
    retentionDays: RETENTION_DAYS,
  });
});

// ============================================
// API: stock snapshot
// ============================================
app.get("/api/stock", (req, res) => {
  res.json(getStockSnapshot());
});

// ============================================
// API: movements list (last N days)
// GET /api/movements?days=7
// ============================================
app.get("/api/movements", (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days || RETENTION_DAYS), RETENTION_DAYS));
  const data = listMovements({ days });

  // Tri décroissant par date (au cas où)
  data.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  res.json({
    days,
    count: data.length,
    data,
  });
});

// ============================================
// API: purge old movements now
// POST /api/movements/purge
// ============================================
app.post("/api/movements/purge", express.json(), (req, res) => {
  try {
    purgeOld(RETENTION_DAYS);
    logEvent("movements_purged_manual", { retentionDays: RETENTION_DAYS, plan: PLAN });
    res.json({ success: true, retentionDays: RETENTION_DAYS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// API: restock (+ / -)
// POST /api/restock { productId, grams }
// ============================================
app.post("/api/restock", express.json(), async (req, res) => {
  try {
    const productId = String(req.body?.productId || "");
    const g = Number(req.body?.grams);

    if (!productId || !PRODUCT_CONFIG[productId]) {
      return res.status(404).json({ error: "Produit non trouvé" });
    }
    if (!Number.isFinite(g) || g === 0) {
      return res.status(400).json({ error: "Quantité invalide" });
    }

    const before = PRODUCT_CONFIG[productId].totalGrams ?? null;

    // Modifie l'état interne
    const updated = restockProduct(productId, g);
    if (!updated) return res.status(404).json({ error: "Produit non trouvé" });

    // Écrase Shopify selon l'état interne (0 pour ne pas resoustraire)
    const ctx = { source: "manual:restock" };
    await updateProductStock(productId, 0, ctx);

    addMovement({
      ts: new Date().toISOString(),
      type: "restock",
      source: "manual",
      productId,
      productName: updated.name,
      deltaGrams: Number(g),
      gramsBefore: before,
      gramsAfter: updated.totalGrams,
    });

    logEvent("restock_done", {
      productId,
      productName: updated.name,
      gramsDelta: Number(g),
      gramsBefore: before,
      gramsAfter: updated.totalGrams,
    });

    return res.json({
      success: true,
      productId,
      newTotal: updated.totalGrams,
    });
  } catch (error) {
    logEvent("api_restock_error", { message: error.message }, "error");
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// API: set total stock
// POST /api/set-total-stock { productId, totalGrams }
// ============================================
app.post("/api/set-total-stock", express.json(), async (req, res) => {
  try {
    const productId = String(req.body?.productId || "");
    const newTotal = Number(req.body?.totalGrams);

    if (!productId || !PRODUCT_CONFIG[productId]) {
      return res.status(404).json({ error: "Produit non trouvé" });
    }
    if (!Number.isFinite(newTotal) || newTotal < 0) {
      return res.status(400).json({ error: "Quantité invalide" });
    }

    const currentTotal = Number(PRODUCT_CONFIG[productId].totalGrams || 0);
    const difference = newTotal - currentTotal;

    const updated = restockProduct(productId, difference);
    if (!updated) return res.status(404).json({ error: "Produit non trouvé" });

    const ctx = { source: "manual:set_total" };
    await updateProductStock(productId, 0, ctx);

    addMovement({
      ts: new Date().toISOString(),
      type: "set_total",
      source: "manual",
      productId,
      productName: updated.name,
      deltaGrams: Number(difference),
      gramsBefore: currentTotal,
      gramsAfter: updated.totalGrams,
    });

    logEvent("set_total_done", {
      productId,
      productName: updated.name,
      gramsBefore: currentTotal,
      gramsAfter: updated.totalGrams,
      deltaGrams: Number(difference),
    });

    return res.json({
      success: true,
      productId,
      previousTotal: currentTotal,
      newTotal: updated.totalGrams,
      difference,
    });
  } catch (error) {
    logEvent("api_set_total_error", { message: error.message }, "error");
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// API: test order (manual simulation)
// POST /api/test-order
// ============================================
app.post("/api/test-order", express.json(), async (req, res) => {
  try {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    logEvent("test_order_start", { requestId });

    const testOrder = {
      id: Date.now(),
      name: "#TEST-" + Date.now(),
      line_items: [
        {
          product_id: 10349843513687,
          variant_title: "3",
          quantity: 2,
          title: "3x Filtré",
        },
      ],
    };

    for (const item of testOrder.line_items) {
      const productId = String(item.product_id);
      const variantTitle = item.variant_title || "";
      const quantity = Number(item.quantity || 0);

      const gramsMatch = variantTitle.match(/([\d.,]+)/);
      if (!gramsMatch) continue;

      const gramsPerUnit = parseFloat(gramsMatch[1].replace(",", "."));
      const totalGrams = gramsPerUnit * quantity;

      const ctx = {
        requestId,
        source: "test_order",
        orderId: String(testOrder.id),
        orderName: testOrder.name,
        lineTitle: item.title,
        variantTitle,
      };

      const result = await updateProductStock(productId, totalGrams, ctx);

      if (result?.update) {
        addMovement({
          ts: new Date().toISOString(),
          type: "test_order",
          source: "test_order",
          requestId,
          orderId: String(testOrder.id),
          orderName: testOrder.name,
          productId,
          productName: result.update.name,
          deltaGrams: -Number(totalGrams),
          gramsBefore: result.before,
          gramsAfter: result.after,
          lineTitle: item.title,
          variantTitle,
        });
      }
    }

    logEvent("test_order_done", { requestId, orderId: String(testOrder.id) });

    return res.json({
      success: true,
      message: "Commande test traitée",
      order: testOrder,
    });
  } catch (error) {
    logEvent("test_order_error", { message: error.message }, "error");
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// Home
// ============================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================
// Start server (Render-ready)
// ============================================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  logEvent("server_started", {
    host: HOST,
    port: PORT,
    productCount: Object.keys(PRODUCT_CONFIG).length,
    plan: PLAN,
    retentionDays: RETENTION_DAYS,
  });
});

// ============================================
// GESTIONNAIRE DE STOCK CBD POUR SHOPIFY
// PRÊT POUR RENDER (PORT + 0.0.0.0 + /health)
// + Historique mouvements (Option 2) + Logs JSON
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

const { addMovement, listMovements, toCSV } = require("./movementStore");

// --------------------------------------------
// Logger structuré (Render friendly)
// --------------------------------------------
function logEvent(event, data = {}, level = "info") {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  console.log(JSON.stringify(payload));
}

const app = express();

// ============================================
// HEALTHCHECK
// ============================================
app.get("/health", (req, res) => res.status(200).send("ok"));

// ============================================
// MIDDLEWARE : Servir les fichiers statiques
// ============================================
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// MIDDLEWARE : CORS
// ============================================
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

// ============================================
// MIDDLEWARE : CSP pour Shopify Admin
// ============================================
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
// CONFIG SHOPIFY
// ============================================
const shopify = getShopifyClient();

// ============================================
// FONCTION : Vérification HMAC Shopify
// ============================================
function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("⚠️ SHOPIFY_WEBHOOK_SECRET non défini - Mode DEV (HMAC bypass)");
    return true;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
    .digest("base64");

  return hash === hmacHeader;
}

// ============================================
// FONCTION : Mise à jour du stock
// ============================================
async function updateProductStock(productId, gramsToSubtract) {
  const update = applyOrderToProduct(productId, gramsToSubtract);
  if (!update) {
    logEvent("product_not_configured", { productId }, "warn");
    return;
  }

  logEvent("product_stock_updated_local", {
    productId,
    name: update.name,
    totalGrams: update.totalGrams,
  });

  for (const [label, variantCfg] of Object.entries(update.variants)) {
    const unitsAvailable = variantCfg.canSell;

    try {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: variantCfg.inventoryItemId,
        available: unitsAvailable,
      });

      logEvent("inventory_level_set", {
        productId,
        label,
        unitsAvailable,
        inventoryItemId: variantCfg.inventoryItemId,
        locationId: process.env.LOCATION_ID,
      });
    } catch (error) {
      logEvent(
        "inventory_level_set_error",
        { productId, label, message: error.message },
        "error"
      );
    }
  }

  return update.totalGrams;
}

// ============================================
// WEBHOOK : Commande créée
// ============================================
app.post("/webhooks/orders/create", (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === "true";
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  logEvent("webhook_received", { mode: isProduction ? "production" : "dev" });

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));

  req.on("end", async () => {
    try {
      if (chunks.length === 0) {
        logEvent("webhook_empty_body", {}, "warn");
        return res.sendStatus(400);
      }

      const rawBody = Buffer.concat(chunks);

      // Vérification HMAC en production
      if (isProduction && process.env.SHOPIFY_WEBHOOK_SECRET && !skipHmac) {
        if (!hmacHeader) {
          logEvent("webhook_hmac_missing", {}, "warn");
          return res.sendStatus(401);
        }
        const isValid = verifyShopifyWebhook(rawBody, hmacHeader);
        if (!isValid) {
          logEvent("webhook_hmac_invalid", {}, "warn");
          return res.sendStatus(401);
        }
        logEvent("webhook_hmac_valid");
      }

      let order;
      try {
        order = JSON.parse(rawBody.toString("utf8"));
      } catch (e) {
        logEvent("webhook_json_parse_error", {}, "warn");
        return res.sendStatus(400);
      }

      if (!order.id || !order.line_items) {
        logEvent("webhook_invalid_payload", { hasId: !!order.id }, "warn");
        return res.sendStatus(200);
      }

      logEvent("order_received", {
        orderId: String(order.id),
        orderName: order.name || null,
        lineCount: order.line_items.length,
      });

      for (const item of order.line_items) {
        if (!item.product_id) continue;

        const productId = item.product_id.toString();
        const variantTitle = item.variant_title || "";
        const quantity = item.quantity || 0;

        if (!PRODUCT_CONFIG[productId] || !variantTitle) continue;

        const gramsMatch = variantTitle.match(/([\d.,]+)/);
        if (!gramsMatch) continue;

        const gramsPerUnit = parseFloat(gramsMatch[1].replace(",", "."));
        const totalGrams = gramsPerUnit * quantity;

        const before = PRODUCT_CONFIG[productId]?.totalGrams ?? null;

        await updateProductStock(productId, totalGrams);

        const after = PRODUCT_CONFIG[productId]?.totalGrams ?? null;

        // Historique + logs structurés
        addMovement({
          source: "webhook",
          productId,
          productName: PRODUCT_CONFIG[productId]?.name,
          gramsDelta: -totalGrams,
          gramsBefore: before,
          gramsAfter: after,
          orderId: order.id,
          orderName: order.name,
          lineTitle: item.title,
          variantTitle,
          meta: { quantity, gramsPerUnit },
        });

        logEvent("stock_movement", {
          source: "webhook",
          productId,
          gramsDelta: -totalGrams,
          orderId: String(order.id),
        });
      }

      return res.sendStatus(200);
    } catch (err) {
      logEvent("webhook_processing_error", { message: err.message }, "error");
      if (!res.headersSent) return res.sendStatus(500);
    }
  });

  req.on("error", (err) => {
    logEvent("webhook_stream_error", { message: err.message }, "error");
    if (!res.headersSent) return res.sendStatus(500);
  });
});

// ============================================
// API : Informations serveur
// ============================================
app.get("/api/server-info", (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || "development",
    port: process.env.PORT || 3000,
    hmacEnabled: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    productCount: Object.keys(PRODUCT_CONFIG).length,
  });
});

// ============================================
// API : Stock actuel
// ============================================
app.get("/api/stock", (req, res) => {
  const stock = getStockSnapshot();
  res.json(stock);
});

// ============================================
// API : Historique des mouvements (mémoire)
// GET /api/movements?limit=200&productId=...&orderId=...&source=webhook
// ============================================
app.get("/api/movements", (req, res) => {
  const { limit, productId, orderId, source } = req.query;
  const data = listMovements({ limit, productId, orderId, source });
  res.json({ count: data.length, data });
});

// ============================================
// API : Export mouvements (CSV ou JSON)
// GET /api/movements/export?format=csv&limit=1000
// ============================================
app.get("/api/movements/export", (req, res) => {
  const { format = "json", limit, productId, orderId, source } = req.query;
  const data = listMovements({
    limit: limit || 1000,
    productId,
    orderId,
    source,
  });

  if (String(format).toLowerCase() === "csv") {
    const csv = toCSV(data);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="stock-movements-${Date.now()}.csv"`
    );
    return res.send(csv);
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="stock-movements-${Date.now()}.json"`
  );
  return res.send(JSON.stringify({ count: data.length, data }, null, 2));
});

// ============================================
// API : Réapprovisionner
// ============================================
app.post("/api/restock", express.json(), async (req, res) => {
  try {
    const { productId, grams } = req.body;
    const g = Number(grams);

    if (!g || g <= 0) {
      return res.status(400).json({ error: "Quantité invalide" });
    }

    const before = PRODUCT_CONFIG[productId]?.totalGrams ?? null;

    const updated = restockProduct(productId, g);
    if (!updated) {
      return res.status(404).json({ error: "Produit non trouvé" });
    }

    await updateProductStock(productId, 0);

    addMovement({
      source: "restock",
      productId,
      productName: updated.name,
      gramsDelta: +g,
      gramsBefore: before,
      gramsAfter: updated.totalGrams,
      meta: { via: "api/restock" },
    });

    logEvent("stock_movement", { source: "restock", productId, gramsDelta: +g });

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
// API : Définir le stock total manuellement
// ============================================
app.post("/api/set-total-stock", express.json(), async (req, res) => {
  try {
    const { productId, totalGrams } = req.body;
    const newTotal = Number(totalGrams);

    if (isNaN(newTotal) || newTotal < 0) {
      return res.status(400).json({ error: "Quantité invalide" });
    }

    const product = PRODUCT_CONFIG[productId];
    if (!product) {
      return res.status(404).json({ error: "Produit non trouvé" });
    }

    const currentTotal = product.totalGrams || 0;
    const difference = newTotal - currentTotal;

    const updated = restockProduct(productId, difference);

    await updateProductStock(productId, 0);

    addMovement({
      source: "set_total",
      productId,
      productName: updated.name,
      gramsDelta: difference,
      gramsBefore: currentTotal,
      gramsAfter: updated.totalGrams,
      meta: { via: "api/set-total-stock" },
    });

    logEvent("stock_movement", {
      source: "set_total",
      productId,
      gramsDelta: difference,
    });

    return res.json({
      success: true,
      productId,
      previousTotal: currentTotal,
      newTotal: updated.totalGrams,
      difference,
    });
  } catch (error) {
    logEvent("api_set_total_stock_error", { message: error.message }, "error");
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// API : Test de commande (même logique que webhook)
// ============================================
app.post("/api/test-order", express.json(), async (req, res) => {
  try {
    logEvent("test_order_start");

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
      const productId = item.product_id.toString();
      const variantTitle = item.variant_title || "";
      const quantity = item.quantity;

      const gramsMatch = variantTitle.match(/([\d.,]+)/);
      if (!gramsMatch) continue;

      const gramsPerUnit = parseFloat(gramsMatch[1].replace(",", "."));
      const totalGrams = gramsPerUnit * quantity;

      const before = PRODUCT_CONFIG[productId]?.totalGrams ?? null;

      await updateProductStock(productId, totalGrams);

      const after = PRODUCT_CONFIG[productId]?.totalGrams ?? null;

      addMovement({
        source: "test_order",
        productId,
        productName: PRODUCT_CONFIG[productId]?.name,
        gramsDelta: -totalGrams,
        gramsBefore: before,
        gramsAfter: after,
        orderId: testOrder.id,
        orderName: testOrder.name,
        lineTitle: item.title,
        variantTitle,
        meta: { quantity, gramsPerUnit },
      });

      logEvent("stock_movement", {
        source: "test_order",
        productId,
        gramsDelta: -totalGrams,
        orderId: String(testOrder.id),
      });
    }

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
// ROUTE : Page d'accueil (sert index.html)
// ============================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================
// DÉMARRAGE DU SERVEUR (Render-ready)
// ============================================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const PUBLIC_URL = process.env.RENDER_PUBLIC_URL || "";

app.listen(PORT, HOST, () => {
  logEvent("server_started", {
    host: HOST,
    port: PORT,
    productCount: Object.keys(PRODUCT_CONFIG).length,
    publicUrl: PUBLIC_URL || null,
    health: (PUBLIC_URL ? `${PUBLIC_URL}/health` : null),
    webhook: (PUBLIC_URL ? `${PUBLIC_URL}/webhooks/orders/create` : null),
  });
});

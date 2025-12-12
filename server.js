// server.js
// ============================================
// Bulk Stock Manager - Shopify (Render)
// API alignée avec public/js/app.js
// - Static: /public (index.html + css/js)
// - API: server-info, stock, categories, shopify products, import, movements JSON/CSV
// - Webhook: orders/create (HMAC) => MAJ stock + push Shopify inventory
// ============================================

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { getShopifyClient } = require("./shopifyClient");

// Stock
const {
  PRODUCT_CONFIG,
  applyOrderToProduct,
  restockProduct,
  getStockSnapshot,
  setProductCategories,
  upsertImportedProductConfig,
} = require("./stockManager");

// Mouvements
const { addMovement, listMovements, toCSV } = require("./movementStore");

// Catégories
const { listCategories, createCategory, renameCategory, deleteCategory } = require("./catalogStore");

const app = express();
const shopify = getShopifyClient();

// ---------------- Helpers ----------------
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

function parseGramsFromVariantTitle(variantTitle = "") {
  const m = String(variantTitle).match(/([\d.,]+)/);
  if (!m) return null;
  return parseFloat(m[1].replace(",", "."));
}

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // dev
  const hash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
  return hash === hmacHeader;
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function stockToCSV(products) {
  const cols = ["productId", "name", "totalGrams", "categoryIds", "variants"];
  const header = cols.join(",");

  const lines = products.map((p) => {
    const row = {
      productId: p.productId,
      name: p.name,
      totalGrams: p.totalGrams,
      categoryIds: (p.categoryIds || []).join("|"),
      variants: JSON.stringify(p.variants || {}),
    };
    return cols.map((c) => csvEscape(row[c])).join(",");
  });

  return [header, ...lines].join("\n");
}

// ---------------- Middlewares ----------------

// Static assets (public/)
app.use(express.static(path.join(__dirname, "public")));

// CORS (simple)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Shopify-Hmac-Sha256");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// CSP Shopify Admin (iframe)
app.use((req, res, next) => {
  const shopDomain = process.env.SHOP_NAME ? `https://${process.env.SHOP_NAME}.myshopify.com` : "*";
  res.setHeader("Content-Security-Policy", `frame-ancestors https://admin.shopify.com ${shopDomain};`);
  next();
});

// JSON sur /api uniquement (webhook utilise raw)
app.use("/api", express.json({ limit: "2mb" }));

// Health check
app.get("/health", (req, res) => res.status(200).send("ok"));

// Home page
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------- API ----------------

// Infos serveur
app.get("/api/server-info", (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || "development",
    port: process.env.PORT || 3000,
    hmacEnabled: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    productCount: Object.keys(PRODUCT_CONFIG || {}).length,
    lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
  });
});

// Stock (format app.js: { products, categories })
app.get("/api/stock", (req, res) => {
  const { sort = "", category = "" } = req.query;

  const snapshot = getStockSnapshot();
  let products = Object.entries(snapshot).map(([productId, p]) => ({
    productId: String(productId),
    name: p.name,
    totalGrams: Number(p.totalGrams || 0),
    categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds : [],
    variants: p.variants || {},
  }));

  if (category) {
    products = products.filter((p) => Array.isArray(p.categoryIds) && p.categoryIds.includes(String(category)));
  }

  if (sort === "alpha") {
    products.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
    );
  }

  res.json({
    products,
    categories: listCategories(),
  });
});

// CSV stock
app.get("/api/stock.csv", (req, res) => {
  const snapshot = getStockSnapshot();
  const products = Object.entries(snapshot).map(([productId, p]) => ({
    productId: String(productId),
    name: p.name,
    totalGrams: Number(p.totalGrams || 0),
    categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds : [],
    variants: p.variants || {},
  }));

  const csv = stockToCSV(products);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="stock.csv"');
  res.send(csv);
});

// ✅ NEW: Mouvements JSON (pour affichage au-dessus console)
app.get("/api/movements", (req, res) => {
  try {
    const days = Math.min(Number(req.query.days || 7), 90);
    const limit = Math.min(Number(req.query.limit || 80), 1000);

    const rows = listMovements({ days })
      .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0))
      .slice(0, limit);

    return res.json({ movements: rows });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Erreur mouvements" });
  }
});

// CSV mouvements
app.get("/api/movements.csv", (req, res) => {
  const days = Math.min(Number(req.query.days || 7), 90);
  const rows = listMovements({ days });
  const csv = toCSV(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="movements.csv"');
  res.send(csv);
});

// -------- Categories (format app.js: {categories}) --------
app.get("/api/categories", (req, res) => {
  res.json({ categories: listCategories() });
});

app.post("/api/categories", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nom invalide" });
  const created = createCategory(name);
  res.json({ success: true, category: created });
});

app.put("/api/categories/:id", (req, res) => {
  const id = String(req.params.id);
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nom invalide" });

  const updated = renameCategory(id, name);
  if (!updated) return res.status(404).json({ error: "Catégorie introuvable" });
  res.json({ success: true, category: updated });
});

app.delete("/api/categories/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = deleteCategory(id);
  if (!ok) return res.status(404).json({ error: "Catégorie introuvable" });
  res.json({ success: true });
});

// Assigner catégories à un produit (app.js => POST)
app.post("/api/products/:productId/categories", (req, res) => {
  const productId = String(req.params.productId);
  const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(String) : [];
  const ok = setProductCategories(productId, categoryIds);
  if (!ok) return res.status(404).json({ error: "Produit introuvable" });
  res.json({ success: true });
});

// -------- Restock --------
app.post("/api/restock", async (req, res) => {
  try {
    const productId = String(req.body?.productId || "");
    const grams = Number(req.body?.grams || 0);
    if (!productId) return res.status(400).json({ error: "productId manquant" });
    if (!grams || grams <= 0) return res.status(400).json({ error: "Quantité invalide" });

    const updated = await restockProduct(productId, grams);
    if (!updated) return res.status(404).json({ error: "Produit introuvable" });

    // Push Shopify inventory
    for (const [label, v] of Object.entries(updated.variants || {})) {
      try {
        await shopify.inventoryLevel.set({
          location_id: process.env.LOCATION_ID,
          inventory_item_id: v.inventoryItemId,
          available: Number(v.canSell || 0),
        });
      } catch (e) {
        logEvent("inventory_set_error", { productId, label, message: e?.message }, "error");
      }
    }

    addMovement({
      ts: new Date().toISOString(),
      type: "restock",
      source: "manual",
      productId,
      productName: updated.name,
      deltaGrams: grams,
      gramsAfter: updated.totalGrams,
    });

    res.json({ success: true, product: updated });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Erreur serveur" });
  }
});

// -------- Test order --------
app.post("/api/test-order", async (req, res) => {
  try {
    const pid = Object.keys(PRODUCT_CONFIG || {})[0];
    if (!pid) return res.status(400).json({ error: "Aucun produit configuré" });

    const p = PRODUCT_CONFIG[pid];
    const labels = Object.keys(p.variants || {})
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const gramsPerUnit = labels.length ? labels[0] : 1;

    const updated = await applyOrderToProduct(String(pid), gramsPerUnit);

    if (updated) {
      for (const [label, v] of Object.entries(updated.variants || {})) {
        try {
          await shopify.inventoryLevel.set({
            location_id: process.env.LOCATION_ID,
            inventory_item_id: v.inventoryItemId,
            available: Number(v.canSell || 0),
          });
        } catch (e) {
          logEvent("inventory_set_error", { pid, label, message: e?.message }, "error");
        }
      }

      addMovement({
        ts: new Date().toISOString(),
        type: "test_order",
        source: "manual",
        productId: String(pid),
        productName: updated.name,
        deltaGrams: -Math.abs(gramsPerUnit),
        gramsAfter: updated.totalGrams,
      });
    }

    res.json({ success: true, product: updated });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Erreur test-order" });
  }
});

// -------- Shopify: Search products (format app.js) --------
app.get("/api/shopify/products", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 250);
    const query = String(req.query.query || "").trim().toLowerCase();

    const products = await shopify.product.list({ limit });

    const filtered = (products || []).filter((p) => {
      if (!query) return true;
      return String(p.title || "").toLowerCase().includes(query);
    });

    const out = filtered.map((p) => ({
      id: String(p.id),
      title: p.title,
      variantsCount: Array.isArray(p.variants) ? p.variants.length : 0,
    }));

    res.json({ products: out });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Erreur Shopify" });
  }
});

// -------- Import product from Shopify --------
app.post("/api/import/product", async (req, res) => {
  try {
    const productId = String(req.body?.productId || "");
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(String) : [];
    const gramsMode = String(req.body?.gramsMode || "parse_title");

    if (!productId) return res.status(400).json({ error: "productId manquant" });

    const p = await shopify.product.get(Number(productId));
    if (!p?.id) return res.status(404).json({ error: "Produit Shopify introuvable" });

    const variants = {};
    for (const v of p.variants || []) {
      let grams = null;

      if (gramsMode === "parse_title") {
        grams = parseGramsFromVariantTitle(v.title);
      }

      if (!grams || grams <= 0) continue;

      variants[String(grams)] = {
        gramsPerUnit: grams,
        inventoryItemId: Number(v.inventory_item_id),
      };
    }

    const imported = upsertImportedProductConfig({
      productId: String(p.id),
      name: String(p.title || p.handle || p.id),
      variants,
      categoryIds,
    });

    addMovement({
      ts: new Date().toISOString(),
      type: "import",
      source: "shopify",
      productId: String(p.id),
      productName: imported.name,
      deltaGrams: 0,
      gramsAfter: imported.totalGrams,
    });

    res.json({ success: true, product: imported });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Erreur import" });
  }
});

// ---------------- Webhook Shopify ----------------
// IMPORTANT: raw body ici sinon HMAC faux
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === "true";
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  try {
    const rawBody = req.body; // Buffer

    if (isProduction && process.env.SHOPIFY_WEBHOOK_SECRET && !skipHmac) {
      if (!hmacHeader) return res.sendStatus(401);
      const ok = verifyShopifyWebhook(rawBody, hmacHeader);
      if (!ok) return res.sendStatus(401);
    }

    const order = JSON.parse(rawBody.toString("utf8"));
    if (!order?.id || !Array.isArray(order?.line_items)) return res.sendStatus(200);

    logEvent("order_received", { orderId: String(order.id), lines: order.line_items.length });

    for (const item of order.line_items) {
      const productId = item?.product_id ? String(item.product_id) : null;
      if (!productId) continue;
      if (!PRODUCT_CONFIG[productId]) continue;

      const gramsPerUnit = parseGramsFromVariantTitle(item.variant_title || "");
      const qty = Number(item.quantity || 0);
      if (!gramsPerUnit || gramsPerUnit <= 0 || qty <= 0) continue;

      const gramsDelta = gramsPerUnit * qty;

      const updated = await applyOrderToProduct(productId, gramsDelta);
      if (!updated) continue;

      // Push Shopify inventory
      for (const [label, v] of Object.entries(updated.variants || {})) {
        try {
          await shopify.inventoryLevel.set({
            location_id: process.env.LOCATION_ID,
            inventory_item_id: v.inventoryItemId,
            available: Number(v.canSell || 0),
          });
        } catch (e) {
          logEvent("inventory_set_error", { productId, label, message: e?.message }, "error");
        }
      }

      addMovement({
        ts: new Date().toISOString(),
        type: "order",
        source: "webhook",
        orderId: String(order.id),
        orderName: String(order.name || ""),
        productId,
        productName: updated.name,
        deltaGrams: -Math.abs(gramsDelta),
        gramsAfter: updated.totalGrams,
        variantTitle: String(item.variant_title || ""),
        lineTitle: String(item.title || ""),
      });

      logEvent("stock_updated", { productId, gramsAfter: updated.totalGrams, delta: -Math.abs(gramsDelta) });
    }

    return res.sendStatus(200);
  } catch (e) {
    logEvent("webhook_error", { message: e?.message }, "error");
    return res.sendStatus(500);
  }
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", {
    port: PORT,
    products: Object.keys(PRODUCT_CONFIG || {}).length,
  });
});

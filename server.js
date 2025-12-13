// server.js (Render + Shopify Admin iframe + Express5 safe)

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");

// ✅ Chemins projet (mémorisés)
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");

// Utils
const { logEvent } = require("./utils/logger");

// Shopify
const { getShopifyClient } = require("./shopifyClient");
const shopify = getShopifyClient();

// Stock manager (import SAFE)
const stock = require("./stockManager");
const PRODUCT_CONFIG = stock?.PRODUCT_CONFIG || {};
const {
  applyOrderToProduct,
  restockProduct,
  upsertImportedProductConfig,
  setProductCategories,
  getCatalogSnapshot,
  removeProduct,
} = stock;

// Stores
const {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
} = require("./catalogStore");

const { addMovement, listMovements, toCSV, clearMovements } = require("./movementStore");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// Middlewares
// -----------------------------
app.use(express.json({ limit: "2mb" }));

// CORS simple (ok pour admin iframe/fetch)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Shopify-Hmac-Sha256");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// CSP Shopify Admin (iframe)
app.use((req, res, next) => {
  const shopDomain = process.env.SHOP_NAME ? `https://${process.env.SHOP_NAME}.myshopify.com` : "*";
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://admin.shopify.com ${shopDomain};`
  );
  next();
});

// Front static : ✅ sert /css/style.css et /js/app.js
app.use(express.static(PUBLIC_DIR));

// Health
app.get("/health", (req, res) => res.status(200).send("ok"));

// -----------------------------
// API - Infos
// -----------------------------
app.get("/api/server-info", (req, res) => {
  res.json({
    port: PORT,
    productsCount: Object.keys(PRODUCT_CONFIG || {}).length,
  });
});

// -----------------------------
// API - Stock/Catalog
// -----------------------------
app.get("/api/stock", (req, res) => {
  try {
    const snap = getCatalogSnapshot ? getCatalogSnapshot() : { products: [], categories: [] };
    res.json(snap);
  } catch (e) {
    console.error("GET /api/stock error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Assigner catégories à un produit
app.post("/api/products/:id/categories", (req, res) => {
  try {
    const id = String(req.params.id);
    const { categoryIds } = req.body || {};
    const ok = setProductCategories ? setProductCategories(id, categoryIds) : false;
    if (!ok) return res.status(404).json({ error: "Produit introuvable" });
    res.json({ success: true });
  } catch (e) {
    console.error("POST product categories error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// API - Catégories
// -----------------------------
app.get("/api/categories", (req, res) => {
  try {
    res.json({ categories: listCategories() });
  } catch (e) {
    console.error("GET categories error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/categories", (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Nom requis" });

    const created = createCategory(String(name).trim());

    // movement non-bloquant
    try { addMovement({ source: "category_create", gramsDelta: 0, meta: created }); } catch {}

    res.json({ success: true, category: created });
  } catch (e) {
    console.error("POST category error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/categories/:id", (req, res) => {
  try {
    const id = String(req.params.id);
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Nom requis" });

    const updated = renameCategory(id, String(name).trim());
    if (!updated) return res.status(404).json({ error: "Catégorie introuvable" });

    res.json({ success: true, category: updated });
  } catch (e) {
    console.error("PUT category error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/categories/:id", (req, res) => {
  try {
    const ok = deleteCategory(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Catégorie introuvable" });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE category error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// API - Import Shopify
// -----------------------------
app.get("/api/shopify/products", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const products = await shopify.product.list({ limit });

    res.json({
      products: (products || []).map((p) => ({
        id: String(p.id),
        title: String(p.title || ""),
        variantsCount: Array.isArray(p.variants) ? p.variants.length : 0,
      })),
    });
  } catch (e) {
    console.error("GET shopify products error:", e);
    res.status(500).json({ error: e.message });
  }
});

function parseGrams(v) {
  const candidates = [v?.option1, v?.option2, v?.option3, v?.title, v?.sku].filter(Boolean);
  for (const c of candidates) {
    const m = String(c).match(/([\d.,]+)/);
    if (!m) continue;
    const g = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(g) && g > 0) return g;
  }
  return null;
}

app.post("/api/import/product", async (req, res) => {
  try {
    const { productId, totalGrams, categoryIds } = req.body || {};
    if (!productId) return res.status(400).json({ error: "productId manquant" });

    const p = await shopify.product.get(Number(productId));
    if (!p?.id) return res.status(404).json({ error: "Produit introuvable" });

    const variants = {};
    for (const v of p.variants || []) {
      const grams = parseGrams(v);
      if (!grams) continue;
      variants[String(grams)] = {
        gramsPerUnit: grams,
        inventoryItemId: Number(v.inventory_item_id),
      };
    }

    const imported = upsertImportedProductConfig({
      productId: String(p.id),
      name: String(p.title || p.handle || p.id),
      totalGrams: Number.isFinite(Number(totalGrams)) ? Number(totalGrams) : undefined,
      variants,
      categoryIds: Array.isArray(categoryIds) ? categoryIds.map(String) : [],
    });

    res.json({ success: true, product: imported });
  } catch (e) {
    console.error("POST import product error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// FRONT routes (Express 5 safe)
// -----------------------------
app.get("/", (req, res) => res.sendFile(INDEX_HTML));

// Catch-all SPA sans casser l’API
app.get(/^\/(?!api\/|webhooks\/|health).*/, (req, res) => {
  res.sendFile(INDEX_HTML);
});

// -----------------------------
app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", {
    port: PORT,
    products: Object.keys(PRODUCT_CONFIG || {}).length,
    publicDir: PUBLIC_DIR,
  });
});

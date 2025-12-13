// server.js
require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { logEvent } = require("./utils/logger");

// Managers (multi-shop)
const {
  applyOrderToProduct,
  restockProduct,
  getCatalogSnapshot,
  getStockSnapshot,
  upsertImportedProductConfig,
  setProductCategories,
  removeProduct,
} = require("./stockManager");

const {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
} = require("./catalogStore");

const {
  addMovement,
  listMovements,
  toCSV: movementsToCSV,
} = require("./movementStore");

// Shopify
const { searchProducts } = require("./shopifyClient");

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// -----------------------------
// Helpers
// -----------------------------
function getShop(req) {
  // Shopify admin iframe ajoute ?shop=xxxx.myshopify.com
  const shop = (req.query.shop || req.body?.shop || req.headers["x-shopify-shop-domain"] || "").toString();
  return shop || "default";
}

function ok(res, data) {
  return res.json({ ok: true, ...data });
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

// -----------------------------
// Static front (public/)
// -----------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/health", (req, res) => res.json({ ok: true }));

// -----------------------------
// Server info
// -----------------------------
app.get("/api/server-info", (req, res) => {
  const shop = getShop(req);
  const snapshot = getStockSnapshot(shop);

  ok(res, {
    mode: process.env.NODE_ENV || "development",
    dataDir: process.env.DATA_DIR || "/var/data",
    productCount: Object.keys(snapshot || {}).length,
    lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
    shop,
  });
});

// -----------------------------
// Catalog / stock
// -----------------------------
// Support:
//  - /api/stock?shop=...&sort=alpha&category=<id>
app.get("/api/stock", (req, res) => {
  try {
    const shop = getShop(req);
    const { sort, category } = req.query || {};

    let { products, categories } = getCatalogSnapshot(shop);

    // filter by category
    if (category) {
      const catId = String(category);
      products = (products || []).filter((p) => Array.isArray(p.categoryIds) && p.categoryIds.includes(catId));
    }

    // sort alpha
    if (sort === "alpha") {
      products.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" }));
    }

    ok(res, { products, categories, shop });
  } catch (e) {
    logEvent("api_stock_error", { message: e.message }, "error");
    fail(res, 500, e.message);
  }
});

// CSV stock
app.get("/api/stock.csv", (req, res) => {
  try {
    const shop = getShop(req);
    const snap = getStockSnapshot(shop);

    const rows = Object.entries(snap || {}).map(([productId, p]) => {
      const variants = p?.variants || {};
      const variantTitles = Object.keys(variants).join(" | ");
      const canSell = Object.entries(variants)
        .map(([k, v]) => `${k}g:${v.canSell}`)
        .join(" | ");

      return {
        productId,
        name: p?.name || "",
        totalGrams: p?.totalGrams ?? 0,
        categoryIds: (p?.categoryIds || []).join("|"),
        variantTitles,
        canSell,
        shop,
      };
    });

    const header = ["productId", "name", "totalGrams", "categoryIds", "variantTitles", "canSell", "shop"];
    const csv = [
      header.join(","),
      ...rows.map((r) => header.map((c) => {
        const s = r[c] === null || r[c] === undefined ? "" : String(r[c]);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="stock-${shop}.csv"`);
    res.send(csv);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Categories (multi-shop)
// -----------------------------
app.get("/api/categories", (req, res) => {
  try {
    const shop = getShop(req);
    ok(res, { categories: listCategories(shop), shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/api/categories", (req, res) => {
  try {
    const shop = getShop(req);
    const { name } = req.body || {};
    const cat = createCategory(shop, name);
    ok(res, { category: cat, categories: listCategories(shop), shop });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.put("/api/categories/:id", (req, res) => {
  try {
    const shop = getShop(req);
    const { name } = req.body || {};
    const cat = renameCategory(shop, req.params.id, name);
    ok(res, { category: cat, categories: listCategories(shop), shop });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.delete("/api/categories/:id", (req, res) => {
  try {
    const shop = getShop(req);
    deleteCategory(shop, req.params.id);
    ok(res, { categories: listCategories(shop), shop });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

// -----------------------------
// Product categories assign
// POST /api/products/:id/categories { categoryIds: [] }
// -----------------------------
app.post("/api/products/:id/categories", (req, res) => {
  try {
    const shop = getShop(req);
    const { categoryIds } = req.body || {};
    const okSet = setProductCategories(shop, req.params.id, categoryIds || []);
    if (!okSet) return fail(res, 404, "Produit introuvable");
    ok(res, { shop });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

// -----------------------------
// Adjust total grams
// POST /api/products/:id/adjust-total { gramsDelta: number }
// -----------------------------
app.post("/api/products/:id/adjust-total", async (req, res) => {
  try {
    const shop = getShop(req);
    const gramsDelta = Number(req.body?.gramsDelta || 0);
    if (!Number.isFinite(gramsDelta) || gramsDelta === 0) return fail(res, 400, "gramsDelta invalide");

    let out = null;
    if (gramsDelta > 0) out = await restockProduct(shop, req.params.id, gramsDelta);
    else out = await applyOrderToProduct(shop, req.params.id, Math.abs(gramsDelta));

    if (!out) return fail(res, 404, "Produit introuvable");

    // movement
    addMovement(shop, {
      type: "adjust_total",
      source: "ui",
      productId: req.params.id,
      productName: out.name,
      gramsDelta,
      totalAfter: out.totalGrams,
    });

    ok(res, { product: out, shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Delete product config (not Shopify product)
// DELETE /api/products/:id
// -----------------------------
app.delete("/api/products/:id", (req, res) => {
  try {
    const shop = getShop(req);
    const okDel = removeProduct(shop, req.params.id);
    if (!okDel) return fail(res, 404, "Produit introuvable");
    ok(res, { shop });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

// -----------------------------
// Restock shortcut (used by index.html glue)
// POST /api/restock { productId, grams }
// -----------------------------
app.post("/api/restock", async (req, res) => {
  try {
    const shop = getShop(req);
    const { productId, grams } = req.body || {};
    const g = Number(grams || 0);
    if (!productId) return fail(res, 400, "productId manquant");
    if (!Number.isFinite(g) || g <= 0) return fail(res, 400, "grams invalide");

    const out = await restockProduct(shop, String(productId), g);
    if (!out) return fail(res, 404, "Produit introuvable");

    addMovement(shop, {
      type: "restock",
      source: "ui",
      productId: String(productId),
      productName: out.name,
      gramsDelta: g,
      totalAfter: out.totalGrams,
    });

    ok(res, { product: out, shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Movements (global)
// GET /api/movements?days=7&limit=300
// -----------------------------
app.get("/api/movements", (req, res) => {
  try {
    const shop = getShop(req);
    const days = Number(req.query.days || 7);
    const limit = Number(req.query.limit || 300);
    const data = listMovements(shop, { days, limit });
    ok(res, { data, shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// Product history
app.get("/api/products/:id/history", (req, res) => {
  try {
    const shop = getShop(req);
    const limit = Number(req.query.limit || 200);
    const all = listMovements(shop, { days: 365, limit: 10000 });
    const data = all
      .filter((m) => String(m.productId || "") === String(req.params.id))
      .slice(0, Math.max(1, Math.min(limit, 2000)));

    ok(res, { data, shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// Movements CSV
app.get("/api/movements.csv", (req, res) => {
  try {
    const shop = getShop(req);
    const days = Number(req.query.days || 30);
    const limit = Number(req.query.limit || 5000);
    const rows = listMovements(shop, { days, limit });
    const csv = movementsToCSV(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="movements-${shop}.csv"`);
    res.send(csv);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Shopify search products (for import UI)
// GET /api/shopify/products?query=...&limit=100
// -----------------------------
app.get("/api/shopify/products", async (req, res) => {
  try {
    const shop = getShop(req);
    const query = String(req.query.query || "");
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 250));

    // shopifyClient.js doit savoir résoudre la session/credentials (env)
    const products = await searchProducts(shop, { query, limit });
    ok(res, { products, shop });
  } catch (e) {
    logEvent("shopify_products_error", { message: e.message }, "error");
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Import a Shopify product into local config
// POST /api/import/product { productId, categoryIds? }
// -----------------------------
app.post("/api/import/product", async (req, res) => {
  try {
    const shop = getShop(req);
    const { productId, categoryIds } = req.body || {};
    if (!productId) return fail(res, 400, "productId manquant");

    // 1) On récupère le produit Shopify complet (avec variants)
    // shopifyClient.js doit exposer un fetchProduct(...)
    const { fetchProduct } = require("./shopifyClient");
    const p = await fetchProduct(shop, String(productId));
    if (!p) return fail(res, 404, "Produit Shopify introuvable");

    // 2) On transforme en config
    const variants = {};
    for (const v of p.variants || []) {
      // On attend un titre "3g" ou "3" ou "3.5" etc => on garde le nombre dans le label
      const title = String(v.title || "").trim();
      const num = title.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[1];
      if (!num) continue;

      variants[num] = {
        gramsPerUnit: Number(num),
        inventoryItemId: Number(v.inventoryItem_id || v.inventoryItemId || 0),
      };
    }

    const product = upsertImportedProductConfig(shop, {
      productId: String(p.id),
      name: String(p.title || p.name || p.id),
      totalGrams: 0,
      variants,
      categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
    });

    addMovement(shop, {
      type: "import",
      source: "ui",
      productId: product.productId,
      productName: product.name,
      gramsDelta: 0,
      totalAfter: product.totalGrams,
    });

    ok(res, { product, shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Test order (optionnel)
// POST /api/test-order
// -----------------------------
app.post("/api/test-order", async (req, res) => {
  try {
    const shop = getShop(req);

    // prend le premier produit dispo
    const snap = getStockSnapshot(shop);
    const firstId = Object.keys(snap || {})[0];
    if (!firstId) return fail(res, 400, "Aucun produit configuré");

    const before = snap[firstId]?.totalGrams ?? 0;
    const out = await applyOrderToProduct(shop, firstId, 3); // retire 3g

    addMovement(shop, {
      type: "test_order",
      source: "api",
      productId: firstId,
      productName: out?.name || "",
      gramsDelta: -3,
      gramsBefore: before,
      totalAfter: out?.totalGrams,
    });

    ok(res, { product: out, shop });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// -----------------------------
// Catch-all
// -----------------------------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logEvent("server_started", { port: PORT });
  console.log(`✅ Server running on port ${PORT}`);
});

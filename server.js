// server.js — FIX "Réponse non-JSON du serveur" (Express 5 safe)
// + Routes complètes attendues par public/js/app.js
// + Support ?shop=... (détection auto single-shop vs multi-shop)
// + /api renvoie TOUJOURS du JSON (même 404/500)

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const { logEvent } = require("./utils/logger");
const { getShopifyClient } = require("./shopifyClient");
const shopify = getShopifyClient();

const stock = require("./stockManager");

// Stores (peuvent être single-shop OU multi-shop suivant ta version)
const catalogStore = require("./catalogStore");
const movementStore = require("./movementStore");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");

// =========================
// Helpers multi-shop (auto)
// =========================
function getShop(req) {
  // Shopify admin iframe ajoute souvent ?shop=xxx.myshopify.com
  const s = String(req.query?.shop || "").trim();
  return s || "default";
}

// Détection auto: si ton catalogStore supporte (shop, name)
// - multi-shop: exports.sanitizeShop OU fonction à 2+ params
const isCatalogMultiShop =
  typeof catalogStore?.sanitizeShop === "function" ||
  (typeof catalogStore?.listCategories === "function" && catalogStore.listCategories.length >= 1 && catalogStore.createCategory?.length >= 2);

// Détection auto movementStore multi-shop
const isMovementsMultiShop =
  typeof movementStore?.shopDir === "function" ||
  (typeof movementStore?.listMovements === "function" && movementStore.listMovements.length >= 1);

// Wrappers catalog (compat)
function listCategoriesFor(req) {
  const shop = getShop(req);
  return isCatalogMultiShop ? catalogStore.listCategories(shop) : catalogStore.listCategories();
}
function createCategoryFor(req, name) {
  const shop = getShop(req);
  return isCatalogMultiShop ? catalogStore.createCategory(shop, name) : catalogStore.createCategory(name);
}
function renameCategoryFor(req, id, name) {
  const shop = getShop(req);
  return isCatalogMultiShop ? catalogStore.renameCategory(shop, id, name) : catalogStore.renameCategory(id, name);
}
function deleteCategoryFor(req, id) {
  const shop = getShop(req);
  return isCatalogMultiShop ? catalogStore.deleteCategory(shop, id) : catalogStore.deleteCategory(id);
}

// Wrappers movements (compat)
function addMovementFor(req, movement) {
  const shop = getShop(req);
  // si movementStore multi-shop: addMovement(movement, shop) OU addMovement({shop:...})
  try {
    if (movementStore.addMovement.length >= 2) return movementStore.addMovement(movement, shop);
    return movementStore.addMovement({ ...movement, shop });
  } catch {
    // fallback
    return movementStore.addMovement(movement);
  }
}
function listMovementsFor(req, { days, limit } = {}) {
  const shop = getShop(req);
  const opts = { days, limit, shop };
  return movementStore.listMovements(opts);
}

// =========================
// 1) MIDDLEWARES
// =========================

// Webhook Shopify doit rester en RAW uniquement sur sa route (pas global)
function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true;
  const hash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
  return hash === hmacHeader;
}

// JSON parser AVANT /api (sinon req.body undefined)
app.use("/api", express.json({ limit: "2mb" }));

// CORS simple
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Shopify-Hmac-Sha256");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// CSP Shopify admin iframe
app.use((req, res, next) => {
  const shopDomain = process.env.SHOP_NAME ? `https://${process.env.SHOP_NAME}.myshopify.com` : "*";
  res.setHeader("Content-Security-Policy", `frame-ancestors https://admin.shopify.com ${shopDomain};`);
  next();
});

// Health
app.get("/health", (req, res) => res.status(200).send("ok"));

// =========================
// 2) WEBHOOKS (RAW BODY)
// =========================
app.post(
  "/webhooks/orders/create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hmac = req.get("X-Shopify-Hmac-Sha256");
      if (process.env.NODE_ENV === "production" && process.env.SHOPIFY_WEBHOOK_SECRET) {
        if (!hmac || !verifyShopifyWebhook(req.body, hmac)) return res.sendStatus(401);
      }

      // (optionnel) traitement commande...
      return res.sendStatus(200);
    } catch (e) {
      console.error("webhook error:", e);
      return res.sendStatus(500);
    }
  }
);

// =========================
// 3) API (TOUJOURS JSON)
// =========================

// helper : JSON error safe
function apiError(res, code, message, extra) {
  return res.status(code).json({ error: message, ...(extra ? { extra } : {}) });
}

// ---------------- server-info ----------------
// attendu par app.js: mode, productCount, lowStockThreshold
app.get("/api/server-info", (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || "development",
    productCount: Object.keys(stock?.PRODUCT_CONFIG || {}).length,
    lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
    port: PORT,
  });
});

// ---------------- categories CRUD ----------------
app.get("/api/categories", (req, res) => {
  try {
    res.json({ categories: listCategoriesFor(req) });
  } catch (e) {
    console.error("GET categories error:", e);
    return apiError(res, 500, e.message);
  }
});

app.post("/api/categories", (req, res) => {
  try {
    const name = String(req.body?.name ?? req.body?.categoryName ?? "").trim();
    if (!name) return apiError(res, 400, "Nom de catégorie invalide");
    const created = createCategoryFor(req, name);

    addMovementFor(req, { source: "category_create", gramsDelta: 0, meta: { id: created.id, name: created.name } });
    res.json({ success: true, category: created });
  } catch (e) {
    console.error("POST category error:", e);
    return apiError(res, 500, e.message);
  }
});

app.put("/api/categories/:id", (req, res) => {
  try {
    const id = String(req.params.id);
    const name = String(req.body?.name ?? "").trim();
    if (!name) return apiError(res, 400, "Nom invalide");

    const updated = renameCategoryFor(req, id, name);
    addMovementFor(req, { source: "category_rename", gramsDelta: 0, meta: { id, name } });

    res.json({ success: true, category: updated });
  } catch (e) {
    console.error("PUT category error:", e);
    return apiError(res, 500, e.message);
  }
});

app.delete("/api/categories/:id", (req, res) => {
  try {
    const id = String(req.params.id);
    deleteCategoryFor(req, id);

    addMovementFor(req, { source: "category_delete", gramsDelta: 0, meta: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE category error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- stock (UI) ----------------
// attendu par app.js: { products:[{productId,name,totalGrams,variants,categoryIds}], categories:[...] }
// support: ?sort=alpha & ?category=<id>
app.get("/api/stock", (req, res) => {
  try {
    const snap = stock.getCatalogSnapshot(); // { products, categories }
    let products = Array.isArray(snap.products) ? snap.products.slice() : [];
    const categories = Array.isArray(snap.categories) ? snap.categories : [];

    const sort = String(req.query.sort || "");
    const category = String(req.query.category || "");

    if (category) {
      products = products.filter((p) => Array.isArray(p.categoryIds) && p.categoryIds.map(String).includes(category));
    }

    if (sort === "alpha") {
      products.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" }));
    }

    res.json({ products, categories });
  } catch (e) {
    console.error("GET stock error:", e);
    return apiError(res, 500, e.message);
  }
});

// CSV stock (attendu par app.js: /api/stock.csv)
function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
app.get("/api/stock.csv", (req, res) => {
  try {
    const snap = stock.getCatalogSnapshot();
    const rows = Array.isArray(snap.products) ? snap.products : [];

    const cols = ["productId", "name", "totalGrams", "categoryIds", "variants"];
    const header = cols.join(",");

    const lines = rows.map((p) => {
      const categoryIds = Array.isArray(p.categoryIds) ? p.categoryIds.join("|") : "";
      const variants = p.variants ? JSON.stringify(p.variants) : "";
      return [
        csvEscape(p.productId),
        csvEscape(p.name),
        csvEscape(p.totalGrams),
        csvEscape(categoryIds),
        csvEscape(variants),
      ].join(",");
    });

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock.csv"');
    return res.status(200).send(csv);
  } catch (e) {
    console.error("GET stock.csv error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- restock (index.html mini glue) ----------------
// POST /api/restock { productId, grams }
app.post("/api/restock", async (req, res) => {
  try {
    const productId = String(req.body?.productId || "").trim();
    const grams = Number(req.body?.grams || 0);
    if (!productId || !Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "Paramètres invalides");

    const before = stock.PRODUCT_CONFIG?.[productId]?.totalGrams ?? null;
    const updated = await stock.restockProduct(productId, grams);
    if (!updated) return apiError(res, 404, "Produit introuvable");

    addMovementFor(req, {
      source: "restock",
      productId,
      productName: updated.name,
      gramsDelta: grams,
      gramsBefore: before,
      totalAfter: updated.totalGrams,
    });

    res.json({ success: true, product: updated });
  } catch (e) {
    console.error("POST restock error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- adjust total ----------------
// POST /api/products/:id/adjust-total { gramsDelta }
app.post("/api/products/:id/adjust-total", async (req, res) => {
  try {
    const productId = String(req.params.id);
    const gramsDelta = Number(req.body?.gramsDelta ?? 0);
    if (!Number.isFinite(gramsDelta) || gramsDelta === 0) return apiError(res, 400, "gramsDelta invalide");

    const before = stock.PRODUCT_CONFIG?.[productId]?.totalGrams ?? null;
    const updated = await stock.restockProduct(productId, gramsDelta);
    if (!updated) return apiError(res, 404, "Produit introuvable");

    addMovementFor(req, {
      source: "adjust_total",
      productId,
      productName: updated.name,
      gramsDelta,
      gramsBefore: before,
      totalAfter: updated.totalGrams,
    });

    res.json({ success: true, product: updated });
  } catch (e) {
    console.error("POST adjust-total error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- delete product (config only) ----------------
// DELETE /api/products/:id
app.delete("/api/products/:id", (req, res) => {
  try {
    const productId = String(req.params.id);
    const name = stock.PRODUCT_CONFIG?.[productId]?.name || productId;

    const ok = stock.removeProduct(productId);
    if (!ok) return apiError(res, 404, "Produit introuvable");

    addMovementFor(req, { source: "delete_product", productId, productName: name, gramsDelta: 0 });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE product error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- save product categories ----------------
// POST /api/products/:id/categories { categoryIds: [] }
app.post("/api/products/:id/categories", (req, res) => {
  try {
    const productId = String(req.params.id);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];

    const ok = stock.setProductCategories(productId, categoryIds);
    if (!ok) return apiError(res, 404, "Produit introuvable");

    addMovementFor(req, { source: "set_categories", productId, gramsDelta: 0, meta: { categoryIds } });
    res.json({ success: true });
  } catch (e) {
    console.error("POST product categories error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- movements (global) ----------------
// attendu par app.js: { data: [...] }
app.get("/api/movements", (req, res) => {
  try {
    const days = Number(req.query.days ?? 7);
    const limit = Number(req.query.limit ?? 300);
    const data = listMovementsFor(req, { days, limit });
    res.json({ data });
  } catch (e) {
    console.error("GET movements error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- movements CSV ----------------
app.get("/api/movements.csv", (req, res) => {
  try {
    const days = Number(req.query.days ?? 30);
    const limit = Number(req.query.limit ?? 10000);
    const rows = listMovementsFor(req, { days, limit });
    const csv = movementStore.toCSV(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="movements.csv"');
    return res.status(200).send(csv);
  } catch (e) {
    console.error("GET movements.csv error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- product history ----------------
// GET /api/products/:id/history?limit=200  -> { data:[...] }
app.get("/api/products/:id/history", (req, res) => {
  try {
    const productId = String(req.params.id);
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 200), 2000));

    // On lit large (30j) puis filtre
    const rows = listMovementsFor(req, { days: 30, limit: 10000 })
      .filter((m) => String(m.productId || "") === productId)
      .slice(0, limit);

    res.json({ data: rows });
  } catch (e) {
    console.error("GET product history error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- Shopify list products ----------------
// support ?query=... côté UI
app.get("/api/shopify/products", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const query = String(req.query.query || "").trim().toLowerCase();

    const products = await shopify.product.list({ limit });
    const filtered = query
      ? (products || []).filter((p) => String(p.title || "").toLowerCase().includes(query))
      : (products || []);

    res.json({
      products: (filtered || []).map((p) => ({
        id: String(p.id),
        title: String(p.title || ""),
        variantsCount: Array.isArray(p.variants) ? p.variants.length : 0,
      })),
    });
  } catch (e) {
    console.error("GET shopify products error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---- Import un produit Shopify vers ton app
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
    const productId = req.body?.productId ?? req.body?.id;
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];

    if (!productId) return apiError(res, 400, "productId manquant");

    const p = await shopify.product.get(Number(productId));
    if (!p?.id) return apiError(res, 404, "Produit Shopify introuvable");

    const variants = {};
    for (const v of p.variants || []) {
      const grams = parseGrams(v);
      if (!grams) continue;
      variants[String(grams)] = {
        gramsPerUnit: grams,
        inventoryItemId: Number(v.inventory_item_id),
      };
    }

    if (!Object.keys(variants).length) {
      return apiError(res, 400, "Aucune variante avec grammage détecté (option/title/sku).");
    }

    if (typeof stock?.upsertImportedProductConfig !== "function") {
      return apiError(res, 500, "upsertImportedProductConfig introuvable dans stockManager.js");
    }

    const imported = stock.upsertImportedProductConfig({
      productId: String(p.id),
      name: String(p.title || p.handle || p.id),
      variants,
      categoryIds,
    });

    addMovementFor(req, { source: "import_shopify", productId: String(p.id), productName: imported.name, gramsDelta: 0 });

    res.json({ success: true, product: imported });
  } catch (e) {
    console.error("POST import product error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---------------- test-order ----------------
// POST /api/test-order (attendu par app.js)
app.post("/api/test-order", async (req, res) => {
  try {
    const ids = Object.keys(stock?.PRODUCT_CONFIG || {});
    if (!ids.length) return apiError(res, 400, "Aucun produit configuré");

    const productId = ids[0];
    const gramsToSubtract = 1;

    const before = stock.PRODUCT_CONFIG?.[productId]?.totalGrams ?? null;
    const updated = await stock.applyOrderToProduct(productId, gramsToSubtract);
    if (!updated) return apiError(res, 404, "Produit introuvable");

    addMovementFor(req, {
      source: "test_order",
      productId,
      productName: updated.name,
      gramsDelta: -gramsToSubtract,
      gramsBefore: before,
      totalAfter: updated.totalGrams,
    });

    res.json({ success: true, product: updated });
  } catch (e) {
    console.error("POST test-order error:", e);
    return apiError(res, 500, e.message);
  }
});

// ✅ IMPORTANT : si une route /api n’existe pas => JSON 404 (pas HTML)
app.use("/api", (req, res) => apiError(res, 404, "Route API non trouvée"));

// ✅ IMPORTANT : handler erreurs => JSON (pas HTML)
app.use((err, req, res, next) => {
  if (req.path.startsWith("/api")) {
    console.error("API uncaught error:", err);
    return apiError(res, 500, "Erreur serveur API");
  }
  next(err);
});

// =========================
// 4) FRONT (après l’API)
// =========================
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(INDEX_HTML));

// Catch-all SPA : EXCLUT /api et /webhooks et /health (Express 5 safe)
app.get(/^\/(?!api\/|webhooks\/|health).*/, (req, res) => {
  res.sendFile(INDEX_HTML);
});

// =========================
app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", { port: PORT, publicDir: PUBLIC_DIR });
  console.log("✅ Server running on port", PORT);
});

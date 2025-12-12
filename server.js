// server.js
// ============================================
// BULK STOCK MANAGER (Shopify) - Render Ready
// - Sert /public + GET /
// - Webhook orders/create (HMAC) -> décrémente le stock "vrac" (grammes)
// - Source de vérité = app (elle écrase Shopify)
// - Catégories + import produits Shopify
// - Historique (mouvements) + CSV
// - Ajustement stock TOTAL (+ / - en grammes)
// - Suppression produit (dans la config locale uniquement)
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
  setProductCategories,
  upsertImportedProductConfig,
  getCatalogSnapshot,
  removeProduct,
} = require("./stockManager");

// Mouvements
const { addMovement, listMovements, toCSV, clearMovements } = require("./movementStore");

// Catégories
const { listCategories, createCategory, renameCategory, deleteCategory } = require("./catalogStore");

const app = express();

// ================= Helpers =================
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

// Toujours renvoyer du JSON (évite "JSON.parse unexpected character" côté front)
function safeJson(res, fn) {
  try {
    const maybePromise = fn();
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise.catch((e) => {
        logEvent("api_error", { message: e?.message }, "error");
        res.status(500).json({ error: e?.message || "Erreur serveur" });
      });
    }
    return maybePromise;
  } catch (e) {
    logEvent("api_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur serveur" });
  }
}

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // dev
  const hash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
  return hash === hmacHeader;
}

function parseGramsFromVariantTitle(variantTitle = "") {
  // ex: "1.5", "3", "10 g", "25G", "50"
  const m = String(variantTitle).match(/([\d.,]+)/);
  if (!m) return null;
  return parseFloat(m[1].replace(",", "."));
}

// Push les quantités calculées vers Shopify
async function pushProductInventoryToShopify(shopify, productView) {
  if (!productView?.variants) return;
  const locationId = process.env.LOCATION_ID;
  if (!locationId) return;

  for (const [, v] of Object.entries(productView.variants)) {
    const unitsAvailable = Number(v.canSell || 0);
    const inventoryItemId = v.inventoryItemId;

    if (!inventoryItemId) continue;

    await shopify.inventoryLevel.set({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: unitsAvailable,
    });
  }
}

// ================= Middlewares =================

// Static UI
app.use(express.static(path.join(__dirname, "public")));

// CORS (utile si iframe admin)
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
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://admin.shopify.com ${shopDomain};`
  );
  next();
});

// JSON pour API (IMPORTANT: ne pas casser le RAW webhook)
app.use("/api", express.json({ limit: "2mb" }));

// Healthcheck Render
app.get("/health", (req, res) => res.status(200).send("ok"));

// Shopify client
const shopify = getShopifyClient();

// ================= Webhook Shopify (RAW BODY) =================
// IMPORTANT: express.raw uniquement ici, sinon HMAC faux
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === "true";
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  try {
    const rawBody = req.body; // Buffer

    // HMAC en prod
    if (isProduction && process.env.SHOPIFY_WEBHOOK_SECRET && !skipHmac) {
      if (!hmacHeader) return res.sendStatus(401);
      const ok = verifyShopifyWebhook(rawBody, hmacHeader);
      if (!ok) return res.sendStatus(401);
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }

    if (!order?.id || !Array.isArray(order?.line_items)) return res.sendStatus(200);

    for (const item of order.line_items) {
      if (!item?.product_id) continue;

      const productId = String(item.product_id);
      const variantTitle = String(item.variant_title || "");
      const quantity = Number(item.quantity || 0);

      // On ne traite que les produits configurés dans l'app
      if (!PRODUCT_CONFIG[productId]) continue;

      const gramsPerUnit = parseGramsFromVariantTitle(variantTitle);
      if (!gramsPerUnit || gramsPerUnit <= 0) continue;

      const gramsDelta = gramsPerUnit * quantity;

      // 1) update local pool (source de vérité)
      const updated = await applyOrderToProduct(productId, gramsDelta);
      if (!updated) continue;

      // 2) push vers Shopify (écrase Shopify)
      try {
        await pushProductInventoryToShopify(shopify, updated);
      } catch (e) {
        logEvent("inventory_push_error", { productId, message: e?.message }, "error");
      }

      // mouvement
      addMovement({
        source: "webhook_order",
        productId,
        productName: updated.name,
        gramsDelta: -Math.abs(gramsDelta),
        totalAfter: updated.totalGrams,
        meta: { orderId: String(order.id), orderName: String(order.name || "") },
      });
    }

    return res.sendStatus(200);
  } catch (e) {
    logEvent("webhook_error", { message: e?.message }, "error");
    return res.sendStatus(500);
  }
});

// ================= Pages =================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ================= API =================

app.get("/api/server-info", (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || "development",
    port: process.env.PORT || 3000,
    hmacEnabled: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    productCount: Object.keys(PRODUCT_CONFIG).length,
    lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
  });
});

// ✅ Ce que ton app.js attend : { products:[...], categories:[...] }
app.get("/api/stock", (req, res) => {
  safeJson(res, () => {
    const { sort = "alpha", category = "" } = req.query;

    const catalog = getCatalogSnapshot();
    let products = Array.isArray(catalog.products) ? catalog.products.slice() : [];
    const categories = Array.isArray(catalog.categories) ? catalog.categories : [];

    if (category) {
      products = products.filter(
        (p) => Array.isArray(p.categoryIds) && p.categoryIds.includes(String(category))
      );
    }

    if (sort === "alpha") {
      products.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
      );
    }

    res.json({ products, categories });
  });
});

// ======== TEST COMMANDE (bouton "Tester une commande") ========
app.post("/api/test-order", async (req, res) => {
  safeJson(res, async () => {
    const productId = Object.keys(PRODUCT_CONFIG)[0];
    if (!productId) return res.status(400).json({ error: "Aucun produit configuré" });

    const product = PRODUCT_CONFIG[productId];
    const firstLabel = Object.keys(product.variants || {})[0];
    if (!firstLabel) return res.status(400).json({ error: "Aucune variante configurée" });

    const gramsPerUnit = Number(product.variants[firstLabel].gramsPerUnit || 0);
    if (!gramsPerUnit) return res.status(400).json({ error: "gramsPerUnit invalide" });

    // -1 unité => -gramsPerUnit grammes
    const updated = await restockProduct(productId, -gramsPerUnit);
    if (!updated) return res.status(404).json({ error: "Produit introuvable" });

    try {
      await pushProductInventoryToShopify(shopify, updated);
    } catch (e) {
      logEvent("inventory_push_error", { productId, message: e?.message }, "error");
    }

    addMovement({
      source: "test_order",
      productId,
      productName: updated.name,
      gramsDelta: -Math.abs(gramsPerUnit),
      totalAfter: updated.totalGrams,
      meta: { variantLabel: firstLabel, units: 1 },
    });

    res.json({
      success: true,
      message: `Test OK: -1 unité (${firstLabel}g) sur "${updated.name}"`,
      productId,
      variantLabel: firstLabel,
      gramsDelta: -Math.abs(gramsPerUnit),
      totalAfter: updated.totalGrams,
    });
  });
});

// ======== Catégories ========
app.get("/api/categories", (req, res) => {
  safeJson(res, () => {
    res.json({ categories: listCategories() });
  });
});

app.post("/api/categories", (req, res) => {
  safeJson(res, () => {
    const { name } = req.body || {};
    if (!name || String(name).trim().length < 1) {
      return res.status(400).json({ error: "Nom invalide" });
    }

    const created = createCategory(String(name).trim());

    addMovement({
      source: "category_create",
      gramsDelta: 0,
      meta: { categoryId: created.id, name: created.name },
    });

    res.json({ success: true, category: created });
  });
});

app.put("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const id = String(req.params.id);
    const { name } = req.body || {};
    if (!name || String(name).trim().length < 1) {
      return res.status(400).json({ error: "Nom invalide" });
    }

    const updated = renameCategory(id, String(name).trim());
    if (!updated) return res.status(404).json({ error: "Catégorie introuvable" });

    addMovement({
      source: "category_rename",
      gramsDelta: 0,
      meta: { categoryId: id, name: updated.name },
    });

    res.json({ success: true, category: updated });
  });
});

app.delete("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const id = String(req.params.id);
    const ok = deleteCategory(id);
    if (!ok) return res.status(404).json({ error: "Catégorie introuvable" });

    addMovement({
      source: "category_delete",
      gramsDelta: 0,
      meta: { categoryId: id },
    });

    res.json({ success: true });
  });
});

// ======== Assigner catégories à un produit ========
function handleSetProductCategories(req, res) {
  return safeJson(res, () => {
    const productId = String(req.params.productId);
    const { categoryIds } = req.body || {};
    const ids = Array.isArray(categoryIds) ? categoryIds.map(String) : [];

    const ok = setProductCategories(productId, ids);
    if (!ok) return res.status(404).json({ error: "Produit introuvable (non configuré)" });

    addMovement({
      source: "product_set_categories",
      productId,
      gramsDelta: 0,
      meta: { categoryIds: ids },
    });

    res.json({ success: true, productId, categoryIds: ids });
  });
}
app.post("/api/products/:productId/categories", handleSetProductCategories);
app.put("/api/products/:productId/categories", handleSetProductCategories);

// ======== Ajuster le stock TOTAL (en grammes) : + ou - ========
app.post("/api/products/:productId/adjust-total", async (req, res) => {
  safeJson(res, async () => {
    const productId = String(req.params.productId);
    const { gramsDelta } = req.body || {};
    const g = Number(gramsDelta);

    if (!Number.isFinite(g) || g === 0) {
      return res.status(400).json({ error: "gramsDelta invalide (ex: 50 ou -50)" });
    }

    if (!PRODUCT_CONFIG[productId]) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

    const updated = await restockProduct(productId, g);
    if (!updated) return res.status(404).json({ error: "Produit introuvable" });

    try {
      await pushProductInventoryToShopify(shopify, updated);
    } catch (e) {
      logEvent("inventory_push_error", { productId, message: e?.message }, "error");
    }

    addMovement({
      source: "adjust_total",
      productId,
      productName: updated.name,
      gramsDelta: g,
      totalAfter: updated.totalGrams,
    });

    res.json({ success: true, product: updated });
  });
});

// ======== Supprimer un produit de l’interface (config locale) ========
app.delete("/api/products/:productId", (req, res) => {
  safeJson(res, () => {
    const productId = String(req.params.productId);

    const ok = removeProduct(productId);
    if (!ok) return res.status(404).json({ error: "Produit introuvable" });

    addMovement({
      source: "product_delete",
      productId,
      gramsDelta: 0,
    });

    res.json({ success: true, productId });
  });
});

// ======== Historique d’un produit ========
app.get("/api/products/:productId/history", (req, res) => {
  safeJson(res, () => {
    const productId = String(req.params.productId);
    const limit = Math.min(Number(req.query.limit || 200), 2000);

    const all = listMovements({ limit: 10000 }) || [];
    const filtered = all.filter((m) => String(m.productId || "") === productId).slice(0, limit);

    res.json({ count: filtered.length, data: filtered });
  });
});

// ======== Mouvements (global) ========
app.get("/api/movements", (req, res) => {
  safeJson(res, () => {
    const limit = Math.min(Number(req.query.limit || 200), 2000);
    const data = listMovements({ limit });
    res.json({ count: data.length, data });
  });
});

app.get("/api/movements.csv", (req, res) => {
  safeJson(res, () => {
    const limit = Math.min(Number(req.query.limit || 2000), 10000);
    const data = listMovements({ limit });
    const csv = toCSV(data);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock-movements.csv"');
    res.send(csv);
  });
});

app.delete("/api/movements", (req, res) => {
  safeJson(res, () => {
    clearMovements();
    res.json({ success: true });
  });
});

// ======== Export stock CSV ========
app.get("/api/stock.csv", (req, res) => {
  safeJson(res, () => {
    const catalog = getCatalogSnapshot();
    const products = Array.isArray(catalog.products) ? catalog.products : [];

    const header = ["productId", "name", "totalGrams", "categoryIds"].join(";");
    const lines = products.map((p) => {
      const cats = Array.isArray(p.categoryIds) ? p.categoryIds.join(",") : "";
      return [p.productId, (p.name || "").replace(/;/g, ","), Number(p.totalGrams || 0), cats].join(
        ";"
      );
    });

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock.csv"');
    res.send(csv);
  });
});

// ======== Shopify: lister produits (pour import) ========
app.get("/api/shopify/products", async (req, res) => {
  safeJson(res, async () => {
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const q = String(req.query.query || "").trim().toLowerCase();

    const products = await shopify.product.list({ limit });

    let out = (products || []).map((p) => ({
      id: String(p.id),
      title: String(p.title || ""),
      variantsCount: Array.isArray(p.variants) ? p.variants.length : 0,
    }));

    if (q) out = out.filter((p) => p.title.toLowerCase().includes(q));

    out.sort((a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" }));
    res.json({ products: out });
  });
});

// ======== Import 1 produit Shopify -> upsert config ========
app.post("/api/import/product", async (req, res) => {
  safeJson(res, async () => {
    const { productId, totalGrams, categoryIds } = req.body || {};
    if (!productId) return res.status(400).json({ error: "productId manquant" });

    const p = await shopify.product.get(Number(productId));
    if (!p?.id) return res.status(404).json({ error: "Produit Shopify introuvable" });

    const variants = {};
    for (const v of p.variants || []) {
      const grams = parseGramsFromVariantTitle(v.title);
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
      categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
    });

    addMovement({
      source: "import_shopify_product",
      productId: String(p.id),
      productName: imported.name,
      gramsDelta: 0,
      meta: { categoryIds: Array.isArray(categoryIds) ? categoryIds : [] },
    });

    res.json({ success: true, product: imported });
  });
});

// ================= Start =================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  logEvent("server_started", {
    host: HOST,
    port: PORT,
    products: Object.keys(PRODUCT_CONFIG).length,
  });
});

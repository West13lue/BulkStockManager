// server.js
// ============================================
// BULK STOCK MANAGER (Shopify) - Render Ready
// - Sert /public (CSS/JS/HTML)
// - Webhook orders/create (HMAC)
// - Source de vérité = app (écrase Shopify)
// - Mouvements + logs JSON structurés + CSV export
// - Catégories + import produits Shopify + tri alpha
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
  getCatalogSnapshot,
} = require("./stockManager");

// Mouvements
const { addMovement, listMovements, toCSV, clearMovements } = require("./movementStore");

// Catégories
const { listCategories, createCategory, renameCategory, deleteCategory } = require("./catalogStore");

const app = express();

// ============ Helpers ============
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

// ============ Static (PUBLIC) ============
// ✅ C’est LA partie qui fixe ton CSS cassé :
app.use(express.static(path.join(__dirname, "public")));

// CORS (si tu utilises l’UI dans un iframe Shopify / admin)
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

// JSON pour toutes les routes API classiques
app.use("/api", express.json({ limit: "1mb" }));

// Healthcheck Render
app.get("/health", (req, res) => res.status(200).send("ok"));

// Shopify client
const shopify = getShopifyClient();

// ============ Webhook Shopify (RAW BODY) ============
// IMPORTANT: express.raw uniquement ici, sinon HMAC faux
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === "true";
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  logEvent("webhook_received", { mode: isProduction ? "production" : "dev" });

  try {
    const rawBody = req.body; // Buffer

    // HMAC en prod
    if (isProduction && process.env.SHOPIFY_WEBHOOK_SECRET && !skipHmac) {
      if (!hmacHeader) {
        logEvent("webhook_hmac_missing", {}, "warn");
        return res.sendStatus(401);
      }
      const ok = verifyShopifyWebhook(rawBody, hmacHeader);
      if (!ok) {
        logEvent("webhook_hmac_invalid", {}, "warn");
        return res.sendStatus(401);
      }
      logEvent("webhook_hmac_valid");
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString("utf8"));
    } catch {
      logEvent("webhook_json_parse_error", {}, "warn");
      return res.sendStatus(400);
    }

    if (!order?.id || !Array.isArray(order?.line_items)) {
      logEvent("webhook_invalid_payload", { hasId: !!order?.id }, "warn");
      return res.sendStatus(200);
    }

    logEvent("order_received", {
      orderId: String(order.id),
      orderName: String(order.name || ""),
      lineCount: order.line_items.length,
    });

    // applique chaque ligne à ton pool de grammes
    for (const item of order.line_items) {
      if (!item?.product_id) continue;

      const productId = String(item.product_id);
      const variantTitle = String(item.variant_title || "");
      const quantity = Number(item.quantity || 0);

      if (!PRODUCT_CONFIG[productId]) continue;

      const gramsPerUnit = parseGramsFromVariantTitle(variantTitle);
      if (!gramsPerUnit || gramsPerUnit <= 0) continue;

      const gramsDelta = gramsPerUnit * quantity;

      // 1) update local pool (source de vérité)
      const updated = applyOrderToProduct(productId, gramsDelta);

      // 2) push vers Shopify (écrase Shopify)
      if (updated) {
        for (const [label, v] of Object.entries(updated.variants || {})) {
          const unitsAvailable = Number(v.canSell || 0);
          try {
            await shopify.inventoryLevel.set({
              location_id: process.env.LOCATION_ID,
              inventory_item_id: v.inventoryItemId,
              available: unitsAvailable,
            });

            logEvent("inventory_level_set", {
              productId,
              label,
              unitsAvailable,
              inventoryItemId: v.inventoryItemId,
              locationId: process.env.LOCATION_ID,
            });
          } catch (e) {
            logEvent("inventory_level_set_error", { productId, label, message: e?.message }, "error");
          }
        }

        addMovement({
          source: "webhook_order",
          productId,
          productName: updated.name,
          gramsDelta: -Math.abs(gramsDelta),
          totalAfter: updated.totalGrams,
          meta: { orderId: String(order.id), orderName: String(order.name || "") },
        });

        logEvent("stock_movement", {
          source: "webhook_order",
          productId,
          gramsDelta: -Math.abs(gramsDelta),
          totalAfter: updated.totalGrams,
        });
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    logEvent("webhook_error", { message: e?.message }, "error");
    return res.sendStatus(500);
  }
});

// ============ Pages ============
// ✅ Le snippet demandé, incorporé :
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ============ API ============
app.get("/api/server-info", (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || "development",
    port: process.env.PORT || 3000,
    hmacEnabled: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    productCount: Object.keys(PRODUCT_CONFIG).length,
  });
});

// Stock (option tri + filtre)
app.get("/api/stock", (req, res) => {
  const { sort = "alpha", categoryId = "" } = req.query;

  const snapshot = getStockSnapshot();
  let products = Object.entries(snapshot).map(([productId, p]) => ({ productId, ...p }));

  if (categoryId) {
    products = products.filter(
      (p) => Array.isArray(p.categoryIds) && p.categoryIds.includes(String(categoryId))
    );
  }

  if (sort === "alpha") {
    products.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
    );
  }

  res.json({ count: products.length, data: products });
});

// Catalog complet (produits + catégories)
app.get("/api/catalog", (req, res) => {
  const catalog = getCatalogSnapshot();
  catalog.products.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
  );
  res.json(catalog);
});

// Catégories CRUD
app.get("/api/categories", (req, res) => res.json({ data: listCategories() }));

app.post("/api/categories", (req, res) => {
  const { name } = req.body || {};
  if (!name || String(name).trim().length < 1)
    return res.status(400).json({ error: "Nom invalide" });
  const created = createCategory(String(name).trim());
  addMovement({ source: "category_create", gramsDelta: 0, meta: { categoryId: created.id, name: created.name } });
  return res.json({ success: true, category: created });
});

app.put("/api/categories/:id", (req, res) => {
  const id = String(req.params.id);
  const { name } = req.body || {};
  if (!name || String(name).trim().length < 1)
    return res.status(400).json({ error: "Nom invalide" });
  const updated = renameCategory(id, String(name).trim());
  if (!updated) return res.status(404).json({ error: "Catégorie introuvable" });
  addMovement({ source: "category_rename", gramsDelta: 0, meta: { categoryId: id, name: updated.name } });
  return res.json({ success: true, category: updated });
});

app.delete("/api/categories/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = deleteCategory(id);
  if (!ok) return res.status(404).json({ error: "Catégorie introuvable" });
  addMovement({ source: "category_delete", gramsDelta: 0, meta: { categoryId: id } });
  return res.json({ success: true });
});

// Assigner catégories à un produit
app.put("/api/products/:productId/categories", (req, res) => {
  const productId = String(req.params.productId);
  const { categoryIds } = req.body || {};
  const ok = setProductCategories(productId, Array.isArray(categoryIds) ? categoryIds : []);
  if (!ok) return res.status(404).json({ error: "Produit introuvable" });

  addMovement({
    source: "product_set_categories",
    productId,
    gramsDelta: 0,
    meta: { categoryIds: Array.isArray(categoryIds) ? categoryIds : [] },
  });

  return res.json({ success: true });
});

// Restock (+)
app.post("/api/restock", async (req, res) => {
  try {
    const { productId, grams } = req.body || {};
    const g = Number(grams);
    if (!productId) return res.status(400).json({ error: "productId manquant" });
    if (!g || g <= 0) return res.status(400).json({ error: "Quantité invalide" });

    const updated = restockProduct(String(productId), g);
    if (!updated) return res.status(404).json({ error: "Produit non trouvé" });

    for (const [label, v] of Object.entries(updated.variants || {})) {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: v.inventoryItemId,
        available: Number(v.canSell || 0),
      });
    }

    addMovement({
      source: "restock",
      productId: String(productId),
      productName: updated.name,
      gramsDelta: +Math.abs(g),
      totalAfter: updated.totalGrams,
    });

    return res.json({ success: true, productId: String(productId), newTotal: updated.totalGrams });
  } catch (e) {
    logEvent("api_restock_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur serveur" });
  }
});

// Set total stock (écrase total)
app.post("/api/set-total-stock", async (req, res) => {
  try {
    const { productId, totalGrams } = req.body || {};
    const newTotal = Number(totalGrams);
    if (!productId) return res.status(400).json({ error: "productId manquant" });
    if (!Number.isFinite(newTotal) || newTotal < 0) return res.status(400).json({ error: "Quantité invalide" });

    const current = PRODUCT_CONFIG[String(productId)]?.totalGrams ?? null;
    if (current === null) return res.status(404).json({ error: "Produit non trouvé" });

    const diff = newTotal - Number(current || 0);
    const updated = restockProduct(String(productId), diff);

    for (const [label, v] of Object.entries(updated.variants || {})) {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: v.inventoryItemId,
        available: Number(v.canSell || 0),
      });
    }

    addMovement({
      source: "set_total",
      productId: String(productId),
      productName: updated.name,
      gramsDelta: diff,
      totalAfter: updated.totalGrams,
      meta: { previousTotal: Number(current || 0), newTotal },
    });

    return res.json({
      success: true,
      productId: String(productId),
      previousTotal: Number(current || 0),
      newTotal,
      difference: diff,
    });
  } catch (e) {
    logEvent("api_set_total_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur serveur" });
  }
});

// Mouvements
app.get("/api/movements", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 2000);
  const data = listMovements({ limit });
  res.json({ count: data.length, data });
});

app.get("/api/movements.csv", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 2000), 10000);
  const data = listMovements({ limit });
  const csv = toCSV(data);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="stock-movements.csv"');
  res.send(csv);
});

app.delete("/api/movements", (req, res) => {
  clearMovements();
  return res.json({ success: true });
});

// Alertes stock bas (simple)
app.get("/api/alerts/low-stock", (req, res) => {
  const threshold = Number(req.query.threshold ?? process.env.LOW_STOCK_THRESHOLD ?? 10);
  const snap = getStockSnapshot();

  const low = Object.entries(snap)
    .map(([productId, p]) => ({ productId, ...p }))
    .filter((p) => Number(p.totalGrams || 0) <= threshold)
    .sort((a, b) => Number(a.totalGrams || 0) - Number(b.totalGrams || 0));

  res.json({ threshold, count: low.length, data: low });
});

// Shopify: lister produits (pour import)
app.get("/api/shopify/products", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const products = await shopify.product.list({ limit });

    const out = (products || []).map((p) => ({
      productId: String(p.id),
      title: p.title,
      variants: (p.variants || []).map((v) => ({
        variantId: String(v.id),
        title: String(v.title || ""),
        inventoryItemId: Number(v.inventory_item_id),
      })),
    }));

    return res.json({ count: out.length, data: out });
  } catch (e) {
    logEvent("shopify_products_list_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur Shopify" });
  }
});

// Import 1 produit Shopify -> crée/maj config dans l’app
app.post("/api/import/product", async (req, res) => {
  try {
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
      meta: { categories: Array.isArray(categoryIds) ? categoryIds : [] },
    });

    return res.json({ success: true, product: imported });
  } catch (e) {
    logEvent("import_product_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur import" });
  }
});

// ============ Start ============
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  logEvent("server_started", {
    host: HOST,
    port: PORT,
    products: Object.keys(PRODUCT_CONFIG).length,
  });
});

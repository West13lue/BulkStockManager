// server.js
// ============================================
// BULK STOCK MANAGER (Shopify) - Render Ready
// - Sert /public + GET /
// - Webhook orders/create (HMAC) -> décrémente le stock "vrac" (grammes)
// - Source de vérité = app (écrase Shopify)
// - Catégories + import produits Shopify
// - Historique (mouvements) + CSV
// - Ajustement stock par UNITÉS (+ / -) pour la modal produit
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

// Petit helper : push les quantités calculées vers Shopify
async function pushProductInventoryToShopify(shopify, productView) {
  if (!productView?.variants) return;

  for (const [label, v] of Object.entries(productView.variants)) {
    const unitsAvailable = Number(v.canSell || 0);
    const inventoryItemId = v.inventoryItemId;

    if (!inventoryItemId || !process.env.LOCATION_ID) continue;

    await shopify.inventoryLevel.set({
      location_id: process.env.LOCATION_ID,
      inventory_item_id: inventoryItemId,
      available: unitsAvailable,
    });
  }
}

// ================= Middlewares =================
app.use(express.static(path.join(__dirname, "public")));

// CORS (utile si iframe admin)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Shopify-Hmac-Sha256");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// CSP Shopify Admin
app.use((req, res, next) => {
  const shopDomain = process.env.SHOP_NAME ? `https://${process.env.SHOP_NAME}.myshopify.com` : "*";
  res.setHeader("Content-Security-Policy", `frame-ancestors https://admin.shopify.com ${shopDomain};`);
  next();
});

// JSON pour API
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

    for (const item of order.line_items) {
      if (!item?.product_id) continue;

      const productId = String(item.product_id);
      const variantTitle = String(item.variant_title || "");
      const quantity = Number(item.quantity || 0);

      if (!PRODUCT_CONFIG[productId]) continue;

      const gramsPerUnit = parseGramsFromVariantTitle(variantTitle);
      if (!gramsPerUnit || gramsPerUnit <= 0) continue;

      const gramsDelta = gramsPerUnit * quantity;

      // 1) update local pool (source de vérité)  ✅ (await important)
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

// Alias (si tu veux garder l’ancien)
app.get("/api/catalog", (req, res) => {
  const catalog = getCatalogSnapshot();
  catalog.products.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
  );
  res.json(catalog);
});

// ======== Catégories (format attendu par app.js) ========
app.get("/api/categories", (req, res) => {
  res.json({ categories: listCategories() });
});

app.post("/api/categories", (req, res) => {
  const { name } = req.body || {};
  if (!name || String(name).trim().length < 1) return res.status(400).json({ error: "Nom invalide" });

  const created = createCategory(String(name).trim());

  addMovement({
    source: "category_create",
    gramsDelta: 0,
    meta: { categoryId: created.id, name: created.name },
  });

  return res.json({ success: true, category: created });
});

app.put("/api/categories/:id", (req, res) => {
  const id = String(req.params.id);
  const { name } = req.body || {};
  if (!name || String(name).trim().length < 1) return res.status(400).json({ error: "Nom invalide" });

  const updated = renameCategory(id, String(name).trim());
  if (!updated) return res.status(404).json({ error: "Catégorie introuvable" });

  addMovement({
    source: "category_rename",
    gramsDelta: 0,
    meta: { categoryId: id, name: updated.name },
  });

  return res.json({ success: true, category: updated });
});

app.delete("/api/categories/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = deleteCategory(id);
  if (!ok) return res.status(404).json({ error: "Catégorie introuvable" });

  addMovement({
    source: "category_delete",
    gramsDelta: 0,
    meta: { categoryId: id },
  });

  return res.json({ success: true });
});

// ======== Assigner catégories à un produit (POST attendu) ========
function handleSetProductCategories(req, res) {
  const productId = String(req.params.productId);
  const { categoryIds } = req.body || {};
  const ids = Array.isArray(categoryIds) ? categoryIds.map(String) : [];

  const ok = setProductCategories(productId, ids);
  if (!ok) return res.status(404).json({ error: "Produit introuvable" });

  addMovement({
    source: "product_set_categories",
    productId,
    gramsDelta: 0,
    meta: { categoryIds: ids },
  });

  return res.json({ success: true });
}
app.post("/api/products/:productId/categories", handleSetProductCategories);
app.put("/api/products/:productId/categories", handleSetProductCategories);

// ======== Restock en grammes (modal réapprovisionner) ========
app.post("/api/restock", async (req, res) => {
  try {
    const { productId, grams } = req.body || {};
    const g = Number(grams);

    if (!productId) return res.status(400).json({ error: "productId manquant" });
    if (!g || g <= 0) return res.status(400).json({ error: "Quantité invalide" });

    const updated = await restockProduct(String(productId), g); // ✅ await
    if (!updated) return res.status(404).json({ error: "Produit non trouvé" });

    try {
      await pushProductInventoryToShopify(shopify, updated);
    } catch (e) {
      logEvent("inventory_push_error", { productId: String(productId), message: e?.message }, "error");
    }

    addMovement({
      source: "restock_grams",
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

// ======== ✅ Ajuster stock par UNITÉS (pour tes boutons + / -) ========
// body: { label: "3" } + { unitsDelta: 2 }  -> +2 unités de 3g (= +6g)
// body: { label: "10" } + { unitsDelta: -1 } -> -1 unité de 10g (= -10g)
app.post("/api/products/:productId/adjust-units", async (req, res) => {
  try {
    const productId = String(req.params.productId);
    const { label, unitsDelta } = req.body || {};

    const p = PRODUCT_CONFIG[productId];
    if (!p) return res.status(404).json({ error: "Produit introuvable" });

    const v = p.variants?.[String(label)];
    if (!v) return res.status(400).json({ error: "Variante introuvable (label)" });

    const u = Number(unitsDelta);
    if (!Number.isFinite(u) || u === 0) return res.status(400).json({ error: "unitsDelta invalide" });

    const gramsPer = Number(v.gramsPerUnit || 0);
    if (!gramsPer || gramsPer <= 0) return res.status(400).json({ error: "gramsPerUnit invalide" });

    const gramsChange = u * gramsPer; // peut être négatif
    const updated = await restockProduct(productId, gramsChange); // ✅ ajoute ou enlève en grammes
    if (!updated) return res.status(404).json({ error: "Produit introuvable" });

    try {
      await pushProductInventoryToShopify(shopify, updated);
    } catch (e) {
      logEvent("inventory_push_error", { productId, message: e?.message }, "error");
    }

    addMovement({
      source: "adjust_units",
      productId,
      productName: updated.name,
      gramsDelta: gramsChange,
      totalAfter: updated.totalGrams,
      meta: { label: String(label), unitsDelta: u, gramsPerUnit: gramsPer },
    });

    return res.json({
      success: true,
      productId,
      label: String(label),
      unitsDelta: u,
      gramsDelta: gramsChange,
      totalAfter: updated.totalGrams,
      product: updated,
    });
  } catch (e) {
    logEvent("api_adjust_units_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur serveur" });
  }
});

// ======== Historique d’un produit (à afficher sous Variantes) ========
app.get("/api/products/:productId/history", (req, res) => {
  const productId = String(req.params.productId);
  const limit = Math.min(Number(req.query.limit || 200), 2000);

  const all = listMovements({ limit: 10000 }) || [];
  const filtered = all.filter((m) => String(m.productId || "") === productId).slice(0, limit);

  res.json({ count: filtered.length, data: filtered });
});

// ======== Mouvements (global) ========
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

// ======== Export stock CSV (app.js le propose) ========
app.get("/api/stock.csv", (req, res) => {
  const catalog = getCatalogSnapshot();
  const products = Array.isArray(catalog.products) ? catalog.products : [];

  const header = ["productId", "name", "totalGrams", "categoryIds"].join(";");
  const lines = products.map((p) => {
    const cats = Array.isArray(p.categoryIds) ? p.categoryIds.join(",") : "";
    return [p.productId, (p.name || "").replace(/;/g, ","), Number(p.totalGrams || 0), cats].join(";");
  });

  const csv = [header, ...lines].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="stock.csv"');
  res.send(csv);
});

// ======== Shopify: lister produits (pour import) ========
// ✅ Format attendu par ton app.js : { products:[{id,title,variantsCount}] }
app.get("/api/shopify/products", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const q = String(req.query.query || "").trim().toLowerCase();

    const products = await shopify.product.list({ limit });

    let out = (products || []).map((p) => ({
      id: String(p.id),
      title: String(p.title || ""),
      variantsCount: Array.isArray(p.variants) ? p.variants.length : 0,
    }));

    if (q) {
      out = out.filter((p) => p.title.toLowerCase().includes(q));
    }

    // tri A->Z
    out.sort((a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" }));

    return res.json({ products: out });
  } catch (e) {
    logEvent("shopify_products_list_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur Shopify" });
  }
});

// ======== Import 1 produit Shopify -> upsert config ========
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

    // ✅ upsert (marche même si déjà présent)
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

    return res.json({ success: true, product: imported });
  } catch (e) {
    logEvent("import_product_error", { message: e?.message }, "error");
    return res.status(500).json({ error: e?.message || "Erreur import" });
  }
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

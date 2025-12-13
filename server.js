// server.js
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
const shopify = getShopifyClient();

// ================= Helpers =================
function logEvent(event, data = {}, level = "info") {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
}

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

function parseGramsFromAnyVariantField(v) {
  // Essaie option1/2/3 puis title puis sku
  const candidates = [
    v?.option1,
    v?.option2,
    v?.option3,
    v?.title,
    v?.sku,
  ].filter(Boolean);

  for (const c of candidates) {
    const m = String(c).match(/([\d.,]+)/);
    if (!m) continue;
    const g = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(g) && g > 0) return g;
  }
  return null;
}

async function pushProductInventoryToShopify(shopifyClient, productView) {
  if (!productView?.variants) return;
  const locationId = process.env.LOCATION_ID;
  if (!locationId) return;

  for (const [, v] of Object.entries(productView.variants)) {
    const unitsAvailable = Number(v.canSell || 0);
    const inventoryItemId = v.inventoryItemId;
    if (!inventoryItemId) continue;

    await shopifyClient.inventoryLevel.set({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: unitsAvailable,
    });
  }
}

// ================= Middlewares =================

// ✅ FRONT : toujours servir /public (cohérent avec ton repo)
app.use(express.static(path.join(__dirname, "public")));

// CORS minimal (iframe admin / fetch)
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

// ================= Webhook Shopify (RAW BODY) =================
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === "true";
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  try {
    const rawBody = req.body;

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

      if (!PRODUCT_CONFIG[productId]) continue;

      const gramsPerUnit = (() => {
        const m = variantTitle.match(/([\d.,]+)/);
        return m ? parseFloat(m[1].replace(",", ".")) : null;
      })();

      if (!gramsPerUnit || gramsPerUnit <= 0) continue;

      const gramsDelta = gramsPerUnit * quantity;

      const updated = await applyOrderToProduct(productId, gramsDelta);
      if (!updated) continue;

      try {
        await pushProductInventoryToShopify(shopify, updated);
      } catch (e) {
        logEvent("inventory_push_error", { productId, message: e?.message }, "error");
      }

      // movement non-bloquant
      try {
        addMovement({
          source: "webhook_order",
          productId,
          productName: updated.name,
          gramsDelta: -Math.abs(gramsDelta),
          totalAfter: updated.totalGrams,
          meta: { orderId: String(order.id), orderName: String(order.name || "") },
        });
      } catch (e) {
        console.warn("Movement ignored:", e.message);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    logEvent("webhook_error", { message: e?.message }, "error");
    return res.sendStatus(500);
  }
});

// ================= Pages =================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ✅ Catch-all SPA SAFE Express5 (sans casser /api)
// (optionnel, mais évite le “route not found” quand tu refresh une page)
app.get(/^\/(?!api\/|webhooks\/|health).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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

// ======== Catégories ========
app.get("/api/categories", (req, res) => {
  safeJson(res, () => res.json({ categories: listCategories() }));
});

app.post("/api/categories", (req, res) => {
  safeJson(res, () => {
    const { name } = req.body || {};
    if (!name || String(name).trim().length < 1) {
      return res.status(400).json({ error: "Nom invalide" });
    }

    const created = createCategory(String(name).trim());

    try {
      addMovement({
        source: "category_create",
        gramsDelta: 0,
        meta: { categoryId: created.id, name: created.name },
      });
    } catch {}

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

    try {
      addMovement({
        source: "category_rename",
        gramsDelta: 0,
        meta: { categoryId: id, name: updated.name },
      });
    } catch {}

    res.json({ success: true, category: updated });
  });
});

app.delete("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const id = String(req.params.id);
    const ok = deleteCategory(id);
    if (!ok) return res.status(404).json({ error: "Catégorie introuvable" });

    try {
      addMovement({ source: "category_delete", gramsDelta: 0, meta: { categoryId: id } });
    } catch {}

    res.json({ success: true });
  });
});

// ======== Import Shopify ========
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

app.post("/api/import/product", async (req, res) => {
  safeJson(res, async () => {
    const { productId, totalGrams, categoryIds } = req.body || {};
    if (!productId) return res.status(400).json({ error: "productId manquant" });

    const p = await shopify.product.get(Number(productId));
    if (!p?.id) return res.status(404).json({ error: "Produit Shopify introuvable" });

    const variants = {};
    for (const v of p.variants || []) {
      const grams = parseGramsFromAnyVariantField(v); // ✅ plus robuste
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

    try {
      addMovement({
        source: "import_shopify_product",
        productId: String(p.id),
        productName: imported.name,
        gramsDelta: 0,
        meta: { categoryIds: Array.isArray(categoryIds) ? categoryIds : [] },
      });
    } catch {}

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

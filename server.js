// server.js — FIX "Réponse non-JSON du serveur" + Multi-shop safe + Express 5 safe

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const crypto = require("crypto");

// --- logger (compat : ./utils/logger OU ./logger)
let logEvent = (event, data = {}, level = "info") =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
try {
  ({ logEvent } = require("./utils/logger"));
} catch {
  try {
    ({ logEvent } = require("./logger"));
  } catch {}
}

// --- Shopify
const { getShopifyClient } = require("./shopifyClient");
const shopify = getShopifyClient();

// --- Stock (source de vérité app)
const stock = require("./stockManager");

// --- Catalog/categories (multi-shop)
const catalogStore = require("./catalogStore");

// --- Movements (multi-shop)
const movementStore = require("./movementStore");

// --- Settings (multi-shop) : locationId par boutique (Option 2B)
const settingsStore = require("./settingsStore");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");

// =========================
// Helpers
// =========================
function getShop(req) {
  const q = String(req.query?.shop || "").trim();
  if (q) return q;

  const h = String(req.get("X-Shopify-Shop-Domain") || "").trim();
  if (h) return h;

  const envShopName = String(process.env.SHOP_NAME || "").trim();
  if (envShopName && envShopName.includes(".myshopify.com")) return envShopName;
  if (envShopName) return `${envShopName}.myshopify.com`;

  return "default";
}

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // dev
  const hash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
  return hash === hmacHeader;
}

function apiError(res, code, message, extra) {
  return res.status(code).json({ error: message, ...(extra ? { extra } : {}) });
}

function safeJson(res, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.catch((e) => {
        logEvent("api_error", { message: e?.message }, "error");
        return apiError(res, 500, e?.message || "Erreur serveur");
      });
    }
    return out;
  } catch (e) {
    logEvent("api_error", { message: e?.message }, "error");
    return apiError(res, 500, e?.message || "Erreur serveur");
  }
}

function parseGramsFromVariant(v) {
  const candidates = [v?.option1, v?.option2, v?.option3, v?.title, v?.sku].filter(Boolean);
  for (const c of candidates) {
    const m = String(c).match(/([\d.,]+)/);
    if (!m) continue;
    const g = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(g) && g > 0) return g;
  }
  return null;
}

// =========================
// Shopify inventory sync — MULTI SHOP (Option 2B)
// =========================
const _cachedLocationIdByShop = new Map(); // shopKey -> locationId

async function getLocationIdForShop(shop) {
  const sh = String(shop || "default").trim().toLowerCase();

  if (_cachedLocationIdByShop.has(sh)) return _cachedLocationIdByShop.get(sh);

  // 1) settingsStore
  const settings = settingsStore.loadSettings(sh) || {};
  if (settings.locationId) {
    const id = Number(settings.locationId);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  // 2) fallback env
  const envLoc = process.env.SHOPIFY_LOCATION_ID || process.env.LOCATION_ID;
  if (envLoc) {
    const id = Number(envLoc);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  // 3) fallback: première location Shopify
  const locations = await shopify.location.list({ limit: 10 });
  const first = Array.isArray(locations) ? locations[0] : null;
  if (!first?.id) throw new Error("Aucune location Shopify trouvée (location.list)");

  const id = Number(first.id);
  _cachedLocationIdByShop.set(sh, id);
  return id;
}

async function pushProductInventoryToShopify(shop, productView) {
  if (!productView?.variants) return;

  const locationId = await getLocationIdForShop(shop);

  for (const [, v] of Object.entries(productView.variants)) {
    const inventoryItemId = Number(v.inventoryItemId || 0);
    const unitsAvailable = Math.max(0, Number(v.canSell || 0));
    if (!inventoryItemId) continue;

    await shopify.inventoryLevel.set({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: unitsAvailable,
    });
  }
}

function findGramsPerUnitByInventoryItemId(productView, inventoryItemId) {
  const invId = Number(inventoryItemId);
  if (!productView?.variants) return null;

  for (const v of Object.values(productView.variants)) {
    if (Number(v?.inventoryItemId) === invId) {
      const g = Number(v?.gramsPerUnit);
      return Number.isFinite(g) && g > 0 ? g : null;
    }
  }
  return null;
}

// =========================
// 1) MIDDLEWARES
// =========================
app.use("/api", express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Shopify-Hmac-Sha256, X-Shopify-Shop-Domain"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const envShopName = String(process.env.SHOP_NAME || "").trim();
  const shopDomain = envShopName
    ? envShopName.includes(".myshopify.com")
      ? `https://${envShopName}`
      : `https://${envShopName}.myshopify.com`
    : "*";

  res.setHeader("Content-Security-Policy", `frame-ancestors https://admin.shopify.com ${shopDomain};`);
  next();
});

app.get("/health", (req, res) => res.status(200).send("ok"));

// =========================
// 2) WEBHOOKS (RAW BODY)
// =========================
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const hmac = req.get("X-Shopify-Hmac-Sha256");

    if (process.env.NODE_ENV === "production" && process.env.SHOPIFY_WEBHOOK_SECRET) {
      if (!hmac || !verifyShopifyWebhook(req.body, hmac)) return res.sendStatus(401);
    }

    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const shop =
      String(payload?.myshopify_domain || payload?.domain || payload?.shop_domain || "").trim().toLowerCase() ||
      getShop(req);

    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    if (!lineItems.length) return res.sendStatus(200);

    for (const li of lineItems) {
      const productId = String(li?.product_id || "");
      const variantId = Number(li?.variant_id || 0);
      const qty = Number(li?.quantity || 0);
      if (!productId || !variantId || qty <= 0) continue;

      const currentSnap = stock.getStockSnapshot ? stock.getStockSnapshot(shop)?.[productId] : null;
      if (!currentSnap) continue;

      const variant = await shopify.productVariant.get(variantId);
      const inventoryItemId = Number(variant?.inventory_item_id || 0);
      if (!inventoryItemId) continue;

      const gramsPerUnit = findGramsPerUnitByInventoryItemId(currentSnap, inventoryItemId);
      if (!gramsPerUnit) continue;

      const gramsToSubtract = gramsPerUnit * qty;

      const updated = await stock.applyOrderToProduct(shop, productId, gramsToSubtract);
      if (updated) {
        try {
          await pushProductInventoryToShopify(shop, updated);
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId, message: e?.message }, "error");
        }

        if (movementStore.addMovement) {
          movementStore.addMovement(
            {
              source: "order_webhook",
              productId,
              productName: updated.name,
              gramsDelta: -Math.abs(gramsToSubtract),
              totalAfter: updated.totalGrams,
              shop,
            },
            shop
          );
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    logEvent("webhook_error", { message: e.message }, "error");
    return res.sendStatus(500);
  }
});

// =========================
// 3) API (TOUJOURS JSON)
// =========================

// ---- Settings (Option 2B)
app.get("/api/settings", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const settings = settingsStore.loadSettings(shop) || {};
    return res.json({ shop, settings });
  });
});

// ---- Lister les locations Shopify
app.get("/api/shopify/locations", (req, res) => {
  safeJson(res, async () => {
    const locations = await shopify.location.list({ limit: 50 });
    const out = (locations || []).map((l) => ({
      id: Number(l.id),
      name: String(l.name || ""),
      active: Boolean(l.active),
      address1: l.address1 || "",
      city: l.city || "",
      country: l.country || "",
    }));
    return res.json({ locations: out });
  });
});

// ---- Enregistrer locationId par shop
app.post("/api/settings/location", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const locationId = Number(req.body?.locationId);

    if (!Number.isFinite(locationId) || locationId <= 0) {
      return apiError(res, 400, "locationId invalide");
    }

    const saved = settingsStore.setLocationId(shop, locationId);
    _cachedLocationIdByShop.delete(String(shop || "default").trim().toLowerCase());

    return res.json({ success: true, shop, settings: saved });
  });
});

app.get("/api/server-info", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const snap = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };

    return res.json({
      mode: process.env.NODE_ENV || "development",
      port: PORT,
      productCount: Array.isArray(snap.products) ? snap.products.length : 0,
      lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
      shop,
    });
  });
});

// ---- Stock (front attend : { products:[...], categories:[...] })
app.get("/api/stock", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const { sort = "alpha", category = "" } = req.query;

    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    const categories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];

    let products = Array.isArray(snapshot.products) ? snapshot.products.slice() : [];

    if (category) {
      products = products.filter((p) => Array.isArray(p.categoryIds) && p.categoryIds.includes(String(category)));
    }

    if (sort === "alpha") {
      products.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
      );
    }

    return res.json({ products, categories });
  });
});

// ---- Export stock CSV
app.get("/api/stock.csv", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];

    const header = ["productId", "name", "totalGrams", "categoryIds"].join(",");
    const lines = products.map((p) => {
      const cat = Array.isArray(p.categoryIds) ? p.categoryIds.join("|") : "";
      const esc = (v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [esc(p.productId), esc(p.name), esc(p.totalGrams), esc(cat)].join(",");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock.csv"');
    return res.send([header, ...lines].join("\n"));
  });
});

// ---- Catégories
app.get("/api/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const categories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    return res.json({ categories });
  });
});

app.post("/api/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const name = String(req.body?.name ?? req.body?.categoryName ?? "").trim();
    if (!name) return apiError(res, 400, "Nom de catégorie invalide");

    const created = catalogStore.createCategory(shop, name);

    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "category_create", gramsDelta: 0, meta: { categoryId: created.id, name: created.name }, shop },
        shop
      );
    }

    return res.json({ success: true, category: created });
  });
});

app.put("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const id = String(req.params.id);
    const name = String(req.body?.name || "").trim();
    if (!name) return apiError(res, 400, "Nom invalide");

    const updated = catalogStore.renameCategory(shop, id, name);

    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "category_rename", gramsDelta: 0, meta: { categoryId: id, name }, shop },
        shop
      );
    }

    return res.json({ success: true, category: updated });
  });
});

app.delete("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const id = String(req.params.id);

    catalogStore.deleteCategory(shop, id);

    if (movementStore.addMovement) {
      movementStore.addMovement({ source: "category_delete", gramsDelta: 0, meta: { categoryId: id }, shop }, shop);
    }

    return res.json({ success: true });
  });
});

// ---- Mouvements
app.get("/api/movements", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const limit = Math.min(Number(req.query.limit || 200), 2000);
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 365);

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days, limit }) : [];
    return res.json({ count: rows.length, data: rows });
  });
});

app.get("/api/movements.csv", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const limit = Math.min(Number(req.query.limit || 2000), 10000);
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days, limit }) : [];
    const csv = movementStore.toCSV ? movementStore.toCSV(rows) : "ts,source,productId\n";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock-movements.csv"');
    return res.send(csv);
  });
});

// ---- Historique produit
app.get("/api/products/:productId/history", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const productId = String(req.params.productId || "");
    const limit = Math.min(Number(req.query.limit || 200), 2000);

    if (!productId) return apiError(res, 400, "productId manquant");

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days: 365, limit: 10000 }) : [];
    const filtered = (rows || []).filter((m) => String(m.productId || "") === productId).slice(0, limit);
    return res.json({ data: filtered });
  });
});

// ---- Ajuster total
app.post("/api/products/:productId/adjust-total", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    const productId = String(req.params.productId);
    const gramsDelta = Number(req.body?.gramsDelta);

    if (!Number.isFinite(gramsDelta) || gramsDelta === 0) {
      return apiError(res, 400, "gramsDelta invalide (ex: 50 ou -50)");
    }
    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    const updated = await stock.restockProduct(shop, productId, gramsDelta);
    if (!updated) return apiError(res, 404, "Produit introuvable");

    try {
      await pushProductInventoryToShopify(shop, updated);
    } catch (e) {
      logEvent("inventory_push_error", { shop, productId, message: e?.message }, "error");
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "adjust_total",
          productId,
          productName: updated.name,
          gramsDelta,
          totalAfter: updated.totalGrams,
          shop,
        },
        shop
      );
    }

    return res.json({ success: true, product: updated });
  });
});

// ✅ FIX: endpoint utilisé par index.html (mini glue modal restock)
app.post("/api/restock", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    const productId = String(req.body?.productId || "");
    const grams = Number(req.body?.grams);

    if (!productId) return apiError(res, 400, "productId manquant");
    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide (ex: 50)");

    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    // on réutilise restockProduct (delta positif)
    const updated = await stock.restockProduct(shop, productId, Math.abs(grams));
    if (!updated) return apiError(res, 404, "Produit introuvable");

    try {
      await pushProductInventoryToShopify(shop, updated);
    } catch (e) {
      logEvent("inventory_push_error", { shop, productId, message: e?.message }, "error");
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "restock_modal",
          productId,
          productName: updated.name,
          gramsDelta: Math.abs(grams),
          totalAfter: updated.totalGrams,
          shop,
        },
        shop
      );
    }

    return res.json({ success: true, product: updated });
  });
});

// ---- Assigner catégories produit
app.post("/api/products/:productId/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const productId = String(req.params.productId);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(String) : [];

    if (typeof stock.setProductCategories !== "function") {
      return apiError(res, 500, "stock.setProductCategories introuvable");
    }

    const ok = stock.setProductCategories(shop, productId, categoryIds);
    if (!ok) return apiError(res, 404, "Produit introuvable (non configuré)");

    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "product_set_categories", productId, gramsDelta: 0, meta: { categoryIds }, shop },
        shop
      );
    }

    return res.json({ success: true, productId, categoryIds });
  });
});

// ---- Supprimer un produit côté app
app.delete("/api/products/:productId", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    const productId = String(req.params.productId);

    if (typeof stock.removeProduct !== "function") {
      return apiError(res, 500, "stock.removeProduct introuvable");
    }

    const ok = stock.removeProduct(shop, productId);
    if (!ok) return apiError(res, 404, "Produit introuvable");

    if (movementStore.addMovement) {
      movementStore.addMovement({ source: "product_deleted", productId, gramsDelta: 0, shop }, shop);
    }

    return res.json({ success: true });
  });
});

// ---- Shopify : lister produits
app.get("/api/shopify/products", (req, res) => {
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

    return res.json({ products: out });
  });
});

// ---- Import 1 produit Shopify
app.post("/api/import/product", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);

    const productId = req.body?.productId ?? req.body?.id;
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];

    if (!productId) return apiError(res, 400, "productId manquant");

    const p = await shopify.product.get(Number(productId));
    if (!p?.id) return apiError(res, 404, "Produit Shopify introuvable");

    const variants = {};
    for (const v of p.variants || []) {
      const grams = parseGramsFromVariant(v);
      if (!grams) continue;

      variants[String(grams)] = {
        gramsPerUnit: grams,
        inventoryItemId: Number(v.inventory_item_id),
      };
    }

    if (!Object.keys(variants).length) {
      return apiError(res, 400, "Aucune variante avec grammage détecté (option/title/sku).");
    }

    if (typeof stock.upsertImportedProductConfig !== "function") {
      return apiError(res, 500, "stock.upsertImportedProductConfig introuvable");
    }

    const imported = stock.upsertImportedProductConfig(shop, {
      productId: String(p.id),
      name: String(p.title || p.handle || p.id),
      variants,
      categoryIds,
    });

    try {
      await pushProductInventoryToShopify(shop, imported);
    } catch (e) {
      logEvent("inventory_push_error", { shop, productId: String(p.id), message: e?.message }, "error");
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "import_shopify_product",
          productId: String(p.id),
          productName: imported.name,
          gramsDelta: 0,
          meta: { categoryIds },
          shop,
        },
        shop
      );
    }

    return res.json({ success: true, product: imported });
  });
});

// ---- TEST ORDER
app.post("/api/test-order", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    const grams = Number(req.body?.grams || 10);
    let productId = String(req.body?.productId || "");

    if (!productId) {
      const snap = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const first = Array.isArray(snap.products) ? snap.products[0] : null;
      if (!first?.productId) return apiError(res, 400, "Aucun produit configuré pour test");
      productId = String(first.productId);
    }

    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide");

    const updated = await stock.applyOrderToProduct(shop, productId, grams);
    if (!updated) return apiError(res, 404, "Produit introuvable");

    try {
      await pushProductInventoryToShopify(shop, updated);
    } catch (e) {
      logEvent("inventory_push_error", { shop, productId, message: e?.message }, "error");
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "test_order",
          productId,
          productName: updated.name,
          gramsDelta: -Math.abs(grams),
          totalAfter: updated.totalGrams,
          shop,
        },
        shop
      );
    }

    return res.json({ success: true, tested: { productId, grams }, product: updated });
  });
});

// ✅ si une route /api n’existe pas => JSON 404 (pas HTML)
app.use("/api", (req, res) => apiError(res, 404, "Route API non trouvée"));

// ✅ handler erreurs => JSON (pas HTML)
app.use((err, req, res, next) => {
  if (req.path.startsWith("/api")) {
    logEvent("api_uncaught_error", { message: err?.message }, "error");
    return apiError(res, 500, "Erreur serveur API");
  }
  next(err);
});

// =========================
// 4) FRONT
// =========================
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(INDEX_HTML));

// Catch-all SPA : EXCLUT /api et /webhooks et /health (Express 5 safe)
app.get(/^\/(?!api\/|webhooks\/|health).*/, (req, res) => res.sendFile(INDEX_HTML));

// =========================
app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", { port: PORT, publicDir: PUBLIC_DIR });
  console.log("✅ Server running on port", PORT);
});

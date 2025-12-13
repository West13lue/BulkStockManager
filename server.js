// server.js — FIX "Réponse non-JSON du serveur" (Express 5 safe)

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
const {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
} = require("./catalogStore");

const {
  addMovement,
  listMovements,
  toCSV,
  clearMovements,
} = require("./movementStore");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");

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
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://admin.shopify.com ${shopDomain};`
  );
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

      // Ici tu peux remettre ton traitement commande si besoin
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

app.get("/api/server-info", (req, res) => {
  res.json({
    port: PORT,
    productsCount: Object.keys(stock?.PRODUCT_CONFIG || {}).length,
  });
});

// ---- Catégories
app.get("/api/categories", (req, res) => {
  try {
    res.json({ categories: listCategories() });
  } catch (e) {
    console.error("GET categories error:", e);
    return apiError(res, 500, e.message);
  }
});

app.post("/api/categories", (req, res) => {
  try {
    const name = String(req.body?.name ?? req.body?.categoryName ?? "").trim();
    if (!name) return apiError(res, 400, "Nom de catégorie invalide");

    const created = createCategory(name);
    res.json({ success: true, category: created });
  } catch (e) {
    console.error("POST category error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---- Mouvements (si ton UI les lit)
app.get("/api/movements", (req, res) => {
  try {
    res.json({ movements: listMovements() });
  } catch (e) {
    console.error("GET movements error:", e);
    return apiError(res, 500, e.message);
  }
});

// ---- Shopify liste produits
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
    });

    res.json({ success: true, product: imported });
  } catch (e) {
    console.error("POST import product error:", e);
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

// Static front
app.use(express.static(PUBLIC_DIR));

// Home
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

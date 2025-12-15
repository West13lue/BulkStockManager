// server.js — PREFIX-SAFE (/apps/<slug>/...), STATIC FIX, JSON API SAFE, Multi-shop safe, Express 5 safe
// ✅ ENRICHI avec CMP, Valeur stock, Stats catégories, Suppression mouvements
// ✅ + OAuth Shopify (Partner) : /api/auth/start + /api/auth/callback
// ✅ + SECURE /api/* (App Store) via Shopify Session Token (JWT HS256)

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// ✅ OAuth token store
const tokenStore = require("./utils/tokenStore");

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

// --- Shopify client (✅ par shop)
const { getShopifyClient, normalizeShopDomain } = require("./shopifyClient");

// --- Stock (source de vérité app)
const stock = require("./stockManager");

// --- Catalog/categories (multi-shop)
const catalogStore = require("./catalogStore");

// --- Movements (multi-shop)
const movementStore = require("./movementStore");

// --- Settings (multi-shop) : locationId par boutique (Option 2B)
let settingsStore = null;
try {
  settingsStore = require("./settingsStore");
} catch (e) {
  settingsStore = {
    loadSettings: () => ({}),
    setLocationId: (_shop, locationId) => ({ locationId }),
  };
}

// ✅ OAuth config
const SHOPIFY_API_KEY = String(process.env.SHOPIFY_API_KEY || "").trim();
const SHOPIFY_API_SECRET = String(process.env.SHOPIFY_API_SECRET || "").trim();
const OAUTH_SCOPES = String(process.env.SHOPIFY_SCOPES || "").trim();

// ✅ API auth switch (en prod => ON par défaut)
const API_AUTH_REQUIRED =
  String(process.env.API_AUTH_REQUIRED || "").trim() === ""
    ? process.env.NODE_ENV === "production"
    : String(process.env.API_AUTH_REQUIRED).trim().toLowerCase() !== "false";

// state anti-CSRF simple en mémoire (ok pour 1 instance Render)
const _oauthStateByShop = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

const INDEX_HTML = fileExists(path.join(PUBLIC_DIR, "index.html"))
  ? path.join(PUBLIC_DIR, "index.html")
  : path.join(ROOT_DIR, "index.html");

// =====================================================
// Helpers
// =====================================================

function resolveShopFallback() {
  const envShopName = String(process.env.SHOP_NAME || "").trim();
  const envShop = envShopName ? normalizeShopDomain(envShopName) : "";
  return envShop;
}

function shopFromHostParam(hostParam) {
  try {
    const raw = String(hostParam || "").trim();
    if (!raw) return "";
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const domain = decoded.split("/")[0].trim();
    return domain ? normalizeShopDomain(domain) : "";
  } catch {
    return "";
  }
}

function getShop(req) {
  // ✅ priorité: shop déterminé par middleware auth (session token)
  const fromAuth = String(req.shopDomain || "").trim();
  if (fromAuth) return normalizeShopDomain(fromAuth);

  const q = String(req.query?.shop || "").trim();
  if (q) return normalizeShopDomain(q);

  const hostQ = String(req.query?.host || "").trim();
  const hostShop = shopFromHostParam(hostQ);
  if (hostShop) return hostShop;

  const h = String(req.get("X-Shopify-Shop-Domain") || "").trim();
  if (h) return normalizeShopDomain(h);

  const envShop = resolveShopFallback();
  if (envShop) return envShop;

  return "";
}

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true;
  const hash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
  return hash === hmacHeader;
}

function apiError(res, code, message, extra) {
  return res.status(code).json({ error: message, ...(extra ? { extra } : {}) });
}

// ✅ OAuth helpers
function verifyOAuthHmac(query) {
  const { hmac, ...rest } = query || {};
  if (!hmac || !SHOPIFY_API_SECRET) return false;

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");

  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");

  const hmacStr = String(hmac);
  if (hmacStr.length !== digest.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmacStr, "utf8"));
  } catch {
    return false;
  }
}

function requireOAuthEnv(res) {
  if (!SHOPIFY_API_KEY) return apiError(res, 500, "SHOPIFY_API_KEY manquant");
  if (!SHOPIFY_API_SECRET) return apiError(res, 500, "SHOPIFY_API_SECRET manquant");
  if (!OAUTH_SCOPES) return apiError(res, 500, "SHOPIFY_SCOPES manquant (ex: read_products,write_inventory,...)");
  if (!process.env.RENDER_PUBLIC_URL) {
    return apiError(res, 500, "RENDER_PUBLIC_URL manquant (ex: https://stock-cbd-manager-1.onrender.com)");
  }
  return null;
}

// ===============================
// ✅ Shopify Session Token (JWT)
// ===============================
function base64UrlToBuffer(str) {
  const s = String(str || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(str || "").length / 4) * 4, "=");
  return Buffer.from(s, "base64");
}

function parseShopFromDestOrIss(payload) {
  // dest: "https://xxx.myshopify.com"
  const dest = String(payload?.dest || "").trim();
  if (dest) return normalizeShopDomain(dest);

  // iss: "https://xxx.myshopify.com/admin"
  const iss = String(payload?.iss || "").trim();
  if (iss) {
    const noProto = iss.replace(/^https?:\/\//i, "");
    const domain = noProto.split("/")[0].trim();
    return normalizeShopDomain(domain);
  }
  return "";
}

function verifySessionToken(token) {
  if (!SHOPIFY_API_SECRET) return { ok: false, error: "SHOPIFY_API_SECRET manquant (JWT verify)" };

  const t = String(token || "").trim();
  const parts = t.split(".");
  if (parts.length !== 3) return { ok: false, error: "Session token JWT invalide" };

  const [h64, p64, s64] = parts;

  let header = null;
  let payload = null;
  try {
    header = JSON.parse(base64UrlToBuffer(h64).toString("utf8"));
    payload = JSON.parse(base64UrlToBuffer(p64).toString("utf8"));
  } catch {
    return { ok: false, error: "JWT illisible" };
  }

  // Shopify session tokens are HS256
  if (String(header?.alg || "") !== "HS256") return { ok: false, error: "JWT alg non supporté" };

  // Signature check (HMAC SHA256)
  const signingInput = `${h64}.${p64}`;
  const expected = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(signingInput).digest(); // Buffer (32)
  const got = base64UrlToBuffer(s64);

  if (got.length !== expected.length) return { ok: false, error: "JWT signature invalide" };
  try {
    if (!crypto.timingSafeEqual(expected, got)) return { ok: false, error: "JWT signature invalide" };
  } catch {
    return { ok: false, error: "JWT signature invalide" };
  }

  // Basic claims checks
  const now = Math.floor(Date.now() / 1000);

  const exp = Number(payload?.exp);
  if (Number.isFinite(exp) && exp <= now) return { ok: false, error: "Session token expiré" };

  const nbf = Number(payload?.nbf);
  if (Number.isFinite(nbf) && nbf > now) return { ok: false, error: "Session token pas encore valide" };

  // aud check (should match API key)
  if (SHOPIFY_API_KEY) {
    const aud = payload?.aud;
    const audOk = Array.isArray(aud) ? aud.includes(SHOPIFY_API_KEY) : String(aud || "") === SHOPIFY_API_KEY;
    if (!audOk) return { ok: false, error: "JWT audience invalide" };
  }

  return { ok: true, payload, header };
}

function extractBearerToken(req) {
  const auth = String(req.get("Authorization") || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  // fallback header (pratique côté fetch)
  const x = String(req.get("X-Shopify-Session-Token") || "").trim();
  if (x) return x;

  return "";
}

function requireApiAuth(req, res, next) {
  // Bypass dev optionnel
  if (!API_AUTH_REQUIRED) return next();

  // Laisse passer l’OAuth install/callback
  if (req.path === "/api/auth/start" || req.path === "/api/auth/callback") return next();

  const token = extractBearerToken(req);
  if (!token) return apiError(res, 401, "Session token manquant");

  const verified = verifySessionToken(token);
  if (!verified.ok) return apiError(res, 401, verified.error);

  const shop = parseShopFromDestOrIss(verified.payload);
  if (!shop) return apiError(res, 401, "Shop introuvable dans le session token");

  // ✅ inject shop + payload (utile partout)
  req.shopDomain = shop;
  req.sessionTokenPayload = verified.payload;

  next();
}

function extractShopifyError(e) {
  const statusCode = e?.statusCode || e?.response?.statusCode;
  const requestId = e?.response?.headers?.["x-request-id"] || e?.response?.headers?.["x-requestid"];
  const retryAfter = e?.response?.headers?.["retry-after"];
  const body = e?.response?.body;

  return {
    message: e?.message,
    statusCode,
    requestId,
    retryAfter,
    body: body && typeof body === "object" ? body : undefined,
  };
}

function safeJson(res, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.catch((e) => {
        const info = extractShopifyError(e);
        logEvent("api_error", info, "error");
        return apiError(res, info.statusCode || 500, info.message || "Erreur serveur", info);
      });
    }
    return out;
  } catch (e) {
    const info = extractShopifyError(e);
    logEvent("api_error", info, "error");
    return apiError(res, info.statusCode || 500, info.message || "Erreur serveur", info);
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

function shopifyFor(shop) {
  return getShopifyClient(shop);
}

// =====================================================
// Shopify inventory sync (Option 2B)
// =====================================================
const _cachedLocationIdByShop = new Map();

async function getLocationIdForShop(shop) {
  const sh = String(shop || "").trim().toLowerCase();
  if (!sh) throw new Error("Shop introuvable (location)");

  if (_cachedLocationIdByShop.has(sh)) return _cachedLocationIdByShop.get(sh);

  const settings = (settingsStore?.loadSettings && settingsStore.loadSettings(sh)) || {};
  if (settings.locationId) {
    const id = Number(settings.locationId);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  const envLoc = process.env.SHOPIFY_LOCATION_ID || process.env.LOCATION_ID;
  if (envLoc) {
    const id = Number(envLoc);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  const client = shopifyFor(shop);
  const locations = await client.location.list({ limit: 10 });
  const first = Array.isArray(locations) ? locations[0] : null;
  if (!first?.id) throw new Error("Aucune location Shopify trouvée");

  const id = Number(first.id);
  _cachedLocationIdByShop.set(sh, id);
  return id;
}

async function pushProductInventoryToShopify(shop, productView) {
  if (!productView?.variants) return;

  const client = shopifyFor(shop);
  const locationId = await getLocationIdForShop(shop);

  for (const [, v] of Object.entries(productView.variants)) {
    const inventoryItemId = Number(v.inventoryItemId || 0);
    const unitsAvailable = Math.max(0, Number(v.canSell || 0));
    if (!inventoryItemId) continue;

    await client.inventoryLevel.set({
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

// =====================================================
// ROUTER "prefix-safe"
// =====================================================
const router = express.Router();

// JSON (uniquement /api)
router.use("/api", express.json({ limit: "2mb" }));

// CORS (simple)
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Shopify-Hmac-Sha256, X-Shopify-Shop-Domain, X-Shopify-Session-Token"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// CSP frame-ancestors (admin + shop)
router.use((req, res, next) => {
  const envShopName = String(process.env.SHOP_NAME || "").trim();
  const shopDomain = envShopName ? `https://${normalizeShopDomain(envShopName)}` : "*";
  res.setHeader("Content-Security-Policy", `frame-ancestors https://admin.shopify.com ${shopDomain};`);
  next();
});

// ✅ SECURE toutes les routes /api/*
router.use("/api", requireApiAuth);

router.get("/health", (req, res) => res.status(200).send("ok"));

// Static
if (fileExists(PUBLIC_DIR)) router.use(express.static(PUBLIC_DIR));
router.use(express.static(ROOT_DIR, { index: false }));

router.get("/css/style.css", (req, res) => {
  const p1 = path.join(PUBLIC_DIR, "css", "style.css");
  const p2 = path.join(ROOT_DIR, "style.css");
  const target = fileExists(p1) ? p1 : p2;
  if (!fileExists(target)) return res.status(404).send("style.css not found");
  res.type("text/css").sendFile(target);
});

router.get("/js/app.js", (req, res) => {
  const p1 = path.join(PUBLIC_DIR, "js", "app.js");
  const p2 = path.join(ROOT_DIR, "app.js");
  const target = fileExists(p1) ? p1 : p2;
  if (!fileExists(target)) return res.status(404).send("app.js not found");
  res.type("application/javascript").sendFile(target);
});

// =====================================================
// API ROUTES
// =====================================================

router.get("/api/debug/shopify", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable. Passe ?shop=xxx.myshopify.com ou configure SHOP_NAME.");

    const envShop = resolveShopFallback();
    const client = shopifyFor(shop);

    let connection = { ok: false };
    try {
      const s = await client.shop.get();
      connection = { ok: true, shop: { id: Number(s.id), name: String(s.name || ""), domain: String(s.domain || "") } };
    } catch (e) {
      connection = { ok: false, error: extractShopifyError(e) };
    }

    let locations = [];
    try {
      const locs = await client.location.list({ limit: 10 });
      locations = (locs || []).map((l) => ({ id: Number(l.id), name: String(l.name || ""), active: !!l.active }));
    } catch (e) {
      logEvent("debug_locations_error", extractShopifyError(e), "error");
    }

    res.json({
      ok: true,
      resolvedShop: shop,
      envShop,
      hasToken: Boolean(String(process.env.SHOPIFY_ADMIN_TOKEN || "").trim()),
      apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
      connection,
      locations,
    });
  });
});

router.get("/api/settings", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const settings = (settingsStore?.loadSettings && settingsStore.loadSettings(shop)) || {};
    res.json({ shop, settings });
  });
});

router.get("/api/shopify/locations", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const client = shopifyFor(shop);

    const locations = await client.location.list({ limit: 50 });
    const out = (locations || []).map((l) => ({
      id: Number(l.id),
      name: String(l.name || ""),
      active: Boolean(l.active),
      address1: l.address1 || "",
      city: l.city || "",
      country: l.country || "",
    }));
    res.json({ locations: out });
  });
});

router.post("/api/settings/location", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const locationId = Number(req.body?.locationId);
    if (!Number.isFinite(locationId) || locationId <= 0) return apiError(res, 400, "locationId invalide");

    const saved =
      (settingsStore?.setLocationId && settingsStore.setLocationId(shop, locationId)) || { locationId };

    _cachedLocationIdByShop.delete(String(shop).trim().toLowerCase());
    res.json({ success: true, shop, settings: saved });
  });
});

router.get("/api/server-info", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const snap = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    res.json({
      mode: process.env.NODE_ENV || "development",
      port: PORT,
      productCount: Array.isArray(snap.products) ? snap.products.length : 0,
      lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
      shop,
    });
  });
});

router.get("/api/stock", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

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

    res.json({ products, categories });
  });
});

// ✅ Valeur totale du stock
router.get("/api/stock/value", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (typeof stock.calculateTotalStockValue !== "function") {
      return apiError(res, 500, "calculateTotalStockValue non disponible");
    }

    const result = stock.calculateTotalStockValue(shop);
    res.json(result);
  });
});

// ✅ Stats par catégorie
router.get("/api/stats/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (typeof stock.getCategoryStats !== "function") {
      return apiError(res, 500, "getCategoryStats non disponible");
    }

    const result = stock.getCategoryStats(shop);
    res.json(result);
  });
});

router.get("/api/stock.csv", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];

    const header = ["productId", "name", "totalGrams", "averageCostPerGram", "categoryIds"].join(",");
    const lines = products.map((p) => {
      const cat = Array.isArray(p.categoryIds) ? p.categoryIds.join("|") : "";
      const esc = (v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [esc(p.productId), esc(p.name), esc(p.totalGrams), esc(p.averageCostPerGram || 0), esc(cat)].join(",");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock.csv"');
    res.send([header, ...lines].join("\n"));
  });
});

router.get("/api/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const categories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    res.json({ categories });
  });
});

router.post("/api/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const name = String(req.body?.name ?? req.body?.categoryName ?? "").trim();
    if (!name) return apiError(res, 400, "Nom de catégorie invalide");

    const created = catalogStore.createCategory(shop, name);
    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "category_create", gramsDelta: 0, meta: { categoryId: created.id, name: created.name }, shop },
        shop
      );
    }

    res.json({ success: true, category: created });
  });
});

router.put("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

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

    res.json({ success: true, category: updated });
  });
});

router.delete("/api/categories/:id", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const id = String(req.params.id);
    catalogStore.deleteCategory(shop, id);

    if (movementStore.addMovement) {
      movementStore.addMovement({ source: "category_delete", gramsDelta: 0, meta: { categoryId: id }, shop }, shop);
    }

    res.json({ success: true });
  });
});

router.get("/api/movements", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const limit = Math.min(Number(req.query.limit || 200), 2000);
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 365);

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days, limit }) : [];
    res.json({ count: rows.length, data: rows });
  });
});

router.get("/api/movements.csv", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const limit = Math.min(Number(req.query.limit || 2000), 10000);
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days, limit }) : [];

    const header = ["ts", "source", "productId", "productName", "gramsDelta", "purchasePricePerGram", "totalAfter", "shop"].join(
      ","
    );

    const csvEscape = (v) => {
      const s = String(v ?? "");
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = (rows || []).map((m) => {
      return [
        csvEscape(m.ts || ""),
        csvEscape(m.source || ""),
        csvEscape(m.productId || ""),
        csvEscape(m.productName || ""),
        csvEscape(m.gramsDelta ?? ""),
        csvEscape(m.purchasePricePerGram ?? ""),
        csvEscape(m.totalAfter ?? ""),
        csvEscape(m.shop || shop),
      ].join(",");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stock-movements.csv"');
    res.send([header, ...lines].join("\n"));
  });
});

router.delete("/api/movements/:id", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const movementId = String(req.params.id || "");
    if (!movementId) return apiError(res, 400, "ID de mouvement manquant");

    const mode = String(req.query.mode || "hide");
    return apiError(res, 501, "Suppression de mouvements non encore implémentée dans movementStore. Voir documentation.");
  });
});

router.get("/api/products/:productId/history", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId || "");
    const limit = Math.min(Number(req.query.limit || 200), 2000);
    if (!productId) return apiError(res, 400, "productId manquant");

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days: 365, limit: 10000 }) : [];
    const filtered = (rows || []).filter((m) => String(m.productId || "") === productId).slice(0, limit);
    return res.json({ data: filtered });
  });
});

router.post("/api/products/:productId/adjust-total", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);
    const gramsDelta = Number(req.body?.gramsDelta);
    const purchasePricePerGram = Number(req.body?.purchasePricePerGram || 0);

    if (!Number.isFinite(gramsDelta) || gramsDelta === 0) {
      return apiError(res, 400, "gramsDelta invalide (ex: 50 ou -50)");
    }
    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    const updated = await stock.restockProduct(shop, productId, gramsDelta, purchasePricePerGram);
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
          purchasePricePerGram: gramsDelta > 0 && purchasePricePerGram > 0 ? purchasePricePerGram : undefined,
          totalAfter: updated.totalGrams,
          shop,
        },
        shop
      );
    }

    res.json({
      success: true,
      product: updated,
      cmpUpdated: gramsDelta > 0 && purchasePricePerGram > 0,
    });
  });
});

router.patch("/api/products/:productId/average-cost", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);
    const averageCostPerGram = Number(req.body?.averageCostPerGram);

    if (!Number.isFinite(averageCostPerGram) || averageCostPerGram < 0) {
      return apiError(res, 400, "averageCostPerGram invalide (ex: 4.50)");
    }

    const store = stock.PRODUCT_CONFIG_BY_SHOP?.get(shop);
    if (!store) return apiError(res, 500, "Store introuvable");

    const cfg = store[productId];
    if (!cfg) return apiError(res, 404, "Produit introuvable");

    const oldCost = cfg.averageCostPerGram || 0;
    cfg.averageCostPerGram = averageCostPerGram;

    const stockStateMod = require("./stockState");
    const saveState = stockStateMod?.saveState;
    if (saveState) {
      const products = {};
      for (const [pid, p] of Object.entries(store)) {
        products[pid] = {
          name: p.name,
          totalGrams: p.totalGrams,
          averageCostPerGram: p.averageCostPerGram || 0,
          categoryIds: p.categoryIds || [],
          variants: p.variants || {},
        };
      }
      saveState(shop, {
        version: 2,
        updatedAt: new Date().toISOString(),
        products,
      });
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "average_cost_updated",
          productId,
          productName: cfg.name,
          gramsDelta: 0,
          meta: {
            oldAverageCost: oldCost,
            newAverageCost: averageCostPerGram,
          },
          shop,
        },
        shop
      );
    }

    logEvent("average_cost_manual_update", {
      shop,
      productId,
      oldCost: oldCost.toFixed(2),
      newCost: averageCostPerGram.toFixed(2),
    });

    res.json({
      success: true,
      productId,
      oldAverageCost: oldCost,
      newAverageCost: averageCostPerGram,
    });
  });
});

router.post("/api/products/:productId/categories", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

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

    res.json({ success: true, productId, categoryIds });
  });
});

router.delete("/api/products/:productId", (req, res) => {
  safeJson(res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);

    if (typeof stock.removeProduct !== "function") {
      return apiError(res, 500, "stock.removeProduct introuvable");
    }

    const ok = stock.removeProduct(shop, productId);
    if (!ok) return apiError(res, 404, "Produit introuvable");

    if (movementStore.addMovement) {
      movementStore.addMovement({ source: "product_deleted", productId, gramsDelta: 0, shop }, shop);
    }

    res.json({ success: true });
  });
});

router.get("/api/shopify/products", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const client = shopifyFor(shop);

    const limit = Math.min(Number(req.query.limit || 50), 250);
    const q = String(req.query.query || "").trim().toLowerCase();

    const products = await client.product.list({ limit });
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

router.post("/api/import/product", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const client = shopifyFor(shop);

    const productId = req.body?.productId ?? req.body?.id;
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];
    if (!productId) return apiError(res, 400, "productId manquant");

    const p = await client.product.get(Number(productId));
    if (!p?.id) return apiError(res, 404, "Produit Shopify introuvable");

    const variants = {};
    for (const v of p.variants || []) {
      const grams = parseGramsFromVariant(v);
      if (!grams) continue;
      variants[String(grams)] = { gramsPerUnit: grams, inventoryItemId: Number(v.inventory_item_id) };
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

    res.json({ success: true, product: imported });
  });
});

router.post("/api/restock", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.body?.productId || "").trim();
    const grams = Number(req.body?.grams);
    const purchasePricePerGram = Number(req.body?.purchasePricePerGram || 0);

    if (!productId) return apiError(res, 400, "productId manquant");
    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide (ex: 50)");

    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    const updated = await stock.restockProduct(shop, productId, grams, purchasePricePerGram);
    if (!updated) return apiError(res, 404, "Produit introuvable");

    try {
      await pushProductInventoryToShopify(shop, updated);
    } catch (e) {
      logEvent("inventory_push_error", { shop, productId, message: e?.message }, "error");
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "restock",
          productId,
          productName: updated.name,
          gramsDelta: Math.abs(grams),
          purchasePricePerGram: purchasePricePerGram > 0 ? purchasePricePerGram : undefined,
          totalAfter: updated.totalGrams,
          shop,
        },
        shop
      );
    }

    res.json({
      success: true,
      product: updated,
      cmpUpdated: purchasePricePerGram > 0,
    });
  });
});

router.post("/api/test-order", (req, res) => {
  safeJson(res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const grams = Number(req.body?.grams || 10);
    let productId = String(req.body?.productId || "");

    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide");

    if (!productId) {
      const snap = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const first = Array.isArray(snap.products) ? snap.products[0] : null;
      if (!first?.productId) return apiError(res, 400, "Aucun produit configuré pour test");
      productId = String(first.productId);
    }

    if (typeof stock.applyOrderToProduct !== "function") {
      return apiError(res, 500, "stock.applyOrderToProduct introuvable");
    }

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

    res.json({ success: true, tested: { productId, grams }, product: updated });
  });
});

// =====================
// OAuth Shopify (Partner)
// =====================

router.get("/api/auth/start", (req, res) => {
  safeJson(res, () => {
    const missing = requireOAuthEnv(res);
    if (missing) return;

    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable (ex: ?shop=xxx.myshopify.com)");

    const state = crypto.randomBytes(16).toString("hex");
    _oauthStateByShop.set(shop.toLowerCase(), state);

    const redirectUri = `${String(process.env.RENDER_PUBLIC_URL).replace(/\/+$/, "")}/api/auth/callback`;

    const authUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(SHOPIFY_API_KEY)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  });
});

router.get("/api/auth/callback", (req, res) => {
  safeJson(res, async () => {
    const missing = requireOAuthEnv(res);
    if (missing) return;

    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable (callback)");

    if (!verifyOAuthHmac(req.query)) return apiError(res, 401, "HMAC invalide");

    const expected = _oauthStateByShop.get(shop.toLowerCase());
    const got = String(req.query?.state || "");
    if (!expected || got !== expected) return apiError(res, 401, "State invalide");
    _oauthStateByShop.delete(shop.toLowerCase());

    const code = String(req.query?.code || "");
    if (!code) return apiError(res, 400, "Code OAuth manquant");

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson?.access_token) {
      return apiError(res, 500, "Échec échange token", { status: tokenRes.status, body: tokenJson });
    }

    tokenStore.saveToken(shop, tokenJson.access_token, { scope: tokenJson.scope });

    res.type("html").send(`
      <div style="font-family:system-ui;padding:24px">
        <h2>✅ OAuth OK</h2>
        <p>Token enregistré pour <b>${shop}</b>.</p>
        <p>Tu peux fermer cette page et relancer l'app.</p>
      </div>
    `);
  });
});

router.use("/api", (req, res) => apiError(res, 404, "Route API non trouvée"));

router.use((err, req, res, next) => {
  if (req.path.startsWith("/api")) {
    logEvent("api_uncaught_error", extractShopifyError(err), "error");
    return apiError(res, 500, "Erreur serveur API");
  }
  next(err);
});

router.get("/", (req, res) => res.sendFile(INDEX_HTML));
router.get(/^\/(?!api\/|webhooks\/|health|css\/|js\/).*/, (req, res) => res.sendFile(INDEX_HTML));

// =====================================================
// WEBHOOKS
// =====================================================
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const hmac = req.get("X-Shopify-Hmac-Sha256");

    if (process.env.NODE_ENV === "production" && process.env.SHOPIFY_WEBHOOK_SECRET) {
      if (!hmac || !verifyShopifyWebhook(req.body, hmac)) return res.sendStatus(401);
    }

    const headerShop = String(req.get("X-Shopify-Shop-Domain") || "").trim();
    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const payloadShop = String(payload?.myshopify_domain || payload?.domain || payload?.shop_domain || "").trim();

    const shop = normalizeShopDomain(headerShop || payloadShop || resolveShopFallback());
    if (!shop) {
      logEvent("webhook_no_shop", { headerShop, payloadShop }, "error");
      return res.sendStatus(200);
    }

    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    if (!lineItems.length) return res.sendStatus(200);

    const client = shopifyFor(shop);

    for (const li of lineItems) {
      const productId = String(li?.product_id || "");
      const variantId = Number(li?.variant_id || 0);
      const qty = Number(li?.quantity || 0);
      if (!productId || !variantId || qty <= 0) continue;

      const currentSnap = stock.getStockSnapshot ? stock.getStockSnapshot(shop)?.[productId] : null;
      if (!currentSnap) continue;

      const variant = await client.productVariant.get(variantId);
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
    logEvent("webhook_error", extractShopifyError(e), "error");
    return res.sendStatus(500);
  }
});

app.use("/", router);
app.use("/apps/:appSlug", router);

app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", { port: PORT, indexHtml: INDEX_HTML, apiAuthRequired: API_AUTH_REQUIRED });
  console.log("✅ Server running on port", PORT);
});

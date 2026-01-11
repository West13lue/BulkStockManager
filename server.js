// server.js — PREFIX-SAFE (/apps/<slug>/...), STATIC FIX, JSON API SAFE, Multi-shop safe, Express 5 safe
// ✅ ENRICHI avec CMP, Valeur stock, Stats categories, Suppression mouvements (stub)
// ✅ + OAuth Shopify (Partner) : /api/auth/start + /api/auth/callback
// ✅ + SECURE /api/* (App Store) via Shopify Session Token (JWT HS256)

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// ✅ OAuth token store (Render disk)
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
const {
  getShopifyClient,
  normalizeShopDomain,
  createAppSubscription,
  getActiveAppSubscriptions,
  cancelAppSubscription,
} = require("./shopifyClient");

// --- Stock (source de verite app)
const stock = require("./stockManager");

// --- Catalog/categories (multi-shop)
const catalogStore = require("./catalogStore");

// --- Movements (multi-shop)
const movementStore = require("./movementStore");

// --- Batch/Lots tracking (multi-shop) - PRO
let batchStore = null;
try {
  batchStore = require("./batchStore");
} catch (e) {
  console.warn("BatchStore non disponible:", e.message);
}

// --- Supplier Store (multi-shop) - PRO
let supplierStore = null;
try {
  supplierStore = require("./supplierStore");
} catch (e) {
  console.warn("SupplierStore non disponible:", e.message);
}

// --- Purchase Order Store (multi-shop) - Business
let purchaseOrderStore = null;
try {
  purchaseOrderStore = require("./purchaseOrderStore");
} catch (e) {
  console.warn("PurchaseOrderStore non disponible:", e.message);
}

// --- Sales Order Store (multi-shop) - PRO
let salesOrderStore = null;
try {
  salesOrderStore = require("./salesOrderStore");
} catch (e) {
  console.warn("SalesOrderStore non disponible:", e.message);
}

// --- Analytics (multi-shop) ✅ NOUVEAU
let analyticsStore = null;
let analyticsManager = null;
try {
  analyticsStore = require("./analyticsStore");
  analyticsManager = require("./analyticsManager");
} catch (e) {
  console.warn("Analytics modules non disponibles:", e.message);
}

// --- Plan Manager (Free/Standard/Premium) ✅ NOUVEAU
let planManager = null;
try {
  planManager = require("./planManager");
} catch (e) {
  console.warn("PlanManager non disponible:", e.message);
}

// --- Settings Manager (parametres avances) ✅ NOUVEAU
let settingsManager = null;
try {
  settingsManager = require("./settingsManager");
} catch (e) {
  console.warn("SettingsManager non disponible:", e.message);
}

// --- Settings (multi-shop) : locationId par boutique
let settingsStore = null;
try {
  settingsStore = require("./settingsStore");
} catch (e) {
  settingsStore = {
    loadSettings: () => ({}),
    setLocationId: (_shop, locationId) => ({ locationId }),
  };
}

// --- Kit Store (Kits & Bundles)
let kitStore = null;
try {
  kitStore = require("./kitStore");
} catch (e) {
  console.warn("KitStore non disponible:", e.message);
}
// --- Inventory Count Store (Sessions d'inventaire)
let inventoryCountStore = null;
try {
  inventoryCountStore = require("./inventoryCountStore");
} catch (e) {
  console.warn("InventoryCountStore non disponible:", e.message);
}
// --- Forecast Manager (Previsions)
let forecastManager = null;
try {
  forecastManager = require("./forecastManager");
} catch (e) {
  console.warn("ForecastManager non disponible:", e.message);
}

// --- User Profile Store (Profils utilisateurs)
let userProfileStore = null;
try {
  userProfileStore = require("./userProfileStore");
} catch (e) {
  console.warn("UserProfileStore non disponible:", e.message);
}

// ✅ Notifications & Alertes
let notificationStore = null;
let alertChecker = null;
try {
  notificationStore = require("./notificationStore");
  alertChecker = require("./alertChecker");
} catch (e) {
  console.warn("NotificationStore/AlertChecker non disponible:", e.message);
}


// ✅ OAuth config
const SHOPIFY_API_KEY = String(process.env.SHOPIFY_API_KEY || "").trim();
const SHOPIFY_API_SECRET = String(process.env.SHOPIFY_API_SECRET || "").trim();
const OAUTH_SCOPES = String(process.env.SHOPIFY_SCOPES || "").trim();

// ✅ API auth switch (en prod => ON par defaut)
const API_AUTH_REQUIRED =
  String(process.env.API_AUTH_REQUIRED || "").trim() === ""
    ? process.env.NODE_ENV === "production"
    : String(process.env.API_AUTH_REQUIRED).trim().toLowerCase() !== "false";

// state anti-CSRF simple en memoire (ok pour 1 instance Render)
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
  // ✅ priorite: shop determine par middleware auth (session token)
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
  if (!OAUTH_SCOPES)
    return apiError(res, 500, "SHOPIFY_SCOPES manquant (ex: read_products,write_inventory,...)");
  if (!process.env.RENDER_PUBLIC_URL) {
    return apiError(res, 500, "RENDER_PUBLIC_URL manquant (ex: https://stock-cbd-manager.onrender.com)");
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
  const dest = String(payload?.dest || "").trim(); // "https://xxx.myshopify.com"
  if (dest) return normalizeShopDomain(dest);

  const iss = String(payload?.iss || "").trim(); // "https://xxx.myshopify.com/admin"
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

  if (String(header?.alg || "") !== "HS256") return { ok: false, error: "JWT alg non supporte" };

  // Signature check
  const signingInput = `${h64}.${p64}`;
  const expected = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(signingInput).digest();
  const got = base64UrlToBuffer(s64);

  if (got.length !== expected.length) return { ok: false, error: "JWT signature invalide" };
  try {
    if (!crypto.timingSafeEqual(expected, got)) return { ok: false, error: "JWT signature invalide" };
  } catch {
    return { ok: false, error: "JWT signature invalide" };
  }

  const now = Math.floor(Date.now() / 1000);

  const exp = Number(payload?.exp);
  if (Number.isFinite(exp) && exp <= now) return { ok: false, error: "Session token expire" };

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

  const x = String(req.get("X-Shopify-Session-Token") || "").trim();
  if (x) return x;

  return "";
}

function requireApiAuth(req, res, next) {
  if (!API_AUTH_REQUIRED) return next();

  // Laisse passer l'OAuth install/callback
  if (req.path === "/auth/start" || req.path === "/auth/callback") return next();

  // ✅ config publique (front App Bridge)
  if (req.path === "/public/config") return next();

  // ✅ returnUrl Shopify Billing (apres acceptation abonnement)
  if (req.path === "/billing/return" || req.path === "/api/billing/return") return next();

  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: "unauthorized",
      reason: "missing_session_token",
      hint: "This endpoint must be called from an embedded Shopify app",
    });
  }

  const verified = verifySessionToken(token);
  if (!verified.ok) return apiError(res, 401, verified.error);

  const shop = parseShopFromDestOrIss(verified.payload);
  if (!shop) return apiError(res, 401, "Shop introuvable dans le session token");

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

function safeJson(req, res, fn) {
  const resolvedShop = normalizeShopDomain(String(req?.resolvedShop || getShop(req) || "").trim());

  const handleAuthErrorIfNeeded = (info) => {
    const status = Number(info?.statusCode || 0);
    if (status !== 401) return false;

    // ✅ Token invalide/revoque => purge + renvoi URL de reauth
    if (resolvedShop) {
      try {
        tokenStore?.removeToken?.(resolvedShop);
      } catch {}

      return res.status(401).json({
        error: "reauth_required",
        message: "Shopify authentication required",
        shop: resolvedShop,
        reauthUrl: `/api/auth/start?shop=${encodeURIComponent(resolvedShop)}`,
      });
    }

    return res.status(401).json({
      error: "reauth_required",
      message: "Shopify authentication required",
      reauthUrl: "/api/auth/start",
    });
  };

  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.catch((e) => {
        const info = extractShopifyError(e);
        logEvent("api_error", { shop: resolvedShop || undefined, ...info }, "error");

        if (handleAuthErrorIfNeeded(info)) return;
        return apiError(res, info.statusCode || 500, info.message || "Erreur serveur", info);
      });
    }
    return out;
  } catch (e) {
    const info = extractShopifyError(e);
    logEvent("api_error", { shop: resolvedShop || undefined, ...info }, "error");

    if (handleAuthErrorIfNeeded(info)) return;
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

  // 1) Priorite : settings par boutique
  const settings = (settingsStore?.loadSettings && settingsStore.loadSettings(sh)) || {};
  if (settings.locationId) {
    const id = Number(settings.locationId);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  // 2) ENV locationId (⚠️ uniquement si la boutique == SHOP_NAME)
  const envShop = resolveShopFallback(); // SHOP_NAME normalise
  const envLoc = process.env.SHOPIFY_LOCATION_ID || process.env.LOCATION_ID;

  if (envLoc && envShop && normalizeShopDomain(envShop) === normalizeShopDomain(sh)) {
    const id = Number(envLoc);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  // 3) Sinon : on prend la 1ere location de CETTE boutique (dev/prod)
  const client = shopifyFor(sh);
  const locations = await client.location.list({ limit: 10 });
  const first = Array.isArray(locations) ? locations[0] : null;
  if (!first?.id) throw new Error("Aucune location Shopify trouvee");

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
// ✅ DURCISSEMENT #1 : Anti-spoof multi-shop (API)
// =====================================================
function getShopRequestedByClient(req) {
  const q = String(req.query?.shop || "").trim();
  if (q) return normalizeShopDomain(q);

  const hostQ = String(req.query?.host || "").trim();
  const hostShop = shopFromHostParam(hostQ);
  if (hostShop) return hostShop;

  const h = String(req.get("X-Shopify-Shop-Domain") || "").trim();
  if (h) return normalizeShopDomain(h);

  return "";
}

function enforceAuthShopMatch(req, res, next) {
  const authShop = String(req.shopDomain || "").trim();
  if (!API_AUTH_REQUIRED || !authShop) return next();

  const requested = getShopRequestedByClient(req);
  if (requested && normalizeShopDomain(requested) !== normalizeShopDomain(authShop)) {
    logEvent(
      "shop_spoof_blocked",
      { authShop: normalizeShopDomain(authShop), requestedShop: normalizeShopDomain(requested), path: req.path },
      "warn"
    );
    return apiError(res, 403, "Shop mismatch (anti-spoof)");
  }
  next();
}

// =====================================================
// ✅ DURCISSEMENT #2 : Webhooks shop + HMAC strict
// =====================================================
function getShopFromWebhook(req, payloadObj) {
  const headerShop = String(req.get("X-Shopify-Shop-Domain") || "").trim();
  const payloadShop = String(payloadObj?.myshopify_domain || payloadObj?.shop_domain || payloadObj?.domain || "").trim();
  const shop = normalizeShopDomain(headerShop || payloadShop || "");
  return shop || "";
}

function requireVerifiedWebhook(req, res) {
  const secret = String(process.env.SHOPIFY_WEBHOOK_SECRET || "").trim();
  if (!secret) return true;
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac) return false;
  return verifyShopifyWebhook(req.body, hmac);
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

// ✅ Public config (sans session token)
router.get("/api/public/config", (req, res) => {
  res.json({
    apiKey: SHOPIFY_API_KEY || "",
    apiAuthRequired: API_AUTH_REQUIRED,
  });
});

// ✅ SECURE toutes les routes /api/*
router.use("/api", requireApiAuth);

// ✅ DURCISSEMENT #1 (suite) : anti-spoof APRES auth
router.use("/api", enforceAuthShopMatch);

// ✅ Resout le shop une fois pour toutes (utile pour auto-reauth)
router.use("/api", (req, _res, next) => {
  req.resolvedShop = getShop(req);
  next();
});

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
  safeJson(req, res, async () => {
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

// NOTE: /api/settings endpoint is in settings routes section (line ~1660)

router.get("/api/shopify/locations", (req, res) => {
  safeJson(req, res, async () => {
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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const locationId = Number(req.body?.locationId);
    if (!Number.isFinite(locationId) || locationId <= 0) return apiError(res, 400, "locationId invalide");

    const saved = (settingsStore?.setLocationId && settingsStore.setLocationId(shop, locationId)) || { locationId };

    _cachedLocationIdByShop.delete(String(shop).trim().toLowerCase());
    res.json({ success: true, shop, settings: saved });
  });
});

router.get("/api/server-info", (req, res) => {
  safeJson(req, res, () => {
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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const { sort = "alpha", category = "", q = "" } = req.query;

    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    const categories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    let products = Array.isArray(snapshot.products) ? snapshot.products.slice() : [];

    // Filtre par recherche (nom produit)
    if (q && q.trim()) {
      const search = q.trim().toLowerCase();
      products = products.filter((p) => 
        String(p.name || "").toLowerCase().includes(search)
      );
    }

    // Filtre par categorie
    if (category === "uncategorized") {
      // Produits sans categorie
      products = products.filter((p) => !Array.isArray(p.categoryIds) || p.categoryIds.length === 0);
    } else if (category) {
      // Produits dans une categorie specifique
      products = products.filter((p) => Array.isArray(p.categoryIds) && p.categoryIds.includes(String(category)));
    }

    // Tri
    if (sort === "alpha" || sort === "alpha_asc") {
      products.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" })
      );
    } else if (sort === "alpha_desc") {
      products.sort((a, b) =>
        String(b.name || "").localeCompare(String(a.name || ""), "fr", { sensitivity: "base" })
      );
    } else if (sort === "stock_asc") {
      products.sort((a, b) => (a.totalGrams || 0) - (b.totalGrams || 0));
    } else if (sort === "stock_desc") {
      products.sort((a, b) => (b.totalGrams || 0) - (a.totalGrams || 0));
    } else if (sort === "value_asc") {
      products.sort((a, b) => 
        ((a.totalGrams || 0) * (a.averageCostPerGram || 0)) - ((b.totalGrams || 0) * (b.averageCostPerGram || 0))
      );
    } else if (sort === "value_desc") {
      products.sort((a, b) => 
        ((b.totalGrams || 0) * (b.averageCostPerGram || 0)) - ((a.totalGrams || 0) * (a.averageCostPerGram || 0))
      );
    }

    // Ajouter compteur produits par categorie
    const categoriesWithCount = categories.map((cat) => {
      const allProducts = snapshot.products || [];
      const count = allProducts.filter((p) => 
        Array.isArray(p.categoryIds) && p.categoryIds.includes(cat.id)
      ).length;
      return { ...cat, productCount: count };
    });

    // Compter produits sans categorie
    const allProducts = snapshot.products || [];
    const uncategorizedCount = allProducts.filter((p) => 
      !Array.isArray(p.categoryIds) || p.categoryIds.length === 0
    ).length;

    res.json({ 
      products, 
      categories: categoriesWithCount,
      meta: {
        total: products.length,
        uncategorizedCount,
        sort,
        category: category || "all",
        q: q || ""
      }
    });
  });
});

// ✅ Valeur totale du stock - STANDARD+ ONLY
router.get("/api/stock/value", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_stock_value");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
          feature: "stock_value",
        });
      }
    }

    if (typeof stock.calculateTotalStockValue !== "function") {
      return apiError(res, 500, "calculateTotalStockValue non disponible");
    }

    const result = stock.calculateTotalStockValue(shop);
    res.json(result);
  });
});

// ✅ Stats par categorie - STANDARD+ ONLY
router.get("/api/stats/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_categories");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
          feature: "categories",
        });
      }
    }

    if (typeof stock.getCategoryStats !== "function") {
      return apiError(res, 500, "getCategoryStats non disponible");
    }

    const result = stock.getCategoryStats(shop);
    res.json(result);
  });
});

router.get("/api/stock.csv", (req, res) => {
  safeJson(req, res, () => {
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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ✅ Verifier le plan (categories = Standard+)
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_categories");
      if (!check.allowed) {
        // Pour la liste, on retourne un tableau vide avec un flag
        return res.json({ 
          categories: [], 
          planLimited: true,
          message: check.reason,
          upgrade: check.upgrade,
        });
      }
    }

    const categories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    res.json({ categories });
  });
});

router.post("/api/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "manage_categories");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
          feature: "categories",
        });
      }
    }

    const name = String(req.body?.name ?? req.body?.categoryName ?? "").trim();
    if (!name) return apiError(res, 400, "Nom de categorie invalide");

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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const id = String(req.params.id);
    const name = String(req.body?.name || "").trim();
    if (!name) return apiError(res, 400, "Nom invalide");

    const updated = catalogStore.renameCategory(shop, id, name);
    if (movementStore.addMovement) {
      movementStore.addMovement({ source: "category_rename", gramsDelta: 0, meta: { categoryId: id, name }, shop }, shop);
    }

    res.json({ success: true, category: updated });
  });
});

router.delete("/api/categories/:id", (req, res) => {
  safeJson(req, res, () => {
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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const limit = Math.min(Number(req.query.limit || 200), 2000);
    let days = Math.min(Math.max(Number(req.query.days || 7), 1), 365);

    // ✅ Appliquer la limite de jours selon le plan
    let daysLimited = false;
    if (planManager) {
      const maxDays = planManager.applyMovementDaysLimit(shop, days);
      if (maxDays < days) {
        daysLimited = true;
        days = maxDays;
      }
    }

    const rows = movementStore.listMovements ? movementStore.listMovements({ shop, days, limit }) : [];
    res.json({ 
      count: rows.length, 
      movements: rows,
      data: rows,
      daysLimited,
      maxDays: days,
    });
  });
});

router.get("/api/movements.csv", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ✅ Verifier le plan pour export avance
    if (planManager) {
      const check = planManager.checkLimit(shop, "advanced_export");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
          feature: "advanced_export",
        });
      }
    }

    const limit = Math.min(Number(req.query.limit || 2000), 10000);
    let days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    // Appliquer la limite de jours
    if (planManager) {
      days = planManager.applyMovementDaysLimit(shop, days);
    }

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

// stub suppression mouvements
router.delete("/api/movements/:id", (req, res) => {
  safeJson(req, res, () => {
    return apiError(res, 501, "Suppression de mouvements non encore implementee dans movementStore.");
  });
});

// âÅ“â€¦ NOUVEAU : Détail produit avec variantes et stats
router.get("/api/products/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId || "");
    if (!productId) return apiError(res, 400, "productId manquant");

    // Récupérer le snapshot du produit
    const product = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (!product) return apiError(res, 404, "Produit introuvable");

    // Récupérer les catégories
    const allCategories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    const productCategories = allCategories.filter(c => (product.categoryIds || []).includes(c.id));

    // Récupérer les variantes avec calcul des stats
    const storeObj = stock.PRODUCT_CONFIG_BY_SHOP?.get(shop);
    const cfg = storeObj ? storeObj[productId] : null;
    const variants = cfg?.variants || {};
    const totalGrams = product.totalGrams || 0;

    // Calculer les stats par variante
    const variantStats = [];
    let totalCanSell = 0;

    for (const [key, v] of Object.entries(variants)) {
      const gramsPerUnit = Number(v?.gramsPerUnit) || 0;
      const inventoryItemId = v?.inventoryItemId || null;
      const canSell = gramsPerUnit > 0 ? Math.floor(totalGrams / gramsPerUnit) : 0;
      const gramsEquivalent = canSell * gramsPerUnit;

      totalCanSell += canSell;

      variantStats.push({
        key,
        gramsPerUnit,
        inventoryItemId,
        canSell,
        gramsEquivalent,
      });
    }

    // Calcul du pourcentage (basé sur les unités vendables)
    for (const vs of variantStats) {
      vs.shareByUnits = totalCanSell > 0 ? Math.round((vs.canSell / totalCanSell) * 100 * 100) / 100 : 0;
    }

    // Trier par gramsPerUnit croissant
    variantStats.sort((a, b) => a.gramsPerUnit - b.gramsPerUnit);

    // Déterminer le statut stock
    let stockStatus = "good";
    let stockLabel = "OK";
    if (totalGrams <= 0) {
      stockStatus = "critical";
      stockLabel = "Rupture";
    } else if (totalGrams < 50) {
      stockStatus = "critical";
      stockLabel = "Critique";
    } else if (totalGrams < 200) {
      stockStatus = "low";
      stockLabel = "Bas";
    }

    // Valeur du stock
    const stockValue = totalGrams * (product.averageCostPerGram || 0);

    res.json({
      product: {
        productId: product.productId,
        name: product.name,
        totalGrams,
        averageCostPerGram: product.averageCostPerGram || 0,
        stockValue: Math.round(stockValue * 100) / 100,
        stockStatus,
        stockLabel,
        categoryIds: product.categoryIds || [],
        categories: productCategories,
      },
      variantStats,
      summary: {
        variantCount: variantStats.length,
        totalCanSellUnits: totalCanSell,
        smallestVariant: variantStats.length > 0 ? variantStats[0].gramsPerUnit : null,
        largestVariant: variantStats.length > 0 ? variantStats[variantStats.length - 1].gramsPerUnit : null,
      },
    });
  });
});

router.get("/api/products/:productId/history", (req, res) => {
  safeJson(req, res, () => {
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
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);
    const gramsDelta = Number(req.body?.gramsDelta);
    const purchasePricePerGram = Number(req.body?.purchasePricePerGram || 0);
    
    // Récupérer les infos du profil
    const profileId = req.body?.profileId || null;
    const profileName = req.body?.profileName || "User";
    const profileColor = req.body?.profileColor || "#6366f1";

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
      logEvent("inventory_push_error", { shop, productId, ...extractShopifyError(e) }, "error");
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
          profileId,
          profileName,
          profileColor,
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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);
    const averageCostPerGram = Number(req.body?.averageCostPerGram);

    if (!Number.isFinite(averageCostPerGram) || averageCostPerGram < 0) {
      return apiError(res, 400, "averageCostPerGram invalide (ex: 4.50)");
    }

    // product config store (Map shop -> object)
    const storeObj = stock.PRODUCT_CONFIG_BY_SHOP?.get(shop);
    if (!storeObj) return apiError(res, 500, "Store introuvable");

    const cfg = storeObj[productId];
    if (!cfg) return apiError(res, 404, "Produit introuvable");

    const oldCost = cfg.averageCostPerGram || 0;
    cfg.averageCostPerGram = averageCostPerGram;

    // persist (via stockState directly, comme tu avais)
    const stockStateMod = require("./stockState");
    const saveState = stockStateMod?.saveState;
    if (saveState) {
      const products = {};
      for (const [pid, p] of Object.entries(storeObj)) {
        products[pid] = {
          name: p.name,
          totalGrams: p.totalGrams,
          averageCostPerGram: p.averageCostPerGram || 0,
          categoryIds: p.categoryIds || [],
          variants: p.variants || {},
        };
      }
      saveState(shop, { version: 2, updatedAt: new Date().toISOString(), products });
    }

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "average_cost_updated",
          productId,
          productName: cfg.name,
          gramsDelta: 0,
          meta: { oldAverageCost: oldCost, newAverageCost: averageCostPerGram },
          shop,
        },
        shop
      );
    }

    logEvent("average_cost_manual_update", {
      shop,
      productId,
      oldCost: Number(oldCost).toFixed(2),
      newCost: Number(averageCostPerGram).toFixed(2),
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
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(String) : [];

    if (typeof stock.setProductCategories !== "function") {
      return apiError(res, 500, "stock.setProductCategories introuvable");
    }

    const ok = stock.setProductCategories(shop, productId, categoryIds);
    if (!ok) return apiError(res, 404, "Produit introuvable (non configure)");

    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "product_set_categories", productId, gramsDelta: 0, meta: { categoryIds }, shop },
        shop
      );
    }

    res.json({ success: true, productId, categoryIds });
  });
});

// ✅ Creer un produit manuellement (sans import Shopify)
router.post("/api/products", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const name = String(req.body?.name || "").trim();
    const totalGrams = Number(req.body?.totalGrams || 0);
    const averageCostPerGram = Number(req.body?.averageCostPerGram || 0);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];

    if (!name) return apiError(res, 400, "Nom du produit requis");

    // ✅ Verifier le plan (limite de produits)
    if (planManager) {
      const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const currentCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;
      const checkProduct = planManager.checkLimit(shop, "add_product", { currentProductCount: currentCount });
      if (!checkProduct.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: checkProduct.reason,
          upgrade: checkProduct.upgrade,
          feature: "max_products",
          limit: checkProduct.limit,
          current: checkProduct.current,
        });
      }
    }

    // Generer un ID unique pour le produit manuel
    const productId = `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (typeof stock.upsertImportedProductConfig !== "function") {
      return apiError(res, 500, "stock.upsertImportedProductConfig introuvable");
    }

    // Creer le produit avec une variante par defaut (1g)
    const created = stock.upsertImportedProductConfig(shop, {
      productId,
      name,
      variants: {
        "1": { gramsPerUnit: 1, inventoryItemId: null }
      },
      categoryIds,
      totalGrams,
      averageCostPerGram,
    });

    if (movementStore.addMovement) {
      movementStore.addMovement(
        {
          source: "product_created_manual",
          productId,
          productName: name,
          gramsDelta: totalGrams,
          purchasePricePerGram: averageCostPerGram > 0 ? averageCostPerGram : undefined,
          totalAfter: totalGrams,
          shop,
        },
        shop
      );
    }

    logEvent("product_created_manual", { shop, productId, name }, "info");

    res.status(201).json({ success: true, product: created });
  });
});

router.delete("/api/products/:productId", (req, res) => {
  safeJson(req, res, () => {
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
  safeJson(req, res, async () => {
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
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ✅ Verifier le plan (import Shopify = Standard+)
    if (planManager) {
      const checkImport = planManager.checkLimit(shop, "import_shopify");
      if (!checkImport.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: checkImport.reason,
          upgrade: checkImport.upgrade,
          feature: "import_shopify",
        });
      }

      // Verifier aussi la limite de produits
      const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const currentCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;
      const checkProduct = planManager.checkLimit(shop, "add_product", { currentProductCount: currentCount });
      if (!checkProduct.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: checkProduct.reason,
          upgrade: checkProduct.upgrade,
          feature: "max_products",
          limit: checkProduct.limit,
          current: checkProduct.current,
        });
      }
    }

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
      variants[String(grams)] = { 
        gramsPerUnit: grams, 
        inventoryItemId: Number(v.inventory_item_id),
        variantId: String(v.id), // NOUVEAU: stocker le variantId Shopify
      };
    }

    if (!Object.keys(variants).length) {
      return apiError(res, 400, "Aucune variante avec grammage detecte (option/title/sku).");
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
  safeJson(req, res, async () => {
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
      logEvent("inventory_push_error", { shop, productId, ...extractShopifyError(e) }, "error");
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

    res.json({ success: true, product: updated, cmpUpdated: purchasePricePerGram > 0 });
  });
});

router.post("/api/test-order", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const grams = Number(req.body?.grams || 10);
    let productId = String(req.body?.productId || "");

    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide");

    if (!productId) {
      const snap = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const first = Array.isArray(snap.products) ? snap.products[0] : null;
      if (!first?.productId) return apiError(res, 400, "Aucun produit configure pour test");
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
  safeJson(req, res, () => {
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
  safeJson(req, res, async () => {
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

    const doFetch = typeof fetch === "function" ? fetch : null;
    if (!doFetch) return apiError(res, 500, "fetch non disponible (Node < 18). Installe node-fetch ou upgrade Node.");

    const tokenRes = await doFetch(`https://${shop}/admin/oauth/access_token`, {
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
      return apiError(res, 500, "Echec echange token", { status: tokenRes.status, body: tokenJson });
    }

    tokenStore.saveToken(shop, tokenJson.access_token, { scope: tokenJson.scope });

    res.type("html").send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>OAuth Success</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 40px; text-align: center; background: #1a1a2e; color: #fff; }
          .success { color: #10b981; font-size: 48px; margin-bottom: 16px; }
          h2 { margin: 0 0 8px 0; }
          p { color: #a0a0a0; margin: 8px 0; }
          .shop { color: #6c5ce7; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="success">&#10003;</div>
        <h2 id="title">Connection successful</h2>
        <p><span id="tokenText">Token saved for</span> <span class="shop">${shop}</span></p>
        <p id="closeText">This page will close automatically...</p>
        <script>
          var translations = {
            en: { title: "Connection successful", tokenText: "Token saved for", closeText: "This page will close automatically..." },
            fr: { title: "Connexion reussie", tokenText: "Token enregistre pour", closeText: "Cette page va se fermer automatiquement..." },
            de: { title: "Verbindung erfolgreich", tokenText: "Token gespeichert fur", closeText: "Diese Seite wird automatisch geschlossen..." },
            es: { title: "Conexion exitosa", tokenText: "Token guardado para", closeText: "Esta pagina se cerrara automaticamente..." },
            it: { title: "Connessione riuscita", tokenText: "Token salvato per", closeText: "Questa pagina si chiudera automaticamente..." }
          };
          var lang = (navigator.language || "en").substring(0, 2);
          var t = translations[lang] || translations.en;
          document.getElementById("title").textContent = t.title;
          document.getElementById("tokenText").textContent = t.tokenText;
          document.getElementById("closeText").textContent = t.closeText;
          if (window.opener) window.opener.location.reload();
          setTimeout(function() { window.close(); }, 1500);
        </script>
      </body>
      </html>
    `);
  });
});

// =====================================================
// SETTINGS ROUTES ✅ NOUVEAU (Parametres avances)
// =====================================================

// Recuperer tous les parametres
router.get("/api/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const settings = settingsManager.loadSettings(shop);
    const options = settingsManager.SETTING_OPTIONS;
    res.json({ settings, options });
  });
});

// Recuperer une section
router.get("/api/settings/:section", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const section = String(req.params.section);
    const settings = settingsManager.loadSettings(shop);
    if (!settings[section]) return apiError(res, 404, `Section '${section}' non trouvee`);
    res.json({ section, settings: settings[section] });
  });
});

// Mettre à jour une section
router.put("/api/settings/:section", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const currentSettings = settingsManager.loadSettings(shop);
    if (currentSettings.security?.readOnlyMode) {
      return res.status(403).json({ error: "readonly_mode", message: "Mode lecture seule active" });
    }

    const section = String(req.params.section);
    try {
      const updated = settingsManager.updateSettings(shop, section, req.body);
      logEvent("settings_updated", { shop, section }, "info");
      res.json({ success: true, section, settings: updated[section] });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Reset parametres
router.post("/api/settings/reset", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const section = req.body?.section || null;
    try {
      const settings = settingsManager.resetSettings(shop, section);
      logEvent("settings_reset", { shop, section: section || "all" }, "info");
      res.json({ success: true, settings });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Export config (backup)
router.get("/api/settings/backup", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const config = settingsManager.exportConfig(shop);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="config-backup.json"`);
    res.json(config);
  });
});

// Import config (restore)
router.post("/api/settings/restore", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const config = req.body?.config;
    const merge = req.body?.merge === true;
    if (!config) return apiError(res, 400, "Configuration manquante");

    try {
      const settings = settingsManager.importConfig(shop, config, { merge });
      logEvent("settings_restored", { shop, merge }, "info");
      res.json({ success: true, settings });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Diagnostic
router.get("/api/settings/diagnostic", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    let shopifyStatus = "unknown";
    try {
      const client = shopifyFor(shop);
      const shopInfo = await client.shop.get();
      shopifyStatus = shopInfo?.id ? "connected" : "error";
    } catch (e) {
      shopifyStatus = "error";
    }

    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;

    let planInfo = { planId: "free", limits: {} };
    if (planManager) {
      planInfo = planManager.getShopPlan(shop);
    }

    const settings = settingsManager ? settingsManager.loadSettings(shop) : {};

    res.json({
      status: "ok",
      shop: shop,
      shopify: { status: shopifyStatus },
      data: { 
        productCount,
        settingsVersion: settings._meta?.version,
        lastUpdated: settings._meta?.updatedAt,
      },
      plan: { id: planInfo.planId, limits: planInfo.limits },
    });
  });
});

// Support bundle
router.get("/api/settings/support-bundle", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const bundle = settingsManager.generateSupportBundle(shop);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="support-bundle.json"`);
    res.json(bundle);
  });
});

// =====================================================
// USER PROFILES ROUTES
// =====================================================

// Liste des profils
router.get("/api/profiles", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const data = userProfileStore.loadProfiles(shop);
    res.json({
      profiles: data.profiles || [],
      activeProfileId: data.activeProfileId,
      settings: data.settings || {}
    });
  });
});

// Profil actif
router.get("/api/profiles/active", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const profile = userProfileStore.getActiveProfile(shop);
    res.json({ profile });
  });
});

// Créer un profil
router.post("/api/profiles", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const { name, role, color } = req.body || {};
    if (!name) return apiError(res, 400, "Nom requis");

    const profile = userProfileStore.createProfile(shop, { name, role, color });
    res.json({ success: true, profile });
  });
});

// Mettre à jour un profil
router.put("/api/profiles/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const { id } = req.params;
    const updates = req.body || {};

    const profile = userProfileStore.updateProfile(shop, id, updates);
    if (!profile) return apiError(res, 404, "Profil non trouve");

    res.json({ success: true, profile });
  });
});

// Supprimer un profil
router.delete("/api/profiles/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const { id } = req.params;
    const result = userProfileStore.deleteProfile(shop, id);

    if (!result.success) return apiError(res, 400, result.error || "Impossible de supprimer");
    res.json({ success: true });
  });
});

// Changer le profil actif
router.post("/api/profiles/:id/activate", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const { id } = req.params;
    const result = userProfileStore.setActiveProfile(shop, id);

    if (!result.success) return apiError(res, 404, result.error || "Profil non trouve");
    res.json({ success: true, profile: result.profile });
  });
});

// Mettre à jour les paramètres des profils
router.put("/api/profiles/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!userProfileStore) return apiError(res, 500, "UserProfileStore non disponible");

    const settings = req.body || {};
    const updated = userProfileStore.updateSettings(shop, settings);
    res.json({ success: true, settings: updated });
  });
});

// =====================================================
// PLAN ROUTES ✅ Billing Shopify (AppSubscription)
// =====================================================

// Helper: map planId -> billing config
function getBillingConfigForPlan(planId, interval = "monthly") {
  const pid = String(planId || "").toLowerCase();
  if (!planManager || !planManager.PLANS || !planManager.PLANS[pid]) return null;

  const p = planManager.PLANS[pid];

  // Free = pas de billing
  if (pid === "free" || Number(p.price || 0) <= 0) return null;

  const isYearly = String(interval || "monthly").toLowerCase() === "yearly";
  const price = isYearly ? Number(p.priceYearly || 0) : Number(p.price || 0);

  return {
    name: String(p.name || pid),
    price,
    currencyCode: String(p.currency || "EUR").toUpperCase(),
    interval: isYearly ? "ANNUAL" : "EVERY_30_DAYS",
  };
}

function buildBillingReturnUrl(shop, planId, interval) {
  const base = String(process.env.RENDER_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("RENDER_PUBLIC_URL manquant pour Billing returnUrl");
  const q = new URLSearchParams({
    shop: normalizeShopDomain(shop),
    planId: String(planId || "").toLowerCase(),
    interval: String(interval || "monthly").toLowerCase(),
  });
  return `${base}/api/billing/return?${q.toString()}`;
}

function isBillingTestMode() {
  // en prod => false par defaut
  const v = String(process.env.SHOPIFY_BILLING_TEST || "").trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return process.env.NODE_ENV !== "production";
}

// Info sur le plan actuel
router.get("/api/plan", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    console.log(`[Plan] API /api/plan called - shop: "${shop}"`);

    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    // Verifier si c'est un nouveau shop qui merite un trial Starter
    const currentPlan = planManager.getShopPlan(shop);
    
    // Si pas d'abonnement, pas de trial en cours, et effectivePlan = free
    // => Demarrer le trial Starter automatique de 7 jours
    if (currentPlan.effectivePlanId === "free" && 
        !currentPlan.trialPlanId && 
        !currentPlan.trialEndsAt &&
        (!currentPlan.subscription || currentPlan.subscription.status !== "active")) {
      console.log(`[Trial] Starting automatic Starter trial for ${shop}`);
      planManager.startStarterTrial(shop);
    }

    // Compter les produits actuels
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;

    const planInfo = planManager.getPlanInfoForUI(shop, productCount);
    console.log(`[Plan] Result: effectivePlan=${planInfo.current?.planId}, trial=${planInfo.trial?.active}, daysLeft=${planInfo.trial?.daysLeft}`);
    res.json(planInfo);
  });
});

// Liste des plans disponibles
router.get("/api/plans", (req, res) => {
  safeJson(req, res, () => {
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");
    res.json({ plans: Object.values(planManager.PLANS) });
  });
});

// ✅ Retour Billing Shopify (apres acceptation abonnement)
// IMPORTANT: cette route passe SANS session token (bypass dans requireApiAuth)
router.get("/api/billing/return", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    const planId = String(req.query?.planId || "").toLowerCase();
    const interval = String(req.query?.interval || "monthly").toLowerCase();

    if (!shop) return apiError(res, 400, "Shop introuvable (billing return)");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");
    if (!planId || !planManager.PLANS[planId]) return apiError(res, 400, `planId invalide: ${planId}`);

    // Si bypass => on fixe direct (pas besoin de billing)
    const bypassPlan = planManager.getBypassPlan ? planManager.getBypassPlan(shop) : null;
    if (bypassPlan) {
      const result = planManager.setShopPlan(shop, bypassPlan, {
        id: `bypass_${Date.now()}`,
        status: "active",
        startedAt: new Date().toISOString(),
        interval: "lifetime",
      });
      return res.type("html").send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Plan Active</title>
        <style>body{font-family:system-ui;padding:40px;text-align:center;background:#1a1a2e;color:#fff}.success{color:#10b981;font-size:48px}h2{margin:16px 0 8px}p{color:#a0a0a0}.shop{color:#6c5ce7;font-weight:bold}</style>
        </head><body>
          <div class="success">&#10003;</div>
          <h2 id="title">Plan activated (bypass)</h2>
          <p><span id="shopText">Store</span>: <span class="shop">${shop}</span></p>
          <p>Plan: <b>${String(bypassPlan).toUpperCase()}</b></p>
          <p id="closeText">This page will close automatically...</p>
          <script>
            var translations = {
              en: { title: "Plan activated (bypass)", shopText: "Store", closeText: "This page will close automatically..." },
              fr: { title: "Plan active (bypass)", shopText: "Boutique", closeText: "Cette page va se fermer automatiquement..." },
              de: { title: "Plan aktiviert (bypass)", shopText: "Shop", closeText: "Diese Seite wird automatisch geschlossen..." },
              es: { title: "Plan activado (bypass)", shopText: "Tienda", closeText: "Esta pagina se cerrara automaticamente..." },
              it: { title: "Piano attivato (bypass)", shopText: "Negozio", closeText: "Questa pagina si chiudera automaticamente..." }
            };
            var lang = (navigator.language || "en").substring(0, 2);
            var t = translations[lang] || translations.en;
            document.getElementById("title").textContent = t.title;
            document.getElementById("shopText").textContent = t.shopText;
            document.getElementById("closeText").textContent = t.closeText;
            if(window.opener)window.opener.location.reload();
            setTimeout(function(){window.close()},1500);
          </script>
        </body></html>
      `);
    }

    // Verifier que Shopify a bien un abonnement actif
    const subs = await getActiveAppSubscriptions(shop);

    // On prend le plus recent (souvent 1 seul)
    const chosen = Array.isArray(subs) && subs.length ? subs[0] : null;

    if (!chosen?.id) {
      return res.type("html").send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Subscription not found</title>
        <style>body{font-family:system-ui;padding:40px;text-align:center;background:#1a1a2e;color:#fff}.error{color:#ef4444;font-size:48px}h2{margin:16px 0 8px}p{color:#a0a0a0}.shop{color:#6c5ce7;font-weight:bold}</style>
        </head><body>
          <div class="error">&#10007;</div>
          <h2 id="title">Subscription not found</h2>
          <p><span id="shopText">Store</span>: <span class="shop">${shop}</span></p>
          <p id="errorText">No active subscription found on Shopify.</p>
          <p id="retryText">Return to the app and try again.</p>
          <script>
            var translations = {
              en: { title: "Subscription not found", shopText: "Store", errorText: "No active subscription found on Shopify.", retryText: "Return to the app and try again." },
              fr: { title: "Abonnement non detecte", shopText: "Boutique", errorText: "Aucun abonnement actif trouve cote Shopify.", retryText: "Retournez dans l'app et relancez l'upgrade." },
              de: { title: "Abonnement nicht gefunden", shopText: "Shop", errorText: "Kein aktives Abonnement bei Shopify gefunden.", retryText: "Kehren Sie zur App zuruck und versuchen Sie es erneut." },
              es: { title: "Suscripcion no encontrada", shopText: "Tienda", errorText: "No se encontro suscripcion activa en Shopify.", retryText: "Vuelva a la app e intente de nuevo." },
              it: { title: "Abbonamento non trovato", shopText: "Negozio", errorText: "Nessun abbonamento attivo trovato su Shopify.", retryText: "Torna all'app e riprova." }
            };
            var lang = (navigator.language || "en").substring(0, 2);
            var t = translations[lang] || translations.en;
            document.getElementById("title").textContent = t.title;
            document.getElementById("shopText").textContent = t.shopText;
            document.getElementById("errorText").textContent = t.errorText;
            document.getElementById("retryText").textContent = t.retryText;
          </script>
        </body></html>
      `);
    }

    // Stocker localement (source de verite app = plan.json)
    const result = planManager.setShopPlan(shop, planId, {
      id: chosen.id,
      status: String(chosen.status || "ACTIVE").toLowerCase(), // "active" / "trialing" etc (best effort)
      startedAt: chosen.createdAt || new Date().toISOString(),
      expiresAt: null,
      interval: interval === "yearly" ? "annual" : "monthly",
    });

    logEvent("billing_confirmed", { shop, planId, subId: chosen.id, status: chosen.status }, "info");

    return res.type("html").send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Subscription activated</title>
      <style>body{font-family:system-ui;padding:40px;text-align:center;background:#1a1a2e;color:#fff}.success{color:#10b981;font-size:48px}h2{margin:16px 0 8px}p{color:#a0a0a0}.shop{color:#6c5ce7;font-weight:bold}</style>
      </head><body>
        <div class="success">&#10003;</div>
        <h2 id="title">Subscription activated</h2>
        <p><span id="shopText">Store</span>: <span class="shop">${shop}</span></p>
        <p>Plan: <b>${planId.toUpperCase()}</b></p>
        <p><span id="statusText">Status</span>: <b>${String(chosen.status || "")}</b></p>
        <p id="closeText">This page will close automatically...</p>
        <script>
          var translations = {
            en: { title: "Subscription activated", shopText: "Store", statusText: "Status", closeText: "This page will close automatically..." },
            fr: { title: "Abonnement active", shopText: "Boutique", statusText: "Statut", closeText: "Cette page va se fermer automatiquement..." },
            de: { title: "Abonnement aktiviert", shopText: "Shop", statusText: "Status", closeText: "Diese Seite wird automatisch geschlossen..." },
            es: { title: "Suscripcion activada", shopText: "Tienda", statusText: "Estado", closeText: "Esta pagina se cerrara automaticamente..." },
            it: { title: "Abbonamento attivato", shopText: "Negozio", statusText: "Stato", closeText: "Questa pagina si chiudera automaticamente..." }
          };
          var lang = (navigator.language || "en").substring(0, 2);
          var t = translations[lang] || translations.en;
          document.getElementById("title").textContent = t.title;
          document.getElementById("shopText").textContent = t.shopText;
          document.getElementById("statusText").textContent = t.statusText;
          document.getElementById("closeText").textContent = t.closeText;
          if(window.opener)window.opener.location.reload();
          setTimeout(function(){window.close()},1500);
        </script>
      </body></html>
    `);
  });
});

// Upgrade: cree un abonnement Shopify et renvoie confirmationUrl
router.post("/api/plan/upgrade", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    const planId = String(req.body?.planId || "").toLowerCase();
    const interval = String(req.body?.interval || "monthly").toLowerCase(); // "monthly" | "yearly"

    if (!planManager.PLANS[planId]) return apiError(res, 400, `Plan inconnu: ${planId}`);
    if (planId === "free") {
      // Si l'utilisateur downgrade vers free => passe par cancel
      return apiError(res, 400, "Pour revenir en Free, utilise /api/plan/cancel");
    }

    // ✅ Bypass billing => on fixe direct sans Shopify
    const bypassPlan = planManager.getBypassPlan ? planManager.getBypassPlan(shop) : null;
    if (bypassPlan) {
      const result = planManager.setShopPlan(shop, bypassPlan, {
        id: `bypass_${Date.now()}`,
        status: "active",
        startedAt: new Date().toISOString(),
        interval: "lifetime",
      });
      logEvent("plan_upgraded_bypass", { shop, planId: bypassPlan }, "info");
      return res.json({ success: true, bypass: true, ...result });
    }

    // ✅ Si dejà un abonnement actif Shopify => on evite doublon
    const existingSubs = await getActiveAppSubscriptions(shop);
    if (Array.isArray(existingSubs) && existingSubs.length) {
      return res.status(409).json({
        error: "billing_already_active",
        message: "Un abonnement Shopify est dejà actif pour cette boutique. Annule avant de recreer.",
        subscriptions: existingSubs.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      });
    }

    const billingCfg = getBillingConfigForPlan(planId, interval);
    if (!billingCfg) return apiError(res, 400, "Plan non billable (config)");

    const returnUrl = buildBillingReturnUrl(shop, planId, interval);

    // Trial: 14 jours par defaut (desactivable)
    const skipTrial = req.body?.skipTrial === true;
    const trialDays = skipTrial ? 0 : 14;

    const created = await createAppSubscription(shop, {
      name: billingCfg.name,
      returnUrl,
      price: billingCfg.price,
      currencyCode: billingCfg.currencyCode,
      interval: billingCfg.interval,
      trialDays,
      test: isBillingTestMode(),
    });

    if (created.userErrors && created.userErrors.length) {
      return res.status(400).json({
        error: "billing_user_errors",
        message: "Shopify a refuse la creation d'abonnement",
        userErrors: created.userErrors,
      });
    }

    if (!created.confirmationUrl) {
      return res.status(500).json({
        error: "billing_no_confirmation_url",
        message: "Aucune confirmationUrl retournee par Shopify",
      });
    }

    logEvent("billing_subscription_created", { shop, planId, interval, trialDays }, "info");

    // IMPORTANT: le front doit ouvrir confirmationUrl (top level)
    return res.json({
      success: true,
      planId,
      interval,
      trialDays,
      confirmationUrl: created.confirmationUrl,
      returnUrl,
    });
  });
});

// ✅ Cancel: annule l'abonnement Shopify + downgrade local en Free
router.post("/api/plan/cancel", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    // Bypass => on ne cancel pas Shopify (il n'y a rien), et ca restera bypass
    const bypassPlan = planManager.getBypassPlan ? planManager.getBypassPlan(shop) : null;
    if (bypassPlan) {
      const current = planManager.getShopPlan(shop);
      return res.json({
        success: true,
        bypass: true,
        message: "Boutique en bypass billing: annulation Shopify non applicable.",
        current,
      });
    }

    const subs = await getActiveAppSubscriptions(shop);
    const sub = Array.isArray(subs) && subs.length ? subs[0] : null;

    // S'il n'y a rien cote Shopify, on downgrade quand meme localement
    if (!sub?.id) {
      const result = planManager.cancelSubscription(shop);
      logEvent("plan_cancelled_no_shopify_sub", { shop }, "warn");
      return res.json({ success: true, shopifyCancelled: false, ...result });
    }

    const cancelled = await cancelAppSubscription(shop, sub.id, { prorate: true, reason: "OTHER" });

    if (cancelled.userErrors && cancelled.userErrors.length) {
      return res.status(400).json({
        error: "billing_cancel_user_errors",
        message: "Shopify a refuse l'annulation",
        userErrors: cancelled.userErrors,
      });
    }

    const result = planManager.cancelSubscription(shop);

    logEvent("plan_cancelled", { shop, subId: sub.id }, "info");
    return res.json({
      success: true,
      shopifyCancelled: true,
      cancelled: { id: cancelled.cancelledId, status: cancelled.status },
      ...result,
    });
  });
});

// Verifier une limite specifique
router.get("/api/plan/check/:action", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    const action = String(req.params.action);

    // Context pour certaines verifications
    const context = {};
    if (action === "add_product") {
      const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      context.currentProductCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;
    }
    if (action === "view_movements") {
      context.days = Number(req.query.days || 7);
    }

    const result = planManager.checkLimit(shop, action, context);
    res.json(result);
  });
});

// =====================================================
// ANALYTICS ROUTES ✅ NOUVEAU
// =====================================================

// Summary (KPIs globaux) - ✅ PREMIUM ONLY
router.get("/api/analytics/summary", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_analytics");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
          feature: "analytics",
        });
      }
    }

    const from = req.query.from || null;
    const to = req.query.to || null;

    const summary = analyticsManager.calculateSummary(shop, from, to);
    res.json(summary);
  });
});

// Timeseries (donnees graphiques) - ✅ PREMIUM ONLY
router.get("/api/analytics/timeseries", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_analytics");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
        });
      }
    }

    const from = req.query.from || null;
    const to = req.query.to || null;
    const bucket = String(req.query.bucket || "day");

    const data = analyticsManager.calculateTimeseries(shop, from, to, bucket);
    res.json(data);
  });
});

// Liste des commandes recentes - ✅ PREMIUM ONLY
router.get("/api/analytics/orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_analytics");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
        });
      }
    }

    const from = req.query.from || null;
    const to = req.query.to || null;
    const limit = Math.min(Number(req.query.limit || 50), 500);

    const data = analyticsManager.listRecentOrders(shop, from, to, limit);
    res.json(data);
  });
});

// Top produits - ✅ PREMIUM ONLY
router.get("/api/analytics/products/top", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ✅ Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_analytics");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
        });
      }
    }

    const from = req.query.from || null;
    const to = req.query.to || null;
    const by = String(req.query.by || "revenue");
    const limit = Math.min(Number(req.query.limit || 10), 100);

    const data = analyticsManager.getTopProducts(shop, from, to, { by, limit });
    res.json(data);
  });
});

// Stats d'un produit specifique
router.get("/api/analytics/products/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    const productId = String(req.params.productId);
    const from = req.query.from || null;
    const to = req.query.to || null;

    const data = analyticsManager.calculateProductStats(shop, productId, from, to);
    res.json(data);
  });
});

// Stats par categorie
router.get("/api/analytics/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    const from = req.query.from || null;
    const to = req.query.to || null;

    const data = analyticsManager.getCategoryAnalytics(shop, from, to);
    res.json(data);
  });
});

// Export CSV
router.get("/api/analytics/export.csv", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const from = req.query.from || null;
    const to = req.query.to || null;
    const limit = Math.min(Number(req.query.limit || 10000), 50000);

    const sales = analyticsStore.listSales({ shop, from, to, limit });
    const csv = analyticsStore.toCSV(sales);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${from || "all"}-${to || "now"}.csv"`);
    res.send(csv);
  });
});

// Export JSON
router.get("/api/analytics/export.json", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const from = req.query.from || null;
    const to = req.query.to || null;
    const limit = Math.min(Number(req.query.limit || 10000), 50000);

    const sales = analyticsStore.listSales({ shop, from, to, limit });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${from || "all"}-${to || "now"}.json"`);
    res.json({ sales, count: sales.length, period: { from, to } });
  });
});

// ============================================
// ANALYTICS DASHBOARD PRO - Endpoint complet
// ============================================
router.get("/api/analytics/dashboard", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Verifier le plan PRO
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_analytics");
      if (!check.allowed) {
        return res.status(403).json({
          error: "plan_limit",
          message: check.reason,
          upgrade: check.upgrade,
          feature: "analytics",
        });
      }
    }

    const period = req.query.period || "30"; // jours
    const now = new Date();
    const daysAgo = parseInt(period, 10) || 30;
    const from = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);

    // 1. Recuperer le snapshot stock
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];
    const categories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];

    // 2. Calculer les KPIs stock
    let totalStockValue = 0;
    let totalStockGrams = 0;
    const alertsRupture = [];
    const alertsLow = [];
    const alertsDormant = [];

    // Seuils configurables
    const SEUIL_RUPTURE = 0;
    const SEUIL_CRITIQUE = 50; // grammes
    const SEUIL_BAS = 200; // grammes
    const SEUIL_ROTATION_LENT = 30; // jours
    const SEUIL_ROTATION_DORMANT = 60; // jours

    // Analyser chaque produit
    const productsAnalysis = products.map(p => {
      const grams = p.totalGrams || 0;
      const cmp = p.averageCostPerGram || 0;
      const value = grams * cmp;
      totalStockValue += value;
      totalStockGrams += grams;

      // Calculer rotation estimee (basee sur les ventes si dispo)
      let rotationDays = null;
      let velocityPerDay = 0;
      let lastSaleDate = null;
      let totalSoldGrams = 0;

      if (analyticsStore) {
        const sales = analyticsStore.getSalesByProduct ? 
          analyticsStore.getSalesByProduct(shop, p.productId, from, to) : [];
        if (sales.length > 0) {
          totalSoldGrams = sales.reduce((sum, s) => sum + (s.totalGrams || 0), 0);
          velocityPerDay = totalSoldGrams / daysAgo;
          rotationDays = velocityPerDay > 0 ? Math.round(grams / velocityPerDay) : null;
          lastSaleDate = sales[0]?.orderDate || null;
        }
      }

      // Determiner le statut
      let status = "good";
      let statusLabel = "OK";
      if (grams <= SEUIL_RUPTURE) {
        status = "rupture";
        statusLabel = "Rupture";
      } else if (grams < SEUIL_CRITIQUE) {
        status = "critical";
        statusLabel = "Critique";
      } else if (grams < SEUIL_BAS) {
        status = "low";
        statusLabel = "Bas";
      }

      // Determiner sante rotation
      let rotationStatus = "unknown";
      if (rotationDays !== null) {
        if (rotationDays <= SEUIL_ROTATION_LENT) rotationStatus = "fast";
        else if (rotationDays <= SEUIL_ROTATION_DORMANT) rotationStatus = "slow";
        else rotationStatus = "dormant";
      } else if (grams > 0 && totalSoldGrams === 0) {
        rotationStatus = "dormant"; // Aucune vente sur la periode
      }

      // Alertes
      if (status === "rupture") {
        alertsRupture.push({ productId: p.productId, name: p.name, grams, value });
      } else if (status === "critical" || status === "low") {
        if (rotationDays !== null && rotationDays < 7) {
          alertsLow.push({ productId: p.productId, name: p.name, grams, daysLeft: rotationDays, value });
        }
      }
      if (rotationStatus === "dormant" && grams > 0) {
        alertsDormant.push({ productId: p.productId, name: p.name, grams, value, daysSinceLastSale: rotationDays || 999 });
      }

      return {
        productId: p.productId,
        name: p.name,
        grams,
        cmp,
        value,
        status,
        statusLabel,
        rotationDays,
        rotationStatus,
        velocityPerDay: Math.round(velocityPerDay * 100) / 100,
        totalSoldGrams,
        categoryIds: p.categoryIds || [],
      };
    });

    // 3. Calculer la sante globale du stock
    let stockVendable = 0;
    let stockLent = 0;
    let stockDormant = 0;

    productsAnalysis.forEach(p => {
      if (p.rotationStatus === "fast") stockVendable += p.value;
      else if (p.rotationStatus === "slow") stockLent += p.value;
      else if (p.rotationStatus === "dormant") stockDormant += p.value;
      else stockVendable += p.value; // Par defaut si pas de donnees
    });

    const healthScore = totalStockValue > 0 
      ? Math.round(((stockVendable / totalStockValue) * 100) - ((stockDormant / totalStockValue) * 30))
      : 100;

    // 4. Top produits
    const topVendus = [...productsAnalysis]
      .filter(p => p.totalSoldGrams > 0)
      .sort((a, b) => b.totalSoldGrams - a.totalSoldGrams)
      .slice(0, 5);

    const topValeur = [...productsAnalysis]
      .filter(p => p.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    const topLents = [...productsAnalysis]
      .filter(p => p.rotationStatus === "dormant" || p.rotationStatus === "slow")
      .sort((a, b) => (b.rotationDays || 999) - (a.rotationDays || 999))
      .slice(0, 5);

    // 5. Analyse par categorie
    const categoryAnalysis = categories.map(cat => {
      const catProducts = productsAnalysis.filter(p => 
        Array.isArray(p.categoryIds) && p.categoryIds.includes(cat.id)
      );
      const catValue = catProducts.reduce((sum, p) => sum + p.value, 0);
      const catGrams = catProducts.reduce((sum, p) => sum + p.grams, 0);
      const catSold = catProducts.reduce((sum, p) => sum + p.totalSoldGrams, 0);
      const avgRotation = catProducts.length > 0
        ? catProducts.reduce((sum, p) => sum + (p.rotationDays || 0), 0) / catProducts.length
        : null;

      let health = "good";
      if (avgRotation !== null) {
        if (avgRotation > SEUIL_ROTATION_DORMANT) health = "dormant";
        else if (avgRotation > SEUIL_ROTATION_LENT) health = "slow";
      }

      return {
        id: cat.id,
        name: cat.name,
        productCount: catProducts.length,
        stockGrams: Math.round(catGrams),
        stockValue: Math.round(catValue * 100) / 100,
        soldGrams: Math.round(catSold),
        avgRotationDays: avgRotation ? Math.round(avgRotation) : null,
        health,
      };
    });

    // Produits sans categorie
    const uncategorized = productsAnalysis.filter(p => 
      !Array.isArray(p.categoryIds) || p.categoryIds.length === 0
    );
    if (uncategorized.length > 0) {
      const uncatValue = uncategorized.reduce((sum, p) => sum + p.value, 0);
      const uncatGrams = uncategorized.reduce((sum, p) => sum + p.grams, 0);
      const uncatSold = uncategorized.reduce((sum, p) => sum + p.totalSoldGrams, 0);
      categoryAnalysis.push({
        id: "uncategorized",
        name: "Sans categorie",
        productCount: uncategorized.length,
        stockGrams: Math.round(uncatGrams),
        stockValue: Math.round(uncatValue * 100) / 100,
        soldGrams: Math.round(uncatSold),
        avgRotationDays: null,
        health: "unknown",
      });
    }

    // 6. Analyse par format (gramsPerUnit des variantes)
    const formatBuckets = { small: { label: "1-5g", min: 0, max: 5 }, medium: { label: "10-25g", min: 6, max: 25 }, large: { label: "50g+", min: 26, max: 9999 } };
    const formatAnalysis = [];

    products.forEach(p => {
      if (!Array.isArray(p.variants)) return;
      p.variants.forEach(v => {
        const gpu = v.gramsPerUnit || 0;
        let bucket = null;
        if (gpu > 0 && gpu <= 5) bucket = "small";
        else if (gpu > 5 && gpu <= 25) bucket = "medium";
        else if (gpu > 25) bucket = "large";
        if (bucket) {
          if (!formatAnalysis[bucket]) {
            formatAnalysis[bucket] = { ...formatBuckets[bucket], stockValue: 0, soldGrams: 0, productCount: 0 };
          }
          // Calculer la part de stock de cette variante
          const productData = productsAnalysis.find(pa => pa.productId === p.productId);
          if (productData) {
            formatAnalysis[bucket].stockValue += productData.value / (p.variants.length || 1);
            formatAnalysis[bucket].soldGrams += productData.totalSoldGrams / (p.variants.length || 1);
            formatAnalysis[bucket].productCount++;
          }
        }
      });
    });

    const formatAnalysisArray = Object.values(formatAnalysis).map(f => ({
      ...f,
      stockValue: Math.round(f.stockValue * 100) / 100,
      soldGrams: Math.round(f.soldGrams),
      percentStock: totalStockValue > 0 ? Math.round((f.stockValue / totalStockValue) * 100) : 0,
    }));

    // 7. Recuperer les ventes analytics si disponibles
    let salesSummary = null;
    if (analyticsManager && typeof analyticsManager.calculateSummary === "function") {
      salesSummary = analyticsManager.calculateSummary(shop, from, to);
    }

    // 8. Calculer la rotation moyenne globale
    const productsWithRotation = productsAnalysis.filter(p => p.rotationDays !== null && p.rotationDays > 0);
    const avgRotation = productsWithRotation.length > 0
      ? Math.round(productsWithRotation.reduce((sum, p) => sum + p.rotationDays, 0) / productsWithRotation.length)
      : null;

    // Reponse finale
    res.json({
      period: { from, to, days: daysAgo },
      
      // KPIs principaux
      kpis: {
        totalStockValue: Math.round(totalStockValue * 100) / 100,
        totalStockGrams: Math.round(totalStockGrams),
        totalProducts: products.length,
        alertsCount: alertsRupture.length + alertsLow.length,
        avgRotationDays: avgRotation,
        healthScore: Math.max(0, Math.min(100, healthScore)),
      },

      // Sante du stock
      stockHealth: {
        vendable: { value: Math.round(stockVendable * 100) / 100, percent: totalStockValue > 0 ? Math.round((stockVendable / totalStockValue) * 100) : 0 },
        lent: { value: Math.round(stockLent * 100) / 100, percent: totalStockValue > 0 ? Math.round((stockLent / totalStockValue) * 100) : 0 },
        dormant: { value: Math.round(stockDormant * 100) / 100, percent: totalStockValue > 0 ? Math.round((stockDormant / totalStockValue) * 100) : 0 },
      },

      // Alertes
      alerts: {
        rupture: alertsRupture.slice(0, 10),
        lowStock: alertsLow.sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 10),
        dormant: alertsDormant.sort((a, b) => b.value - a.value).slice(0, 10),
      },

      // Tops
      topProducts: {
        vendus: topVendus,
        valeur: topValeur,
        lents: topLents,
      },

      // Par categorie
      categories: categoryAnalysis.sort((a, b) => b.stockValue - a.stockValue),

      // Par format
      formats: formatAnalysisArray,

      // Ventes (si disponibles)
      sales: salesSummary,

      // Seuils utilises
      thresholds: {
        rupture: SEUIL_RUPTURE,
        critique: SEUIL_CRITIQUE,
        bas: SEUIL_BAS,
        rotationLent: SEUIL_ROTATION_LENT,
        rotationDormant: SEUIL_ROTATION_DORMANT,
      },
    });
  });
});

// ============================================
// ANALYTICS PRO - Ventes Shopify & Marges
// ============================================

router.get("/api/analytics/sales", async (req, res) => {
  try {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Verifier le plan PRO
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_analytics");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason });
      }
    }

    const period = parseInt(req.query.period, 10) || 30;
    const now = new Date();
    const fromDate = new Date(now.getTime() - period * 24 * 60 * 60 * 1000);

    // Recuperer les commandes Shopify
    const client = shopifyFor(shop);
    if (!client) return apiError(res, 500, "Client Shopify non disponible");

    const orders = await client.order.list({
      status: "any",
      created_at_min: fromDate.toISOString(),
      limit: 250,
    });

    // Recuperer les produits avec leur CMP
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];
    const productMap = {};
    products.forEach(p => {
      productMap[p.productId] = {
        name: p.name,
        cmp: p.averageCostPerGram || 0,
        totalGrams: p.totalGrams || 0,
      };
    });

    // Analyser les ventes
    let totalRevenue = 0;
    let totalCost = 0;
    let totalQuantitySold = 0;
    let totalGramsSold = 0;
    const productSales = {};
    const dailySales = {};

    (orders || []).forEach(order => {
      if (order.financial_status === "refunded" || order.cancelled_at) return;

      const orderDate = order.created_at.slice(0, 10);
      if (!dailySales[orderDate]) {
        dailySales[orderDate] = { date: orderDate, revenue: 0, cost: 0, margin: 0, orders: 0 };
      }
      dailySales[orderDate].orders++;

      (order.line_items || []).forEach(item => {
        const productId = String(item.product_id);
        const variantId = String(item.variant_id);
        const quantity = item.quantity || 0;
        const price = parseFloat(item.price) || 0;
        const lineTotal = price * quantity;

        totalRevenue += lineTotal;
        totalQuantitySold += quantity;
        dailySales[orderDate].revenue += lineTotal;

        // Trouver le produit pour calculer le cout
        const product = productMap[productId];
        let gramsPerUnit = 0;
        let lineCost = 0;

        if (product) {
          // Chercher la variante pour les gramsPerUnit
          const fullProduct = products.find(p => p.productId === productId);
          if (fullProduct && Array.isArray(fullProduct.variants)) {
            const variant = fullProduct.variants.find(v => String(v.variantId) === variantId);
            gramsPerUnit = variant?.gramsPerUnit || 1;
          } else {
            gramsPerUnit = 1; // Fallback
          }
          
          const gramsSold = gramsPerUnit * quantity;
          lineCost = gramsSold * product.cmp;
          totalCost += lineCost;
          totalGramsSold += gramsSold;
          dailySales[orderDate].cost += lineCost;

          // Agreger par produit
          if (!productSales[productId]) {
            productSales[productId] = {
              productId,
              name: product.name || item.title,
              quantitySold: 0,
              gramsSold: 0,
              revenue: 0,
              cost: 0,
              margin: 0,
              marginPercent: 0,
              cmp: product.cmp,
            };
          }
          productSales[productId].quantitySold += quantity;
          productSales[productId].gramsSold += gramsSold;
          productSales[productId].revenue += lineTotal;
          productSales[productId].cost += lineCost;
        }
      });
    });

    // Calculer les marges par produit
    Object.values(productSales).forEach(p => {
      p.margin = p.revenue - p.cost;
      p.marginPercent = p.revenue > 0 ? Math.round((p.margin / p.revenue) * 100) : 0;
    });

    // Calculer les marges journalieres
    Object.values(dailySales).forEach(d => {
      d.margin = d.revenue - d.cost;
      d.marginPercent = d.revenue > 0 ? Math.round((d.margin / d.revenue) * 100) : 0;
    });

    // Trier et preparer les tops
    const productList = Object.values(productSales);
    const topByRevenue = [...productList].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    const topByMargin = [...productList].sort((a, b) => b.margin - a.margin).slice(0, 5);
    const topByMarginPercent = [...productList].filter(p => p.revenue > 10).sort((a, b) => b.marginPercent - a.marginPercent).slice(0, 5);
    const topByVolume = [...productList].sort((a, b) => b.gramsSold - a.gramsSold).slice(0, 5);
    const worstByMargin = [...productList].filter(p => p.revenue > 10).sort((a, b) => a.marginPercent - b.marginPercent).slice(0, 5);

    // Calculer totaux
    const totalMargin = totalRevenue - totalCost;
    const marginPercent = totalRevenue > 0 ? Math.round((totalMargin / totalRevenue) * 100) : 0;
    const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;
    const avgCMP = totalGramsSold > 0 ? totalCost / totalGramsSold : 0;
    const avgSellingPrice = totalGramsSold > 0 ? totalRevenue / totalGramsSold : 0;

    // Timeline pour graphique
    const timeline = Object.values(dailySales).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      period: { days: period, from: fromDate.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
      
      // KPIs Ventes
      kpis: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalMargin: Math.round(totalMargin * 100) / 100,
        marginPercent,
        totalOrders: orders.length,
        totalQuantitySold,
        totalGramsSold: Math.round(totalGramsSold),
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        avgCMP: Math.round(avgCMP * 100) / 100,
        avgSellingPrice: Math.round(avgSellingPrice * 100) / 100,
      },

      // Top produits
      topProducts: {
        byRevenue: topByRevenue,
        byMargin: topByMargin,
        byMarginPercent: topByMarginPercent,
        byVolume: topByVolume,
        worstMargin: worstByMargin,
      },

      // Timeline pour graphiques
      timeline,

      // Tous les produits vendus
      products: productList.sort((a, b) => b.revenue - a.revenue),
    });

  } catch (e) {
    logEvent("analytics_sales_error", { error: e.message }, "error");
    return apiError(res, 500, "Erreur: " + e.message);
  }
});

// ============================================
// SYNC SHOPIFY API
// ============================================

// Sync produits depuis Shopify
router.post("/api/sync/shopify", async (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    try {
      const client = getShopifyClient(shop);
      if (!client) {
        return apiError(res, 400, "Client Shopify non configuré");
      }

      // Récupérer les produits Shopify
      const products = await client.product.list({ limit: 250 });
      
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      
      for (const shopifyProduct of products) {
        const productId = shopifyProduct.id.toString();
        const existingProduct = stock.getProductSnapshot(shop, productId);
        
        // Préparer les variantes au format attendu par stockManager
        // IMPORTANT: normalizeVariants exige inventoryItemId ET gramsPerUnit > 0
        const variantsObj = {};
        let hasValidVariant = false;
        
        if (shopifyProduct.variants && shopifyProduct.variants.length > 0) {
          shopifyProduct.variants.forEach(v => {
            // inventory_item_id est fourni par Shopify API
            const inventoryItemId = v.inventory_item_id || v.inventoryItemId || 0;
            // grams est le poids en grammes de Shopify, sinon on met 1 par défaut
            const gramsPerUnit = parseFloat(v.grams) || 1;
            
            if (inventoryItemId && gramsPerUnit > 0) {
              // Utiliser le titre de la variante comme clé (ex: "1.5", "3", "5g")
              const label = v.title || v.id.toString();
              variantsObj[label] = {
                variantId: v.id.toString(),
                inventoryItemId: inventoryItemId,
                gramsPerUnit: gramsPerUnit,
                sku: v.sku || "",
                barcode: v.barcode || "",
                price: parseFloat(v.price) || 0
              };
              hasValidVariant = true;
            }
          });
        }
        
        // Si aucune variante valide, on skip ce produit
        if (!hasValidVariant) {
          skipped++;
          continue;
        }
        
        // Utiliser upsertImportedProductConfig qui existe dans stockManager
        const productData = {
          productId: productId,
          name: shopifyProduct.title,
          totalGrams: existingProduct ? existingProduct.totalGrams : 0,
          variants: variantsObj,
          categoryIds: existingProduct ? existingProduct.categoryIds : []
        };
        
        try {
          stock.upsertImportedProductConfig(shop, productData);
          
          if (!existingProduct) {
            imported++;
          } else {
            updated++;
          }
        } catch (productError) {
          // Log l'erreur mais continue avec les autres produits
          logEvent("sync_product_error", { 
            shop, 
            productId, 
            productName: shopifyProduct.title,
            error: productError.message 
          }, "warn");
          skipped++;
        }
      }

      logEvent("sync_shopify", { shop, imported, updated, skipped });
      
      res.json({
        success: true,
        imported,
        updated,
        skipped,
        total: products.length,
        message: `Sync terminé: ${imported} importés, ${updated} mis à jour, ${skipped} ignorés`
      });

    } catch (e) {
      logEvent("sync_shopify_error", { shop, error: e.message }, "error");
      return apiError(res, 500, "Erreur sync Shopify: " + e.message);
    }
  });
});

// ============================================
// NOTIFICATIONS API
// ============================================

// Liste des notifications/alertes
router.get("/api/notifications", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Vérifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_notifications");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!notificationStore) {
      return res.json({ notifications: [], unreadCount: 0 });
    }

    const limit = parseInt(req.query.limit) || 20;
    const data = notificationStore.loadNotifications(shop);
    const alerts = data.alerts || [];
    
    // Trier par date décroissante
    alerts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const unreadCount = alerts.filter(a => !a.read && !a.dismissed).length;
    
    res.json({
      notifications: alerts.slice(0, limit),
      unreadCount,
      total: alerts.length,
      settings: data.settings,
      lastCheck: data.lastCheck
    });
  });
});

// Vérifier/générer les alertes
router.post("/api/notifications/check", async (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (!alertChecker) {
      return res.json({ newAlerts: 0, resolvedAlerts: 0, message: "AlertChecker non disponible" });
    }

    try {
      const results = await alertChecker.checkAllAlerts(shop);
      res.json(results);
    } catch (e) {
      logEvent("notifications_check_error", { shop, error: e.message }, "error");
      return apiError(res, 500, "Erreur vérification alertes: " + e.message);
    }
  });
});

// Marquer une notification comme lue
router.put("/api/notifications/:id/read", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (!notificationStore) {
      return apiError(res, 500, "NotificationStore non disponible");
    }

    const alertId = req.params.id;
    notificationStore.markAsRead(shop, alertId);
    
    res.json({ success: true });
  });
});

// Ignorer/dismiss une notification
router.put("/api/notifications/:id/dismiss", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (!notificationStore) {
      return apiError(res, 500, "NotificationStore non disponible");
    }

    const alertId = req.params.id;
    notificationStore.dismissAlert(shop, alertId);
    
    res.json({ success: true });
  });
});

// Paramètres des notifications
router.get("/api/notifications/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (!notificationStore) {
      return res.json({ settings: {} });
    }

    const data = notificationStore.loadNotifications(shop);
    res.json({ settings: data.settings || {} });
  });
});

router.put("/api/notifications/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (!notificationStore) {
      return apiError(res, 500, "NotificationStore non disponible");
    }

    const newSettings = req.body;
    notificationStore.updateSettings(shop, newSettings);
    
    res.json({ success: true });
  });
});

// ============================================
// FOURNISSEURS API (Plan PRO)
// ============================================

// Liste des fournisseurs
router.get("/api/suppliers", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Verifier le plan (hasSuppliers)
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_suppliers");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    const { status, search, tag } = req.query;
    const suppliers = supplierStore.listSuppliers(shop, { status, search, tag });
    const stats = supplierStore.getSupplierStats(shop);

    // Enrichir avec les stats de commandes si disponible
    const enriched = suppliers.map(s => {
      // Compter les lots lies
      let lotsCount = 0;
      let totalPurchased = 0;
      if (batchStore) {
        const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
        (snapshot.products || []).forEach(p => {
          const batches = batchStore.loadBatches(shop, p.productId);
          batches.forEach(b => {
            if (b.supplierId === s.id) {
              lotsCount++;
              totalPurchased += b.initialGrams || 0;
            }
          });
        });
      }

      return {
        ...s,
        lotsCount,
        totalPurchased,
        productsCount: (s.products || []).length,
      };
    });

    res.json({ suppliers: enriched, stats });
  });
});

// Detail d'un fournisseur
router.get("/api/suppliers/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    const supplier = supplierStore.getSupplier(shop, req.params.id);
    if (!supplier) return apiError(res, 404, "Fournisseur non trouve");

    // Enrichir avec les produits details
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productMap = {};
    (snapshot.products || []).forEach(p => { productMap[p.productId] = p; });

    const productsEnriched = (supplier.products || []).map(sp => {
      const product = productMap[sp.productId];
      return {
        ...sp,
        productName: product ? product.name : "Produit inconnu",
        currentStock: product ? product.totalGrams : 0,
      };
    });

    // Recuperer les lots de ce fournisseur
    let lots = [];
    if (batchStore) {
      (snapshot.products || []).forEach(p => {
        const batches = batchStore.loadBatches(shop, p.productId);
        batches.forEach(b => {
          if (b.supplierId === supplier.id) {
            lots.push({
              ...b,
              productName: p.name,
            });
          }
        });
      });
    }
    lots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Calculer les analytics
    const analytics = {
      totalLots: lots.length,
      totalPurchased: lots.reduce((s, l) => s + (l.initialGrams || 0), 0),
      totalSpent: lots.reduce((s, l) => s + ((l.initialGrams || 0) * (l.purchasePricePerGram || 0)), 0),
      avgPricePerGram: 0,
      lastPurchase: lots.length > 0 ? lots[0].createdAt : null,
    };
    if (analytics.totalPurchased > 0) {
      analytics.avgPricePerGram = analytics.totalSpent / analytics.totalPurchased;
    }

    res.json({ 
      supplier: { ...supplier, products: productsEnriched }, 
      lots: lots.slice(0, 20),
      analytics 
    });
  });
});

// Creer un fournisseur
router.post("/api/suppliers", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    // Compter les fournisseurs actuels
    const currentSuppliers = supplierStore.loadSuppliers(shop);
    const currentCount = currentSuppliers.length;

    // Verifier limite du plan avec le comptage
    if (planManager) {
      const check = planManager.checkLimit(shop, "create_supplier", { currentSupplierCount: currentCount });
      if (!check.allowed) {
        return res.status(403).json({ 
          error: "plan_limit", 
          message: check.reason,
          upgrade: check.upgrade,
          limit: check.limit,
          current: check.current
        });
      }
    }

    try {
      const supplier = supplierStore.createSupplier(shop, {
        name: req.body.name,
        code: req.body.code,
        type: req.body.type,
        contact: req.body.contact,
        address: req.body.address,
        terms: req.body.terms,
        notes: req.body.notes,
        tags: req.body.tags,
      });
      res.json({ success: true, supplier });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Modifier un fournisseur
router.put("/api/suppliers/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    try {
      const supplier = supplierStore.updateSupplier(shop, req.params.id, req.body);
      res.json({ success: true, supplier });
    } catch (e) {
      return apiError(res, 404, e.message);
    }
  });
});

// Supprimer un fournisseur
router.delete("/api/suppliers/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    const hard = req.query.hard === "true";
    try {
      const result = supplierStore.deleteSupplier(shop, req.params.id, hard);
      res.json({ success: true, result });
    } catch (e) {
      return apiError(res, 404, e.message);
    }
  });
});

// Lier un produit a un fournisseur
router.post("/api/suppliers/:id/products", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    const { productId, pricePerGram, minQuantity, notes } = req.body;
    if (!productId) return apiError(res, 400, "productId requis");

    try {
      const result = supplierStore.setProductPrice(shop, req.params.id, productId, pricePerGram || 0, { minQuantity, notes });
      res.json({ success: true, product: result });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Retirer un produit d'un fournisseur
router.delete("/api/suppliers/:id/products/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    const result = supplierStore.removeProductPrice(shop, req.params.id, req.params.productId);
    res.json({ success: true, removed: result });
  });
});

// Fournisseurs pour un produit (comparaison prix)
router.get("/api/products/:productId/suppliers", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!supplierStore) return apiError(res, 500, "Module fournisseurs non disponible");

    const quantity = parseInt(req.query.quantity) || 100;
    const suppliers = supplierStore.comparePrices(shop, req.params.productId, quantity);
    res.json({ suppliers });
  });
});

// ============================================
// COMMANDES D'ACHAT (Purchase Orders) - Business
// ============================================

// Liste des PO
router.get("/api/purchase-orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (planManager) {
      const check = planManager.checkLimit(shop, "view_purchase_orders");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    const { year, status, supplierId, limit } = req.query;
    const orders = purchaseOrderStore.listPurchaseOrders(shop, {
      year: year ? parseInt(year) : null,
      status,
      supplierId,
      limit: limit ? parseInt(limit) : 100,
    });

    const stats = purchaseOrderStore.getPOStats(shop);
    res.json({ orders, stats });
  });
});

// Detail PO
router.get("/api/purchase-orders/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    const po = purchaseOrderStore.getPurchaseOrder(shop, req.params.id);
    if (!po) return apiError(res, 404, "Commande non trouvee");

    // Enrichir avec les noms de produits
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productMap = {};
    (snapshot.products || []).forEach(p => { productMap[p.productId] = p; });

    po.lines = po.lines.map(line => ({
      ...line,
      productName: line.productName || (productMap[line.productId]?.name) || "Produit inconnu",
    }));

    res.json({ order: po });
  });
});

// Creer PO
router.post("/api/purchase-orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (planManager) {
      const check = planManager.checkLimit(shop, "create_purchase_order");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason });
      }
    }

    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      const po = purchaseOrderStore.createPurchaseOrder(shop, req.body);
      res.json({ success: true, order: po });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Update PO
router.put("/api/purchase-orders/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      const po = purchaseOrderStore.updatePurchaseOrder(shop, req.params.id, req.body);
      res.json({ success: true, order: po });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Envoyer PO
router.post("/api/purchase-orders/:id/send", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      const po = purchaseOrderStore.sendPurchaseOrder(shop, req.params.id);
      res.json({ success: true, order: po });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Confirmer PO
router.post("/api/purchase-orders/:id/confirm", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      const po = purchaseOrderStore.confirmPurchaseOrder(shop, req.params.id, req.body.expectedDeliveryAt);
      res.json({ success: true, order: po });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Recevoir items PO
router.post("/api/purchase-orders/:id/receive", async (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      const result = purchaseOrderStore.receiveItems(shop, req.params.id, req.body.lines, {
        notes: req.body.notes,
        createBatches: req.body.createBatches !== false,
      });

      // Creer les lots et mettre a jour le stock
      if (batchStore && result.batchesToCreate.length > 0) {
        for (const batchData of result.batchesToCreate) {
          try {
            batchStore.createBatch(shop, batchData.productId, {
              grams: batchData.grams,
              purchasePricePerGram: batchData.pricePerGram,
              supplierId: batchData.supplierId,
              purchaseOrderId: batchData.purchaseOrderId,
              expiryDate: batchData.expiryDate,
              expiryType: batchData.expiryType,
            });

            // Mettre a jour le stock
            if (stock.addStock) {
              stock.addStock(shop, batchData.productId, batchData.grams, batchData.pricePerGram);
            }
          } catch (e) {
            console.warn("Erreur creation lot:", e.message);
          }
        }
      }

      res.json({ success: true, ...result });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Annuler PO
router.post("/api/purchase-orders/:id/cancel", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      const po = purchaseOrderStore.cancelPurchaseOrder(shop, req.params.id, req.body.reason);
      res.json({ success: true, order: po });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Supprimer PO (brouillon seulement)
router.delete("/api/purchase-orders/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");

    try {
      purchaseOrderStore.deletePurchaseOrder(shop, req.params.id);
      res.json({ success: true });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// ============================================
// COMMANDES DE VENTE (Sales Orders) - PRO
// ============================================

// Liste des SO
router.get("/api/sales-orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (planManager) {
      const check = planManager.checkLimit(shop, "view_sales_orders");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!salesOrderStore) return apiError(res, 500, "Module ventes non disponible");

    const { from, to, status, source, search, limit } = req.query;
    const orders = salesOrderStore.listSalesOrders(shop, {
      from, to, status, source, search,
      limit: limit ? parseInt(limit) : 100,
    });

    const stats = salesOrderStore.getSalesStats(shop, { from, to });
    res.json({ orders, stats });
  });
});

// Detail SO
router.get("/api/sales-orders/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!salesOrderStore) return apiError(res, 500, "Module ventes non disponible");

    const so = salesOrderStore.getSalesOrder(shop, req.params.id);
    if (!so) return apiError(res, 404, "Commande non trouvee");

    res.json({ order: so });
  });
});

// Creer SO manuellement
router.post("/api/sales-orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!salesOrderStore) return apiError(res, 500, "Module ventes non disponible");

    // Recuperer les CMP des produits
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productMap = {};
    (snapshot.products || []).forEach(p => { 
      productMap[p.productId] = { 
        name: p.name, 
        cmp: p.averageCostPerGram || 0 
      }; 
    });

    // Ajouter les couts aux lignes
    const lines = (req.body.lines || []).map(line => ({
      ...line,
      productName: line.productName || productMap[line.productId]?.name || "Produit",
      costPrice: line.costPrice || productMap[line.productId]?.cmp || 0,
    }));

    try {
      const result = salesOrderStore.createSalesOrder(shop, { ...req.body, lines, source: "manual" });
      res.json({ success: true, ...result });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Import Shopify
router.post("/api/sales-orders/import-shopify", async (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!salesOrderStore) return apiError(res, 500, "Module ventes non disponible");

    // Recuperer les CMP des produits pour calculer les marges
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCostMap = {};
    const variantGramsMap = {};
    
    (snapshot.products || []).forEach(p => { 
      productCostMap[p.productId] = p.averageCostPerGram || 0;
      
      // Construire le mapping des grammes par variante
      if (Array.isArray(p.variants)) {
        p.variants.forEach(v => {
          if (v.inventoryItemId && v.grams) {
            variantGramsMap[v.variantId] = v.grams;
          }
        });
      }
    });

    try {
      // Recuperer les commandes Shopify via l'API
      const client = shopifyFor(shop);
      if (!client) return apiError(res, 500, "Client Shopify non disponible");

      const days = parseInt(req.query.days) || 30;
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);

      const shopifyOrders = await client.order.list({
        status: "any",
        created_at_min: fromDate.toISOString(),
        limit: 250,
      });

      const result = salesOrderStore.importFromShopify(shop, shopifyOrders || [], productCostMap, variantGramsMap);
      res.json({ success: true, ...result });
    } catch (e) {
      return apiError(res, 500, "Erreur import: " + e.message);
    }
  });
});

// Stats ventes
router.get("/api/sales-orders/stats", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!salesOrderStore) return apiError(res, 500, "Module ventes non disponible");

    const { from, to } = req.query;
    const stats = salesOrderStore.getSalesStats(shop, { from, to });
    res.json(stats);
  });
});

// ============================================
// LOTS & DLC API (Plan PRO)
// ============================================

// Liste tous les lots (tous produits)
router.get("/api/lots", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Verifier le plan PRO
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_batches");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const { status, productId, expiringDays, supplierId } = req.query;
    
    // Recuperer tous les produits
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];
    
    const allLots = [];
    const now = new Date();

    products.forEach(product => {
      if (productId && product.productId !== productId) return;
      
      const batches = batchStore.loadBatches(shop, product.productId);
      
      batches.forEach(batch => {
        // Filtres
        if (status && batch.status !== status) return;
        if (supplierId && batch.supplierId !== supplierId) return;
        
        // Calculer jours restants
        let daysLeft = null;
        let expiryStatus = "ok";
        if (batch.expiryDate) {
          const expiry = new Date(batch.expiryDate);
          daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
          
          if (daysLeft <= 0) expiryStatus = "expired";
          else if (daysLeft <= 7) expiryStatus = "critical";
          else if (daysLeft <= 15) expiryStatus = "warning";
          else if (daysLeft <= 30) expiryStatus = "watch";
        }
        
        // Filtre expiring
        if (expiringDays && daysLeft !== null && daysLeft > parseInt(expiringDays)) return;
        
        allLots.push({
          ...batch,
          productName: product.name,
          productId: product.productId,
          daysLeft,
          expiryStatus,
          valueRemaining: (batch.currentGrams || 0) * (batch.purchasePricePerGram || 0),
        });
      });
    });

    // Trier par urgence DLC puis par date de reception
    allLots.sort((a, b) => {
      if (a.daysLeft !== null && b.daysLeft !== null) {
        return a.daysLeft - b.daysLeft;
      }
      if (a.daysLeft !== null) return -1;
      if (b.daysLeft !== null) return 1;
      return new Date(b.receivedAt) - new Date(a.receivedAt);
    });

    // KPIs
    const kpis = {
      totalLots: allLots.length,
      activeLots: allLots.filter(l => l.status === "active").length,
      expiringWithin30: allLots.filter(l => l.daysLeft !== null && l.daysLeft > 0 && l.daysLeft <= 30).length,
      expiredLots: allLots.filter(l => l.expiryStatus === "expired").length,
      criticalLots: allLots.filter(l => l.expiryStatus === "critical").length,
      totalValueAtRisk: allLots.filter(l => l.daysLeft !== null && l.daysLeft <= 30).reduce((s, l) => s + l.valueRemaining, 0),
      totalValue: allLots.filter(l => l.status === "active").reduce((s, l) => s + l.valueRemaining, 0),
    };

    res.json({ lots: allLots, kpis });
  });
});

// Detail d'un lot
router.get("/api/lots/:productId/:lotId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const { productId, lotId } = req.params;
    const batch = batchStore.getBatch(shop, productId, lotId);
    
    if (!batch) return apiError(res, 404, "Lot non trouve");

    // Recuperer les mouvements lies a ce lot
    let movements = [];
    if (movementStore && movementStore.loadMovements) {
      const allMovements = movementStore.loadMovements(shop);
      movements = allMovements.filter(m => m.batchId === lotId || m.lotId === lotId).slice(0, 50);
    }

    // Calculer jours restants
    let daysLeft = null;
    if (batch.expiryDate) {
      const expiry = new Date(batch.expiryDate);
      daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
    }

    res.json({ 
      lot: { 
        ...batch, 
        daysLeft,
        valueRemaining: (batch.currentGrams || 0) * (batch.purchasePricePerGram || 0),
      }, 
      movements 
    });
  });
});

// Creer un lot
router.post("/api/lots/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    
    if (planManager) {
      const check = planManager.checkLimit(shop, "create_batch");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason });
      }
    }

    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const { productId } = req.params;
    const batchData = req.body;

    const batch = batchStore.createBatch(shop, productId, {
      grams: batchData.grams || batchData.quantity,
      purchasePricePerGram: batchData.costPerGram || batchData.purchasePricePerGram,
      expiryType: batchData.expiryType || "dlc",
      expiryDate: batchData.expiryDate,
      supplierId: batchData.supplierId,
      supplierBatchRef: batchData.supplierRef || batchData.supplierBatchRef,
      notes: batchData.notes,
      receivedAt: batchData.receivedAt,
    });

    // Enregistrer le mouvement
    if (movementStore && movementStore.addMovement) {
      movementStore.addMovement(shop, {
        type: "restock",
        productId,
        delta: batch.initialGrams,
        batchId: batch.id,
        reason: "Nouveau lot: " + batch.id,
      });
    }

    res.json({ success: true, lot: batch });
  });
});

// Modifier un lot
router.put("/api/lots/:productId/:lotId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const { productId, lotId } = req.params;
    const updates = req.body;

    try {
      const batch = batchStore.updateBatch(shop, productId, lotId, {
        expiryDate: updates.expiryDate,
        expiryType: updates.expiryType,
        notes: updates.notes,
        status: updates.status,
        supplierId: updates.supplierId,
        supplierBatchRef: updates.supplierBatchRef,
      });
      res.json({ success: true, lot: batch });
    } catch (e) {
      return apiError(res, 404, e.message);
    }
  });
});

// Ajuster la quantite d'un lot
router.post("/api/lots/:productId/:lotId/adjust", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const { productId, lotId } = req.params;
    const { delta, reason } = req.body;

    const batches = batchStore.loadBatches(shop, productId);
    const idx = batches.findIndex(b => b.id === lotId);
    if (idx === -1) return apiError(res, 404, "Lot non trouve");

    const batch = batches[idx];
    const oldGrams = batch.currentGrams;
    batch.currentGrams = Math.max(0, batch.currentGrams + Number(delta));
    batch.usedGrams = batch.initialGrams - batch.currentGrams;
    batch.updatedAt = new Date().toISOString();

    if (batch.currentGrams <= 0 && batch.status === "active") {
      batch.status = "depleted";
    }

    batches[idx] = batch;
    batchStore.saveBatches ? null : null; // saveBatches n'est pas exporte, on refait
    
    // Sauvegarder manuellement
    const fs = require("fs");
    const path = require("path");
    const DATA_DIR = process.env.DATA_DIR || "/var/data";
    const shopDir = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"));
    const batchDir = path.join(shopDir, "batches");
    if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });
    const file = path.join(batchDir, productId + ".json");
    fs.writeFileSync(file, JSON.stringify({ productId, batches, updatedAt: new Date().toISOString() }, null, 2));

    // Enregistrer le mouvement
    if (movementStore && movementStore.addMovement) {
      movementStore.addMovement(shop, {
        type: "adjustment",
        productId,
        delta: Number(delta),
        batchId: lotId,
        reason: reason || "Ajustement lot",
      });
    }

    res.json({ success: true, lot: batch, oldGrams, newGrams: batch.currentGrams });
  });
});

// Supprimer / Desactiver un lot
router.delete("/api/lots/:productId/:lotId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const { productId, lotId } = req.params;
    const { hard } = req.query;

    try {
      const result = batchStore.deleteBatch(shop, productId, lotId, hard === "true");
      res.json({ success: true, result });
    } catch (e) {
      return apiError(res, 404, e.message);
    }
  });
});

// Marquer les lots expires automatiquement
router.post("/api/lots/mark-expired", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const result = batchStore.markExpiredBatches(shop);
    res.json({ success: true, ...result });
  });
});

// Lots proches de l'expiration (alertes)
router.get("/api/lots/expiring", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!batchStore) return apiError(res, 500, "Module lots non disponible");

    const days = parseInt(req.query.days) || 30;
    const lots = batchStore.getExpiringBatches(shop, { daysThreshold: days });

    // Enrichir avec les noms de produits
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productMap = {};
    (snapshot.products || []).forEach(p => { productMap[p.productId] = p.name; });

    const enriched = lots.map(l => ({
      ...l,
      productName: productMap[l.productId] || "Produit inconnu",
      valueAtRisk: (l.currentGrams || 0) * (l.purchasePricePerGram || 0),
    }));

    res.json({ lots: enriched, count: enriched.length });
  });
});

// ============================================
// KITS & BUNDLES API (Plan Business)
// ============================================

// Liste des kits
router.get("/api/kits", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Vérifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_kits");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    const { status, type, categoryId, search, includeArchived } = req.query;
    const kits = kitStore.listKits(shop, { 
      status, type, categoryId, search, 
      includeArchived: includeArchived === "true" 
    });

    // Enrichir avec calcul coût/marge
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCosts = {};
    (snapshot.products || []).forEach(p => {
      productCosts[p.productId] = { 
        cmp: p.averageCostPerGram || 0, 
        stock: p.totalGrams || 0,
        name: p.name 
      };
    });

    const enriched = kits.map(kit => {
      const costData = kitStore.calculateKitCostAndMargin(kit, productCosts);
      return {
        ...kit,
        calculatedCost: costData.totalCost,
        calculatedMargin: costData.margin,
        calculatedMarginPercent: costData.marginPercent,
        hasIssues: costData.hasIssues,
        alerts: costData.alerts,
        itemCount: kit.items.length,
        maxProducible: kitStore.calculateMaxProducible(kit, productCosts),
      };
    });

    const stats = kitStore.getKitStats(shop);
    res.json({ kits: enriched, stats });
  });
});

// Détail d'un kit
router.get("/api/kits/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    const kit = kitStore.getKit(shop, req.params.id);
    if (!kit) return apiError(res, 404, "Kit non trouvé");

    // Enrichir avec calcul coût/marge
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCosts = {};
    (snapshot.products || []).forEach(p => {
      productCosts[p.productId] = { 
        cmp: p.averageCostPerGram || 0, 
        stock: p.totalGrams || 0,
        name: p.name 
      };
    });

    const costData = kitStore.calculateKitCostAndMargin(kit, productCosts);
    const events = kitStore.getKitEvents(shop, kit.id, { limit: 20 });

    res.json({ 
      kit, 
      costData,
      events,
      maxProducible: kitStore.calculateMaxProducible(kit, productCosts),
    });
  });
});

// Créer un kit
router.post("/api/kits", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Vérifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "manage_kits");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const kit = kitStore.createKit(shop, req.body);
      res.json({ success: true, kit });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Modifier un kit
router.put("/api/kits/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const kit = kitStore.updateKit(shop, req.params.id, req.body);
      res.json({ success: true, kit });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Archiver un kit
router.delete("/api/kits/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      if (req.query.permanent === "true") {
        const result = kitStore.deleteKit(shop, req.params.id);
        res.json({ success: true, deleted: true });
      } else {
        const kit = kitStore.archiveKit(shop, req.params.id);
        res.json({ success: true, kit, archived: true });
      }
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Ajouter un composant
router.post("/api/kits/:id/items", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const result = kitStore.addKitItem(shop, req.params.id, req.body);
      res.json({ success: true, kit: result.kit, item: result.item });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Modifier un composant
router.put("/api/kits/:id/items/:itemId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const result = kitStore.updateKitItem(shop, req.params.id, req.params.itemId, req.body);
      res.json({ success: true, kit: result.kit, item: result.item });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Supprimer un composant
router.delete("/api/kits/:id/items/:itemId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const result = kitStore.removeKitItem(shop, req.params.id, req.params.itemId);
      res.json({ success: true, kit: result.kit, removed: result.removed });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Mapper un kit à Shopify
router.post("/api/kits/:id/map-shopify", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const { shopifyProductId, shopifyVariantId } = req.body;
      const kit = kitStore.mapKitToShopify(shop, req.params.id, shopifyProductId, shopifyVariantId);
      res.json({ success: true, kit });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Assembler des kits
router.post("/api/kits/:id/assemble", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      const { quantity, allowNegative, notes } = req.body;
      const result = kitStore.assembleKits(shop, req.params.id, quantity || 1, {
        stockManager: stock,
        batchStore,
        allowNegative: allowNegative === true,
        notes,
      });
      res.json(result);
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Simuler des ventes
router.post("/api/kits/:id/simulate", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    try {
      // Récupérer les coûts produits
      const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const productCosts = {};
      (snapshot.products || []).forEach(p => {
        productCosts[p.productId] = { 
          cmp: p.averageCostPerGram || 0, 
          stock: p.totalGrams || 0,
          name: p.name 
        };
      });

      const { quantity } = req.body;
      const result = kitStore.simulateKitSales(shop, req.params.id, quantity || 1, productCosts);
      res.json(result);
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Stats kits
router.get("/api/kits-stats", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    const { from, to } = req.query;
    const stats = kitStore.getKitStats(shop, { from, to });
    res.json(stats);
  });
});

// ============================================
// FORECAST / PREVISIONS API (Business)
// ============================================

// Liste des prévisions
router.get("/api/forecast", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Vérifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_forecast");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const windowDays = parseInt(req.query.windowDays) || 30;
    const categoryId = req.query.categoryId || null;

    // Récupérer les produits
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    let products = snapshot.products || [];

    // Filtrer par catégorie
    if (categoryId) {
      products = products.filter(p => p.categoryIds && p.categoryIds.includes(categoryId));
    }

    // Récupérer les données de ventes (depuis analyticsStore si disponible)
    let salesData = [];
    if (analyticsStore && typeof analyticsStore.listSales === "function") {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - windowDays);
      salesData = analyticsStore.listSales({ 
        shop, 
        from: fromDate.toISOString(), 
        limit: 50000 
      }).map(s => ({
        date: s.orderDate,
        productId: s.productId,
        qty: s.totalGrams || 0,
      }));
    }

    const forecasts = forecastManager.generateForecast(shop, products, salesData, { windowDays });
    const stats = forecastManager.getForecastStats(forecasts);
    const settings = forecastManager.loadForecastSettings(shop);

    res.json({ forecasts, stats, settings });
  });
});

// Détail prévision d'un produit
router.get("/api/forecast/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const windowDays = parseInt(req.query.windowDays) || 30;

    // Récupérer le produit
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const product = (snapshot.products || []).find(p => p.productId === req.params.productId);
    
    if (!product) return apiError(res, 404, "Produit non trouvé");

    // Récupérer les ventes
    let salesData = [];
    if (analyticsStore && typeof analyticsStore.listSales === "function") {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 90); // 90 jours d'historique
      salesData = analyticsStore.listSales({ 
        shop, 
        from: fromDate.toISOString(),
        productId: req.params.productId,
        limit: 10000 
      }).map(s => ({
        date: s.orderDate,
        productId: s.productId,
        qty: s.totalGrams || 0,
      }));
    }

    const forecast = forecastManager.generateProductForecast(shop, product, salesData, { windowDays });
    res.json(forecast);
  });
});

// Recommandations d'achat
router.get("/api/forecast/recommendations", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const windowDays = parseInt(req.query.windowDays) || 30;

    // Récupérer les produits
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const products = snapshot.products || [];

    // Récupérer les ventes
    let salesData = [];
    if (analyticsStore && typeof analyticsStore.listSales === "function") {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - windowDays);
      salesData = analyticsStore.listSales({ shop, from: fromDate.toISOString(), limit: 50000 })
        .map(s => ({ date: s.orderDate, productId: s.productId, qty: s.totalGrams || 0 }));
    }

    // Récupérer les fournisseurs
    let suppliersData = [];
    if (supplierStore && typeof supplierStore.loadSuppliers === "function") {
      suppliersData = supplierStore.loadSuppliers(shop);
    }

    const forecasts = forecastManager.generateForecast(shop, products, salesData, { windowDays });
    const settings = forecastManager.loadForecastSettings(shop);
    const recommendations = forecastManager.generatePurchaseRecommendations(forecasts, {
      ...settings,
      suppliersData,
    });

    res.json(recommendations);
  });
});

// Settings forecast
router.get("/api/forecast/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const settings = forecastManager.loadForecastSettings(shop);
    res.json({ settings });
  });
});

router.post("/api/forecast/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const settings = forecastManager.saveForecastSettings(shop, req.body);
    res.json({ success: true, settings });
  });
});

// ============================================
// INVENTAIRE API (Sessions, Comptage, Audit)
// ============================================

// Liste des sessions d'inventaire
router.get("/api/inventory/sessions", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Vérifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_inventory");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    const { status, includeArchived } = req.query;
    const sessions = inventoryCountStore.listSessions(shop, { 
      status, 
      includeArchived: includeArchived === "true" 
    });

    res.json({ sessions });
  });
});

// Créer une session
router.post("/api/inventory/sessions", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    if (planManager) {
      const check = planManager.checkLimit(shop, "manage_inventory");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const session = inventoryCountStore.createSession(shop, req.body);
      res.json({ success: true, session });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Détail d'une session
router.get("/api/inventory/sessions/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    const session = inventoryCountStore.getSession(shop, req.params.id);
    if (!session) return apiError(res, 404, "Session non trouvée");

    const items = inventoryCountStore.getSessionItems(shop, session.id);
    res.json({ session, items });
  });
});

// Modifier une session
router.put("/api/inventory/sessions/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const session = inventoryCountStore.updateSession(shop, req.params.id, req.body);
      res.json({ success: true, session });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Démarrer une session (créer les items)
router.post("/api/inventory/sessions/:id/start", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      // Récupérer les produits du catalogue
      const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const products = snapshot.products || [];

      const result = inventoryCountStore.startSession(shop, req.params.id, products);
      res.json({ success: true, ...result });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Items d'une session
router.get("/api/inventory/sessions/:id/items", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    const { status, search, onlyDiffs, onlyFlagged } = req.query;
    const items = inventoryCountStore.getSessionItems(shop, req.params.id, {
      status,
      search,
      onlyDiffs: onlyDiffs === "true",
      onlyFlagged: onlyFlagged === "true",
    });

    res.json({ items });
  });
});

// Mettre à jour un item
router.put("/api/inventory/sessions/:id/items/:itemId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const item = inventoryCountStore.updateItem(shop, req.params.id, req.params.itemId, req.body);
      res.json({ success: true, item });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Mise à jour en masse (autosave)
router.post("/api/inventory/sessions/:id/items/bulk-upsert", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const items = req.body.items || [];
      const results = inventoryCountStore.bulkUpsertItems(shop, req.params.id, items);
      res.json({ success: true, updated: results.length });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Valider une session (review)
router.post("/api/inventory/sessions/:id/review", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const session = inventoryCountStore.reviewSession(shop, req.params.id);
      res.json({ success: true, session });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Appliquer les ajustements
router.post("/api/inventory/sessions/:id/apply", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const result = inventoryCountStore.applySession(shop, req.params.id, {
        stockManager: stock,
        allowNegative: req.body.allowNegative === true,
      });
      res.json({ success: true, ...result });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Archiver une session
router.delete("/api/inventory/sessions/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const session = inventoryCountStore.archiveSession(shop, req.params.id);
      res.json({ success: true, session });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Dupliquer une session
router.post("/api/inventory/sessions/:id/duplicate", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      const session = inventoryCountStore.duplicateSession(shop, req.params.id);
      res.json({ success: true, session });
    } catch (e) {
      return apiError(res, 400, e.message);
    }
  });
});

// Événements d'audit
router.get("/api/inventory/events", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    const { sessionId, productId, source, from, to, limit } = req.query;
    const events = inventoryCountStore.listEvents(shop, {
      sessionId,
      productId,
      source,
      from,
      to,
      limit: parseInt(limit) || 100,
    });

    res.json({ events });
  });
});

// Stats inventaire
router.get("/api/inventory/stats", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    const { from, to } = req.query;
    const stats = inventoryCountStore.getInventoryStats(shop, { from, to });
    res.json(stats);
  });
});

// ============================================
// ROUTES PRO (Batches, Suppliers, PO, Forecast, Kits, Inventory)
// ============================================
try {
  require("./server-pro-routes")(router, { getShop, apiError, safeJson });
} catch (e) {
  console.warn("Routes PRO non chargees:", e.message);
}

router.use("/api", (req, res) => apiError(res, 404, "Route API non trouvee"));

router.use((err, req, res, next) => {
  if (req.path.startsWith("/api")) {
    logEvent("api_uncaught_error", extractShopifyError(err), "error");
    return apiError(res, 500, "Erreur serveur API");
  }
  next(err);
});

// Front SPA
router.get("/", (req, res) => res.sendFile(INDEX_HTML));
router.get(/^\/(?!api\/|webhooks\/|health|css\/|js\/).*/, (req, res) => res.sendFile(INDEX_HTML));

// =====================================================
// WEBHOOKS
// =====================================================

// ✅ DURCISSEMENT #3 : purge complete + cache (et hooks optionnels stock/catalog)
async function purgeShopData(shop) {
  const s = normalizeShopDomain(String(shop || "").trim());
  if (!s) return;

  try {
    // tokens
    if (tokenStore?.removeToken) await tokenStore.removeToken(s);

    // mouvements
    if (movementStore?.clearShopMovements) await movementStore.clearShopMovements(s);

    // settings
    if (settingsStore?.removeSettings) await settingsStore.removeSettings(s);

    // cache locationId
    _cachedLocationIdByShop.delete(String(s).trim().toLowerCase());

    // stock/catalog (optionnels selon tes modules)
    if (typeof stock.removeShop === "function") {
      await stock.removeShop(s);
    } else if (typeof stock.clearShop === "function") {
      await stock.clearShop(s);
    }

    if (typeof catalogStore.removeShop === "function") {
      await catalogStore.removeShop(s);
    } else if (typeof catalogStore.clearShop === "function") {
      await catalogStore.clearShop(s);
    }

    logEvent("shop_data_purged", { shop: s }, "info");
  } catch (err) {
    logEvent("purge_shop_data_error", { error: err.message, shop: s }, "error");
    throw new Error("Erreur lors de la purge des donnees");
  }
}

// Webhook pour la desinstallation de l'application
app.post("/webhooks/app/uninstalled", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!requireVerifiedWebhook(req, res)) return res.sendStatus(401);

    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const shop = getShopFromWebhook(req, payload);
    if (!shop) return res.sendStatus(200);

    await purgeShopData(shop);

    res.sendStatus(200);
  } catch (err) {
    logEvent("webhook_app_uninstalled_error", { error: err.message }, "error");
    res.sendStatus(500);
  }
});

// Webhook pour la demande de donnees clients
app.post("/webhooks/customers/data_request", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!requireVerifiedWebhook(req, res)) return res.sendStatus(401);

    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const shop = getShopFromWebhook(req, payload);
    if (!shop) return res.sendStatus(200);

    res.sendStatus(200);
  } catch (err) {
    logEvent("webhook_data_request_error", { error: err.message }, "error");
    res.sendStatus(500);
  }
});

// Webhook pour la demande de suppression des donnees clients
app.post("/webhooks/customers/redact", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!requireVerifiedWebhook(req, res)) return res.sendStatus(401);

    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const shop = getShopFromWebhook(req, payload);
    if (!shop) return res.sendStatus(200);

    res.sendStatus(200);
  } catch (err) {
    logEvent("webhook_redact_error", { error: err.message }, "error");
    res.sendStatus(500);
  }
});

// Webhook pour la suppression des donnees du shop
app.post("/webhooks/shop/redact", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!requireVerifiedWebhook(req, res)) return res.sendStatus(401);

    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const shop = getShopFromWebhook(req, payload);
    if (!shop) return res.sendStatus(200);

    await purgeShopData(shop);

    res.sendStatus(200);
  } catch (err) {
    logEvent("webhook_shop_redact_error", { error: err.message }, "error");
    res.sendStatus(500);
  }
});

// ✅ Webhook pour les mises à jour d'abonnement (Shopify Billing)
app.post("/webhooks/app_subscriptions/update", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!requireVerifiedWebhook(req, res)) return res.sendStatus(401);

    const headerShop = String(req.get("X-Shopify-Shop-Domain") || "").trim();
    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const shop = normalizeShopDomain(headerShop || "");
    
    if (!shop) {
      logEvent("webhook_subscription_no_shop", { headerShop }, "warn");
      return res.sendStatus(200);
    }

    const subscriptionId = payload?.app_subscription?.admin_graphql_api_id || payload?.id;
    const status = String(payload?.app_subscription?.status || payload?.status || "").toLowerCase();

    logEvent("webhook_subscription_update", { shop, subscriptionId, status }, "info");

    // Si l'abonnement est annule/expire, downgrade vers Free
    if (status === "cancelled" || status === "expired" || status === "frozen") {
      if (planManager) {
        planManager.cancelSubscription(shop);
        logEvent("subscription_auto_cancelled", { shop, status }, "info");
      }
    }

    // Si l'abonnement est actif (apres trial ou renouvellement)
    if (status === "active") {
      // On pourrait mettre à jour le statut local si necessaire
      logEvent("subscription_confirmed_active", { shop }, "info");
    }

    res.sendStatus(200);
  } catch (err) {
    logEvent("webhook_subscription_error", { error: err.message }, "error");
    res.sendStatus(500);
  }
});

app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!requireVerifiedWebhook(req, res)) return res.sendStatus(401);

    const headerShop = String(req.get("X-Shopify-Shop-Domain") || "").trim();
    const payload = JSON.parse(req.body.toString("utf8") || "{}");
    const payloadShop = String(payload?.myshopify_domain || payload?.domain || payload?.shop_domain || "").trim();

    const shop = normalizeShopDomain(headerShop || payloadShop || "");
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

    // ✅ ANALYTICS : Enregistrer la vente complete
    try {
      if (analyticsManager && typeof analyticsManager.recordSaleFromOrder === "function") {
        await analyticsManager.recordSaleFromOrder(shop, payload);
        logEvent("analytics_sale_recorded", { shop, orderId: payload?.id }, "info");
      }
    } catch (e) {
      logEvent("analytics_record_error", { shop, orderId: payload?.id, error: e.message }, "error");
    }

    return res.sendStatus(200);
  } catch (e) {
    logEvent("webhook_error", extractShopifyError(e), "error");
    return res.sendStatus(500);
  }
});

// Mount router en "prefix-safe"
app.use("/", router);
app.use("/apps/:appSlug", router);


app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", { port: PORT, indexHtml: INDEX_HTML, apiAuthRequired: API_AUTH_REQUIRED });
  console.log("✅ Server running on port", PORT);
});
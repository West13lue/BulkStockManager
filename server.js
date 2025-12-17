// server.js Ã¢â‚¬â€ PREFIX-SAFE (/apps/<slug>/...), STATIC FIX, JSON API SAFE, Multi-shop safe, Express 5 safe
// Ã¢Å“â€¦ ENRICHI avec CMP, Valeur stock, Stats catÃƒÂ©gories, Suppression mouvements (stub)
// Ã¢Å“â€¦ + OAuth Shopify (Partner) : /api/auth/start + /api/auth/callback
// Ã¢Å“â€¦ + SECURE /api/* (App Store) via Shopify Session Token (JWT HS256)

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// Ã¢Å“â€¦ OAuth token store (Render disk)
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

// --- Shopify client (Ã¢Å“â€¦ par shop)
const {
  getShopifyClient,
  normalizeShopDomain,
  createAppSubscription,
  getActiveAppSubscriptions,
  cancelAppSubscription,
} = require("./shopifyClient");

// --- Stock (source de vÃƒÂ©ritÃƒÂ© app)
const stock = require("./stockManager");

// --- Catalog/categories (multi-shop)
const catalogStore = require("./catalogStore");

// --- Movements (multi-shop)
const movementStore = require("./movementStore");

// --- Analytics (multi-shop) Ã¢Å“â€¦ NOUVEAU
let analyticsStore = null;
let analyticsManager = null;
try {
  analyticsStore = require("./analyticsStore");
  analyticsManager = require("./analyticsManager");
} catch (e) {
  console.warn("Analytics modules non disponibles:", e.message);
}

// --- Plan Manager (Free/Standard/Premium) Ã¢Å“â€¦ NOUVEAU
let planManager = null;
try {
  planManager = require("./planManager");
} catch (e) {
  console.warn("PlanManager non disponible:", e.message);
}

// --- Settings Manager (paramÃƒÂ¨tres avancÃƒÂ©s) Ã¢Å“â€¦ NOUVEAU
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

// Ã¢Å“â€¦ OAuth config
const SHOPIFY_API_KEY = String(process.env.SHOPIFY_API_KEY || "").trim();
const SHOPIFY_API_SECRET = String(process.env.SHOPIFY_API_SECRET || "").trim();
const OAUTH_SCOPES = String(process.env.SHOPIFY_SCOPES || "").trim();

// Ã¢Å“â€¦ API auth switch (en prod => ON par dÃƒÂ©faut)
const API_AUTH_REQUIRED =
  String(process.env.API_AUTH_REQUIRED || "").trim() === ""
    ? process.env.NODE_ENV === "production"
    : String(process.env.API_AUTH_REQUIRED).trim().toLowerCase() !== "false";

// state anti-CSRF simple en mÃƒÂ©moire (ok pour 1 instance Render)
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
  // Ã¢Å“â€¦ prioritÃƒÂ©: shop dÃƒÂ©terminÃƒÂ© par middleware auth (session token)
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

// Ã¢Å“â€¦ OAuth helpers
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
// Ã¢Å“â€¦ Shopify Session Token (JWT)
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

  if (String(header?.alg || "") !== "HS256") return { ok: false, error: "JWT alg non supportÃƒÂ©" };

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
  if (Number.isFinite(exp) && exp <= now) return { ok: false, error: "Session token expirÃƒÂ©" };

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

  // Laisse passer lâ€™OAuth install/callback
  if (req.path === "/auth/start" || req.path === "/auth/callback") return next();

  // âœ… config publique (front App Bridge)
  if (req.path === "/public/config") return next();

  // âœ… returnUrl Shopify Billing (aprÃ¨s acceptation abonnement)
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

    // âœ… Token invalide/rÃ©voquÃ© => purge + renvoi URL de rÃ©auth
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

  // 1) PrioritÃƒÂ© : settings par boutique
  const settings = (settingsStore?.loadSettings && settingsStore.loadSettings(sh)) || {};
  if (settings.locationId) {
    const id = Number(settings.locationId);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  // 2) ENV locationId (Ã¢Å¡Â Ã¯Â¸Â uniquement si la boutique == SHOP_NAME)
  const envShop = resolveShopFallback(); // SHOP_NAME normalisÃƒÂ©
  const envLoc = process.env.SHOPIFY_LOCATION_ID || process.env.LOCATION_ID;

  if (envLoc && envShop && normalizeShopDomain(envShop) === normalizeShopDomain(sh)) {
    const id = Number(envLoc);
    if (Number.isFinite(id) && id > 0) {
      _cachedLocationIdByShop.set(sh, id);
      return id;
    }
  }

  // 3) Sinon : on prend la 1ÃƒÂ¨re location de CETTE boutique (dev/prod)
  const client = shopifyFor(sh);
  const locations = await client.location.list({ limit: 10 });
  const first = Array.isArray(locations) ? locations[0] : null;
  if (!first?.id) throw new Error("Aucune location Shopify trouvÃƒÂ©e");

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
// Ã¢Å“â€¦ DURCISSEMENT #1 : Anti-spoof multi-shop (API)
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
// Ã¢Å“â€¦ DURCISSEMENT #2 : Webhooks shop + HMAC strict
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

// Ã¢Å“â€¦ Public config (sans session token)
router.get("/api/public/config", (req, res) => {
  res.json({
    apiKey: SHOPIFY_API_KEY || "",
    apiAuthRequired: API_AUTH_REQUIRED,
  });
});

// Ã¢Å“â€¦ SECURE toutes les routes /api/*
router.use("/api", requireApiAuth);

// Ã¢Å“â€¦ DURCISSEMENT #1 (suite) : anti-spoof APRES auth
router.use("/api", enforceAuthShopMatch);

// Ã¢Å“â€¦ RÃƒÂ©sout le shop une fois pour toutes (utile pour auto-reauth)
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

router.get("/api/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const settings = (settingsStore?.loadSettings && settingsStore.loadSettings(shop)) || {};
    res.json({ shop, settings });
  });
});

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

// Ã¢Å“â€¦ Valeur totale du stock - STANDARD+ ONLY
router.get("/api/stock/value", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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

// Ã¢Å“â€¦ Stats par catÃƒÂ©gorie - STANDARD+ ONLY
router.get("/api/stats/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan (catÃƒÂ©gories = Standard+)
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

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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
    if (!name) return apiError(res, 400, "Nom de catÃƒÂ©gorie invalide");

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

    // Ã¢Å“â€¦ Appliquer la limite de jours selon le plan
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

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan pour export avancÃƒÂ©
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
    return apiError(res, 501, "Suppression de mouvements non encore implÃƒÂ©mentÃƒÂ©e dans movementStore.");
  });
});

// ✅ NOUVEAU : Détail produit avec variantes et stats
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
    if (!ok) return apiError(res, 404, "Produit introuvable (non configurÃƒÂ©)");

    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "product_set_categories", productId, gramsDelta: 0, meta: { categoryIds }, shop },
        shop
      );
    }

    res.json({ success: true, productId, categoryIds });
  });
});

// âœ… CrÃ©er un produit manuellement (sans import Shopify)
router.post("/api/products", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const name = String(req.body?.name || "").trim();
    const totalGrams = Number(req.body?.totalGrams || 0);
    const averageCostPerGram = Number(req.body?.averageCostPerGram || 0);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];

    if (!name) return apiError(res, 400, "Nom du produit requis");

    // âœ… VÃ©rifier le plan (limite de produits)
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

    // GÃ©nÃ©rer un ID unique pour le produit manuel
    const productId = `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (typeof stock.upsertImportedProductConfig !== "function") {
      return apiError(res, 500, "stock.upsertImportedProductConfig introuvable");
    }

    // CrÃ©er le produit avec une variante par dÃ©faut (1g)
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

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan (import Shopify = Standard+)
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

      // VÃƒÂ©rifier aussi la limite de produits
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
      variants[String(grams)] = { gramsPerUnit: grams, inventoryItemId: Number(v.inventory_item_id) };
    }

    if (!Object.keys(variants).length) {
      return apiError(res, 400, "Aucune variante avec grammage dÃƒÂ©tectÃƒÂ© (option/title/sku).");
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
      if (!first?.productId) return apiError(res, 400, "Aucun produit configurÃƒÂ© pour test");
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
      return apiError(res, 500, "Ãƒâ€°chec ÃƒÂ©change token", { status: tokenRes.status, body: tokenJson });
    }

    tokenStore.saveToken(shop, tokenJson.access_token, { scope: tokenJson.scope });

    res.type("html").send(`
      <div style="font-family:system-ui;padding:24px">
        <h2>Ã¢Å“â€¦ OAuth OK</h2>
        <p>Token enregistrÃƒÂ© pour <b>${shop}</b>.</p>
        <p>Tu peux fermer cette page et relancer l'app.</p>
      </div>
    `);
  });
});

// =====================================================
// SETTINGS ROUTES Ã¢Å“â€¦ NOUVEAU (ParamÃƒÂ¨tres avancÃƒÂ©s)
// =====================================================

// RÃƒÂ©cupÃƒÂ©rer tous les paramÃƒÂ¨tres
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

// RÃƒÂ©cupÃƒÂ©rer une section
router.get("/api/settings/:section", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const section = String(req.params.section);
    const settings = settingsManager.loadSettings(shop);
    if (!settings[section]) return apiError(res, 404, `Section '${section}' non trouvÃƒÂ©e`);
    res.json({ section, settings: settings[section] });
  });
});

// Mettre ÃƒÂ  jour une section
router.put("/api/settings/:section", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const currentSettings = settingsManager.loadSettings(shop);
    if (currentSettings.security?.readOnlyMode) {
      return res.status(403).json({ error: "readonly_mode", message: "Mode lecture seule activÃƒÂ©" });
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

// Reset paramÃƒÂ¨tres
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
// PLAN ROUTES Ã¢Å“â€¦ Billing Shopify (AppSubscription)
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
  // en prod => false par dÃƒÂ©faut
  const v = String(process.env.SHOPIFY_BILLING_TEST || "").trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return process.env.NODE_ENV !== "production";
}

// Info sur le plan actuel
router.get("/api/plan", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    console.log(`Ã°Å¸â€œâ€¹ API /api/plan called - shop from request: "${shop}"`);
    console.log(`   Query params: ${JSON.stringify(req.query)}`);
    console.log(`   Headers x-shop-domain: ${req.headers["x-shop-domain"]}`);

    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    // Compter les produits actuels
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;

    const planInfo = planManager.getPlanInfoForUI(shop, productCount);
    console.log(`   Plan result: ${planInfo.current?.planId} (bypass: ${planInfo.bypass || false})`);
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

// Ã¢Å“â€¦ Retour Billing Shopify (aprÃƒÂ¨s acceptation abonnement)
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
        <div style="font-family:system-ui;padding:24px">
          <h2>Ã¢Å“â€¦ Plan activÃƒÂ© (bypass)</h2>
          <p>Boutique: <b>${shop}</b></p>
          <p>Plan: <b>${String(bypassPlan).toUpperCase()}</b></p>
          <p>Tu peux fermer cette page.</p>
        </div>
      `);
    }

    // VÃƒÂ©rifier que Shopify a bien un abonnement actif
    const subs = await getActiveAppSubscriptions(shop);

    // On prend le plus rÃƒÂ©cent (souvent 1 seul)
    const chosen = Array.isArray(subs) && subs.length ? subs[0] : null;

    if (!chosen?.id) {
      // Le marchand a peut-ÃƒÂªtre fermÃƒÂ© avant de confirmer
      return res.type("html").send(`
        <div style="font-family:system-ui;padding:24px">
          <h2>Ã¢Å¡Â Ã¯Â¸Â Abonnement non dÃƒÂ©tectÃƒÂ©</h2>
          <p>Boutique: <b>${shop}</b></p>
          <p>Aucun abonnement actif trouvÃƒÂ© cÃƒÂ´tÃƒÂ© Shopify.</p>
          <p>Retourne dans lÃ¢â‚¬â„¢app et relance lÃ¢â‚¬â„¢upgrade.</p>
        </div>
      `);
    }

    // Stocker localement (source de vÃƒÂ©ritÃƒÂ© app = plan.json)
    const result = planManager.setShopPlan(shop, planId, {
      id: chosen.id,
      status: String(chosen.status || "ACTIVE").toLowerCase(), // "active" / "trialing" etc (best effort)
      startedAt: chosen.createdAt || new Date().toISOString(),
      expiresAt: null,
      interval: interval === "yearly" ? "annual" : "monthly",
    });

    logEvent("billing_confirmed", { shop, planId, subId: chosen.id, status: chosen.status }, "info");

    return res.type("html").send(`
      <div style="font-family:system-ui;padding:24px">
        <h2>Ã¢Å“â€¦ Abonnement activÃƒÂ©</h2>
        <p>Boutique: <b>${shop}</b></p>
        <p>Plan: <b>${planId.toUpperCase()}</b></p>
        <p>Statut: <b>${String(chosen.status || "")}</b></p>
        <p>Tu peux fermer cette page et retourner dans lÃ¢â‚¬â„¢app.</p>
      </div>
    `);
  });
});

// Ã¢Å“â€¦ Upgrade: crÃƒÂ©e un abonnement Shopify et renvoie confirmationUrl
router.post("/api/plan/upgrade", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    const planId = String(req.body?.planId || "").toLowerCase();
    const interval = String(req.body?.interval || "monthly").toLowerCase(); // "monthly" | "yearly"

    if (!planManager.PLANS[planId]) return apiError(res, 400, `Plan inconnu: ${planId}`);
    if (planId === "free") {
      // Si lÃ¢â‚¬â„¢utilisateur downgrade vers free => passe par cancel
      return apiError(res, 400, "Pour revenir en Free, utilise /api/plan/cancel");
    }

    // Ã¢Å“â€¦ Bypass billing => on fixe direct sans Shopify
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

    // Ã¢Å“â€¦ Si dÃƒÂ©jÃƒÂ  un abonnement actif Shopify => on ÃƒÂ©vite doublon
    const existingSubs = await getActiveAppSubscriptions(shop);
    if (Array.isArray(existingSubs) && existingSubs.length) {
      return res.status(409).json({
        error: "billing_already_active",
        message: "Un abonnement Shopify est dÃƒÂ©jÃƒÂ  actif pour cette boutique. Annule avant de recrÃƒÂ©er.",
        subscriptions: existingSubs.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      });
    }

    const billingCfg = getBillingConfigForPlan(planId, interval);
    if (!billingCfg) return apiError(res, 400, "Plan non billable (config)");

    const returnUrl = buildBillingReturnUrl(shop, planId, interval);

    // Trial: 14 jours par dÃƒÂ©faut (dÃƒÂ©sactivable)
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
        message: "Shopify a refusÃƒÂ© la crÃƒÂ©ation dÃ¢â‚¬â„¢abonnement",
        userErrors: created.userErrors,
      });
    }

    if (!created.confirmationUrl) {
      return res.status(500).json({
        error: "billing_no_confirmation_url",
        message: "Aucune confirmationUrl retournÃƒÂ©e par Shopify",
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

// Ã¢Å“â€¦ Cancel: annule lÃ¢â‚¬â„¢abonnement Shopify + downgrade local en Free
router.post("/api/plan/cancel", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    // Bypass => on ne cancel pas Shopify (il nÃ¢â‚¬â„¢y a rien), et ÃƒÂ§a restera bypass
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

    // SÃ¢â‚¬â„¢il nÃ¢â‚¬â„¢y a rien cÃƒÂ´tÃƒÂ© Shopify, on downgrade quand mÃƒÂªme localement
    if (!sub?.id) {
      const result = planManager.cancelSubscription(shop);
      logEvent("plan_cancelled_no_shopify_sub", { shop }, "warn");
      return res.json({ success: true, shopifyCancelled: false, ...result });
    }

    const cancelled = await cancelAppSubscription(shop, sub.id, { prorate: true, reason: "OTHER" });

    if (cancelled.userErrors && cancelled.userErrors.length) {
      return res.status(400).json({
        error: "billing_cancel_user_errors",
        message: "Shopify a refusÃƒÂ© lÃ¢â‚¬â„¢annulation",
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

// VÃƒÂ©rifier une limite spÃƒÂ©cifique
router.get("/api/plan/check/:action", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    const action = String(req.params.action);

    // Context pour certaines vÃƒÂ©rifications
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
// ANALYTICS ROUTES Ã¢Å“â€¦ NOUVEAU
// =====================================================

// Summary (KPIs globaux) - Ã¢Å“â€¦ PREMIUM ONLY
router.get("/api/analytics/summary", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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

// Timeseries (donnÃƒÂ©es graphiques) - Ã¢Å“â€¦ PREMIUM ONLY
router.get("/api/analytics/timeseries", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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

// Liste des commandes rÃƒÂ©centes - Ã¢Å“â€¦ PREMIUM ONLY
router.get("/api/analytics/orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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

// Top produits - Ã¢Å“â€¦ PREMIUM ONLY
router.get("/api/analytics/products/top", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // Ã¢Å“â€¦ VÃƒÂ©rifier le plan
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

// Stats d'un produit spÃƒÂ©cifique
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

// Stats par catÃƒÂ©gorie
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
// ROUTES PRO (Batches, Suppliers, PO, Forecast, Kits, Inventory)
// ============================================
try {
  require("./server-pro-routes")(router, { getShop, apiError, safeJson });
} catch (e) {
  console.warn("Routes PRO non chargees:", e.message);
}

router.use("/api", (req, res) => apiError(res, 404, "Route API non trouvÃƒÂ©e"));

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

// Ã¢Å“â€¦ DURCISSEMENT #3 : purge complÃƒÂ¨te + cache (et hooks optionnels stock/catalog)
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
    throw new Error("Erreur lors de la purge des donnÃƒÂ©es");
  }
}

// Webhook pour la dÃƒÂ©sinstallation de l'application
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

// Webhook pour la demande de donnÃƒÂ©es clients
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

// Webhook pour la demande de suppression des donnÃƒÂ©es clients
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

// Webhook pour la suppression des donnÃƒÂ©es du shop
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

// âœ… Webhook pour les mises Ã  jour d'abonnement (Shopify Billing)
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

    // Si l'abonnement est annulÃ©/expirÃ©, downgrade vers Free
    if (status === "cancelled" || status === "expired" || status === "frozen") {
      if (planManager) {
        planManager.cancelSubscription(shop);
        logEvent("subscription_auto_cancelled", { shop, status }, "info");
      }
    }

    // Si l'abonnement est actif (aprÃ¨s trial ou renouvellement)
    if (status === "active") {
      // On pourrait mettre Ã  jour le statut local si nÃ©cessaire
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

    // Ã¢Å“â€¦ ANALYTICS : Enregistrer la vente complÃƒÂ¨te
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
  console.log("Ã¢Å“â€¦ Server running on port", PORT);
});

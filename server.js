// ---
// ---
// ---
// ---

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// Compression gzip pour les réponses
let compression;
try {
  compression = require("compression");
} catch (e) {
  compression = null;
}

// Rate limiting pour protection API
let rateLimit;
try {
  rateLimit = require("express-rate-limit");
} catch (e) {
  rateLimit = null;
}

// Webhook deduplication - prevents processing same order multiple times
const processedWebhooks = new Map(); // orderId -> timestamp
const WEBHOOK_DEDUP_TTL = 24 * 60 * 60 * 1000; // 24h

function isWebhookDuplicate(orderId) {
  if (!orderId) return false;
  const key = String(orderId);
  if (processedWebhooks.has(key)) return true;
  processedWebhooks.set(key, Date.now());
  // Cleanup old entries every 100 additions
  if (processedWebhooks.size % 100 === 0) {
    const cutoff = Date.now() - WEBHOOK_DEDUP_TTL;
    for (const [k, ts] of processedWebhooks) {
      if (ts < cutoff) processedWebhooks.delete(k);
    }
  }
  return false;
}

// OAuth token store (Render disk)
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

// ---
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
const notificationStore = require("./notificationStore");

// --- Batch/Lots tracking (multi-shop) - PRO
let batchStore = null;
try {
  batchStore = require("./batchStore");
} catch (e) {
  // BatchStore optionnel non charge
}

// --- Supplier Store (multi-shop) - PRO
let supplierStore = null;
try {
  supplierStore = require("./supplierStore");
} catch (e) {
  // SupplierStore optionnel non charge
}

// --- Purchase Order Store (multi-shop) - Business
let purchaseOrderStore = null;
try {
  purchaseOrderStore = require("./purchaseOrderStore");
} catch (e) {
  // PurchaseOrderStore optionnel non charge
}

// --- Sales Order Store (multi-shop) - PRO
let salesOrderStore = null;
try {
  salesOrderStore = require("./salesOrderStore");
} catch (e) {
  // SalesOrderStore optionnel non charge
}

// ---
let analyticsStore = null;
let analyticsManager = null;
try {
  analyticsStore = require("./analyticsStore");
  analyticsManager = require("./analyticsManager");
} catch (e) {
  // Analytics modules optionnels non charges
}

// ---
let planManager = null;
try {
  planManager = require("./planManager");
} catch (e) {
  // PlanManager optionnel non charge
}

// ---
let settingsManager = null;
try {
  settingsManager = require("./settingsManager");
} catch (e) {
  // SettingsManager optionnel non charge
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

// --- Product Overrides (poids fixe ou suivi a l'unite par produit)
let productOverridesStore = null;
try {
  productOverridesStore = require("./productOverridesStore");
} catch (e) {
  productOverridesStore = {
    getOverride: () => null,
    setOverride: () => null,
    removeOverride: () => false,
    listOverrides: () => ({}),
  };
}

// --- Kit Store (Kits & Bundles)
let kitStore = null;
try {
  kitStore = require("./kitStore");
} catch (e) {
  // KitStore optionnel non charge
}
// --- Inventory Count Store (Sessions d'inventaire)
let inventoryCountStore = null;
try {
  inventoryCountStore = require("./inventoryCountStore");
} catch (e) {
  // InventoryCountStore optionnel non charge
}
// --- Forecast Manager (Previsions)
let forecastManager = null;
try {
  forecastManager = require("./forecastManager");
} catch (e) {
  // ForecastManager optionnel non charge
}

// --- User Profile Store (Profils utilisateurs)
let userProfileStore = null;
try {
  userProfileStore = require("./userProfileStore");
} catch (e) {
  // UserProfileStore optionnel non charge
}


// ---
const SHOPIFY_API_KEY = String(process.env.SHOPIFY_API_KEY || "").trim();
const SHOPIFY_API_SECRET = String(process.env.SHOPIFY_API_SECRET || "").trim();
const OAUTH_SCOPES = String(process.env.SHOPIFY_SCOPES || "").trim();

// ---
const API_AUTH_REQUIRED =
  String(process.env.API_AUTH_REQUIRED || "").trim() === ""
    ? process.env.NODE_ENV === "production"
    : String(process.env.API_AUTH_REQUIRED).trim().toLowerCase() !== "false";

// state anti-CSRF simple en memoire (ok pour 1 instance Render)
const _oauthStateByShop = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

// Appliquer compression gzip si disponible
if (compression) {
  app.use(compression());
  logEvent("compression_enabled", { type: "gzip" });
}

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
  // ---
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

// Helpers de validation des inputs
function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

function validatePositiveNumber(value, fieldName) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return { valid: false, error: `${fieldName} doit etre un nombre positif` };
  }
  return { valid: true, value: num };
}

function validateRequiredString(value, fieldName, maxLength = 500) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return { valid: false, error: `${fieldName} est requis` };
  }
  return { valid: true, value: sanitizeString(value, maxLength) };
}

function validateEmail(email) {
  if (!email) return { valid: true, value: '' };
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Email invalide' };
  }
  return { valid: true, value: sanitizeString(email, 254) };
}

// ---
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
// ---
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

  // ---
  if (req.path === "/public/config") return next();

  // ---
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

    // ---
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

function parseGramsFromVariant(v, productTitle) {
  // 1) Priorité: utiliser le champ "grams" de Shopify (toujours en grammes)
  if (v?.grams && Number.isFinite(Number(v.grams)) && Number(v.grams) > 0) {
    return Number(v.grams);
  }

  // 2) Sinon: parser depuis option1/option2/option3/title/sku avec détection de l'unité
  // Fallback final: product.title (utile pour les packs nommes "Pack 7,5g" avec variante "Default Title")
  const candidates = [v?.option1, v?.option2, v?.option3, v?.title, v?.sku, productTitle].filter(Boolean);
  
  // Facteurs de conversion vers grammes
  const unitFactors = {
    'g': 1,
    'gr': 1,
    'gram': 1,
    'grams': 1,
    'gramme': 1,
    'grammes': 1,
    'kg': 1000,
    'kilo': 1000,
    'kilos': 1000,
    'kilogram': 1000,
    'kilograms': 1000,
    'kilogramme': 1000,
    'kilogrammes': 1000,
    'oz': 28.3495,
    'ounce': 28.3495,
    'ounces': 28.3495,
    'lb': 453.592,
    'lbs': 453.592,
    'pound': 453.592,
    'pounds': 453.592,
    'livre': 453.592,
    'livres': 453.592,
  };
  
  for (const c of candidates) {
    const str = String(c).toLowerCase().trim();
    
    // Pattern: nombre + unité (ex: "0.5kg", "100g", "1 kg", "250 gr")
    const match = str.match(/([\d.,]+)\s*(g|gr|gram|grams|gramme|grammes|kg|kilo|kilos|kilogram|kilograms|kilogramme|kilogrammes|oz|ounce|ounces|lb|lbs|pound|pounds|livre|livres)?/i);
    
    if (match) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!Number.isFinite(value) || value <= 0) continue;
      
      // Détecter l'unité (défaut: grammes si pas d'unité spécifiée)
      const unit = (match[2] || 'g').toLowerCase();
      const factor = unitFactors[unit] || 1;
      
      const grams = value * factor;
      if (grams > 0) return grams;
    }
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

  // 2) ENV locationId (aÂ¡Â iÂ¸Â uniquement si la boutique == SHOP_NAME)
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

// Pousse les unites disponibles (canSell) de chaque variante locale vers Shopify.
// - Une variante en erreur n'interrompt PLUS le push des suivantes (regression
//   precedente : tout `await` qui rejette sortait de la boucle silencieusement,
//   laissant des variantes avec une vieille valeur sur le storefront).
// - Si l'inventory_item n'est pas stocke a la location active, on tente
//   automatiquement un `connect` puis un retry du `set`.
// - Retourne { pushed, skipped, failed[] } pour pouvoir surfacer le detail
//   en API (debug) ; les echecs partiels sont aussi logues en `warn`.
async function pushProductInventoryToShopify(shop, productView) {
  if (!productView?.variants) return { pushed: 0, skipped: 0, failed: [] };

  const client = shopifyFor(shop);
  const locationId = await getLocationIdForShop(shop);

  let pushed = 0;
  let skipped = 0;
  const failed = [];

  const trySet = async (inventoryItemId, available) => {
    await client.inventoryLevel.set({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available,
    });
  };

  for (const [label, v] of Object.entries(productView.variants)) {
    const inventoryItemId = Number(v?.inventoryItemId || 0);
    const unitsAvailable = Math.max(0, Number(v?.canSell || 0));
    if (!inventoryItemId) {
      skipped++;
      continue;
    }

    try {
      await trySet(inventoryItemId, unitsAvailable);
      pushed++;
      continue;
    } catch (err) {
      const info = extractShopifyError(err);
      const status = Number(info?.statusCode || 0);
      const bodyStr = info?.body ? JSON.stringify(info.body) : "";
      const notStocked = status === 422 && /not stocked/i.test(bodyStr + " " + (info?.message || ""));

      if (notStocked) {
        try {
          await client.inventoryLevel.connect({
            location_id: locationId,
            inventory_item_id: inventoryItemId,
          });
          await trySet(inventoryItemId, unitsAvailable);
          pushed++;
          logEvent(
            "inventory_level_reconnected",
            {
              shop,
              productId: productView.productId,
              productName: productView.name,
              variantLabel: label,
              inventoryItemId,
              locationId,
            },
            "info"
          );
          continue;
        } catch (retryErr) {
          failed.push({
            label,
            inventoryItemId,
            gramsPerUnit: Number(v?.gramsPerUnit) || 0,
            requested: unitsAvailable,
            stage: "connect_retry",
            ...extractShopifyError(retryErr),
          });
          continue;
        }
      }

      failed.push({
        label,
        inventoryItemId,
        gramsPerUnit: Number(v?.gramsPerUnit) || 0,
        requested: unitsAvailable,
        stage: "set",
        ...info,
      });
    }
  }

  if (failed.length) {
    logEvent(
      "inventory_push_partial",
      {
        shop,
        productId: productView.productId,
        productName: productView.name,
        locationId,
        pushed,
        skipped,
        failedCount: failed.length,
        failed,
      },
      "warn"
    );
  }

  return { pushed, skipped, failed };
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
// ---
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
// ---
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

// Rate limiting sur les routes API (si disponible)
if (rateLimit) {
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // 200 requêtes par fenêtre par IP
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.use("/api", apiLimiter);
  logEvent("rate_limit_enabled", { windowMs: 900000, max: 200 });
}

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

// ---
router.get("/api/public/config", (req, res) => {
  res.json({
    apiKey: SHOPIFY_API_KEY || "",
    apiAuthRequired: API_AUTH_REQUIRED,
  });
});

// ---
router.use("/api", requireApiAuth);

// ---
router.use("/api", enforceAuthShopMatch);

// ---
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

router.get("/api/settings/location", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const settings = (settingsStore?.loadSettings && settingsStore.loadSettings(shop)) || {};
    res.json({ locationId: settings.locationId || null });
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

    const { sort = "alpha", category = "", categories = "", q = "" } = req.query;
    
    // Support multi-catégories (priorité) ou catégorie unique (rétro-compatibilité)
    let selectedCategories = [];
    if (categories && categories.trim()) {
      selectedCategories = categories.split(",").map(c => c.trim()).filter(Boolean);
    } else if (category) {
      selectedCategories = [category];
    }

    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    const categoriesList = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    let products = Array.isArray(snapshot.products) ? snapshot.products.slice() : [];

    // Decorer chaque produit avec son override (gramsPerUnit fixe ou suivi a l'unite)
    // Quand trackByUnit=true : remplacer totalGrams par le compteur d'unites pour
    // que le frontend affiche "X unites" plutot que "X g" (les variantes ont
    // ete enregistrees avec gramsPerUnit=1 par la sync).
    const overridesMap = (productOverridesStore.listOverrides && productOverridesStore.listOverrides(shop)) || {};
    const includeArchived = String(req.query.includeArchived || "").toLowerCase() === "true";
    const archivedOnly = String(req.query.archivedOnly || "").toLowerCase() === "true";

    products = products.map((p) => {
      const ovr = overridesMap[String(p.productId || p.id || "")];
      if (!ovr) return p;
      const enriched = { ...p, override: ovr };
      if (ovr.trackByUnit) {
        enriched.trackByUnit = true;
        enriched.unitCount = Number(p.totalGrams || 0); // sync stocke gramsPerUnit=1, donc totalGrams = nb unites
      }
      if (Number(ovr.gramsPerUnit) > 0) {
        enriched.gramsPerUnitOverride = Number(ovr.gramsPerUnit);
      }
      if (ovr.archived === true) {
        enriched.archived = true;
        enriched.archivedAt = ovr.archivedAt || null;
      }
      return enriched;
    });

    // Filtrer selon le mode archived
    if (archivedOnly) {
      products = products.filter((p) => p.archived === true);
    } else if (!includeArchived) {
      products = products.filter((p) => p.archived !== true);
    }

    // Filtre par recherche (nom produit)
    if (q && q.trim()) {
      const search = q.trim().toLowerCase();
      products = products.filter((p) => 
        String(p.name || "").toLowerCase().includes(search)
      );
    }

    // Filtre par catégorie(s)
    if (selectedCategories.length > 0) {
      products = products.filter((p) => {
        // Vérifier si au moins une catégorie sélectionnée correspond
        return selectedCategories.some(catId => {
          if (catId === "uncategorized") {
            return !Array.isArray(p.categoryIds) || p.categoryIds.length === 0;
          }
          return Array.isArray(p.categoryIds) && p.categoryIds.includes(String(catId));
        });
      });
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
    } else if (sort === "cmp_asc") {
      products.sort((a, b) => (a.averageCostPerGram || 0) - (b.averageCostPerGram || 0));
    } else if (sort === "cmp_desc") {
      products.sort((a, b) => (b.averageCostPerGram || 0) - (a.averageCostPerGram || 0));
    } else if (sort === "status_asc") {
      const statusOrder = { critical: 0, low: 1, good: 2, ok: 2 };
      products.sort((a, b) => (statusOrder[a.stockStatus] ?? 3) - (statusOrder[b.stockStatus] ?? 3));
    } else if (sort === "status_desc") {
      const statusOrder = { critical: 0, low: 1, good: 2, ok: 2 };
      products.sort((a, b) => (statusOrder[b.stockStatus] ?? 3) - (statusOrder[a.stockStatus] ?? 3));
    }

    // Ajouter compteur produits par categorie
    const categoriesWithCount = categoriesList.map((cat) => {
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

// ---
router.get("/api/stock/value", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ---
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

// ---
router.get("/api/stats/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ---
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
    const categories = snapshot.categories || [];
    
    // Map des catégories pour afficher les noms
    const catMap = {};
    categories.forEach(c => { catMap[c.id] = c.name; });

    // En-têtes lisibles
    const header = [
      "Produit",
      "Reference Shopify",
      "Stock (g)",
      "Stock (kg)",
      "Cout moyen (EUR/kg)",
      "Valeur stock (EUR)",
      "Categories",
      "Statut"
    ].join(";");

    const csvEscape = (v) => {
      const s = String(v ?? "");
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const formatNumber = (num, decimals = 2) => {
      if (num === null || num === undefined || isNaN(num)) return "";
      return Number(num).toFixed(decimals).replace(".", ",");
    };

    const getStatus = (grams) => {
      if (grams <= 0) return "Rupture";
      if (grams < 500) return "Critique";
      if (grams < 2000) return "Bas";
      return "OK";
    };

    const lines = products.map((p) => {
      const grams = p.totalGrams || 0;
      const costPerGram = p.averageCostPerGram || 0;
      const stockValue = grams * costPerGram;
      
      // Convertir les IDs de catégories en noms
      const catNames = Array.isArray(p.categoryIds) 
        ? p.categoryIds.map(id => catMap[id] || id).join(", ")
        : "";
      
      return [
        csvEscape(p.name || "Sans nom"),
        csvEscape(p.productId),
        csvEscape(formatNumber(grams, 0)),
        csvEscape(formatNumber(grams / 1000, 3)),
        csvEscape(formatNumber(costPerGram * 1000)),
        csvEscape(formatNumber(stockValue)),
        csvEscape(catNames),
        csvEscape(getStatus(grams))
      ].join(";");
    });

    // Ligne de résumé
    const totalGrams = products.reduce((sum, p) => sum + (p.totalGrams || 0), 0);
    const totalValue = products.reduce((sum, p) => sum + (p.totalGrams || 0) * (p.averageCostPerGram || 0), 0);
    
    const summaryLine = [
      "TOTAL",
      products.length + " produits",
      formatNumber(totalGrams, 0),
      formatNumber(totalGrams / 1000, 3),
      "",
      formatNumber(totalValue),
      "",
      ""
    ].join(";");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="inventaire-stock.csv"');
    // BOM UTF-8 pour Excel
    res.send("\uFEFF" + [header, ...lines, "", summaryLine].join("\n"));
  });
});

router.get("/api/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // ---
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

    // ---
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

    // ---
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

    // ---
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

    // En-têtes lisibles par l'humain
    const header = [
      "Date",
      "Heure", 
      "Type de mouvement",
      "Produit",
      "Quantite (g)",
      "Quantite (kg)",
      "Prix achat (EUR/kg)",
      "Stock apres (g)",
      "Stock apres (kg)",
      "Utilisateur"
    ].join(";");

    const csvEscape = (v) => {
      const s = String(v ?? "");
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    // Traduire les types de mouvements
    const translateType = (type) => {
      const types = {
        restock: "Reapprovisionnement",
        sale: "Vente",
        adjustment: "Ajustement",
        import: "Import",
        manual: "Manuel",
        order: "Commande",
        kit_assembly: "Assemblage kit",
        transfer: "Transfert",
        batch_add: "Ajout lot",
        batch_consume: "Consommation lot",
        product_created: "Creation produit",
        product_deleted: "Suppression produit"
      };
      return types[type] || type || "Autre";
    };

    // Formater la date lisiblement
    const formatDate = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
    };

    const formatTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    };

    const lines = (rows || []).map((m) => {
      const grams = m.gramsDelta ?? 0;
      const totalGrams = m.totalAfter ?? 0;
      return [
        csvEscape(formatDate(m.ts)),
        csvEscape(formatTime(m.ts)),
        csvEscape(translateType(m.source || m.type)),
        csvEscape(m.productName || m.productId || ""),
        csvEscape(grams),
        csvEscape((grams / 1000).toFixed(3)),
        csvEscape(m.purchasePricePerGram ? (m.purchasePricePerGram * 1000).toFixed(2) : ""),
        csvEscape(totalGrams),
        csvEscape((totalGrams / 1000).toFixed(3)),
        csvEscape(m.profileName || "")
      ].join(";");
    });

    // Utiliser ; comme séparateur pour Excel FR
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="mouvements-stock.csv"');
    // Ajouter BOM UTF-8 pour Excel
    res.send("\uFEFF" + [header, ...lines].join("\n"));
  });
});

// stub suppression mouvements
router.delete("/api/movements/:id", (req, res) => {
  safeJson(req, res, () => {
    return apiError(res, 501, "Suppression de mouvements non encore implementee dans movementStore.");
  });
});

// aœ" NOUVEAU : Detail produit avec variantes et stats
router.get("/api/products/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId || "");
    if (!productId) return apiError(res, 400, "productId manquant");

    // Recuperer le snapshot du produit
    const product = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (!product) return apiError(res, 404, "Produit introuvable");

    // Recuperer les categories
    const allCategories = catalogStore.listCategories ? catalogStore.listCategories(shop) : [];
    const productCategories = allCategories.filter(c => (product.categoryIds || []).includes(c.id));

    // Recuperer les variantes avec calcul des stats
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

    // Calcul du pourcentage (base sur les unites vendables)
    for (const vs of variantStats) {
      vs.shareByUnits = totalCanSell > 0 ? Math.round((vs.canSell / totalCanSell) * 100 * 100) / 100 : 0;
    }

    // Trier par gramsPerUnit croissant
    variantStats.sort((a, b) => a.gramsPerUnit - b.gramsPerUnit);

    // Determiner le statut stock
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
    
    // Recuperer les infos du profil
    const profileId = req.body?.profileId || null;
    const profileName = req.body?.profileName || "User";
    const profileColor = req.body?.profileColor || "#6366f1";

    if (!Number.isFinite(gramsDelta) || gramsDelta === 0) {
      return apiError(res, 400, "gramsDelta invalide (ex: 50 ou -50)");
    }
    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, productId) : 0;
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
          cmpBefore: gramsDelta > 0 && purchasePricePerGram > 0 ? cmpBefore : undefined,
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

// =====================================================
// Product overrides : poids fixe / suivi a l'unite
// =====================================================
router.get("/api/products/:productId/override", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const productId = String(req.params.productId);
    const ovr = productOverridesStore.getOverride(shop, productId) || null;
    res.json({ productId, override: ovr });
  });
});

router.patch("/api/products/:productId/override", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const productId = String(req.params.productId);
    const patch = {};
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "gramsPerUnit")) {
      patch.gramsPerUnit = req.body.gramsPerUnit;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "trackByUnit")) {
      patch.trackByUnit = Boolean(req.body.trackByUnit);
    }
    const next = productOverridesStore.setOverride(shop, productId, patch);
    logEvent("product_override_updated", { shop, productId, patch });
    res.json({ productId, override: next });
  });
});

router.delete("/api/products/:productId/override", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    const productId = String(req.params.productId);
    const removed = productOverridesStore.removeOverride(shop, productId);
    logEvent("product_override_removed", { shop, productId, removed });
    res.json({ productId, removed });
  });
});

// =====================================================
// Shop health : audits locaux pour detecter incoherences
// =====================================================
router.get("/api/shop-health", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const settings = (settingsStore && settingsStore.loadSettings && settingsStore.loadSettings(shop)) || {};
    const overrides = (productOverridesStore.listOverrides && productOverridesStore.listOverrides(shop)) || {};
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];

    const checks = [];

    // ----- Globaux -----
    if (!settings.locationId) {
      checks.push({
        id: "no_location",
        severity: "critical",
        category: "config",
        title: "Aucune location Shopify configuree",
        detail: "Sans locationId, la synchronisation d'inventaire ne sait pas ou ecrire. Configure-la dans Parametres.",
        action: { type: "open_settings", target: "settings" }
      });
    }

    if (products.length === 0) {
      checks.push({
        id: "no_products",
        severity: "warning",
        category: "config",
        title: "Aucun produit synchronise",
        detail: "Lance une synchronisation Shopify pour rapatrier ton catalogue.",
        action: { type: "sync" }
      });
    }

    // ----- Par produit -----
    let fallback1000 = 0;
    let trackedProducts = 0;
    let masterOrphan = 0;
    let cmpSuspect = 0;
    let configuredOverrides = 0;

    for (const p of products) {
      const pid = String(p.productId || p.id || "");
      const ovr = overrides[pid] || null;
      if (ovr) configuredOverrides++;

      const variants = p.variants || {};
      const variantEntries = Object.entries(variants);
      const isTrackByUnit = ovr && ovr.trackByUnit === true;

      // Pas de variantes du tout
      if (variantEntries.length === 0) {
        checks.push({
          id: "no_variants_" + pid,
          severity: "warning",
          category: "products",
          productId: pid,
          productName: p.name,
          title: "Aucune variante valide",
          detail: "Ce produit n'a aucune variante synchronisee. Probleme de synchronisation ou produit Shopify incomplet.",
          action: { type: "open_product", productId: pid }
        });
        continue;
      }

      // Master totalGrams > 0 mais aucune variante avec poids exploitable (sauf trackByUnit)
      if (!isTrackByUnit && (p.totalGrams || 0) > 0) {
        const sellable = variantEntries.some(([_, v]) => Number(v.gramsPerUnit) > 0 && Number(v.canSell) > 0);
        if (!sellable) {
          masterOrphan++;
          checks.push({
            id: "orphan_master_" + pid,
            severity: "warning",
            category: "stock",
            productId: pid,
            productName: p.name,
            title: "Stock impossible a vendre",
            detail: `${p.totalGrams} g en stock mais aucune variante n'a un poids/unite exploitable.`,
            action: { type: "open_product_config", productId: pid }
          });
        }
      }

      // Fallback 1000g detecte (variant gramsPerUnit=1000 sans override et sans label compatible)
      if (!ovr) {
        for (const [label, v] of variantEntries) {
          if (Number(v.gramsPerUnit) === 1000) {
            // Si le label contient explicitement "1000", "1kg" ou "1 kg", c'est OK
            const legitimate = /1000|1\s*kg|kilo/i.test(String(label));
            if (!legitimate) {
              fallback1000++;
              checks.push({
                id: "fallback_1000_" + pid + "_" + label,
                severity: "warning",
                category: "parsing",
                productId: pid,
                productName: p.name,
                variantLabel: label,
                title: "Poids estime par defaut (1 kg)",
                detail: `La variante "${label}" n'expose pas de poids ; le systeme a applique 1 kg/unite par securite. Configure un poids fixe ou active le suivi a l'unite.`,
                action: { type: "open_product_config", productId: pid }
              });
              break; // un seul check par produit, suffit
            }
          }
        }
      }

      // CMP suspect : > 100 €/g (= 100 000 €/kg, absurde meme pour produit haut de gamme)
      const cmp = Number(p.averageCostPerGram) || 0;
      if (cmp > 100) {
        cmpSuspect++;
        checks.push({
          id: "cmp_suspect_" + pid,
          severity: "critical",
          category: "pricing",
          productId: pid,
          productName: p.name,
          title: "CMP anormalement eleve",
          detail: `Cout moyen = ${cmp.toFixed(2)} EUR/g (= ${(cmp * 1000).toFixed(0)} EUR/kg). Probable saisie en EUR/kg traitee comme EUR/g.`,
          action: { type: "open_cmp", productId: pid, currentCMP: cmp }
        });
      }

      if (isTrackByUnit) trackedProducts++;
    }

    // ----- Analytics : detection de ventes aberrantes -----
    let anomalousSales = 0;
    if (analyticsStore && analyticsStore.listSales) {
      try {
        const recentSales = analyticsStore.listSales({ shop, limit: 5000 });
        const aberrant = recentSales.filter((s) => {
          const grams = Number(s.totalGrams) || 0;
          const qty = Number(s.quantity) || 1;
          const cost = Number(s.totalCost) || 0;
          const rev = Number(s.netRevenue) || 0;
          const cpg = Number(s.costPerGram) || 0;
          // Heuristiques :
          //  a) > 1 kg vendus en une ligne = saisie unite probablement fausse
          //  b) costPerGram > 20 EUR/g (= 20k EUR/kg) = irrealiste meme haut de gamme
          //  c) cost > 5x revenue = ratio aberrant (au-dela d'une marge legitimement negative)
          //  d) Perte > 100 EUR sur une seule ligne dans un shop CBD typique
          return (
            (grams > 1000 && qty <= 1) ||
            cpg > 20 ||
            (rev > 0 && cost / rev > 5) ||
            (cost - rev) > 100
          );
        });
        anomalousSales = aberrant.length;
        if (aberrant.length > 0) {
          checks.push({
            id: "anomalous_sales",
            severity: "critical",
            category: "analytics",
            title: aberrant.length + " vente(s) aberrante(s) en analytics",
            detail: "Des enregistrements ont des quantites > 5 kg, un CMP > 100 EUR/g, ou une perte > 1000 EUR par ligne. Probable saisie en mauvaise unite ou bug CMP historique.",
            action: { type: "open_anomalies" },
            anomalousIds: aberrant.slice(0, 50).map((s) => s.id).filter(Boolean),
            anomalousOrderIds: Array.from(new Set(aberrant.map((s) => s.orderId).filter(Boolean))).slice(0, 50)
          });
        }
      } catch (e) {
        // pas bloquant
      }
    }

    // Resume
    const summary = {
      totalProducts: products.length,
      configuredOverrides,
      trackedByUnit: trackedProducts,
      issues: {
        critical: checks.filter((c) => c.severity === "critical").length,
        warning: checks.filter((c) => c.severity === "warning").length,
      },
      counts: {
        fallback1000,
        masterOrphan,
        cmpSuspect,
        anomalousSales,
      },
      locationConfigured: Boolean(settings.locationId),
      locationId: settings.locationId || null,
    };

    res.json({ shop, summary, checks });
  });
});

// =====================================================
// Lister + purger les ventes analytics aberrantes
// =====================================================
router.get("/api/analytics/anomalies", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales) return apiError(res, 500, "Analytics non disponible");

    const allSales = analyticsStore.listSales({ shop, limit: 50000 });
    const anomalies = [];
    for (const s of allSales) {
      const grams = Number(s.totalGrams) || 0;
      const qty = Number(s.quantity) || 1;
      const cost = Number(s.totalCost) || 0;
      const rev = Number(s.netRevenue) || 0;
      const cpg = Number(s.costPerGram) || 0;
      const reasons = [];
      if (grams > 1000 && qty <= 1) reasons.push(`quantite ${grams} g pour 1 unite`);
      if (cpg > 20) reasons.push(`CMP ${cpg.toFixed(2)} EUR/g (= ${(cpg * 1000).toFixed(0)} EUR/kg)`);
      if (rev > 0 && cost / rev > 5) reasons.push(`cout ${(cost / rev).toFixed(1)}x le CA`);
      if ((cost - rev) > 100) reasons.push(`perte ${(cost - rev).toFixed(2)} EUR sur la ligne`);
      if (reasons.length > 0) {
        anomalies.push({
          id: s.id,
          orderId: s.orderId,
          orderNumber: s.orderNumber,
          orderDate: s.orderDate,
          productName: s.productName,
          quantity: qty,
          totalGrams: grams,
          netRevenue: rev,
          totalCost: cost,
          costPerGram: cpg,
          margin: Number(s.margin) || (rev - cost),
          source: s.source,
          reasons,
        });
      }
    }

    anomalies.sort((a, b) => new Date(b.orderDate || 0) - new Date(a.orderDate || 0));
    res.json({ shop, total: anomalies.length, anomalies });
  });
});

// =====================================================
// Ventes analytics : liste + KPIs + tops + produits
// =====================================================
// Source unique de verite = analyticsStore (= meme source que /analytics/orders-debug
// utilise par l'onglet Recap commandes). Garantit que Performance et Recap voient
// EXACTEMENT les memes ventes (Shopify reels + ventes manuelles).
//
// Modes :
//  - ?period=N           -> filtre sur les N derniers jours, retourne KPIs/tops/products
//  - ?from=&to=          -> filtre par dates explicites (utilise par l'editeur)
//  - ?productId=         -> filtre sur un produit (compatible avec les anciens appels)
//  - ?limit=             -> taille max (default 2000, plafond 50000)
//
// La reponse contient TOUJOURS sales[] + kpis + topProducts + products + timeline.
// Les consommateurs (Performance / editeur) prennent ce qu'ils veulent.
router.get("/api/analytics/sales", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales) return apiError(res, 500, "Analytics non disponible");

    // Gating PRO (alignement avec l'ancien endpoint Performance)
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

    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 50000);
    const productId = req.query.productId || null;

    // Determination de la fenetre temporelle
    let from = req.query.from || null;
    let to = req.query.to || null;
    let periodDays = null;
    if (req.query.period != null && req.query.period !== "") {
      const p = parseInt(req.query.period, 10);
      if (Number.isFinite(p) && p > 0) {
        periodDays = p;
        const now = new Date();
        const fromD = new Date(now.getTime() - p * 24 * 60 * 60 * 1000);
        from = fromD.toISOString().slice(0, 10);
        to = now.toISOString().slice(0, 10);
      }
    }

    const sales = analyticsStore.listSales({ shop, from, to, productId, limit });

    // ----- Agregation KPIs / tops / produits -----
    let totalRevenue = 0;
    let totalCost = 0;
    let totalGramsSold = 0;
    let totalQuantitySold = 0;
    const orderIds = new Set();
    const productSales = {};
    const dailySales = {};

    sales.forEach(s => {
      // Schema canonique = netRevenue (cf. analyticsStore.js et webhooks).
      // sellingPriceTotal n'est qu'un alias d'entree pour la vente manuelle ;
      // dans le record stocke le CA est toujours sous netRevenue.
      const revenue = Number(s.netRevenue) || Number(s.sellingPriceTotal) || 0;
      const cost = Number(s.totalCost) || 0;
      const grams = Number(s.totalGrams) || 0;
      const qty = Number(s.quantity) || 0;
      const day = String(s.orderDate || s.ts || "").slice(0, 10);

      totalRevenue += revenue;
      totalCost += cost;
      totalGramsSold += grams;
      totalQuantitySold += qty;
      if (s.orderId) orderIds.add(s.orderId);

      if (day) {
        if (!dailySales[day]) dailySales[day] = { date: day, revenue: 0, cost: 0, margin: 0, orders: new Set() };
        dailySales[day].revenue += revenue;
        dailySales[day].cost += cost;
        if (s.orderId) dailySales[day].orders.add(s.orderId);
      }

      const pid = String(s.productId || "");
      if (pid) {
        if (!productSales[pid]) {
          productSales[pid] = {
            productId: pid,
            name: s.productName || pid,
            quantitySold: 0,
            gramsSold: 0,
            revenue: 0,
            cost: 0,
            margin: 0,
            marginPercent: 0,
            cmp: Number(s.costPerGram) || 0,
          };
        }
        productSales[pid].quantitySold += qty;
        productSales[pid].gramsSold += grams;
        productSales[pid].revenue += revenue;
        productSales[pid].cost += cost;
      }
    });

    Object.values(productSales).forEach(p => {
      p.margin = p.revenue - p.cost;
      p.marginPercent = p.revenue > 0 ? Math.round((p.margin / p.revenue) * 100) : 0;
      p.revenue = Math.round(p.revenue * 100) / 100;
      p.cost = Math.round(p.cost * 100) / 100;
      p.margin = Math.round(p.margin * 100) / 100;
      p.gramsSold = Math.round(p.gramsSold);
    });

    const productList = Object.values(productSales);
    const topByRevenue = [...productList].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    const topByMargin = [...productList].sort((a, b) => b.margin - a.margin).slice(0, 5);
    const topByMarginPercent = [...productList].filter(p => p.revenue > 10).sort((a, b) => b.marginPercent - a.marginPercent).slice(0, 5);
    const topByVolume = [...productList].sort((a, b) => b.gramsSold - a.gramsSold).slice(0, 5);
    const worstByMargin = [...productList].filter(p => p.revenue > 10).sort((a, b) => a.marginPercent - b.marginPercent).slice(0, 5);

    const totalMargin = totalRevenue - totalCost;
    const marginPercent = totalRevenue > 0 ? Math.round((totalMargin / totalRevenue) * 100) : 0;
    const totalOrders = orderIds.size;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const avgCMP = totalGramsSold > 0 ? totalCost / totalGramsSold : 0;
    const avgSellingPrice = totalGramsSold > 0 ? totalRevenue / totalGramsSold : 0;

    const timeline = Object.values(dailySales)
      .map(d => ({
        date: d.date,
        revenue: Math.round(d.revenue * 100) / 100,
        cost: Math.round(d.cost * 100) / 100,
        margin: Math.round((d.revenue - d.cost) * 100) / 100,
        marginPercent: d.revenue > 0 ? Math.round(((d.revenue - d.cost) / d.revenue) * 100) : 0,
        orders: d.orders.size,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      shop,
      total: sales.length,
      sales,
      period: periodDays
        ? { days: periodDays, from, to }
        : { from, to },
      kpis: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalMargin: Math.round(totalMargin * 100) / 100,
        marginPercent,
        totalOrders,
        totalQuantitySold,
        totalGramsSold: Math.round(totalGramsSold),
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        avgCMP: Math.round(avgCMP * 100) / 100,
        avgSellingPrice: Math.round(avgSellingPrice * 100) / 100,
      },
      topProducts: {
        byRevenue: topByRevenue,
        byMargin: topByMargin,
        byMarginPercent: topByMarginPercent,
        byVolume: topByVolume,
        worstMargin: worstByMargin,
      },
      timeline,
      products: productList.sort((a, b) => b.revenue - a.revenue),
    });
  });
});

router.patch("/api/analytics/sales/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.updateSale) return apiError(res, 500, "Editeur indisponible");

    const id = String(req.params.id || "").trim();
    if (!id) return apiError(res, 400, "id manquant");

    const next = analyticsStore.updateSale(shop, id, req.body || {});
    if (!next) return apiError(res, 404, "Vente introuvable");
    logEvent("analytics_sale_updated", { shop, id });
    res.json({ success: true, sale: next });
  });
});

router.delete("/api/analytics/sales/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.deleteSale) return apiError(res, 500, "Editeur indisponible");

    const id = String(req.params.id || "").trim();
    if (!id) return apiError(res, 400, "id manquant");

    const removed = analyticsStore.deleteSale(shop, id);
    if (!removed) return apiError(res, 404, "Vente introuvable");
    logEvent("analytics_sale_deleted", { shop, id });
    res.json({ success: true, removed: true });
  });
});

// Fusionner plusieurs commandes en une seule (analytics seulement)
// Utile quand l'utilisateur a fait plusieurs ventes manuelles separees
// qui auraient du etre une seule commande multi-produits.
router.post("/api/analytics/merge-orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales || !analyticsStore.rewriteAllSales) {
      return apiError(res, 500, "Editeur indisponible");
    }

    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map(String) : [];
    if (orderIds.length < 2) return apiError(res, 400, "Au moins 2 commandes a fusionner");

    const targetName = String(req.body?.targetOrderName || "").trim();
    const orderIdSet = new Set(orderIds);

    const allSales = analyticsStore.listSales({ shop, limit: 50000 });
    const matched = allSales.filter((s) => orderIdSet.has(String(s.orderId)));
    if (matched.length === 0) return apiError(res, 404, "Aucune vente trouvee pour ces orderIds");

    // Canonique = la plus ancienne (premiere chronologiquement) pour ne pas
    // creer de nouvel orderId, on garde le premier vrai. On reattribue son
    // orderId, orderNumber et orderName aux autres lignes.
    matched.sort((a, b) => new Date(a.orderDate || a.ts || 0) - new Date(b.orderDate || b.ts || 0));
    const canonical = matched[0];
    const targetOrderId = canonical.orderId;
    const targetOrderNumber = canonical.orderNumber || canonical.orderId;
    const finalOrderName = targetName || canonical.orderName || "";

    let touched = 0;
    const next = allSales.map((s) => {
      if (!orderIdSet.has(String(s.orderId))) return s;
      touched++;
      return {
        ...s,
        orderId: targetOrderId,
        orderNumber: targetOrderNumber,
        orderName: finalOrderName || s.orderName || "",
        updatedAt: new Date().toISOString(),
      };
    });

    analyticsStore.rewriteAllSales(shop, next);
    logEvent("analytics_orders_merged", { shop, mergedCount: orderIds.length, lineCount: touched, targetOrderId });

    res.json({
      success: true,
      mergedCount: orderIds.length,
      lineCount: touched,
      targetOrderId,
      targetOrderNumber,
      targetOrderName: finalOrderName || null,
    });
  });
});

router.post("/api/analytics/wipe", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const confirm = String(req.body?.confirm || "").toUpperCase();
    if (confirm !== "RESET") return apiError(res, 400, "Confirmation requise (envoyer { confirm: 'RESET' })");

    try {
      if (typeof analyticsStore.clearShopAnalytics === "function") {
        analyticsStore.clearShopAnalytics(shop);
      } else {
        // Fallback : supprimer manuellement le dossier analytics
        const fs = require("fs");
        const path = require("path");
        const DATA_DIR = process.env.DATA_DIR || "/var/data";
        const analyticsDir = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"), "analytics");
        if (fs.existsSync(analyticsDir)) {
          fs.rmSync(analyticsDir, { recursive: true, force: true });
        }
      }
      logEvent("analytics_wiped", { shop });
      res.json({ success: true, shop });
    } catch (e) {
      logEvent("analytics_wipe_error", { shop, error: e.message }, "error");
      return apiError(res, 500, "Erreur de purge: " + e.message);
    }
  });
});

router.post("/api/analytics/anomalies/purge", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales) return apiError(res, 500, "Analytics non disponible");

    const idsRaw = Array.isArray(req.body?.saleIds) ? req.body.saleIds : null;
    const orderIdsRaw = Array.isArray(req.body?.orderIds) ? req.body.orderIds : null;
    if (!idsRaw && !orderIdsRaw) return apiError(res, 400, "Fournis saleIds ou orderIds");

    const idSet = new Set((idsRaw || []).map(String));
    const orderSet = new Set((orderIdsRaw || []).map(String));

    const allSales = analyticsStore.listSales({ shop, limit: 50000 });
    const kept = [];
    let removed = 0;
    for (const s of allSales) {
      const matchId = s.id && idSet.has(String(s.id));
      const matchOrder = s.orderId && orderSet.has(String(s.orderId));
      if (matchId || matchOrder) {
        removed++;
      } else {
        kept.push(s);
      }
    }

    if (removed === 0) return res.json({ success: true, removed: 0, kept: kept.length });

    try {
      const fs = require("fs");
      const path = require("path");
      const DATA_DIR = process.env.DATA_DIR || "/var/data";
      const analyticsDir = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"), "analytics");

      const byMonth = new Map();
      for (const sale of kept) {
        const d = new Date(sale.orderDate || sale.ts || Date.now());
        const monthKey = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
        byMonth.get(monthKey).push(sale);
      }

      if (fs.existsSync(analyticsDir)) {
        const files = fs.readdirSync(analyticsDir).filter((f) => f.endsWith(".ndjson") || f.endsWith(".jsonl"));
        for (const file of files) fs.unlinkSync(path.join(analyticsDir, file));
      } else {
        fs.mkdirSync(analyticsDir, { recursive: true });
      }

      for (const [monthKey, sales] of byMonth) {
        const filePath = path.join(analyticsDir, monthKey + ".ndjson");
        const content = sales.map((s) => JSON.stringify(s)).join("\n") + (sales.length ? "\n" : "");
        fs.writeFileSync(filePath, content, "utf8");
      }

      logEvent("analytics_anomalies_purged", { shop, removed, kept: kept.length });
      res.json({ success: true, removed, kept: kept.length });
    } catch (e) {
      logEvent("analytics_anomalies_purge_error", { shop, error: e.message }, "error");
      return apiError(res, 500, "Erreur purge: " + e.message);
    }
  });
});

// =====================================================
// Shop health : auto-fix base sur des heuristiques de noms
// =====================================================
function inferProductFix(productName) {
  const name = String(productName || "").toLowerCase();
  if (!name) return null;

  // Huiles / tinctures : flacons, vendus a l'unite
  const oilPatterns = [
    /\bhuile\b/, /\boil\b/, /tincture/, /teinture/,
    /\bflacon\b/, /\bbottle\b/, /goutte/, /\bdrops?\b/
  ];
  for (const pat of oilPatterns) {
    if (pat.test(name)) {
      return {
        type: "trackByUnit",
        patch: { trackByUnit: true, gramsPerUnit: null },
        reason: "Huile / flacon detecte (suivi a l'unite, pas au gramme)"
      };
    }
  }

  // Accessoires (suivi a l'unite)
  const accessoryPatterns = [
    /briquet/, /lighter/, /grinder/, /plateau/, /tray/, /cendrier/, /ashtray/,
    /sticker/, /t-?shirt/, /casquette/, /\bcap\b/, /mug/,
    /\bocb\b/, /\bpapers?\b/, /\brolling\b/, /\bfeuilles?\b/, /\bfiltres?\b/, /\btips?\b/,
    /\bkit\b/, /accessoire/, /accessories/, /\bbong\b/, /\bpipe\b/, /vaporisateur/, /vapo\b/,
    /\bsac\b/, /\bbag\b/, /pochette/
  ];
  for (const pat of accessoryPatterns) {
    if (pat.test(name)) {
      return {
        type: "trackByUnit",
        patch: { trackByUnit: true, gramsPerUnit: null },
        reason: "Accessoire detecte (suivi a l'unite, pas au gramme)"
      };
    }
  }

  // Pre-roules : detecter "joint", "pre-roll", "spliff", "cone"
  // Avec multipack : "duo" / "(x2)" / "x 3" / "pack de N"
  const isPreRoll = /\bjoint\b|\bpre[\s-]?roll/i.test(name) || /spliff|\bcone\b/i.test(name);
  if (isPreRoll) {
    let multiplier = 1;
    const xMatch = name.match(/\(?x\s*(\d+)\)?|\bduo\b|\btrio\b|\bquatuor\b|pack\s+de\s+(\d+)/i);
    if (xMatch) {
      if (/duo/.test(name)) multiplier = 2;
      else if (/trio/.test(name)) multiplier = 3;
      else if (/quatuor/.test(name)) multiplier = 4;
      else if (xMatch[1]) multiplier = parseInt(xMatch[1], 10) || 1;
      else if (xMatch[2]) multiplier = parseInt(xMatch[2], 10) || 1;
    }
    const grams = 0.5 * multiplier;
    return {
      type: "gramsPerUnit",
      patch: { gramsPerUnit: grams, trackByUnit: false },
      reason: `Pre-roule detecte (${multiplier} x 0.5 g = ${grams} g/unite)`
    };
  }

  return null;
}

router.post("/api/shop-health/auto-fix", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const dryRun = req.body && req.body.dryRun === true;
    const overrides = (productOverridesStore.listOverrides && productOverridesStore.listOverrides(shop)) || {};
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];

    const proposed = [];
    const applied = [];
    const skipped = [];

    for (const p of products) {
      const pid = String(p.productId || p.id || "");
      if (!pid) continue;

      // Skip si override deja configure manuellement
      if (overrides[pid]) {
        skipped.push({ productId: pid, productName: p.name, reason: "Override manuel deja present" });
        continue;
      }

      // L'heuristique decide si une correction s'applique. On NE filtre PAS sur
      // "fallback 1000g" parce que certains produits parsent vers une valeur
      // basse mais incorrecte (ex: huile "10 %" -> 10 g/flacon, alors qu'il
      // faudrait du suivi a l'unite).
      const fix = inferProductFix(p.name);
      if (!fix) {
        skipped.push({ productId: pid, productName: p.name, reason: "Aucun pattern reconnu" });
        continue;
      }

      proposed.push({
        productId: pid,
        productName: p.name,
        type: fix.type,
        patch: fix.patch,
        reason: fix.reason
      });

      if (!dryRun) {
        try {
          productOverridesStore.setOverride(shop, pid, fix.patch);
          applied.push({ productId: pid, productName: p.name, type: fix.type, reason: fix.reason });
        } catch (e) {
          skipped.push({ productId: pid, productName: p.name, reason: "Erreur application: " + e.message });
        }
      }
    }

    if (!dryRun) {
      logEvent("shop_health_auto_fix", {
        shop,
        applied: applied.length,
        skipped: skipped.length,
      });
    }

    res.json({
      dryRun,
      proposed,
      applied,
      skipped,
      summary: {
        proposedCount: proposed.length,
        appliedCount: applied.length,
        skippedCount: skipped.length,
      }
    });
  });
});

router.post("/api/products/:productId/categories", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(String) : [];
    
    // Récupérer les infos du profil
    const profileId = req.body?.profileId || null;
    const profileName = req.body?.profileName || "User";
    const profileColor = req.body?.profileColor || "#6366f1";

    if (typeof stock.setProductCategories !== "function") {
      return apiError(res, 500, "stock.setProductCategories introuvable");
    }

    const ok = stock.setProductCategories(shop, productId, categoryIds);
    if (!ok) return apiError(res, 404, "Produit introuvable (non configure)");

    if (movementStore.addMovement) {
      movementStore.addMovement(
        { source: "product_set_categories", productId, gramsDelta: 0, meta: { categoryIds }, profileId, profileName, profileColor, shop },
        shop
      );
    }

    res.json({ success: true, productId, categoryIds });
  });
});

// ---
router.post("/api/products", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const name = String(req.body?.name || "").trim();
    const totalGrams = Number(req.body?.totalGrams || 0);
    const averageCostPerGram = Number(req.body?.averageCostPerGram || 0);
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [];

    if (!name) return apiError(res, 400, "Nom du produit requis");

    // ---
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
    
    // Récupérer les infos du profil depuis query params (DELETE n'a pas de body standard)
    const profileId = req.query?.profileId || null;
    const profileName = req.query?.profileName || "User";
    const profileColor = req.query?.profileColor || "#6366f1";

    if (typeof stock.removeProduct !== "function") {
      return apiError(res, 500, "stock.removeProduct introuvable");
    }

    // Récupérer le nom du produit avant suppression pour le mouvement
    const productSnapshot = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    const productName = productSnapshot?.name || productSnapshot?.title || "Produit inconnu";
    const totalGrams = productSnapshot?.totalGrams || 0;

    const ok = stock.removeProduct(shop, productId);
    if (!ok) return apiError(res, 404, "Produit introuvable");

    if (movementStore.addMovement) {
      movementStore.addMovement({ 
        source: "product_deleted", 
        productId, 
        productName,
        gramsDelta: -totalGrams, // Stock perdu
        totalAfter: 0,
        profileId,
        profileName,
        profileColor,
        shop 
      }, shop);
    }

    logEvent("product_deleted", { shop, productId, productName }, "info");

    res.json({ success: true, productId, productName });
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

    // ---
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

// ============================================
// SYNC SHOPIFY - Synchronisation en masse
// ============================================
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
        const existingProduct = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;

        // Override par-produit : poids fixe ou suivi a l'unite (accessoires)
        const ovr = productOverridesStore.getOverride(shop, productId) || {};
        const ovrGrams = Number(ovr.gramsPerUnit) > 0 ? Number(ovr.gramsPerUnit) : null;
        const ovrTrackByUnit = ovr.trackByUnit === true;

        // Skip total des produits archives (hors catalogue) : on ne touche ni
        // au stock ni aux variantes ni aux metadata. Ils restent invisibles
        // partout sauf modal Archives, et la sync ne doit pas les ressusciter.
        if (ovr.archived === true) {
          skipped++;
          continue;
        }

        // Préparer les variantes au format attendu par stockManager
        // IMPORTANT: normalizeVariants exige inventoryItemId ET gramsPerUnit > 0
        const variantsObj = {};
        let hasValidVariant = false;
        // Pour produits "vrac" (split) : toutes les variantes representent le
        // MEME stock master. invQty x gramsPerUnit doit donner la meme valeur
        // pour chaque variante (modulo arrondi du floor cote push). On prend
        // le MAX = stock potentiel le plus a jour.
        // Pour trackByUnit : chaque variante a son stock physique separe,
        // on additionne (1g/unite, donc somme = nombre total d'unites).
        let totalGramsMaxFromShopify = 0;
        let totalGramsSumFromShopify = 0;

        if (shopifyProduct.variants && shopifyProduct.variants.length > 0) {
          for (const v of shopifyProduct.variants) {
            // inventory_item_id est fourni par Shopify API
            const inventoryItemId = v.inventory_item_id || v.inventoryItemId || 0;

            let gramsPerUnit = 0;

            if (ovrGrams) {
              // Override explicite : court-circuite tout le parsing
              gramsPerUnit = ovrGrams;
            } else if (ovrTrackByUnit) {
              // Suivi a l'unite : on enregistre 1g/unite pour ne pas casser le data model,
              // les routes en lecture remettront totalGrams a 0 et exposeront unitCount.
              gramsPerUnit = 1;
            } else {
              // Parsing standard avec fallback sur product title
              gramsPerUnit = parseGramsFromVariant(v, shopifyProduct.title);

              // Fallback 1: utiliser le champ grams de Shopify directement
              if (!gramsPerUnit && v.grams && Number(v.grams) > 0) {
                gramsPerUnit = Number(v.grams);
              }

              // Fallback 2: utiliser weight de Shopify (converti en grammes selon weight_unit)
              if (!gramsPerUnit && v.weight && Number(v.weight) > 0) {
                const weight = Number(v.weight);
                const weightUnit = (v.weight_unit || 'g').toLowerCase();
                if (weightUnit === 'kg') {
                  gramsPerUnit = weight * 1000;
                } else if (weightUnit === 'lb') {
                  gramsPerUnit = weight * 453.592;
                } else if (weightUnit === 'oz') {
                  gramsPerUnit = weight * 28.3495;
                } else {
                  gramsPerUnit = weight; // Assume grammes
                }
              }

              // Dernier fallback: 1000g (1kg). Toujours mauvais pour pre-roules / packs
              // sans poids explicite, mais l'override gramsPerUnit ou trackByUnit doit
              // etre utilise dans ces cas.
              if (!gramsPerUnit || gramsPerUnit <= 0) {
                gramsPerUnit = 1000;
              }
            }

            if (inventoryItemId && gramsPerUnit > 0) {
              // Utiliser le titre de la variante comme clé (ex: "0.5kg", "100g", "1kg")
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

              // Stock master :
              // - mode vrac (split) : MAX(invQty x gramsPerUnit) - chaque variante
              //   represente le meme pot. inventory_quantity[var] = floor(vrac/grams[var])
              //   pour la sync inverse, le max donne le vrac le plus a jour.
              // - mode trackByUnit : somme (chaque variante = stock physique distinct).
              const invQty = Number(v.inventory_quantity) || 0;
              if (invQty > 0) {
                const variantGrams = invQty * gramsPerUnit;
                if (variantGrams > totalGramsMaxFromShopify) {
                  totalGramsMaxFromShopify = variantGrams;
                }
                totalGramsSumFromShopify += variantGrams;
              }
            }
          }
        }

        const totalGramsFromShopify = ovrTrackByUnit
          ? totalGramsSumFromShopify
          : totalGramsMaxFromShopify;

        // Si aucune variante valide, on skip ce produit
        if (!hasValidVariant) {
          skipped++;
          continue;
        }

        // Sync stock : par defaut on aligne sur Shopify (source de verite).
        // Le client peut envoyer { preserveLocalStock: true } dans le body
        // pour conserver totalGrams existant (utile si l'app a des ventes
        // hors Shopify non encore poussees).
        const preserveLocal = req.body?.preserveLocalStock === true;
        const totalGramsValue = preserveLocal && existingProduct
          ? existingProduct.totalGrams
          : totalGramsFromShopify;

        const productData = {
          productId: productId,
          name: shopifyProduct.title,
          totalGrams: totalGramsValue,
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

// =====================================================
// ADMIN / DIAGNOSTIC INVENTAIRE
// Compare le snapshot local (canSell calcule depuis totalGrams / gramsPerUnit)
// avec l'etat Shopify variante par variante. Permet de detecter pourquoi une
// variante reste vendable sur le storefront alors que canSell local = 0 :
//   - inventory_management = null  -> Shopify ignore "available" (non suivi)
//   - inventory_policy = "continue" -> survente autorisee
//   - inventory level non connecte a la location -> set silencieux impossible
//   - drift (Shopify.available != local.canSell) -> dernier push echoue
// =====================================================
router.get("/api/admin/inventory-diff", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.query?.productId || "").trim();
    if (!productId) return apiError(res, 400, "productId manquant");

    const local = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (!local) return apiError(res, 404, "Produit introuvable cote app");

    const client = shopifyFor(shop);
    const locationId = await getLocationIdForShop(shop);

    const rows = [];
    for (const [label, v] of Object.entries(local.variants || {})) {
      const inventoryItemId = Number(v?.inventoryItemId || 0);
      const localCanSell = Number(v?.canSell || 0);

      let shopifyAvailable = null;
      let connectedToLocation = null;
      let inventoryManagement = null;
      let inventoryPolicy = null;
      let variantTitle = null;
      let errors = [];

      if (inventoryItemId) {
        try {
          const levels = await client.inventoryLevel.list({
            inventory_item_ids: inventoryItemId,
            location_ids: locationId,
          });
          connectedToLocation = Array.isArray(levels) && levels.length > 0;
          shopifyAvailable = connectedToLocation ? Number(levels[0]?.available || 0) : null;
        } catch (e) {
          errors.push({ stage: "inventory_level_list", ...extractShopifyError(e) });
        }
      }

      if (v?.variantId) {
        try {
          const variant = await client.productVariant.get(Number(v.variantId));
          inventoryManagement = variant?.inventory_management ?? null;
          inventoryPolicy = variant?.inventory_policy ?? null;
          variantTitle = variant?.title ?? null;
        } catch (e) {
          errors.push({ stage: "variant_get", ...extractShopifyError(e) });
        }
      }

      const drift =
        shopifyAvailable !== null && Number.isFinite(localCanSell)
          ? shopifyAvailable - localCanSell
          : null;

      // Diagnostic synthetique : pourquoi cette variante peut rester achetable
      // alors qu'on voudrait qu'elle soit "Sold out".
      const sellableDespiteEmpty =
        localCanSell === 0 &&
        (
          inventoryManagement === null ||
          inventoryManagement === "" ||
          inventoryPolicy === "continue" ||
          (shopifyAvailable !== null && shopifyAvailable > 0)
        );

      rows.push({
        label,
        gramsPerUnit: Number(v?.gramsPerUnit) || 0,
        inventoryItemId,
        variantId: v?.variantId || null,
        variantTitle,
        local: { canSell: localCanSell },
        shopify: {
          available: shopifyAvailable,
          inventoryManagement,
          inventoryPolicy,
          connectedToLocation,
        },
        drift,
        sellableDespiteEmpty,
        errors: errors.length ? errors : undefined,
      });
    }

    res.json({
      success: true,
      shop,
      productId,
      productName: local.name,
      totalGrams: local.totalGrams,
      locationId,
      variants: rows,
      summary: {
        variantCount: rows.length,
        driftCount: rows.filter((r) => r.drift !== null && r.drift !== 0).length,
        sellableDespiteEmpty: rows.filter((r) => r.sellableDespiteEmpty).length,
        notConnected: rows.filter((r) => r.shopify.connectedToLocation === false).length,
        notTracked: rows.filter(
          (r) => r.shopify.inventoryManagement === null || r.shopify.inventoryManagement === ""
        ).length,
      },
    });
  });
});

// Force-republie l'etat local d'un produit vers Shopify (re-applique
// pushProductInventoryToShopify). Utile quand le storefront semble "coince"
// sur d'anciennes valeurs apres un push partiel.
router.post("/api/admin/inventory-resync", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.body?.productId || "").trim();
    if (!productId) return apiError(res, 400, "productId manquant");

    const snap = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (!snap) return apiError(res, 404, "Produit introuvable cote app");

    let result = null;
    try {
      result = await pushProductInventoryToShopify(shop, snap);
    } catch (e) {
      logEvent("inventory_resync_error", { shop, productId, ...extractShopifyError(e) }, "error");
      return apiError(res, 500, "Echec resync: " + (e?.message || "erreur inconnue"));
    }

    res.json({
      success: true,
      shop,
      productId,
      productName: snap.name,
      totalGrams: snap.totalGrams,
      result,
    });
  });
});

router.post("/api/restock", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.body?.productId || "").trim();
    const grams = Number(req.body?.grams);
    const purchasePricePerGram = Number(req.body?.purchasePricePerGram || 0);
    
    // Récupérer les infos du profil
    const profileId = req.body?.profileId || null;
    const profileName = req.body?.profileName || "User";
    const profileColor = req.body?.profileColor || "#6366f1";

    if (!productId) return apiError(res, 400, "productId manquant");
    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide (ex: 50)");

    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, productId) : 0;
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
          cmpBefore: purchasePricePerGram > 0 ? cmpBefore : undefined,
          totalAfter: updated.totalGrams,
          profileId,
          profileName,
          profileColor,
          shop,
        },
        shop
      );
    }

    res.json({ success: true, product: updated, cmpUpdated: purchasePricePerGram > 0 });
  });
});

// Alias route for /api/products/:productId/restock
router.post("/api/products/:productId/restock", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.params.productId || "").trim();
    const grams = Number(req.body?.grams);
    const purchasePricePerGram = Number(req.body?.purchasePricePerGram || 0);
    
    // Récupérer les infos du profil
    const profileId = req.body?.profileId || null;
    const profileName = req.body?.profileName || "User";
    const profileColor = req.body?.profileColor || "#6366f1";

    if (!productId) return apiError(res, 400, "productId manquant");
    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "grams invalide (ex: 50)");

    if (typeof stock.restockProduct !== "function") {
      return apiError(res, 500, "stock.restockProduct introuvable");
    }

    const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, productId) : 0;
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
          cmpBefore: purchasePricePerGram > 0 ? cmpBefore : undefined,
          totalAfter: updated.totalGrams,
          profileId,
          profileName,
          profileColor,
          shop,
        },
        shop
      );
    }

    res.json({ success: true, product: updated, cmpUpdated: purchasePricePerGram > 0 });
  });
});

// =====================================================
// VENTE MANUELLE (hors Shopify)
// =====================================================
router.post("/api/sales/manual", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const productId = String(req.body?.productId || "").trim();
    const grams = Number(req.body?.grams || 0);
    const sellingPriceTotal = Number(req.body?.sellingPriceTotal || 0);
    const customerName = String(req.body?.customerName || "").trim();
    const orderNote = String(req.body?.orderNote || "").trim();
    const orderName = String(req.body?.orderName || "").trim();
    const orderIdInput = String(req.body?.orderId || "").trim();
    const orderNumberInput = String(req.body?.orderNumber || "").trim();
    const profileId = req.body?.profileId || null;
    const profileName = req.body?.profileName || "User";
    const profileColor = req.body?.profileColor || "#6366f1";

    if (!productId) return apiError(res, 400, "productId manquant");
    if (!Number.isFinite(grams) || grams <= 0) return apiError(res, 400, "Quantité invalide");
    if (sellingPriceTotal < 0) return apiError(res, 400, "Prix invalide");

    // Get product info for CMP
    const productSnapshot = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (!productSnapshot) return apiError(res, 404, "Produit introuvable");

    const productName = productSnapshot.name || productId;
    const costPerGram = productSnapshot.averageCostPerGram || 0;
    const totalCost = grams * costPerGram;
    const margin = sellingPriceTotal - totalCost;
    const marginPercent = sellingPriceTotal > 0 ? Math.round((margin / sellingPriceTotal) * 100) : 0;
    const sellingPricePerGram = grams > 0 ? sellingPriceTotal / grams : 0;

    // 1. Deduct stock. applyOrderToProduct clampe le stock a 0 et renvoie le
    // snapshot a jour : on en extrait le stock reel post-deduction pour que le
    // mouvement enregistre la bonne valeur (et non un totalAfter negatif quand
    // on vend plus que le stock disponible).
    let stockAfter = Math.max(0, (productSnapshot.totalGrams || 0) - grams);
    if (typeof stock.applyOrderToProduct === "function") {
      try {
        const deducted = await stock.applyOrderToProduct(shop, productId, grams);
        if (deducted && Number.isFinite(deducted.totalGrams)) {
          stockAfter = deducted.totalGrams;
        }
      } catch (e) {
        return apiError(res, 400, "Erreur déduction stock: " + e.message);
      }
    }

    // 2. Record movement.
    // Honor a client-supplied orderId/orderNumber so multi-line manual sales
    // share one logical order instead of generating one per line.
    const orderId = orderIdInput || `manual_${Date.now()}`;
    const orderNumber = orderNumberInput || ("MANUAL-" + Date.now().toString(36).toUpperCase());

    if (movementStore && movementStore.addMovement) {
      movementStore.addMovement({
        source: "sale",
        type: "manual_sale",
        productId,
        productName,
        gramsDelta: -Math.abs(grams),
        totalAfter: stockAfter,
        orderId,
        orderNumber,
        orderName: orderName || undefined,
        sellingPricePerGram,
        sellingPriceTotal,
        customerName: customerName || undefined,
        note: orderNote || undefined,
        profileId,
        profileName,
        profileColor,
        shop,
      }, shop);
    }

    // 3. Record sale in analytics
    if (analyticsStore && analyticsStore.addSale) {
      analyticsStore.addSale({
        orderId,
        orderNumber,
        orderName: orderName || undefined,
        orderDate: new Date().toISOString(),
        productId,
        productName,
        quantity: 1,
        gramsPerUnit: grams,
        totalGrams: grams,
        grossPrice: sellingPriceTotal,
        discountAmount: 0,
        netRevenue: sellingPriceTotal,
        costPerGram,
        totalCost,
        margin,
        marginPercent,
        source: "manual",
        customerName: customerName || undefined,
        shop,
      }, shop);
    }

    // 4. Sync Shopify inventory
    const updatedProduct = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (updatedProduct) {
      try {
        await pushProductInventoryToShopify(shop, updatedProduct);
      } catch (e) {
        logEvent("inventory_push_error", { shop, productId, error: e.message }, "error");
      }
    }

    logEvent("manual_sale", { shop, productId, productName, grams, sellingPriceTotal, margin }, "info");

    res.json({
      success: true,
      orderId,
      productName,
      grams,
      sellingPriceTotal,
      totalCost: Math.round(totalCost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      marginPercent,
      newStock: updatedProduct ? updatedProduct.totalGrams : null,
    });
  });
});

// =====================================================
// ANNULATION D'UNE VENTE MANUELLE (restitution de stock)
// =====================================================
// Coeur partage par les deux routes ci-dessous. Recoit un tableau
// d'enregistrements analytics (deja verifies source === "manual") et, pour
// chacun :
//   1. recredite le stock via restockProduct SANS prix d'achat -> le CMP ne
//      change pas (operation symetrique de la vente) ;
//   2. ecrit un mouvement de contre-passation (gramsDelta positif) plutot que
//      d'effacer le mouvement d'origine (movementStore est append-only) ;
//   3. supprime la ligne analytics ;
//   4. re-pousse l'inventaire vers Shopify (une fois par produit touche).
// Si la restitution de stock echoue pour une ligne, on NE supprime PAS son
// analytics (on garde l'etat coherent) et on remonte l'erreur.
async function cancelManualSales(shop, sales) {
  const result = { cancelled: 0, restitutedGrams: 0, errors: [] };
  const touchedProducts = new Set();

  for (const sale of sales) {
    const productId = String(sale.productId || "");
    const grams = Number(sale.totalGrams || 0);
    if (!productId) {
      result.errors.push({ id: sale.id, error: "productId manquant" });
      continue;
    }

    // 1. Restituer le stock (CMP inchange : pas de prix d'achat fourni).
    let stockAfter = null;
    if (typeof stock.restockProduct === "function" && grams > 0) {
      try {
        const snap = await stock.restockProduct(shop, productId, grams);
        if (snap && Number.isFinite(snap.totalGrams)) stockAfter = snap.totalGrams;
      } catch (e) {
        result.errors.push({ id: sale.id, error: "restitution stock: " + e.message });
        continue; // ne pas supprimer l'analytics si la restitution a echoue
      }
    }

    // 2. Mouvement de contre-passation (audit : vente -X puis annulation +X).
    if (movementStore && movementStore.addMovement) {
      movementStore.addMovement({
        source: "sale",
        type: "manual_sale_cancel",
        productId,
        productName: sale.productName || productId,
        gramsDelta: Math.abs(grams),
        totalAfter: stockAfter !== null ? stockAfter : undefined,
        orderId: sale.orderId || undefined,
        orderNumber: sale.orderNumber || undefined,
        orderName: sale.orderName || undefined,
        customerName: sale.customerName || undefined,
        note: "Annulation vente manuelle",
        shop,
      }, shop);
    }

    // 3. Supprimer la ligne analytics.
    if (analyticsStore && analyticsStore.deleteSale) {
      analyticsStore.deleteSale(shop, sale.id);
    }

    touchedProducts.add(productId);
    result.cancelled++;
    result.restitutedGrams += grams;
  }

  // 4. Sync Shopify (une seule fois par produit touche, best-effort).
  for (const pid of touchedProducts) {
    const snap = stock.getProductSnapshot ? stock.getProductSnapshot(shop, pid) : null;
    if (snap) {
      try {
        await pushProductInventoryToShopify(shop, snap);
      } catch (e) {
        logEvent("inventory_push_error", { shop, productId: pid, error: e.message }, "error");
      }
    }
  }

  return result;
}

// Annuler une seule ligne de vente manuelle (route specifique declaree AVANT
// la route commande pour eviter toute ambiguite de matching).
router.post("/api/sales/manual/line/:saleId/cancel", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales) return apiError(res, 500, "Analytics non disponible");

    const saleId = String(req.params.saleId || "").trim();
    if (!saleId) return apiError(res, 400, "saleId manquant");

    const all = analyticsStore.listSales({ shop, limit: 50000 });
    const line = all.find(s => String(s.id) === saleId);
    if (!line) return apiError(res, 404, "Ligne introuvable");
    if (line.source !== "manual") return apiError(res, 400, "Seules les ventes manuelles peuvent etre annulees ici");

    const result = await cancelManualSales(shop, [line]);
    logEvent("manual_sale_line_cancelled", { shop, saleId, grams: result.restitutedGrams }, "info");
    res.json({ success: true, ...result });
  });
});

// Annuler une commande de vente manuelle entiere (toutes ses lignes).
router.post("/api/sales/manual/:orderId/cancel", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales) return apiError(res, 500, "Analytics non disponible");

    const orderId = String(req.params.orderId || "").trim();
    if (!orderId) return apiError(res, 400, "orderId manquant");

    const all = analyticsStore.listSales({ shop, limit: 50000 });
    const lines = all.filter(s => String(s.orderId) === orderId && s.source === "manual");
    if (lines.length === 0) return apiError(res, 404, "Vente manuelle introuvable");

    const result = await cancelManualSales(shop, lines);
    logEvent("manual_sale_cancelled", { shop, orderId, lines: result.cancelled, grams: result.restitutedGrams }, "info");
    res.json({ success: true, ...result });
  });
});

// =====================================================
// LIGNE CADEAU sur commande Shopify existante
// =====================================================
// Ajoute une ligne de produit "offert" rattachée à une commande Shopify
// existante. Décrémente le stock comme une vente normale, enregistre une
// ligne analytics avec netRevenue=0 et totalCost = qty × gramsPerUnit × CMP
// pour que la marge totale de la commande reflète le coût du cadeau.
//
// Body: { orderId, orderNumber?, productId, quantity, gramsPerUnit }
//   - orderId      : id Shopify de la commande à laquelle rattacher (obligatoire)
//   - quantity     : nombre de pochons cadeaux (>=1)
//   - gramsPerUnit : poids unitaire en g (>0)
// Le coût (CMP) est résolu côté serveur depuis le snapshot produit.
router.post("/api/sales/gift", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const orderId = String(req.body?.orderId || "").trim();
    const orderNumber = String(req.body?.orderNumber || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const quantity = Number(req.body?.quantity || 0);
    const gramsPerUnit = Number(req.body?.gramsPerUnit || 0);

    if (!orderId) return apiError(res, 400, "orderId manquant");
    if (!productId) return apiError(res, 400, "productId manquant");
    if (!Number.isFinite(quantity) || quantity <= 0) return apiError(res, 400, "quantity invalide");
    if (!Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0) return apiError(res, 400, "gramsPerUnit invalide");

    const productSnapshot = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (!productSnapshot) return apiError(res, 404, "Produit introuvable");

    const productName = productSnapshot.name || productId;
    const costPerGram = Number(productSnapshot.averageCostPerGram || 0);
    const totalGrams = quantity * gramsPerUnit;
    const totalCost = totalGrams * costPerGram;
    const margin = -totalCost; // netRevenue = 0
    const marginPercent = 0;

    // 1. Décrémenter le stock
    if (typeof stock.applyOrderToProduct === "function") {
      try {
        await stock.applyOrderToProduct(shop, productId, totalGrams);
      } catch (e) {
        return apiError(res, 400, "Erreur déduction stock: " + e.message);
      }
    }

    // 2. Mouvement (source: gift) — distinct des ventes pour pouvoir filtrer
    if (movementStore && movementStore.addMovement) {
      movementStore.addMovement({
        source: "gift",
        type: "gift_line",
        productId,
        productName,
        gramsDelta: -Math.abs(totalGrams),
        totalAfter: (productSnapshot.totalGrams || 0) - totalGrams,
        orderId,
        orderNumber: orderNumber || undefined,
        sellingPriceTotal: 0,
        sellingPricePerGram: 0,
        shop,
      }, shop);
    }

    // 3. Analytics : netRevenue=0, le coût pèse sur la marge de la commande.
    // La dédup analytics se fait sur (orderId, productId, variantId) ; on
    // synthétise un variantId unique par appel pour permettre plusieurs cadeaux
    // du même produit sur la même commande sans collision avec une vraie ligne.
    const giftVariantId = "gift_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    if (analyticsStore && analyticsStore.addSale) {
      analyticsStore.addSale({
        orderId,
        orderNumber: orderNumber || null,
        orderDate: new Date().toISOString(),
        productId,
        productName,
        variantId: giftVariantId,
        variantTitle: "Cadeau",
        quantity,
        gramsPerUnit,
        totalGrams,
        grossPrice: 0,
        discountAmount: 0,
        netRevenue: 0,
        costPerGram,
        totalCost,
        margin,
        marginPercent,
        source: "gift",
        shop,
      }, shop);
    }

    // 4. Sync Shopify
    const updatedProduct = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
    if (updatedProduct) {
      try {
        await pushProductInventoryToShopify(shop, updatedProduct);
      } catch (e) {
        logEvent("inventory_push_error", { shop, productId, error: e.message }, "error");
      }
    }

    logEvent("gift_line_added", { shop, orderId, productId, productName, quantity, totalGrams, totalCost }, "info");

    res.json({
      success: true,
      orderId,
      productId,
      productName,
      quantity,
      totalGrams,
      totalCost: Math.round(totalCost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      newStock: updatedProduct ? updatedProduct.totalGrams : null,
    });
  });
});

// Préparation "pack découverte" : déduit un poids (1,5 g) par produit sélectionné
// (les plus gros stocks, sélection faite côté client). Enregistre un mouvement par
// ligne + push Shopify. AUCUNE écriture analytics (préparation, pas une vente).
// Calqué sur /api/sales/gift sans la partie analytics.
router.post("/api/discovery-pack/commit", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (rawLines.length === 0) return apiError(res, 400, "Aucune ligne à préparer");

    // Identifiant commun à toutes les lignes de ce pack -> permet d'annuler
    // le pack entier d'un coup (voir POST /api/movements/undo).
    const batchId = "dp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    const prepared = [];
    const skipped = [];
    let totalGramsDeducted = 0;

    for (const line of rawLines) {
      const productId = String(line?.productId || "").trim();
      const grams = Number(line?.grams || 0);

      if (!productId || !Number.isFinite(grams) || grams <= 0) {
        skipped.push({ productId, productName: "", reason: "ligne invalide" });
        continue;
      }

      const snapshot = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
      if (!snapshot) {
        skipped.push({ productId, productName: "", reason: "produit introuvable" });
        continue;
      }

      const productName = snapshot.name || productId;
      const currentGrams = Number(snapshot.totalGrams || 0);
      if (currentGrams < grams) {
        skipped.push({ productId, productName, reason: "stock insuffisant" });
        continue;
      }

      // 1. Décrémenter le stock
      try {
        if (typeof stock.applyOrderToProduct === "function") {
          await stock.applyOrderToProduct(shop, productId, grams);
        }
      } catch (e) {
        skipped.push({ productId, productName, reason: "erreur déduction: " + e.message });
        continue;
      }

      const updated = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
      const totalAfter = updated ? Number(updated.totalGrams || 0) : currentGrams - grams;

      // 2. Mouvement (source: discovery_pack) — distinct des ventes pour filtrage
      if (movementStore && movementStore.addMovement) {
        try {
          movementStore.addMovement({
            source: "discovery_pack",
            type: "discovery_pack_prep",
            productId,
            productName,
            gramsDelta: -Math.abs(grams),
            totalAfter,
            batchId,
            shop,
          }, shop);
        } catch (e) {
          logEvent("discovery_pack_movement_error", { shop, productId, error: e.message }, "error");
        }
      }

      // 3. Sync Shopify (best-effort)
      if (updated) {
        try {
          await pushProductInventoryToShopify(shop, updated);
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId, error: e.message }, "error");
        }
      }

      prepared.push({ productId, productName, grams, totalAfter });
      totalGramsDeducted += grams;
    }

    logEvent("discovery_pack_prepared", {
      shop,
      prepared: prepared.length,
      skipped: skipped.length,
      totalGramsDeducted,
    }, "info");

    res.json({
      success: true,
      prepared: prepared.length,
      totalGramsDeducted: Math.round(totalGramsDeducted * 100) / 100,
      preparedLines: prepared,
      skipped,
    });
  });
});

// Retour en arrière (contre-passation) d'une opération de stock manuelle récente.
// Append-only : on n'efface pas le mouvement d'origine, on applique l'inverse + on
// écrit un mouvement "reversal". v1 : discovery_pack, adjust_total, restock.
router.post("/api/movements/undo", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const UNDOABLE = new Set(["discovery_pack", "adjust_total", "restock"]);
    const movementId = String(req.body?.movementId || "").trim();
    const batchId = String(req.body?.batchId || "").trim();
    if (!movementId && !batchId) return apiError(res, 400, "movementId ou batchId requis");

    const all = movementStore.listMovements ? movementStore.listMovements({ shop, days: 90, limit: 10000 }) : [];
    const reversedIds = new Set(all.filter((m) => m.reversalOf).map((m) => String(m.reversalOf)));

    let targets;
    if (batchId) {
      targets = all.filter((m) => m.batchId === batchId && m.source === "discovery_pack");
    } else {
      targets = all.filter((m) => String(m.id) === movementId);
    }

    // Uniquement les cibles annulables et non déjà annulées.
    targets = targets.filter((m) =>
      UNDOABLE.has(m.source) && !m.reversalOf && m.source !== "reversal" && !reversedIds.has(String(m.id))
    );

    if (targets.length === 0) {
      return apiError(res, 400, "Rien à annuler (déjà annulé ou non annulable)");
    }

    const undoneLines = [];
    const skipped = [];
    const touched = new Set();
    let netStockDelta = 0;
    let cmpRestored = false;

    for (const m of targets) {
      const productId = String(m.productId || "");
      const delta = Number(m.gramsDelta || 0);
      if (!productId || !Number.isFinite(delta) || delta === 0) {
        skipped.push({ id: m.id, reason: "mouvement sans effet stock" });
        continue;
      }

      try {
        if (delta < 0) {
          // L'opération avait déduit -> on restocke (CMP neutre : pas de prix).
          await stock.restockProduct(shop, productId, Math.abs(delta));
        } else {
          // L'opération avait ajouté -> on déduit.
          await stock.applyOrderToProduct(shop, productId, delta);
        }
      } catch (e) {
        skipped.push({ id: m.id, reason: "stock: " + e.message });
        continue;
      }

      // Restaurer le CMP si l'opération d'origine l'avait changé.
      if (m.cmpBefore !== undefined && m.cmpBefore !== null && typeof stock.setAverageCostPerGram === "function") {
        try {
          stock.setAverageCostPerGram(shop, productId, Number(m.cmpBefore));
          cmpRestored = true;
        } catch (e) {
          logEvent("undo_cmp_restore_error", { shop, productId, error: e.message }, "error");
        }
      }

      const snap = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
      const totalAfter = snap ? Number(snap.totalGrams || 0) : undefined;

      if (movementStore && movementStore.addMovement) {
        movementStore.addMovement({
          source: "reversal",
          type: "undo",
          productId,
          productName: m.productName || productId,
          gramsDelta: -delta,
          totalAfter,
          reversalOf: m.id,
          batchId: m.batchId || undefined,
          note: "Annulation de " + (m.source || "?"),
          shop,
        }, shop);
      }

      touched.add(productId);
      netStockDelta += -delta;
      undoneLines.push({ id: m.id, productId, productName: m.productName || productId, gramsRestored: -delta });
    }

    // Sync Shopify 1x par produit touché (best-effort).
    for (const pid of touched) {
      const snap = stock.getProductSnapshot ? stock.getProductSnapshot(shop, pid) : null;
      if (snap) {
        try {
          await pushProductInventoryToShopify(shop, snap);
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId: pid, error: e.message }, "error");
        }
      }
    }

    logEvent("movement_undone", { shop, undone: undoneLines.length, batchId: batchId || undefined }, "info");

    res.json({
      success: true,
      undone: undoneLines.length,
      netStockDelta: Math.round(netStockDelta * 100) / 100,
      cmpRestored,
      undoneLines,
      skipped,
    });
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
// ---
// =====================================================

// Recuperer tous les parametres
// Route pour récupérer la locale Shopify de la boutique
router.get("/api/shop-locale", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    try {
      const client = shopifyFor(shop);
      const shopInfo = await client.shop.get();
      
      const primaryLocale = shopInfo?.primary_locale || "en";
      const currency = shopInfo?.currency || "EUR";
      const timezone = shopInfo?.iana_timezone || shopInfo?.timezone || "Europe/Paris";
      
      const localeMap = {
        "fr": "fr", "fr-FR": "fr", "fr-CA": "fr",
        "en": "en", "en-US": "en", "en-GB": "en",
        "de": "de", "de-DE": "de", "de-AT": "de", "de-CH": "de",
        "es": "es", "es-ES": "es", "es-MX": "es",
        "it": "it", "it-IT": "it",
      };
      
      const detectedLang = localeMap[primaryLocale] || localeMap[primaryLocale.split("-")[0]] || "en";
      
      res.json({
        success: true,
        shopLocale: primaryLocale,
        detectedLanguage: detectedLang,
        currency: currency,
        timezone: timezone,
      });
    } catch (e) {
      logEvent("shop_locale_error", { shop, error: e.message }, "error");
      let fallbackLang = "en";
      if (shop.includes(".fr") || shop.includes("-fr")) fallbackLang = "fr";
      else if (shop.includes(".de") || shop.includes("-de")) fallbackLang = "de";
      else if (shop.includes(".es") || shop.includes("-es")) fallbackLang = "es";
      else if (shop.includes(".it") || shop.includes("-it")) fallbackLang = "it";
      
      res.json({ success: false, detectedLanguage: fallbackLang, fallback: true });
    }
  });
});

router.get("/api/settings", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!settingsManager) return apiError(res, 500, "SettingsManager non disponible");

    const settings = settingsManager.loadSettings(shop);
    const options = settingsManager.SETTING_OPTIONS;
    
    // Si language est "auto", récupérer la locale Shopify
    let shopLocale = null;
    if (settings.general?.language === "auto") {
      try {
        const client = shopifyFor(shop);
        const shopInfo = await client.shop.get();
        const primaryLocale = shopInfo?.primary_locale || "en";
        
        const localeMap = {
          "fr": "fr", "fr-FR": "fr", "fr-CA": "fr",
          "en": "en", "en-US": "en", "en-GB": "en",
          "de": "de", "de-DE": "de",
          "es": "es", "es-ES": "es",
          "it": "it", "it-IT": "it",
        };
        shopLocale = localeMap[primaryLocale] || localeMap[primaryLocale.split("-")[0]] || "en";
      } catch (e) {
        shopLocale = "fr";
      }
    }
    
    res.json({ settings, options, shopLocale });
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

// Mettre a jour une section
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
// DATA MANAGEMENT ROUTES (Snapshots, Rollback, Reset)
// =====================================================

const SNAPSHOTS_SUBDIR = "snapshots";

function snapshotsDir(shop) {
  const DATA_DIR_SM = process.env.DATA_DIR || "/var/data";
  const s = String(shop || "default").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const dir = path.join(DATA_DIR_SM, s, SNAPSHOTS_SUBDIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Create a snapshot (manual or auto)
router.post("/api/data/snapshot", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    try {
      const label = req.body?.label || "";
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
      const snapId = `${dateStr}_${timeStr}`;
      const dir = snapshotsDir(shop);
      const snapFile = path.join(dir, `${snapId}.json`);

      // Gather all data
      const stockStateMod = require("./stockState");
      const stockData = stockStateMod.loadState(shop);

      let settingsData = {};
      if (settingsManager) {
        try { settingsData = settingsManager.exportConfig(shop); } catch(e) {}
      }

      let batchData = [];
      if (batchStore) {
        try { batchData = batchStore.listBatches ? batchStore.listBatches(shop) : []; } catch(e) {}
      }

      let supplierData = [];
      if (supplierStore) {
        try { supplierData = supplierStore.listSuppliers ? supplierStore.listSuppliers(shop) : []; } catch(e) {}
      }

      // Movements from the last 30 days
      let movementsData = [];
      if (movementStore) {
        try { movementsData = movementStore.listMovements({ shop, days: 30, limit: 5000 }); } catch(e) {}
      }

      const snapshot = {
        id: snapId,
        label: label || `Snapshot ${dateStr}`,
        createdAt: now.toISOString(),
        data: {
          stock: stockData,
          settings: settingsData,
          batches: batchData,
          suppliers: supplierData,
          movements: movementsData,
        }
      };

      fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2), "utf8");
      logEvent("snapshot_created", { shop, snapId, label }, "info");

      // Keep only last 10 snapshots
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
      if (files.length > 10) {
        const toDelete = files.slice(0, files.length - 10);
        toDelete.forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch(e) {} });
      }

      res.json({ success: true, snapshot: { id: snapId, label: snapshot.label, createdAt: snapshot.createdAt } });
    } catch (e) {
      return apiError(res, 500, "Erreur création snapshot: " + e.message);
    }
  });
});

// List available snapshots
router.get("/api/data/snapshots", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    try {
      const dir = snapshotsDir(shop);
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().reverse();

      const snapshots = files.map(f => {
        try {
          const raw = fs.readFileSync(path.join(dir, f), "utf8");
          const snap = JSON.parse(raw);
          const productCount = snap.data?.stock?.products ? Object.keys(snap.data.stock.products).length : 0;
          const movementCount = Array.isArray(snap.data?.movements) ? snap.data.movements.length : 0;
          return {
            id: snap.id,
            label: snap.label,
            createdAt: snap.createdAt,
            productCount,
            movementCount,
            fileSize: fs.statSync(path.join(dir, f)).size,
          };
        } catch(e) { return null; }
      }).filter(Boolean);

      res.json({ snapshots });
    } catch (e) {
      return apiError(res, 500, "Erreur lecture snapshots: " + e.message);
    }
  });
});

// Download a full backup (all data)
router.get("/api/data/full-backup", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    try {
      const stockStateMod = require("./stockState");
      const stockData = stockStateMod.loadState(shop);

      let settingsData = {};
      if (settingsManager) {
        try { settingsData = settingsManager.exportConfig(shop); } catch(e) {}
      }
      let batchData = [];
      if (batchStore) {
        try { batchData = batchStore.listBatches ? batchStore.listBatches(shop) : []; } catch(e) {}
      }
      let supplierData = [];
      if (supplierStore) {
        try { supplierData = supplierStore.listSuppliers ? supplierStore.listSuppliers(shop) : []; } catch(e) {}
      }
      let movementsData = [];
      if (movementStore) {
        try { movementsData = movementStore.listMovements({ shop, days: 90, limit: 10000 }); } catch(e) {}
      }

      const backup = {
        version: "1.0",
        createdAt: new Date().toISOString(),
        shop,
        data: { stock: stockData, settings: settingsData, batches: batchData, suppliers: supplierData, movements: movementsData }
      };

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="full-backup-${new Date().toISOString().slice(0,10)}.json"`);
      res.json(backup);
    } catch (e) {
      return apiError(res, 500, "Erreur backup: " + e.message);
    }
  });
});

// Rollback to a specific snapshot
router.post("/api/data/rollback", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const snapId = req.body?.snapshotId;
    if (!snapId) return apiError(res, 400, "snapshotId manquant");

    try {
      const dir = snapshotsDir(shop);
      const snapFile = path.join(dir, `${snapId}.json`);
      if (!fs.existsSync(snapFile)) return apiError(res, 404, "Snapshot introuvable");

      const raw = fs.readFileSync(snapFile, "utf8");
      const snapshot = JSON.parse(raw);
      const snapData = snapshot.data;

      // Auto-snapshot before rollback (safety net)
      const autoSnapId = `pre-rollback_${new Date().toISOString().slice(0,19).replace(/:/g, "-")}`;
      const stockStateMod = require("./stockState");
      const currentStock = stockStateMod.loadState(shop);
      const autoSnap = {
        id: autoSnapId,
        label: "Auto (avant rollback)",
        createdAt: new Date().toISOString(),
        data: { stock: currentStock }
      };
      fs.writeFileSync(path.join(dir, `${autoSnapId}.json`), JSON.stringify(autoSnap, null, 2), "utf8");

      // Restore stock
      if (snapData.stock) {
        stockStateMod.saveState(shop, snapData.stock);
        // Reload stock manager state
        if (stock.reloadShop) stock.reloadShop(shop);
      }

      // Restore settings
      if (snapData.settings && settingsManager) {
        try { settingsManager.importConfig(shop, snapData.settings, { merge: false }); } catch(e) { console.warn("Rollback settings error:", e.message); }
      }

      logEvent("data_rollback", { shop, snapshotId: snapId, snapshotDate: snapshot.createdAt }, "warn");
      res.json({ success: true, restoredFrom: snapshot.createdAt, label: snapshot.label });
    } catch (e) {
      return apiError(res, 500, "Erreur rollback: " + e.message);
    }
  });
});

// Reset all data
router.post("/api/data/reset", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const confirm = req.body?.confirm;
    if (confirm !== "RESET") return apiError(res, 400, "Confirmation manquante. Envoyez confirm: 'RESET'");

    try {
      const DATA_DIR = process.env.DATA_DIR || "/var/data";

      // Auto-snapshot before reset (safety net)
      const dir = snapshotsDir(shop);
      const autoSnapId = `pre-reset_${new Date().toISOString().slice(0,19).replace(/:/g, "-")}`;
      const stockStateMod = require("./stockState");
      const currentStock = stockStateMod.loadState(shop);
      let currentMovements = [];
      if (movementStore) {
        try { currentMovements = movementStore.listMovements({ shop, days: 90, limit: 10000 }); } catch(e) {}
      }
      const autoSnap = {
        id: autoSnapId,
        label: "Auto (avant reset complet)",
        createdAt: new Date().toISOString(),
        data: { stock: currentStock, movements: currentMovements }
      };
      fs.writeFileSync(path.join(dir, `${autoSnapId}.json`), JSON.stringify(autoSnap, null, 2), "utf8");

      // Reset stock
      stockStateMod.saveState(shop, {});
      if (stock.reloadShop) stock.reloadShop(shop);

      // Reset movements
      if (movementStore && movementStore.clearShopMovements) {
        movementStore.clearShopMovements(shop);
      }

      // Reset settings
      if (settingsManager) {
        try { settingsManager.resetSettings(shop); } catch(e) {}
      }

      // Reset analytics (delete all .ndjson sale files)
      try {
        const analyticsDir = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"), "analytics");
        if (fs.existsSync(analyticsDir)) {
          const files = fs.readdirSync(analyticsDir);
          for (const file of files) {
            if (file.endsWith(".ndjson") || file.endsWith(".jsonl")) {
              fs.unlinkSync(path.join(analyticsDir, file));
            }
          }
        }
      } catch(e) {
        logEvent("reset_analytics_error", { shop, error: e.message }, "warn");
      }

      // Reset batches
      try {
        const batchesDir = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"), "batches");
        if (fs.existsSync(batchesDir)) {
          const files = fs.readdirSync(batchesDir);
          for (const file of files) {
            if (file.endsWith(".json")) fs.unlinkSync(path.join(batchesDir, file));
          }
        }
      } catch(e) {
        logEvent("reset_batches_error", { shop, error: e.message }, "warn");
      }

      // Reset suppliers, kits, inventory, sales orders, purchase orders, notifications
      const dirsToClean = ["suppliers", "kits", "inventory", "sales-orders", "purchase-orders", "notifications"];
      for (const subDir of dirsToClean) {
        try {
          const dirPath = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"), subDir);
          if (fs.existsSync(dirPath)) {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
              const filePath = path.join(dirPath, file);
              const stat = fs.statSync(filePath);
              if (stat.isFile()) fs.unlinkSync(filePath);
            }
          }
        } catch(e) {
          logEvent("reset_subdir_error", { shop, subDir, error: e.message }, "warn");
        }
      }

      logEvent("data_full_reset", { shop, autoSnapshotId: autoSnapId }, "warn");
      res.json({ success: true, autoSnapshotId: autoSnapId, message: "Toutes les données ont été réinitialisées. Un snapshot automatique a été créé." });
    } catch (e) {
      return apiError(res, 500, "Erreur reset: " + e.message);
    }
  });
});

// Delete a snapshot
router.delete("/api/data/snapshots/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const snapId = req.params.id;
    const dir = snapshotsDir(shop);
    const snapFile = path.join(dir, `${snapId}.json`);
    if (!fs.existsSync(snapFile)) return apiError(res, 404, "Snapshot introuvable");

    try {
      fs.unlinkSync(snapFile);
      res.json({ success: true });
    } catch(e) {
      return apiError(res, 500, "Erreur suppression: " + e.message);
    }
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

// Creer un profil
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

// ---
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

// ---
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
// ---
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
    logEvent("plan_api_called", { shop }, "debug");

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
      logEvent("trial_auto_start", { shop }, "info");
      planManager.startStarterTrial(shop);
    }

    // Compter les produits actuels
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const productCount = Array.isArray(snapshot.products) ? snapshot.products.length : 0;

    const planInfo = planManager.getPlanInfoForUI(shop, productCount);
    logEvent("plan_result", { plan: planInfo.current?.planId, trial: planInfo.trial?.active }, "debug");
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

// ---
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
      // ---
      return apiError(res, 400, "Pour revenir en Free, utilise /api/plan/cancel");
    }

    // ---
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

    // ---
    const existingSubs = await getActiveAppSubscriptions(shop);
    if (Array.isArray(existingSubs) && existingSubs.length) {
      return res.status(409).json({
        error: "billing_already_active",
        message: "Un abonnement Shopify est dejÆ’  actif pour cette boutique. Annule avant de recreer.",
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
        message: "Shopify a refusé la création d'abonnement",
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

// ---
router.post("/api/plan/cancel", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!planManager) return apiError(res, 500, "PlanManager non disponible");

    // ---
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

    // ---
    if (!sub?.id) {
      const result = planManager.cancelSubscription(shop);
      logEvent("plan_cancelled_no_shopify_sub", { shop }, "warn");
      return res.json({ success: true, shopifyCancelled: false, ...result });
    }

    const cancelled = await cancelAppSubscription(shop, sub.id, { prorate: true, reason: "OTHER" });

    if (cancelled.userErrors && cancelled.userErrors.length) {
      return res.status(400).json({
        error: "billing_cancel_user_errors",
        message: "Shopify a refusé l'annulation",
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
// ---
// =====================================================

// ---
router.get("/api/analytics/summary", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ---
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

// ---
router.get("/api/analytics/timeseries", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ---
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

// ---
router.get("/api/analytics/orders", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ---
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

// =====================================================
// VENTES MANUELLES (listing filtré)
// =====================================================
router.get("/api/analytics/manual-sales", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const from = req.query.from || null;
    const to = req.query.to || null;
    const limit = Math.min(Number(req.query.limit || 100), 500);

    // Get all sales, filter to manual only
    const allSales = analyticsStore.listSales({ shop, from, to, limit: 5000 });
    const manualSales = allSales.filter(s => s.source === "manual");

    // Sort by date desc
    manualSales.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));

    // Calculate summary
    const totalRevenue = manualSales.reduce((sum, s) => sum + (Number(s.netRevenue) || 0), 0);
    const totalCost = manualSales.reduce((sum, s) => sum + (Number(s.totalCost) || 0), 0);
    const totalMargin = totalRevenue - totalCost;
    const totalGrams = manualSales.reduce((sum, s) => sum + (Number(s.totalGrams) || 0), 0);
    const marginPercent = totalRevenue > 0 ? Math.round((totalMargin / totalRevenue) * 100) : 0;

    res.json({
      period: { from, to },
      summary: {
        count: manualSales.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalMargin: Math.round(totalMargin * 100) / 100,
        marginPercent,
        totalGrams: Math.round(totalGrams * 100) / 100,
      },
      sales: manualSales.slice(0, limit),
    });
  });
});

// =====================================================
// ÉTIQUETTES — dernière commande Shopify
// =====================================================
// Retourne la dernière commande Shopify (source webhook), pré-formattée pour
// alimenter showLabelsModal({ prefilledConfigs }) côté frontend.
// Filtre : on exclut les ventes manuelles (source === "manual" ou orderId
// préfixé "manual_"). Look-back 60 jours pour rester pertinent.
router.get("/api/labels/latest-order", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore || !analyticsStore.listSales) return apiError(res, 500, "Analytics non disponible");

    const fromDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const sales = analyticsStore.listSales({ shop, from: fromDate.toISOString(), limit: 5000 });

    const shopifySales = (sales || []).filter(s => {
      if (!s || !s.orderId) return false;
      if (s.source === "manual") return false;
      if (String(s.orderId).startsWith("manual_")) return false;
      return true;
    });

    if (shopifySales.length === 0) {
      return res.json({ order: null });
    }

    shopifySales.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    const latestOrderId = shopifySales[0].orderId;
    const latestDate = shopifySales[0].orderDate;

    const lines = shopifySales.filter(s => s.orderId === latestOrderId);

    const items = lines.map(s => {
      const qty = Number(s.quantity || 0) || 1;
      const totalGrams = Number(s.totalGrams || 0);
      const gramsPerUnit = Number(s.gramsPerUnit || 0) || (qty > 0 ? totalGrams / qty : totalGrams);
      const netRevenue = Number(s.netRevenue || 0);
      const unitPrice = qty > 0 ? netRevenue / qty : netRevenue;
      return {
        productId: String(s.productId || ""),
        productName: String(s.productName || ""),
        variantId: s.variantId || null,
        variantTitle: s.variantTitle || null,
        quantity: qty,
        gramsPerUnit: Math.round(gramsPerUnit * 100) / 100,
        totalGrams: Math.round(totalGrams * 100) / 100,
        netRevenue: Math.round(netRevenue * 100) / 100,
        unitPrice: Math.round(unitPrice * 100) / 100,
      };
    });

    res.json({
      order: {
        orderId: latestOrderId,
        orderNumber: lines[0].orderNumber || null,
        orderDate: latestDate,
        currency: lines[0].currency || "EUR",
        items,
        totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      },
    });
  });
});

// =====================================================
// FINANCE — Solde compte Qonto (compte principal)
// =====================================================
// Lit les credentials depuis l'env (QONTO_LOGIN + QONTO_SECRET_KEY) et
// interroge https://thirdparty.qonto.com/v2/organization. Retourne le solde
// du compte marque `main: true` (fallback : premier compte de la liste).
// Cache memoire 60s pour ne pas spammer l'API Qonto (limite 2 req/s).
const _qontoCache = { ts: 0, data: null, error: null };
const QONTO_CACHE_TTL_MS = 60 * 1000;

async function fetchQontoOrganization() {
  const login = String(process.env.QONTO_LOGIN || "").trim();
  const secret = String(process.env.QONTO_SECRET_KEY || "").trim();
  if (!login || !secret) {
    const err = new Error("qonto_not_configured");
    err.code = "qonto_not_configured";
    throw err;
  }
  const r = await fetch("https://thirdparty.qonto.com/v2/organization", {
    method: "GET",
    headers: {
      Authorization: `${login}:${secret}`,
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    const err = new Error(`qonto_api_${r.status}`);
    err.code = `qonto_api_${r.status}`;
    err.body = txt.slice(0, 500);
    throw err;
  }
  return r.json();
}

router.get("/api/finance/qonto-balance", (req, res) => {
  safeJson(req, res, async () => {
    const now = Date.now();
    const force = String(req.query?.force || "") === "1";

    if (!force && _qontoCache.data && now - _qontoCache.ts < QONTO_CACHE_TTL_MS) {
      return res.json({ ...(_qontoCache.data), cached: true });
    }
    if (!force && _qontoCache.error && now - _qontoCache.ts < QONTO_CACHE_TTL_MS) {
      return res.status(_qontoCache.error.status || 502).json({
        ...(_qontoCache.error.body),
        cached: true,
      });
    }

    try {
      const data = await fetchQontoOrganization();
      const accounts = (data && data.organization && data.organization.bank_accounts) || [];
      if (!accounts.length) {
        const payload = { configured: true, available: false, reason: "no_account" };
        _qontoCache.ts = now;
        _qontoCache.data = payload;
        _qontoCache.error = null;
        return res.json(payload);
      }
      const main = accounts.find((a) => a && a.main === true) || accounts[0];
      const balance = Number(main.balance != null ? main.balance : (main.balance_cents || 0) / 100);
      const authorizedBalance = main.authorized_balance != null
        ? Number(main.authorized_balance)
        : (main.authorized_balance_cents != null ? Number(main.authorized_balance_cents) / 100 : null);
      const payload = {
        configured: true,
        available: true,
        account: {
          slug: main.slug || null,
          name: main.name || null,
          iban: main.iban || null,
          currency: main.currency || "EUR",
          balance: Math.round(balance * 100) / 100,
          authorizedBalance: authorizedBalance != null ? Math.round(authorizedBalance * 100) / 100 : null,
          updatedAt: main.updated_at || null,
        },
        accountCount: accounts.length,
        organizationSlug: (data && data.organization && data.organization.slug) || null,
        fetchedAt: new Date().toISOString(),
      };
      _qontoCache.ts = now;
      _qontoCache.data = payload;
      _qontoCache.error = null;
      return res.json(payload);
    } catch (e) {
      if (e.code === "qonto_not_configured") {
        const payload = { configured: false, available: false, reason: "missing_env" };
        _qontoCache.ts = now;
        _qontoCache.data = payload;
        _qontoCache.error = null;
        return res.json(payload);
      }
      logEvent(
        "qonto_balance_error",
        { code: e.code || null, message: e.message || String(e), body: e.body || null },
        "warn"
      );
      const status = /qonto_api_(\d+)/.test(e.code || "") ? Number(RegExp.$1) : 502;
      const errBody = {
        configured: true,
        available: false,
        reason: e.code || "fetch_failed",
        message: e.message || "Qonto API error",
      };
      _qontoCache.ts = now;
      _qontoCache.data = null;
      _qontoCache.error = { status, body: errBody };
      return res.status(status).json(errBody);
    }
  });
});

// =====================================================
// FINANCE — Tresorerie / Cashflow Qonto sur N jours
// =====================================================
// Pull pagine /v2/transactions sur la periode, agrege en cashflow + top
// counterparties + timeline jour-par-jour. Croise avec le CA brut Shopify
// (analyticsStore) pour faire ressortir le gap "frais payment processor".
//
// Cache memoire 15min par valeur de "days" (1 entree par periode demandee).
// Pas de cache disque : le data set reste petit (50-300 transactions par mois)
// et un restart Render (~30min mini) re-pull naturellement.
const _qontoTreasuryCache = new Map(); // key = days -> { ts, data }
const QONTO_TREASURY_TTL_MS = 15 * 60 * 1000;
const QONTO_TX_PAGE_SIZE = 100;
const QONTO_TX_MAX_PAGES = 20; // garde-fou : 2000 tx max

async function fetchQontoTransactionsPage({ slug, fromIso, toIso, page }) {
  const login = String(process.env.QONTO_LOGIN || "").trim();
  const secret = String(process.env.QONTO_SECRET_KEY || "").trim();
  if (!login || !secret) {
    const err = new Error("qonto_not_configured");
    err.code = "qonto_not_configured";
    throw err;
  }
  const url = new URL("https://thirdparty.qonto.com/v2/transactions");
  url.searchParams.set("slug", slug);
  url.searchParams.set("settled_at_from", fromIso);
  url.searchParams.set("settled_at_to", toIso);
  url.searchParams.set("status", "completed");
  url.searchParams.set("per_page", String(QONTO_TX_PAGE_SIZE));
  url.searchParams.set("current_page", String(page));
  url.searchParams.set("sort_by", "settled_at:desc");
  const r = await fetch(url.toString(), {
    headers: {
      Authorization: `${login}:${secret}`,
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    const err = new Error(`qonto_api_${r.status}`);
    err.code = `qonto_api_${r.status}`;
    err.body = txt.slice(0, 500);
    throw err;
  }
  return r.json();
}

async function fetchQontoTransactions({ slug, fromIso, toIso }) {
  const all = [];
  let page = 1;
  let totalPages = 1;
  while (page <= QONTO_TX_MAX_PAGES) {
    const data = await fetchQontoTransactionsPage({ slug, fromIso, toIso, page });
    const items = Array.isArray(data?.transactions) ? data.transactions : [];
    all.push(...items);
    totalPages = Number(data?.meta?.total_pages || 1);
    if (page >= totalPages) break;
    page += 1;
  }
  return { transactions: all, totalPages };
}

function classifyCounterparty(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return "other";
  if (n.includes("shopify")) return "shopify";
  if (n.includes("stripe")) return "stripe";
  if (n.includes("paypal")) return "paypal";
  return "other";
}

function aggregateQontoTransactions(transactions, fromDate, toDate) {
  const cashflow = {
    credits: 0,
    debits: 0,
    net: 0,
    transactionCount: transactions.length,
    creditCount: 0,
    debitCount: 0,
  };
  const payouts = {
    shopify: { amount: 0, count: 0 },
    stripe: { amount: 0, count: 0 },
    paypal: { amount: 0, count: 0 },
    other: { amount: 0, count: 0 },
  };
  const byCounterpartyCredit = new Map();
  const byCounterpartyDebit = new Map();
  const byDay = new Map(); // date YYYY-MM-DD -> { credit, debit }

  for (const tx of transactions) {
    if (!tx) continue;
    const side = String(tx.side || "").toLowerCase(); // "credit" | "debit"
    const amount = Number(tx.amount != null ? tx.amount : (tx.amount_cents || 0) / 100);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const counterparty = String(tx.counterparty_name || tx.label || "Inconnu").trim() || "Inconnu";
    const day = String(tx.settled_at || tx.emitted_at || "").slice(0, 10);

    if (side === "credit") {
      cashflow.credits += amount;
      cashflow.creditCount += 1;
      const bucket = classifyCounterparty(counterparty);
      payouts[bucket].amount += amount;
      payouts[bucket].count += 1;
      const cur = byCounterpartyCredit.get(counterparty) || { name: counterparty, amount: 0, count: 0 };
      cur.amount += amount;
      cur.count += 1;
      byCounterpartyCredit.set(counterparty, cur);
      if (day) {
        const d = byDay.get(day) || { date: day, credit: 0, debit: 0 };
        d.credit += amount;
        byDay.set(day, d);
      }
    } else if (side === "debit") {
      cashflow.debits += amount;
      cashflow.debitCount += 1;
      const cur = byCounterpartyDebit.get(counterparty) || { name: counterparty, amount: 0, count: 0 };
      cur.amount += amount;
      cur.count += 1;
      byCounterpartyDebit.set(counterparty, cur);
      if (day) {
        const d = byDay.get(day) || { date: day, credit: 0, debit: 0 };
        d.debit += amount;
        byDay.set(day, d);
      }
    }
  }

  cashflow.credits = Math.round(cashflow.credits * 100) / 100;
  cashflow.debits = Math.round(cashflow.debits * 100) / 100;
  cashflow.net = Math.round((cashflow.credits - cashflow.debits) * 100) / 100;
  Object.keys(payouts).forEach((k) => {
    payouts[k].amount = Math.round(payouts[k].amount * 100) / 100;
  });

  const topCreditors = Array.from(byCounterpartyCredit.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map((x) => ({ name: x.name, amount: Math.round(x.amount * 100) / 100, count: x.count }));
  const topDebtors = Array.from(byCounterpartyDebit.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map((x) => ({ name: x.name, amount: Math.round(x.amount * 100) / 100, count: x.count }));

  // Timeline complete (jours sans tx -> 0/0)
  const timeline = [];
  const cursor = new Date(fromDate);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    const v = byDay.get(key) || { date: key, credit: 0, debit: 0 };
    timeline.push({
      date: key,
      credit: Math.round(v.credit * 100) / 100,
      debit: Math.round(v.debit * 100) / 100,
      net: Math.round((v.credit - v.debit) * 100) / 100,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return { cashflow, payouts, topCreditors, topDebtors, timeline };
}

// Reconstitue la timeline du patrimoine (Qonto + stock) sur la periode.
// Strategie : on connait les valeurs ACTUELLES (balance Qonto, stock value),
// et on walk-back jour par jour en soustrayant les deltas observes.
//
// Deltas par jour :
// - delta_qonto(d)   = credits(d) - debits(d)  [depuis agg.timeline Qonto]
// - delta_stock(d)   = sum(restocks_value(d)) - sum(sales_cost(d))
//   - sales : analyticsStore expose totalCost (CMP * qty au moment de la vente)
//   - restocks : movementStore expose gramsDelta + purchasePricePerGram (peut
//     etre absent quand le CMP n'a pas ete mis a jour) -> fallback sur le CMP
//     actuel du produit (perte de precision acceptable pour des CMP stables)
//
// Limites assumees :
// - Approximation lossy si les CMP ont beaucoup bouge (rare en CBD/cannabis)
// - On reconstruit a partir de l'etat ACTUEL : si une transaction Qonto plus
//   ancienne que la fenetre n'est pas dans le cashflow, c'est OK car la balance
//   actuelle l'integre deja
function buildPatrimoineTimeline({
  days,
  qontoTimeline,
  shop,
  fromDate,
  toDate,
  currentQontoBalance,
  currentStockValue,
  stockProducts, // [{ productId, averageCostPerGram }, ...] pour fallback CMP
}) {
  // Map productId -> CMP courant pour fallback restock sans purchasePricePerGram
  const cmpByProduct = new Map();
  for (const p of stockProducts || []) {
    if (p && p.productId) cmpByProduct.set(String(p.productId), Number(p.averageCostPerGram) || 0);
  }

  // Delta cash Qonto par jour
  const qontoDeltaByDay = new Map();
  for (const t of qontoTimeline || []) {
    qontoDeltaByDay.set(t.date, Number(t.net) || 0);
  }

  // Delta stock par jour : restocks (entrees valorisees) - cost of goods sold
  const stockDeltaByDay = new Map();

  // 1. Sales -> coup en stock
  if (analyticsStore && typeof analyticsStore.listSales === "function") {
    try {
      const sales = analyticsStore.listSales({
        shop,
        from: fromDate.toISOString().slice(0, 10),
        to: toDate.toISOString().slice(0, 10),
        limit: 50000,
      });
      for (const s of sales || []) {
        const day = String(s.orderDate || s.ts || "").slice(0, 10);
        if (!day) continue;
        let cost = Number(s.totalCost) || 0;
        if (cost === 0) {
          // Fallback : qty * CMP courant du produit
          const qty = Number(s.quantity) || 0;
          const grams = Number(s.totalGrams) || qty * Number(s.gramsPerUnit || 0);
          const cmp = cmpByProduct.get(String(s.productId || "")) || 0;
          cost = grams * cmp;
        }
        stockDeltaByDay.set(day, (stockDeltaByDay.get(day) || 0) - cost);
      }
    } catch (_) {}
  }

  // 2. Restocks -> entree de valeur en stock
  if (movementStore && typeof movementStore.listMovements === "function") {
    try {
      // listMovements prend "days" en parametre, on couvre la periode + 1 jour de marge
      const movs = movementStore.listMovements({ shop, days: days + 1, limit: 10000 });
      for (const m of movs || []) {
        if (!m || m.source !== "restock") continue;
        const day = String(m.ts || "").slice(0, 10);
        if (!day) continue;
        const grams = Math.abs(Number(m.gramsDelta) || 0);
        if (grams <= 0) continue;
        let pricePerGram = Number(m.purchasePricePerGram) || 0;
        if (pricePerGram === 0) {
          // Fallback : CMP courant du produit
          pricePerGram = cmpByProduct.get(String(m.productId || "")) || 0;
        }
        const value = grams * pricePerGram;
        if (value > 0) {
          stockDeltaByDay.set(day, (stockDeltaByDay.get(day) || 0) + value);
        }
      }
    } catch (_) {}
  }

  // Walk back : on a les valeurs ACTUELLES (end-of-today), on retire les deltas
  // pour reconstruire l'historique.
  let runningQonto = currentQontoBalance;
  let runningStock = currentStockValue;

  const series = [];
  const cursor = new Date(toDate);
  cursor.setHours(23, 59, 59, 999);
  const start = new Date(fromDate);
  start.setHours(0, 0, 0, 0);

  while (cursor >= start) {
    const dayKey = cursor.toISOString().slice(0, 10);
    series.unshift({
      date: dayKey,
      qonto: Math.round(runningQonto * 100) / 100,
      stock: Math.round(runningStock * 100) / 100,
      patrimoine: Math.round((runningQonto + runningStock) * 100) / 100,
    });
    // Soustraction du delta du jour pour obtenir end-of-yesterday
    runningQonto -= qontoDeltaByDay.get(dayKey) || 0;
    runningStock -= stockDeltaByDay.get(dayKey) || 0;
    cursor.setDate(cursor.getDate() - 1);
  }

  return series;
}

function computeShopifyGrossForPeriod(shop, fromIso, toIso) {
  if (!analyticsStore || !analyticsStore.listSales) return null;
  try {
    const sales = analyticsStore.listSales({ shop, from: fromIso, to: toIso, limit: 50000 });
    let grossRevenue = 0;
    let netRevenue = 0;
    const orderIds = new Set();
    for (const s of sales || []) {
      const net = Number(s.netRevenue) || Number(s.sellingPriceTotal) || 0;
      const gross = Number(s.grossPrice) || net;
      grossRevenue += gross;
      netRevenue += net;
      if (s.orderId) orderIds.add(s.orderId);
    }
    return {
      grossRevenue: Math.round(grossRevenue * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100,
      orderCount: orderIds.size,
      lineCount: sales.length,
    };
  } catch (_) {
    return null;
  }
}

router.get("/api/finance/qonto-treasury", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 30, 1), 366);
    const force = String(req.query?.force || "") === "1";
    const cacheKey = `${shop}:${days}`;
    const now = Date.now();

    // Valeur stock recalculee a chaque hit (rapide, in-memory) pour eviter
    // d'afficher un stock perime apres une vente/restock dans la fenetre cache.
    // Retourne aussi le detail produits (CMP par produit) pour la timeline patrimoine.
    const computeStockValue = () => {
      try {
        if (stock && typeof stock.calculateTotalStockValue === "function") {
          const sv = stock.calculateTotalStockValue(shop);
          const products = Array.isArray(sv.products) ? sv.products : [];
          return {
            totalValue: Number(sv.totalValue || 0),
            currency: sv.currency || "EUR",
            productCount: products.length,
            _products: products, // interne, utilise pour fallback CMP timeline
          };
        }
      } catch (_) {}
      return null;
    };

    // Strip le champ interne avant exposition
    const stripStockInternals = (s) => {
      if (!s) return null;
      const { _products, ...rest } = s;
      return rest;
    };

    if (!force && _qontoTreasuryCache.has(cacheKey)) {
      const entry = _qontoTreasuryCache.get(cacheKey);
      if (now - entry.ts < QONTO_TREASURY_TTL_MS) {
        const freshStock = computeStockValue();
        // Recalcule la timeline patrimoine avec le stock value frais
        let freshPatrimoineTimeline = entry.data.patrimoineTimeline || null;
        if (
          freshStock &&
          entry.data.qonto &&
          entry.data.qonto.balance &&
          Array.isArray(entry.data.qonto.timeline)
        ) {
          try {
            const periodFrom = new Date(entry.data.period.from);
            const periodTo = new Date(entry.data.period.to);
            freshPatrimoineTimeline = buildPatrimoineTimeline({
              days: entry.data.period.days,
              qontoTimeline: entry.data.qonto.timeline,
              shop,
              fromDate: periodFrom,
              toDate: periodTo,
              currentQontoBalance: entry.data.qonto.balance.current,
              currentStockValue: freshStock.totalValue,
              stockProducts: freshStock._products,
            });
          } catch (_) {}
        }
        return res.json({
          ...entry.data,
          stock: stripStockInternals(freshStock),
          patrimoine: freshStock && entry.data.qonto && entry.data.qonto.balance
            ? Math.round((entry.data.qonto.balance.current + freshStock.totalValue) * 100) / 100
            : null,
          patrimoineTimeline: freshPatrimoineTimeline,
          cached: true,
        });
      }
    }

    let org;
    try {
      org = await fetchQontoOrganization();
    } catch (e) {
      if (e.code === "qonto_not_configured") {
        return res.json({ configured: false, available: false, reason: "missing_env" });
      }
      logEvent("qonto_treasury_error", { stage: "organization", code: e.code, message: e.message }, "warn");
      return res.status(502).json({ configured: true, available: false, reason: e.code || "fetch_failed" });
    }

    const accounts = (org && org.organization && org.organization.bank_accounts) || [];
    if (!accounts.length) {
      return res.json({ configured: true, available: false, reason: "no_account" });
    }
    const main = accounts.find((a) => a && a.main === true) || accounts[0];
    const slug = main.slug;
    const currency = main.currency || "EUR";
    const currentBalance = Number(main.balance != null ? main.balance : (main.balance_cents || 0) / 100);

    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - days * 86400000);
    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();

    let txData;
    try {
      txData = await fetchQontoTransactions({ slug, fromIso, toIso });
    } catch (e) {
      logEvent("qonto_treasury_error", { stage: "transactions", code: e.code, message: e.message }, "warn");
      return res.status(502).json({ configured: true, available: false, reason: e.code || "fetch_failed" });
    }

    const agg = aggregateQontoTransactions(txData.transactions, fromDate, toDate);
    const dailyAvgNet = days > 0 ? agg.cashflow.net / days : 0;
    const monthlyProjection = dailyAvgNet * 30;

    const shopifyGross = computeShopifyGrossForPeriod(shop, fromIso.slice(0, 10), toIso.slice(0, 10));

    // Gap "Shopify gross vs encaisse Qonto" : indicateur grossier des frais
    // payment processor. Pertinent SEULEMENT si on a au moins quelques payouts
    // Shopify dans la periode (sinon le lag 2-3j fausse tout).
    let processorGap = null;
    if (shopifyGross && agg.payouts.shopify.count > 0) {
      const grossDelta = shopifyGross.grossRevenue - agg.payouts.shopify.amount;
      const pct = shopifyGross.grossRevenue > 0 ? (grossDelta / shopifyGross.grossRevenue) * 100 : null;
      processorGap = {
        shopifyGrossRevenue: shopifyGross.grossRevenue,
        shopifyPayoutsReceived: agg.payouts.shopify.amount,
        gap: Math.round(grossDelta * 100) / 100,
        gapPercent: pct != null ? Math.round(pct * 100) / 100 : null,
        note: "Approximation: les payouts Shopify Payments arrivent avec 2-3j de delai et incluent refunds. A interpreter avec prudence sur des periodes courtes.",
      };
    }

    const payload = {
      configured: true,
      available: true,
      period: { days, from: fromIso, to: toIso },
      qonto: {
        balance: {
          current: Math.round(currentBalance * 100) / 100,
          currency,
          updatedAt: main.updated_at || null,
          accountName: main.name || null,
        },
        cashflow: agg.cashflow,
        payouts: agg.payouts,
        topCounterparties: { credits: agg.topCreditors, debits: agg.topDebtors },
        timeline: agg.timeline,
        runRate: {
          dailyAvgNet: Math.round(dailyAvgNet * 100) / 100,
          monthlyProjectionNet: Math.round(monthlyProjection * 100) / 100,
        },
        meta: {
          transactionsFetched: txData.transactions.length,
          pagesFetched: txData.totalPages,
          truncated: txData.totalPages > QONTO_TX_MAX_PAGES,
        },
      },
      shopify: shopifyGross,
      processorGap,
      fetchedAt: new Date().toISOString(),
    };

    const freshStock = computeStockValue();
    payload.stock = stripStockInternals(freshStock);
    payload.patrimoine = freshStock
      ? Math.round((payload.qonto.balance.current + freshStock.totalValue) * 100) / 100
      : null;

    // Timeline patrimoine (Qonto + stock par jour) pour le chart d'evolution
    if (freshStock) {
      try {
        payload.patrimoineTimeline = buildPatrimoineTimeline({
          days,
          qontoTimeline: payload.qonto.timeline,
          shop,
          fromDate,
          toDate,
          currentQontoBalance: payload.qonto.balance.current,
          currentStockValue: freshStock.totalValue,
          stockProducts: freshStock._products,
        });
      } catch (e) {
        logEvent("patrimoine_timeline_error", { shop, message: e.message }, "warn");
        payload.patrimoineTimeline = null;
      }
    } else {
      payload.patrimoineTimeline = null;
    }

    _qontoTreasuryCache.set(cacheKey, { ts: now, data: payload });
    return res.json(payload);
  });
});

// =====================================================
// DEBUG: Récap détaillé des commandes avec lignes brutes
// =====================================================
router.get("/api/analytics/orders-debug", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const from = req.query.from || null;
    const to = req.query.to || null;
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const allSales = analyticsStore.listSales({ shop, from, to, limit: 5000 });

    // Group by orderId
    const ordersMap = new Map();
    for (const sale of allSales) {
      const oid = sale.orderId || sale.id;
      if (!ordersMap.has(oid)) {
        ordersMap.set(oid, {
          orderId: sale.orderId,
          orderNumber: sale.orderNumber,
          orderDate: sale.orderDate,
          source: sale.source,
          lines: [],
          totalGrams: 0,
          totalRevenue: 0,
          totalCost: 0,
          totalMargin: 0,
        });
      }
      const order = ordersMap.get(oid);
      order.lines.push({
        productId: sale.productId,
        productName: sale.productName,
        variantTitle: sale.variantTitle,
        quantity: sale.quantity,
        gramsPerUnit: sale.gramsPerUnit,
        totalGrams: sale.totalGrams,
        grossPrice: sale.grossPrice,
        netRevenue: sale.netRevenue,
        costPerGram: sale.costPerGram,
        totalCost: sale.totalCost,
        margin: sale.margin,
      });
      order.totalGrams += Number(sale.totalGrams) || 0;
      order.totalRevenue += Number(sale.netRevenue) || 0;
      order.totalCost += Number(sale.totalCost) || 0;
      order.totalMargin += Number(sale.margin) || 0;
    }

    const orders = Array.from(ordersMap.values())
      .sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))
      .slice(0, limit)
      .map(o => ({
        ...o,
        totalGrams: Math.round(o.totalGrams * 100) / 100,
        totalRevenue: Math.round(o.totalRevenue * 100) / 100,
        totalCost: Math.round(o.totalCost * 100) / 100,
        totalMargin: Math.round(o.totalMargin * 100) / 100,
        // Flag anomalies
        anomalies: detectSaleAnomalies(o),
      }));

    res.json({ period: { from, to }, orders });
  });
});

function detectSaleAnomalies(order) {
  const anomalies = [];
  // Detect unusually high grams per unit (likely parsing bug)
  for (const line of order.lines) {
    const gpu = Number(line.gramsPerUnit) || 0;
    if (gpu > 100) anomalies.push("Ligne '" + line.productName + "' a " + gpu + "g/unite (suspect)");
    if (gpu === 1000) anomalies.push("Ligne '" + line.productName + "' = 1000g (probablement li.grams mal lu)");
  }
  // Detect impossible margin
  if (order.totalRevenue > 0 && order.totalMargin < -order.totalRevenue * 2) {
    anomalies.push("Marge absurde (-" + Math.abs(Math.round(order.totalMargin)) + "€ pour " + order.totalRevenue + "€ CA)");
  }
  return anomalies;
}

// =====================================================
// Analytics cleanup: détecte et supprime les doublons
// =====================================================
router.post("/api/analytics/deduplicate", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const dryRun = req.body?.dryRun !== false; // default true
    const deleteOrderIds = Array.isArray(req.body?.deleteOrderIds) ? req.body.deleteOrderIds.map(String) : [];
    const deleteOrderIdsSet = new Set(deleteOrderIds);

    const allSales = analyticsStore.listSales({ shop, limit: 50000 });
    
    // Group duplicates by orderId + productId (exclude manual_ sales from dedup)
    const seen = new Map();
    const duplicates = [];
    const kept = [];

    for (const sale of allSales) {
      const orderId = sale.orderId || "";
      const productId = sale.productId || "";
      
      // Manual sales: each has unique timestamp-based ID, keep all
      if (String(orderId).startsWith("manual_")) {
        kept.push(sale);
        continue;
      }

      const key = orderId + "|" + productId;
      if (seen.has(key)) {
        duplicates.push(sale);
      } else {
        seen.set(key, sale);
        kept.push(sale);
      }
    }

    if (dryRun) {
      // Group kept sales by orderId for clearer picture
      const uniqueByOrder = new Map();
      for (const sale of kept) {
        const oid = sale.orderId || sale.id;
        if (!uniqueByOrder.has(oid)) {
          uniqueByOrder.set(oid, {
            orderId: sale.orderId,
            orderNumber: sale.orderNumber,
            orderDate: sale.orderDate,
            source: sale.source,
            products: [],
            totalRevenue: 0,
            totalGrams: 0,
          });
        }
        const order = uniqueByOrder.get(oid);
        order.products.push({
          productName: sale.productName,
          quantity: sale.quantity,
          totalGrams: sale.totalGrams,
          netRevenue: sale.netRevenue,
        });
        order.totalRevenue += Number(sale.netRevenue) || 0;
        order.totalGrams += Number(sale.totalGrams) || 0;
      }

      const uniqueOrdersArray = Array.from(uniqueByOrder.values())
        .map(o => ({
          ...o,
          totalRevenue: Math.round(o.totalRevenue * 100) / 100,
          totalGrams: Math.round(o.totalGrams * 100) / 100,
          lineCount: o.products.length,
        }))
        .sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));

      return res.json({
        dryRun: true,
        totalSales: allSales.length,
        duplicatesFound: duplicates.length,
        wouldKeep: kept.length,
        uniqueOrders: uniqueOrdersArray,
        sampleDuplicates: duplicates.slice(0, 5).map(d => ({
          orderId: d.orderId,
          orderNumber: d.orderNumber,
          productName: d.productName,
          orderDate: d.orderDate,
        })),
      });
    }

    // Actually clean: rewrite the analytics files
    // Also remove entire orders that user selected for deletion
    const ordersDeletedCount = kept.filter(s => deleteOrderIdsSet.has(String(s.orderId))).length;
    const keptAfterUserDelete = kept.filter(s => !deleteOrderIdsSet.has(String(s.orderId)));

    if (duplicates.length === 0 && ordersDeletedCount === 0) {
      return res.json({ success: true, duplicatesRemoved: 0, ordersDeleted: 0, kept: kept.length });
    }

    try {
      const fs = require("fs");
      const path = require("path");
      const DATA_DIR = process.env.DATA_DIR || "/var/data";
      const analyticsDir = path.join(DATA_DIR, shop.replace(/[^a-z0-9._-]/g, "_"), "analytics");

      // Group kept sales by month file (excluding user-deleted orders)
      const byMonth = new Map();
      for (const sale of keptAfterUserDelete) {
        const d = new Date(sale.orderDate);
        const monthKey = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
        byMonth.get(monthKey).push(sale);
      }

      // Clear and rewrite each month file (NDJSON format - one JSON per line)
      if (fs.existsSync(analyticsDir)) {
        const files = fs.readdirSync(analyticsDir).filter(f => f.endsWith(".ndjson") || f.endsWith(".jsonl"));
        for (const file of files) {
          fs.unlinkSync(path.join(analyticsDir, file));
        }
      } else {
        fs.mkdirSync(analyticsDir, { recursive: true });
      }

      for (const [monthKey, sales] of byMonth) {
        const filePath = path.join(analyticsDir, monthKey + ".ndjson");
        const content = sales.map(s => JSON.stringify(s)).join("\n") + "\n";
        fs.writeFileSync(filePath, content, "utf8");
      }

      logEvent("analytics_deduplicated", { shop, removed: duplicates.length, ordersDeleted: ordersDeletedCount, kept: keptAfterUserDelete.length }, "info");
      res.json({
        success: true,
        duplicatesRemoved: duplicates.length,
        ordersDeleted: ordersDeletedCount,
        kept: keptAfterUserDelete.length,
      });
    } catch (e) {
      logEvent("analytics_dedup_error", { shop, error: e.message }, "error");
      return apiError(res, 500, "Erreur nettoyage: " + e.message);
    }
  });
});


// ---
router.get("/api/analytics/products/top", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsManager) return apiError(res, 500, "Analytics non disponible");

    // ---
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

// Export CSV - Format lisible
router.get("/api/analytics/export.csv", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!analyticsStore) return apiError(res, 500, "Analytics non disponible");

    const period = req.query.period || "30";
    const daysAgo = parseInt(period, 10) || 30;
    const now = new Date();
    const fromDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const from = fromDate.toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    
    const limit = Math.min(Number(req.query.limit || 10000), 50000);

    const sales = analyticsStore.listSales({ shop, from, to, limit });
    
    // En-têtes lisibles
    const header = [
      "Date commande",
      "N° commande",
      "Produit",
      "Variante",
      "Quantite",
      "Poids unitaire (g)",
      "Poids total (kg)",
      "Prix brut (EUR)",
      "Remise (EUR)",
      "CA net (EUR)",
      "Cout unitaire (EUR/kg)",
      "Cout total (EUR)",
      "Marge (EUR)",
      "Marge (%)"
    ].join(";");

    const csvEscape = (v) => {
      const s = String(v ?? "");
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const formatDate = (dateStr) => {
      if (!dateStr) return "";
      const d = new Date(dateStr);
      return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
    };

    const formatNumber = (num, decimals = 2) => {
      if (num === null || num === undefined || isNaN(num)) return "";
      return Number(num).toFixed(decimals).replace(".", ",");
    };

    const lines = (sales || []).map((s) => {
      const gramsPerUnit = s.gramsPerUnit || 0;
      const totalGrams = s.totalGrams || 0;
      const costPerGram = s.costPerGram || 0;
      
      return [
        csvEscape(formatDate(s.orderDate)),
        csvEscape(s.orderNumber || s.orderId || ""),
        csvEscape(s.productName || ""),
        csvEscape(s.variantTitle || "-"),
        csvEscape(s.quantity || 0),
        csvEscape(formatNumber(gramsPerUnit, 0)),
        csvEscape(formatNumber(totalGrams / 1000, 3)),
        csvEscape(formatNumber(s.grossPrice)),
        csvEscape(formatNumber(s.discountAmount)),
        csvEscape(formatNumber(s.netRevenue)),
        csvEscape(formatNumber(costPerGram * 1000)),
        csvEscape(formatNumber(s.totalCost)),
        csvEscape(formatNumber(s.margin)),
        csvEscape(formatNumber(s.marginPercent, 1))
      ].join(";");
    });

    // Ajouter une ligne de résumé
    const totalRevenue = sales.reduce((sum, s) => sum + (s.netRevenue || 0), 0);
    const totalCost = sales.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    const totalMargin = sales.reduce((sum, s) => sum + (s.margin || 0), 0);
    const avgMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
    
    const summaryLine = [
      "TOTAL",
      "",
      sales.length + " lignes",
      "",
      "",
      "",
      "",
      "",
      "",
      formatNumber(totalRevenue),
      "",
      formatNumber(totalCost),
      formatNumber(totalMargin),
      formatNumber(avgMarginPct, 1)
    ].join(";");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${daysAgo}j-${to}.csv"`);
    // BOM UTF-8 pour Excel + séparateur ; pour Excel FR
    res.send("\uFEFF" + [header, ...lines, "", summaryLine].join("\n"));
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

    // Seuils : on prend ceux configures par l'utilisateur dans
    // Parametres > Gestion du stock, avec des fallbacks raisonnables.
    // Source unique = settingsStore (= meme valeurs que dashboard principal).
    const userSettings = (settingsStore && settingsStore.loadSettings)
      ? (settingsStore.loadSettings(shop) || {})
      : {};
    const stockSettings = userSettings.stock || {};
    const SEUIL_RUPTURE = 0;
    const SEUIL_CRITIQUE = Number(stockSettings.criticalThreshold) > 0
      ? Number(stockSettings.criticalThreshold)
      : 50;
    const SEUIL_BAS = Number(stockSettings.lowStockThreshold) > 0
      ? Number(stockSettings.lowStockThreshold)
      : 200;
    const SEUIL_ROTATION_LENT = Number(stockSettings.rotationSlowDays) > 0
      ? Number(stockSettings.rotationSlowDays)
      : 30;
    const SEUIL_ROTATION_DORMANT = Number(stockSettings.rotationDormantDays) > 0
      ? Number(stockSettings.rotationDormantDays)
      : 60;

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

// (Ancienne route /api/analytics/sales basee sur Shopify Admin supprimee :
//  elle etait shadow par la route ligne ~1931 et lisait une autre source que
//  /analytics/orders-debug, ce qui faisait diverger Performance et Recap.
//  Source unique = analyticsStore, agregation faite dans la route fusionnee.)

// ============================================
// NOTIFICATIONS API
// ============================================

// Liste des notifications
router.get("/api/notifications", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const data = notificationStore.loadNotifications(shop);
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    
    // Trier par date décroissante
    alerts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    // Compter les non lues
    const unreadCount = alerts.filter(a => !a.read && !a.dismissed).length;
    
    // Filtrer les notifications non ignorées et limiter
    const notifications = alerts
      .filter(a => !a.dismissed)
      .slice(0, limit)
      .map(a => ({
        id: a.id,
        type: a.type,
        title: a.title || a.message,
        message: a.message,
        priority: a.priority || "medium",
        read: !!a.read,
        productId: a.productId,
        productName: a.productName,
        createdAt: a.createdAt
      }));

    res.json({ 
      notifications, 
      unreadCount,
      total: alerts.filter(a => !a.dismissed).length 
    });
  });
});

// Marquer une notification comme lue
router.patch("/api/notifications/:id/read", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const notificationId = req.params.id;
    const result = notificationStore.markAsRead(shop, notificationId);
    
    res.json({ success: true, notification: result });
  });
});

// Ignorer une notification
router.delete("/api/notifications/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const notificationId = req.params.id;
    const result = notificationStore.dismissAlert(shop, notificationId);
    
    res.json({ success: true });
  });
});

// Marquer toutes comme lues
router.post("/api/notifications/mark-all-read", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const data = notificationStore.loadNotifications(shop);
    if (Array.isArray(data.alerts)) {
      data.alerts.forEach(a => { a.read = true; });
      notificationStore.saveNotifications(shop, data);
    }
    
    res.json({ success: true });
  });
});

// Vérifier et générer les alertes (appelé périodiquement ou manuellement)
router.post("/api/notifications/check", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    try {
      // Récupérer les données de stock
      const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
      const products = Array.isArray(snapshot.products) ? snapshot.products : [];
      
      // Récupérer les settings pour les seuils
      const settings = settingsStore.loadSettings ? settingsStore.loadSettings(shop) : {};
      const criticalThreshold = (settings.stock && settings.stock.criticalThreshold) || 50;
      const lowThreshold = (settings.stock && settings.stock.lowStockThreshold) || 200;
      
      let alertsGenerated = 0;
      
      // Vérifier chaque produit
      products.forEach(p => {
        const totalGrams = p.totalGrams || 0;
        const productId = p.productId;
        const productName = p.name || "Produit";
        
        // Rupture de stock
        if (totalGrams <= 0) {
          notificationStore.addAlert(shop, {
            type: "out_of_stock",
            priority: "high",
            title: "Rupture de stock",
            message: productName + " est en rupture de stock",
            productId,
            productName
          });
          alertsGenerated++;
        }
        // Stock critique
        else if (totalGrams < criticalThreshold * 1000) { // Convertir en grammes
          notificationStore.addAlert(shop, {
            type: "critical_stock",
            priority: "high",
            title: "Stock critique",
            message: productName + " a un stock critique",
            productId,
            productName
          });
          alertsGenerated++;
        }
        // Stock bas
        else if (totalGrams < lowThreshold * 1000) { // Convertir en grammes
          notificationStore.addAlert(shop, {
            type: "low_stock",
            priority: "medium",
            title: "Stock bas",
            message: productName + " a un stock bas",
            productId,
            productName
          });
          alertsGenerated++;
        }
      });
      
      // Mettre à jour la date de dernière vérification
      const data = notificationStore.loadNotifications(shop);
      data.lastCheck = new Date().toISOString();
      notificationStore.saveNotifications(shop, data);
      
      logEvent("notifications_check", { shop, alertsGenerated }, "info");
      
      res.json({ 
        success: true, 
        alertsGenerated,
        lastCheck: data.lastCheck 
      });
    } catch (e) {
      logEvent("notifications_check_error", { shop, error: e.message }, "error");
      return apiError(res, 500, "Erreur: " + e.message);
    }
  });
});

// Paramètres des notifications
router.get("/api/notifications/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const data = notificationStore.loadNotifications(shop);
    res.json({ settings: data.settings || {} });
  });
});

router.put("/api/notifications/settings", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const newSettings = req.body || {};
    const data = notificationStore.loadNotifications(shop);
    data.settings = { ...data.settings, ...newSettings };
    notificationStore.saveNotifications(shop, data);
    
    res.json({ success: true, settings: data.settings });
  });
});

// ============================================
// ---
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
            logEvent("lot_creation_error", { error: e.message }, "warn");
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

    // Verifier le plan
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

    // Enrichir avec calcul cout/marge
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

// Detail d'un kit
router.get("/api/kits/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!kitStore) return apiError(res, 500, "Module kits non disponible");

    const kit = kitStore.getKit(shop, req.params.id);
    if (!kit) return apiError(res, 404, "Kit non trouve");

    // Enrichir avec calcul cout/marge
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

// Creer un kit
router.post("/api/kits", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Verifier le plan
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

// Mapper un kit   Shopify
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
      
      // Vérifier que le kit existe
      const kit = kitStore.getKit(shop, req.params.id);
      if (!kit) {
        return apiError(res, 404, "Kit non trouve");
      }
      
      // Vérifier que le kit a des composants
      if (!kit.items || kit.items.length === 0) {
        return apiError(res, 400, "Le kit n'a pas de composants. Ajoutez des composants avant d'assembler.");
      }
      
      const result = kitStore.assembleKits(shop, req.params.id, quantity || 1, {
        stockManager: stock,
        batchStore,
        allowNegative: allowNegative === true,
        notes,
      });
      res.json(result);
    } catch (e) {
      logEvent("kit_assemble_error", { error: e.message, stack: e.stack }, "error");
      return apiError(res, 400, e.message || "Erreur lors de l'assemblage");
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
      // Recuperer les couts produits
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

// Liste des previsions
router.get("/api/forecast", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    // Verifier le plan
    if (planManager) {
      const check = planManager.checkLimit(shop, "view_forecast");
      if (!check.allowed) {
        return res.status(403).json({ error: "plan_limit", message: check.reason, upgrade: check.upgrade });
      }
    }

    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const windowDays = parseInt(req.query.windowDays) || 30;
    const categoryId = req.query.categoryId || null;

    // Recuperer les produits puis exclure :
    //  - accessoires (trackByUnit) : pas de sens de prevoir au gramme
    //  - produits archives : hors catalogue
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const overridesMap = (productOverridesStore.listOverrides && productOverridesStore.listOverrides(shop)) || {};
    let products = (snapshot.products || []).filter((p) => {
      const ovr = overridesMap[String(p.productId || "")];
      if (!ovr) return true;
      return !ovr.trackByUnit && !ovr.archived;
    });

    // Filtrer par categorie
    if (categoryId) {
      products = products.filter(p => p.categoryIds && p.categoryIds.includes(categoryId));
    }

    // Recuperer les donnees de ventes (depuis analyticsStore si disponible)
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

// Detail prevision d'un produit
router.get("/api/forecast/:productId", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!forecastManager) return apiError(res, 500, "Module forecast non disponible");

    const windowDays = parseInt(req.query.windowDays) || 30;

    // Recuperer le produit
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const product = (snapshot.products || []).find(p => p.productId === req.params.productId);
    
    if (!product) return apiError(res, 404, "Produit non trouve");

    // Recuperer les ventes
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

    // Recuperer les produits puis filtrer accessoires/archives
    const snapshot = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [] };
    const overridesMap = (productOverridesStore.listOverrides && productOverridesStore.listOverrides(shop)) || {};
    const products = (snapshot.products || []).filter((p) => {
      const ovr = overridesMap[String(p.productId || "")];
      if (!ovr) return true;
      return !ovr.trackByUnit && !ovr.archived;
    });

    // Recuperer les ventes
    let salesData = [];
    if (analyticsStore && typeof analyticsStore.listSales === "function") {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - windowDays);
      salesData = analyticsStore.listSales({ shop, from: fromDate.toISOString(), limit: 50000 })
        .map(s => ({ date: s.orderDate, productId: s.productId, qty: s.totalGrams || 0 }));
    }

    // Recuperer les fournisseurs
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

    // Verifier le plan
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

// Creer une session
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

// Detail d'une session
router.get("/api/inventory/sessions/:id", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    const session = inventoryCountStore.getSession(shop, req.params.id);
    if (!session) return apiError(res, 404, "Session non trouvee");

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

// Demarrer une session (creer les items)
router.post("/api/inventory/sessions/:id/start", (req, res) => {
  safeJson(req, res, () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");
    if (!inventoryCountStore) return apiError(res, 500, "Module inventaire non disponible");

    try {
      // Recuperer les produits du catalogue
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

// Mettre   jour un item
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

// Mise   jour en masse (autosave)
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

// °venements d'audit
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
  // Routes PRO optionnelles non chargees
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

// ---
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

// ---
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
      // On pourrait mettre Æ’  jour le statut local si necessaire
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

    // --- DEDUPLICATION: skip if this order was already processed ---
    const orderId = String(payload?.id || "");
    if (isWebhookDuplicate(orderId)) {
      logEvent("webhook_duplicate_skipped", { shop, orderId, orderNumber: payload?.order_number }, "info");
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

      // Capture selling price per line from Shopify payload
      const unitPrice = Number(li?.price || 0);
      const lineTotal = unitPrice * qty;
      const lineDiscounts = Array.isArray(li?.discount_allocations)
        ? li.discount_allocations.reduce((sum, d) => sum + Number(d?.amount || 0), 0)
        : 0;
      const netLineRevenue = Math.max(0, lineTotal - lineDiscounts);

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
              orderId,
              orderNumber: payload?.order_number || payload?.name || "",
              sellingPriceTotal: netLineRevenue,
              sellingPricePerGram: gramsToSubtract > 0 ? netLineRevenue / gramsToSubtract : 0,
              shop,
            },
            shop
          );
        }
      }
    }

    // --- Record analytics (with selling prices from payload) ---
    try {
      if (analyticsManager && typeof analyticsManager.recordSaleFromOrder === "function") {
        await analyticsManager.recordSaleFromOrder(shop, payload);
        logEvent("analytics_sale_recorded", { shop, orderId: payload?.id, orderNumber: payload?.order_number }, "info");
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

// Global error handler
app.use((err, req, res, next) => {
  logEvent("unhandled_error", { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method 
  }, "error");
  res.status(500).json({ error: "Internal server error" });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logEvent("uncaught_exception", { error: err.message, stack: err.stack }, "error");
});

process.on('unhandledRejection', (reason) => {
  logEvent("unhandled_rejection", { reason: String(reason) }, "error");
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0'
  });
});

app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_started", { port: PORT, indexHtml: INDEX_HTML, apiAuthRequired: API_AUTH_REQUIRED });
});
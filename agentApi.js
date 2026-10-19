// agentApi.js - API machine-a-machine pour un agent (ex. Hermes) : lister les produits,
// importer un produit Shopify dans l'app, enregistrer une entree de stock (reappro avec prix d'achat).
//
// Montee sur `app` (PAS sur le router) : requireApiAuth / enforceAuthShopMatch de /api ne sont pas touches.
//   registerAgentRoutes(app, deps)   -> prefixe /agent/v1
//
// Securite :
//   - header X-Agent-Key, env AGENT_API_KEY (>= 32 car.). Absente/trop courte => TOUTES les routes /agent/v1 font 404.
//   - comparaison timingSafeEqual sur les digests sha256 ; la cle n'est jamais loguee.
//   - la boutique n'est JAMAIS lue dans la requete : env AGENT_SHOP (sinon 503).
//   - rate limit propre (AGENT_API_RATE_LIMIT_PER_MIN, defaut 30/min), body JSON limite a 100 ko.
//   - ecritures idempotentes (requestId) : ${DATA_DIR}/<shop>/agent-requests.json (.tmp + rename).
//
// Routes :
//   GET  /agent/v1/products?q=
//   POST /agent/v1/import   { productId, categoryIds?, requestId, dryRun? }
//   POST /agent/v1/restock  { productId, grams, purchasePricePerGram, supplier?, invoice?, note?, requestId, dryRun? }
//
// deps (tout est injecte depuis server.js, rien n'est require ici hors express / express-rate-limit) :
//   requis : stock, movementStore, normalizeShopDomain, logEvent, pushProductInventoryToShopify, parseGramsFromVariant
//   optionnels : productOverridesStore (archives), planManager (limites d'import),
//                getShopifyProduct(shop, productId) -> produit au format REST {id,title,handle,variants[]}
//                  (a defaut : shopifyFor(shop).product.get(Number(id)))  | shopifyFor(shop),
//                dataDir (defaut env DATA_DIR ou /var/data), env (defaut process.env)

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROUTE_PREFIX = "/agent/v1";
const MIN_KEY_LENGTH = 32;
const MAX_GRAMS = 20000;
const MAX_PRICE_PER_GRAM = 50;
const MAX_STORED_REQUESTS = 2000;
const DEFAULT_RATE_LIMIT_PER_MIN = 30;
const AGENT_PROFILE_NAME = "Agent Hermes";
const AGENT_PROFILE_COLOR = "#14b8a6";
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

class ApiError extends Error {
  constructor(status, error, message, extra) {
    super(message);
    this.status = status;
    this.error = error;
    this.extra = extra || null;
  }
}

// Meme logique que movementStore/stockState/productOverridesStore.
function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  if (!s) return "default";
  return s.replace(/[^a-z0-9._-]/g, "_");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

// ---------------------------------------------------------------
// Store d'idempotence : ${dataDir}/<shop>/agent-requests.json
// { version: 1, entries: [{ requestId, route, fingerprint, at, result }] } (les 2000 dernieres)
// ---------------------------------------------------------------
function createRequestStore(dataDir, logEvent) {
  const cache = new Map(); // shopKey -> { entries: [], index: Map<requestId, entry> }

  const fileFor = (shop) => path.join(dataDir, sanitizeShop(shop), "agent-requests.json");

  function load(shop) {
    const key = sanitizeShop(shop);
    if (cache.has(key)) return cache.get(key);

    let entries = [];
    const file = fileFor(shop);
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries.filter((e) => e && e.requestId);
      }
    } catch (e) {
      // Fichier illisible : on le garde de cote (pas d'ecrasement silencieux) et on repart vide.
      logEvent("agent_api_store_error", { message: String(e?.message || e) }, "error");
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {}
      entries = [];
    }
    const slot = { entries, index: new Map(entries.map((e) => [e.requestId, e])) };
    cache.set(key, slot);
    return slot;
  }

  function get(shop, requestId) {
    return load(shop).index.get(requestId) || null;
  }

  function put(shop, entry) {
    const slot = load(shop);
    const existing = slot.index.get(entry.requestId);
    if (existing) {
      Object.assign(existing, entry);
    } else {
      slot.entries.push(entry);
      slot.index.set(entry.requestId, entry);
      while (slot.entries.length > MAX_STORED_REQUESTS) {
        const dropped = slot.entries.shift();
        slot.index.delete(dropped.requestId);
      }
    }

    const file = fileFor(shop);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: slot.entries }), "utf8");
    fs.renameSync(tmp, file);
  }

  return { get, put };
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------
function readBody(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    throw new ApiError(400, "invalid_body", "Corps JSON attendu (Content-Type: application/json)");
  }
  return b;
}

function parseNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v.trim());
  return NaN;
}

function optString(v, field, max) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ApiError(400, "invalid_field", `${field} doit etre une chaine`);
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > max) throw new ApiError(400, "invalid_field", `${field} trop long (max ${max} caracteres)`);
  return s;
}

function readDryRun(body) {
  if (body.dryRun === undefined) return false;
  if (typeof body.dryRun !== "boolean") throw new ApiError(400, "invalid_field", "dryRun doit etre un booleen");
  return body.dryRun;
}

// requestId obligatoire pour une ecriture ; facultatif pour un dryRun (jamais stocke).
function readRequestId(body, dryRun) {
  const raw = body.requestId;
  if (raw === undefined || raw === null || raw === "") {
    if (dryRun) return null;
    throw new ApiError(400, "invalid_request_id", "requestId requis (chaine de 8 a 100 caracteres)");
  }
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length < 8 || s.length > 100) {
    throw new ApiError(400, "invalid_request_id", "requestId doit etre une chaine de 8 a 100 caracteres");
  }
  return s;
}

function readShopifyProductId(body) {
  const raw = body.productId;
  const m = /^(?:gid:\/\/shopify\/Product\/)?(\d{1,20})$/.exec(String(raw ?? "").trim());
  if (!m) throw new ApiError(400, "invalid_product_id", "productId manquant ou invalide (id Shopify numerique)");
  return m[1];
}

function fingerprintOf(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj), "utf8").digest("hex");
}

function mapShopifyError(e) {
  const status = Number(e?.statusCode || e?.response?.statusCode || 0);
  if (status === 404) return new ApiError(404, "shopify_product_not_found", "Produit Shopify introuvable");
  if (status === 401 || status === 403) {
    return new ApiError(
      502,
      "shopify_auth_error",
      "Acces Shopify refuse ou token absent : ouvrir l'app dans Shopify pour reautoriser"
    );
  }
  if (status === 429) return new ApiError(503, "shopify_rate_limited", "Shopify limite les appels, reessayer plus tard");
  return new ApiError(502, "shopify_error", String(e?.message || "Erreur Shopify").slice(0, 200));
}

// ---------------------------------------------------------------
// Enregistrement des routes
// ---------------------------------------------------------------
function registerAgentRoutes(app, deps = {}) {
  const express = require("express");
  const env = deps.env || process.env;
  const logEvent = typeof deps.logEvent === "function" ? deps.logEvent : () => {};

  const router = express.Router();
  app.use(ROUTE_PREFIX, router);

  const reply404 = (res) => res.status(404).json({ error: "not_found", message: "Not found" });

  // --- Config / garde-fous de demarrage : en cas de doute, la fonctionnalite reste desactivee (404).
  const apiKey = String(env.AGENT_API_KEY || "");
  let rateLimit = null;
  try {
    rateLimit = require("express-rate-limit");
  } catch {}

  const missing = ["stock", "movementStore", "normalizeShopDomain", "pushProductInventoryToShopify", "parseGramsFromVariant"]
    .filter((k) => !deps[k]);

  let disabledReason = null;
  if (!apiKey) disabledReason = "AGENT_API_KEY absente";
  else if (apiKey.length < MIN_KEY_LENGTH) disabledReason = `AGENT_API_KEY trop courte (< ${MIN_KEY_LENGTH} caracteres)`;
  else if (!rateLimit) disabledReason = "express-rate-limit indisponible";
  else if (missing.length) disabledReason = `dependances manquantes: ${missing.join(",")}`;

  if (disabledReason) {
    router.use((req, res) => reply404(res));
    logEvent("agent_api_disabled", { reason: disabledReason }, apiKey ? "warn" : "info");
    return { enabled: false };
  }

  const { stock, movementStore, normalizeShopDomain, pushProductInventoryToShopify, parseGramsFromVariant } = deps;
  const productOverridesStore = deps.productOverridesStore || null;
  const planManager = deps.planManager || null;
  const dataDir = deps.dataDir || env.DATA_DIR || "/var/data";
  const keyDigest = sha256(apiKey);
  const requests = createRequestStore(dataDir, logEvent);
  const inflight = new Map(); // `${shop}|${requestId}` -> { fingerprint, promise }

  const perMin = Math.max(1, Number.parseInt(env.AGENT_API_RATE_LIMIT_PER_MIN, 10) || DEFAULT_RATE_LIMIT_PER_MIN);

  const shopRaw = String(env.AGENT_SHOP || "").trim();
  const agentShop = shopRaw ? normalizeShopDomain(shopRaw) : "";
  const shopOk = SHOP_RE.test(agentShop);

  async function fetchShopifyProduct(shop, productId) {
    if (typeof deps.getShopifyProduct === "function") return deps.getShopifyProduct(shop, productId);
    if (typeof deps.shopifyFor !== "function") throw new ApiError(500, "not_configured", "Client Shopify indisponible");
    return deps.shopifyFor(shop).product.get(Number(productId));
  }

  // --- Helpers catalogue
  const overridesOf = (shop) =>
    (productOverridesStore?.listOverrides && productOverridesStore.listOverrides(shop)) || {};

  function catalogProducts(shop) {
    const snap = stock.getCatalogSnapshot ? stock.getCatalogSnapshot(shop) : { products: [], categories: [] };
    return { products: Array.isArray(snap.products) ? snap.products : [], categories: snap.categories || [] };
  }

  function toProductView(p, overrides) {
    const ovr = overrides[String(p.productId)] || {};
    const variants = Object.entries(p.variants || {})
      .map(([label, v]) => ({
        label,
        grams: v.gramsPerUnit,
        variantId: v.variantId ?? null,
        inventoryItemId: v.inventoryItemId ?? null,
        canSell: v.canSell,
      }))
      .sort((a, b) => a.grams - b.grams);
    return {
      productId: String(p.productId),
      name: p.name,
      totalGrams: p.totalGrams,
      averageCostPerGram: p.averageCostPerGram,
      categoryIds: p.categoryIds || [],
      archived: ovr.archived === true,
      trackByUnit: ovr.trackByUnit === true,
      variants,
    };
  }

  function summary(p) {
    return { productId: String(p.productId), name: p.name, totalGrams: p.totalGrams, averageCostPerGram: p.averageCostPerGram };
  }

  const safeLog = (route, data) => {
    const clean = {};
    for (const [k, v] of Object.entries({ route, ...data })) if (v !== undefined && v !== null) clean[k] = v;
    logEvent("agent_api", clean);
  };

  // --- Execution idempotente d'une ecriture
  async function runWrite(req, res, { route, shop, requestId, fingerprint, productId, grams, execute }) {
    const replay = (body) => {
      safeLog(route, { productId, grams, requestId, replayed: true });
      return res.status(200).json({ ...body, replayed: true });
    };
    const conflict = () => {
      throw new ApiError(409, "request_id_conflict", "requestId deja utilise avec un contenu different");
    };

    const stored = requests.get(shop, requestId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) conflict();
      return replay(stored.result);
    }

    const key = `${shop}|${requestId}`;
    const running = inflight.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) conflict();
      const out = await running.promise;
      if (out.status < 300) return replay(out.body);
      return res.status(out.status).json(out.body);
    }

    const persist = (body) => {
      try {
        requests.put(shop, { requestId, route, fingerprint, at: new Date().toISOString(), result: body });
        return true;
      } catch (e) {
        logEvent("agent_api_store_error", { route, requestId, message: String(e?.message || e) }, "error");
        return false;
      }
    };

    const promise = (async () => {
      try {
        return await execute(persist);
      } catch (e) {
        if (e instanceof ApiError) return { status: e.status, body: errorBody(e) };
        throw e;
      }
    })();
    inflight.set(key, { fingerprint, promise });
    let out;
    try {
      out = await promise;
    } finally {
      inflight.delete(key);
    }
    if (out.status < 300) safeLog(route, { productId, grams, requestId, replayed: false });
    return res.status(out.status).json(out.body);
  }

  function errorBody(e) {
    return { error: e.error, message: e.message, ...(e.extra || {}) };
  }

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json(errorBody(e));
      logEvent("agent_api_error", { route: req.path, message: String(e?.message || e) }, "error");
      return res.status(500).json({ error: "internal_error", message: "Erreur serveur" });
    }
  };

  // --- Middlewares : rate limit -> auth -> boutique -> JSON
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: perMin,
      standardHeaders: true,
      legacyHeaders: false,
      // Derriere le proxy Render sans `trust proxy`, req.ip = IP du proxy : un seul agent, compteur global voulu.
      validate: { xForwardedForHeader: false },
      handler: (req, res) =>
        res.status(429).json({ error: "rate_limited", message: `Trop de requetes (max ${perMin}/min)` }),
    })
  );

  router.use((req, res, next) => {
    const given = sha256(req.get("X-Agent-Key") || "");
    if (!crypto.timingSafeEqual(given, keyDigest)) {
      logEvent("agent_api_unauthorized", { route: req.path, method: req.method }, "warn");
      return res.status(401).json({ error: "unauthorized", message: "Cle agent invalide ou manquante (header X-Agent-Key)" });
    }
    next();
  });

  router.use((req, res, next) => {
    if (!shopOk) {
      return res.status(503).json({ error: "agent_shop_not_configured", message: "AGENT_SHOP non configure cote serveur" });
    }
    req.agentShop = agentShop;
    next();
  });

  router.use(express.json({ limit: "100kb" }));

  // =============================================================
  // GET /products
  // =============================================================
  router.get(
    "/products",
    wrap(async (req, res) => {
      const shop = req.agentShop;
      const overrides = overridesOf(shop);
      const q = String(req.query.q || "").trim().toLowerCase();
      let products = catalogProducts(shop).products.map((p) => toProductView(p, overrides));
      if (q) products = products.filter((p) => String(p.name || "").toLowerCase().includes(q));
      products.sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }));
      res.json({ shop, count: products.length, products });
    })
  );

  // =============================================================
  // POST /import  (meme comportement que POST /api/import/product)
  // =============================================================
  router.post(
    "/import",
    wrap(async (req, res) => {
      const shop = req.agentShop;
      const body = readBody(req);
      const dryRun = readDryRun(body);
      const requestId = readRequestId(body, dryRun);
      const productId = readShopifyProductId(body);

      let categoryIds = [];
      if (body.categoryIds !== undefined && body.categoryIds !== null) {
        if (!Array.isArray(body.categoryIds) || body.categoryIds.length > 50) {
          throw new ApiError(400, "invalid_field", "categoryIds doit etre un tableau (max 50)");
        }
        categoryIds = body.categoryIds.map((c) => String(c ?? "").trim());
        if (categoryIds.some((c) => !c || c.length > 100)) {
          throw new ApiError(400, "invalid_field", "categoryIds contient une valeur invalide");
        }
      }

      const execute = async (persist) => {
        const before = catalogProducts(shop);
        const existing = before.products.find((p) => String(p.productId) === productId);
        if (existing) {
          return {
            status: 409,
            body: {
              error: "already_imported",
              message: "Produit deja present dans l'app : import ignore",
              product: toProductView(existing, overridesOf(shop)),
            },
          };
        }
        const known = new Set(before.categories.map((c) => String(c.id)));
        const unknown = categoryIds.filter((c) => !known.has(c));
        if (unknown.length) throw new ApiError(400, "unknown_category", `Categorie(s) inconnue(s): ${unknown.join(",")}`);

        if (planManager) {
          const checkImport = planManager.checkLimit(shop, "import_shopify");
          if (!checkImport.allowed) {
            return {
              status: 403,
              body: { error: "plan_limit", message: checkImport.reason, upgrade: checkImport.upgrade, feature: "import_shopify" },
            };
          }
          const checkProduct = planManager.checkLimit(shop, "add_product", { currentProductCount: before.products.length });
          if (!checkProduct.allowed) {
            return {
              status: 403,
              body: {
                error: "plan_limit",
                message: checkProduct.reason,
                upgrade: checkProduct.upgrade,
                feature: "max_products",
                limit: checkProduct.limit,
                current: checkProduct.current,
              },
            };
          }
        }

        let p;
        try {
          p = await fetchShopifyProduct(shop, productId);
        } catch (e) {
          if (e instanceof ApiError) throw e;
          throw mapShopifyError(e);
        }
        if (!p?.id) throw new ApiError(404, "shopify_product_not_found", "Produit Shopify introuvable");

        const variants = {};
        for (const v of p.variants || []) {
          const grams = parseGramsFromVariant(v);
          if (!grams) continue;
          variants[String(grams)] = {
            gramsPerUnit: grams,
            inventoryItemId: Number(v.inventory_item_id),
            variantId: String(v.id),
          };
        }
        if (!Object.keys(variants).length) {
          throw new ApiError(400, "no_grams_variant", "Aucune variante avec grammage detecte (option/title/sku).");
        }
        if (typeof stock.upsertImportedProductConfig !== "function") {
          throw new ApiError(500, "not_configured", "stock.upsertImportedProductConfig introuvable");
        }
        const name = String(p.title || p.handle || p.id);

        if (dryRun) {
          return {
            status: 200,
            body: {
              dryRun: true,
              wouldImport: true,
              product: { productId: String(p.id), name },
              variants: Object.values(variants).map((v) => ({
                grams: v.gramsPerUnit,
                variantId: v.variantId,
                inventoryItemId: v.inventoryItemId,
              })),
              categoryIds,
            },
          };
        }

        // Pendant l'appel Shopify, un autre import a pu creer le produit.
        if (catalogProducts(shop).products.some((x) => String(x.productId) === String(p.id))) {
          throw new ApiError(409, "already_imported", "Produit deja present dans l'app : import ignore");
        }

        let imported;
        try {
          imported = stock.upsertImportedProductConfig(shop, { productId: String(p.id), name, variants, categoryIds });
        } catch (e) {
          throw new ApiError(422, "import_failed", String(e?.message || "Import impossible").slice(0, 200));
        }

        const result = {
          success: true,
          requestId,
          product: toProductView(imported, overridesOf(shop)),
          inventorySync: { ok: null },
        };
        let stored = persist(result);

        if (movementStore.addMovement) {
          movementStore.addMovement(
            {
              source: "import_shopify_product",
              productId: String(p.id),
              productName: imported.name,
              gramsDelta: 0,
              meta: { categoryIds, requestId, via: "agent-api" },
              profileId: null,
              profileName: AGENT_PROFILE_NAME,
              profileColor: AGENT_PROFILE_COLOR,
              shop,
            },
            shop
          );
        }

        try {
          await pushProductInventoryToShopify(shop, imported);
          result.inventorySync = { ok: true };
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId: String(p.id), message: e?.message }, "error");
          result.inventorySync = { ok: false, error: String(e?.message || "push Shopify en echec").slice(0, 200) };
        }
        stored = persist(result) && stored;
        if (!stored) result.warning = "idempotence non persistee";
        return { status: 200, body: result };
      };

      if (dryRun) {
        const out = await execute(() => true);
        return res.status(out.status).json(out.body);
      }
      return runWrite(req, res, {
        route: "import",
        shop,
        requestId,
        fingerprint: fingerprintOf({ route: "import", productId, categoryIds }),
        productId,
        execute,
      });
    })
  );

  // =============================================================
  // POST /restock  (meme coeur que POST /api/restock)
  // =============================================================
  router.post(
    "/restock",
    wrap(async (req, res) => {
      const shop = req.agentShop;
      const body = readBody(req);
      const dryRun = readDryRun(body);
      const requestId = readRequestId(body, dryRun);

      const productId = String(body.productId ?? "").trim();
      if (!productId || productId.length > 40) throw new ApiError(400, "invalid_product_id", "productId manquant ou invalide");

      const grams = parseNumber(body.grams);
      if (!Number.isFinite(grams) || grams <= 0 || grams > MAX_GRAMS) {
        throw new ApiError(400, "invalid_grams", `grams invalide (nombre > 0 et <= ${MAX_GRAMS})`);
      }
      const price = parseNumber(body.purchasePricePerGram);
      if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE_PER_GRAM) {
        throw new ApiError(
          400,
          "invalid_price",
          `purchasePricePerGram invalide (nombre >= 0 et <= ${MAX_PRICE_PER_GRAM}, 0 = CMP inchange)`
        );
      }
      const supplier = optString(body.supplier, "supplier", 200);
      const invoice = optString(body.invoice, "invoice", 200);
      const note = optString(body.note, "note", 500);

      const execute = async (persist) => {
        const current = catalogProducts(shop).products.find((p) => String(p.productId) === productId);
        if (!current) throw new ApiError(404, "product_not_found", "Produit absent du catalogue de l'app (importer d'abord)");
        if (overridesOf(shop)[productId]?.archived === true) {
          throw new ApiError(409, "product_archived", "Produit archive : reappro refuse");
        }
        if (typeof stock.restockProduct !== "function") {
          throw new ApiError(500, "not_configured", "stock.restockProduct introuvable");
        }

        const totalGramsBefore = current.totalGrams;
        const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, productId) : current.averageCostPerGram;

        if (dryRun) {
          const cmpAfterEstimate =
            price > 0 && typeof stock.calculateWeightedAverageCost === "function"
              ? stock.calculateWeightedAverageCost(totalGramsBefore, cmpBefore, grams, price)
              : cmpBefore;
          return {
            status: 200,
            body: {
              dryRun: true,
              product: summary(current),
              totalGramsBefore,
              totalGramsAfter: totalGramsBefore + grams,
              cmpBefore,
              cmpAfterEstimate,
              cmpUpdated: price > 0,
            },
          };
        }

        const updated = await stock.restockProduct(shop, productId, grams, price);
        if (!updated) throw new ApiError(404, "product_not_found", "Produit introuvable");

        let mv = null;
        if (movementStore.addMovement) {
          mv = movementStore.addMovement(
            {
              source: "restock",
              productId,
              productName: updated.name,
              gramsDelta: Math.abs(grams),
              purchasePricePerGram: price > 0 ? price : undefined,
              cmpBefore: price > 0 ? cmpBefore : undefined,
              totalAfter: updated.totalGrams,
              profileId: null,
              profileName: AGENT_PROFILE_NAME,
              profileColor: AGENT_PROFILE_COLOR,
              meta: { supplier, invoice, note, requestId, via: "agent-api" },
              shop,
            },
            shop
          );
        }

        const result = {
          success: true,
          requestId,
          product: summary(updated),
          restocked: { grams, purchasePricePerGram: price, totalCost: Math.round(grams * price * 100) / 100 },
          totalGramsBefore,
          totalGramsAfter: updated.totalGrams,
          cmpBefore,
          cmpAfter: updated.averageCostPerGram,
          cmpUpdated: price > 0,
          movementId: mv ? mv.id : null,
          inventorySync: { ok: null },
        };
        // Enregistre AVANT l'appel Shopify (lent) : un rejeu ne doit jamais re-appliquer le stock.
        let stored = persist(result);

        try {
          await pushProductInventoryToShopify(shop, updated);
          result.inventorySync = { ok: true };
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId, message: e?.message }, "error");
          result.inventorySync = { ok: false, error: String(e?.message || "push Shopify en echec").slice(0, 200) };
        }
        stored = persist(result) && stored;
        if (!stored) result.warning = "idempotence non persistee";
        return { status: 200, body: result };
      };

      if (dryRun) {
        const out = await execute(() => true);
        return res.status(out.status).json(out.body);
      }
      return runWrite(req, res, {
        route: "restock",
        shop,
        requestId,
        fingerprint: fingerprintOf({ route: "restock", productId, grams, price, supplier, invoice, note }),
        productId,
        grams,
        execute,
      });
    })
  );

  // --- 404 JSON + erreurs (JSON invalide, body trop gros)
  router.use((req, res) => reply404(res));
  router.use((err, req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "JSON invalide" });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "payload_too_large", message: "Corps trop volumineux (max 100 ko)" });
    }
    logEvent("agent_api_error", { route: req.path, message: String(err?.message || err) }, "error");
    return res.status(500).json({ error: "internal_error", message: "Erreur serveur" });
  });

  logEvent("agent_api_enabled", { shop: agentShop || "non configure", rateLimitPerMin: perMin });
  return { enabled: true };
}

module.exports = { registerAgentRoutes };

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
//   POST /agent/v1/invoices { requestId, dryRun?, supplier{name,...}, invoice{number,date,productsHT,shippingHT,taxTotal,totalTTC,...},
//                             lines[{productId,grams,pricePerGram}], shippingAllocation?, pdf{filename,contentBase64}? }
//                           -> fournisseur + PO (COMPLETE) + PDF + entrees de stock au prix de revient (port reparti). Corps jusqu'a 15 Mo.
//   GET  /agent/v1/purchase-orders?limit=20&invoiceNumber=&supplierId=   (lecture seule : ce qui est deja enregistre)
//
// deps (tout est injecte depuis server.js, rien n'est require ici hors express / express-rate-limit) :
//   requis : stock, movementStore, normalizeShopDomain, logEvent, pushProductInventoryToShopify, parseGramsFromVariant
//   optionnels : productOverridesStore (archives), planManager (limites d'import, hasFeature('hasPurchaseOrders')),
//                supplierStore + purchaseOrderStore + documentStore (requis par /invoices et /purchase-orders),
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
const MAX_INVOICE_LINES = 50;
const MONEY_TOLERANCE = 0.02; // EUR : ecart accepte entre les totaux de la facture et la somme des lignes
const MAX_MONEY = 10000000;
const INVOICE_BODY_LIMIT = "15mb"; // PDF 10 Mo max -> ~13,4 Mo en base64
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
  const supplierStore = deps.supplierStore || null;
  const purchaseOrderStore = deps.purchaseOrderStore || null;
  const documentStore = deps.documentStore || null;
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

  // 100 ko partout, sauf POST /invoices (PDF en base64) : parser a part, lu seulement APRES l'auth ci-dessus.
  const smallJson = express.json({ limit: "100kb" });
  const invoiceJson = express.json({ limit: INVOICE_BODY_LIMIT });
  router.use((req, res, next) => (req.method === "POST" && req.path === "/invoices" ? invoiceJson(req, res, next) : smallJson(req, res, next)));

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
          let grams = parseGramsFromVariant(v);
          if (!grams) continue;
          // Le champ REST `grams` est un entier : une variante "1,5" pesee 1,5 g remonte grams=2.
          // Si le titre est un nombre decimal dont l'arrondi vaut ce `grams`, la valeur du titre fait foi.
          const titleNum = String(v?.option1 ?? v?.title ?? "").trim().replace(",", ".");
          if (/^\d+\.\d+$/.test(titleNum)) {
            const n = Number(titleNum);
            if (n > 0 && Number.isInteger(Number(v?.grams)) && Math.round(n) === Number(v.grams)) grams = n;
          }
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

  // =============================================================
  // POST /invoices : facture fournisseur reelle -> fournisseur + PO (COMPLETE) + PDF + entrees de stock
  //   (prix de revient = prix facture + port reparti ; PAS de passage par /receive : le stock n'est ajoute qu'une fois)
  // =============================================================
  const round2 = (n) => Math.round(n * 100) / 100;
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const sameMoney = (a, b) => Math.abs(a - b) <= MONEY_TOLERANCE + 1e-9;
  const norm = (s) => String(s || "").trim().toLowerCase();

  function requireObject(v, field) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ApiError(400, `invalid_${field}`, `${field} doit etre un objet`);
    return v;
  }
  function requiredString(v, field, code, max) {
    const s = optString(v, field, max);
    if (!s) throw new ApiError(400, code, `${field} requis`);
    return s;
  }
  function readMoney(v, field) {
    const n = parseNumber(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new ApiError(400, "invalid_amount", `${field} invalide (nombre >= 0 et <= ${MAX_MONEY})`);
    return n;
  }
  function readInvoiceDate(v) {
    const s = typeof v === "string" ? v.trim() : "";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      throw new ApiError(400, "invalid_invoice_date", "invoice.date doit etre une date reelle au format YYYY-MM-DD");
    }
    return s;
  }

  function parseInvoiceBody(body) {
    const s = requireObject(body.supplier, "supplier");
    const supplier = {
      name: requiredString(s.name, "supplier.name", "invalid_supplier", 200),
      siret: optString(s.siret, "supplier.siret", 40),
      vat: optString(s.vat, "supplier.vat", 40),
      address: optString(s.address, "supplier.address", 300),
      phone: optString(s.phone, "supplier.phone", 40),
      email: optString(s.email, "supplier.email", 200),
    };

    const i = requireObject(body.invoice, "invoice");
    const invoice = {
      number: requiredString(i.number, "invoice.number", "invalid_invoice_number", 100),
      date: readInvoiceDate(i.date),
      orderRef: optString(i.orderRef, "invoice.orderRef", 100),
      paymentMethod: optString(i.paymentMethod, "invoice.paymentMethod", 100),
      productsHT: readMoney(i.productsHT, "invoice.productsHT"),
      shippingHT: readMoney(i.shippingHT, "invoice.shippingHT"),
      taxTotal: readMoney(i.taxTotal, "invoice.taxTotal"),
      totalTTC: readMoney(i.totalTTC, "invoice.totalTTC"),
    };
    invoice.totalHT = round2(invoice.productsHT + invoice.shippingHT);
    if (i.totalHT !== undefined && i.totalHT !== null && !sameMoney(readMoney(i.totalHT, "invoice.totalHT"), invoice.totalHT)) {
      throw new ApiError(400, "totals_mismatch", "productsHT + shippingHT ne correspond pas a totalHT", {
        productsHT: invoice.productsHT,
        shippingHT: invoice.shippingHT,
        totalHT: Number(i.totalHT),
      });
    }
    if (!sameMoney(invoice.totalHT + invoice.taxTotal, invoice.totalTTC)) {
      throw new ApiError(400, "totals_mismatch", "totalHT + taxTotal ne correspond pas a totalTTC", {
        totalHT: invoice.totalHT,
        taxTotal: invoice.taxTotal,
        totalTTC: invoice.totalTTC,
      });
    }

    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > MAX_INVOICE_LINES) {
      throw new ApiError(400, "invalid_lines", `lines doit etre un tableau de 1 a ${MAX_INVOICE_LINES} lignes`);
    }
    const lines = body.lines.map((l, idx) => {
      const where = `lines[${idx}]`;
      requireObject(l, "lines");
      const productId = String(l.productId ?? "").trim();
      if (!productId || productId.length > 40) throw new ApiError(400, "invalid_product_id", `${where}.productId manquant ou invalide`);
      const grams = parseNumber(l.grams);
      if (!Number.isFinite(grams) || grams <= 0 || grams > MAX_GRAMS) {
        throw new ApiError(400, "invalid_grams", `${where}.grams invalide (nombre > 0 et <= ${MAX_GRAMS})`);
      }
      const pricePerGram = parseNumber(l.pricePerGram);
      if (!Number.isFinite(pricePerGram) || pricePerGram < 0 || pricePerGram > MAX_PRICE_PER_GRAM) {
        throw new ApiError(400, "invalid_price", `${where}.pricePerGram invalide (nombre >= 0 et <= ${MAX_PRICE_PER_GRAM})`);
      }
      return { productId, grams, pricePerGram, label: optString(l.label, `${where}.label`, 200) };
    });
    const linesTotal = round2(lines.reduce((sum, l) => sum + l.grams * l.pricePerGram, 0));
    if (!sameMoney(linesTotal, invoice.productsHT)) {
      throw new ApiError(400, "totals_mismatch", "La somme des lignes (grams x pricePerGram) ne correspond pas a invoice.productsHT", {
        linesTotal,
        productsHT: invoice.productsHT,
      });
    }

    const allocation = body.shippingAllocation === undefined || body.shippingAllocation === null ? "weight" : body.shippingAllocation;
    if (allocation !== "weight" && allocation !== "value") {
      throw new ApiError(400, "invalid_shipping_allocation", "shippingAllocation doit valoir 'weight' ou 'value'");
    }

    let pdf = null;
    if (body.pdf !== undefined && body.pdf !== null) {
      requireObject(body.pdf, "pdf");
      if (!documentStore) throw new ApiError(500, "not_configured", "documentStore indisponible");
      try {
        const buffer = documentStore.decodePdfBase64(body.pdf.contentBase64);
        pdf = {
          buffer,
          filename: optString(body.pdf.filename, "pdf.filename", 200) || `facture-${invoice.number}.pdf`,
          sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        };
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (e && e.status && e.code) throw new ApiError(e.status, e.code, e.message);
        throw e;
      }
    }
    return { supplier, invoice, lines, allocation, pdf, linesTotal };
  }

  // Prix de revient par gramme : prix facture + port reparti (au poids, ou a la valeur), arrondi a 4 decimales.
  function landedPrices(lines, shippingHT, allocation) {
    const totalGrams = lines.reduce((s, l) => s + l.grams, 0);
    const totalValue = lines.reduce((s, l) => s + l.grams * l.pricePerGram, 0);
    const byValue = allocation === "value" && totalValue > 0;
    return lines.map((l) => round4(l.pricePerGram + (byValue ? (shippingHT * l.pricePerGram) / totalValue : shippingHT / totalGrams)));
  }

  function findSupplier(shop, name) {
    return supplierStore.loadSuppliers(shop).find((s) => norm(s.name) === norm(name)) || null;
  }

  function invoiceSummaryOf(po) {
    const inv = po.invoice || null;
    return {
      id: po.id,
      number: po.number,
      status: po.status,
      supplierId: po.supplierId || null,
      supplierName: po.supplierName || "",
      createdAt: po.createdAt,
      receivedAt: po.receivedAt || null,
      invoice: inv,
      invoiceNumber: inv ? inv.number : null,
      subtotal: po.subtotal,
      shippingCost: po.shippingCost,
      total: po.total,
      currency: po.currency,
      lineCount: (po.lines || []).length,
      totalGrams: (po.lines || []).reduce((s, l) => s + (Number(l.orderedGrams) || 0), 0),
      documentIds: Array.isArray(po.documentIds) ? po.documentIds : [],
    };
  }

  router.post(
    "/invoices",
    wrap(async (req, res) => {
      const shop = req.agentShop;
      const body = readBody(req);
      const dryRun = readDryRun(body);
      const requestId = readRequestId(body, dryRun);
      const { supplier, invoice, lines, allocation, pdf } = parseInvoiceBody(body);

      const totalGrams = lines.reduce((s, l) => s + l.grams, 0);

      const execute = async (persist) => {
        if (!supplierStore || !purchaseOrderStore || !documentStore || typeof stock.restockProduct !== "function") {
          throw new ApiError(500, "not_configured", "Modules fournisseurs / commandes / documents indisponibles");
        }
        if (planManager && typeof planManager.hasFeature === "function" && !planManager.hasFeature(shop, "hasPurchaseOrders")) {
          return { status: 403, body: { error: "plan_limit", message: "Factures fournisseur reservees au plan Business", upgrade: "business", feature: "hasPurchaseOrders" } };
        }

        // --- Validation de l'etat (AUCUNE ecriture avant la fin de ce bloc)
        const catalog = catalogProducts(shop).products;
        const overrides = overridesOf(shop);
        const resolved = lines.map((l) => {
          const product = catalog.find((p) => String(p.productId) === l.productId);
          if (!product) {
            throw new ApiError(404, "product_not_found", `Produit ${l.productId} absent du catalogue de l'app (importer d'abord)`, { productId: l.productId });
          }
          if (overrides[l.productId]?.archived === true) {
            throw new ApiError(409, "product_archived", `Produit ${l.productId} archive : entree de stock refusee`, { productId: l.productId });
          }
          return product;
        });

        const existingSupplier = findSupplier(shop, supplier.name);
        const duplicate = purchaseOrderStore
          .listPurchaseOrders(shop, { limit: 100000 })
          .find((po) => po.status !== "cancelled" && po.invoice && norm(po.invoice.number) === norm(invoice.number) && norm(po.supplierName) === norm(supplier.name));
        if (duplicate) {
          throw new ApiError(409, "invoice_already_recorded", "Une facture avec ce numero est deja enregistree pour ce fournisseur", {
            purchaseOrder: { id: duplicate.id, number: duplicate.number },
          });
        }

        // --- Calcul (stock/CMP simules ligne apres ligne : un meme produit peut apparaitre 2 fois)
        const landed = landedPrices(lines, invoice.shippingHT, allocation);
        const sim = new Map();
        const plan = lines.map((l, idx) => {
          const product = resolved[idx];
          const state = sim.get(l.productId) || {
            grams: product.totalGrams,
            cmp: stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, l.productId) : product.averageCostPerGram,
          };
          const cmpAfter =
            landed[idx] > 0 && typeof stock.calculateWeightedAverageCost === "function"
              ? stock.calculateWeightedAverageCost(state.grams, state.cmp, l.grams, landed[idx])
              : state.cmp;
          sim.set(l.productId, { grams: state.grams + l.grams, cmp: cmpAfter });
          return {
            product: summary(product),
            grams: l.grams,
            invoicePricePerGram: l.pricePerGram,
            landedPricePerGram: landed[idx],
            totalGramsBefore: state.grams,
            totalGramsAfter: state.grams + l.grams,
            cmpBefore: state.cmp,
            cmpAfterEstimate: cmpAfter,
          };
        });

        const poLines = lines.map((l, idx) => ({ productId: l.productId, productName: resolved[idx].name, grams: l.grams, pricePerGram: l.pricePerGram }));
        const poInvoice = {
          number: invoice.number,
          date: invoice.date,
          orderRef: invoice.orderRef,
          taxTotal: invoice.taxTotal,
          totalTTC: invoice.totalTTC,
          paymentMethod: invoice.paymentMethod,
        };
        const totals = {
          productsHT: invoice.productsHT,
          shippingHT: invoice.shippingHT,
          totalHT: invoice.totalHT,
          taxTotal: invoice.taxTotal,
          totalTTC: invoice.totalTTC,
        };

        if (dryRun) {
          let docKnown = false;
          if (pdf) docKnown = documentStore.listDocuments(shop, {}).some((d) => d.sha256 === pdf.sha256);
          return {
            status: 200,
            body: {
              dryRun: true,
              supplier: { name: supplier.name, exists: !!existingSupplier, id: existingSupplier ? existingSupplier.id : null },
              purchaseOrder: {
                status: "complete",
                invoice: poInvoice,
                lines: poLines.map((l) => ({ ...l, lineTotal: round2(l.grams * l.pricePerGram) })),
                subtotal: invoice.productsHT,
                shippingCost: invoice.shippingHT,
                total: invoice.totalHT,
              },
              document: pdf ? { filename: documentStore.sanitizeFilename(pdf.filename), size: pdf.buffer.length, sha256: pdf.sha256, alreadyStored: docKnown } : null,
              shippingAllocation: allocation,
              totalGrams,
              lines: plan,
            },
          };
        }

        // --- Ecritures : fournisseur -> PO -> PDF -> stock par ligne
        let supplierRecord = existingSupplier;
        let supplierCreated = false;
        if (!supplierRecord) {
          const notes = [supplier.siret ? `SIRET ${supplier.siret}` : "", supplier.vat ? `TVA ${supplier.vat}` : ""].filter(Boolean).join(" - ");
          supplierRecord = supplierStore.createSupplier(shop, {
            name: supplier.name,
            contact: { email: supplier.email || "", phone: supplier.phone || "" },
            address: { street: supplier.address || "" },
            notes: notes ? `${notes} (cree depuis une facture via l'API agent)` : "Cree depuis une facture via l'API agent",
          });
          supplierCreated = true;
        }

        const po = purchaseOrderStore.createCompletedPurchaseOrder(shop, {
          supplierId: supplierRecord.id,
          supplierName: supplierRecord.name,
          shippingCost: invoice.shippingHT,
          lines: poLines,
          invoice: poInvoice,
          notes: `Facture ${invoice.number}`,
          internalNotes: `Saisie via l'API agent (requestId ${requestId})`,
          createdBy: AGENT_PROFILE_NAME,
        });

        let doc = null;
        let docDeduped = false;
        if (pdf) {
          const saved = documentStore.saveDocument(shop, {
            buffer: pdf.buffer,
            filename: pdf.filename,
            kind: "invoice",
            supplierId: supplierRecord.id,
            supplierName: supplierRecord.name,
            purchaseOrderId: po.id,
            invoiceNumber: invoice.number,
            invoiceDate: invoice.date,
            totals,
            createdBy: AGENT_PROFILE_NAME,
          });
          doc = saved.document;
          docDeduped = saved.deduped;
          purchaseOrderStore.attachDocument(shop, po.id, doc.id);
        }

        const resultLines = [];
        const updatedProducts = [];
        for (let idx = 0; idx < lines.length; idx++) {
          const l = lines[idx];
          const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, l.productId) : 0;
          const totalBefore = (stock.getProductSnapshot ? stock.getProductSnapshot(shop, l.productId)?.totalGrams : undefined) ?? plan[idx].totalGramsBefore;
          const updated = await stock.restockProduct(shop, l.productId, l.grams, landed[idx]);
          if (!updated) {
            throw new ApiError(500, "restock_failed", `Entree de stock impossible pour le produit ${l.productId} (PO ${po.number} deja cree)`, {
              purchaseOrder: { id: po.id, number: po.number },
            });
          }
          let mv = null;
          if (movementStore.addMovement) {
            mv = movementStore.addMovement(
              {
                source: "restock",
                productId: l.productId,
                productName: updated.name,
                gramsDelta: Math.abs(l.grams),
                purchasePricePerGram: landed[idx] > 0 ? landed[idx] : undefined,
                cmpBefore: landed[idx] > 0 ? cmpBefore : undefined,
                totalAfter: updated.totalGrams,
                profileId: null,
                profileName: AGENT_PROFILE_NAME,
                profileColor: AGENT_PROFILE_COLOR,
                meta: {
                  supplier: supplierRecord.name,
                  invoice: invoice.number,
                  purchaseOrderId: po.id,
                  documentId: doc ? doc.id : undefined,
                  requestId,
                  via: "agent-api",
                },
                shop,
              },
              shop
            );
          }
          updatedProducts.push(updated);
          resultLines.push({
            product: summary(updated),
            grams: l.grams,
            invoicePricePerGram: l.pricePerGram,
            landedPricePerGram: landed[idx],
            totalGramsBefore: totalBefore,
            totalGramsAfter: updated.totalGrams,
            cmpBefore,
            cmpAfter: updated.averageCostPerGram,
            movementId: mv ? mv.id : null,
            inventorySync: { ok: null },
          });
        }

        const result = {
          success: true,
          requestId,
          purchaseOrder: { id: po.id, number: po.number },
          documentId: doc ? doc.id : null,
          documentDeduped: docDeduped,
          supplierId: supplierRecord.id,
          supplierCreated,
          shippingAllocation: allocation,
          lines: resultLines,
          inventorySync: { ok: null },
        };
        // Enregistre AVANT les appels Shopify (lents) : un rejeu ne doit jamais re-appliquer le stock.
        let stored = persist(result);

        // Un seul push par produit (le plus recent etat), compte rendu ligne par ligne.
        const pushed = new Map();
        for (let idx = 0; idx < lines.length; idx++) {
          const pid = lines[idx].productId;
          if (!pushed.has(pid)) {
            const latest = updatedProducts.filter((u) => String(u.productId) === pid).pop();
            try {
              await pushProductInventoryToShopify(shop, latest);
              pushed.set(pid, { ok: true });
            } catch (e) {
              logEvent("inventory_push_error", { shop, productId: pid, message: e?.message }, "error");
              pushed.set(pid, { ok: false, error: String(e?.message || "push Shopify en echec").slice(0, 200) });
            }
          }
          resultLines[idx].inventorySync = pushed.get(pid);
        }
        const failed = [...pushed.values()].filter((p) => !p.ok).length;
        result.inventorySync = { ok: failed === 0, failed };
        stored = persist(result) && stored;
        if (!stored) result.warning = "idempotence non persistee";
        return { status: 200, body: result };
      };

      if (dryRun) {
        const out = await execute(() => true);
        return res.status(out.status).json(out.body);
      }
      return runWrite(req, res, {
        route: "invoices",
        shop,
        requestId,
        fingerprint: fingerprintOf({
          route: "invoices",
          supplier,
          invoice,
          lines: lines.map((l) => [l.productId, l.grams, l.pricePerGram]),
          allocation,
          pdf: pdf ? pdf.sha256 : null,
        }),
        grams: totalGrams,
        execute,
      });
    })
  );

  // =============================================================
  // GET /purchase-orders?limit=20&invoiceNumber=&supplierId=   (lecture seule)
  // =============================================================
  router.get(
    "/purchase-orders",
    wrap(async (req, res) => {
      const shop = req.agentShop;
      if (!purchaseOrderStore) throw new ApiError(500, "not_configured", "purchaseOrderStore indisponible");
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const supplierId = String(req.query.supplierId || "").trim();
      const invoiceNumber = norm(req.query.invoiceNumber);
      let orders = purchaseOrderStore.listPurchaseOrders(shop, { limit: 100000, supplierId: supplierId || undefined });
      if (invoiceNumber) orders = orders.filter((po) => po.invoice && norm(po.invoice.number).includes(invoiceNumber));
      const total = orders.length;
      res.json({ shop, count: Math.min(total, limit), total, purchaseOrders: orders.slice(0, limit).map(invoiceSummaryOf) });
    })
  );

  // --- 404 JSON + erreurs (JSON invalide, body trop gros)
  router.use((req, res) => reply404(res));
  router.use((err, req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "JSON invalide" });
    }
    if (err?.type === "entity.too.large") {
      const big = req.path === "/invoices";
      return res.status(413).json({ error: "payload_too_large", message: `Corps trop volumineux (max ${big ? "15 Mo" : "100 ko"})` });
    }
    logEvent("agent_api_error", { route: req.path, message: String(err?.message || err) }, "error");
    return res.status(500).json({ error: "internal_error", message: "Erreur serveur" });
  });

  logEvent("agent_api_enabled", { shop: agentShop || "non configure", rateLimitPerMin: perMin });
  return { enabled: true };
}

module.exports = { registerAgentRoutes };

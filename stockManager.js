// stockManager.js
// ============================================
// Bulk Stock Manager - Stock côté serveur
// - Source de vérité = app (elle écrase Shopify)
// - Persistance Render Disk via stockState.js (multi-boutique)
// - Queue pour éviter race conditions
// - Support suppression persistée (deletedProductIds)
// - ✅ FIX: produits BASE ne disparaissent plus à chaque deploy
// - ✅ REVENTE: produits BASE désactivables via env
// - ✅ FIX: compat exports stockState (loadState/saveState)
// - ✅ FIX: upsertImportedProductConfig compatible (shop,payload) / (payload) / (args...)
// ============================================

// ---------- stockState import ROBUSTE ----------
const stockStateMod = require("./stockState");

// support:
// - module.exports = { loadState, saveState }
// - exports.loadState = ...
// - module.exports = function loadState() { ... } (rare)
const loadState =
  typeof stockStateMod?.loadState === "function"
    ? stockStateMod.loadState
    : (typeof stockStateMod === "function" ? stockStateMod : null);

const saveState =
  typeof stockStateMod?.saveState === "function"
    ? stockStateMod.saveState
    : null;

if (typeof loadState !== "function") {
  throw new Error("stockState.loadState introuvable (vérifie stockState.js / exports)");
}
if (typeof saveState !== "function") {
  throw new Error("stockState.saveState introuvable (vérifie stockState.js / exports)");
}

const { listCategories } = require("./catalogStore");

// ✅ queue/logger dans /utils
const queueMod = require("./utils/queue");
const { logEvent } = require("./utils/logger");

// Compat queue : supporte `module.exports = stockQueue` OU `{ stockQueue }`
const stockQueue = queueMod?.add ? queueMod : queueMod?.stockQueue;

// --------------------------------------------
// CONFIG PRODUITS "BASE" (hardcodée)
// ✅ Pour vendre l'app : laisse ENABLE_BASE_PRODUCTS=false (par défaut).
// Pour TON shop : mets ENABLE_BASE_PRODUCTS=true dans Render.
// --------------------------------------------
const ENABLE_BASE_PRODUCTS = process.env.ENABLE_BASE_PRODUCTS === "true";

const BASE_PRODUCT_CONFIG = ENABLE_BASE_PRODUCTS
  ? {
      "10349843513687": {
        name: "3x Filtré",
        totalGrams: 50,
        categoryIds: [],
        variants: {
          "1.5": { gramsPerUnit: 1.5, inventoryItemId: 54088575582551 },
          "3": { gramsPerUnit: 3, inventoryItemId: 54088575615319 },
          "5": { gramsPerUnit: 5, inventoryItemId: 54088575648087 },
          "10": { gramsPerUnit: 10, inventoryItemId: 54088575680855 },
          "25": { gramsPerUnit: 25, inventoryItemId: 54088575713623 },
          "50": { gramsPerUnit: 50, inventoryItemId: 54088575746391 },
        },
      },
      // ... autres produits base si besoin
    }
  : {};

// --------------------------------------------
// STORE EN MÉMOIRE (par shop) ✅
// PRODUCT_CONFIG_BY_SHOP[shop] = { [productId]: config }
// --------------------------------------------
const PRODUCT_CONFIG_BY_SHOP = new Map();

// --------------------------------------------
// Helpers
// --------------------------------------------
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clampMin0(n) {
  return Math.max(0, toNum(n, 0));
}
function normalizeVariants(variants) {
  const safe = {};
  for (const [label, v] of Object.entries(variants || {})) {
    const gramsPerUnit = toNum(v?.gramsPerUnit, 0);
    const inventoryItemId = toNum(v?.inventoryItemId, 0);
    if (!inventoryItemId) continue;
    if (!gramsPerUnit || gramsPerUnit <= 0) continue;
    safe[String(label)] = { gramsPerUnit, inventoryItemId };
  }
  return safe;
}
function normalizeCategoryIds(categoryIds) {
  return Array.isArray(categoryIds) ? categoryIds.map(String) : [];
}
function normalizeDeletedIds(arr) {
  return Array.isArray(arr) ? arr.map(String) : [];
}

function buildProductView(config) {
  const total = clampMin0(config.totalGrams);
  const out = {};
  for (const [label, v] of Object.entries(config.variants || {})) {
    const gramsPer = toNum(v?.gramsPerUnit, 0);
    const canSell = gramsPer > 0 ? Math.floor(total / gramsPer) : 0;
    out[label] = {
      gramsPerUnit: gramsPer,
      inventoryItemId: v.inventoryItemId,
      canSell,
    };
  }
  return out;
}

function snapshotProduct(shop, productId) {
  const store = getStore(shop);
  const cfg = store[productId];
  if (!cfg) return null;

  return {
    productId: String(productId),
    name: String(cfg.name || productId),
    totalGrams: clampMin0(cfg.totalGrams),
    categoryIds: normalizeCategoryIds(cfg.categoryIds),
    variants: buildProductView(cfg),
  };
}

// --------------------------------------------
// Argument parsing (compat server)
// --------------------------------------------
function parseShopFirstArgs(shopOrProductId, maybeProductId, rest) {
  // Cas A: (shop, productId, ...)
  // Cas B: (productId, ...) => shop="default"
  // Détection simple: un shop contient souvent ".myshopify.com"
  const a = String(shopOrProductId ?? "");
  const looksLikeShop = a.includes(".myshopify.com") || a === "default";

  if (looksLikeShop) {
    return { shop: a || "default", productId: String(maybeProductId ?? ""), rest };
  }

  return { shop: "default", productId: String(shopOrProductId ?? ""), rest: [maybeProductId, ...rest] };
}

// --------------------------------------------
// STORE init/restore (par shop) ✅
// --------------------------------------------
function getStore(shop = "default") {
  const key = String(shop || "default");

  if (!PRODUCT_CONFIG_BY_SHOP.has(key)) {
    // Base store clone
    const base = {};
    for (const [pid, p] of Object.entries(BASE_PRODUCT_CONFIG)) {
      base[pid] = {
        name: p.name,
        totalGrams: p.totalGrams,
        categoryIds: normalizeCategoryIds(p.categoryIds),
        variants: normalizeVariants(p.variants),
      };
    }

    PRODUCT_CONFIG_BY_SHOP.set(key, base);

    // restore persisted
    restoreStateForShop(key);
  }

  return PRODUCT_CONFIG_BY_SHOP.get(key);
}

function persistState(shop, extra = {}) {
  const prev = loadState(shop) || {};
  const deletedProductIds = normalizeDeletedIds(extra.deletedProductIds ?? prev.deletedProductIds);

  const store = getStore(shop);

  const products = {};
  for (const [pid, p] of Object.entries(store)) {
    products[pid] = {
      name: String(p.name || pid),
      totalGrams: clampMin0(p.totalGrams),
      categoryIds: normalizeCategoryIds(p.categoryIds),
      variants: normalizeVariants(p.variants),
    };
  }

  saveState(shop, {
    version: 2,
    updatedAt: new Date().toISOString(),
    products,
    deletedProductIds,
  });
}

function restoreStateForShop(shop) {
  const store = PRODUCT_CONFIG_BY_SHOP.get(shop);
  const saved = loadState(shop) || {};

  // v2
  if (saved.version === 2 && saved.products && typeof saved.products === "object") {
    const restoredIds = Object.keys(saved.products);

    // 1) restore products
    for (const [pid, p] of Object.entries(saved.products)) {
      store[pid] = {
        name: String(p?.name || pid),
        totalGrams: clampMin0(p?.totalGrams),
        categoryIds: normalizeCategoryIds(p?.categoryIds),
        variants: normalizeVariants(p?.variants),
      };
    }

    // 2) apply tombstones (sans supprimer les BASE)
    const deleted = normalizeDeletedIds(saved.deletedProductIds);
    for (const pid of deleted) {
      if (BASE_PRODUCT_CONFIG[pid]) continue; // ✅ base toujours visible
      if (store[pid]) delete store[pid];
    }

    logEvent("stock_state_restore", {
      shop,
      mode: "v2",
      products: restoredIds.length,
      deleted: deleted.length,
    });

    return;
  }

  // Legacy
  if (saved && typeof saved === "object") {
    let applied = 0;
    for (const [pid, data] of Object.entries(saved)) {
      if (!store[pid]) continue;
      if (typeof data?.totalGrams === "number") store[pid].totalGrams = clampMin0(data.totalGrams);
      if (Array.isArray(data?.categoryIds)) store[pid].categoryIds = normalizeCategoryIds(data.categoryIds);
      applied++;
    }

    logEvent("stock_state_restore", { shop, mode: "legacy", applied });
  }
}

// --------------------------------------------
// Queue wrapper (anti race conditions)
// --------------------------------------------
function enqueue(fn) {
  if (stockQueue && typeof stockQueue.add === "function") return stockQueue.add(fn);
  return Promise.resolve().then(fn);
}

// --------------------------------------------
// API Stock (par shop) ✅
// --------------------------------------------

// ✅ Compat:
// applyOrderToProduct(shop, productId, gramsToSubtract)
// applyOrderToProduct(productId, gramsToSubtract)
async function applyOrderToProduct(shopOrProductId, maybeProductId, gramsToSubtract) {
  const { shop: sh, productId: pid, rest } = parseShopFirstArgs(shopOrProductId, maybeProductId, [gramsToSubtract]);
  const grams = rest.length ? rest[0] : gramsToSubtract;

  return enqueue(() => {
    const store = getStore(sh);
    const cfg = store[pid];
    if (!cfg) return null;

    const g = clampMin0(grams);
    cfg.totalGrams = clampMin0(clampMin0(cfg.totalGrams) - g);

    persistState(sh);
    return snapshotProduct(sh, pid);
  });
}

// ✅ Compat:
// restockProduct(shop, productId, gramsDelta)
// restockProduct(productId, gramsDelta)
async function restockProduct(shopOrProductId, maybeProductId, gramsDelta) {
  const { shop: sh, productId: pid, rest } = parseShopFirstArgs(shopOrProductId, maybeProductId, [gramsDelta]);
  const deltaRaw = rest.length ? rest[0] : gramsDelta;

  return enqueue(() => {
    const store = getStore(sh);
    const cfg = store[pid];
    if (!cfg) return null;

    const delta = toNum(deltaRaw, 0);
    cfg.totalGrams = clampMin0(clampMin0(cfg.totalGrams) + delta);

    persistState(sh);
    return snapshotProduct(sh, pid);
  });
}

function getStockSnapshot(shop = "default") {
  const sh = String(shop || "default");
  const store = getStore(sh);

  const out = {};
  for (const [pid] of Object.entries(store)) {
    out[pid] = snapshotProduct(sh, pid);
  }
  return out;
}

// --------------------------------------------
// Catégories (par shop) ✅
// --------------------------------------------

// ✅ Compat:
// setProductCategories(shop, productId, categoryIds)
// setProductCategories(productId, categoryIds)
function setProductCategories(shopOrProductId, maybeProductId, categoryIdsMaybe) {
  const { shop: sh, productId: pid, rest } = parseShopFirstArgs(shopOrProductId, maybeProductId, [categoryIdsMaybe]);
  const categoryIds = rest.length ? rest[0] : categoryIdsMaybe;

  const store = getStore(sh);
  const cfg = store[pid];
  if (!cfg) return false;

  const existing = new Set((listCategories?.(sh) || []).map((c) => String(c.id)));
  const ids = normalizeCategoryIds(categoryIds).filter((id) => existing.size === 0 || existing.has(String(id)));

  cfg.categoryIds = ids;
  persistState(sh);
  return true;
}

// --------------------------------------------
// Import Shopify -> Upsert config (par shop) ✅
// --------------------------------------------
//
// ✅ Support total:
// A) upsertImportedProductConfig(shop, {productId,name,totalGrams,variants,categoryIds})
// B) upsertImportedProductConfig({productId,name,totalGrams,variants,categoryIds})   // shop default
// C) upsertImportedProductConfig(productId, name, totalGrams, variants, categoryIds) // shop default
//
function upsertImportedProductConfig(arg1, arg2, arg3, arg4, arg5, arg6) {
  let sh = "default";
  let payload = null;

  // A) (shop, payload)
  if (typeof arg1 === "string" && arg2 && typeof arg2 === "object") {
    const looksLikeShop = arg1.includes(".myshopify.com") || arg1 === "default";
    if (looksLikeShop) {
      sh = arg1 || "default";
      payload = arg2;
    }
  }

  // B) (payload)
  if (!payload && arg1 && typeof arg1 === "object") {
    payload = arg1;
    sh = "default";
  }

  // C) (productId, name, totalGrams, variants, categoryIds)
  if (!payload) {
    payload = { productId: arg1, name: arg2, totalGrams: arg3, variants: arg4, categoryIds: arg5 };
    sh = "default";
  }

  const productId = payload?.productId;
  if (!productId) {
    throw new Error("Import: productId manquant (upsertImportedProductConfig)");
  }

  const pid = String(productId);
  const store = getStore(sh);

  const safeVariants = normalizeVariants(payload?.variants);
  if (!Object.keys(safeVariants).length) {
    throw new Error("Import: aucune variante valide (inventoryItemId/gramsPerUnit manquant)");
  }

  if (!store[pid]) {
    store[pid] = {
      name: String(payload?.name || pid),
      totalGrams: clampMin0(payload?.totalGrams),
      categoryIds: normalizeCategoryIds(payload?.categoryIds),
      variants: safeVariants,
    };
  } else {
    const cfg = store[pid];
    cfg.name = String(payload?.name || cfg.name || pid);
    cfg.variants = safeVariants;

    if (Number.isFinite(Number(payload?.totalGrams))) cfg.totalGrams = clampMin0(payload.totalGrams);
    if (Array.isArray(payload?.categoryIds)) cfg.categoryIds = normalizeCategoryIds(payload.categoryIds);
    if (!Array.isArray(cfg.categoryIds)) cfg.categoryIds = [];
  }

  // ✅ Si tombstone: on restaure à l'import
  const prev = loadState(sh) || {};
  const deleted = new Set(normalizeDeletedIds(prev.deletedProductIds));
  if (deleted.has(pid)) {
    deleted.delete(pid);
    persistState(sh, { deletedProductIds: Array.from(deleted) });
  } else {
    persistState(sh);
  }

  return snapshotProduct(sh, pid);
}

// --------------------------------------------
// Catalog snapshot (UI) ✅
// --------------------------------------------
function getCatalogSnapshot(shop = "default") {
  const sh = String(shop || "default");
  const categories = listCategories ? listCategories(sh) : [];
  const store = getStore(sh);
  const products = Object.keys(store).map((pid) => snapshotProduct(sh, pid));
  return { products, categories };
}

// --------------------------------------------
// Suppression produit (par shop) ✅
// --------------------------------------------

// ✅ Compat:
// removeProduct(shop, productId)
// removeProduct(productId)
function removeProduct(shopOrProductId, maybeProductId) {
  const { shop: sh, productId: pid } = parseShopFirstArgs(shopOrProductId, maybeProductId, []);

  const store = getStore(sh);
  if (!store[pid]) return false;

  delete store[pid];

  const allowDeleteBase = process.env.ALLOW_DELETE_BASE_PRODUCTS === "true";
  if (BASE_PRODUCT_CONFIG[pid] && !allowDeleteBase) {
    persistState(sh);
    return true;
  }

  const prev = loadState(sh) || {};
  const deleted = new Set(normalizeDeletedIds(prev.deletedProductIds));
  deleted.add(pid);

  persistState(sh, { deletedProductIds: Array.from(deleted) });
  return true;
}

module.exports = {
  // exposé pour debug si besoin
  PRODUCT_CONFIG_BY_SHOP,

  applyOrderToProduct,
  restockProduct,
  getStockSnapshot,
  upsertImportedProductConfig,
  setProductCategories,
  getCatalogSnapshot,
  removeProduct,
};

// stockManager.js
// ============================================
// Bulk Stock Manager - Stock côté serveur
// - Source de vérité = app (elle écrase Shopify)
// - Persistance Render Disk via stockState.js (multi-boutique)
// - Queue pour éviter race conditions
// - Support suppression persistée (deletedProductIds)
// - ✅ FIX: produits BASE ne disparaissent plus à chaque deploy
// - ✅ REVENTE: produits BASE désactivables via env
// ============================================

const { loadState, saveState } = require("./stockState");
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
async function applyOrderToProduct(shop, productId, gramsToSubtract) {
  const pid = String(productId);
  const sh = String(shop || "default");

  return enqueue(() => {
    const store = getStore(sh);
    const cfg = store[pid];
    if (!cfg) return null;

    const g = clampMin0(gramsToSubtract);
    cfg.totalGrams = clampMin0(clampMin0(cfg.totalGrams) - g);

    persistState(sh);
    return snapshotProduct(sh, pid);
  });
}

async function restockProduct(shop, productId, gramsDelta) {
  const pid = String(productId);
  const sh = String(shop || "default");

  return enqueue(() => {
    const store = getStore(sh);
    const cfg = store[pid];
    if (!cfg) return null;

    const delta = toNum(gramsDelta, 0);
    cfg.totalGrams = clampMin0(clampMin0(cfg.totalGrams) + delta);

    persistState(sh);
    return snapshotProduct(sh, pid);
  });
}

function getStockSnapshot(shop = "default") {
  const sh = String(shop || "default");
  const store = getStore(sh);

  const stock = {};
  for (const [pid] of Object.entries(store)) {
    stock[pid] = snapshotProduct(sh, pid);
  }
  return stock;
}

// --------------------------------------------
// Catégories (par shop) ✅
// --------------------------------------------
function setProductCategories(shop, productId, categoryIds) {
  const sh = String(shop || "default");
  const pid = String(productId);

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
function upsertImportedProductConfig(shop, { productId, name, totalGrams, variants, categoryIds }) {
  const sh = String(shop || "default");
  const pid = String(productId);

  const store = getStore(sh);

  const safeVariants = normalizeVariants(variants);
  if (!Object.keys(safeVariants).length) {
    throw new Error("Import: aucune variante valide (inventoryItemId/gramsPerUnit manquant)");
  }

  if (!store[pid]) {
    store[pid] = {
      name: String(name || pid),
      totalGrams: clampMin0(totalGrams),
      categoryIds: normalizeCategoryIds(categoryIds),
      variants: safeVariants,
    };
  } else {
    const cfg = store[pid];
    cfg.name = String(name || cfg.name || pid);
    cfg.variants = safeVariants;
    if (Number.isFinite(Number(totalGrams))) cfg.totalGrams = clampMin0(totalGrams);
    if (Array.isArray(categoryIds)) cfg.categoryIds = normalizeCategoryIds(categoryIds);
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
function removeProduct(shop, productId) {
  const sh = String(shop || "default");
  const pid = String(productId);

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

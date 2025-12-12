// stockManager.js
// Gestion du stock côté serveur avec queue pour éviter race conditions

const { loadState, saveState } = require("./stockState");
const { listCategories } = require("./catalogStore");
const { stockQueue } = require("./utils/queue");
const { logEvent } = require("./utils/logger");

// Configuration produits (ton existant)
const PRODUCT_CONFIG = {
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
  // ... (garde tous tes autres produits)
};

// Charger l'état persisté
(function applySavedTotals() {
  const saved = loadState();
  for (const [pid, data] of Object.entries(saved || {})) {
    if (!PRODUCT_CONFIG[pid]) continue;

    if (typeof data?.totalGrams === "number") {
      PRODUCT_CONFIG[pid].totalGrams = data.totalGrams;
    }
    if (Array.isArray(data?.categoryIds)) {
      PRODUCT_CONFIG[pid].categoryIds = data.categoryIds.map(String);
    }
  }
  logEvent("stock_state_loaded", { products: Object.keys(PRODUCT_CONFIG).length });
})();

function persistState() {
  const out = {};
  for (const [pid, p] of Object.entries(PRODUCT_CONFIG)) {
    out[pid] = {
      totalGrams: Number(p.totalGrams || 0),
      categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds.map(String) : [],
    };
  }
  saveState(out);
}

function buildProductView(config) {
  const variants = {};
  for (const [label, v] of Object.entries(config.variants || {})) {
    const gramsPer = Number(v.gramsPerUnit || 0);
    const canSell = gramsPer > 0 ? Math.floor((Number(config.totalGrams || 0)) / gramsPer) : 0;

    variants[label] = {
      gramsPerUnit: gramsPer,
      inventoryItemId: v.inventoryItemId,
      canSell,
    };
  }
  return variants;
}

// ✅ CORRIGÉ: Utilise la queue pour éviter race conditions
async function applyOrderToProduct(productId, gramsToSubtract) {
  return stockQueue.add(() => {
    const config = PRODUCT_CONFIG[productId];
    if (!config) return null;

    const g = Number(gramsToSubtract || 0);
    config.totalGrams = Math.max(0, Number(config.totalGrams || 0) - g);

    persistState();

    return {
      productId,
      name: config.name,
      totalGrams: config.totalGrams,
      categoryIds: config.categoryIds || [],
      variants: buildProductView(config),
    };
  });
}

// ✅ CORRIGÉ: Utilise la queue
async function restockProduct(productId, grams) {
  return stockQueue.add(() => {
    const config = PRODUCT_CONFIG[productId];
    if (!config) return null;

    const g = Number(grams || 0);
    config.totalGrams = Math.max(0, Number(config.totalGrams || 0) + g);

    persistState();

    return {
      productId,
      name: config.name,
      totalGrams: config.totalGrams,
      categoryIds: config.categoryIds || [],
      variants: buildProductView(config),
    };
  });
}

function getStockSnapshot() {
  const stock = {};
  for (const [productId, config] of Object.entries(PRODUCT_CONFIG)) {
    stock[productId] = {
      name: config.name,
      totalGrams: config.totalGrams,
      categoryIds: config.categoryIds || [],
      variants: buildProductView(config),
    };
  }
  return stock;
}

function setProductCategories(productId, categoryIds) {
  const p = PRODUCT_CONFIG[productId];
  if (!p) return false;

  p.categoryIds = Array.isArray(categoryIds) ? categoryIds.map(String) : [];
  persistState();
  return true;
}

function upsertImportedProductConfig({ productId, name, totalGrams, variants, categoryIds }) {
  const pid = String(productId);
  const exists = !!PRODUCT_CONFIG[pid];

  const safeVariants = {};
  for (const [label, v] of Object.entries(variants || {})) {
    const gramsPerUnit = Number(v.gramsPerUnit || 0) || 1;
    const inventoryItemId = Number(v.inventoryItemId);
    if (!inventoryItemId) continue;
    safeVariants[String(label)] = { gramsPerUnit, inventoryItemId };
  }

  if (!Object.keys(safeVariants).length) {
    throw new Error("Import: aucune variante valide (inventoryItemId manquant)");
  }

  if (!exists) {
    PRODUCT_CONFIG[pid] = {
      name: String(name || pid),
      totalGrams: Number.isFinite(Number(totalGrams)) ? Number(totalGrams) : 0,
      categoryIds: Array.isArray(categoryIds) ? categoryIds.map(String) : [],
      variants: safeVariants,
    };
  } else {
    PRODUCT_CONFIG[pid].name = String(name || PRODUCT_CONFIG[pid].name);
    PRODUCT_CONFIG[pid].variants = safeVariants;

    if (Number.isFinite(Number(totalGrams))) {
      PRODUCT_CONFIG[pid].totalGrams = Math.max(0, Number(totalGrams));
    }

    if (Array.isArray(categoryIds)) {
      PRODUCT_CONFIG[pid].categoryIds = categoryIds.map(String);
    } else if (!Array.isArray(PRODUCT_CONFIG[pid].categoryIds)) {
      PRODUCT_CONFIG[pid].categoryIds = [];
    }
  }

  persistState();

  const cfg = PRODUCT_CONFIG[pid];
  return {
    productId: pid,
    name: cfg.name,
    totalGrams: cfg.totalGrams,
    categoryIds: cfg.categoryIds || [],
    variants: buildProductView(cfg),
  };
}

function getCatalogSnapshot() {
  const categories = listCategories ? listCategories() : [];

  const products = Object.entries(PRODUCT_CONFIG).map(([productId, p]) => ({
    productId,
    name: p.name,
    totalGrams: Number(p.totalGrams || 0),
    categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds : [],
    variants: buildProductView(p),
  }));

  return { products, categories };
}

function removeProduct(productId) {
  const pid = String(productId);
  if (!PRODUCT_CONFIG[pid]) return false;

  delete PRODUCT_CONFIG[pid];
  persistState();
  return true;
}

module.exports = {
  PRODUCT_CONFIG,
  applyOrderToProduct,
  restockProduct,
  getStockSnapshot,
  upsertImportedProductConfig,
  setProductCategories,
  getCatalogSnapshot,
  removeProduct, // ✅ AJOUT
};
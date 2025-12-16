// stockManager.js - ENRICHI avec Coût Moyen Pondéré (CMP)
// ✅ NON-DESTRUCTIF : compatibilité totale avec l'existant
// ✅ NOUVEAUTÉS :
//    - averageCostPerGram par produit (CMP)
//    - recalcul automatique à chaque restock
//    - API pour valeur totale du stock

const stockStateMod = require("./stockState");
const loadState = typeof stockStateMod?.loadState === "function" ? stockStateMod.loadState : null;
const saveState = typeof stockStateMod?.saveState === "function" ? stockStateMod.saveState : null;

if (typeof loadState !== "function") throw new Error("stockState.loadState introuvable");
if (typeof saveState !== "function") throw new Error("stockState.saveState introuvable");

const { listCategories } = require("./catalogStore");
const queueMod = require("./utils/queue");
const { logEvent } = require("./utils/logger");
const stockQueue = queueMod?.add ? queueMod : queueMod?.stockQueue;

const ENABLE_BASE_PRODUCTS = process.env.ENABLE_BASE_PRODUCTS === "true";
const BASE_PRODUCT_CONFIG = ENABLE_BASE_PRODUCTS ? {
  "10349843513687": {
    name: "3x Filtré",
    totalGrams: 50,
    averageCostPerGram: 0,  // ✅ NOUVEAU champ (initialisé à 0)
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
} : {};

const PRODUCT_CONFIG_BY_SHOP = new Map();

// ============================================
// Helpers
// ============================================
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
    if (!inventoryItemId || !gramsPerUnit || gramsPerUnit <= 0) continue;
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

// ✅ NOUVEAU : Calcul du Coût Moyen Pondéré
function calculateWeightedAverageCost(currentStock, currentAvgCost, addedStock, purchasePrice) {
  const stock = clampMin0(currentStock);
  const avgCost = clampMin0(currentAvgCost);
  const added = clampMin0(addedStock);
  const purchase = clampMin0(purchasePrice);

  // Si pas de stock actuel, le nouveau prix devient le prix moyen
  if (stock === 0) return purchase;

  // Si pas d'ajout, on garde l'ancien prix
  if (added === 0) return avgCost;

  // Formule CMP : (stock_ancien × prix_ancien + stock_ajouté × prix_achat) / (stock_ancien + stock_ajouté)
  const totalValue = (stock * avgCost) + (added * purchase);
  const totalStock = stock + added;

  return totalStock > 0 ? totalValue / totalStock : avgCost;
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
    averageCostPerGram: clampMin0(cfg.averageCostPerGram || 0),  // ✅ NOUVEAU
    categoryIds: normalizeCategoryIds(cfg.categoryIds),
    variants: buildProductView(cfg),
  };
}

function parseShopFirstArgs(shopOrProductId, maybeProductId, rest) {
  const a = String(shopOrProductId ?? "");
  const looksLikeShop = a.includes(".myshopify.com") || a === "default";

  if (looksLikeShop) {
    return { shop: a || "default", productId: String(maybeProductId ?? ""), rest };
  }
  return { shop: "default", productId: String(shopOrProductId ?? ""), rest: [maybeProductId, ...rest] };
}

// ============================================
// Store init/restore
// ============================================
function getStore(shop = "default") {
  const key = String(shop || "default");

  if (!PRODUCT_CONFIG_BY_SHOP.has(key)) {
    const base = {};
    for (const [pid, p] of Object.entries(BASE_PRODUCT_CONFIG)) {
      base[pid] = {
        name: p.name,
        totalGrams: p.totalGrams,
        averageCostPerGram: toNum(p.averageCostPerGram, 0),  // ✅ NOUVEAU
        categoryIds: normalizeCategoryIds(p.categoryIds),
        variants: normalizeVariants(p.variants),
      };
    }
    PRODUCT_CONFIG_BY_SHOP.set(key, base);
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
      averageCostPerGram: clampMin0(p.averageCostPerGram || 0),  // ✅ NOUVEAU
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

  if (saved.version === 2 && saved.products && typeof saved.products === "object") {
    const restoredIds = Object.keys(saved.products);

    for (const [pid, p] of Object.entries(saved.products)) {
      store[pid] = {
        name: String(p?.name || pid),
        totalGrams: clampMin0(p?.totalGrams),
        averageCostPerGram: clampMin0(p?.averageCostPerGram || 0),  // ✅ NOUVEAU
        categoryIds: normalizeCategoryIds(p?.categoryIds),
        variants: normalizeVariants(p?.variants),
      };
    }

    const deleted = normalizeDeletedIds(saved.deletedProductIds);
    for (const pid of deleted) {
      if (BASE_PRODUCT_CONFIG[pid]) continue;
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

  // Legacy restore (sans averageCostPerGram)
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

function enqueue(fn) {
  if (stockQueue && typeof stockQueue.add === "function") return stockQueue.add(fn);
  return Promise.resolve().then(fn);
}

// ============================================
// API Stock (EXISTANTE - compatible)
// ============================================
async function applyOrderToProduct(shopOrProductId, maybeProductId, gramsToSubtract) {
  const { shop: sh, productId: pid, rest } = parseShopFirstArgs(shopOrProductId, maybeProductId, [gramsToSubtract]);
  const grams = rest.length ? rest[0] : gramsToSubtract;

  return enqueue(() => {
    const store = getStore(sh);
    const cfg = store[pid];
    if (!cfg) return null;

    const g = clampMin0(grams);
    cfg.totalGrams = clampMin0(clampMin0(cfg.totalGrams) - g);
    // ⚠️ Lors d'une vente, le CMP ne change PAS

    persistState(sh);
    return snapshotProduct(sh, pid);
  });
}

// ✅ ENRICHI : restockProduct avec calcul CMP
// Signature compatible : restockProduct(shop, productId, gramsDelta, purchasePricePerGram?)
async function restockProduct(shopOrProductId, maybeProductId, gramsDelta, purchasePricePerGram) {
  const { shop: sh, productId: pid, rest } = parseShopFirstArgs(shopOrProductId, maybeProductId, [gramsDelta, purchasePricePerGram]);
  const deltaRaw = rest.length ? rest[0] : gramsDelta;
  const priceRaw = rest.length > 1 ? rest[1] : purchasePricePerGram;

  return enqueue(() => {
    const store = getStore(sh);
    const cfg = store[pid];
    if (!cfg) return null;

    const delta = toNum(deltaRaw, 0);
    const purchasePrice = toNum(priceRaw, 0);

    // ✅ Recalcul du CMP si un prix d'achat est fourni
    if (delta > 0 && purchasePrice > 0) {
      const currentStock = clampMin0(cfg.totalGrams);
      const currentAvgCost = clampMin0(cfg.averageCostPerGram || 0);
      
      cfg.averageCostPerGram = calculateWeightedAverageCost(
        currentStock,
        currentAvgCost,
        delta,
        purchasePrice
      );

      logEvent("cmp_recalculated", {
        shop: sh,
        productId: pid,
        oldAvg: currentAvgCost.toFixed(2),
        newAvg: cfg.averageCostPerGram.toFixed(2),
        addedGrams: delta,
        purchasePrice: purchasePrice.toFixed(2),
      });
    }

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

// ============================================
// ✅ NOUVEAU : Calcul valeur totale du stock
// ============================================
function calculateTotalStockValue(shop = "default") {
  const sh = String(shop || "default");
  const store = getStore(sh);

  let totalValue = 0;
  const details = [];

  for (const [pid, cfg] of Object.entries(store)) {
    const stock = clampMin0(cfg.totalGrams);
    const avgCost = clampMin0(cfg.averageCostPerGram || 0);
    const value = stock * avgCost;

    if (value > 0) {
      totalValue += value;
      details.push({
        productId: pid,
        productName: cfg.name,
        totalGrams: stock,
        averageCostPerGram: avgCost,
        totalValue: value,
      });
    }
  }

  return {
    totalValue: Math.round(totalValue * 100) / 100, // arrondi à 2 décimales
    currency: "EUR",
    products: details.sort((a, b) => b.totalValue - a.totalValue),
  };
}

// ============================================
// ✅ NOUVEAU : Stats par catégorie
// ============================================
function getCategoryStats(shop = "default") {
  const sh = String(shop || "default");
  const store = getStore(sh);
  const categories = listCategories ? listCategories(sh) : [];

  let totalGrams = 0;
  const statsByCategory = new Map();

  // Init catégories
  for (const cat of categories) {
    statsByCategory.set(cat.id, {
      categoryId: cat.id,
      categoryName: cat.name,
      totalGrams: 0,
      totalValue: 0,
      productCount: 0,
    });
  }

  // Catégorie "Sans catégorie"
  statsByCategory.set("_uncategorized", {
    categoryId: "_uncategorized",
    categoryName: "Sans catégorie",
    totalGrams: 0,
    totalValue: 0,
    productCount: 0,
  });

  // Calcul
  for (const [pid, cfg] of Object.entries(store)) {
    const grams = clampMin0(cfg.totalGrams);
    const avgCost = clampMin0(cfg.averageCostPerGram || 0);
    const value = grams * avgCost;

    totalGrams += grams;

    const catIds = Array.isArray(cfg.categoryIds) && cfg.categoryIds.length > 0 
      ? cfg.categoryIds 
      : ["_uncategorized"];

    // Un produit peut avoir plusieurs catégories, on compte dans toutes
    for (const catId of catIds) {
      const stat = statsByCategory.get(catId);
      if (stat) {
        stat.totalGrams += grams;
        stat.totalValue += value;
        stat.productCount += 1;
      }
    }
  }

  // Calcul des pourcentages
  const results = Array.from(statsByCategory.values())
    .filter(s => s.totalGrams > 0)
    .map(s => ({
      ...s,
      percentage: totalGrams > 0 ? Math.round((s.totalGrams / totalGrams) * 100 * 100) / 100 : 0,
    }))
    .sort((a, b) => b.totalGrams - a.totalGrams);

  return {
    totalGrams,
    categories: results,
  };
}

// ============================================
// Autres fonctions (INCHANGÉES)
// ============================================
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

function upsertImportedProductConfig(arg1, arg2, arg3, arg4, arg5, arg6) {
  let sh = "default";
  let payload = null;

  if (typeof arg1 === "string" && arg2 && typeof arg2 === "object") {
    const looksLikeShop = arg1.includes(".myshopify.com") || arg1 === "default";
    if (looksLikeShop) {
      sh = arg1 || "default";
      payload = arg2;
    }
  }

  if (!payload && arg1 && typeof arg1 === "object") {
    payload = arg1;
    sh = "default";
  }

  if (!payload) {
    payload = { productId: arg1, name: arg2, totalGrams: arg3, variants: arg4, categoryIds: arg5 };
    sh = "default";
  }

  const productId = payload?.productId;
  if (!productId) throw new Error("Import: productId manquant");

  const pid = String(productId);
  const store = getStore(sh);

  const safeVariants = normalizeVariants(payload?.variants);
  if (!Object.keys(safeVariants).length) {
    throw new Error("Import: aucune variante valide");
  }

  if (!store[pid]) {
    store[pid] = {
      name: String(payload?.name || pid),
      totalGrams: clampMin0(payload?.totalGrams),
      averageCostPerGram: 0,  // ✅ Init à 0 pour les imports
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

function getCatalogSnapshot(shop = "default") {
  const sh = String(shop || "default");
  const categories = listCategories ? listCategories(sh) : [];
  const store = getStore(sh);
  const products = Object.keys(store).map((pid) => snapshotProduct(sh, pid));
  return { products, categories };
}

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

// ============================================
// ✅ NOUVEAU pour Analytics
// ============================================

/**
 * Récupère le CMP actuel d'un produit (pour snapshot analytics)
 * Utilisé par analyticsManager pour capturer le coût au moment de la vente
 */
function getProductCMPSnapshot(shop, productId) {
  const sh = String(shop || "default");
  const pid = String(productId || "");
  
  const store = getStore(sh);
  const cfg = store[pid];
  
  if (!cfg) return 0;
  
  return clampMin0(cfg.averageCostPerGram || 0);
}

/**
 * Récupère les infos complètes d'un produit pour analytics
 */
function getProductSnapshot(shop, productId) {
  const sh = String(shop || "default");
  const pid = String(productId || "");
  
  const store = getStore(sh);
  const cfg = store[pid];
  
  if (!cfg) return null;
  
  return {
    productId: pid,
    name: String(cfg.name || pid),
    totalGrams: clampMin0(cfg.totalGrams),
    averageCostPerGram: clampMin0(cfg.averageCostPerGram || 0),
    categoryIds: Array.isArray(cfg.categoryIds) ? cfg.categoryIds.slice() : [],
  };
}

module.exports = {
  PRODUCT_CONFIG_BY_SHOP,
  applyOrderToProduct,
  restockProduct,
  getStockSnapshot,
  upsertImportedProductConfig,
  setProductCategories,
  getCatalogSnapshot,
  removeProduct,
  
  // Fonctions CMP
  calculateTotalStockValue,
  getCategoryStats,
  calculateWeightedAverageCost,
  
  // ✅ NOUVEAU pour Analytics
  getProductCMPSnapshot,
  getProductSnapshot,
};
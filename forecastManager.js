// forecastManager.js - Prévisions de stock, ruptures et recommandations d'achat
// v1.0 - Forecast, Days of Stock, Reorder suggestions

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// CONSTANTES
// ============================================

const FORECAST_STATUS = {
  OK: "ok",               // > 30 jours de stock
  WATCH: "watch",         // 14-30 jours
  URGENT: "urgent",       // < 14 jours
  CRITICAL: "critical",   // < 7 jours
  OUT_OF_STOCK: "out",    // Rupture
  NO_DATA: "nodata",      // Pas de données de vente
  OVERSTOCK: "overstock", // Surstock (> 90 jours)
};

const DEFAULT_SETTINGS = {
  windowDays: 30,           // Fenêtre d'analyse des ventes
  forecastHorizon: 30,      // Horizon de prévision
  alertThresholdDays: 14,   // Seuil d'alerte rupture
  targetCoverageDays: 30,   // Couverture cible pour réassort
  reorderPointDays: 14,     // Point de réapprovisionnement
  includeReturns: false,    // Prendre en compte les retours
  ignoreZeroDays: false,    // Ignorer les jours sans ventes
  useVariants: false,       // Mode variantes
  outlierCapping: false,    // Cappage des outliers (Pro)
  outlierPercentile: 95,    // Percentile pour outliers
};

// ============================================
// HELPERS
// ============================================

function forecastDir(shop) {
  const dir = path.join(DATA_DIR, shop, "forecast");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function settingsFile(shop) {
  return path.join(forecastDir(shop), "settings.json");
}

function cacheFile(shop) {
  return path.join(forecastDir(shop), "cache.json");
}

function loadForecastSettings(shop) {
  try {
    const file = settingsFile(shop);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return { ...DEFAULT_SETTINGS, ...data };
    }
  } catch (e) {
    console.warn("Erreur lecture settings forecast:", e.message);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveForecastSettings(shop, settings) {
  const file = settingsFile(shop);
  const data = { ...DEFAULT_SETTINGS, ...settings, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
  return data;
}

function loadCache(shop) {
  try {
    const file = cacheFile(shop);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      // Cache valide 1 heure
      if (data.timestamp && (Date.now() - new Date(data.timestamp).getTime()) < 3600000) {
        return data;
      }
    }
  } catch (e) {}
  return null;
}

function saveCache(shop, data) {
  const file = cacheFile(shop);
  const cached = { ...data, timestamp: new Date().toISOString() };
  try {
    fs.writeFileSync(file + ".tmp", JSON.stringify(cached, null, 2), "utf8");
    fs.renameSync(file + ".tmp", file);
  } catch (e) {}
  return cached;
}

// ============================================
// CALCULS DE PRÉVISION
// ============================================

/**
 * Pre-agreger toutes les ventes par productId puis par jour, en un seul pass
 * sur la liste de ventes. Coupe les O(N x M) en O(N + M) pour generateForecast
 * qui sinon refiltre la liste complete pour chaque produit.
 *
 * @param {Array} salesData - [{ productId, date, qty }, ...]
 * @returns {Map<string, Map<string, number>>} productId -> day(YYYY-MM-DD) -> qty
 */
function preaggregateSalesByDay(salesData) {
  const byProduct = new Map();
  if (!Array.isArray(salesData)) return byProduct;
  for (const sale of salesData) {
    const pid = sale && sale.productId;
    if (!pid || !sale.date) continue;
    const day = String(sale.date).slice(0, 10);
    let dayMap = byProduct.get(pid);
    if (!dayMap) {
      dayMap = new Map();
      byProduct.set(pid, dayMap);
    }
    dayMap.set(day, (dayMap.get(day) || 0) + (Number(sale.qty) || 0));
  }
  return byProduct;
}

/**
 * Calculer le taux de vente journalier a partir d'une dayMap pre-aggregee.
 * Utilise une fenetre effective : si les donnees couvrent moins que
 * windowDays, on divise par le nombre reel de jours observes pour
 * eviter de sous-estimer le rythme d'un produit recent.
 */
function calculateDailyRateFromDayMap(dayMap, windowDays, options = {}) {
  if (!dayMap || dayMap.size === 0) {
    return { dailyRate: 0, hasData: false, dataPoints: 0, totalSold: 0, daysWithSales: 0, effectiveWindow: windowDays };
  }
  const { ignoreZeroDays = false, outlierCapping = false, outlierPercentile = 95 } = options;

  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - windowDays);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  // Filtrer par fenetre + collecter
  let totalQty = 0;
  let daysWithSales = 0;
  let firstDay = null;
  const dayValues = [];
  for (const [day, qty] of dayMap.entries()) {
    if (day < windowStartStr) continue;
    dayValues.push(qty);
    totalQty += qty;
    if (qty > 0) daysWithSales++;
    if (!firstDay || day < firstDay) firstDay = day;
  }

  if (dayValues.length === 0) {
    return { dailyRate: 0, hasData: false, dataPoints: 0, totalSold: 0, daysWithSales: 0, effectiveWindow: windowDays };
  }

  // Cappage des outliers (Pro)
  if (outlierCapping && dayValues.length > 5) {
    const sorted = dayValues.slice().sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * (outlierPercentile / 100));
    const cap = sorted[idx] || sorted[sorted.length - 1];
    totalQty = 0;
    for (let i = 0; i < dayValues.length; i++) {
      if (dayValues[i] > cap) dayValues[i] = cap;
      totalQty += dayValues[i];
    }
  }

  // Fenetre effective : min(windowDays, jours depuis premiere vente)
  let effectiveWindow = windowDays;
  if (firstDay) {
    const firstDate = new Date(firstDay + "T00:00:00Z");
    const diffDays = Math.max(1, Math.ceil((now.getTime() - firstDate.getTime()) / 86400000));
    effectiveWindow = Math.min(windowDays, diffDays);
  }
  const denominator = ignoreZeroDays ? Math.max(1, daysWithSales) : effectiveWindow;
  const dailyRate = totalQty / denominator;

  return {
    dailyRate: Math.round(dailyRate * 100) / 100,
    hasData: true,
    dataPoints: dayValues.length,
    totalSold: Math.round(totalQty * 100) / 100,
    daysWithSales,
    effectiveWindow,
  };
}

/**
 * Wrapper retro-compatible : prend l'ancienne forme [{date, qty}] et delegue.
 */
function calculateDailyRate(salesData, windowDays, options = {}) {
  if (!salesData || salesData.length === 0) {
    return { dailyRate: 0, hasData: false, dataPoints: 0 };
  }
  const dayMap = new Map();
  for (const s of salesData) {
    if (!s || !s.date) continue;
    const day = String(s.date).slice(0, 10);
    dayMap.set(day, (dayMap.get(day) || 0) + (Number(s.qty) || 0));
  }
  return calculateDailyRateFromDayMap(dayMap, windowDays, options);
}

/**
 * Calculer les jours de couverture
 */
function calculateDaysOfStock(currentStock, dailyRate) {
  if (dailyRate <= 0) {
    return currentStock > 0 ? Infinity : 0;
  }
  return Math.round((currentStock / dailyRate) * 10) / 10;
}

/**
 * Calculer la date de rupture estimée
 */
function calculateStockoutDate(daysOfStock) {
  if (daysOfStock === Infinity || daysOfStock <= 0) {
    return null;
  }
  
  const date = new Date();
  date.setDate(date.getDate() + Math.floor(daysOfStock));
  return date.toISOString().split("T")[0];
}

/**
 * Calculer la quantite a recommander.
 * Lead-time-aware : on commande de quoi tenir le lead time PUIS la couverture
 * cible apres reception, moins ce qui est deja en stock. Sans lead time, on
 * retombe sur l'ancien comportement (juste la couverture cible).
 */
function calculateReorderQuantity(currentStock, dailyRate, targetCoverageDays, minOrderQty = 0, leadTimeDays = 0) {
  if (dailyRate <= 0) return 0;

  const lt = Math.max(0, Number(leadTimeDays) || 0);
  // Stock necessaire = ce qui sera consomme pendant le lead time + couverture
  // cible apres reception. currentStock va couvrir le lead time, le delta
  // sert a remplir jusqu'a la couverture cible.
  const targetStock = dailyRate * (lt + Math.max(1, targetCoverageDays));
  const needed = Math.max(0, targetStock - currentStock);

  let rounded;
  if (needed < 10) rounded = Math.ceil(needed * 10) / 10;
  else if (needed < 100) rounded = Math.ceil(needed);
  else rounded = Math.ceil(needed / 10) * 10;

  return Math.max(rounded, minOrderQty);
}

/**
 * Déterminer le statut du forecast
 */
function determineStatus(daysOfStock, dailyRate, alertThreshold = 14) {
  if (dailyRate <= 0) {
    return FORECAST_STATUS.NO_DATA;
  }
  
  if (daysOfStock <= 0) {
    return FORECAST_STATUS.OUT_OF_STOCK;
  }
  
  if (daysOfStock > 90) {
    return FORECAST_STATUS.OVERSTOCK;
  }
  
  if (daysOfStock < 7) {
    return FORECAST_STATUS.CRITICAL;
  }
  
  if (daysOfStock < alertThreshold) {
    return FORECAST_STATUS.URGENT;
  }
  
  if (daysOfStock < 30) {
    return FORECAST_STATUS.WATCH;
  }
  
  return FORECAST_STATUS.OK;
}

/**
 * Calculer la date limite de commande (avec lead time)
 */
function calculateOrderDeadline(stockoutDate, leadTimeDays) {
  if (!stockoutDate || !leadTimeDays) {
    return null;
  }
  
  const deadline = new Date(stockoutDate);
  deadline.setDate(deadline.getDate() - leadTimeDays);
  return deadline.toISOString().split("T")[0];
}

// ============================================
// FORECAST PRINCIPAL
// ============================================

/**
 * Générer les prévisions pour tous les produits
 */
function generateForecast(shop, productsData, salesData, options = {}) {
  const settings = { ...loadForecastSettings(shop), ...options };
  const {
    windowDays,
    alertThresholdDays,
    targetCoverageDays,
    ignoreZeroDays,
    outlierCapping,
    outlierPercentile,
  } = settings;

  // Pre-agregation O(N) : un seul pass sur la liste des ventes, indexe par
  // produit puis par jour. La boucle des produits ne refiltre plus la liste.
  const salesByProductDay = preaggregateSalesByDay(salesData);
  const todayStr = new Date().toISOString().slice(0, 10);
  const forecasts = [];

  for (const product of productsData) {
    const dayMap = salesByProductDay.get(product.productId);
    const rateData = calculateDailyRateFromDayMap(dayMap, windowDays, {
      ignoreZeroDays,
      outlierCapping,
      outlierPercentile,
    });

    const currentStock = product.totalGrams || 0;
    const daysOfStock = calculateDaysOfStock(currentStock, rateData.dailyRate);
    const stockoutDate = calculateStockoutDate(daysOfStock);
    const status = determineStatus(daysOfStock, rateData.dailyRate, alertThresholdDays);
    const leadTimeDays = product.leadTimeDays || 0;
    const reorderQty = calculateReorderQuantity(
      currentStock,
      rateData.dailyRate,
      targetCoverageDays,
      0,
      leadTimeDays
    );

    const orderDeadline = calculateOrderDeadline(stockoutDate, leadTimeDays || null);
    const isOrderUrgent = orderDeadline ? orderDeadline <= todayStr : false;

    forecasts.push({
      productId: product.productId,
      productName: product.name,
      sku: product.sku || null,
      categoryIds: product.categoryIds || [],
      supplierId: product.supplierId || null,

      // Stock
      currentStock,
      averageCostPerGram: product.averageCostPerGram || 0,
      stockValue: currentStock * (product.averageCostPerGram || 0),

      // Ventes
      dailyRate: rateData.dailyRate,
      hasData: rateData.hasData,
      dataPoints: rateData.dataPoints,
      totalSoldInWindow: rateData.totalSold || 0,
      effectiveWindow: rateData.effectiveWindow || windowDays,

      // Previsions
      daysOfStock,
      stockoutDate,
      status,

      // Recommandations
      reorderQty,
      reorderValue: reorderQty * (product.averageCostPerGram || 0),
      targetCoverageDays,

      // Lead time
      leadTimeDays: leadTimeDays || null,
      orderDeadline,
      isOrderUrgent,

      // Meta
      windowDays,
    });
  }

  // Tri par urgence : ruptures, puis stock le plus court, puis sans donnees
  forecasts.sort((a, b) => {
    if (a.status === FORECAST_STATUS.OUT_OF_STOCK && b.status !== FORECAST_STATUS.OUT_OF_STOCK) return -1;
    if (b.status === FORECAST_STATUS.OUT_OF_STOCK && a.status !== FORECAST_STATUS.OUT_OF_STOCK) return 1;
    if (a.daysOfStock === Infinity && b.daysOfStock !== Infinity) return 1;
    if (b.daysOfStock === Infinity && a.daysOfStock !== Infinity) return -1;
    return a.daysOfStock - b.daysOfStock;
  });

  return forecasts;
}

/**
 * Générer les prévisions détaillées pour un produit
 */
function generateProductForecast(shop, product, salesData, options = {}) {
  const settings = { ...loadForecastSettings(shop), ...options };
  const { windowDays, forecastHorizon, targetCoverageDays } = settings;

  // Pre-aggreger uniquement les ventes du produit (un pass)
  const dayMap = new Map();
  for (const s of salesData || []) {
    if (!s || s.productId !== product.productId || !s.date) continue;
    const day = String(s.date).slice(0, 10);
    dayMap.set(day, (dayMap.get(day) || 0) + (Number(s.qty) || 0));
  }

  const rateData = calculateDailyRateFromDayMap(dayMap, windowDays, settings);
  const currentStock = product.totalGrams || 0;
  const daysOfStock = calculateDaysOfStock(currentStock, rateData.dailyRate);
  const stockoutDate = calculateStockoutDate(daysOfStock);
  const status = determineStatus(daysOfStock, rateData.dailyRate, settings.alertThresholdDays);
  const leadTimeDays = product.leadTimeDays || 0;
  const reorderQty = calculateReorderQuantity(currentStock, rateData.dailyRate, targetCoverageDays, 0, leadTimeDays);
  
  // Historique journalier (30 derniers jours) reconstruit depuis dayMap
  const dailyHistory = buildDailyHistoryFromDayMap(dayMap, 30);
  
  // Scénarios
  const scenarios = {
    pessimistic: {
      multiplier: 1.2, // Ventes plus élevées = rupture plus rapide
      dailyRate: rateData.dailyRate * 1.2,
      daysOfStock: calculateDaysOfStock(currentStock, rateData.dailyRate * 1.2),
    },
    normal: {
      multiplier: 1.0,
      dailyRate: rateData.dailyRate,
      daysOfStock: daysOfStock,
    },
    optimistic: {
      multiplier: 0.8, // Ventes plus faibles = stock dure plus
      dailyRate: rateData.dailyRate * 0.8,
      daysOfStock: calculateDaysOfStock(currentStock, rateData.dailyRate * 0.8),
    },
  };
  
  // Projection sur l'horizon
  const projection = buildProjection(currentStock, rateData.dailyRate, forecastHorizon);
  
  // Explication du calcul
  const explanation = buildExplanation(rateData, windowDays, currentStock, daysOfStock);
  
  return {
    productId: product.productId,
    productName: product.name,
    
    currentStock,
    dailyRate: rateData.dailyRate,
    hasData: rateData.hasData,
    totalSoldInWindow: rateData.totalSold || 0,
    daysWithSales: rateData.daysWithSales || 0,
    
    daysOfStock,
    stockoutDate,
    status,
    
    reorderQty,
    reorderValue: reorderQty * (product.averageCostPerGram || 0),
    targetCoverageDays,
    
    dailyHistory,
    scenarios,
    projection,
    explanation,
    
    settings,
  };
}

/**
 * Construire l'historique journalier directement depuis une dayMap pre-aggregee
 */
function buildDailyHistoryFromDayMap(dayMap, days) {
  const history = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dayStr = date.toISOString().slice(0, 10);
    history.push({ date: dayStr, qty: (dayMap && dayMap.get(dayStr)) || 0 });
  }
  return history;
}

/**
 * Construire l'historique journalier (legacy - prend [{date, qty}])
 */
function buildDailyHistory(salesData, days) {
  const history = [];
  const now = new Date();
  
  // Créer un map des ventes par jour
  const salesByDay = {};
  for (const sale of salesData) {
    const day = sale.date.split("T")[0];
    salesByDay[day] = (salesByDay[day] || 0) + (sale.qty || 0);
  }
  
  // Remplir les jours
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dayStr = date.toISOString().split("T")[0];
    
    history.push({
      date: dayStr,
      qty: salesByDay[dayStr] || 0,
    });
  }
  
  return history;
}

/**
 * Construire la projection de stock
 */
function buildProjection(currentStock, dailyRate, horizonDays) {
  const projection = [];
  let stock = currentStock;
  const now = new Date();
  
  for (let i = 0; i <= horizonDays; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() + i);
    
    projection.push({
      date: date.toISOString().split("T")[0],
      stock: Math.max(0, Math.round(stock * 10) / 10),
    });
    
    stock -= dailyRate;
  }
  
  return projection;
}

/**
 * Construire l'explication du calcul
 */
function buildExplanation(rateData, windowDays, currentStock, daysOfStock) {
  const lines = [];
  
  lines.push(`Analyse sur les ${windowDays} derniers jours`);
  
  if (!rateData.hasData) {
    lines.push("Aucune donnée de vente disponible");
    return lines;
  }
  
  lines.push(`Total vendu: ${rateData.totalSold?.toFixed(1) || 0}g sur ${rateData.daysWithSales || 0} jour(s)`);
  lines.push(`Moyenne journalière: ${rateData.dailyRate?.toFixed(2) || 0}g/jour`);
  lines.push(`Stock actuel: ${currentStock?.toFixed(1) || 0}g`);
  
  if (daysOfStock === Infinity) {
    lines.push("Couverture: Illimitée (pas de ventes récentes)");
  } else {
    lines.push(`Couverture estimée: ${daysOfStock?.toFixed(0) || 0} jours`);
  }
  
  return lines;
}

// ============================================
// RECOMMANDATIONS D'ACHAT
// ============================================

/**
 * Générer les recommandations de commande groupées par fournisseur
 */
function generatePurchaseRecommendations(forecasts, options = {}) {
  const { 
    reorderPointDays = 14,
    targetCoverageDays = 30,
    suppliersData = [],
  } = options;
  
  // Filtrer les produits qui nécessitent un réassort
  const needsReorder = forecasts.filter(f => {
    if (f.status === FORECAST_STATUS.NO_DATA) return false;
    if (f.daysOfStock === Infinity) return false;
    return f.daysOfStock <= reorderPointDays || f.reorderQty > 0;
  });
  
  // Grouper par fournisseur
  const bySupplier = {};
  for (const f of needsReorder) {
    const supplierId = f.supplierId || "unknown";
    if (!bySupplier[supplierId]) {
      const supplier = suppliersData.find(s => s.id === supplierId);
      bySupplier[supplierId] = {
        supplierId,
        supplierName: supplier?.name || "Fournisseur inconnu",
        items: [],
        totalValue: 0,
        totalItems: 0,
      };
    }
    
    bySupplier[supplierId].items.push({
      productId: f.productId,
      productName: f.productName,
      currentStock: f.currentStock,
      daysOfStock: f.daysOfStock,
      stockoutDate: f.stockoutDate,
      reorderQty: f.reorderQty,
      reorderValue: f.reorderValue,
      isUrgent: f.status === FORECAST_STATUS.CRITICAL || f.status === FORECAST_STATUS.URGENT,
      orderDeadline: f.orderDeadline,
    });
    
    bySupplier[supplierId].totalValue += f.reorderValue || 0;
    bySupplier[supplierId].totalItems++;
  }
  
  // Convertir en array et trier par urgence
  const recommendations = Object.values(bySupplier).map(r => ({
    ...r,
    items: r.items.sort((a, b) => a.daysOfStock - b.daysOfStock),
    hasUrgent: r.items.some(i => i.isUrgent),
  }));
  
  recommendations.sort((a, b) => {
    if (a.hasUrgent && !b.hasUrgent) return -1;
    if (!a.hasUrgent && b.hasUrgent) return 1;
    return b.totalItems - a.totalItems;
  });
  
  return {
    recommendations,
    summary: {
      totalProducts: needsReorder.length,
      totalValue: recommendations.reduce((sum, r) => sum + r.totalValue, 0),
      urgentCount: needsReorder.filter(f => 
        f.status === FORECAST_STATUS.CRITICAL || f.status === FORECAST_STATUS.URGENT
      ).length,
    },
  };
}

// ============================================
// STATS & KPIs
// ============================================

/**
 * Calculer les KPIs de prévision
 */
function getForecastStats(forecasts) {
  const total = forecasts.length;
  
  const byStatus = {};
  for (const status of Object.values(FORECAST_STATUS)) {
    byStatus[status] = forecasts.filter(f => f.status === status).length;
  }
  
  const totalStockValue = forecasts.reduce((sum, f) => sum + (f.stockValue || 0), 0);
  const totalReorderValue = forecasts.reduce((sum, f) => sum + (f.reorderValue || 0), 0);
  
  const urgentProducts = forecasts.filter(f => 
    f.status === FORECAST_STATUS.CRITICAL || 
    f.status === FORECAST_STATUS.URGENT ||
    f.status === FORECAST_STATUS.OUT_OF_STOCK
  );
  
  const avgDaysOfStock = forecasts
    .filter(f => f.daysOfStock !== Infinity && f.hasData)
    .reduce((sum, f, _, arr) => sum + f.daysOfStock / arr.length, 0);
  
  return {
    totalProducts: total,
    byStatus,
    totalStockValue: Math.round(totalStockValue * 100) / 100,
    totalReorderValue: Math.round(totalReorderValue * 100) / 100,
    urgentCount: urgentProducts.length,
    avgDaysOfStock: Math.round(avgDaysOfStock),
    healthScore: Math.round((1 - urgentProducts.length / Math.max(total, 1)) * 100),
  };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Constants
  FORECAST_STATUS,
  DEFAULT_SETTINGS,
  
  // Settings
  loadForecastSettings,
  saveForecastSettings,
  
  // Calculs
  calculateDailyRate,
  calculateDailyRateFromDayMap,
  preaggregateSalesByDay,
  calculateDaysOfStock,
  calculateStockoutDate,
  calculateReorderQuantity,
  calculateOrderDeadline,
  determineStatus,
  
  // Forecast
  generateForecast,
  generateProductForecast,
  
  // Recommendations
  generatePurchaseRecommendations,
  
  // Stats
  getForecastStats,
  
  // Cache
  loadCache,
  saveCache,
};
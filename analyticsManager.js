// analyticsManager.js — Logique métier des calculs analytics
// Transforme les données brutes en KPIs, timeseries, et stats produits

const analyticsStore = require("./analyticsStore");

// Import conditionnel du stockManager pour récupérer le CMP
let stockManager = null;
try {
  stockManager = require("./stockManager");
} catch (e) {
  console.warn("analyticsManager: stockManager non disponible, CMP snapshot désactivé");
}

// ============================================
// Helpers
// ============================================

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function roundTo(n, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function parseDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(d) {
  const date = new Date(d);
  date.setHours(23, 59, 59, 999);
  return date;
}

function formatDateKey(d, bucket = "day") {
  const date = parseDate(d);
  if (!date) return "";
  
  const iso = date.toISOString();
  
  switch (bucket) {
    case "hour":
      return iso.slice(0, 13); // "2025-01-15T14"
    case "day":
      return iso.slice(0, 10); // "2025-01-15"
    case "week":
      // ISO week (lundi = début)
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date.setDate(diff));
      return monday.toISOString().slice(0, 10);
    case "month":
      return iso.slice(0, 7); // "2025-01"
    default:
      return iso.slice(0, 10);
  }
}

// ============================================
// ENREGISTREMENT DES VENTES (depuis webhook)
// ============================================

/**
 * Transforme un payload de commande Shopify en ventes individuelles
 * et les enregistre dans le store
 * 
 * @param {string} shop - Domaine de la boutique
 * @param {Object} orderPayload - Payload du webhook orders/create
 * @returns {Array} Liste des ventes enregistrées
 */
async function recordSaleFromOrder(shop, orderPayload) {
  if (!orderPayload) return [];

  const orderId = String(orderPayload.id || "");
  const orderNumber = orderPayload.order_number || orderPayload.name || "";
  const orderDate = orderPayload.created_at || new Date().toISOString();
  const currency = String(orderPayload.currency || "EUR").toUpperCase();
  
  // Vérifier le statut financier (ignorer les commandes annulées/non payées)
  const financialStatus = String(orderPayload.financial_status || "").toLowerCase();
  if (["voided", "refunded"].includes(financialStatus)) {
    console.log(`[Analytics] Commande ${orderId} ignorée (status: ${financialStatus})`);
    return [];
  }

  // Client (optionnel)
  const customerId = orderPayload.customer?.id || null;
  const customerEmail = orderPayload.customer?.email || null;

  const lineItems = Array.isArray(orderPayload.line_items) ? orderPayload.line_items : [];
  const sales = [];

  for (const li of lineItems) {
    const productId = String(li.product_id || "");
    const variantId = li.variant_id || null;
    
    if (!productId) continue;

    // Quantité commandée
    const quantity = toNum(li.quantity, 0);
    if (quantity <= 0) continue;

    // Prix de vente
    const unitPrice = toNum(li.price, 0);
    const lineTotal = unitPrice * quantity;

    // Déterminer les grammes par unité depuis le variant title/sku
    const gramsPerUnit = parseGramsFromLineItem(li);
    const totalGrams = gramsPerUnit * quantity;

    // Récupérer le CMP actuel du produit (snapshot)
    let costPerGram = 0;
    let categoryIds = [];
    
    if (stockManager && typeof stockManager.getProductCMPSnapshot === "function") {
      costPerGram = stockManager.getProductCMPSnapshot(shop, productId);
    }
    
    // Récupérer les catégories si disponible
    if (stockManager && typeof stockManager.getStockSnapshot === "function") {
      const snapshot = stockManager.getStockSnapshot(shop);
      const productData = snapshot?.[productId];
      if (productData?.categoryIds) {
        categoryIds = productData.categoryIds;
      }
    }

    // Calculer coût et marge
    const totalCost = roundTo(totalGrams * costPerGram, 2);
    const margin = roundTo(lineTotal - totalCost, 2);
    const marginPercent = lineTotal > 0 ? roundTo((margin / lineTotal) * 100, 2) : 0;

    // Enregistrer la vente
    const sale = analyticsStore.addSale({
      orderId,
      orderNumber,
      orderDate,
      
      productId,
      productName: li.title || li.name || productId,
      variantId,
      variantTitle: li.variant_title || null,
      
      quantity,
      gramsPerUnit,
      totalGrams,
      
      unitPrice,
      lineTotal,
      currency,
      
      costPerGram,
      totalCost,
      margin,
      marginPercent,
      
      categoryIds,
      
      customerId,
      customerEmail,
      
      source: "webhook",
    }, shop);

    sales.push(sale);
  }

  return sales;
}

/**
 * Extrait le grammage depuis un line_item Shopify
 */
function parseGramsFromLineItem(li) {
  // Chercher dans variant_title, sku, properties
  const candidates = [
    li.variant_title,
    li.sku,
    li.title,
    ...(li.properties || []).map(p => p.value),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const match = String(candidate).match(/([\d.,]+)\s*g(?:r(?:amme)?s?)?/i);
    if (match) {
      const g = parseFloat(match[1].replace(",", "."));
      if (Number.isFinite(g) && g > 0) return g;
    }
  }

  // Fallback: grams field de Shopify
  if (li.grams && Number(li.grams) > 0) {
    return Number(li.grams);
  }

  return 0;
}

// ============================================
// CALCULS ANALYTICS
// ============================================

/**
 * Calcule les KPIs globaux pour une période
 */
function calculateSummary(shop, from, to) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });
  
  if (!sales.length) {
    return {
      period: { from, to },
      totalOrders: 0,
      uniqueOrders: 0,
      totalRevenue: 0,
      totalCost: 0,
      totalMargin: 0,
      averageMarginPercent: 0,
      totalGrams: 0,
      totalQuantity: 0,
      averageOrderValue: 0,
      averageGramsPerOrder: 0,
      currency: "EUR",
    };
  }

  // Calculer les métriques
  const orderIds = new Set(sales.map(s => s.orderId).filter(Boolean));
  
  const totals = sales.reduce((acc, s) => {
    acc.revenue += toNum(s.lineTotal, 0);
    acc.cost += toNum(s.totalCost, 0);
    acc.margin += toNum(s.margin, 0);
    acc.grams += toNum(s.totalGrams, 0);
    acc.quantity += toNum(s.quantity, 0);
    return acc;
  }, { revenue: 0, cost: 0, margin: 0, grams: 0, quantity: 0 });

  const uniqueOrders = orderIds.size || sales.length;
  const avgMarginPercent = totals.revenue > 0 
    ? (totals.margin / totals.revenue) * 100 
    : 0;

  return {
    period: { from, to },
    totalOrders: sales.length,
    uniqueOrders,
    totalRevenue: roundTo(totals.revenue, 2),
    totalCost: roundTo(totals.cost, 2),
    totalMargin: roundTo(totals.margin, 2),
    averageMarginPercent: roundTo(avgMarginPercent, 2),
    totalGrams: roundTo(totals.grams, 2),
    totalQuantity: totals.quantity,
    averageOrderValue: roundTo(totals.revenue / uniqueOrders, 2),
    averageGramsPerOrder: roundTo(totals.grams / uniqueOrders, 2),
    currency: sales[0]?.currency || "EUR",
  };
}

/**
 * Calcule les données pour les graphiques (timeseries)
 */
function calculateTimeseries(shop, from, to, bucket = "day") {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });
  
  // Grouper par bucket temporel
  const buckets = new Map();
  
  for (const sale of sales) {
    const key = formatDateKey(sale.orderDate, bucket);
    if (!key) continue;
    
    if (!buckets.has(key)) {
      buckets.set(key, {
        date: key,
        revenue: 0,
        cost: 0,
        margin: 0,
        grams: 0,
        quantity: 0,
        orders: new Set(),
      });
    }
    
    const b = buckets.get(key);
    b.revenue += toNum(sale.lineTotal, 0);
    b.cost += toNum(sale.totalCost, 0);
    b.margin += toNum(sale.margin, 0);
    b.grams += toNum(sale.totalGrams, 0);
    b.quantity += toNum(sale.quantity, 0);
    if (sale.orderId) b.orders.add(sale.orderId);
  }

  // Convertir en array et trier
  const data = Array.from(buckets.values())
    .map(b => ({
      date: b.date,
      revenue: roundTo(b.revenue, 2),
      cost: roundTo(b.cost, 2),
      margin: roundTo(b.margin, 2),
      marginPercent: b.revenue > 0 ? roundTo((b.margin / b.revenue) * 100, 2) : 0,
      grams: roundTo(b.grams, 2),
      quantity: b.quantity,
      orderCount: b.orders.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    bucket,
    period: { from, to },
    data,
  };
}

/**
 * Calcule les stats pour un produit spécifique
 */
function calculateProductStats(shop, productId, from, to) {
  const sales = analyticsStore.getSalesByProduct(shop, productId, from, to);
  
  if (!sales.length) {
    return {
      productId,
      productName: "",
      period: { from, to },
      totalSales: 0,
      totalRevenue: 0,
      totalCost: 0,
      totalMargin: 0,
      averageMarginPercent: 0,
      totalGrams: 0,
      totalQuantity: 0,
      averagePrice: 0,
      lastSaleDate: null,
    };
  }

  const productName = sales[0]?.productName || productId;
  
  const totals = sales.reduce((acc, s) => {
    acc.revenue += toNum(s.lineTotal, 0);
    acc.cost += toNum(s.totalCost, 0);
    acc.margin += toNum(s.margin, 0);
    acc.grams += toNum(s.totalGrams, 0);
    acc.quantity += toNum(s.quantity, 0);
    return acc;
  }, { revenue: 0, cost: 0, margin: 0, grams: 0, quantity: 0 });

  const avgMarginPercent = totals.revenue > 0 
    ? (totals.margin / totals.revenue) * 100 
    : 0;

  return {
    productId,
    productName,
    period: { from, to },
    totalSales: sales.length,
    totalRevenue: roundTo(totals.revenue, 2),
    totalCost: roundTo(totals.cost, 2),
    totalMargin: roundTo(totals.margin, 2),
    averageMarginPercent: roundTo(avgMarginPercent, 2),
    totalGrams: roundTo(totals.grams, 2),
    totalQuantity: totals.quantity,
    averagePrice: totals.quantity > 0 ? roundTo(totals.revenue / totals.quantity, 2) : 0,
    lastSaleDate: sales[0]?.orderDate || null,
    currency: sales[0]?.currency || "EUR",
  };
}

/**
 * Compare plusieurs produits
 */
function compareProducts(shop, productIds, from, to) {
  if (!Array.isArray(productIds) || !productIds.length) {
    return { products: [], period: { from, to } };
  }

  const products = productIds.map(pid => calculateProductStats(shop, pid, from, to));
  
  // Trier par revenu décroissant
  products.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return {
    products,
    period: { from, to },
  };
}

/**
 * Retourne le top N des produits
 */
function getTopProducts(shop, from, to, { by = "revenue", limit = 10 } = {}) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });
  
  // Grouper par produit
  const productMap = new Map();
  
  for (const sale of sales) {
    const pid = sale.productId;
    if (!pid) continue;
    
    if (!productMap.has(pid)) {
      productMap.set(pid, {
        productId: pid,
        productName: sale.productName || pid,
        revenue: 0,
        cost: 0,
        margin: 0,
        grams: 0,
        quantity: 0,
        salesCount: 0,
      });
    }
    
    const p = productMap.get(pid);
    p.revenue += toNum(sale.lineTotal, 0);
    p.cost += toNum(sale.totalCost, 0);
    p.margin += toNum(sale.margin, 0);
    p.grams += toNum(sale.totalGrams, 0);
    p.quantity += toNum(sale.quantity, 0);
    p.salesCount += 1;
  }

  // Convertir et calculer les pourcentages de marge
  let products = Array.from(productMap.values()).map(p => ({
    ...p,
    revenue: roundTo(p.revenue, 2),
    cost: roundTo(p.cost, 2),
    margin: roundTo(p.margin, 2),
    marginPercent: p.revenue > 0 ? roundTo((p.margin / p.revenue) * 100, 2) : 0,
    grams: roundTo(p.grams, 2),
  }));

  // Trier selon le critère demandé
  const sortKey = {
    revenue: "revenue",
    margin: "margin",
    grams: "grams",
    quantity: "quantity",
    sales: "salesCount",
  }[by] || "revenue";

  products.sort((a, b) => b[sortKey] - a[sortKey]);

  // Limiter et ajouter le rang
  const maxLimit = Math.min(Number(limit) || 10, 100);
  products = products.slice(0, maxLimit).map((p, i) => ({
    ...p,
    rank: i + 1,
  }));

  return {
    by,
    period: { from, to },
    products,
  };
}

/**
 * Retourne les stats par catégorie
 */
function getCategoryAnalytics(shop, from, to) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });
  
  const categoryMap = new Map();
  
  for (const sale of sales) {
    const cats = Array.isArray(sale.categoryIds) && sale.categoryIds.length > 0
      ? sale.categoryIds
      : ["_uncategorized"];
    
    for (const catId of cats) {
      if (!categoryMap.has(catId)) {
        categoryMap.set(catId, {
          categoryId: catId,
          revenue: 0,
          cost: 0,
          margin: 0,
          grams: 0,
          quantity: 0,
          salesCount: 0,
        });
      }
      
      const c = categoryMap.get(catId);
      c.revenue += toNum(sale.lineTotal, 0);
      c.cost += toNum(sale.totalCost, 0);
      c.margin += toNum(sale.margin, 0);
      c.grams += toNum(sale.totalGrams, 0);
      c.quantity += toNum(sale.quantity, 0);
      c.salesCount += 1;
    }
  }

  const categories = Array.from(categoryMap.values())
    .map(c => ({
      ...c,
      revenue: roundTo(c.revenue, 2),
      cost: roundTo(c.cost, 2),
      margin: roundTo(c.margin, 2),
      marginPercent: c.revenue > 0 ? roundTo((c.margin / c.revenue) * 100, 2) : 0,
      grams: roundTo(c.grams, 2),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    period: { from, to },
    categories,
  };
}

/**
 * Liste les commandes récentes (pour le tableau)
 */
function listRecentOrders(shop, from, to, limit = 50) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 5000 });
  
  // Grouper par commande
  const orderMap = new Map();
  
  for (const sale of sales) {
    const oid = sale.orderId || sale.id;
    
    if (!orderMap.has(oid)) {
      orderMap.set(oid, {
        orderId: sale.orderId,
        orderNumber: sale.orderNumber,
        orderDate: sale.orderDate,
        items: [],
        totalRevenue: 0,
        totalCost: 0,
        totalMargin: 0,
        totalGrams: 0,
        totalQuantity: 0,
        currency: sale.currency || "EUR",
      });
    }
    
    const order = orderMap.get(oid);
    order.items.push({
      productId: sale.productId,
      productName: sale.productName,
      variantTitle: sale.variantTitle,
      quantity: sale.quantity,
      gramsPerUnit: sale.gramsPerUnit,
      totalGrams: sale.totalGrams,
      lineTotal: sale.lineTotal,
    });
    order.totalRevenue += toNum(sale.lineTotal, 0);
    order.totalCost += toNum(sale.totalCost, 0);
    order.totalMargin += toNum(sale.margin, 0);
    order.totalGrams += toNum(sale.totalGrams, 0);
    order.totalQuantity += toNum(sale.quantity, 0);
  }

  // Convertir et trier
  const orders = Array.from(orderMap.values())
    .map(o => ({
      ...o,
      totalRevenue: roundTo(o.totalRevenue, 2),
      totalCost: roundTo(o.totalCost, 2),
      totalMargin: roundTo(o.totalMargin, 2),
      marginPercent: o.totalRevenue > 0 ? roundTo((o.totalMargin / o.totalRevenue) * 100, 2) : 0,
      totalGrams: roundTo(o.totalGrams, 2),
      itemCount: o.items.length,
    }))
    .sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))
    .slice(0, Math.min(Number(limit) || 50, 500));

  return {
    period: { from, to },
    orders,
  };
}

// ============================================
// Module Exports
// ============================================

module.exports = {
  // Enregistrement
  recordSaleFromOrder,
  parseGramsFromLineItem,
  
  // Calculs analytics
  calculateSummary,
  calculateTimeseries,
  calculateProductStats,
  compareProducts,
  getTopProducts,
  getCategoryAnalytics,
  listRecentOrders,
  
  // Helpers
  formatDateKey,
  roundTo,
};

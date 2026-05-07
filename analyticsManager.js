// analyticsManager.js — Logique métier des calculs analytics.
// Transforme les données brutes en KPIs, timeseries, et stats produits.
//
// Source unique de vérité = analyticsStore (NDJSON par mois).
// Champ canonique du CA dans le store = `netRevenue` (prix réel HT après réductions).
// Ce module n'écrit jamais directement sur disque ; il appelle analyticsStore.

const analyticsStore = require("./analyticsStore");

// Import conditionnel du stockManager pour récupérer le CMP snapshot.
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

function roundTo(n, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function parseDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Lit le CA d'une vente. Le champ canonique est netRevenue (HT après réductions).
 * `grossPrice` sert de fallback pour des enregistrements legacy éventuels.
 */
function saleRevenue(sale) {
  return toNum(sale.netRevenue, 0) || toNum(sale.grossPrice, 0);
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
    case "week": {
      // Lundi de la semaine ISO (sans muter `date`).
      const ref = new Date(date);
      const day = ref.getDay();
      const diff = ref.getDate() - day + (day === 0 ? -6 : 1);
      ref.setDate(diff);
      return ref.toISOString().slice(0, 10);
    }
    case "month":
      return iso.slice(0, 7); // "2025-01"
    default:
      return iso.slice(0, 10);
  }
}

// ============================================
// Enregistrement des ventes (depuis webhook Shopify)
// ============================================

/**
 * Transforme un payload de commande Shopify en ventes individuelles
 * et les enregistre dans le store.
 *
 * - Calcul sur prix RÉEL (après réductions, hors shipping/cadeaux).
 * - Collecte minimale : aucune donnée client (cf. politique RGPD du store).
 *
 * @param {string} shop - Domaine de la boutique
 * @param {Object} orderPayload - Payload du webhook orders/create
 * @returns {Promise<Array>} Liste des ventes enregistrées
 */
async function recordSaleFromOrder(shop, orderPayload) {
  if (!orderPayload) return [];

  const orderId = String(orderPayload.id || "");
  const orderNumber = orderPayload.order_number || orderPayload.name || "";
  const orderDate = orderPayload.created_at || new Date().toISOString();
  const currency = String(orderPayload.currency || "EUR").toUpperCase();

  // Ignorer les commandes annulées / remboursées.
  const financialStatus = String(orderPayload.financial_status || "").toLowerCase();
  if (["voided", "refunded"].includes(financialStatus)) {
    console.log(`[Analytics] Commande ${orderId} ignorée (status: ${financialStatus})`);
    return [];
  }

  const lineItems = Array.isArray(orderPayload.line_items) ? orderPayload.line_items : [];

  // Total des réductions au niveau commande pour répartition proportionnelle.
  const orderDiscounts = calculateOrderDiscounts(orderPayload);
  const orderSubtotal = lineItems.reduce(
    (sum, li) => sum + toNum(li.price, 0) * toNum(li.quantity, 0),
    0,
  );

  // Mapping variantId -> gramsPerUnit depuis le catalogue.
  const variantGramsMap = buildVariantGramsMap(shop);

  const sales = [];

  for (const li of lineItems) {
    const productId = String(li.product_id || "");
    const variantId = li.variant_id ? String(li.variant_id) : null;
    if (!productId) continue;

    const quantity = toNum(li.quantity, 0);
    if (quantity <= 0) continue;

    const unitPrice = toNum(li.price, 0);
    const grossPrice = unitPrice * quantity;

    // Réductions sur cette ligne + part proportionnelle des réductions commande.
    const lineDiscounts = calculateLineDiscounts(li);
    const proportionalOrderDiscount = orderSubtotal > 0
      ? (grossPrice / orderSubtotal) * orderDiscounts
      : 0;
    const totalDiscount = lineDiscounts + proportionalOrderDiscount;

    // CA NET = brut - réductions (hors shipping/taxes).
    const netRevenue = Math.max(0, grossPrice - totalDiscount);

    // Détermination des grammes par unité :
    //  1. Mapping catalogue (le plus fiable)
    //  2. Parsing depuis variant_title / sku / title / properties
    //  3. li.grams (si valeur "raisonnable" par unité)
    let gramsPerUnit = 0;
    if (variantId && variantGramsMap[variantId]) {
      gramsPerUnit = variantGramsMap[variantId];
    }
    if (!gramsPerUnit) {
      gramsPerUnit = parseGramsFromLineItem(li);
    }

    const totalGrams = gramsPerUnit * quantity;

    // CMP snapshot + catégories produit.
    let costPerGram = 0;
    let categoryIds = [];

    if (stockManager && typeof stockManager.getProductCMPSnapshot === "function") {
      costPerGram = stockManager.getProductCMPSnapshot(shop, productId);
    }

    if (stockManager && typeof stockManager.getStockSnapshot === "function") {
      const snapshot = stockManager.getStockSnapshot(shop);
      const productData = snapshot?.[productId];
      if (productData?.categoryIds) {
        categoryIds = productData.categoryIds;
      }
    }

    const totalCost = roundTo(totalGrams * costPerGram, 2);
    const margin = roundTo(netRevenue - totalCost, 2);
    const marginPercent = netRevenue > 0 ? roundTo((margin / netRevenue) * 100, 2) : 0;

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

      grossPrice: roundTo(grossPrice, 2),
      discountAmount: roundTo(totalDiscount, 2),
      netRevenue: roundTo(netRevenue, 2),
      currency,

      costPerGram,
      totalCost,
      margin,
      marginPercent,

      categoryIds,
      source: "webhook",
    }, shop);

    sales.push(sale);
  }

  return sales;
}

/**
 * Total des réductions au niveau commande (codes promo globaux, etc.).
 */
function calculateOrderDiscounts(orderPayload) {
  let total = 0;

  if (Array.isArray(orderPayload.discount_codes)) {
    for (const dc of orderPayload.discount_codes) {
      total += toNum(dc.amount, 0);
    }
  }

  if (Array.isArray(orderPayload.discount_applications)) {
    for (const da of orderPayload.discount_applications) {
      if (da.target_type === "line_item") continue; // déjà comptabilisé sur la ligne
      total += toNum(da.value, 0);
    }
  }

  // Fallback Shopify legacy.
  if (total === 0 && orderPayload.total_discounts) {
    total = toNum(orderPayload.total_discounts, 0);
  }

  return total;
}

/**
 * Réductions appliquées à une ligne spécifique.
 */
function calculateLineDiscounts(lineItem) {
  let total = 0;

  if (Array.isArray(lineItem.discount_allocations)) {
    for (const da of lineItem.discount_allocations) {
      total += toNum(da.amount, 0);
    }
  }

  if (lineItem.total_discount) {
    total = Math.max(total, toNum(lineItem.total_discount, 0));
  }

  return total;
}

/**
 * Construit un mapping `variantId -> gramsPerUnit` depuis le snapshot stockManager.
 * Supporte les deux formats de variants (objet par grammage, et array legacy).
 */
function buildVariantGramsMap(shop) {
  const map = {};

  if (!stockManager || typeof stockManager.getStockSnapshot !== "function") {
    return map;
  }

  try {
    const snapshot = stockManager.getStockSnapshot(shop);
    if (!snapshot) return map;

    for (const productData of Object.values(snapshot)) {
      if (!productData || !productData.variants) continue;

      // Format objet : { "5": { gramsPerUnit: 5, variantId, inventoryItemId }, ... }
      if (typeof productData.variants === "object" && !Array.isArray(productData.variants)) {
        for (const v of Object.values(productData.variants)) {
          if (v && v.variantId && v.gramsPerUnit) {
            map[String(v.variantId)] = Number(v.gramsPerUnit);
          }
          if (v && v.inventoryItemId && v.gramsPerUnit) {
            map["inv_" + v.inventoryItemId] = Number(v.gramsPerUnit);
          }
        }
      } else if (Array.isArray(productData.variants)) {
        // Format array (legacy).
        for (const v of productData.variants) {
          if (v.variantId && (v.grams || v.gramsPerUnit)) {
            map[String(v.variantId)] = Number(v.grams || v.gramsPerUnit);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[Analytics] Erreur buildVariantGramsMap:", e.message);
  }

  return map;
}

/**
 * Extrait les grammes par unité depuis un line_item Shopify.
 * Plusieurs stratégies, par ordre de fiabilité décroissante.
 */
function parseGramsFromLineItem(li) {
  // 1. variant_title = nombre nu ("5", "10") ou explicite "Xg" — très fiable pour shop CBD.
  if (li.variant_title) {
    const str = String(li.variant_title).trim();
    const plainNum = str.match(/^([\d.,]+)$/);
    if (plainNum) {
      const g = parseFloat(plainNum[1].replace(",", "."));
      if (Number.isFinite(g) && g >= 0.1 && g <= 500) return g;
    }
    const gPattern = str.match(/^([\d.,]+)\s*g(?![a-zA-Z])/i);
    if (gPattern) {
      const g = parseFloat(gPattern[1].replace(",", "."));
      if (Number.isFinite(g) && g >= 0.1 && g <= 500) return g;
    }
  }

  // 2. Pattern "Xg" dans sku / title / name / properties.
  const otherCandidates = [li.sku, li.title, li.name, ...(li.properties || []).map(p => p.value)].filter(Boolean);
  for (const candidate of otherCandidates) {
    const str = String(candidate);
    const match = str.match(/(?:^|[\s\-_])([\d.,]+)\s*g(?:r(?:amme)?s?)?(?:\s|$|[^a-zA-Z0-9])/i);
    if (match) {
      const g = parseFloat(match[1].replace(",", "."));
      if (Number.isFinite(g) && g >= 0.1 && g <= 500) return g;
    }
  }

  // 3. li.grams Shopify, uniquement si la valeur par unité est plausible.
  if (li.grams && Number(li.grams) > 0) {
    const quantity = Number(li.quantity) || 1;
    const gramsPerUnit = Number(li.grams) / quantity;
    if (gramsPerUnit >= 0.1 && gramsPerUnit <= 100) return gramsPerUnit;
    console.warn("[Analytics] Suspicious li.grams ignored:", {
      li_grams: li.grams, quantity, gramsPerUnit,
      productId: li.product_id, variantTitle: li.variant_title, sku: li.sku,
    });
  }

  console.warn("[Analytics] Could not determine gramsPerUnit:", {
    productId: li.product_id, variantId: li.variant_id,
    variantTitle: li.variant_title, sku: li.sku, title: li.title,
  });
  return 1;
}

// ============================================
// Calculs analytics (lecture)
// ============================================

/**
 * KPIs globaux pour une période. Source = analyticsStore.
 */
function calculateSummary(shop, from, to) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });

  if (!sales.length) {
    return {
      period: { from, to },
      totalOrders: 0,
      uniqueOrders: 0,
      totalRevenue: 0,
      totalGrossRevenue: 0,
      totalDiscounts: 0,
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

  const orderIds = new Set(sales.map(s => s.orderId).filter(Boolean));

  const totals = sales.reduce((acc, s) => {
    acc.revenue += saleRevenue(s);
    acc.grossRevenue += toNum(s.grossPrice, 0) || saleRevenue(s);
    acc.discounts += toNum(s.discountAmount, 0);
    acc.cost += toNum(s.totalCost, 0);
    acc.margin += toNum(s.margin, 0);
    acc.grams += toNum(s.totalGrams, 0);
    acc.quantity += toNum(s.quantity, 0);
    return acc;
  }, { revenue: 0, grossRevenue: 0, discounts: 0, cost: 0, margin: 0, grams: 0, quantity: 0 });

  const uniqueOrders = orderIds.size || sales.length;
  const avgMarginPercent = totals.revenue > 0
    ? (totals.margin / totals.revenue) * 100
    : 0;

  return {
    period: { from, to },
    totalOrders: sales.length,
    uniqueOrders,
    totalRevenue: roundTo(totals.revenue, 2),         // CA net (après réductions)
    totalGrossRevenue: roundTo(totals.grossRevenue, 2), // CA brut
    totalDiscounts: roundTo(totals.discounts, 2),
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
 * Données pour les graphiques (timeseries) groupées par bucket temporel.
 */
function calculateTimeseries(shop, from, to, bucket = "day") {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });

  const buckets = new Map();

  for (const sale of sales) {
    const key = formatDateKey(sale.orderDate, bucket);
    if (!key) continue;

    if (!buckets.has(key)) {
      buckets.set(key, {
        date: key,
        revenue: 0,
        grossRevenue: 0,
        discounts: 0,
        cost: 0,
        margin: 0,
        grams: 0,
        quantity: 0,
        orders: new Set(),
      });
    }

    const b = buckets.get(key);
    b.revenue += saleRevenue(sale);
    b.grossRevenue += toNum(sale.grossPrice, 0) || saleRevenue(sale);
    b.discounts += toNum(sale.discountAmount, 0);
    b.cost += toNum(sale.totalCost, 0);
    b.margin += toNum(sale.margin, 0);
    b.grams += toNum(sale.totalGrams, 0);
    b.quantity += toNum(sale.quantity, 0);
    if (sale.orderId) b.orders.add(sale.orderId);
  }

  const data = Array.from(buckets.values())
    .map(b => ({
      date: b.date,
      revenue: roundTo(b.revenue, 2),
      grossRevenue: roundTo(b.grossRevenue, 2),
      discounts: roundTo(b.discounts, 2),
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
 * Stats agrégées d'un produit sur une période.
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
    acc.revenue += saleRevenue(s);
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
 * Compare plusieurs produits sur une période, triés par CA décroissant.
 */
function compareProducts(shop, productIds, from, to) {
  if (!Array.isArray(productIds) || !productIds.length) {
    return { products: [], period: { from, to } };
  }

  const products = productIds.map(pid => calculateProductStats(shop, pid, from, to));
  products.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return { products, period: { from, to } };
}

/**
 * Top N produits, triés par critère (revenue / margin / grams / quantity / sales).
 */
function getTopProducts(shop, from, to, { by = "revenue", limit = 10 } = {}) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 50000 });

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
    p.revenue += saleRevenue(sale);
    p.cost += toNum(sale.totalCost, 0);
    p.margin += toNum(sale.margin, 0);
    p.grams += toNum(sale.totalGrams, 0);
    p.quantity += toNum(sale.quantity, 0);
    p.salesCount += 1;
  }

  let products = Array.from(productMap.values()).map(p => ({
    ...p,
    revenue: roundTo(p.revenue, 2),
    cost: roundTo(p.cost, 2),
    margin: roundTo(p.margin, 2),
    marginPercent: p.revenue > 0 ? roundTo((p.margin / p.revenue) * 100, 2) : 0,
    grams: roundTo(p.grams, 2),
  }));

  const sortKey = {
    revenue: "revenue",
    margin: "margin",
    grams: "grams",
    quantity: "quantity",
    sales: "salesCount",
  }[by] || "revenue";

  products.sort((a, b) => b[sortKey] - a[sortKey]);

  const maxLimit = Math.min(Number(limit) || 10, 100);
  products = products.slice(0, maxLimit).map((p, i) => ({ ...p, rank: i + 1 }));

  return { by, period: { from, to }, products };
}

/**
 * Stats par catégorie. Une vente sans catégorie est rangée sous "_uncategorized".
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
      c.revenue += saleRevenue(sale);
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

  return { period: { from, to }, categories };
}

/**
 * Liste les commandes récentes (groupées par orderId), triées par date desc.
 */
function listRecentOrders(shop, from, to, limit = 50) {
  const sales = analyticsStore.listSales({ shop, from, to, limit: 5000 });

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
    const lineRevenue = saleRevenue(sale);
    order.items.push({
      productId: sale.productId,
      productName: sale.productName,
      variantTitle: sale.variantTitle,
      quantity: sale.quantity,
      gramsPerUnit: sale.gramsPerUnit,
      totalGrams: sale.totalGrams,
      netRevenue: lineRevenue,
    });
    order.totalRevenue += lineRevenue;
    order.totalCost += toNum(sale.totalCost, 0);
    order.totalMargin += toNum(sale.margin, 0);
    order.totalGrams += toNum(sale.totalGrams, 0);
    order.totalQuantity += toNum(sale.quantity, 0);
  }

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

  return { period: { from, to }, orders };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Enregistrement
  recordSaleFromOrder,
  parseGramsFromLineItem,

  // Calculs
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

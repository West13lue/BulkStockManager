// salesOrderStore.js - Gestion des commandes de vente (Sales Orders)
// Import Shopify ou manuel, calcul marge, deduction stock

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

const SO_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
};

const SO_SOURCE = {
  SHOPIFY: "shopify",
  MANUAL: "manual",
  CSV: "csv",
};

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s ? s.replace(/[^a-z0-9._-]/g, "_") : "default";
}

function soDir(shop) {
  const dir = path.join(DATA_DIR, sanitizeShop(shop), "sales-orders");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function soFile(shop, yearMonth) {
  return path.join(soDir(shop), `${yearMonth}.json`);
}

function getYearMonth(date) {
  const d = date ? new Date(date) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function generateSONumber(shop) {
  const now = new Date();
  const prefix = `SO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${rand}`;
}

function loadOrdersByMonth(shop, yearMonth) {
  const file = soFile(shop, yearMonth);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.orders) ? data.orders : [];
    }
  } catch (e) {
    console.warn("Erreur lecture SO:", e.message);
  }
  return [];
}

function saveOrdersByMonth(shop, yearMonth, orders) {
  const file = soFile(shop, yearMonth);
  const data = { yearMonth, updatedAt: new Date().toISOString(), orders };
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
  return orders;
}

/**
 * Cree une commande de vente
 */
function createSalesOrder(shop, soData) {
  const orderDate = soData.createdAt || new Date().toISOString();
  const yearMonth = getYearMonth(orderDate);
  const orders = loadOrdersByMonth(shop, yearMonth);
  
  const so = {
    id: soData.id || `so_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    number: soData.number || generateSONumber(shop),
    externalId: soData.externalId || null, // ID Shopify
    source: soData.source || SO_SOURCE.MANUAL,
    status: soData.status || SO_STATUS.PAID,
    
    createdAt: orderDate,
    paidAt: soData.paidAt || null,
    shippedAt: soData.shippedAt || null,
    
    // Client
    customer: {
      name: soData.customer?.name || "",
      email: soData.customer?.email || "",
      phone: soData.customer?.phone || "",
    },
    
    // Lignes
    lines: (soData.lines || []).map((line, idx) => {
      const qty = Number(line.quantity || line.qty || 0);
      const gramsPerUnit = Number(line.gramsPerUnit || line.grams || 1);
      const totalGrams = qty * gramsPerUnit;
      const salePrice = Number(line.salePrice || line.price || 0);
      const costPricePerGram = Number(line.costPrice || line.costAtSale || 0);
      
      // Calcul correct: CA = qty * prix unitaire, Cout = totalGrams * cout/g
      const saleTotal = qty * salePrice;
      const costTotal = totalGrams * costPricePerGram; // CORRECTION: utiliser totalGrams
      
      return {
        id: line.id || `line_${idx + 1}`,
        productId: String(line.productId || ""),
        variantId: line.variantId ? String(line.variantId) : null,
        productName: line.productName || line.title || "",
        sku: line.sku || "",
        quantity: qty, // nombre d'unites vendues
        gramsPerUnit: gramsPerUnit, // grammes par unite (variante)
        totalGrams: totalGrams, // total grammes consommes
        saleUnitPrice: salePrice,
        saleTotal,
        costUnitPrice: costPricePerGram, // CMP par gramme
        costTotal, // cout total = totalGrams * CMP
        grossMargin: saleTotal - costTotal,
        marginPercent: saleTotal > 0 ? Math.round(((saleTotal - costTotal) / saleTotal) * 100) : 0,
        // Lots consommes (FIFO)
        consumedBatches: line.consumedBatches || [],
      };
    }),
    
    // Totaux
    subtotal: 0,
    shipping: Number(soData.shipping || 0),
    discount: Number(soData.discount || 0),
    tax: Number(soData.tax || 0),
    total: Number(soData.total || 0),
    
    // Couts et marge
    totalCost: 0,
    grossMargin: 0,
    marginPercent: 0,
    
    currency: soData.currency || "EUR",
    notes: soData.notes || "",
    tags: Array.isArray(soData.tags) ? soData.tags : [],
    
    // Freebies appliques
    freebiesApplied: soData.freebiesApplied || [],
    freebiesCost: 0,
    
    updatedAt: new Date().toISOString(),
  };
  
  // Calculer les totaux
  so.subtotal = so.lines.reduce((sum, l) => sum + l.saleTotal, 0);
  so.totalCost = so.lines.reduce((sum, l) => sum + l.costTotal, 0);
  so.freebiesCost = (so.freebiesApplied || []).reduce((sum, f) => sum + (f.cost || 0), 0);
  so.totalCost += so.freebiesCost;
  
  if (!so.total) {
    so.total = so.subtotal + so.shipping - so.discount + so.tax;
  }
  
  so.grossMargin = so.total - so.totalCost;
  so.marginPercent = so.total > 0 ? Math.round((so.grossMargin / so.total) * 100) : 0;
  
  // Verifier si deja existe (import Shopify)
  if (so.externalId) {
    const existing = orders.find(o => o.externalId === so.externalId);
    if (existing) {
      return { order: existing, created: false, message: "Commande deja importee" };
    }
  }
  
  orders.push(so);
  saveOrdersByMonth(shop, yearMonth, orders);
  
  return { order: so, created: true };
}

/**
 * Recupere une commande par ID
 */
function getSalesOrder(shop, soId) {
  const dir = soDir(shop);
  if (!fs.existsSync(dir)) return null;
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  for (const file of files) {
    const yearMonth = file.replace(".json", "");
    const orders = loadOrdersByMonth(shop, yearMonth);
    const so = orders.find(o => o.id === soId || o.number === soId || o.externalId === soId);
    if (so) return { ...so, _yearMonth: yearMonth };
  }
  return null;
}

/**
 * Met a jour une commande
 */
function updateSalesOrder(shop, soId, updates) {
  const so = getSalesOrder(shop, soId);
  if (!so) throw new Error(`Commande non trouvee: ${soId}`);
  
  const yearMonth = so._yearMonth;
  const orders = loadOrdersByMonth(shop, yearMonth);
  const index = orders.findIndex(o => o.id === soId);
  
  if (updates.status !== undefined) orders[index].status = updates.status;
  if (updates.notes !== undefined) orders[index].notes = updates.notes;
  if (updates.shippedAt !== undefined) orders[index].shippedAt = updates.shippedAt;
  if (updates.tags !== undefined) orders[index].tags = updates.tags;
  
  orders[index].updatedAt = new Date().toISOString();
  saveOrdersByMonth(shop, yearMonth, orders);
  
  return orders[index];
}

/**
 * Liste les commandes avec filtres
 */
function listSalesOrders(shop, options = {}) {
  const { from, to, status, source, search, limit = 100 } = options;
  const dir = soDir(shop);
  if (!fs.existsSync(dir)) return [];
  
  let allOrders = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  
  for (const file of files) {
    const yearMonth = file.replace(".json", "");
    
    // Filtrer par periode
    if (from) {
      const fromYM = getYearMonth(from);
      if (yearMonth < fromYM) continue;
    }
    if (to) {
      const toYM = getYearMonth(to);
      if (yearMonth > toYM) continue;
    }
    
    allOrders = allOrders.concat(loadOrdersByMonth(shop, yearMonth));
  }
  
  // Filtres
  if (status) allOrders = allOrders.filter(o => o.status === status);
  if (source) allOrders = allOrders.filter(o => o.source === source);
  if (search) {
    const q = search.toLowerCase();
    allOrders = allOrders.filter(o =>
      o.number.toLowerCase().includes(q) ||
      o.customer?.name?.toLowerCase().includes(q) ||
      o.customer?.email?.toLowerCase().includes(q) ||
      o.lines.some(l => l.productName.toLowerCase().includes(q))
    );
  }
  
  // Date range precise
  if (from) {
    const fromDate = new Date(from);
    allOrders = allOrders.filter(o => new Date(o.createdAt) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    allOrders = allOrders.filter(o => new Date(o.createdAt) <= toDate);
  }
  
  allOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return allOrders.slice(0, limit);
}

/**
 * Statistiques des ventes
 */
function getSalesStats(shop, options = {}) {
  const orders = listSalesOrders(shop, { ...options, limit: 10000 });
  
  const stats = {
    totalOrders: orders.length,
    totalRevenue: 0,
    totalCost: 0,
    totalMargin: 0,
    avgMarginPercent: 0,
    avgOrderValue: 0,
    byStatus: {},
    bySource: {},
    topProducts: [],
    negativeMarginOrders: 0,
  };
  
  // Comptage par statut et source
  for (const s of Object.values(SO_STATUS)) stats.byStatus[s] = 0;
  for (const s of Object.values(SO_SOURCE)) stats.bySource[s] = 0;
  
  const productStats = {};
  
  for (const order of orders) {
    if (order.status === SO_STATUS.CANCELLED || order.status === SO_STATUS.REFUNDED) continue;
    
    stats.totalRevenue += order.total || 0;
    stats.totalCost += order.totalCost || 0;
    stats.totalMargin += order.grossMargin || 0;
    
    if (order.grossMargin < 0) stats.negativeMarginOrders++;
    
    stats.byStatus[order.status] = (stats.byStatus[order.status] || 0) + 1;
    stats.bySource[order.source] = (stats.bySource[order.source] || 0) + 1;
    
    // Aggreger par produit
    for (const line of order.lines) {
      if (!productStats[line.productId]) {
        productStats[line.productId] = {
          productId: line.productId,
          productName: line.productName,
          totalQty: 0,
          totalRevenue: 0,
          totalCost: 0,
          totalMargin: 0,
        };
      }
      productStats[line.productId].totalQty += line.quantity;
      productStats[line.productId].totalRevenue += line.saleTotal;
      productStats[line.productId].totalCost += line.costTotal;
      productStats[line.productId].totalMargin += line.grossMargin;
    }
  }
  
  // Moyennes
  const validOrders = orders.filter(o => o.status !== SO_STATUS.CANCELLED && o.status !== SO_STATUS.REFUNDED);
  stats.avgOrderValue = validOrders.length > 0 ? stats.totalRevenue / validOrders.length : 0;
  stats.avgMarginPercent = stats.totalRevenue > 0 ? Math.round((stats.totalMargin / stats.totalRevenue) * 100) : 0;
  
  // Top produits
  stats.topProducts = Object.values(productStats)
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10)
    .map(p => ({
      ...p,
      marginPercent: p.totalRevenue > 0 ? Math.round((p.totalMargin / p.totalRevenue) * 100) : 0,
    }));
  
  return stats;
}

/**
 * Import depuis Shopify
 */
function importFromShopify(shop, shopifyOrders, productCostMap = {}, variantGramsMap = {}) {
  const results = { imported: 0, skipped: 0, errors: [] };
  
  for (const so of shopifyOrders) {
    try {
      // Convertir le format Shopify
      const lines = (so.line_items || []).map(item => {
        const costPricePerGram = productCostMap[item.product_id] || 0;
        
        // Shopify: item.grams = poids TOTAL de la ligne (qty * gramsPerUnit)
        // On doit calculer gramsPerUnit = item.grams / item.quantity
        const totalLineGrams = item.grams || 0;
        const quantity = item.quantity || 1;
        
        // Si on a un mapping de variantes, l'utiliser en priorite
        let gramsPerUnit = variantGramsMap[item.variant_id] || 0;
        
        // Sinon, calculer depuis les donnees Shopify
        if (!gramsPerUnit && totalLineGrams > 0 && quantity > 0) {
          gramsPerUnit = totalLineGrams / quantity;
        }
        
        // Fallback: 1g par defaut (sera recalcule si le produit est configure)
        if (!gramsPerUnit) gramsPerUnit = 1;
        
        return {
          productId: String(item.product_id),
          variantId: item.variant_id ? String(item.variant_id) : null,
          productName: item.title || item.name,
          sku: item.sku || "",
          quantity: quantity,
          gramsPerUnit: gramsPerUnit, // Grammes par unite vendue
          salePrice: parseFloat(item.price) || 0,
          costPrice: costPricePerGram, // CMP par gramme
        };
      });
      
      const result = createSalesOrder(shop, {
        externalId: String(so.id),
        source: SO_SOURCE.SHOPIFY,
        status: so.financial_status === "paid" ? SO_STATUS.PAID : SO_STATUS.PENDING,
        createdAt: so.created_at,
        paidAt: so.financial_status === "paid" ? so.processed_at : null,
        customer: {
          name: so.customer?.first_name ? `${so.customer.first_name} ${so.customer.last_name || ""}`.trim() : "",
          email: so.customer?.email || so.email || "",
        },
        lines,
        subtotal: parseFloat(so.subtotal_price) || 0,
        shipping: parseFloat(so.total_shipping_price_set?.shop_money?.amount) || 0,
        discount: parseFloat(so.total_discounts) || 0,
        tax: parseFloat(so.total_tax) || 0,
        total: parseFloat(so.total_price) || 0,
        currency: so.currency || "EUR",
      });
      
      if (result.created) {
        results.imported++;
      } else {
        results.skipped++;
      }
    } catch (e) {
      results.errors.push({ orderId: so.id, error: e.message });
    }
  }
  
  return results;
}

module.exports = {
  SO_STATUS,
  SO_SOURCE,
  createSalesOrder,
  getSalesOrder,
  updateSalesOrder,
  listSalesOrders,
  getSalesStats,
  importFromShopify,
  generateSONumber,
};
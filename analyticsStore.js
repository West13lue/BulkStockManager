// analyticsStore.js â€” Persistance des ventes analytics (NDJSON/mois) sur /var/data/<shop>/analytics
// Compatible multi-shop, mÃªme pattern que movementStore.js
// âœ… COLLECTE MINIMALE : pas de PII (nom/adresse client), juste les donnÃ©es nÃ©cessaires au calcul des marges

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// POLITIQUE DE CONFIDENTIALITÃ‰
// ============================================
// Ce module collecte UNIQUEMENT les donnÃ©es nÃ©cessaires au calcul des stocks et marges :
// - order_id, order_number, date
// - product_id, variant_id, qty, grams
// - revenue (prix rÃ©el aprÃ¨s rÃ©ductions), cost, margin
// 
// AUCUNE donnÃ©e personnelle client n'est stockÃ©e :
// - Pas de nom, email, tÃ©lÃ©phone
// - Pas d'adresse de livraison/facturation
// - Pas d'IP ou donnÃ©es de navigation
// ============================================

// ============================================
// Helpers
// ============================================

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  if (!s) return "default";
  return s.replace(/[^a-z0-9._-]/g, "_");
}

function shopDir(shop) {
  return path.join(DATA_DIR, sanitizeShop(shop));
}

function analyticsDir(shop) {
  return path.join(shopDir(shop), "analytics");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Fichier mensuel pour les ventes : YYYY-MM.ndjson
 */
function fileForMonth(shop, date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = d.toISOString().slice(0, 7); // "2025-01"
  return path.join(analyticsDir(shop), `${month}.ndjson`);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Enregistre une vente (COLLECTE MINIMALE - pas de PII)
 * @param {Object} sale - DonnÃ©es de la vente
 * @param {string} shop - Identifiant de la boutique
 * @returns {Object} La vente enregistrÃ©e avec son ID
 */
function addSale(sale = {}, shop = sale.shop) {
  const s = shop || "default";
  ensureDir(analyticsDir(s));

  const saleDate = sale.orderDate ? new Date(sale.orderDate) : new Date();

  // DEDUPLICATION: skip if same orderId + productId already exists (manual_ ids are time-based so unique)
  const orderId = sale.orderId || null;
  const productId = String(sale.productId || "");
  if (orderId && productId && !String(orderId).startsWith("manual_")) {
    try {
      const existing = listSales({ shop: s, limit: 500 });
      const dup = existing.find(function(r) {
        return r.orderId === orderId && r.productId === productId;
      });
      if (dup) {
        console.log("[Analytics] Duplicate sale skipped: orderId=" + orderId + " productId=" + productId);
        return dup;
      }
    } catch (e) {
      // Non-fatal, proceed
    }
  }

  // âœ… STRUCTURE MINIMALE - Pas de donnÃ©es client
  const record = {
    id: sale.id || generateId(),
    ts: new Date().toISOString(),
    
    // Commande (identifiants uniquement)
    orderDate: saleDate.toISOString(),
    orderId: sale.orderId || null,
    orderNumber: sale.orderNumber || null,
    
    // Produit
    productId: String(sale.productId || ""),
    productName: String(sale.productName || ""),
    variantId: sale.variantId || null,
    variantTitle: sale.variantTitle || null,
    categoryIds: Array.isArray(sale.categoryIds) ? sale.categoryIds : [],
    
    // QuantitÃ©s
    quantity: Number(sale.quantity || 0),
    gramsPerUnit: Number(sale.gramsPerUnit || 0),
    totalGrams: Number(sale.totalGrams || 0),
    
    // âœ… Prix RÃ‰ELS (aprÃ¨s rÃ©ductions, hors shipping/cadeaux)
    grossPrice: Number(sale.grossPrice || 0),           // Prix brut avant rÃ©ductions
    discountAmount: Number(sale.discountAmount || 0),   // RÃ©ductions appliquÃ©es
    netRevenue: Number(sale.netRevenue || 0),           // Prix rÃ©el encaissÃ© (HT)
    currency: String(sale.currency || "EUR"),
    
    // CoÃ»t (CMP snapshot)
    costPerGram: Number(sale.costPerGram || 0),
    totalCost: Number(sale.totalCost || 0),
    
    // Marge calculÃ©e sur prix RÃ‰EL
    margin: Number(sale.margin || 0),
    marginPercent: Number(sale.marginPercent || 0),
    
    // MÃ©tadonnÃ©es
    shop: sanitizeShop(s),
    source: sale.source || "webhook",
    
    // âŒ PAS DE DONNÃ‰ES CLIENT
    // Pas de: customerId, customerEmail, customerName, address, phone, ip
  };

  const file = fileForMonth(s, saleDate);
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  
  return record;
}

/**
 * Liste les ventes avec filtres
 * @param {Object} options - Options de filtrage
 * @returns {Array} Liste des ventes
 */
function listSales({ shop = "default", from, to, limit = 2000, productId } = {}) {
  const s = shop || "default";
  ensureDir(analyticsDir(s));

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();
  
  // Normaliser les dates (dÃ©but et fin de journÃ©e)
  fromDate.setHours(0, 0, 0, 0);
  toDate.setHours(23, 59, 59, 999);

  const out = [];
  const maxResults = Math.max(1, Math.min(Number(limit) || 2000, 50000));

  // DÃ©terminer les fichiers mensuels Ã  lire
  const months = getMonthsBetween(fromDate, toDate);

  for (const monthStr of months) {
    const file = path.join(analyticsDir(s), `${monthStr}.ndjson`);
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, "utf8");
    if (!content) continue;

    const lines = content.split("\n").filter(Boolean);
    
    for (const line of lines) {
      const obj = safeJsonParse(line);
      if (!obj) continue;

      // Filtrer par date
      const saleDate = new Date(obj.orderDate || obj.ts);
      if (saleDate < fromDate || saleDate > toDate) continue;

      // Filtrer par productId si spÃ©cifiÃ©
      if (productId && String(obj.productId) !== String(productId)) continue;

      out.push(obj);

      if (out.length >= maxResults * 2) break; // Buffer pour le tri
    }

    if (out.length >= maxResults * 2) break;
  }

  // Trier par date dÃ©croissante et limiter
  out.sort((a, b) => new Date(b.orderDate || b.ts) - new Date(a.orderDate || a.ts));
  return out.slice(0, maxResults);
}

/**
 * RÃ©cupÃ¨re les ventes d'un produit spÃ©cifique
 */
function getSalesByProduct(shop, productId, from, to) {
  return listSales({ shop, from, to, productId, limit: 10000 });
}

/**
 * RÃ©cupÃ¨re une vente par son ID
 */
function getSaleById(shop, saleId) {
  const sales = listSales({ shop, limit: 50000 });
  return sales.find(s => s.id === saleId) || null;
}

/**
 * Supprime les donnÃ©es analytics d'un shop
 */
function clearShopAnalytics(shop) {
  const dir = analyticsDir(shop);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Analytics supprimÃ©es pour le shop: ${shop}`);
  }
}

// ============================================
// Export Helpers
// ============================================

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Convertit les ventes en CSV (SANS donnÃ©es personnelles)
 */
function toCSV(sales = []) {
  const cols = [
    "orderDate",
    "orderId",
    "orderNumber",
    "productId",
    "productName",
    "variantTitle",
    "quantity",
    "gramsPerUnit",
    "totalGrams",
    "grossPrice",
    "discountAmount",
    "netRevenue",
    "currency",
    "costPerGram",
    "totalCost",
    "margin",
    "marginPercent",
    "shop",
  ];
  
  const header = cols.join(",");
  const lines = sales.map((r) => cols.map((c) => csvEscape(r?.[c])).join(","));
  return [header, ...lines].join("\n");
}

/**
 * Convertit les ventes en JSON formatÃ©
 */
function toJSON(sales = []) {
  return JSON.stringify(sales, null, 2);
}

// ============================================
// Utility Functions
// ============================================

/**
 * Retourne la liste des mois entre deux dates (format YYYY-MM)
 */
function getMonthsBetween(from, to) {
  const months = [];
  const current = new Date(from);
  current.setDate(1);

  while (current <= to) {
    months.push(current.toISOString().slice(0, 7));
    current.setMonth(current.getMonth() + 1);
  }

  return months;
}

/**
 * Retourne des statistiques rapides sur les fichiers
 */
function getStorageStats(shop) {
  const dir = analyticsDir(shop);
  if (!fs.existsSync(dir)) return { files: 0, totalSize: 0 };

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".ndjson"));
  let totalSize = 0;

  for (const file of files) {
    const stat = fs.statSync(path.join(dir, file));
    totalSize += stat.size;
  }

  return {
    files: files.length,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// ============================================
// Module Exports
// ============================================

module.exports = {
  // CRUD
  addSale,
  listSales,
  getSalesByProduct,
  getSaleById,
  clearShopAnalytics,
  
  // Exports
  toCSV,
  toJSON,
  
  // Utilities
  sanitizeShop,
  shopDir,
  analyticsDir,
  getStorageStats,
  getMonthsBetween,
};
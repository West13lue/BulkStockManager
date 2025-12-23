// batchStore.js aEUR Gestion des lots (Batch Tracking) avec DLC/DLUO
// Traabilit complte, alertes premption, FIFO automatique

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// Helpers
// ============================================

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s ? s.replace(/[^a-z0-9._-]/g, "_") : "default";
}

function shopDir(shop) {
  return path.join(DATA_DIR, sanitizeShop(shop));
}

function batchDir(shop) {
  return path.join(shopDir(shop), "batches");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function batchFile(shop, productId) {
  ensureDir(batchDir(shop));
  return path.join(batchDir(shop), `${productId}.json`);
}

function generateBatchId() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `LOT-${dateStr}-${rand}`;
}

// ============================================
// STRUCTURE D'UN LOT
// ============================================
/*
{
  id: "LOT-20250115-AB12",
  productId: "123456",
  
  // Quantits
  initialGrams: 500,
  currentGrams: 350,
  usedGrams: 150,
  
  // Cot
  purchasePricePerGram: 4.50,
  totalCost: 2250,
  
  // Dates
  createdAt: "2025-01-15T10:00:00Z",
  receivedAt: "2025-01-15T10:00:00Z",
  
  // Premption
  expiryType: "dlc" | "dluo" | "none",
  expiryDate: "2025-07-15",
  
  // Fournisseur (lien)
  supplierId: "supplier-123",
  supplierBatchRef: "FOURNISSEUR-REF-001",
  
  // Bon de commande (lien)
  purchaseOrderId: "PO-2025-001",
  
  // Statut
  status: "active" | "depleted" | "expired" | "recalled",
  
  // Notes
  notes: "Qualit premium",
  
  // Mtadonnes
  updatedAt: "2025-01-15T10:00:00Z",
}
*/

// ============================================
// CRUD Operations
// ============================================

/**
 * Charge tous les lots d'un produit
 */
function loadBatches(shop, productId) {
  const file = batchFile(shop, productId);
  
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.batches) ? data.batches : [];
    }
  } catch (e) {
    console.warn("Erreur lecture batches:", e.message);
  }
  
  return [];
}

/**
 * Sauvegarde les lots d'un produit
 */
function saveBatches(shop, productId, batches) {
  const file = batchFile(shop, productId);
  const data = {
    productId,
    updatedAt: new Date().toISOString(),
    batches: batches || [],
  };
  
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
  
  return batches;
}

/**
 * Cre un nouveau lot
 */
function createBatch(shop, productId, batchData) {
  const batches = loadBatches(shop, productId);
  
  const batch = {
    id: batchData.id || generateBatchId(),
    productId: String(productId),
    
    // Quantits
    initialGrams: Number(batchData.grams || batchData.initialGrams || 0),
    currentGrams: Number(batchData.grams || batchData.initialGrams || 0),
    usedGrams: 0,
    
    // Cot
    purchasePricePerGram: Number(batchData.purchasePricePerGram || batchData.costPerGram || 0),
    totalCost: 0,
    
    // Dates
    createdAt: new Date().toISOString(),
    receivedAt: batchData.receivedAt || new Date().toISOString(),
    
    // Premption
    expiryType: batchData.expiryType || "none", // dlc | dluo | none
    expiryDate: batchData.expiryDate || null,
    
    // Liens
    supplierId: batchData.supplierId || null,
    supplierBatchRef: batchData.supplierBatchRef || null,
    purchaseOrderId: batchData.purchaseOrderId || null,
    
    // Statut
    status: "active",
    
    // Notes
    notes: batchData.notes || "",
    
    updatedAt: new Date().toISOString(),
  };
  
  // Calculer le cot total
  batch.totalCost = batch.initialGrams * batch.purchasePricePerGram;
  
  batches.push(batch);
  saveBatches(shop, productId, batches);
  
  return batch;
}

/**
 * Met  jour un lot
 */
function updateBatch(shop, productId, batchId, updates) {
  const batches = loadBatches(shop, productId);
  const index = batches.findIndex(b => b.id === batchId);
  
  if (index === -1) {
    throw new Error(`Lot non trouv: ${batchId}`);
  }
  
  const batch = batches[index];
  
  // Champs modifiables
  if (updates.expiryDate !== undefined) batch.expiryDate = updates.expiryDate;
  if (updates.expiryType !== undefined) batch.expiryType = updates.expiryType;
  if (updates.notes !== undefined) batch.notes = updates.notes;
  if (updates.status !== undefined) batch.status = updates.status;
  if (updates.supplierId !== undefined) batch.supplierId = updates.supplierId;
  if (updates.supplierBatchRef !== undefined) batch.supplierBatchRef = updates.supplierBatchRef;
  
  batch.updatedAt = new Date().toISOString();
  
  batches[index] = batch;
  saveBatches(shop, productId, batches);
  
  return batch;
}

/**
 * Supprime un lot (soft delete = status recalled)
 */
function deleteBatch(shop, productId, batchId, hardDelete = false) {
  const batches = loadBatches(shop, productId);
  
  if (hardDelete) {
    const filtered = batches.filter(b => b.id !== batchId);
    saveBatches(shop, productId, filtered);
    return { deleted: true };
  }
  
  return updateBatch(shop, productId, batchId, { status: "recalled" });
}

// ============================================
// DSTOCKAGE FIFO
// ============================================

/**
 * Dstocke des grammes en FIFO (First In, First Out)
 * Utilise les lots les plus anciens en premier
 * 
 * @returns {Array} Liste des lots utiliss avec quantits
 */
function deductGramsFIFO(shop, productId, gramsToDeduct) {
  const batches = loadBatches(shop, productId);
  let remaining = Number(gramsToDeduct);
  const deductions = [];
  
  // Trier par date de rception (plus ancien en premier) puis par date d'expiration
  const activeBatches = batches
    .filter(b => b.status === "active" && b.currentGrams > 0)
    .sort((a, b) => {
      // Priorit aux lots qui expirent bientt
      if (a.expiryDate && b.expiryDate) {
        return new Date(a.expiryDate) - new Date(b.expiryDate);
      }
      if (a.expiryDate) return -1;
      if (b.expiryDate) return 1;
      // Sinon FIFO par date de rception
      return new Date(a.receivedAt) - new Date(b.receivedAt);
    });
  
  for (const batch of activeBatches) {
    if (remaining <= 0) break;
    
    const available = batch.currentGrams;
    const toDeduct = Math.min(available, remaining);
    
    if (toDeduct > 0) {
      // Mettre  jour le lot
      batch.currentGrams -= toDeduct;
      batch.usedGrams += toDeduct;
      batch.updatedAt = new Date().toISOString();
      
      // Marquer comme puis si vide
      if (batch.currentGrams <= 0) {
        batch.status = "depleted";
      }
      
      deductions.push({
        batchId: batch.id,
        grams: toDeduct,
        costPerGram: batch.purchasePricePerGram,
        totalCost: toDeduct * batch.purchasePricePerGram,
        expiryDate: batch.expiryDate,
      });
      
      remaining -= toDeduct;
    }
  }
  
  // Sauvegarder les modifications
  saveBatches(shop, productId, batches);
  
  return {
    deducted: gramsToDeduct - remaining,
    remaining,
    batches: deductions,
    totalCost: deductions.reduce((sum, d) => sum + d.totalCost, 0),
    // Cot moyen pondr des grammes dstocks
    averageCostPerGram: deductions.length > 0
      ? deductions.reduce((sum, d) => sum + d.totalCost, 0) / deductions.reduce((sum, d) => sum + d.grams, 0)
      : 0,
  };
}

/**
 * Calcule le cot FIFO pour une quantit donne (sans dstocker)
 */
function calculateFIFOCost(shop, productId, grams) {
  const batches = loadBatches(shop, productId);
  let remaining = Number(grams);
  let totalCost = 0;
  
  const activeBatches = batches
    .filter(b => b.status === "active" && b.currentGrams > 0)
    .sort((a, b) => {
      if (a.expiryDate && b.expiryDate) {
        return new Date(a.expiryDate) - new Date(b.expiryDate);
      }
      return new Date(a.receivedAt) - new Date(b.receivedAt);
    });
  
  for (const batch of activeBatches) {
    if (remaining <= 0) break;
    
    const toUse = Math.min(batch.currentGrams, remaining);
    totalCost += toUse * batch.purchasePricePerGram;
    remaining -= toUse;
  }
  
  const usedGrams = grams - remaining;
  return {
    totalCost,
    costPerGram: usedGrams > 0 ? totalCost / usedGrams : 0,
    availableGrams: usedGrams,
    shortfall: remaining,
  };
}

// ============================================
// ALERTES PREMPTION
// ============================================

/**
 * Rcupre les lots qui expirent bientt
 */
function getExpiringBatches(shop, options = {}) {
  const { productId, daysThreshold = 30 } = options;
  const now = new Date();
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + daysThreshold);
  
  const results = [];
  const dir = batchDir(shop);
  
  if (!fs.existsSync(dir)) return results;
  
  const files = productId
    ? [`${productId}.json`]
    : fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  
  for (const file of files) {
    const pid = file.replace(".json", "");
    const batches = loadBatches(shop, pid);
    
    for (const batch of batches) {
      if (batch.status !== "active" || !batch.expiryDate) continue;
      
      const expiry = new Date(batch.expiryDate);
      
      if (expiry <= threshold) {
        const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        
        results.push({
          ...batch,
          productId: pid,
          daysLeft,
          isExpired: daysLeft <= 0,
          urgency: daysLeft <= 0 ? "expired" : daysLeft <= 7 ? "critical" : daysLeft <= 14 ? "warning" : "info",
        });
      }
    }
  }
  
  // Trier par urgence
  return results.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * Rcupre les lots expirs
 */
function getExpiredBatches(shop, productId = null) {
  return getExpiringBatches(shop, { productId, daysThreshold: 0 })
    .filter(b => b.isExpired);
}

/**
 * Marque automatiquement les lots expirs
 */
function markExpiredBatches(shop) {
  const expired = getExpiredBatches(shop);
  const marked = [];
  
  for (const batch of expired) {
    if (batch.status === "active") {
      updateBatch(shop, batch.productId, batch.id, { status: "expired" });
      marked.push(batch.id);
    }
  }
  
  return { markedCount: marked.length, batchIds: marked };
}

// ============================================
// STATISTIQUES
// ============================================

/**
 * Statistiques des lots d'un produit
 */
function getBatchStats(shop, productId) {
  const batches = loadBatches(shop, productId);
  
  const stats = {
    totalBatches: batches.length,
    activeBatches: 0,
    depletedBatches: 0,
    expiredBatches: 0,
    recalledBatches: 0,
    
    totalGrams: 0,
    availableGrams: 0,
    
    totalValue: 0,
    availableValue: 0,
    
    averageCostPerGram: 0,
    
    oldestBatch: null,
    newestBatch: null,
    nextExpiring: null,
  };
  
  let totalCost = 0;
  let totalUsedGrams = 0;
  
  for (const batch of batches) {
    stats.totalGrams += batch.initialGrams;
    totalCost += batch.initialGrams * batch.purchasePricePerGram;
    
    switch (batch.status) {
      case "active":
        stats.activeBatches++;
        stats.availableGrams += batch.currentGrams;
        stats.availableValue += batch.currentGrams * batch.purchasePricePerGram;
        break;
      case "depleted":
        stats.depletedBatches++;
        break;
      case "expired":
        stats.expiredBatches++;
        break;
      case "recalled":
        stats.recalledBatches++;
        break;
    }
    
    totalUsedGrams += batch.usedGrams;
  }
  
  stats.totalValue = totalCost;
  stats.averageCostPerGram = stats.totalGrams > 0 ? totalCost / stats.totalGrams : 0;
  
  // Trouver lots remarquables
  const activeBatches = batches.filter(b => b.status === "active");
  
  if (activeBatches.length > 0) {
    stats.oldestBatch = activeBatches.reduce((a, b) =>
      new Date(a.receivedAt) < new Date(b.receivedAt) ? a : b
    );
    
    stats.newestBatch = activeBatches.reduce((a, b) =>
      new Date(a.receivedAt) > new Date(b.receivedAt) ? a : b
    );
    
    const withExpiry = activeBatches.filter(b => b.expiryDate);
    if (withExpiry.length > 0) {
      stats.nextExpiring = withExpiry.reduce((a, b) =>
        new Date(a.expiryDate) < new Date(b.expiryDate) ? a : b
      );
    }
  }
  
  return stats;
}

/**
 * Rsum global des lots pour un shop
 */
function getShopBatchSummary(shop) {
  const dir = batchDir(shop);
  
  if (!fs.existsSync(dir)) {
    return {
      totalProducts: 0,
      totalBatches: 0,
      expiringWithin30Days: 0,
      expiredBatches: 0,
      totalValue: 0,
    };
  }
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  
  let totalBatches = 0;
  let totalValue = 0;
  const expiring = getExpiringBatches(shop, { daysThreshold: 30 });
  const expired = expiring.filter(b => b.isExpired);
  
  for (const file of files) {
    const pid = file.replace(".json", "");
    const stats = getBatchStats(shop, pid);
    totalBatches += stats.totalBatches;
    totalValue += stats.availableValue;
  }
  
  return {
    totalProducts: files.length,
    totalBatches,
    expiringWithin30Days: expiring.length,
    expiredBatches: expired.length,
    totalValue,
  };
}

// ============================================
// LISTE & RECHERCHE
// ============================================

/**
 * Liste tous les lots d'un produit
 */
function listBatches(shop, productId, options = {}) {
  const { status, includeEmpty = false } = options;
  let batches = loadBatches(shop, productId);
  
  if (status) {
    batches = batches.filter(b => b.status === status);
  }
  
  if (!includeEmpty) {
    batches = batches.filter(b => b.currentGrams > 0 || b.status !== "active");
  }
  
  return batches;
}

/**
 * Recherche un lot par son ID
 */
function getBatch(shop, productId, batchId) {
  const batches = loadBatches(shop, productId);
  return batches.find(b => b.id === batchId) || null;
}

/**
 * Recherche un lot par rfrence fournisseur
 */
function findBatchBySupplierRef(shop, productId, supplierRef) {
  const batches = loadBatches(shop, productId);
  return batches.find(b => b.supplierBatchRef === supplierRef) || null;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // CRUD
  loadBatches,
  createBatch,
  updateBatch,
  deleteBatch,
  getBatch,
  listBatches,
  
  // FIFO
  deductGramsFIFO,
  calculateFIFOCost,
  
  // Premption
  getExpiringBatches,
  getExpiredBatches,
  markExpiredBatches,
  
  // Stats
  getBatchStats,
  getShopBatchSummary,
  
  // Recherche
  findBatchBySupplierRef,
  
  // Utils
  generateBatchId,
};
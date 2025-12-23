// supplierStore.js aEUR Gestion des fournisseurs
// Carnet d'adresses, historique achats, comparaison prix

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

function suppliersFile(shop) {
  const dir = shopDir(shop);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "suppliers.json");
}

function generateId() {
  return `sup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================
// STRUCTURE D'UN FOURNISSEUR
// ============================================
/*
{
  id: "sup_123",
  name: "CBD Wholesale France",
  code: "CBDWF",  // Code court pour rfrence
  
  // Contact
  contact: {
    name: "Jean Dupont",
    email: "contact@cbdwholesale.fr",
    phone: "+33 1 23 45 67 89",
    website: "https://cbdwholesale.fr",
  },
  
  // Adresse
  address: {
    street: "123 Rue du Commerce",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  },
  
  // Conditions
  terms: {
    currency: "EUR",
    paymentTerms: "30 days",      // net30, net60, immediate, etc.
    minOrderAmount: 500,          // Commande minimum a
    minOrderGrams: 1000,          // Commande minimum g
    deliveryDays: 3,              // Dlai de livraison moyen
    shippingCost: 15,             // Frais de port fixes
    freeShippingThreshold: 1000,  // Franco de port  partir de
  },
  
  // Produits fournis (optionnel - lien avec products)
  products: [
    { productId: "123", pricePerGram: 4.50, lastUpdated: "2025-01-15" },
  ],
  
  // Notes & tags
  notes: "Excellent rapport qualit/prix",
  tags: ["premium", "bio", "france"],
  
  // Statut
  status: "active" | "inactive" | "blocked",
  rating: 4.5,  // Note sur 5
  
  // Mtadonnes
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-15T00:00:00Z",
}
*/

// ============================================
// CRUD Operations
// ============================================

/**
 * Charge tous les fournisseurs
 */
function loadSuppliers(shop) {
  const file = suppliersFile(shop);
  
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.suppliers) ? data.suppliers : [];
    }
  } catch (e) {
    console.warn("Erreur lecture suppliers:", e.message);
  }
  
  return [];
}

/**
 * Sauvegarde les fournisseurs
 */
function saveSuppliers(shop, suppliers) {
  const file = suppliersFile(shop);
  const data = {
    updatedAt: new Date().toISOString(),
    suppliers: suppliers || [],
  };
  
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
  
  return suppliers;
}

/**
 * Cre un nouveau fournisseur
 */
function createSupplier(shop, supplierData) {
  const suppliers = loadSuppliers(shop);
  
  // Vrifier unicit du code
  if (supplierData.code) {
    const existing = suppliers.find(s => 
      s.code && s.code.toLowerCase() === supplierData.code.toLowerCase()
    );
    if (existing) {
      throw new Error(`Code fournisseur dj utilis: ${supplierData.code}`);
    }
  }
  
  const supplier = {
    id: generateId(),
    name: String(supplierData.name || "").trim(),
    code: String(supplierData.code || "").trim().toUpperCase() || null,
    
    contact: {
      name: supplierData.contact?.name || "",
      email: supplierData.contact?.email || "",
      phone: supplierData.contact?.phone || "",
      website: supplierData.contact?.website || "",
    },
    
    address: {
      street: supplierData.address?.street || "",
      city: supplierData.address?.city || "",
      postalCode: supplierData.address?.postalCode || "",
      country: supplierData.address?.country || "",
    },
    
    terms: {
      currency: supplierData.terms?.currency || "EUR",
      paymentTerms: supplierData.terms?.paymentTerms || "",
      minOrderAmount: Number(supplierData.terms?.minOrderAmount || 0),
      minOrderGrams: Number(supplierData.terms?.minOrderGrams || 0),
      deliveryDays: Number(supplierData.terms?.deliveryDays || 0),
      shippingCost: Number(supplierData.terms?.shippingCost || 0),
      freeShippingThreshold: Number(supplierData.terms?.freeShippingThreshold || 0),
    },
    
    products: [],
    notes: supplierData.notes || "",
    tags: Array.isArray(supplierData.tags) ? supplierData.tags : [],
    
    status: "active",
    rating: null,
    
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  
  if (!supplier.name) {
    throw new Error("Nom du fournisseur requis");
  }
  
  suppliers.push(supplier);
  saveSuppliers(shop, suppliers);
  
  return supplier;
}

/**
 * Met  jour un fournisseur
 */
function updateSupplier(shop, supplierId, updates) {
  const suppliers = loadSuppliers(shop);
  const index = suppliers.findIndex(s => s.id === supplierId);
  
  if (index === -1) {
    throw new Error(`Fournisseur non trouv: ${supplierId}`);
  }
  
  const supplier = suppliers[index];
  
  // Champs modifiables
  if (updates.name !== undefined) supplier.name = String(updates.name).trim();
  if (updates.code !== undefined) supplier.code = String(updates.code).trim().toUpperCase() || null;
  
  if (updates.contact) {
    supplier.contact = { ...supplier.contact, ...updates.contact };
  }
  
  if (updates.address) {
    supplier.address = { ...supplier.address, ...updates.address };
  }
  
  if (updates.terms) {
    supplier.terms = { ...supplier.terms, ...updates.terms };
  }
  
  if (updates.notes !== undefined) supplier.notes = updates.notes;
  if (updates.tags !== undefined) supplier.tags = updates.tags;
  if (updates.status !== undefined) supplier.status = updates.status;
  if (updates.rating !== undefined) supplier.rating = updates.rating;
  
  supplier.updatedAt = new Date().toISOString();
  
  suppliers[index] = supplier;
  saveSuppliers(shop, suppliers);
  
  return supplier;
}

/**
 * Supprime un fournisseur
 */
function deleteSupplier(shop, supplierId, hardDelete = false) {
  const suppliers = loadSuppliers(shop);
  
  if (hardDelete) {
    const filtered = suppliers.filter(s => s.id !== supplierId);
    saveSuppliers(shop, filtered);
    return { deleted: true };
  }
  
  // Soft delete
  return updateSupplier(shop, supplierId, { status: "inactive" });
}

/**
 * Rcupre un fournisseur par ID
 */
function getSupplier(shop, supplierId) {
  const suppliers = loadSuppliers(shop);
  return suppliers.find(s => s.id === supplierId) || null;
}

/**
 * Rcupre un fournisseur par code
 */
function getSupplierByCode(shop, code) {
  const suppliers = loadSuppliers(shop);
  return suppliers.find(s => s.code && s.code.toLowerCase() === code.toLowerCase()) || null;
}

/**
 * Liste les fournisseurs
 */
function listSuppliers(shop, options = {}) {
  const { status, tag, search } = options;
  let suppliers = loadSuppliers(shop);
  
  if (status) {
    suppliers = suppliers.filter(s => s.status === status);
  }
  
  if (tag) {
    suppliers = suppliers.filter(s => s.tags.includes(tag));
  }
  
  if (search) {
    const q = search.toLowerCase();
    suppliers = suppliers.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.code && s.code.toLowerCase().includes(q)) ||
      s.contact.name.toLowerCase().includes(q)
    );
  }
  
  return suppliers;
}

// ============================================
// GESTION DES PRIX PAR PRODUIT
// ============================================

/**
 * Ajoute/met  jour le prix d'un produit chez un fournisseur
 */
function setProductPrice(shop, supplierId, productId, pricePerGram, options = {}) {
  const suppliers = loadSuppliers(shop);
  const index = suppliers.findIndex(s => s.id === supplierId);
  
  if (index === -1) {
    throw new Error(`Fournisseur non trouv: ${supplierId}`);
  }
  
  const supplier = suppliers[index];
  const productIndex = supplier.products.findIndex(p => p.productId === productId);
  
  const productEntry = {
    productId: String(productId),
    pricePerGram: Number(pricePerGram),
    minQuantity: Number(options.minQuantity || 0),
    lastUpdated: new Date().toISOString(),
    notes: options.notes || "",
  };
  
  if (productIndex === -1) {
    supplier.products.push(productEntry);
  } else {
    supplier.products[productIndex] = productEntry;
  }
  
  supplier.updatedAt = new Date().toISOString();
  suppliers[index] = supplier;
  saveSuppliers(shop, suppliers);
  
  return productEntry;
}

/**
 * Supprime un produit d'un fournisseur
 */
function removeProductPrice(shop, supplierId, productId) {
  const suppliers = loadSuppliers(shop);
  const index = suppliers.findIndex(s => s.id === supplierId);
  
  if (index === -1) return false;
  
  const supplier = suppliers[index];
  supplier.products = supplier.products.filter(p => p.productId !== productId);
  supplier.updatedAt = new Date().toISOString();
  
  suppliers[index] = supplier;
  saveSuppliers(shop, suppliers);
  
  return true;
}

/**
 * Rcupre tous les fournisseurs pour un produit donn
 */
function getSuppliersForProduct(shop, productId) {
  const suppliers = loadSuppliers(shop);
  const results = [];
  
  for (const supplier of suppliers) {
    if (supplier.status !== "active") continue;
    
    const product = supplier.products.find(p => p.productId === productId);
    if (product) {
      results.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierCode: supplier.code,
        ...product,
        deliveryDays: supplier.terms.deliveryDays,
        minOrderAmount: supplier.terms.minOrderAmount,
      });
    }
  }
  
  // Trier par prix
  return results.sort((a, b) => a.pricePerGram - b.pricePerGram);
}

/**
 * Compare les prix entre fournisseurs pour un produit
 */
function comparePrices(shop, productId, quantity = 100) {
  const suppliers = getSuppliersForProduct(shop, productId);
  
  return suppliers.map(s => ({
    ...s,
    totalCost: s.pricePerGram * quantity,
    savings: suppliers[0] ? (s.pricePerGram - suppliers[0].pricePerGram) * quantity : 0,
    savingsPercent: suppliers[0] && suppliers[0].pricePerGram > 0
      ? ((s.pricePerGram - suppliers[0].pricePerGram) / suppliers[0].pricePerGram) * 100
      : 0,
  }));
}

// ============================================
// STATISTIQUES
// ============================================

/**
 * Statistiques globales des fournisseurs
 */
function getSupplierStats(shop) {
  const suppliers = loadSuppliers(shop);
  
  return {
    total: suppliers.length,
    active: suppliers.filter(s => s.status === "active").length,
    inactive: suppliers.filter(s => s.status === "inactive").length,
    blocked: suppliers.filter(s => s.status === "blocked").length,
    withProducts: suppliers.filter(s => s.products.length > 0).length,
    averageRating: (() => {
      const rated = suppliers.filter(s => s.rating !== null);
      if (rated.length === 0) return null;
      return rated.reduce((sum, s) => sum + s.rating, 0) / rated.length;
    })(),
    tags: [...new Set(suppliers.flatMap(s => s.tags))],
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // CRUD
  loadSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  getSupplier,
  getSupplierByCode,
  listSuppliers,
  
  // Prix produits
  setProductPrice,
  removeProductPrice,
  getSuppliersForProduct,
  comparePrices,
  
  // Stats
  getSupplierStats,
};
// stockState.js — HYBRIDE (compat ancienne app + nouveau stockManager)
// ✅ Ajoute loadState/saveState (multi-shop, Render disk /var/data)
// ✅ Garde toutes tes anciennes fonctions (products/types/movements) pour compat

const fs = require("fs");
const path = require("path");

// ===============================
// 0) Render Disk (multi-shop) ✅
// ===============================
const DATA_DIR = process.env.DATA_DIR || "/var/data";

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  if (!s) return "default";
  return s.replace(/[^a-z0-9._-]/g, "_");
}

function shopDir(shop) {
  return path.join(DATA_DIR, sanitizeShop(shop));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function stateFile(shop) {
  const dir = shopDir(shop);
  ensureDir(dir);
  return path.join(dir, "stock.json");
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * ✅ NOUVEAU : loadState(shop) -> Object
 * Utilisé par stockManager.js (version v2, products + deletedProductIds)
 */
function loadState(shop = "default") {
  const file = stateFile(shop);
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  return safeJsonParse(raw, {});
}

/**
 * ✅ NOUVEAU : saveState(shop, data) -> void
 * Écriture atomique .tmp + rename
 */
function saveState(shop = "default", data = {}) {
  const file = stateFile(shop);
  const tmp = file + ".tmp";
  const payload = JSON.stringify(data ?? {}, null, 2);
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, file);
}

// ===============================================
// 1) Ancien stockage local (compat DEV) ⚠️
// (Garde tes fonctions existantes, mais en prod Render
// tu ne dois PAS compter sur __dirname/data pour persister)
// ===============================================
const LEGACY_DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(LEGACY_DATA_DIR)) {
  fs.mkdirSync(LEGACY_DATA_DIR, { recursive: true });
  console.log("✅ Dossier data/ créé (legacy)");
}

const PRODUCTS_FILE = path.join(LEGACY_DATA_DIR, "products.json");
const TYPES_FILE = path.join(LEGACY_DATA_DIR, "types.json");
const MOVEMENTS_FILE = path.join(LEGACY_DATA_DIR, "movements.json");

// État legacy
const state = {
  products: [],
  productTypes: { types: [] },
  movements: [],
  lastSync: null,
};

// ---------- legacy helpers ----------
function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = fs.readFileSync(PRODUCTS_FILE, "utf8");
      state.products = JSON.parse(data);
      console.log(`✅ ${state.products.length} produits chargés (legacy)`);
    } else {
      console.log("⚠️  Aucun fichier produits (legacy), init vide");
      saveProducts();
    }
  } catch (error) {
    console.error("❌ Erreur chargement produits (legacy):", error);
    state.products = [];
  }
}

function saveProducts() {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(state.products, null, 2), "utf8");
    console.log(`✅ ${state.products.length} produits sauvegardés (legacy)`);
  } catch (error) {
    console.error("❌ Erreur sauvegarde produits (legacy):", error);
  }
}

function loadTypes() {
  try {
    if (fs.existsSync(TYPES_FILE)) {
      const data = fs.readFileSync(TYPES_FILE, "utf8");
      state.productTypes = JSON.parse(data);
      console.log(`✅ ${state.productTypes.types.length} types chargés (legacy)`);
    } else {
      console.log("⚠️  Aucun fichier types (legacy), création...");
      state.productTypes = {
        types: [
          {
            id: "3x-filtre",
            name: "3x filtré",
            description: "Produit filtré 3 fois",
            isActive: true,
            createdAt: new Date().toISOString(),
          },
          {
            id: "2x-filtre",
            name: "2x filtré",
            description: "Produit filtré 2 fois",
            isActive: true,
            createdAt: new Date().toISOString(),
          },
          {
            id: "brut",
            name: "Brut",
            description: "Produit non filtré",
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
      };
      saveTypes();
    }
  } catch (error) {
    console.error("❌ Erreur chargement types (legacy):", error);
    state.productTypes = { types: [] };
  }
}

function saveTypes() {
  try {
    fs.writeFileSync(TYPES_FILE, JSON.stringify(state.productTypes, null, 2), "utf8");
    console.log(`✅ ${state.productTypes.types.length} types sauvegardés (legacy)`);
  } catch (error) {
    console.error("❌ Erreur sauvegarde types (legacy):", error);
  }
}

function loadMovements() {
  try {
    if (fs.existsSync(MOVEMENTS_FILE)) {
      const data = fs.readFileSync(MOVEMENTS_FILE, "utf8");
      state.movements = JSON.parse(data);
      console.log(`✅ ${state.movements.length} mouvements chargés (legacy)`);
    } else {
      console.log("⚠️  Aucun fichier mouvements (legacy), init vide");
      saveMovements();
    }
  } catch (error) {
    console.error("❌ Erreur chargement mouvements (legacy):", error);
    state.movements = [];
  }
}

function saveMovements() {
  try {
    if (state.movements.length > 1000) {
      state.movements = state.movements
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 1000);
      console.log("🧹 Mouvements limités à 1000 (legacy)");
    }
    fs.writeFileSync(MOVEMENTS_FILE, JSON.stringify(state.movements, null, 2), "utf8");
    console.log(`✅ ${state.movements.length} mouvements sauvegardés (legacy)`);
  } catch (error) {
    console.error("❌ Erreur sauvegarde mouvements (legacy):", error);
  }
}

// ===============================================
// 2) API legacy (inchangée)
// ===============================================
function initialize() {
  console.log("\n🚀 Initialisation du stockage (legacy)...");
  loadProducts();
  loadTypes();
  loadMovements();
  console.log("✅ Stockage legacy initialisé\n");
}

function addProduct(product) {
  state.products.push(product);
  saveProducts();
}

function updateProduct(productId, updates) {
  const index = state.products.findIndex((p) => p.id === productId);
  if (index !== -1) {
    state.products[index] = { ...state.products[index], ...updates };
    saveProducts();
    return state.products[index];
  }
  return null;
}

function addMovement(movement) {
  const newMovement = {
    id: Date.now(),
    date: new Date().toISOString(),
    ...movement,
  };
  state.movements.push(newMovement);
  saveMovements();
  return newMovement;
}

function addType(type) {
  const newType = {
    id: type.id || Date.now().toString(),
    name: type.name,
    description: type.description || "",
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  state.productTypes.types.push(newType);
  saveTypes();
  return newType;
}

function updateType(typeId, updates) {
  const index = state.productTypes.types.findIndex((t) => t.id === typeId);
  if (index !== -1) {
    state.productTypes.types[index] = { ...state.productTypes.types[index], ...updates };
    saveTypes();
    return state.productTypes.types[index];
  }
  return null;
}

function getProducts() {
  return state.products;
}
function getProductById(id) {
  return state.products.find((p) => p.id === id);
}
function getTypes() {
  return state.productTypes.types;
}
function getMovements() {
  return state.movements;
}
function setProducts(products) {
  state.products = products;
  saveProducts();
}
function setLastSync(date) {
  state.lastSync = date;
}
function getLastSync() {
  return state.lastSync;
}

// ===============================================
// EXPORTS ✅ (anciennes + nouvelles)
// ===============================================
module.exports = {
  // ✅ nouveau (pour stockManager.js)
  sanitizeShop,
  shopDir,
  loadState,
  saveState,

  // legacy (compat)
  initialize,

  getProducts,
  getProductById,
  setProducts,
  addProduct,
  updateProduct,

  getTypes,
  addType,
  updateType,

  getMovements,
  addMovement,

  setLastSync,
  getLastSync,

  state,
};

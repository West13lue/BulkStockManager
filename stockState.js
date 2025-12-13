// stockState.js - VERSION FIXÉE avec persistance
const fs = require('fs');
const path = require('path');

// IMPORTANT: Créer le dossier data/ s'il n'existe pas
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('✅ Dossier data/ créé');
}

// Chemins des fichiers de données
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const TYPES_FILE = path.join(DATA_DIR, 'types.json');
const MOVEMENTS_FILE = path.join(DATA_DIR, 'movements.json');

// État de l'application
const state = {
  products: [],
  productTypes: { types: [] },
  movements: [],
  lastSync: null
};

/**
 * Charge les produits depuis le fichier
 */
function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
      state.products = JSON.parse(data);
      console.log(`✅ ${state.products.length} produits chargés`);
    } else {
      console.log('⚠️  Aucun fichier produits, initialisation vide');
      saveProducts();
    }
  } catch (error) {
    console.error('❌ Erreur chargement produits:', error);
    state.products = [];
  }
}

/**
 * Sauvegarde les produits dans le fichier
 */
function saveProducts() {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(state.products, null, 2), 'utf8');
    console.log(`✅ ${state.products.length} produits sauvegardés`);
  } catch (error) {
    console.error('❌ Erreur sauvegarde produits:', error);
  }
}

/**
 * Charge les types de produits depuis le fichier
 * FIX DU "3x FILTRÉ" QUI DISPARAISSAIT
 */
function loadTypes() {
  try {
    if (fs.existsSync(TYPES_FILE)) {
      const data = fs.readFileSync(TYPES_FILE, 'utf8');
      state.productTypes = JSON.parse(data);
      console.log(`✅ ${state.productTypes.types.length} types chargés`);
    } else {
      // Créer le fichier types par défaut
      console.log('⚠️  Aucun fichier types, création...');
      state.productTypes = {
        types: [
          {
            id: '3x-filtre',
            name: '3x filtré',
            description: 'Produit filtré 3 fois',
            isActive: true,
            createdAt: new Date().toISOString()
          },
          {
            id: '2x-filtre',
            name: '2x filtré',
            description: 'Produit filtré 2 fois',
            isActive: true,
            createdAt: new Date().toISOString()
          },
          {
            id: 'brut',
            name: 'Brut',
            description: 'Produit non filtré',
            isActive: true,
            createdAt: new Date().toISOString()
          }
        ]
      };
      saveTypes();
    }
  } catch (error) {
    console.error('❌ Erreur chargement types:', error);
    state.productTypes = { types: [] };
  }
}

/**
 * Sauvegarde les types dans le fichier
 */
function saveTypes() {
  try {
    fs.writeFileSync(TYPES_FILE, JSON.stringify(state.productTypes, null, 2), 'utf8');
    console.log(`✅ ${state.productTypes.types.length} types sauvegardés`);
  } catch (error) {
    console.error('❌ Erreur sauvegarde types:', error);
  }
}

/**
 * Charge les mouvements depuis le fichier
 */
function loadMovements() {
  try {
    if (fs.existsSync(MOVEMENTS_FILE)) {
      const data = fs.readFileSync(MOVEMENTS_FILE, 'utf8');
      state.movements = JSON.parse(data);
      console.log(`✅ ${state.movements.length} mouvements chargés`);
    } else {
      console.log('⚠️  Aucun fichier mouvements, initialisation vide');
      saveMovements();
    }
  } catch (error) {
    console.error('❌ Erreur chargement mouvements:', error);
    state.movements = [];
  }
}

/**
 * Sauvegarde les mouvements dans le fichier
 */
function saveMovements() {
  try {
    // Limiter à 1000 mouvements max (pour Render 1GB)
    if (state.movements.length > 1000) {
      state.movements = state.movements
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 1000);
      console.log('🧹 Mouvements limités à 1000');
    }
    
    fs.writeFileSync(MOVEMENTS_FILE, JSON.stringify(state.movements, null, 2), 'utf8');
    console.log(`✅ ${state.movements.length} mouvements sauvegardés`);
  } catch (error) {
    console.error('❌ Erreur sauvegarde mouvements:', error);
  }
}

/**
 * Initialise l'état au démarrage
 */
function initialize() {
  console.log('\n🚀 Initialisation du stockage...');
  loadProducts();
  loadTypes();
  loadMovements();
  console.log('✅ Stockage initialisé\n');
}

/**
 * Ajoute un produit
 */
function addProduct(product) {
  state.products.push(product);
  saveProducts();
}

/**
 * Met à jour un produit
 */
function updateProduct(productId, updates) {
  const index = state.products.findIndex(p => p.id === productId);
  if (index !== -1) {
    state.products[index] = { ...state.products[index], ...updates };
    saveProducts();
    return state.products[index];
  }
  return null;
}

/**
 * Ajoute un mouvement
 */
function addMovement(movement) {
  const newMovement = {
    id: Date.now(),
    date: new Date().toISOString(),
    ...movement
  };
  state.movements.push(newMovement);
  saveMovements();
  return newMovement;
}

/**
 * Ajoute un type de produit
 */
function addType(type) {
  const newType = {
    id: type.id || Date.now().toString(),
    name: type.name,
    description: type.description || '',
    isActive: true,
    createdAt: new Date().toISOString()
  };
  state.productTypes.types.push(newType);
  saveTypes();
  return newType;
}

/**
 * Met à jour un type
 */
function updateType(typeId, updates) {
  const index = state.productTypes.types.findIndex(t => t.id === typeId);
  if (index !== -1) {
    state.productTypes.types[index] = {
      ...state.productTypes.types[index],
      ...updates
    };
    saveTypes();
    return state.productTypes.types[index];
  }
  return null;
}

// Getters
function getProducts() {
  return state.products;
}

function getProductById(id) {
  return state.products.find(p => p.id === id);
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

module.exports = {
  initialize,
  
  // Products
  getProducts,
  getProductById,
  setProducts,
  addProduct,
  updateProduct,
  
  // Types
  getTypes,
  addType,
  updateType,
  
  // Movements
  getMovements,
  addMovement,
  
  // Sync
  setLastSync,
  getLastSync,
  
  // Direct access (éviter, préférer les fonctions)
  state
};
// settingsManager.js â€” Gestionnaire de parametres avance (multi-shop)
// âœ… International, compliance-friendly, app store ready

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// SCHEMA DES PARAMETRES PAR DEFAUT
// ============================================

const DEFAULT_SETTINGS = {
  // ==================== GENERAL ====================
  general: {
    language: "auto",           // auto | fr | en | de | es | it
    timezone: "auto",           // auto | Europe/Paris | America/New_York | etc.
    dateFormat: "iso",          // iso (2025-01-15) | eu (15/01/2025) | us (01/15/2025)
    timeFormat: "24h",          // 24h | 12h
  },

  // ==================== UNITES & FORMATS ====================
  units: {
    weightUnit: "g",            // g | kg | oz | lb
    weightPrecision: 1,         // Decimales (0, 1, 2)
    showEquivalent: false,      // Afficher equivalent (ex: 1000g = 1kg)
    roundingRule: "standard",   // standard | floor | ceil
    neverNegative: true,        // Ne jamais descendre sous 0
  },

  // ==================== MONNAIE ====================
  currency: {
    code: "EUR",                // EUR | USD | GBP | CAD | CHF | etc.
    symbol: "EUR",
    position: "after",          // before | after
    decimalSeparator: ",",      // , | .
    thousandsSeparator: " ",    // (espace) | , | . | '
    decimals: 2,
  },

  // ==================== STOCK ====================
  stock: {
    lowStockThreshold: 10,      // Seuil stock bas (en unite de poids)
    lowStockEnabled: true,      // Activer alertes stock bas
    lowStockColor: "#ef4444",   // Couleur pour stock bas
    
    costMethod: "cmp",          // cmp (Cout Moyen Pondere) | fifo | lifo
    freezeCMP: false,           // Figer le CMP (ne pas recalculer)
    
    sourceOfTruth: "app",       // app | shopify
    syncFrequency: "realtime",  // realtime | hourly | daily | manual
  },

  // ==================== LOCATIONS SHOPIFY ====================
  locations: {
    defaultLocationId: "auto",  // auto | ID specifique
    multiLocationBehavior: "primary", // primary | distribute | ignore
    // primary = ecrire sur location par defaut uniquement
    // distribute = repartir le stock
    // ignore = ne pas synchroniser les locations
  },

  // ==================== CATEGORIES ====================
  categories: {
    enabled: true,
    showUncategorized: true,    // Afficher "Sans categorie"
    sortOrder: "alpha",         // alpha | manual | count
    defaultExpanded: true,      // Categories depliees par defaut
  },

  // ==================== FREEBIES / CADEAUX ====================
  freebies: {
    enabled: false,
    mode: "per_order",          // per_order | per_product | per_category | cart_threshold
    deductionPerOrder: 0,       // Grammes deduits par commande
    deductionPerProduct: {},    // { productId: grams }
    deductionPerCategory: {},   // { categoryId: grams }
    cartThresholds: [],         // [{ minAmount: 50, deduction: 2 }, ...]
    excludeFromMargin: true,    // Exclure freebies du calcul de marge
  },

  // ==================== EXPORTS CSV ====================
  exports: {
    delimiter: ";",             // ; | , | \t
    encoding: "utf-8",          // utf-8 | utf-8-bom | iso-8859-1
    dateFormat: "iso",          // iso | eu | us
    defaultPeriodDays: 30,      // 7 | 30 | 90 | 365
    includeHeaders: true,
    columns: {
      stock: ["productId", "name", "totalGrams", "averageCostPerGram", "categoryIds", "stockValue"],
      movements: ["ts", "source", "productId", "productName", "gramsDelta", "purchasePricePerGram", "totalAfter"],
      analytics: ["orderDate", "orderId", "productName", "quantity", "totalGrams", "netRevenue", "totalCost", "margin", "marginPercent"],
    },
  },

  // ==================== MARGE & ANALYTICS (PREMIUM) ====================
  analytics: {
    costMethod: "cmp",          // cmp | fifo | actual
    includeShipping: false,     // Inclure shipping dans le CA
    includeTaxes: false,        // Inclure taxes dans le CA
    includeDiscounts: true,     // Deduire les reductions (recommande)
    excludeFreebies: true,      // Exclure les freebies du CA
    excludeGifts: true,         // Exclure les produits offerts (prix=0)
  },

  // ==================== SECURITE & PERMISSIONS ====================
  security: {
    readOnlyMode: false,        // Mode lecture seule (desactive ecritures Shopify)
    confirmDestructive: true,   // Confirmation avant actions destructrices
    requirePinForSensitive: false, // PIN pour actions sensibles
    pin: null,                  // Code PIN hashe
    
    allowedActions: {
      restock: true,
      adjustStock: true,
      deleteProduct: true,
      importShopify: true,
      resetStock: false,        // Desactive par defaut
      exportData: true,
    },
  },

  // ==================== NOTIFICATIONS (PREMIUM) ====================
  notifications: {
    enabled: false,
    channels: {
      email: { enabled: false, address: null },
      slack: { enabled: false, webhookUrl: null },
      discord: { enabled: false, webhookUrl: null },
    },
    triggers: {
      lowStock: true,
      webhookError: true,
      importComplete: true,
      dailySummary: false,
    },
  },

  // ==================== LOGS & AUDIT ====================
  logs: {
    level: "normal",            // normal | debug | verbose
    retentionDays: 30,          // 7 | 30 | 90 | 365
    includePayloads: false,     // Inclure payloads complets (debug)
  },

  // ==================== METADONNEES ====================
  _meta: {
    version: 2,
    createdAt: null,
    updatedAt: null,
    lastBackup: null,
  },
};

// ============================================
// OPTIONS DISPONIBLES (pour UI)
// ============================================

const SETTING_OPTIONS = {
  languages: [
    { value: "auto", label: "Auto (Shopify)" },
    { value: "fr", label: "Francais" },
    { value: "en", label: "English" },
    { value: "de", label: "Deutsch" },
    { value: "es", label: "EspaÃ±ol" },
    { value: "it", label: "Italiano" },
  ],
  
  timezones: [
    { value: "auto", label: "Auto (Shopify)" },
    { value: "Europe/Paris", label: "Paris (CET)" },
    { value: "Europe/London", label: "London (GMT)" },
    { value: "America/New_York", label: "New York (EST)" },
    { value: "America/Los_Angeles", label: "Los Angeles (PST)" },
    { value: "Asia/Tokyo", label: "Tokyo (JST)" },
    { value: "Australia/Sydney", label: "Sydney (AEST)" },
  ],
  
  weightUnits: [
    { value: "g", label: "Grammes (g)", factor: 1 },
    { value: "kg", label: "Kilogrammes (kg)", factor: 1000 },
    { value: "oz", label: "Onces (oz)", factor: 28.3495 },
    { value: "lb", label: "Livres (lb)", factor: 453.592 },
  ],
  
  currencies: [
    { value: "EUR", symbol: "EUR", label: "Euro" },
    { value: "USD", symbol: "$", label: "US Dollar" },
    { value: "GBP", symbol: "Â£", label: "British Pound" },
    { value: "CAD", symbol: "CA$", label: "Canadian Dollar" },
    { value: "CHF", symbol: "CHF", label: "Swiss Franc" },
    { value: "AUD", symbol: "A$", label: "Australian Dollar" },
    { value: "JPY", symbol: "Â¥", label: "Japanese Yen" },
  ],
  
  dateFormats: [
    { value: "iso", label: "ISO (2025-01-15)", example: "2025-01-15" },
    { value: "eu", label: "Europe (15/01/2025)", example: "15/01/2025" },
    { value: "us", label: "US (01/15/2025)", example: "01/15/2025" },
  ],
  
  costMethods: [
    { value: "cmp", label: "CMP (Cout Moyen Pondere)", description: "Moyenne ponderee de tous les achats" },
    { value: "fifo", label: "FIFO (Premier Entre, Premier Sorti)", description: "Utilise le cout du plus ancien stock" },
    { value: "lifo", label: "LIFO (Dernier Entre, Premier Sorti)", description: "Utilise le cout du plus recent stock" },
  ],
  
  syncModes: [
    { value: "realtime", label: "Temps reel", description: "Sync Ã  chaque changement" },
    { value: "hourly", label: "Toutes les heures" },
    { value: "daily", label: "Une fois par jour" },
    { value: "manual", label: "Manuel uniquement" },
  ],
  
  logLevels: [
    { value: "normal", label: "Normal", description: "Evenements importants uniquement" },
    { value: "debug", label: "Debug", description: "Inclut les details techniques" },
    { value: "verbose", label: "Verbose", description: "Tout enregistrer (support)" },
  ],
};

// ============================================
// HELPERS
// ============================================

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

function settingsFile(shop) {
  const dir = shopDir(shop);
  ensureDir(dir);
  return path.join(dir, "settings.json");
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ============================================
// CRUD SETTINGS
// ============================================

/**
 * Charge les parametres d'un shop (avec valeurs par defaut)
 */
function loadSettings(shop) {
  const file = settingsFile(shop);
  let saved = {};
  
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      saved = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Erreur lecture settings:", e.message);
  }
  
  // Merger avec les defaults pour avoir toutes les cles
  const settings = deepMerge(deepClone(DEFAULT_SETTINGS), saved);
  
  // Mettre Ã  jour les metadonnees
  if (!settings._meta.createdAt) {
    settings._meta.createdAt = new Date().toISOString();
  }
  
  return settings;
}

/**
 * Sauvegarde les parametres
 */
function saveSettings(shop, settings) {
  const file = settingsFile(shop);
  
  // Mettre Ã  jour les metadonnees
  settings._meta = settings._meta || {};
  settings._meta.updatedAt = new Date().toISOString();
  settings._meta.version = DEFAULT_SETTINGS._meta.version;
  
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tmp, file);
  
  return settings;
}

/**
 * Met Ã  jour une section de parametres
 */
function updateSettings(shop, section, values) {
  const settings = loadSettings(shop);
  
  if (!settings[section]) {
    throw new Error(`Section inconnue: ${section}`);
  }
  
  settings[section] = { ...settings[section], ...values };
  return saveSettings(shop, settings);
}

/**
 * Met Ã  jour un parametre unique
 */
function setSetting(shop, path, value) {
  const settings = loadSettings(shop);
  const parts = path.split(".");
  
  let obj = settings;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]]) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  
  obj[parts[parts.length - 1]] = value;
  return saveSettings(shop, settings);
}

/**
 * Recupere un parametre unique
 */
function getSetting(shop, path, defaultValue = null) {
  const settings = loadSettings(shop);
  const parts = path.split(".");
  
  let obj = settings;
  for (const part of parts) {
    if (obj === undefined || obj === null) return defaultValue;
    obj = obj[part];
  }
  
  return obj !== undefined ? obj : defaultValue;
}

/**
 * Reset aux valeurs par defaut
 */
function resetSettings(shop, section = null) {
  if (section) {
    const settings = loadSettings(shop);
    if (DEFAULT_SETTINGS[section]) {
      settings[section] = deepClone(DEFAULT_SETTINGS[section]);
      return saveSettings(shop, settings);
    }
    throw new Error(`Section inconnue: ${section}`);
  }
  
  // Reset complet
  const settings = deepClone(DEFAULT_SETTINGS);
  settings._meta.createdAt = new Date().toISOString();
  return saveSettings(shop, settings);
}

// ============================================
// BACKUP & RESTORE
// ============================================

/**
 * Exporte la configuration complete (pour backup)
 */
function exportConfig(shop) {
  const settings = loadSettings(shop);
  
  return {
    exportedAt: new Date().toISOString(),
    version: settings._meta.version,
    shop: sanitizeShop(shop),
    settings,
  };
}

/**
 * Importe une configuration (depuis backup)
 */
function importConfig(shop, config, options = {}) {
  const { merge = false, skipValidation = false } = options;
  
  if (!skipValidation) {
    // Valider la structure
    if (!config.settings || typeof config.settings !== "object") {
      throw new Error("Configuration invalide: 'settings' manquant");
    }
  }
  
  let settings;
  if (merge) {
    // Merger avec l'existant
    const current = loadSettings(shop);
    settings = deepMerge(current, config.settings);
  } else {
    // Remplacer completement
    settings = deepMerge(deepClone(DEFAULT_SETTINGS), config.settings);
  }
  
  settings._meta.importedAt = new Date().toISOString();
  settings._meta.importedFrom = config.exportedAt || "unknown";
  
  return saveSettings(shop, settings);
}

// ============================================
// HELPERS DE FORMATAGE (utilises par l'app)
// ============================================

/**
 * Formate un poids selon les parametres
 */
function formatWeight(shop, grams, options = {}) {
  const settings = loadSettings(shop);
  const { showUnit = true, showEquivalent = null } = options;
  
  const unit = settings.units.weightUnit;
  const precision = settings.units.weightPrecision;
  const factor = SETTING_OPTIONS.weightUnits.find(u => u.value === unit)?.factor || 1;
  
  const value = grams / factor;
  const formatted = value.toFixed(precision);
  
  let result = formatted;
  if (showUnit) {
    result += unit;
  }
  
  // Afficher equivalent si active
  const doShowEquiv = showEquivalent !== null ? showEquivalent : settings.units.showEquivalent;
  if (doShowEquiv && unit !== "g" && grams >= 1000) {
    result += ` (${grams.toFixed(0)}g)`;
  }
  
  return result;
}

/**
 * Formate un montant selon les parametres
 */
function formatCurrency(shop, amount, options = {}) {
  const settings = loadSettings(shop);
  const { showSymbol = true } = options;
  
  const { symbol, position, decimalSeparator, thousandsSeparator, decimals } = settings.currency;
  
  // Formater le nombre
  const parts = amount.toFixed(decimals).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
  const formatted = parts.join(decimalSeparator);
  
  if (!showSymbol) return formatted;
  
  return position === "before" ? `${symbol}${formatted}` : `${formatted}${symbol}`;
}

/**
 * Formate une date selon les parametres
 */
function formatDate(shop, date, options = {}) {
  const settings = loadSettings(shop);
  const { includeTime = false } = options;
  
  const d = date instanceof Date ? date : new Date(date);
  const format = settings.general.dateFormat;
  const timeFormat = settings.general.timeFormat;
  
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  
  let dateStr;
  switch (format) {
    case "eu":
      dateStr = `${day}/${month}/${year}`;
      break;
    case "us":
      dateStr = `${month}/${day}/${year}`;
      break;
    default: // iso
      dateStr = `${year}-${month}-${day}`;
  }
  
  if (includeTime) {
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    
    if (timeFormat === "12h") {
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12 || 12;
      dateStr += ` ${hours}:${minutes} ${ampm}`;
    } else {
      dateStr += ` ${String(hours).padStart(2, "0")}:${minutes}`;
    }
  }
  
  return dateStr;
}

/**
 * Applique les regles d'arrondi au poids
 */
function applyWeightRounding(shop, grams) {
  const settings = loadSettings(shop);
  const { roundingRule, neverNegative, weightPrecision } = settings.units;
  
  let result = grams;
  
  // Appliquer la regle d'arrondi
  const factor = Math.pow(10, weightPrecision);
  switch (roundingRule) {
    case "floor":
      result = Math.floor(result * factor) / factor;
      break;
    case "ceil":
      result = Math.ceil(result * factor) / factor;
      break;
    default: // standard
      result = Math.round(result * factor) / factor;
  }
  
  // Ne jamais descendre sous 0
  if (neverNegative && result < 0) {
    result = 0;
  }
  
  return result;
}

/**
 * Verifie si un produit est en stock bas
 */
function isLowStock(shop, grams) {
  const settings = loadSettings(shop);
  if (!settings.stock.lowStockEnabled) return false;
  return grams <= settings.stock.lowStockThreshold;
}

/**
 * Calcule la deduction freebie pour une commande
 */
function calculateFreebieDeduction(shop, order) {
  const settings = loadSettings(shop);
  if (!settings.freebies.enabled) return 0;
  
  const { mode, deductionPerOrder, deductionPerProduct, deductionPerCategory, cartThresholds } = settings.freebies;
  
  let deduction = 0;
  
  switch (mode) {
    case "per_order":
      deduction = deductionPerOrder || 0;
      break;
      
    case "per_product":
      for (const item of order.lineItems || []) {
        const productDeduction = deductionPerProduct[item.productId] || 0;
        deduction += productDeduction * (item.quantity || 1);
      }
      break;
      
    case "per_category":
      for (const item of order.lineItems || []) {
        for (const catId of item.categoryIds || []) {
          const catDeduction = deductionPerCategory[catId] || 0;
          deduction += catDeduction * (item.quantity || 1);
        }
      }
      break;
      
    case "cart_threshold":
      const orderTotal = order.total || 0;
      // Trouver le seuil applicable (le plus eleve atteint)
      const applicableThreshold = cartThresholds
        .filter(t => orderTotal >= t.minAmount)
        .sort((a, b) => b.minAmount - a.minAmount)[0];
      if (applicableThreshold) {
        deduction = applicableThreshold.deduction || 0;
      }
      break;
  }
  
  return deduction;
}

// ============================================
// DIAGNOSTIC & SUPPORT
// ============================================

/**
 * Genere un bundle de diagnostic pour le support
 */
function generateSupportBundle(shop, options = {}) {
  const settings = loadSettings(shop);
  const { includeSettings = true, includeLogs = true } = options;
  
  const bundle = {
    generatedAt: new Date().toISOString(),
    shop: sanitizeShop(shop),
    appVersion: process.env.APP_VERSION || "unknown",
    nodeVersion: process.version,
    
    // Infos systeme
    system: {
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    },
    
    // Etat des webhooks (Ã  implementer avec les vrais statuts)
    webhooks: {
      ordersCreate: { status: "unknown", lastReceived: null },
      ordersUpdate: { status: "unknown", lastReceived: null },
    },
    
    // Derniere erreur
    lastError: null,
    
    // Statistiques
    stats: {
      dataDir: DATA_DIR,
      settingsFile: settingsFile(shop),
      settingsExists: fs.existsSync(settingsFile(shop)),
    },
  };
  
  if (includeSettings) {
    // Masquer les donnees sensibles
    const safeSettings = deepClone(settings);
    if (safeSettings.security?.pin) safeSettings.security.pin = "***";
    if (safeSettings.notifications?.channels?.slack?.webhookUrl) {
      safeSettings.notifications.channels.slack.webhookUrl = "***";
    }
    if (safeSettings.notifications?.channels?.discord?.webhookUrl) {
      safeSettings.notifications.channels.discord.webhookUrl = "***";
    }
    bundle.settings = safeSettings;
  }
  
  return bundle;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Constantes
  DEFAULT_SETTINGS,
  SETTING_OPTIONS,
  
  // CRUD
  loadSettings,
  saveSettings,
  updateSettings,
  setSetting,
  getSetting,
  resetSettings,
  
  // Backup/Restore
  exportConfig,
  importConfig,
  
  // Helpers de formatage
  formatWeight,
  formatCurrency,
  formatDate,
  applyWeightRounding,
  isLowStock,
  calculateFreebieDeduction,
  
  // Support
  generateSupportBundle,
  
  // Utils
  sanitizeShop,
};

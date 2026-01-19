// settingsStore.js - Multi-shop settings complet
// Gestion de tous les parametres utilisateur (langue, devise, theme, notifications, etc.)

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// VALEURS PAR DEFAUT
// ============================================

const DEFAULT_SETTINGS = {
  // General
  shopName: "",
  locationId: null,
  
  // Langue & Region
  language: "fr",
  timezone: "Europe/Paris",
  dateFormat: "DD/MM/YYYY",
  timeFormat: "24h",
  
  // Devise & Unites
  currency: "EUR",
  currencyPosition: "after",
  weightUnit: "g",
  quantityUnit: "units",
  decimalSeparator: ",",
  thousandSeparator: " ",
  
  // Affichage & UX
  theme: "dark",
  density: "comfort",
  defaultSort: "alpha",
  defaultPageSize: 25,
  showStockValue: true,
  showCMP: true,
  showRotation: false,
  
  // Notifications & Alertes
  notifications: {
    enabled: true,
    lowStockAlert: true,
    lowStockThreshold: 50,
    ruptureAlert: true,
    bigSaleAlert: false,
    marginAlert: false,
    marginAlertThreshold: 10,
    channels: {
      inApp: true,
      email: false,
      webhook: false,
    },
    webhookUrl: "",
  },
  
  // Canaux de notification externes (Discord, Slack, Telegram, Ntfy)
  notificationChannels: {
    discord: {
      enabled: false,
      webhookUrl: "",
      updatedAt: null
    },
    slack: {
      enabled: false,
      webhookUrl: "",
      updatedAt: null
    },
    telegram: {
      enabled: false,
      botToken: "",
      chatId: "",
      updatedAt: null
    },
    ntfy: {
      enabled: false,
      topic: "",
      server: "https://ntfy.sh",
      updatedAt: null
    }
  },
  
  // Avance (PRO/BUSINESS)
  advanced: {
    valuationMethod: "cmp",
    lockCMP: false,
    roundingPrecision: 1,
    allowNegativeStock: false,
    freebiePerOrder: 0,
    autoSyncShopify: true,
    syncInterval: 15,
  },
  
  // Meta
  createdAt: null,
  updatedAt: null,
};

// Langues supportees
const SUPPORTED_LANGUAGES = [
  { code: "fr", name: "Francais", flag: "FR" },
  { code: "en", name: "English", flag: "GB" },
  { code: "es", name: "Espanol", flag: "ES" },
  { code: "de", name: "Deutsch", flag: "DE" },
  { code: "it", name: "Italiano", flag: "IT" },
];

// Devises supportees
const SUPPORTED_CURRENCIES = [
  { code: "EUR", symbol: "E", name: "Euro" },
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "GBP", symbol: "L", name: "British Pound" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
];

// Unites de poids
const WEIGHT_UNITS = [
  { code: "g", name: "Grammes", factor: 1 },
  { code: "kg", name: "Kilogrammes", factor: 1000 },
  { code: "lb", name: "Livres", factor: 453.592 },
  { code: "oz", name: "Onces", factor: 28.3495 },
];

// Fuseaux horaires courants
const COMMON_TIMEZONES = [
  "Europe/Paris",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Zurich",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "America/Toronto",
  "America/Montreal",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
];

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

function filePath(shop) {
  const dir = shopDir(shop);
  ensureDir(dir);
  return path.join(dir, "settings.json");
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

// ============================================
// CRUD SETTINGS
// ============================================

function loadSettings(shop) {
  try {
    const file = filePath(shop);
    if (!fs.existsSync(file)) {
      return { ...DEFAULT_SETTINGS, createdAt: new Date().toISOString() };
    }
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_SETTINGS, parsed || {});
  } catch (e) {
    console.warn("Erreur lecture settings:", e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(shop, settings = {}) {
  const file = filePath(shop);
  const tmp = file + ".tmp";
  const current = loadSettings(shop);
  const merged = deepMerge(current, settings);
  merged.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return merged;
}

function updateSettings(shop, updates = {}) {
  return saveSettings(shop, updates);
}

function resetSettings(shop) {
  const file = filePath(shop);
  const defaults = { ...DEFAULT_SETTINGS, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(defaults, null, 2), "utf8");
  return defaults;
}

function removeSettings(shop) {
  const file = filePath(shop);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log("Settings supprimes pour le shop:", shop);
  }
}

// ============================================
// GETTERS SPECIFIQUES
// ============================================

function getSetting(shop, key, defaultValue = null) {
  const settings = loadSettings(shop);
  const keys = key.split(".");
  let value = settings;
  for (const k of keys) {
    if (value && typeof value === "object" && k in value) {
      value = value[k];
    } else {
      return defaultValue;
    }
  }
  return value !== undefined ? value : defaultValue;
}

function setSetting(shop, key, value) {
  const keys = key.split(".");
  const settings = loadSettings(shop);
  let obj = settings;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== "object") {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  return saveSettings(shop, settings);
}

function setLocationId(shop, locationId) {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("locationId invalide");
  return setSetting(shop, "locationId", id);
}

function getLanguage(shop) {
  return getSetting(shop, "language", "fr");
}

function setLanguage(shop, lang) {
  if (!SUPPORTED_LANGUAGES.find(l => l.code === lang)) {
    throw new Error("Langue non supportee: " + lang);
  }
  return setSetting(shop, "language", lang);
}

function getCurrency(shop) {
  return getSetting(shop, "currency", "EUR");
}

function setCurrency(shop, currency) {
  if (!SUPPORTED_CURRENCIES.find(c => c.code === currency)) {
    throw new Error("Devise non supportee: " + currency);
  }
  return setSetting(shop, "currency", currency);
}

function getTimezone(shop) {
  return getSetting(shop, "timezone", "Europe/Paris");
}

function setTimezone(shop, tz) {
  return setSetting(shop, "timezone", tz);
}

function getTheme(shop) {
  return getSetting(shop, "theme", "dark");
}

function setTheme(shop, theme) {
  if (!["dark", "light", "auto"].includes(theme)) {
    throw new Error("Theme non supporte: " + theme);
  }
  return setSetting(shop, "theme", theme);
}

function getNotificationSettings(shop) {
  return getSetting(shop, "notifications", DEFAULT_SETTINGS.notifications);
}

function updateNotificationSettings(shop, notifSettings) {
  const current = getNotificationSettings(shop);
  const merged = deepMerge(current, notifSettings);
  return setSetting(shop, "notifications", merged);
}

// ============================================
// NOTIFICATION CHANNELS (External: Discord, Slack, Telegram, Ntfy)
// ============================================

function getNotificationChannels(shop) {
  return getSetting(shop, "notificationChannels", DEFAULT_SETTINGS.notificationChannels);
}

function updateNotificationChannel(shop, channelId, config) {
  const channels = getNotificationChannels(shop);
  channels[channelId] = {
    ...channels[channelId],
    ...config,
    updatedAt: new Date().toISOString()
  };
  return setSetting(shop, "notificationChannels", channels);
}

function removeNotificationChannel(shop, channelId) {
  const channels = getNotificationChannels(shop);
  if (channels[channelId]) {
    channels[channelId] = {
      enabled: false,
      updatedAt: new Date().toISOString()
    };
    // Réinitialiser selon le type
    if (channelId === "discord" || channelId === "slack") {
      channels[channelId].webhookUrl = "";
    } else if (channelId === "telegram") {
      channels[channelId].botToken = "";
      channels[channelId].chatId = "";
    } else if (channelId === "ntfy") {
      channels[channelId].topic = "";
      channels[channelId].server = "https://ntfy.sh";
    }
  }
  return setSetting(shop, "notificationChannels", channels);
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  DEFAULT_SETTINGS,
  SUPPORTED_LANGUAGES,
  SUPPORTED_CURRENCIES,
  WEIGHT_UNITS,
  COMMON_TIMEZONES,
  
  sanitizeShop,
  shopDir,
  
  loadSettings,
  saveSettings,
  updateSettings,
  resetSettings,
  removeSettings,
  
  getSetting,
  setSetting,
  setLocationId,
  getLanguage,
  setLanguage,
  getCurrency,
  setCurrency,
  getTimezone,
  setTimezone,
  getTheme,
  setTheme,
  getNotificationSettings,
  updateNotificationSettings,
  
  // Notification Channels (External)
  getNotificationChannels,
  updateNotificationChannel,
  removeNotificationChannel,
};
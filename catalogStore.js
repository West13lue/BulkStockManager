// catalogStore.js
// ============================================
// Catégories (multi-boutique)
// - Persist per-shop on Render Disk:
//     /var/data/shops/<shop>/categories.json
// ============================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { logEvent } = require("./utils/logger");
const { sanitizeShop, shopDir } = require("./stockState");

function fileForShop(shop) {
  return path.join(shopDir(shop), "categories.json");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load(shop) {
  const file = fileForShop(shop);
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logEvent("categories_load_error", { shop: sanitizeShop(shop), message: e.message }, "error");
    return [];
  }
}

function save(shop, categories) {
  const file = fileForShop(shop);
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(categories, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const cache = new Map();

function getShopCategories(shop) {
  const key = sanitizeShop(shop);
  if (!cache.has(key)) cache.set(key, load(key));
  return cache.get(key);
}

function listCategories(shop = "default") {
  return getShopCategories(shop).slice();
}

function createCategory(shop = "default", name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom de catégorie invalide");

  const categories = getShopCategories(shop);
  if (categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
    throw new Error("Catégorie déjà existante");
  }

  const cat = { id: crypto.randomUUID(), name: n, createdAt: new Date().toISOString() };
  categories.push(cat);
  save(shop, categories);

  logEvent("category_created", { shop: sanitizeShop(shop), id: cat.id, name: cat.name });
  return cat;
}

function renameCategory(shop = "default", id, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom invalide");

  const categories = getShopCategories(shop);
  const cat = categories.find((c) => c.id === id);
  if (!cat) throw new Error("Catégorie introuvable");

  cat.name = n;
  save(shop, categories);
  return cat;
}

function deleteCategory(shop = "default", id) {
  const categories = getShopCategories(shop);
  const before = categories.length;
  const next = categories.filter((c) => c.id !== id);
  if (next.length === before) throw new Error("Catégorie introuvable");
  cache.set(sanitizeShop(shop), next);
  save(shop, next);
}

module.exports = { listCategories, createCategory, renameCategory, deleteCategory };
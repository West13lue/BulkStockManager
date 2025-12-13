// catalogStore.js
// ============================================
// Catégories (multi-boutique)
// Persist par shop:
//   /var/data/shops/<shop>/categories.json
// ============================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { logEvent } = require("./utils/logger");
const { sanitizeShop, shopDir } = require("./stockState");

function categoriesFile(shop) {
  return path.join(shopDir(shop), "categories.json");
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load(shop = "default") {
  const file = categoriesFile(shop);
  try {
    ensureDirSync(path.dirname(file));
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logEvent("categories_load_error", { shop: sanitizeShop(shop), file, message: e.message }, "error");
    return [];
  }
}

function save(shop, categories) {
  const file = categoriesFile(shop);
  ensureDirSync(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(categories || [], null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const cache = new Map();

function get(shop = "default") {
  const key = sanitizeShop(shop);
  if (!cache.has(key)) cache.set(key, load(key));
  return cache.get(key);
}

function listCategories(shop = "default") {
  return get(shop).slice();
}

function createCategory(shop = "default", name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom de catégorie invalide");

  const categories = get(shop);

  if (categories.some((c) => String(c.name).toLowerCase() === n.toLowerCase())) {
    throw new Error("Catégorie déjà existante");
  }

  const cat = {
    id: crypto.randomUUID(),
    name: n,
    createdAt: new Date().toISOString(),
  };

  categories.push(cat);
  save(shop, categories);

  logEvent("category_created", { shop: sanitizeShop(shop), id: cat.id, name: cat.name });
  return cat;
}

function renameCategory(shop = "default", id, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom invalide");

  const categories = get(shop);
  const cat = categories.find((c) => c.id === id);
  if (!cat) throw new Error("Catégorie introuvable");

  cat.name = n;
  save(shop, categories);

  logEvent("category_renamed", { shop: sanitizeShop(shop), id, name: n });
  return cat;
}

function deleteCategory(shop = "default", id) {
  const categories = get(shop);
  const next = categories.filter((c) => c.id !== id);

  if (next.length === categories.length) throw new Error("Catégorie introuvable");

  cache.set(sanitizeShop(shop), next);
  save(shop, next);

  logEvent("category_deleted", { shop: sanitizeShop(shop), id });
}

module.exports = {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
};
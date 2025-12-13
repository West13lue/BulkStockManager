// catalogStore.js — Multi-shop safe (Render disk /var/data)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { logEvent } = require("./utils/logger");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

function sanitizeShop(shop) {
  // shop attendu: "xxx.myshopify.com"
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
  return path.join(dir, "categories.json");
}

function load(shop) {
  try {
    const file = filePath(shop);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logEvent("categories_load_error", { message: e.message }, "error");
    return [];
  }
}

function save(shop, categories) {
  const file = filePath(shop);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(categories, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// Cache par shop (évite relire disque à chaque request)
const cache = new Map(); // shopKey -> categories[]

function getShopCategories(shop) {
  const key = sanitizeShop(shop);
  if (!cache.has(key)) cache.set(key, load(shop));
  return cache.get(key);
}

function listCategories(shop) {
  return getShopCategories(shop).slice();
}

function createCategory(shop, name) {
  // compat: si appelé (name) sans shop
  if (name === undefined) {
    name = shop;
    shop = "default";
  }

  const categories = getShopCategories(shop);
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom de catégorie invalide");

  if (categories.some((c) => String(c.name).toLowerCase() === n.toLowerCase())) {
    throw new Error("Catégorie déjà existante");
  }

  const cat = { id: crypto.randomUUID(), name: n, createdAt: new Date().toISOString() };
  categories.push(cat);
  save(shop, categories);

  logEvent("category_created", { shop: sanitizeShop(shop), id: cat.id, name: cat.name });
  return cat;
}

function renameCategory(shop, id, name) {
  // compat: si appelé (id, name) sans shop
  if (name === undefined) {
    name = id;
    id = shop;
    shop = "default";
  }

  const categories = getShopCategories(shop);
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom invalide");

  const cat = categories.find((c) => c.id === id);
  if (!cat) throw new Error("Catégorie introuvable");

  cat.name = n;
  save(shop, categories);
  return cat;
}

function deleteCategory(shop, id) {
  // compat: si appelé (id) sans shop
  if (id === undefined) {
    id = shop;
    shop = "default";
  }

  let categories = getShopCategories(shop);
  const before = categories.length;
  categories = categories.filter((c) => c.id !== id);

  if (categories.length === before) throw new Error("Catégorie introuvable");

  cache.set(sanitizeShop(shop), categories);
  save(shop, categories);
}

module.exports = {
  sanitizeShop,
  shopDir,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
};

// catalogStore.js
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { logEvent } = require("./utils/logger");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const FILE = path.join(DATA_DIR, "categories.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logEvent("categories_load_error", { message: e.message }, "error");
    return [];
  }
}

function save(categories) {
  ensureDir();
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(categories, null, 2), "utf8");
  fs.renameSync(tmp, FILE);
}

let categories = load();

function listCategories() {
  return categories.slice();
}

function createCategory(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom de catégorie invalide");

  if (categories.some(c => c.name.toLowerCase() === n.toLowerCase())) {
    throw new Error("Catégorie déjà existante");
  }

  const cat = {
    id: crypto.randomUUID(),
    name: n,
    createdAt: new Date().toISOString(),
  };

  categories.push(cat);
  save(categories);

  logEvent("category_created", { id: cat.id, name: cat.name });
  return cat;
}

function renameCategory(id, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Nom invalide");

  const cat = categories.find(c => c.id === id);
  if (!cat) throw new Error("Catégorie introuvable");

  cat.name = n;
  save(categories);
  return cat;
}

function deleteCategory(id) {
  const before = categories.length;
  categories = categories.filter(c => c.id !== id);
  if (categories.length === before) throw new Error("Catégorie introuvable");
  save(categories);
}

module.exports = {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
};

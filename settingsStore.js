// settingsStore.js — Multi-shop settings sur Render Disk (/var/data/<shop>/settings.json)
const fs = require("fs");
const path = require("path");

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

function filePath(shop) {
  const dir = shopDir(shop);
  ensureDir(dir);
  return path.join(dir, "settings.json");
}

function loadSettings(shop) {
  try {
    const file = filePath(shop);
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSettings(shop, settings = {}) {
  const file = filePath(shop);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return settings;
}

function setLocationId(shop, locationId) {
  const s = sanitizeShop(shop);
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("locationId invalide");
  const cur = loadSettings(s);
  cur.locationId = id;
  cur.updatedAt = new Date().toISOString();
  saveSettings(s, cur);
  return cur;
}

module.exports = { sanitizeShop, shopDir, loadSettings, saveSettings, setLocationId };

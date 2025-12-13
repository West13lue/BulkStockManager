// stockState.js — Render Disk /var/data — Multi-shop safe
// Stock state persistant par boutique:
// /var/data/<shop>/stock.json

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
 * loadState(shop) -> Object
 */
function loadState(shop = "default") {
  const file = stateFile(shop);
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  return safeJsonParse(raw, {});
}

/**
 * saveState(shop, data) -> void
 * Écriture atomique via .tmp + rename
 */
function saveState(shop = "default", data = {}) {
  const file = stateFile(shop);
  const tmp = file + ".tmp";
  const payload = JSON.stringify(data ?? {}, null, 2);

  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, file);
}

module.exports = {
  sanitizeShop,
  shopDir,
  loadState,
  saveState,
};

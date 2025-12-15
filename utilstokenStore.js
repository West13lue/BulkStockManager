// utils/tokenStore.js — stocke le token OAuth par shop sur Render Disk
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

function tokenFile(shop) {
  const dir = shopDir(shop);
  ensureDir(dir);
  return path.join(dir, "token.json");
}

function loadToken(shop) {
  try {
    const file = tokenFile(shop);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const token = String(parsed?.accessToken || "").trim();
    return token || null;
  } catch {
    return null;
  }
}

function saveToken(shop, accessToken, extra = {}) {
  const file = tokenFile(shop);
  const tmp = file + ".tmp";

  const payload = {
    shop: sanitizeShop(shop),
    accessToken: String(accessToken || "").trim(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };

  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return payload;
}

module.exports = { sanitizeShop, shopDir, loadToken, saveToken };

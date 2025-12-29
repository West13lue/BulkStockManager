// movementStore.js aEUR Multi-shop safe (NDJSON/day) sur /var/data/<shop>/movements
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

function movementsDir(shop) {
  return path.join(shopDir(shop), "movements");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function fileForDate(shop, date) {
  const day = date.toISOString().slice(0, 10);
  return path.join(movementsDir(shop), `${day}.ndjson`);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function addMovement(movement = {}, shop = movement.shop) {
  const s = shop || "default";
  ensureDir(movementsDir(s));

  const m = {
    id: movement.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts: movement.ts || new Date().toISOString(),
    ...movement,
    shop: sanitizeShop(s),
  };

  const file = fileForDate(s, new Date());
  fs.appendFileSync(file, JSON.stringify(m) + "\n", "utf8");
  return m;
}

function listMovements({ shop = "default", days = 7, limit = 2000 } = {}) {
  const s = shop || "default";
  ensureDir(movementsDir(s));

  const now = new Date();
  const out = [];

  const max = Math.max(1, Math.min(Number(limit) || 2000, 10000));
  const maxDays = Math.max(1, Math.min(Number(days) || 7, 365));

  for (let i = 0; i < maxDays; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);

    const file = fileForDate(s, d);
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, "utf8");
    if (!content) continue;

    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      const obj = safeJsonParse(line);
      if (obj) out.push(obj);
    }

    if (out.length >= max * 3) break;
  }

  out.sort((a, b) => Date.parse(b?.ts || "") - Date.parse(a?.ts || ""));
  return out.slice(0, max);
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV(rows = []) {
  const cols = [
    "ts",
    "source",
    "productId",
    "productName",
    "gramsDelta",
    "gramsBefore",
    "totalAfter",
    "userId",
    "userName",
    "shop",
  ];
  const header = cols.join(",");
  const lines = rows.map((r) => cols.map((c) => csvEscape(r?.[c])).join(","));
  return [header, ...lines].join("\n");
}

// Ajout de la fonction pour supprimer les mouvements daEURun shop
function clearShopMovements(shop) {
  const dir = movementsDir(shop);
  if (fs.existsSync(dir)) {
    fs.rmdirSync(dir, { recursive: true });
    console.log(`Mouvements supprims pour le shop: ${shop}`);
  }
}

module.exports = { sanitizeShop, shopDir, addMovement, listMovements, toCSV, clearShopMovements };


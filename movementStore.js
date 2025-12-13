// movementStore.js
// ============================================
// Persist movements to Render Disk (NDJSON/day)
// - BASE_DIR: /var/data/movements (default)
// - addMovement: append 1 JSON per line
// - listMovements: read last N days, return newest first
// - purgeOld: delete files older than N days
// - toCSV: export rows to CSV
// ============================================

const fs = require("fs");
const path = require("path");

const BASE_DIR = process.env.MOVEMENTS_DIR || "/var/data/movements";

function ensureDir() {
  if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
}

function fileForDate(date) {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(BASE_DIR, `${day}.ndjson`);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function addMovement(movement = {}) {
  ensureDir();

  const m = {
    id: movement.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts: movement.ts || new Date().toISOString(), // ✅ date/heure
    ...movement,
  };

  const file = fileForDate(new Date());
  fs.appendFileSync(file, JSON.stringify(m) + "\n", "utf8");
  return m;
}

// Retourne les mouvements (newest first)
// Options:
// - days: nombre de jours à remonter
// - limit: max items retournés
function listMovements({ days = 7, limit = 2000 } = {}) {
  ensureDir();

  const now = new Date();
  const out = [];
  const max = Math.max(1, Math.min(Number(limit) || 2000, 10000));
  const maxDays = Math.max(1, Math.min(Number(days) || 7, 365));

  for (let i = 0; i < maxDays; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);

    const file = fileForDate(d);
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, "utf8");
    if (!content) continue;

    const lines = content.split("\n").filter(Boolean);
    for (const l of lines) {
      const obj = safeJsonParse(l);
      if (obj) out.push(obj);
    }

    // on peut arrêter tôt si on a déjà beaucoup de données
    if (out.length >= max * 2) break;
  }

  // ✅ tri par ts DESC => dernier en haut
  out.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));

  return out.slice(0, max);
}

function purgeOld(daysToKeep = 14) {
  ensureDir();

  const keep = Math.max(1, Math.min(Number(daysToKeep) || 14, 3650));
  const files = fs.readdirSync(BASE_DIR);

  const limit = new Date();
  limit.setDate(limit.getDate() - keep);

  for (const f of files) {
    if (!f.endsWith(".ndjson")) continue;
    const dateStr = f.replace(".ndjson", "");
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) continue;
    if (d < limit) fs.unlinkSync(path.join(BASE_DIR, f));
  }
}

// -------- CSV helpers --------
function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Supporte tes anciennes colonnes + tes nouvelles (gramsDelta / totalAfter)
function toCSV(rows = []) {
  const cols = [
    "ts",
    "type",
    "source",
    "orderId",
    "orderName",
    "productId",
    "productName",
    "deltaGrams",
    "gramsDelta",     // ✅ au cas où tu utilises gramsDelta ailleurs
    "gramsBefore",
    "gramsAfter",
    "totalAfter",     // ✅ au cas où tu utilises totalAfter ailleurs
    "variantTitle",
    "lineTitle",
    "requestId",
  ];

  const header = cols.join(",");
  const lines = rows.map((r) => cols.map((c) => csvEscape(r?.[c])).join(","));
  return [header, ...lines].join("\n");
}

module.exports = { addMovement, listMovements, purgeOld, toCSV };

// movementStore.js
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

function addMovement(movement) {
  const m = {
    id: movement.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts: movement.ts || new Date().toISOString(), // ✅ date/heure
    ...movement,
  };

  // push + persist comme tu fais déjà
  movements.unshift(m); // ✅ dernier en haut (optionnel mais recommandé)
  saveMovements();
  return m;
}

  ensureDir();
  const file = fileForDate(new Date());
  fs.appendFileSync(file, JSON.stringify(movement) + "\n", "utf8");
}

function listMovements({ days = 7 } = {}) {
  ensureDir();
  const now = new Date();
  const out = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const file = fileForDate(d);

    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, "utf8").trim();
    if (!content) continue;

    const lines = content.split("\n");
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
  }

  return out;
}

function purgeOld(daysToKeep) {
  ensureDir();
  const files = fs.readdirSync(BASE_DIR);

  const limit = new Date();
  limit.setDate(limit.getDate() - daysToKeep);

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

function toCSV(rows) {
  const cols = [
    "ts",
    "type",
    "source",
    "orderId",
    "orderName",
    "productId",
    "productName",
    "deltaGrams",
    "gramsBefore",
    "gramsAfter",
    "variantTitle",
    "lineTitle",
    "requestId",
  ];

  const header = cols.join(",");
  const lines = rows.map((r) => cols.map((c) => csvEscape(r?.[c])).join(","));
  return [header, ...lines].join("\n");
}

module.exports = { addMovement, listMovements, purgeOld, toCSV };

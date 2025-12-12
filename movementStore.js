const fs = require("fs");
const path = require("path");

const BASE_DIR = process.env.MOVEMENTS_DIR || "/var/data/movements";

function ensureDir() {
  if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  }
}

function todayFile() {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(BASE_DIR, `${day}.ndjson`);
}

function addMovement(movement) {
  ensureDir();
  const file = todayFile();
  const line = JSON.stringify(movement) + "\n";
  fs.appendFileSync(file, line, "utf8");
}

function listMovements({ days = 7 } = {}) {
  ensureDir();
  const now = new Date();
  const out = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const file = path.join(BASE_DIR, d.toISOString().slice(0, 10) + ".ndjson");

    if (!fs.existsSync(file)) continue;

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
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
    const dateStr = f.replace(".ndjson", "");
    const d = new Date(dateStr);
    if (d < limit) {
      fs.unlinkSync(path.join(BASE_DIR, f));
    }
  }
}

module.exports = {
  addMovement,
  listMovements,
  purgeOld,
};

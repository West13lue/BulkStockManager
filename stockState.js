// stockState.js
// ============================================
// Stock persistence (Render Persistent Disk)
// - DATA_DIR default: /var/data
// - Per-shop files (multi-boutique):
//     /var/data/shops/<shop>/stock-state.json
// - loadState(shop): SYNC (boot safe)
// - saveState(shop,state): ASYNC + atomic write
// ============================================

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// ✅ logger dans /utils/logger.js
const { logEvent } = require("./utils/logger");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const SHOPS_DIR = path.join(DATA_DIR, "shops");

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s.replace(/[^a-z0-9._-]/g, "_") || "default";
}

function shopDir(shop) {
  return path.join(SHOPS_DIR, sanitizeShop(shop));
}

function stateFile(shop) {
  return path.join(shopDir(shop), "stock-state.json");
}

function ensureDirSync(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logEvent("stock_state_ensure_dir_error", { dir, message: e.message }, "error");
  }
}

async function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    logEvent("stock_state_ensure_dir_error", { dir, message: e.message }, "error");
  }
}

function safeParseJSON(raw) {
  try {
    if (!raw || !String(raw).trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadState(shop = "default") {
  const file = stateFile(shop);
  try {
    ensureDirSync(path.dirname(file));

    if (!fs.existsSync(file)) {
      logEvent("stock_state_missing", { shop: sanitizeShop(shop), file });
      return {};
    }

    const raw = fs.readFileSync(file, "utf8");
    const parsed = safeParseJSON(raw);

    logEvent("stock_state_loaded", {
      shop: sanitizeShop(shop),
      file,
      products: parsed?.products ? Object.keys(parsed.products).length : Object.keys(parsed || {}).length,
    });

    return parsed;
  } catch (e) {
    logEvent("stock_state_load_error", { shop: sanitizeShop(shop), file, message: e.message }, "error");
    return {};
  }
}

async function saveState(shop = "default", state = {}) {
  const file = stateFile(shop);
  try {
    await ensureDir(path.dirname(file));

    const tmpFile = file + ".tmp";
    const payload = JSON.stringify(state || {}, null, 2);

    await fsp.writeFile(tmpFile, payload, "utf8");
    await fsp.rename(tmpFile, file);

    logEvent("stock_state_saved", {
      shop: sanitizeShop(shop),
      file,
      size: payload.length,
    });

    return true;
  } catch (e) {
    logEvent("stock_state_save_error", { shop: sanitizeShop(shop), file, message: e.message }, "error");
    return false;
  }
}

module.exports = {
  loadState,
  saveState,
  sanitizeShop,
  shopDir,
  stateFile,
  DATA_DIR,
  SHOPS_DIR,
};

// stockState.js
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { logEvent } = require("./utils/logger");

const STATE_FILE = process.env.STOCK_STATE_FILE || path.join(__dirname, "stockState.json");

// ✅ CORRIGÉ: Async pour ne pas bloquer l'event loop
async function loadState() {
  try {
    if (!fsSync.existsSync(STATE_FILE)) return {};
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    logEvent("stock_state_load_error", { message: e.message }, "error");
    return {};
  }
}

// ✅ CORRIGÉ: Async + atomic write
async function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    const tmp = STATE_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, STATE_FILE);

    logEvent("stock_state_saved", { products: Object.keys(state).length });
  } catch (e) {
    logEvent("stock_state_save_error", { message: e.message }, "error");
  }
}

// Version sync pour l'initialisation
function loadStateSync() {
  try {
    if (!fsSync.existsSync(STATE_FILE)) return {};
    const raw = fsSync.readFileSync(STATE_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    logEvent("stock_state_load_error", { message: e.message }, "error");
    return {};
  }
}

module.exports = { loadState: loadStateSync, saveState, STATE_FILE };
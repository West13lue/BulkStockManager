// stockState.js
const fs = require("fs");
const path = require("path");

const STATE_FILE = process.env.STOCK_STATE_FILE || path.join(__dirname, "stockState.json");

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "stock_state_load_error", message: e.message }));
    return {};
  }
}

function saveState(state) {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "stock_state_save_error", message: e.message }));
  }
}

module.exports = { loadState, saveState, STATE_FILE };

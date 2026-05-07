// productOverridesStore.js — Overrides par produit (per-shop)
// Fichier : /var/data/<shop>/product-overrides.json
//
// Schema:
// {
//   "<productId>": {
//     gramsPerUnit?: number,   // Force ce poids par unite (court-circuite parseGramsFromVariant)
//     trackByUnit?: boolean,   // Suivi a l'unite : exclu du master totalGrams (accessoires)
//     updatedAt: string
//   }
// }
//
// Usage : pour les produits dont le titre de variante n'expose pas de poids
// (joints pre-roules, packs, accessoires) et que parseGramsFromVariant ne
// peut pas resoudre. Ecriture atomique .tmp + rename, meme pattern que les
// autres stores.

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
  return path.join(dir, "product-overrides.json");
}

function loadAll(shop) {
  try {
    const file = filePath(shop);
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("[overrides] read error:", e.message);
    return {};
  }
}

function saveAll(shop, data) {
  const file = filePath(shop);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function getOverride(shop, productId) {
  if (!productId) return null;
  const all = loadAll(shop);
  return all[String(productId)] || null;
}

function setOverride(shop, productId, patch = {}) {
  const pid = String(productId || "").trim();
  if (!pid) throw new Error("productId requis");

  const all = loadAll(shop);
  const current = all[pid] || {};
  const next = { ...current };

  if (patch.gramsPerUnit === null || patch.gramsPerUnit === "") {
    delete next.gramsPerUnit;
  } else if (patch.gramsPerUnit !== undefined) {
    const g = Number(patch.gramsPerUnit);
    if (!Number.isFinite(g) || g < 0) throw new Error("gramsPerUnit invalide");
    if (g === 0) delete next.gramsPerUnit;
    else next.gramsPerUnit = g;
  }

  if (patch.trackByUnit !== undefined) {
    if (patch.trackByUnit === false || patch.trackByUnit === null) {
      delete next.trackByUnit;
    } else {
      next.trackByUnit = Boolean(patch.trackByUnit);
    }
  }

  next.updatedAt = new Date().toISOString();

  if (Object.keys(next).filter((k) => k !== "updatedAt").length === 0) {
    delete all[pid];
  } else {
    all[pid] = next;
  }

  saveAll(shop, all);
  return all[pid] || null;
}

function removeOverride(shop, productId) {
  const pid = String(productId || "").trim();
  if (!pid) return false;
  const all = loadAll(shop);
  if (!all[pid]) return false;
  delete all[pid];
  saveAll(shop, all);
  return true;
}

function listOverrides(shop) {
  return loadAll(shop);
}

function clearShopOverrides(shop) {
  const file = filePath(shop);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  getOverride,
  setOverride,
  removeOverride,
  listOverrides,
  clearShopOverrides,
  sanitizeShop,
};

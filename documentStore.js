// documentStore.js - pieces justificatives par boutique (factures fournisseur en PDF).
//
// Stockage : ${DATA_DIR}/<shop_sanitise>/documents/<docId>.pdf  +  index ${DATA_DIR}/<shop_sanitise>/documents.json
// Ecritures atomiques (.tmp + rename), comme les autres stores.
//
// Donnees personnelles : un PDF de facture contient adresses / telephones. Ce module :
//   - ne logue JAMAIS le contenu (ni le nom de fichier) ; il n'a d'ailleurs aucun logger ;
//   - n'expose rien par lui-meme : l'acces HTTP est gere par les routes (JWT /api, cle agent) ;
//   - n'accepte que du PDF (octets magiques "%PDF-"), 10 Mo max, dedup par sha256.
// Aucune valeur specifique a une boutique ou a un fournisseur n'est codee ici.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DOC_KINDS = ["invoice"];
const DOC_ID_RE = /^doc_[a-z0-9]{6,40}$/;

class DocumentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function dataDir() {
  return process.env.DATA_DIR || "/var/data";
}

// Meme logique que les autres stores.
function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s ? s.replace(/[^a-z0-9._-]/g, "_") : "default";
}

function shopRoot(shop) {
  return path.join(dataDir(), sanitizeShop(shop));
}
function docsDir(shop) {
  return path.join(shopRoot(shop), "documents");
}
function indexFile(shop) {
  return path.join(shopRoot(shop), "documents.json");
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadIndex(shop) {
  const file = indexFile(shop);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && Array.isArray(parsed.documents)) return parsed.documents.filter((d) => d && d.id);
    }
  } catch {
    // Index illisible : copie de sauvegarde, jamais d'ecrasement silencieux.
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
  }
  return [];
}

function saveIndex(shop, documents) {
  atomicWrite(indexFile(shop), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), documents }, null, 2));
}

// ---------------------------------------------------------------
// Validation du contenu
// ---------------------------------------------------------------

// Nom de fichier affichable / utilisable dans Content-Disposition : pas de chemin, pas de caracteres de controle
// ni de guillemets, longueur bornee, extension .pdf.
function sanitizeFilename(name) {
  let s = String(name == null ? "" : name);
  s = s.split(/[\\/]/).pop() || "";
  s = s.replace(/[\u0000-\u001f\u007f"<>:*?|;]/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, "");
  if (s.length > 120) s = s.slice(0, 120);
  if (!/\.pdf$/i.test(s)) s = `${s.replace(/\.+$/, "") || "document"}.pdf`;
  return s;
}

// Decode un PDF en base64 (prefixe data: tolere) et verifie taille + octets magiques.
function decodePdfBase64(contentBase64) {
  if (typeof contentBase64 !== "string" || !contentBase64) {
    throw new DocumentError(400, "invalid_pdf", "contentBase64 manquant (PDF en base64 attendu)");
  }
  let b64 = contentBase64.trim();
  const m = /^data:application\/pdf;base64,/i.exec(b64);
  if (m) b64 = b64.slice(m[0].length);
  b64 = b64.replace(/[\r\n\s]/g, "");
  // Borne avant decodage : evite d'allouer un buffer enorme pour rien.
  if (Math.floor((b64.length * 3) / 4) > MAX_PDF_BYTES + 3) {
    throw new DocumentError(413, "pdf_too_large", `PDF trop volumineux (max ${MAX_PDF_BYTES / (1024 * 1024)} Mo)`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new DocumentError(400, "invalid_pdf", "Contenu base64 invalide");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length > MAX_PDF_BYTES) {
    throw new DocumentError(413, "pdf_too_large", `PDF trop volumineux (max ${MAX_PDF_BYTES / (1024 * 1024)} Mo)`);
  }
  if (buf.length < 8 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new DocumentError(400, "invalid_pdf", "Le fichier n'est pas un PDF (en-tete %PDF- absent)");
  }
  return buf;
}

// ---------------------------------------------------------------
// Operations
// ---------------------------------------------------------------

function cleanStr(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function cleanTotals(t) {
  if (!t || typeof t !== "object") return null;
  const out = {};
  for (const k of ["productsHT", "shippingHT", "totalHT", "taxTotal", "totalTTC"]) {
    const n = t[k] === undefined || t[k] === null || t[k] === "" ? null : Number(t[k]);
    out[k] = Number.isFinite(n) ? n : null;
  }
  return out;
}

// Copie "publique" : ne contient que des metadonnees (jamais le contenu du fichier).
function toMeta(d) {
  return { ...d };
}

/**
 * Enregistre un PDF. Dedup par sha256 : le meme fichier ne cree qu'un document (retourne l'existant, deduped:true).
 * @returns {{document: object, deduped: boolean}}
 */
function saveDocument(shop, { buffer, filename, kind, supplierId, supplierName, purchaseOrderId, invoiceNumber, invoiceDate, totals, createdBy }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new DocumentError(400, "invalid_pdf", "Le fichier n'est pas un PDF (en-tete %PDF- absent)");
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw new DocumentError(413, "pdf_too_large", `PDF trop volumineux (max ${MAX_PDF_BYTES / (1024 * 1024)} Mo)`);
  }
  const docKind = kind || "invoice";
  if (!DOC_KINDS.includes(docKind)) throw new DocumentError(400, "invalid_kind", "Type de document inconnu");

  const sha = crypto.createHash("sha256").update(buffer).digest("hex");
  const documents = loadIndex(shop);
  const existing = documents.find((d) => d.sha256 === sha && fs.existsSync(path.join(docsDir(shop), `${d.id}.pdf`)));
  if (existing) return { document: toMeta(existing), deduped: true };

  const id = `doc_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
  const doc = {
    id,
    kind: docKind,
    filename: sanitizeFilename(filename),
    mime: "application/pdf",
    size: buffer.length,
    sha256: sha,
    supplierId: cleanStr(supplierId, 100),
    supplierName: cleanStr(supplierName, 200),
    purchaseOrderId: cleanStr(purchaseOrderId, 100),
    invoiceNumber: cleanStr(invoiceNumber, 100),
    invoiceDate: cleanStr(invoiceDate, 10),
    totals: cleanTotals(totals),
    createdAt: new Date().toISOString(),
    createdBy: cleanStr(createdBy, 100),
  };

  const file = path.join(docsDir(shop), `${id}.pdf`);
  atomicWrite(file, buffer);
  try {
    saveIndex(shop, [...documents, doc]);
  } catch (e) {
    try {
      fs.unlinkSync(file);
    } catch {}
    throw e;
  }
  return { document: toMeta(doc), deduped: false };
}

function listDocuments(shop, { purchaseOrderId, supplierId, kind } = {}) {
  let docs = loadIndex(shop);
  if (purchaseOrderId) docs = docs.filter((d) => d.purchaseOrderId === String(purchaseOrderId));
  if (supplierId) docs = docs.filter((d) => d.supplierId === String(supplierId));
  if (kind) docs = docs.filter((d) => d.kind === kind);
  docs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return docs.map(toMeta);
}

function getDocument(shop, id) {
  if (!DOC_ID_RE.test(String(id || ""))) return null;
  const d = loadIndex(shop).find((x) => x.id === id);
  return d ? toMeta(d) : null;
}

// Chemin du PDF (null si inconnu / fichier absent). L'id est valide par regex : pas de traversee de dossier.
function getDocumentFilePath(shop, id) {
  const d = getDocument(shop, id);
  if (!d) return null;
  const file = path.join(docsDir(shop), `${d.id}.pdf`);
  return fs.existsSync(file) ? file : null;
}

function deleteDocument(shop, id) {
  if (!DOC_ID_RE.test(String(id || ""))) return null;
  const documents = loadIndex(shop);
  const d = documents.find((x) => x.id === id);
  if (!d) return null;
  saveIndex(
    shop,
    documents.filter((x) => x.id !== id)
  );
  try {
    fs.unlinkSync(path.join(docsDir(shop), `${id}.pdf`));
  } catch {}
  return toMeta(d);
}

// Purge RGPD d'une boutique (webhook shop/redact) : dossier documents/ + index documents.json.
function purgeShopDocuments(shop) {
  let removed = 0;
  try {
    const dir = docsDir(shop);
    if (fs.existsSync(dir)) {
      removed = fs.readdirSync(dir).length;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
  try {
    fs.rmSync(indexFile(shop), { force: true });
    fs.rmSync(`${indexFile(shop)}.tmp`, { force: true });
  } catch {}
  return removed;
}

module.exports = {
  MAX_PDF_BYTES,
  DocumentError,
  sanitizeFilename,
  decodePdfBase64,
  saveDocument,
  listDocuments,
  getDocument,
  getDocumentFilePath,
  deleteDocument,
  purgeShopDocuments,
};

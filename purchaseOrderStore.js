// purchaseOrderStore.js aEUR Gestion des bons de commande (Purchase Orders)
// Workflow : Brouillon a Envoy a Confirm a Reu partiellement a Complet

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

const PO_STATUS = {
  DRAFT: "draft",
  SENT: "sent",
  CONFIRMED: "confirmed",
  PARTIAL: "partial",
  COMPLETE: "complete",
  CANCELLED: "cancelled",
};

const PO_STATUS_LABELS = {
  draft: "Brouillon",
  sent: "Envoy",
  confirmed: "Confirm",
  partial: "Reu partiellement",
  complete: "Complet",
  cancelled: "Annul",
};

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s ? s.replace(/[^a-z0-9._-]/g, "_") : "default";
}

function poDir(shop) {
  const dir = path.join(DATA_DIR, sanitizeShop(shop), "purchase-orders");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function poFile(shop, year) {
  return path.join(poDir(shop), `${year}.json`);
}

function generatePONumber(shop) {
  const year = new Date().getFullYear();
  const orders = loadOrdersByYear(shop, year);
  const count = orders.length + 1;
  return `PO-${year}-${String(count).padStart(4, "0")}`;
}

function loadOrdersByYear(shop, year) {
  const file = poFile(shop, year);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.orders) ? data.orders : [];
    }
  } catch (e) {
    console.warn("Erreur lecture PO:", e.message);
  }
  return [];
}

function saveOrdersByYear(shop, year, orders) {
  const file = poFile(shop, year);
  const data = { year, updatedAt: new Date().toISOString(), orders };
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
  return orders;
}

// Facture fournisseur rattachee au PO (optionnelle) : {number, date, orderRef, taxTotal, totalTTC, paymentMethod}
function normalizeInvoice(inv) {
  if (!inv || typeof inv !== "object" || Array.isArray(inv)) return null;
  const str = (v, max) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
  const num = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    number: str(inv.number, 100),
    date: str(inv.date, 10),
    orderRef: str(inv.orderRef, 100),
    taxTotal: num(inv.taxTotal),
    totalTTC: num(inv.totalTTC),
    paymentMethod: str(inv.paymentMethod, 100),
  };
}

function normalizeDocumentIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 50);
}

function createPurchaseOrder(shop, poData) {
  const year = new Date().getFullYear();
  const orders = loadOrdersByYear(shop, year);
  const po = buildPurchaseOrder(shop, poData);
  orders.push(po);
  saveOrdersByYear(shop, year, orders);
  return po;
}

function buildPurchaseOrder(shop, poData) {
  const po = {
    id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    number: generatePONumber(shop),
    supplierId: poData.supplierId || null,
    supplierName: poData.supplierName || "",
    createdAt: new Date().toISOString(),
    sentAt: null,
    expectedDeliveryAt: poData.expectedDeliveryAt || null,
    receivedAt: null,
    lines: (poData.lines || []).map((line, idx) => ({
      id: `line_${idx + 1}`,
      productId: String(line.productId || ""),
      productName: line.productName || "",
      orderedGrams: Number(line.grams || line.orderedGrams || 0),
      receivedGrams: 0,
      pricePerGram: Number(line.pricePerGram || 0),
      lineTotal: Number(line.grams || line.orderedGrams || 0) * Number(line.pricePerGram || 0),
      batchId: null,
    })),
    subtotal: 0,
    shippingCost: Number(poData.shippingCost || 0),
    otherCosts: Number(poData.otherCosts || 0),
    total: 0,
    currency: poData.currency || "EUR",
    status: PO_STATUS.DRAFT,
    notes: poData.notes || "",
    internalNotes: poData.internalNotes || "",
    receptions: [],
    updatedAt: new Date().toISOString(),
    createdBy: poData.createdBy || null,
    invoice: normalizeInvoice(poData.invoice),
    documentIds: normalizeDocumentIds(poData.documentIds),
  };
  
  po.subtotal = po.lines.reduce((sum, l) => sum + l.lineTotal, 0);
  po.total = po.subtotal + po.shippingCost + po.otherCosts;
  
  return po;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// PO cree directement au statut COMPLETE pour une facture deja livree (pas de send/confirm/receive) :
// receivedGrams = orderedGrams, receivedAt = maintenant. Ne touche NI au stock NI aux lots :
// l'appelant (route agent facture) s'en charge.
function createCompletedPurchaseOrder(shop, poData) {
  const year = new Date().getFullYear();
  const orders = loadOrdersByYear(shop, year);
  const po = buildPurchaseOrder(shop, poData);
  const now = new Date().toISOString();

  po.lines.forEach((l) => {
    l.receivedGrams = l.orderedGrams;
    l.lineTotal = round2(l.orderedGrams * l.pricePerGram);
  });
  po.subtotal = round2(po.lines.reduce((sum, l) => sum + l.lineTotal, 0));
  po.shippingCost = round2(po.shippingCost);
  po.otherCosts = round2(po.otherCosts);
  po.total = round2(po.subtotal + po.shippingCost + po.otherCosts);
  po.status = PO_STATUS.COMPLETE;
  po.sentAt = now;
  po.receivedAt = now;
  po.receptions = [
    {
      id: `rec_${Date.now()}`,
      date: now,
      lines: po.lines.map((l) => ({ lineId: l.id, receivedGrams: l.receivedGrams })),
      notes: poData.receptionNotes || "Facture deja livree (saisie directe)",
    },
  ];
  po.updatedAt = now;

  orders.push(po);
  saveOrdersByYear(shop, year, orders);
  return po;
}

// Lie un document (facture PDF) a un PO, quel que soit son statut.
function attachDocument(shop, poId, documentId) {
  const po = getPurchaseOrder(shop, poId);
  if (!po) throw new Error(`Bon de commande non trouve: ${poId}`);
  const orders = loadOrdersByYear(shop, po._year);
  const index = orders.findIndex((o) => o.id === po.id);
  orders[index].documentIds = normalizeDocumentIds([...(orders[index].documentIds || []), documentId]);
  orders[index].updatedAt = new Date().toISOString();
  saveOrdersByYear(shop, po._year, orders);
  return orders[index];
}

// Retire un document de TOUS les PO qui le referencent (suppression d'un document). Retourne le nb de PO modifies.
function detachDocumentEverywhere(shop, documentId) {
  const dir = poDir(shop);
  let changed = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const year = parseInt(file.replace(".json", ""));
    const orders = loadOrdersByYear(shop, year);
    let dirty = false;
    for (const o of orders) {
      if (Array.isArray(o.documentIds) && o.documentIds.includes(documentId)) {
        o.documentIds = o.documentIds.filter((x) => x !== documentId);
        o.updatedAt = new Date().toISOString();
        dirty = true;
        changed++;
      }
    }
    if (dirty) saveOrdersByYear(shop, year, orders);
  }
  return changed;
}

function getPurchaseOrder(shop, poId) {
  const dir = poDir(shop);
  if (!fs.existsSync(dir)) return null;
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  for (const file of files) {
    const year = parseInt(file.replace(".json", ""));
    const orders = loadOrdersByYear(shop, year);
    const po = orders.find(o => o.id === poId || o.number === poId);
    if (po) return { ...po, _year: year };
  }
  return null;
}

function updatePurchaseOrder(shop, poId, updates) {
  const po = getPurchaseOrder(shop, poId);
  if (!po) throw new Error(`Bon de commande non trouv: ${poId}`);
  
  const year = po._year;
  const orders = loadOrdersByYear(shop, year);
  const index = orders.findIndex(o => o.id === poId);
  
  if (po.status === PO_STATUS.DRAFT) {
    if (updates.supplierId !== undefined) orders[index].supplierId = updates.supplierId;
    if (updates.supplierName !== undefined) orders[index].supplierName = updates.supplierName;
    if (updates.expectedDeliveryAt !== undefined) orders[index].expectedDeliveryAt = updates.expectedDeliveryAt;
    if (updates.shippingCost !== undefined) {
      orders[index].shippingCost = Number(updates.shippingCost);
      orders[index].total = orders[index].subtotal + orders[index].shippingCost + orders[index].otherCosts;
    }
    if (updates.lines !== undefined) {
      orders[index].lines = updates.lines.map((line, idx) => ({
        id: line.id || `line_${idx + 1}`,
        productId: String(line.productId || ""),
        productName: line.productName || "",
        orderedGrams: Number(line.grams || line.orderedGrams || 0),
        receivedGrams: 0,
        pricePerGram: Number(line.pricePerGram || 0),
        lineTotal: Number(line.grams || line.orderedGrams || 0) * Number(line.pricePerGram || 0),
        batchId: null,
      }));
      orders[index].subtotal = orders[index].lines.reduce((sum, l) => sum + l.lineTotal, 0);
      orders[index].total = orders[index].subtotal + orders[index].shippingCost + orders[index].otherCosts;
    }
  }
  
  if (updates.notes !== undefined) orders[index].notes = updates.notes;
  if (updates.internalNotes !== undefined) orders[index].internalNotes = updates.internalNotes;
  if (updates.invoice !== undefined) orders[index].invoice = normalizeInvoice(updates.invoice);
  if (updates.documentIds !== undefined) orders[index].documentIds = normalizeDocumentIds(updates.documentIds);
  orders[index].updatedAt = new Date().toISOString();
  
  saveOrdersByYear(shop, year, orders);
  return orders[index];
}

function deletePurchaseOrder(shop, poId) {
  const po = getPurchaseOrder(shop, poId);
  if (!po) return false;
  if (po.status !== PO_STATUS.DRAFT) throw new Error("Seuls les brouillons peuvent tre supprims");
  
  const year = po._year;
  const orders = loadOrdersByYear(shop, year);
  saveOrdersByYear(shop, year, orders.filter(o => o.id !== poId));
  return true;
}

function sendPurchaseOrder(shop, poId) {
  const po = getPurchaseOrder(shop, poId);
  if (!po) throw new Error(`PO non trouv: ${poId}`);
  if (po.status !== PO_STATUS.DRAFT) throw new Error("Seuls les brouillons peuvent tre envoys");
  
  const year = po._year;
  const orders = loadOrdersByYear(shop, year);
  const index = orders.findIndex(o => o.id === poId);
  
  orders[index].status = PO_STATUS.SENT;
  orders[index].sentAt = new Date().toISOString();
  orders[index].updatedAt = new Date().toISOString();
  
  saveOrdersByYear(shop, year, orders);
  return orders[index];
}

function confirmPurchaseOrder(shop, poId, expectedDeliveryAt = null) {
  const po = getPurchaseOrder(shop, poId);
  if (!po) throw new Error(`PO non trouv: ${poId}`);
  if (po.status !== PO_STATUS.SENT) throw new Error("Le PO doit tre envoy avant confirmation");
  
  const year = po._year;
  const orders = loadOrdersByYear(shop, year);
  const index = orders.findIndex(o => o.id === poId);
  
  orders[index].status = PO_STATUS.CONFIRMED;
  if (expectedDeliveryAt) orders[index].expectedDeliveryAt = expectedDeliveryAt;
  orders[index].updatedAt = new Date().toISOString();
  
  saveOrdersByYear(shop, year, orders);
  return orders[index];
}

function cancelPurchaseOrder(shop, poId, reason = "") {
  const po = getPurchaseOrder(shop, poId);
  if (!po) throw new Error(`PO non trouv: ${poId}`);
  if (po.status === PO_STATUS.COMPLETE) throw new Error("Un PO complet ne peut pas tre annul");
  
  const year = po._year;
  const orders = loadOrdersByYear(shop, year);
  const index = orders.findIndex(o => o.id === poId);
  
  orders[index].status = PO_STATUS.CANCELLED;
  orders[index].internalNotes += `\n[ANNUL] ${reason}`;
  orders[index].updatedAt = new Date().toISOString();
  
  saveOrdersByYear(shop, year, orders);
  return orders[index];
}

// Entrees de stock d'une reception : prix de revient = prix de ligne + part des frais (port + autres)
// repartie au poids sur les grammes COMMANDES du PO. Arrondi a 4 decimales (precision CMP).
function computeReceiptStockEntries(po, receptionLines) {
  const lines = Array.isArray(po?.lines) ? po.lines : [];
  const totalOrdered = lines.reduce((s, l) => s + (Number(l.orderedGrams) || 0), 0);
  const extra = (Number(po?.shippingCost) || 0) + (Number(po?.otherCosts) || 0);
  const extraPerGram = totalOrdered > 0 ? extra / totalOrdered : 0;
  const out = [];
  for (const rl of receptionLines || []) {
    const line = lines.find((l) => l.id === rl.lineId);
    const grams = Number(rl.receivedGrams) || 0;
    if (!line || !(grams > 0) || !line.productId) continue;
    const price = Number(line.pricePerGram) || 0;
    out.push({
      lineId: line.id,
      productId: String(line.productId),
      productName: line.productName || "",
      grams,
      pricePerGram: price,
      landedPricePerGram: Math.round((price + extraPerGram) * 10000) / 10000,
    });
  }
  return out;
}


function receiveItems(shop, poId, receivedLines, options = {}) {
  const po = getPurchaseOrder(shop, poId);
  if (!po) throw new Error(`PO non trouv: ${poId}`);
  if (![PO_STATUS.SENT, PO_STATUS.CONFIRMED, PO_STATUS.PARTIAL].includes(po.status)) {
    throw new Error("Le PO doit tre envoy ou confirm pour recevoir des articles");
  }
  
  const year = po._year;
  const orders = loadOrdersByYear(shop, year);
  const index = orders.findIndex(o => o.id === poId);
  const order = orders[index];
  
  const reception = {
    id: `rec_${Date.now()}`,
    date: new Date().toISOString(),
    lines: [],
    notes: options.notes || "",
  };
  
  const createdBatches = [];
  
  for (const received of receivedLines) {
    const lineIndex = order.lines.findIndex(l => l.id === received.lineId);
    if (lineIndex === -1) continue;
    
    const line = order.lines[lineIndex];
    const grams = Number(received.receivedGrams || 0);
    if (grams <= 0) continue;
    
    line.receivedGrams += grams;
    reception.lines.push({ lineId: line.id, receivedGrams: grams });
    
    if (options.createBatches !== false) {
      createdBatches.push({
        productId: line.productId,
        grams,
        pricePerGram: line.pricePerGram,
        supplierId: order.supplierId,
        purchaseOrderId: order.id,
        expiryDate: received.expiryDate || null,
        expiryType: received.expiryType || "none",
      });
    }
  }
  
  order.receptions.push(reception);
  
  const totalOrdered = order.lines.reduce((sum, l) => sum + l.orderedGrams, 0);
  const totalReceived = order.lines.reduce((sum, l) => sum + l.receivedGrams, 0);
  
  if (totalReceived >= totalOrdered) {
    order.status = PO_STATUS.COMPLETE;
    order.receivedAt = new Date().toISOString();
  } else if (totalReceived > 0) {
    order.status = PO_STATUS.PARTIAL;
  }
  
  order.updatedAt = new Date().toISOString();
  saveOrdersByYear(shop, year, orders);
  
  return { purchaseOrder: order, reception, batchesToCreate: createdBatches, isComplete: order.status === PO_STATUS.COMPLETE };
}

function listPurchaseOrders(shop, options = {}) {
  const { year, status, supplierId, limit = 100 } = options;
  const dir = poDir(shop);
  if (!fs.existsSync(dir)) return [];
  
  let allOrders = [];
  
  if (year) {
    allOrders = loadOrdersByYear(shop, year);
  } else {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      allOrders = allOrders.concat(loadOrdersByYear(shop, parseInt(file.replace(".json", ""))));
    }
  }
  
  if (status) allOrders = allOrders.filter(o => o.status === status);
  if (supplierId) allOrders = allOrders.filter(o => o.supplierId === supplierId);
  
  allOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return allOrders.slice(0, limit);
}

function getPendingOrders(shop) {
  return listPurchaseOrders(shop, {}).filter(o =>
    [PO_STATUS.SENT, PO_STATUS.CONFIRMED, PO_STATUS.PARTIAL].includes(o.status)
  );
}

function getPOStats(shop, year = null) {
  const orders = listPurchaseOrders(shop, { year });
  const stats = { total: orders.length, byStatus: {}, totalValue: 0, pendingValue: 0 };
  
  for (const status of Object.values(PO_STATUS)) {
    stats.byStatus[status] = orders.filter(o => o.status === status).length;
  }
  
  for (const order of orders) {
    if (order.status !== PO_STATUS.CANCELLED) {
      stats.totalValue += order.total;
      if ([PO_STATUS.SENT, PO_STATUS.CONFIRMED, PO_STATUS.PARTIAL].includes(order.status)) {
        stats.pendingValue += order.total;
      }
    }
  }
  
  return stats;
}

module.exports = {
  PO_STATUS,
  PO_STATUS_LABELS,
  createPurchaseOrder,
  createCompletedPurchaseOrder,
  attachDocument,
  detachDocumentEverywhere,
  normalizeInvoice,
  getPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  sendPurchaseOrder,
  confirmPurchaseOrder,
  cancelPurchaseOrder,
  receiveItems,
  computeReceiptStockEntries,
  listPurchaseOrders,
  getPendingOrders,
  getPOStats,
  generatePONumber,
};
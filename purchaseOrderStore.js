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

function createPurchaseOrder(shop, poData) {
  const year = new Date().getFullYear();
  const orders = loadOrdersByYear(shop, year);
  
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
  };
  
  po.subtotal = po.lines.reduce((sum, l) => sum + l.lineTotal, 0);
  po.total = po.subtotal + po.shippingCost + po.otherCosts;
  
  orders.push(po);
  saveOrdersByYear(shop, year, orders);
  return po;
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
  getPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  sendPurchaseOrder,
  confirmPurchaseOrder,
  cancelPurchaseOrder,
  receiveItems,
  listPurchaseOrders,
  getPendingOrders,
  getPOStats,
  generatePONumber,
};
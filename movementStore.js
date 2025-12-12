// movementStore.js
// Historique en mémoire + export JSON/CSV (sans DB)

const MAX_MOVEMENTS = Number(process.env.MAX_MOVEMENTS || 5000);

// En mémoire (perdu si Render redémarre)
const movements = [];

// Ajoute un mouvement (le plus récent en premier)
function addMovement(m) {
  movements.unshift({
    id: m.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: m.ts || new Date().toISOString(),
    source: m.source, // webhook | restock | set_total | manual
    productId: String(m.productId || ""),
    productName: m.productName || null,
    gramsDelta: Number(m.gramsDelta || 0), // - = sortie, + = entrée
    gramsBefore: m.gramsBefore ?? null,
    gramsAfter: m.gramsAfter ?? null,
    orderId: m.orderId ? String(m.orderId) : null,
    orderName: m.orderName || null,
    lineTitle: m.lineTitle || null,
    variantTitle: m.variantTitle || null,
    requestId: m.requestId || null,
    meta: m.meta || null,
  });

  if (movements.length > MAX_MOVEMENTS) movements.length = MAX_MOVEMENTS;
}

function listMovements({ limit = 200, productId, orderId, source } = {}) {
  let out = movements;

  if (productId) out = out.filter((x) => x.productId === String(productId));
  if (orderId) out = out.filter((x) => x.orderId === String(orderId));
  if (source) out = out.filter((x) => x.source === source);

  limit = Math.min(Number(limit || 200), 2000);
  return out.slice(0, limit);
}

function toCSV(rows) {
  const headers = [
    "ts",
    "source",
    "productId",
    "productName",
    "gramsDelta",
    "gramsBefore",
    "gramsAfter",
    "orderId",
    "orderName",
    "lineTitle",
    "variantTitle",
    "requestId",
    "meta",
  ];

  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    // CSV safe
    return `"${s.replace(/"/g, '""')}"`;
  };

  const lines = [];
  lines.push(headers.join(","));
  for (const r of rows) {
    lines.push(
      [
        r.ts,
        r.source,
        r.productId,
        r.productName,
        r.gramsDelta,
        r.gramsBefore,
        r.gramsAfter,
        r.orderId,
        r.orderName,
        r.lineTitle,
        r.variantTitle,
        r.requestId,
        r.meta,
      ].map(escape).join(",")
    );
  }
  return lines.join("\n");
}

module.exports = {
  addMovement,
  listMovements,
  toCSV,
};

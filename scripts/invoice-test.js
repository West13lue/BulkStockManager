// Tests locaux des factures fournisseur + de la reception de PO (serveur reel spawne, DATA_DIR temporaire).
// Usage : node scripts/invoice-test.js        (AGENT_TEST_TMP=<dossier> pour choisir le dossier temporaire)
// Le serveur tourne en NODE_ENV=production AVEC un secret Shopify de test : le test signe lui-meme des JWT HS256
// (comme App Bridge), ce qui permet d'exercer les vraies routes /api derriere requireApiAuth.
// Bruit attendu : "Aucun token OAuth" / inventory_push_error (pas de token Shopify en local) : les ecritures
// de stock reussissent quand meme (push Shopify en echec, intercepte).
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SERVER = process.argv[2] || path.join(REPO, "server.js");
const SHOP = "test-shop.myshopify.com";
const OTHER_SHOP = "autre-shop.myshopify.com";
const AGENT_KEY = crypto.randomBytes(32).toString("hex");
const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret-" + crypto.randomBytes(8).toString("hex");
const ROOT = fs.mkdtempSync(path.join(process.env.AGENT_TEST_TMP || os.tmpdir(), "invoice-test-"));
const DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA; // AVANT de require les stores
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 600) : ""}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------- stores (meme DATA_DIR que le serveur) ----------
const stock = require(path.join(REPO, "stockManager.js"));
const overrides = require(path.join(REPO, "productOverridesStore.js"));
const poStore = require(path.join(REPO, "purchaseOrderStore.js"));
const batchStore = require(path.join(REPO, "batchStore.js"));
const supplierStore = require(path.join(REPO, "supplierStore.js"));

function seedProduct(id, name, totalGrams, cmp) {
  stock.upsertImportedProductConfig(SHOP, {
    productId: id,
    name,
    totalGrams,
    variants: { 1: { gramsPerUnit: 1, inventoryItemId: Number(id) * 10, variantId: String(Number(id) * 100) } },
  });
  stock.setAverageCostPerGram(SHOP, id, cmp);
}

// JWT HS256 signe avec le secret de test
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function jwt(shop = SHOP, { exp, aud = API_KEY, secret = API_SECRET } = {}) {
  const head = b64u({ alg: "HS256", typ: "JWT" });
  const body = b64u({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud, sub: "1", exp: exp || Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(extraEnv) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), NODE_ENV: "production", DATA_DIR: DATA };
  for (const k of ["AGENT_API_KEY", "AGENT_SHOP", "AGENT_API_RATE_LIMIT_PER_MIN", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "API_AUTH_REQUIRED", "SHOP_NAME", "SHOPIFY_WEBHOOK_SECRET"]) delete env[k];
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [SERVER], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await sleep(250);
  }
  return { base, logs: () => out, stop: async () => { child.kill(); await sleep(200); } };
}

async function http(base, method, url, { token, agentKey, body, raw, headers, binary } = {}) {
  const h = { ...(headers || {}) };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (agentKey !== undefined) h["X-Agent-Key"] = agentKey;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  const r = await fetch(base + url, { method, headers: h, body: payload });
  let json = null;
  let buf = null;
  if (binary) buf = Buffer.from(await r.arrayBuffer());
  else { try { json = await r.json(); } catch {} }
  return { status: r.status, headers: r.headers, json, buf };
}

// ---------- helpers disque ----------
const shopDir = path.join(DATA, SHOP);
const productOnDisk = (pid) => JSON.parse(fs.readFileSync(path.join(shopDir, "stock.json"), "utf8")).products[pid];
function readMovements() {
  const dir = path.join(shopDir, "movements");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// Petit PDF minimal genere ici (jamais la vraie facture)
function tinyPdf(label) {
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, "latin1");
}

(async () => {
  const servers = [];
  try {
    // ---------- seed ----------
    seedProduct("111", "Fleur A", 100, 1); // PO receive : ligne 1
    seedProduct("112", "Fleur B", 40, 3); // PO receive : ligne 2
    seedProduct("113", "Fleur C", 0, 0);
    seedProduct("301", "Produit Facture 1", 50, 0.5);
    seedProduct("302", "Produit Facture 2", 0, 0);
    seedProduct("303", "Produit Facture 3", 100, 1);
    seedProduct("304", "Produit Facture 4", 0, 0);
    seedProduct("305", "Produit Archive", 30, 1);
    overrides.setOverride(SHOP, "305", { archived: true });
    fs.writeFileSync(path.join(shopDir, "plan.json"), JSON.stringify({ planId: "business", subscription: { id: "test", status: "active" } }));

    const S = await startServer({ SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET, AGENT_API_KEY: AGENT_KEY, AGENT_SHOP: SHOP, AGENT_API_RATE_LIMIT_PER_MIN: "500" });
    servers.push(S);
    const b = S.base;
    const T = jwt();
    const api = (m, u, o = {}) => http(b, m, u, { token: T, ...o });

    // =========================================================
    // BLOC 1 : reception de PO (bug : stock.addStock n'existait pas)
    // =========================================================
    console.log("--- 1. reception de PO ---");
    const sup = supplierStore.createSupplier(SHOP, { name: "Fournisseur Reception" });
    const po1 = poStore.createPurchaseOrder(SHOP, {
      supplierId: sup.id,
      supplierName: sup.name,
      shippingCost: 6,
      otherCosts: 3,
      lines: [
        { productId: "111", productName: "Fleur A", grams: 100, pricePerGram: 2 },
        { productId: "112", productName: "Fleur B", grams: 50, pricePerGram: 1 },
      ],
    });
    poStore.sendPurchaseOrder(SHOP, po1.id);

    let r = await http(b, "POST", `/api/purchase-orders/${po1.id}/receive`, { body: {} });
    check("receive sans JWT -> 401", r.status === 401, r.json);
    check("  stock inchange apres le 401", productOnDisk("111").totalGrams === 100);

    // Pas de lignes dans le body = ce que envoie l'UI ("Confirmer reception") : tout le reste a livrer.
    r = await api("POST", `/api/purchase-orders/${po1.id}/receive`, { body: { notes: "colis ok" } });
    check("receive (body UI {notes}) -> 200 success", r.status === 200 && r.json && r.json.success === true, r.json);
    check("  PO passe en 'complete', 2 lignes recues", r.json && r.json.purchaseOrder.status === "complete" && r.json.purchaseOrder.lines.every((l) => l.receivedGrams === l.orderedGrams), r.json && r.json.purchaseOrder);
    const stockUp = (r.json && r.json.stockUpdates) || [];
    check("  stockUpdates : 2 lignes ok", stockUp.length === 2 && stockUp.every((u) => u.ok === true), stockUp);
    // port 6 + autres 3 = 9 sur 150 g commandes = 0.06 EUR/g
    const p111 = productOnDisk("111");
    const p112 = productOnDisk("112");
    check("  produit 111 : 100 -> 200 g (stock ajoute UNE fois)", p111.totalGrams === 200, p111);
    check("  produit 111 : CMP = (100*1 + 100*2.06)/200 = 1.53 (prix de revient avec port)", near(p111.averageCostPerGram, 1.53, 1e-6), p111);
    check("  produit 112 : 40 -> 90 g, CMP = (40*3 + 50*1.06)/90", p112.totalGrams === 90 && near(p112.averageCostPerGram, (40 * 3 + 50 * 1.06) / 90, 1e-6), p112);
    const mvs = readMovements().filter((m) => m.source === "purchase_order_receive");
    check("  2 mouvements purchase_order_receive avec meta {purchaseOrderId, poNumber, supplierId, invoiceNumber}",
      mvs.length === 2 && mvs.every((m) => m.meta.purchaseOrderId === po1.id && m.meta.poNumber === po1.number && m.meta.supplierId === sup.id && "invoiceNumber" in m.meta), mvs);
    const m111 = mvs.find((m) => m.productId === "111");
    check("  mouvement 111 : +100 g, prix de revient 2.06, cmpBefore 1, totalAfter 200", m111 && m111.gramsDelta === 100 && near(m111.purchasePricePerGram, 2.06, 1e-6) && near(m111.cmpBefore, 1) && m111.totalAfter === 200, m111);
    const lots = batchStore.loadBatches(SHOP, "111");
    check("  lot toujours cree (1 lot, 100 g, prix de LIGNE 2.00, lie au PO)", lots.length === 1 && lots[0].initialGrams === 100 && near(lots[0].purchasePricePerGram, 2) && lots[0].purchaseOrderId === po1.id, lots);
    check("  erreur Shopify locale (pas de token) n'empeche pas la reception", /inventory_push_error|Aucun token/.test(S.logs()), S.logs().slice(-300));

    r = await api("POST", `/api/purchase-orders/${po1.id}/receive`, { body: {} });
    check("re-receive d'un PO complet -> 400, rien n'est double", r.status === 400 && productOnDisk("111").totalGrams === 200 && readMovements().filter((m) => m.source === "purchase_order_receive").length === 2 && batchStore.loadBatches(SHOP, "111").length === 1, r.json);

    // Reception partielle explicite + frais repartis sur les grammes COMMANDES
    const po2 = poStore.createPurchaseOrder(SHOP, { supplierId: sup.id, supplierName: sup.name, shippingCost: 10, lines: [{ productId: "113", productName: "Fleur C", grams: 200, pricePerGram: 1 }] });
    poStore.sendPurchaseOrder(SHOP, po2.id);
    r = await api("POST", `/api/purchase-orders/${po2.id}/receive`, { body: { lines: [{ lineId: po2.lines[0].id, receivedGrams: 100 }] } });
    check("reception partielle (100 g sur 200) -> status partial, +100 g, prix de revient 1 + 10/200 = 1.05",
      r.status === 200 && r.json.purchaseOrder.status === "partial" && productOnDisk("113").totalGrams === 100 && near(productOnDisk("113").averageCostPerGram, 1.05, 1e-6), [r.json && r.json.purchaseOrder.status, productOnDisk("113")]);
    r = await api("POST", `/api/purchase-orders/${po2.id}/receive`, { body: {} });
    check("  2e reception sans lignes = le reste (100 g) -> complete, 200 g, CMP inchange 1.05", r.status === 200 && r.json.purchaseOrder.status === "complete" && productOnDisk("113").totalGrams === 200 && near(productOnDisk("113").averageCostPerGram, 1.05, 1e-6), productOnDisk("113"));

    // =========================================================
    // BLOC 2 : POST /agent/v1/invoices
    // =========================================================
    console.log("--- 2. agent : POST /agent/v1/invoices ---");
    const ag = (m, u, o = {}) => http(b, m, u, { agentKey: AGENT_KEY, ...o });
    const sdir = (...p) => path.join(shopDir, ...p);
    const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    const poFiles = () => (fs.existsSync(sdir("purchase-orders")) ? fs.readdirSync(sdir("purchase-orders")) : []);
    const allPOs = () => poStore.listPurchaseOrders(SHOP, { limit: 100000 });
    const snapshot = () =>
      JSON.stringify({
        stock: sha256hex(Buffer.from(rd(sdir("stock.json")))),
        suppliers: sha256hex(Buffer.from(rd(sdir("suppliers.json")))),
        pos: poFiles().map((f) => sha256hex(Buffer.from(rd(sdir("purchase-orders", f))))),
        docs: fs.existsSync(sdir("documents")) ? fs.readdirSync(sdir("documents")).sort() : null,
        docIndex: sha256hex(Buffer.from(rd(sdir("documents.json")))),
        movements: readMovements().length,
        requests: sha256hex(Buffer.from(rd(sdir("agent-requests.json")))),
      });

    const pdfA = tinyPdf("facture A");
    const baseInvoice = (over = {}) => ({
      requestId: "inv-req-0001",
      supplier: { name: "Fournisseur Test SAS", siret: "123 456 789 00012", vat: "FR00123456789", address: "1 rue Exemple, 75000 Ville", phone: "+33 1 00 00 00 00", email: "contact@example.test" },
      invoice: { number: "FA-2026-0042", date: "2026-10-15", orderRef: "CMD-77", paymentMethod: "Carte", productsHT: 172.0, shippingHT: 9.9, taxTotal: 36.38, totalTTC: 218.28 },
      lines: [
        { productId: "301", grams: 100, pricePerGram: 0.28 },
        { productId: "302", grams: 100, pricePerGram: 0.35 },
        { productId: "303", grams: 100, pricePerGram: 0.59 },
        { productId: "304", grams: 25, pricePerGram: 2.0 },
      ],
      pdf: { filename: "facture test.pdf", contentBase64: pdfA.toString("base64") },
      ...over,
    });
    const withInvoice = (inv, rest = {}) => baseInvoice({ invoice: { ...baseInvoice().invoice, ...inv }, ...rest });

    r = await http(b, "POST", "/agent/v1/invoices", { body: baseInvoice() });
    check("invoices sans cle -> 401", r.status === 401, r.json);
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice({ dryRun: true }), agentKey: "x".repeat(64) });
    check("  mauvaise cle -> 401", r.status === 401, r.json);

    // ---- dryRun : rien n'est ecrit
    const snap0 = snapshot();
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice({ dryRun: true }) });
    check("dryRun -> 200 dryRun:true, 4 lignes", r.status === 200 && r.json.dryRun === true && r.json.lines.length === 4, r.json);
    const expLanded = [0.3105, 0.3805, 0.6205, 2.0305];
    check("  prix de revient (port 9.90 au poids sur 325 g = +0.030462) : 0.3105 / 0.3805 / 0.6205 / 2.0305",
      r.json.lines.every((l, i) => near(l.landedPricePerGram, expLanded[i], 1e-9)) && r.json.lines.map((l) => l.invoicePricePerGram).join() === "0.28,0.35,0.59,2", r.json.lines);
    const cmpEst = stock.calculateWeightedAverageCost(50, 0.5, 100, 0.3105);
    check("  ligne 301 : avant 50 g / apres 150 g, cmpBefore 0.5, cmpAfterEstimate = CMP pondere",
      r.json.lines[0].totalGramsBefore === 50 && r.json.lines[0].totalGramsAfter === 150 && near(r.json.lines[0].cmpBefore, 0.5) && near(r.json.lines[0].cmpAfterEstimate, cmpEst, 1e-9) && near(cmpEst, 0.37367, 1e-4), r.json.lines[0]);
    check("  PO prevu : complete, sous-total 172, port 9.9, total 181.9 ; fournisseur inexistant ; PDF non encore stocke",
      r.json.purchaseOrder.status === "complete" && r.json.purchaseOrder.subtotal === 172 && r.json.purchaseOrder.shippingCost === 9.9 && r.json.purchaseOrder.total === 181.9 &&
      r.json.supplier.exists === false && r.json.document.alreadyStored === false && r.json.document.sha256 === sha256hex(pdfA), r.json);
    check("  dryRun n'ecrit RIEN (stock, fournisseurs, PO, documents, mouvements, idempotence)", snapshot() === snap0);
    check("  aucun dossier documents/ cree", !fs.existsSync(sdir("documents")) && !fs.existsSync(sdir("documents.json")));
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice({ dryRun: true, shippingAllocation: "value" }) });
    check("dryRun shippingAllocation 'value' : 304 = 2 x (1 + 9.9/172) = 2.1151", r.status === 200 && near(r.json.lines[3].landedPricePerGram, 2.1151, 1e-9) && near(r.json.lines[0].landedPricePerGram, 0.2961, 1e-9), r.json.lines);

    // ---- validations : 400/404/409 AVANT toute ecriture
    const baselineSnap = snapshot();
    const badInv = async (name, body, status, code) => {
      const rr = await ag("POST", "/agent/v1/invoices", { body });
      check(`${name} -> ${status}${code ? " " + code : ""}, rien d'ecrit`, rr.status === status && (!code || rr.json.error === code) && snapshot() === baselineSnap, [rr.status, rr.json]);
      return rr;
    };
    await badInv("somme des lignes != productsHT", withInvoice({ productsHT: 170, totalTTC: 215.88, taxTotal: 35.98 }), 400, "totals_mismatch");
    await badInv("productsHT + shippingHT != totalHT", withInvoice({ totalHT: 180 }), 400, "totals_mismatch");
    await badInv("totalHT + TVA != totalTTC", withInvoice({ totalTTC: 200 }), 400, "totals_mismatch");
    await badInv("produit inconnu", baseInvoice({ lines: [...baseInvoice().lines.slice(0, 3), { productId: "999999", grams: 25, pricePerGram: 2 }] }), 404, "product_not_found");
    await badInv("produit archive", baseInvoice({ lines: [...baseInvoice().lines.slice(0, 3), { productId: "305", grams: 25, pricePerGram: 2 }] }), 409, "product_archived");
    await badInv("PDF invalide (texte)", baseInvoice({ pdf: { filename: "x.pdf", contentBase64: Buffer.from("ceci n'est pas un pdf du tout").toString("base64") } }), 400, "invalid_pdf");
    await badInv("PDF invalide (PNG)", baseInvoice({ pdf: { filename: "x.pdf", contentBase64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64") } }), 400, "invalid_pdf");
    await badInv("PDF base64 invalide", baseInvoice({ pdf: { filename: "x.pdf", contentBase64: "%%%pas du base64%%%" } }), 400, "invalid_pdf");
    await badInv("PDF sans contenu", baseInvoice({ pdf: { filename: "x.pdf" } }), 400, "invalid_pdf");
    await badInv("fournisseur sans nom", baseInvoice({ supplier: { name: "  " } }), 400, "invalid_supplier");
    await badInv("date de facture impossible", withInvoice({ date: "2026-13-40" }), 400, "invalid_invoice_date");
    await badInv("numero de facture absent", withInvoice({ number: "" }), 400, "invalid_invoice_number");
    await badInv("lines vide", baseInvoice({ lines: [] }), 400, "invalid_lines");
    await badInv("grams = 0", baseInvoice({ lines: [{ productId: "301", grams: 0, pricePerGram: 1 }] }), 400, "invalid_grams");
    await badInv("grams > 20000", baseInvoice({ lines: [{ productId: "301", grams: 20001, pricePerGram: 1 }] }), 400, "invalid_grams");
    await badInv("prix > 50", baseInvoice({ lines: [{ productId: "301", grams: 1, pricePerGram: 51 }] }), 400, "invalid_price");
    await badInv("prix negatif", baseInvoice({ lines: [{ productId: "301", grams: 1, pricePerGram: -1 }] }), 400, "invalid_price");
    await badInv("shippingAllocation inconnu", baseInvoice({ shippingAllocation: "poids" }), 400, "invalid_shipping_allocation");
    await badInv("requestId absent", baseInvoice({ requestId: undefined }), 400, "invalid_request_id");
    const bigPdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024 + 1024, 0x20)]); // 10 Mo + : < 15 Mo en base64
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice({ pdf: { filename: "gros.pdf", contentBase64: bigPdf.toString("base64") } }) });
    check("PDF > 10 Mo (corps accepte par le parser 15 Mo) -> 413 pdf_too_large, rien d'ecrit", r.status === 413 && r.json.error === "pdf_too_large" && snapshot() === baselineSnap, [r.status, r.json]);
    r = await ag("POST", "/agent/v1/invoices", { raw: JSON.stringify({ pad: "x".repeat(16 * 1024 * 1024) }), headers: { "Content-Type": "application/json" } });
    check("corps > 15 Mo -> 413 payload_too_large", r.status === 413 && r.json.error === "payload_too_large", [r.status, r.json]);
    r = await ag("POST", "/agent/v1/restock", { raw: JSON.stringify({ pad: "x".repeat(200 * 1024) }), headers: { "Content-Type": "application/json" } });
    check("  les autres routes agent gardent la limite de 100 ko (restock -> 413)", r.status === 413, [r.status, r.json]);

    // ---- facture reelle
    const mv0 = readMovements().length;
    const recvMv0 = readMovements().filter((m) => m.source === "purchase_order_receive").length;
    const po0 = allPOs().length;
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice() });
    const first = r.json;
    check("facture reelle -> 200 success, PO + document + fournisseur crees", r.status === 200 && first.success === true && first.replayed === undefined && !!first.purchaseOrder.id && !!first.documentId && first.supplierCreated === true && first.lines.length === 4, r);
    check("  inventorySync par ligne (pas de token Shopify local -> ok:false sans faire echouer)", first.lines.every((l) => l.inventorySync && l.inventorySync.ok === false) && first.inventorySync.ok === false, first.inventorySync);
    const sups = supplierStore.loadSuppliers(SHOP).filter((s) => s.name === "Fournisseur Test SAS");
    check("  fournisseur cree 1 fois (nom, contact, adresse, SIRET/TVA en notes)", sups.length === 1 && sups[0].id === first.supplierId && sups[0].contact.email === "contact@example.test" && /SIRET 123 456 789 00012/.test(sups[0].notes) && /FR00123456789/.test(sups[0].notes), sups);
    const poRec = poStore.getPurchaseOrder(SHOP, first.purchaseOrder.id);
    check("  PO au statut COMPLETE, receivedAt, 4 lignes recues = commandees, total 181.9",
      poRec && poRec.status === "complete" && !!poRec.receivedAt && poRec.lines.length === 4 && poRec.lines.every((l) => l.receivedGrams === l.orderedGrams) && poRec.subtotal === 172 && poRec.shippingCost === 9.9 && poRec.total === 181.9 && poRec.supplierId === first.supplierId, poRec);
    check("  PO.invoice = {number, date, orderRef, taxTotal, totalTTC, paymentMethod}", poRec.invoice && poRec.invoice.number === "FA-2026-0042" && poRec.invoice.date === "2026-10-15" && poRec.invoice.orderRef === "CMD-77" && poRec.invoice.taxTotal === 36.38 && poRec.invoice.totalTTC === 218.28 && poRec.invoice.paymentMethod === "Carte", poRec.invoice);
    check("  PO.documentIds = [documentId]", JSON.stringify(poRec.documentIds) === JSON.stringify([first.documentId]), poRec.documentIds);
    const pdfOnDisk = sdir("documents", `${first.documentId}.pdf`);
    check("  fichier PDF sur disque, sha256 identique a l'original", fs.existsSync(pdfOnDisk) && sha256hex(fs.readFileSync(pdfOnDisk)) === sha256hex(pdfA), pdfOnDisk);
    const idx = JSON.parse(rd(sdir("documents.json")));
    const d0 = idx.documents.find((d) => d.id === first.documentId);
    check("  documents.json : kind invoice, mime, size, sha256, fournisseur, PO, facture, totaux, createdBy 'Agent Hermes'",
      d0 && d0.kind === "invoice" && d0.mime === "application/pdf" && d0.size === pdfA.length && d0.sha256 === sha256hex(pdfA) && d0.supplierId === first.supplierId && d0.supplierName === "Fournisseur Test SAS" &&
      d0.purchaseOrderId === first.purchaseOrder.id && d0.invoiceNumber === "FA-2026-0042" && d0.invoiceDate === "2026-10-15" && d0.totals.totalHT === 181.9 && d0.totals.totalTTC === 218.28 && d0.totals.shippingHT === 9.9 && d0.createdBy === "Agent Hermes" && d0.filename === "facture test.pdf", d0);
    check("  aucun fichier .tmp restant", !fs.readdirSync(sdir("documents")).some((f) => f.endsWith(".tmp")) && !fs.existsSync(sdir("documents.json.tmp")));
    const expCmp = [(50 * 0.5 + 100 * 0.3105) / 150, 0.3805, (100 * 1 + 100 * 0.6205) / 200, 2.0305];
    const expTot = [150, 100, 200, 25];
    const disk = ["301", "302", "303", "304"].map((pid) => productOnDisk(pid));
    check("  stock + CMP au prix de revient : 150/100/200/25 g, CMP " + expCmp.map((x) => x.toFixed(4)).join(" / "),
      disk.every((p, i) => p.totalGrams === expTot[i] && near(p.averageCostPerGram, expCmp[i], 1e-6)), disk);
    check("  reponse : landed + totalGramsBefore/After + cmpBefore/After par ligne", first.lines.every((l, i) => near(l.landedPricePerGram, expLanded[i], 1e-9) && l.totalGramsAfter === expTot[i] && near(l.cmpAfter, expCmp[i], 1e-6) && !!l.movementId) && first.lines[0].totalGramsBefore === 50 && near(first.lines[0].cmpBefore, 0.5), first.lines[0]);
    const invMv = readMovements().filter((m) => m.source === "restock" && m.meta && m.meta.invoice === "FA-2026-0042");
    check("  4 mouvements 'restock' avec meta {supplier, invoice, purchaseOrderId, requestId, via}",
      invMv.length === 4 && readMovements().length === mv0 + 4 && invMv.every((m) => m.meta.supplier === "Fournisseur Test SAS" && m.meta.purchaseOrderId === first.purchaseOrder.id && m.meta.requestId === "inv-req-0001" && m.meta.via === "agent-api" && m.profileName === "Agent Hermes"), invMv);
    check("  mouvements : +grammes, prix de revient comme purchasePricePerGram, cmpBefore", invMv.every((m, i) => { const k = ["301", "302", "303", "304"].indexOf(m.productId); return k >= 0 && near(m.purchasePricePerGram, expLanded[k], 1e-9) && m.gramsDelta === [100, 100, 100, 25][k]; }), invMv);
    check("  PAS de mouvement purchase_order_receive supplementaire (pas de double passage par /receive)", readMovements().filter((m) => m.source === "purchase_order_receive").length === recvMv0);
    check("  un seul PO cree, aucun lot cree (le chemin 'receive' n'est pas emprunte)", allPOs().length === po0 + 1 && batchStore.loadBatches(SHOP, "301").length === 0);
    const reqs = JSON.parse(rd(sdir("agent-requests.json"))).entries.filter((e) => e.route === "invoices");
    check("  idempotence persistee (route invoices, resultat avec documentId)", reqs.length === 1 && reqs[0].requestId === "inv-req-0001" && reqs[0].result.documentId === first.documentId, reqs);
    check("  le contenu du PDF n'apparait pas dans les logs", !S.logs().includes(pdfA.toString("base64")) && !S.logs().includes("facture A"));

    // ---- lecture : ce qui est enregistre
    r = await ag("GET", "/agent/v1/purchase-orders?limit=20");
    const sumPO = r.json && r.json.purchaseOrders && r.json.purchaseOrders.find((p) => p.id === first.purchaseOrder.id);
    check("GET /agent/v1/purchase-orders -> PO avec facture, fournisseur, total, documentIds", r.status === 200 && sumPO && sumPO.invoiceNumber === "FA-2026-0042" && sumPO.supplierName === "Fournisseur Test SAS" && sumPO.total === 181.9 && sumPO.status === "complete" && sumPO.documentIds[0] === first.documentId && sumPO.invoice.totalTTC === 218.28, r.json);
    r = await ag("GET", "/agent/v1/purchase-orders?invoiceNumber=fa-2026-0042");
    check("  filtre invoiceNumber (insensible a la casse) ; sans cle -> 401", r.status === 200 && r.json.purchaseOrders.length === 1 && (await http(b, "GET", "/agent/v1/purchase-orders")).status === 401, r.json);
    r = await ag("GET", "/agent/v1/purchase-orders?limit=1");
    check("  limit=1 -> 1 element, total >= 3", r.json.count === 1 && r.json.purchaseOrders.length === 1 && r.json.total >= 3, [r.json.count, r.json.total]);

    // ---- rejeu
    const snapAfter1 = snapshot();
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice() });
    check("rejeu meme requestId -> 200 replayed:true, meme PO et meme document", r.status === 200 && r.json.replayed === true && r.json.purchaseOrder.id === first.purchaseOrder.id && r.json.documentId === first.documentId, r.json);
    check("  rien n'est double (stock, PO, mouvements, fournisseur, documents identiques)", snapshot() === snapAfter1);
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice({ supplier: { name: "Autre" } }) });
    check("meme requestId + contenu different -> 409 request_id_conflict", r.status === 409 && r.json.error === "request_id_conflict", r.json);
    const cb = baseInvoice({ requestId: "inv-concurrent-1", invoice: { number: "FA-CONC-1", date: "2026-10-16", productsHT: 5, shippingHT: 0, taxTotal: 1, totalTTC: 6 }, lines: [{ productId: "302", grams: 5, pricePerGram: 1 }], pdf: undefined });
    const [c1, c2] = await Promise.all([ag("POST", "/agent/v1/invoices", { body: cb }), ag("POST", "/agent/v1/invoices", { body: cb })]);
    check("2 requetes simultanees meme requestId -> 200/200 dont 1 replayed, 1 seul PO", c1.status === 200 && c2.status === 200 && [c1, c2].filter((x) => x.json.replayed === true).length === 1 && allPOs().filter((p) => p.invoice && p.invoice.number === "FA-CONC-1").length === 1, [c1.json, c2.json]);
    check("  facture sans PDF : documentId null, documentIds vide", c1.json.documentId === null && poStore.getPurchaseOrder(SHOP, c1.json.purchaseOrder.id).documentIds.length === 0);

    // ---- facture deja enregistree (autre requestId, meme fournisseur + numero)
    const snapBefore2 = snapshot();
    r = await ag("POST", "/agent/v1/invoices", { body: baseInvoice({ requestId: "inv-req-dup-001", supplier: { name: "FOURNISSEUR TEST sas" } }) });
    check("meme fournisseur (casse differente) + meme numero, autre requestId -> 409 invoice_already_recorded, rien d'ecrit", r.status === 409 && r.json.error === "invoice_already_recorded" && r.json.purchaseOrder.id === first.purchaseOrder.id && snapshot() === snapBefore2, r.json);

    // ---- 2e facture : meme PDF, autre numero -> document deduplique, fournisseur retrouve (insensible a la casse)
    const secondBody = baseInvoice({
      requestId: "inv-req-0002",
      supplier: { name: "fournisseur test sas" },
      invoice: { number: "FA-2026-0043", date: "2026-10-16", productsHT: 10, shippingHT: 0, taxTotal: 2, totalTTC: 12 },
      lines: [{ productId: "301", grams: 10, pricePerGram: 1 }],
    });
    r = await ag("POST", "/agent/v1/invoices", { body: secondBody });
    const second = r.json;
    check("2e facture (meme PDF, autre numero) -> 200, document deduplique (meme documentId)", r.status === 200 && second.documentId === first.documentId && second.documentDeduped === true && second.purchaseOrder.id !== first.purchaseOrder.id, second);
    check("  fournisseur retrouve (casse ignoree) : meme supplierId, supplierCreated=false, 1 seul fournisseur", second.supplierId === first.supplierId && second.supplierCreated === false && supplierStore.loadSuppliers(SHOP).filter((s) => s.name.toLowerCase() === "fournisseur test sas").length === 1, second);
    check("  1 seul fichier PDF sur disque, 1 seule entree d'index ; le nouveau PO reference le meme document",
      fs.readdirSync(sdir("documents")).filter((f) => f.endsWith(".pdf")).length === 1 && JSON.parse(rd(sdir("documents.json"))).documents.length === 1 && poStore.getPurchaseOrder(SHOP, second.purchaseOrder.id).documentIds[0] === first.documentId, fs.readdirSync(sdir("documents")));
    check("  stock 301 : 150 + 10 = 160 g (ligne a prix de revient = prix facture, port 0)", productOnDisk("301").totalGrams === 160 && near(productOnDisk("301").averageCostPerGram, (150 * expCmp[0] + 10 * 1) / 160, 1e-6), productOnDisk("301"));


    // =========================================================
    // BLOC 3 : routes UI /api/documents* derriere le JWT
    // =========================================================
    console.log("--- 3. UI : /api/documents* ---");
    const docStore = require(path.join(REPO, "documentStore.js"));
    check("sanitizeFilename : chemin, guillemets, chevrons retires ; .pdf force ; borne",
      docStore.sanitizeFilename("../../etc/passwd") === "passwd.pdf" && docStore.sanitizeFilename('a"b<c>.pdf') === "abc.pdf" && docStore.sanitizeFilename("") === "document.pdf" &&
      docStore.sanitizeFilename("C:\\Users\\x\\facture.PDF") === "facture.PDF" && docStore.sanitizeFilename("x".repeat(300)).length <= 124);
    const pdf3 = Buffer.concat([Buffer.from("%PDF-1.4\n% grosse facture B\n"), Buffer.alloc(3 * 1024 * 1024, 0x20)]); // base64 ~4 Mo > 2 Mo (limite globale /api)

    for (const [m, u] of [["GET", "/api/documents"], ["GET", `/api/documents/${first.documentId}/file`], ["DELETE", `/api/documents/${first.documentId}`]]) {
      r = await http(b, m, u);
      check(`${m} ${u.replace(first.documentId, ":id")} sans JWT -> 401`, r.status === 401, r.json);
    }
    r = await http(b, "POST", "/api/documents", { body: { filename: "a.pdf", contentBase64: pdf3.toString("base64") } });
    check("POST /api/documents sans JWT (corps 4 Mo) -> 401, corps non lu", r.status === 401, r.status);
    r = await http(b, "GET", "/api/documents", { token: jwt(SHOP, { secret: "mauvais-secret" }) });
    check("  JWT signe avec un autre secret -> 401", r.status === 401, r.json);
    r = await http(b, "GET", "/api/documents", { token: jwt(SHOP, { exp: Math.floor(Date.now() / 1000) - 60 }) });
    check("  JWT expire -> 401", r.status === 401, r.json);
    r = await http(b, "GET", "/api/documents", { agentKey: AGENT_KEY });
    check("  la cle agent n'ouvre PAS /api/documents -> 401", r.status === 401, r.json);

    r = await api("GET", "/api/documents");
    check("GET /api/documents (JWT) -> metadonnees du document de la facture agent, sans chemin disque",
      r.status === 200 && r.json.documents.length === 1 && r.json.documents[0].id === first.documentId && r.json.documents[0].sha256 === sha256hex(pdfA) && !("path" in r.json.documents[0]) && !JSON.stringify(r.json).includes(DATA.replace(/\\/g, "/")), r.json);
    r = await api("GET", `/api/documents?purchaseOrderId=${first.purchaseOrder.id}`);
    check("  filtre purchaseOrderId", r.json.documents.length === 1);
    r = await api("GET", "/api/documents?purchaseOrderId=po_inexistant");
    check("  filtre purchaseOrderId inconnu -> 0", r.json.documents.length === 0);
    r = await api("GET", `/api/documents?supplierId=${first.supplierId}`);
    check("  filtre supplierId", r.json.documents.length === 1);

    r = await api("GET", `/api/documents/${first.documentId}/file`, { binary: true });
    const cd = r.headers.get("content-disposition") || "";
    check("GET .../file -> 200 application/pdf, Content-Disposition inline, no-store, nosniff, octets identiques",
      r.status === 200 && r.headers.get("content-type") === "application/pdf" && /^inline; filename="facture test\.pdf"/.test(cd) && /no-store/.test(r.headers.get("cache-control") || "") && r.headers.get("x-content-type-options") === "nosniff" && sha256hex(r.buf) === sha256hex(pdfA), [r.status, r.headers.get("content-type"), cd]);
    r = await api("GET", "/api/documents/..%2F..%2Fstock.json/file");
    check("  id avec traversee de dossier -> 404", r.status === 404, r.status);
    r = await api("GET", "/api/documents/doc_inconnu0000/file");
    check("  id inconnu -> 404", r.status === 404, r.status);

    // PO "ancien format" (sans invoice ni documentIds) : doit continuer a fonctionner
    const poYearFile = sdir("purchase-orders", fs.readdirSync(sdir("purchase-orders"))[0]);
    const poJson = JSON.parse(rd(poYearFile));
    for (const o of poJson.orders) if (o.id === po2.id) { delete o.invoice; delete o.documentIds; }
    fs.writeFileSync(poYearFile, JSON.stringify(poJson));
    r = await api("GET", `/api/purchase-orders/${po2.id}`);
    check("PO ancien format (sans invoice/documentIds) : GET detail -> 200", r.status === 200 && r.json.order.id === po2.id && r.json.order.documentIds === undefined && r.json.order.invoice === undefined, r.json);
    r = await api("GET", "/api/purchase-orders?limit=100");
    const apiFirst = r.json && r.json.orders && r.json.orders.find((o) => o.id === first.purchaseOrder.id);
    check("  GET /api/purchase-orders : liste OK ; le PO facture expose invoice + documentIds (pour l'icone trombone)", r.status === 200 && r.json.orders.some((o) => o.id === po2.id) && apiFirst && apiFirst.invoice.number === "FA-2026-0042" && apiFirst.documentIds[0] === first.documentId, r.json && r.json.stats);

    // Upload
    r = await api("POST", "/api/documents", { body: { purchaseOrderId: po2.id, filename: '../../evil"name<>.pdf', contentBase64: pdf3.toString("base64"), profileName: "Alice" } });
    const upB = r.json;
    check("POST /api/documents (PDF 3 Mo : > 2 Mo global, < 10 Mo) lie a un PO ancien format -> 200",
      r.status === 200 && upB.success === true && upB.deduped === false && upB.document.purchaseOrderId === po2.id && upB.document.supplierId === po2.supplierId && upB.document.createdBy === "Alice" && upB.document.size === pdf3.length, [r.status, upB]);
    check("  nom de fichier assaini (pas de / \\ \" < >)", !/[\\/"<>]/.test(upB.document.filename) && /\.pdf$/.test(upB.document.filename), upB.document.filename);
    check("  fichier sur disque + sha256 correct + PO.documentIds mis a jour", fs.existsSync(sdir("documents", `${upB.document.id}.pdf`)) && sha256hex(fs.readFileSync(sdir("documents", `${upB.document.id}.pdf`))) === sha256hex(pdf3) && poStore.getPurchaseOrder(SHOP, po2.id).documentIds.join() === upB.document.id);
    r = await api("POST", "/api/documents", { body: { purchaseOrderId: po2.id, filename: "encore.pdf", contentBase64: pdf3.toString("base64") } });
    check("  meme fichier renvoye -> deduped:true, meme document, pas de doublon dans documentIds", r.status === 200 && r.json.deduped === true && r.json.document.id === upB.document.id && poStore.getPurchaseOrder(SHOP, po2.id).documentIds.length === 1, r.json);
    r = await api("POST", "/api/documents", { body: { filename: "pas-un-pdf.pdf", contentBase64: Buffer.from("MZ pas un pdf").toString("base64") } });
    check("  non-PDF -> 400 invalid_pdf", r.status === 400 && r.json.error === "invalid_pdf", r.json);
    r = await api("POST", "/api/documents", { body: { filename: "x.pdf" } });
    check("  contentBase64 absent -> 400", r.status === 400, r.json);
    r = await api("POST", "/api/documents", { body: { purchaseOrderId: "po_inconnu", filename: "x.pdf", contentBase64: pdfA.toString("base64") } });
    check("  PO inconnu -> 404", r.status === 404, r.json);
    r = await api("POST", "/api/documents", { body: { supplierId: "sup_inconnu", filename: "x.pdf", contentBase64: pdfA.toString("base64") } });
    check("  fournisseur inconnu -> 404", r.status === 404, r.json);
    r = await api("POST", "/api/documents", { raw: JSON.stringify({ filename: "gros.pdf", contentBase64: "A".repeat(16 * 1024 * 1024) }), headers: { "Content-Type": "application/json" } });
    check("  corps > 15 Mo -> 413 payload_too_large", r.status === 413 && r.json && r.json.error === "payload_too_large", [r.status, r.json]);
    const stockBefore413 = rd(sdir("stock.json"));
    r = await api("POST", "/api/restock", { body: { productId: "301", grams: 1, note: "x".repeat(3 * 1024 * 1024) } });
    check("limite globale /api inchangee : autre route avec corps de 3 Mo -> refus (>= 400), stock inchange", r.status >= 400 && rd(sdir("stock.json")) === stockBefore413, r.status);
    console.log(`      (POST /api/restock 3 Mo : HTTP ${r.status})`);

    // Isolation entre boutiques + plan
    const jwtOther = jwt(OTHER_SHOP);
    r = await http(b, "GET", "/api/documents", { token: jwtOther });
    check("boutique sans plan Business -> 403 plan_limit", r.status === 403 && r.json.error === "plan_limit", r.json);
    fs.mkdirSync(path.join(DATA, OTHER_SHOP), { recursive: true });
    fs.writeFileSync(path.join(DATA, OTHER_SHOP, "plan.json"), JSON.stringify({ planId: "business", subscription: { id: "t2", status: "active" } }));
    r = await http(b, "GET", "/api/documents", { token: jwtOther });
    check("  autre boutique (Business) : liste vide, ne voit pas les documents de la premiere", r.status === 200 && r.json.documents.length === 0, r.json);
    r = await http(b, "GET", `/api/documents/${first.documentId}/file`, { token: jwtOther, binary: true });
    check("  fichier d'une autre boutique -> 404", r.status === 404, r.status);
    r = await http(b, "DELETE", `/api/documents/${first.documentId}`, { token: jwtOther });
    check("  suppression d'un document d'une autre boutique -> 404, document intact", r.status === 404 && fs.existsSync(pdfOnDisk), r.status);
    r = await http(b, "POST", "/api/documents", { token: jwtOther, body: { filename: "autre.pdf", contentBase64: pdfA.toString("base64") } });
    const otherDoc = r.json && r.json.document;
    check("  upload dans l'autre boutique : cree son propre document (meme contenu, pas de dedup entre boutiques)", r.status === 200 && r.json.deduped === false && otherDoc && otherDoc.id !== first.documentId && fs.existsSync(path.join(DATA, OTHER_SHOP, "documents", `${otherDoc.id}.pdf`)), r.json);

    // Suppression
    r = await api("DELETE", `/api/documents/${upB.document.id}`);
    check("DELETE /api/documents/:id -> 200, fichier + entree d'index supprimes, retire de PO.documentIds",
      r.status === 200 && !fs.existsSync(sdir("documents", `${upB.document.id}.pdf`)) && !JSON.parse(rd(sdir("documents.json"))).documents.some((d) => d.id === upB.document.id) && poStore.getPurchaseOrder(SHOP, po2.id).documentIds.length === 0, r.json);
    r = await api("DELETE", `/api/documents/${upB.document.id}`);
    check("  2e suppression -> 404 ; GET file -> 404", r.status === 404 && (await api("GET", `/api/documents/${upB.document.id}/file`, { binary: true })).status === 404);
    check("  le document de la facture agent est intact", fs.existsSync(pdfOnDisk) && sha256hex(fs.readFileSync(pdfOnDisk)) === sha256hex(pdfA));

    // =========================================================
    // BLOC 4 : webhooks (RGPD)
    // =========================================================
    console.log("--- 4. webhooks shop/redact et app/uninstalled ---");
    const hook = (topic, shop) => http(b, "POST", `/webhooks/${topic}`, { raw: "{}", headers: { "Content-Type": "application/json", "X-Shopify-Shop-Domain": shop } });
    r = await hook("shop/redact", OTHER_SHOP);
    check("shop/redact (autre boutique) -> 200 ; son dossier documents/ ET documents.json sont effaces",
      r.status === 200 && !fs.existsSync(path.join(DATA, OTHER_SHOP, "documents")) && !fs.existsSync(path.join(DATA, OTHER_SHOP, "documents.json")), r.status);
    check("  les documents de la premiere boutique ne sont pas touches", fs.existsSync(pdfOnDisk) && fs.existsSync(sdir("documents.json")));
    r = await hook("app/uninstalled", SHOP);
    check("app/uninstalled ne supprime PAS les factures (pieces comptables, effacement seulement sur shop/redact)", fs.existsSync(pdfOnDisk) && fs.existsSync(sdir("documents.json")), r.status);
    r = await hook("shop/redact", SHOP);
    check("shop/redact (premiere boutique) -> documents/ et documents.json effaces, meme si la suite de la purge echoue", !fs.existsSync(sdir("documents")) && !fs.existsSync(sdir("documents.json")), r.status);
    console.log(`      (shop/redact d'une boutique avec mouvements : HTTP ${r.status} - purgeShopData leve avec Node ${process.version} : fs.rmdirSync({recursive}) de movementStore.clearShopMovements n'existe plus ; bug existant, hors perimetre)`);
  } catch (e) {
    fail++;
    console.error("ECHEC INATTENDU", e.stack);
  } finally {
    for (const s of servers) await s.stop();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nRESULTAT : ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();

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
  for (const k of ["AGENT_API_KEY", "AGENT_SHOP", "AGENT_API_RATE_LIMIT_PER_MIN", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "API_AUTH_REQUIRED", "SHOP_NAME"]) delete env[k];
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
    fs.writeFileSync(path.join(shopDir, "plan.json"), JSON.stringify({ planId: "business", subscription: { id: "test", status: "active" } }));

    const S = await startServer({ SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET, AGENT_API_KEY: AGENT_KEY, AGENT_SHOP: SHOP, AGENT_API_RATE_LIMIT_PER_MIN: "500" });
    servers.push(S);
    const b = S.base;
    const T = jwt();
    const api = (m, u, o = {}) => http(b, m, u, { token: T, ...o });
    const ctx = { S, b, T, api, check, near };

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

    // ---- BLOCS SUIVANTS (factures) ----
    // @@BLOCKS@@
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

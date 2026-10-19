// Test local de l'API agent (/agent/v1) : spawn server.js sur un port libre avec un DATA_DIR temporaire.
// Usage : node scripts/agent-api-test.js [chemin/vers/server.js]
//   (AGENT_TEST_TMP=<dossier> pour choisir ou creer le DATA_DIR temporaire ; defaut : os.tmpdir())
// Bruit attendu : "Aucun token OAuth" / inventory_push_error (pas de token Shopify en local) :
//   le reappro doit reussir quand meme (inventorySync.ok=false). Aucun appel Shopify reel n'est possible.
// Limite : l'import de bout en bout (lecture produit Shopify) n'est pas testable en local ;
//   on teste sa validation (400), le refus 409 "deja importe" et l'echec propre sans token (502).
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SERVER = process.argv[2] || path.join(REPO, "server.js");
const SHOP = "test-shop.myshopify.com";
const KEY = crypto.randomBytes(32).toString("hex"); // 64 hex
const ROOT = fs.mkdtempSync(path.join(process.env.AGENT_TEST_TMP || os.tmpdir(), "agent-api-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== undefined ? "  -> " + JSON.stringify(detail) : ""}`);
}

// ---------- seed (DATA_DIR pose AVANT de require les stores) ----------
const DATA_A = path.join(ROOT, "data-a");
fs.mkdirSync(DATA_A, { recursive: true });
process.env.DATA_DIR = DATA_A;
const stock = require(path.join(REPO, "stockManager.js"));
const overrides = require(path.join(REPO, "productOverridesStore.js"));
stock.upsertImportedProductConfig(SHOP, {
  productId: "111",
  name: "Fleur A",
  totalGrams: 100,
  variants: {
    3: { gramsPerUnit: 3, inventoryItemId: 9001, variantId: "5001" },
    5: { gramsPerUnit: 5, inventoryItemId: 9002, variantId: "5002" },
  },
});
stock.setAverageCostPerGram(SHOP, "111", 1); // CMP de depart : 1 EUR/g
stock.upsertImportedProductConfig(SHOP, {
  productId: "222",
  name: "Archive B",
  totalGrams: 50,
  variants: { 1: { gramsPerUnit: 1, inventoryItemId: 9100, variantId: "6001" } },
});
overrides.setOverride(SHOP, "222", { archived: true });

// ---------- helpers serveur ----------
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

async function startServer(extraEnv, dataDir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), NODE_ENV: "production", DATA_DIR: dataDir };
  for (const k of ["AGENT_API_KEY", "AGENT_SHOP", "AGENT_API_RATE_LIMIT_PER_MIN", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "API_AUTH_REQUIRED"]) delete env[k];
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

async function call(base, method, url, { key, body, raw, headers } = {}) {
  const h = { ...(headers || {}) };
  if (key !== undefined) h["X-Agent-Key"] = key;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  const r = await fetch(base + url, { method, headers: h, body: payload });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, headers: r.headers, json };
}

// ---------- helpers disque ----------
const shopDir = (dataDir) => path.join(dataDir, SHOP);
const readStockFile = () => fs.readFileSync(path.join(shopDir(DATA_A), "stock.json"), "utf8");
const readProduct = (pid) => JSON.parse(readStockFile()).products[pid];
function readMovements(shop = SHOP) {
  const dir = path.join(shopDir(DATA_A).replace(SHOP, shop), "movements");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}
const readImportMovements = (shop) => readMovements(shop).filter((m) => m.source === "import_shopify_product");
const restockMovements = () => readMovements().filter((m) => m.source === "restock");
const agentRequestsPath = path.join(shopDir(DATA_A), "agent-requests.json");
const near = (a, b) => Math.abs(a - b) < 1e-9;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

(async () => {
  const servers = [];
  try {
    // =========================================================
    // Serveur A : cle valide + boutique configuree
    // =========================================================
    const A = await startServer({ AGENT_API_KEY: KEY, AGENT_SHOP: SHOP, AGENT_API_RATE_LIMIT_PER_MIN: "200" }, DATA_A);
    servers.push(A);
    const b = A.base;
    console.log("--- A : cle + boutique ---");

    let r = await call(b, "GET", "/agent/v1/products");
    check("sans cle -> 401", r.status === 401, r);
    r = await call(b, "GET", "/agent/v1/products", { key: "x".repeat(64) });
    check("mauvaise cle -> 401", r.status === 401, r);
    r = await call(b, "GET", "/agent/v1/products", { key: KEY.slice(0, 63) });
    check("cle tronquee -> 401", r.status === 401, r);

    r = await call(b, "GET", "/agent/v1/products", { key: KEY });
    const p111 = r.json && r.json.products && r.json.products.find((p) => p.productId === "111");
    const p222 = r.json && r.json.products && r.json.products.find((p) => p.productId === "222");
    check("GET products -> 200 + produit seed", r.status === 200 && !!p111, r);
    check("  produit 111 : nom, 100 g, CMP 1, 2 variantes (variantId, inventoryItemId)",
      p111 && p111.name === "Fleur A" && p111.totalGrams === 100 && near(p111.averageCostPerGram, 1) && p111.archived === false &&
      p111.variants.length === 2 && p111.variants[0].grams === 3 && p111.variants[0].variantId === "5001" && p111.variants[0].inventoryItemId === 9001, p111);
    check("  produit 222 : archived=true", p222 && p222.archived === true, p222);
    check("  header RateLimit-Limit = 200 (override env)", r.headers.get("ratelimit-limit") === "200", r.headers.get("ratelimit-limit"));
    r = await call(b, "GET", "/agent/v1/products?q=fleur", { key: KEY });
    check("  filtre ?q=fleur", r.status === 200 && r.json.count === 1, r.json);

    // ---- dryRun : aucune ecriture
    const stockHash0 = sha(readStockFile());
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, body: { productId: "111", grams: 100, purchasePricePerGram: 2, requestId: "dry-run-0001", dryRun: true } });
    check("restock dryRun -> 200 {before 100, after 200, cmpBefore 1, cmpAfterEstimate 1.5}",
      r.status === 200 && r.json.dryRun === true && r.json.totalGramsBefore === 100 && r.json.totalGramsAfter === 200 &&
      near(r.json.cmpBefore, 1) && near(r.json.cmpAfterEstimate, 1.5), r);
    check("  dryRun : stock.json inchange, aucun mouvement, aucun agent-requests.json",
      sha(readStockFile()) === stockHash0 && readMovements().length === 0 && !fs.existsSync(agentRequestsPath));
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, body: { productId: "111", grams: 10, purchasePricePerGram: 2, dryRun: true } });
    check("  dryRun sans requestId accepte", r.status === 200, r);

    // ---- restock reel
    const body = { productId: "111", grams: 100, purchasePricePerGram: 2, supplier: "Fournisseur Test", invoice: "FA-2026-001", note: "test agent", requestId: "req-restock-0001" };
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, body });
    const first = r.json;
    check("restock 100 g @ 2.00 -> 200", r.status === 200 && first.success === true && first.replayed === undefined, r);
    check("  reponse : total 200, CMP 1.5, movementId", first && first.totalGramsAfter === 200 && near(first.cmpAfter, 1.5) && !!first.movementId, first);
    check("  inventorySync.ok=false (pas de token Shopify local) sans faire echouer le reappro", first && first.inventorySync && first.inventorySync.ok === false, first && first.inventorySync);
    const disk1 = readProduct("111");
    check("  disque : totalGrams 200 et CMP 1.5", disk1.totalGrams === 200 && near(disk1.averageCostPerGram, 1.5), disk1);
    let mvs = restockMovements();
    check("  1 mouvement restock avec meta.invoice/supplier/requestId/via", mvs.length === 1 && mvs[0].meta.invoice === "FA-2026-001" &&
      mvs[0].meta.supplier === "Fournisseur Test" && mvs[0].meta.requestId === "req-restock-0001" && mvs[0].meta.via === "agent-api" && mvs[0].meta.note === "test agent", mvs);
    check("  mouvement : +100 g, 2 EUR/g, cmpBefore 1, totalAfter 200, profil 'Agent Hermes'",
      mvs[0] && mvs[0].gramsDelta === 100 && mvs[0].purchasePricePerGram === 2 && near(mvs[0].cmpBefore, 1) && mvs[0].totalAfter === 200 && mvs[0].profileName === "Agent Hermes" && !!mvs[0].profileColor, mvs[0]);
    const reqFile = JSON.parse(fs.readFileSync(agentRequestsPath, "utf8"));
    check("  agent-requests.json : 1 entree avec le resultat, pas de .tmp restant",
      reqFile.entries.length === 1 && reqFile.entries[0].requestId === "req-restock-0001" && reqFile.entries[0].result.movementId === first.movementId && !fs.existsSync(agentRequestsPath + ".tmp"), reqFile);

    // ---- rejeu
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, body });
    check("rejeu meme requestId -> 200 replayed:true, meme movementId", r.status === 200 && r.json.replayed === true && r.json.movementId === first.movementId, r);
    check("  total inchange (200), toujours 1 mouvement", readProduct("111").totalGrams === 200 && restockMovements().length === 1);
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, body: { ...body, grams: 50 } });
    check("meme requestId + contenu different -> 409 request_id_conflict", r.status === 409 && r.json.error === "request_id_conflict", r);

    // ---- concurrence : 2 requetes simultanees, meme requestId, prix 0 (CMP inchange)
    const cbody = { productId: "111", grams: 10, purchasePricePerGram: 0, requestId: "req-concurrent-01" };
    const [c1, c2] = await Promise.all([call(b, "POST", "/agent/v1/restock", { key: KEY, body: cbody }), call(b, "POST", "/agent/v1/restock", { key: KEY, body: cbody })]);
    const replayedCount = [c1, c2].filter((x) => x.json && x.json.replayed === true).length;
    check("2 requetes simultanees meme requestId -> 200/200 dont 1 replayed", c1.status === 200 && c2.status === 200 && replayedCount === 1, [c1.json, c2.json]);
    const disk2 = readProduct("111");
    check("  stock applique UNE seule fois (210 g), CMP inchange (prix 0)", disk2.totalGrams === 210 && near(disk2.averageCostPerGram, 1.5) && restockMovements().length === 2, disk2);

    // ---- validations
    const base0 = { productId: "111", grams: 5, purchasePricePerGram: 1, requestId: "req-valid-00001" };
    const bad = async (name, over, status, errCode) => {
      const rr = await call(b, "POST", "/agent/v1/restock", { key: KEY, body: { ...base0, ...over } });
      check(name, rr.status === status && (!errCode || rr.json.error === errCode), rr);
    };
    await bad("grams=0 -> 400", { grams: 0 }, 400, "invalid_grams");
    await bad("grams=20001 -> 400", { grams: 20001 }, 400, "invalid_grams");
    await bad("grams='abc' -> 400", { grams: "abc" }, 400, "invalid_grams");
    await bad("grams negatif -> 400", { grams: -5 }, 400, "invalid_grams");
    await bad("prix negatif -> 400", { purchasePricePerGram: -1 }, 400, "invalid_price");
    await bad("prix > 50 -> 400", { purchasePricePerGram: 51 }, 400, "invalid_price");
    await bad("prix absent -> 400", { purchasePricePerGram: undefined }, 400, "invalid_price");
    await bad("requestId absent -> 400", { requestId: undefined }, 400, "invalid_request_id");
    await bad("requestId trop court (<8) -> 400", { requestId: "short" }, 400, "invalid_request_id");
    await bad("productId inconnu -> 404 (jamais auto-cree)", { productId: "424242" }, 404, "product_not_found");
    await bad("produit archive -> 409", { productId: "222" }, 409, "product_archived");
    check("  aucune de ces requetes n'a modifie le stock", readProduct("111").totalGrams === 210 && !readProduct("424242") && readProduct("222").totalGrams === 50);
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, raw: "{pas du json", headers: { "Content-Type": "application/json" } });
    check("JSON invalide -> 400 invalid_json", r.status === 400 && r.json.error === "invalid_json", r);
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, raw: "productId=111", headers: { "Content-Type": "text/plain" } });
    check("mauvais Content-Type -> 400 invalid_body", r.status === 400 && r.json.error === "invalid_body", r);
    r = await call(b, "POST", "/agent/v1/restock", { key: KEY, raw: JSON.stringify({ ...base0, note: "x".repeat(120000) }), headers: { "Content-Type": "application/json" } });
    check("corps > 100 ko -> 413", r.status === 413, r);

    // ---- import : validation seulement
    r = await call(b, "POST", "/agent/v1/import", { key: KEY, body: { requestId: "req-import-0001" } });
    check("import sans productId -> 400", r.status === 400 && r.json.error === "invalid_product_id", r);
    r = await call(b, "POST", "/agent/v1/import", { key: KEY, body: { productId: "abc", requestId: "req-import-0001" } });
    check("import productId non numerique -> 400", r.status === 400, r);
    r = await call(b, "POST", "/agent/v1/import", { key: KEY, body: { productId: "111" } });
    check("import sans requestId -> 400", r.status === 400 && r.json.error === "invalid_request_id", r);
    r = await call(b, "POST", "/agent/v1/import", { key: KEY, body: { productId: "111", requestId: "req-import-0002" } });
    check("import produit deja dans l'app -> 409 + produit existant", r.status === 409 && r.json.error === "already_imported" && r.json.product.productId === "111" && r.json.product.totalGrams === 210, r);
    check("  rien n'est stocke pour un 409 (agent-requests.json : que des entrees restock)", JSON.parse(fs.readFileSync(agentRequestsPath, "utf8")).entries.every((e) => e.route === "restock"));
    r = await call(b, "POST", "/agent/v1/import", { key: KEY, body: { productId: "777", categoryIds: ["nope"], requestId: "req-import-0003" } });
    check("import categorie inconnue -> 400 unknown_category", r.status === 400 && r.json.error === "unknown_category", r);
    r = await call(b, "POST", "/agent/v1/import", { key: KEY, body: { productId: "777", requestId: "req-import-0004" } });
    check("import produit neuf sans token Shopify local -> 502 propre (ou 403 limite de plan), catalogue intact",
      (r.status === 502 || r.status === 403) && !!r.json.error && !readProduct("777"), r);
    console.log(`      (import produit neuf local : HTTP ${r.status} ${r.json && r.json.error})`);

    // ---- divers
    r = await call(b, "GET", "/agent/v1/nope", { key: KEY });
    check("route inconnue -> 404 JSON", r.status === 404 && r.json.error === "not_found", r);
    r = await call(b, "GET", "/api/products");
    check("route existante GET /api/products sans JWT -> 401 (inchange)", r.status === 401, r);
    r = await call(b, "GET", "/api/stock");
    check("route existante GET /api/stock sans JWT -> 401 (inchange)", r.status === 401, r);
    r = await call(b, "POST", "/api/restock", { body: { productId: "111", grams: 1 } });
    check("POST /api/restock sans JWT -> 401 (inchange)", r.status === 401, r);
    r = await call(b, "GET", "/api/products", { key: KEY });
    check("/api n'accepte PAS X-Agent-Key -> 401", r.status === 401, r);
    r = await call(b, "GET", "/health");
    check("GET /health OK", r.status === 200);
    check("la cle n'apparait jamais dans les logs", !A.logs().includes(KEY));

    // =========================================================
    // Serveur B : AGENT_API_KEY absente -> 404 partout
    // =========================================================
    console.log("--- B : AGENT_API_KEY absente ---");
    const DATA_B = path.join(ROOT, "data-b");
    const B = await startServer({ AGENT_SHOP: SHOP }, DATA_B);
    servers.push(B);
    r = await call(B.base, "GET", "/agent/v1/products", { key: KEY });
    check("GET products -> 404 (fonction desactivee)", r.status === 404, r);
    r = await call(B.base, "POST", "/agent/v1/restock", { key: KEY, body: { productId: "111", grams: 1, purchasePricePerGram: 1, requestId: "req-disabled-01" } });
    check("POST restock -> 404", r.status === 404, r);
    r = await call(B.base, "POST", "/agent/v1/import", { body: {} });
    check("POST import sans cle -> 404 aussi", r.status === 404, r);
    r = await call(B.base, "GET", "/api/products");
    check("/api toujours protegee -> 401", r.status === 401, r);

    // Cle trop courte (< 32) -> 404 aussi
    const SHORT = "a".repeat(31);
    const C = await startServer({ AGENT_API_KEY: SHORT, AGENT_SHOP: SHOP }, DATA_B);
    servers.push(C);
    r = await call(C.base, "GET", "/agent/v1/products", { key: SHORT });
    check("cle de 31 caracteres -> 404 (desactive)", r.status === 404, r);

    // =========================================================
    // Serveur D : cle ok, AGENT_SHOP absent -> 503 ; limite par defaut 30
    // =========================================================
    console.log("--- D : AGENT_SHOP absent ---");
    const D = await startServer({ AGENT_API_KEY: KEY }, DATA_B);
    servers.push(D);
    r = await call(D.base, "GET", "/agent/v1/products");
    check("sans cle -> 401 (avant le controle boutique)", r.status === 401, r);
    r = await call(D.base, "GET", "/agent/v1/products", { key: KEY, headers: { "X-Shopify-Shop-Domain": SHOP } });
    check("cle ok mais AGENT_SHOP absent -> 503 (la boutique n'est jamais lue dans la requete)", r.status === 503 && r.json.error === "agent_shop_not_configured", r);
    r = await call(D.base, "GET", `/agent/v1/products?shop=${SHOP}`, { key: KEY });
    check("  ?shop= ignore -> toujours 503", r.status === 503, r);
    check("  limite par defaut = 30/min", r.headers.get("ratelimit-limit") === "30", r.headers.get("ratelimit-limit"));

    // =========================================================
    // Serveur E : limite 5/min -> 429 a la 6e requete
    // =========================================================
    console.log("--- E : rate limit ---");
    const E = await startServer({ AGENT_API_KEY: KEY, AGENT_SHOP: SHOP, AGENT_API_RATE_LIMIT_PER_MIN: "5" }, DATA_B);
    servers.push(E);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(E.base, "GET", "/agent/v1/products", { key: KEY })).status);
    check("5 requetes passent, la 6e -> 429", statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429, statuses);

    // =========================================================
    // F : import de bout en bout avec Shopify SIMULE (in-process, deps injectees).
    // Le vrai server.js ne peut pas lire un produit Shopify en local (pas de token) : on exerce
    // agentApi.js seul, avec le vrai stockManager/movementStore, et un Shopify + planManager factices.
    // =========================================================
    console.log("--- F : import avec Shopify simule (in-process) ---");
    const express = require("express");
    const { registerAgentRoutes } = require(path.join(REPO, "agentApi.js"));
    const movementStore = require(path.join(REPO, "movementStore.js"));
    const SHOP_F = "import-shop.myshopify.com";
    const shopifyProducts = {
      "9001": { id: 9001, title: "Fleur Importee", handle: "fleur-importee", variants: [
        { id: 70001, inventory_item_id: 80001, grams: 3 }, { id: 70002, inventory_item_id: 80002, grams: 10 }, { id: 70003, inventory_item_id: 80003, grams: 0, title: "Default" }] },
      "9002": { id: 9002, title: "Accessoire sans poids", variants: [{ id: 71001, inventory_item_id: 81001, grams: 0, title: "Default Title" }] },
      "9003": { id: 9003, title: "Fleur 1,5 g", handle: "fleur-15", variants: [{ id: 72001, inventory_item_id: 82001, grams: 2, title: "1,5", option1: "1,5" }, { id: 72002, inventory_item_id: 82002, grams: 3, title: "3", option1: "3" }, { id: 72003, inventory_item_id: 82003, grams: 30, title: "25", option1: "25" }] },
    };
    let pushes = [];
    let planAllowed = true;
    let shopifyError = null;
    const fakeDeps = {
      stock, movementStore,
      productOverridesStore: overrides,
      planManager: { checkLimit: (shop, action) => (planAllowed ? { allowed: true } : { allowed: false, reason: "limite", upgrade: "starter" }) },
      getShopifyProduct: async (shop, id) => { if (shopifyError) throw shopifyError; return shopifyProducts[String(id)] || null; },
      parseGramsFromVariant: (v) => (Number(v.grams) > 0 ? Number(v.grams) : null),
      pushProductInventoryToShopify: async (shop, view) => { pushes.push({ shop, productId: view.productId, canSell: Object.values(view.variants).map((x) => x.canSell) }); },
      logEvent: () => {},
      normalizeShopDomain: (s) => (String(s).endsWith(".myshopify.com") ? String(s) : s + ".myshopify.com"),
      dataDir: DATA_A,
      env: { AGENT_API_KEY: KEY, AGENT_SHOP: SHOP_F, AGENT_API_RATE_LIMIT_PER_MIN: "200" },
    };
    const fApp = express();
    registerAgentRoutes(fApp, fakeDeps);
    const fServer = await new Promise((res) => { const s = fApp.listen(0, "127.0.0.1", () => res(s)); });
    servers.push({ stop: async () => fServer.close() });
    const fb = `http://127.0.0.1:${fServer.address().port}`;
    const fcall = (m, u, body) => call(fb, m, u, { key: KEY, body });
    const fStock = () => stock.getCatalogSnapshot(SHOP_F).products;

    r = await fcall("POST", "/agent/v1/import", { productId: "9001", requestId: "imp-dry-00001", dryRun: true });
    check("import dryRun -> 200, variantes detectees (2), rien ecrit", r.status === 200 && r.json.dryRun === true && r.json.variants.length === 2 &&
      r.json.product.name === "Fleur Importee" && fStock().length === 0 && pushes.length === 0, r);
    r = await fcall("POST", "/agent/v1/import", { productId: "9001", requestId: "imp-real-00001", categoryIds: [] });
    check("import reel -> 200, produit cree (0 g), 2 variantes avec variantId/inventoryItemId",
      r.status === 200 && r.json.success === true && r.json.product.totalGrams === 0 && r.json.product.variants.length === 2 &&
      r.json.product.variants[0].variantId === "70001" && r.json.product.variants[0].inventoryItemId === 80001, r);
    check("  catalogue : produit 9001 present ; push Shopify appele 1 fois ; inventorySync.ok", fStock().length === 1 && fStock()[0].productId === "9001" && pushes.length === 1 && r.json.inventorySync.ok === true, pushes);
    const impMv = readImportMovements(SHOP_F);
    check("  mouvement import_shopify_product avec meta.via/requestId", impMv.length === 1 && impMv[0].meta.via === "agent-api" && impMv[0].meta.requestId === "imp-real-00001" && impMv[0].profileName === "Agent Hermes", impMv);
    r = await fcall("POST", "/agent/v1/import", { productId: "9001", requestId: "imp-real-00001", categoryIds: [] });
    check("  rejeu -> replayed:true, pas de 2e push ni de 2e mouvement", r.status === 200 && r.json.replayed === true && pushes.length === 1 && readImportMovements(SHOP_F).length === 1, r);
    r = await fcall("POST", "/agent/v1/import", { productId: "9001", requestId: "imp-real-00002" });
    {
      const r15 = await fcall("POST", "/agent/v1/import", { productId: "9003", requestId: "imp-15g-000001", dryRun: true });
      const gs = JSON.stringify(r15.json);
      check("import : variante \"1,5\" (REST grams=2) gardee a 1,5 g ; 25 g pese 30 g laisse a 30 (donnee Shopify)", r15.status === 200 && gs.includes("1.5") && !gs.includes('"gramsPerUnit":2') && gs.includes("30"), r15.json);
    }
    check("  nouvel appel (autre requestId) -> 409 already_imported, pas de re-import", r.status === 409 && r.json.error === "already_imported" && pushes.length === 1, r);
    r = await fcall("POST", "/agent/v1/restock", { productId: "9001", grams: 30, purchasePricePerGram: 4, invoice: "FA-IMPORT-1", requestId: "imp-restock-0001" });
    check("  puis restock du produit importe : 30 g, CMP 4, push avec canSell [10,3]", r.status === 200 && r.json.totalGramsAfter === 30 && near(r.json.cmpAfter, 4) && pushes.length === 2 &&
      JSON.stringify(pushes[1].canSell) === JSON.stringify([10, 3]) && r.json.inventorySync.ok === true, [r.json, pushes[1]]);
    r = await fcall("POST", "/agent/v1/import", { productId: "9999", requestId: "imp-notfound-01" });
    check("produit Shopify introuvable (null) -> 404 shopify_product_not_found", r.status === 404 && r.json.error === "shopify_product_not_found", r);
    r = await fcall("POST", "/agent/v1/import", { productId: "9002", requestId: "imp-nograms-001" });
    check("produit sans variante avec grammage -> 400 no_grams_variant, rien cree", r.status === 400 && r.json.error === "no_grams_variant" && fStock().length === 1, r);
    shopifyError = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    r = await fcall("POST", "/agent/v1/import", { productId: "9003", requestId: "imp-auth-00001" });
    check("erreur Shopify 401 -> 502 shopify_auth_error (pas de 401 agent, pas de purge de token)", r.status === 502 && r.json.error === "shopify_auth_error", r);
    shopifyError = null;
    planAllowed = false;
    r = await fcall("POST", "/agent/v1/import", { productId: "9002", requestId: "imp-plan-000001" });
    check("limite de plan -> 403 plan_limit", r.status === 403 && r.json.error === "plan_limit", r);
    planAllowed = true;
    overrides.setOverride(SHOP_F, "9001", { archived: true });
    r = await fcall("POST", "/agent/v1/restock", { productId: "9001", grams: 5, purchasePricePerGram: 1, requestId: "imp-archived-002" });
    check("produit archive apres import -> restock 409", r.status === 409 && r.json.error === "product_archived", r);

    console.log("--- logs serveur A (extrait) ---");
    console.log(A.logs().split("\n").filter((l) => /agent_api|inventory_push_error|Aucun token/.test(l)).slice(0, 10).map((l) => "  " + l.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 170)).join("\n"));
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

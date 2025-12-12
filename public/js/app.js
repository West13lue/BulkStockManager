// ============================================
// BULK STOCK MANAGER - Front (Admin UI)
// ============================================
// - Contrôles catalog (tri/filtre/import/export)
// - Produits groupés par catégorie
// - Modal produit : variantes lisibles + catégories + historique + ajuster stock (unités)
// - Modals Import/Catégories avec backdrop
// ============================================

// --------------------------------------------
// DOM refs
// --------------------------------------------
const result = document.getElementById("result");

let stockData = {};       // map: { [productId]: { name, totalGrams, variants, categoryIds } }
let catalogData = null;   // { products:[], categories:[] }
let categories = [];      // [{id,name}]
let serverInfo = {};
let currentProductId = null;

let currentCategoryFilter = "";
let sortAlpha = true; // default A->Z

// --------------------------------------------
// Utils
// --------------------------------------------
function qs(sel) { return document.querySelector(sel); }
function el(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function log(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString("fr-FR");
  if (!result) return;
  result.textContent = `[${timestamp}] ${message}`;
  result.className = "result-content " + type;
  result.scrollTop = result.scrollHeight;
}

function fmtDateFR(iso) {
  try { return new Date(iso).toLocaleString("fr-FR"); }
  catch { return String(iso || ""); }
}

function fmtDelta(delta) {
  const n = Number(delta || 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}g`;
}

function deltaBadge(delta) {
  const n = Number(delta || 0);
  if (n > 0) return "✅";
  if (n < 0) return "🔻";
  return "•";
}

function catNameById(cid) {
  return categories.find(c => String(c.id) === String(cid))?.name || null;
}

// --------------------------------------------
// Backdrop pour les modals (Import/Catégories)
// --------------------------------------------
function ensureModalBackdrop(modalEl, onClose) {
  if (!modalEl) return;

  // Backdrop déjà présent ?
  if (modalEl.querySelector(".modal-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.addEventListener("click", () => {
    modalEl.classList.remove("active");
    if (typeof onClose === "function") onClose();
  });

  // Si le contenu est directement .modal-content (sans panel), on le wrap
  const content = modalEl.querySelector(".modal-content");
  if (content && !content.closest(".modal-panel")) {
    const panel = document.createElement("div");
    panel.className = "modal-panel";
    content.parentNode.insertBefore(panel, content);
    panel.appendChild(content);
  }

  modalEl.insertBefore(backdrop, modalEl.firstChild);
}

// --------------------------------------------
// Contrôles du header (tri/filtre/import/export)
// --------------------------------------------
function ensureCatalogControls() {
  const header = document.querySelector(".header");
  if (!header) return;
  if (document.getElementById("catalogControls")) return;

  const wrap = document.createElement("div");
  wrap.id = "catalogControls";
  wrap.className = "catalog-controls";

  wrap.innerHTML = `
    <div class="catalog-row">
      <div class="field">
        <label>Catégorie</label>
        <select id="categoryFilter">
          <option value="">Toutes</option>
        </select>
      </div>

      <div class="field">
        <label>Tri</label>
        <select id="sortMode">
          <option value="alpha">A → Z</option>
          <option value="none">Par défaut</option>
        </select>
      </div>

      <div class="catalog-actions">
        <button class="btn btn-secondary btn-sm" id="btnCategories">📁 Catégories</button>
        <button class="btn btn-primary btn-sm" id="btnImport">➕ Import Shopify</button>
        <button class="btn btn-info btn-sm" id="btnExportStock"⬇️ Stock CSV</button>
        <button class="btn btn-secondary btn-sm" id="btnExportMovements">⬇️ Mouvements CSV</button>
      </div>
    </div>
  `;
  header.appendChild(wrap);

  el("categoryFilter")?.addEventListener("change", async (e) => {
    currentCategoryFilter = e.target.value || "";
    await refreshStock();
  });

  el("sortMode")?.addEventListener("change", async (e) => {
    sortAlpha = e.target.value === "alpha";
    await refreshStock();
  });

  el("btnImport")?.addEventListener("click", openImportModal);
  el("btnCategories")?.addEventListener("click", openCategoriesModal);

  el("btnExportStock")?.addEventListener("click", () => {
    window.location.href = "/api/stock.csv";
  });

  el("btnExportMovements")?.addEventListener("click", () => {
    window.location.href = "/api/movements.csv";
  });
}

function updateCategoryFilterOptions() {
  const sel = el("categoryFilter");
  if (!sel) return;

  const current = sel.value;
  sel.innerHTML =
    `<option value="">Toutes</option>` +
    categories
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }))
      .map(c => `<option value="${escapeHtml(String(c.id))}">${escapeHtml(String(c.name))}</option>`)
      .join("");

  if (current) sel.value = current;
}

// --------------------------------------------
// Server info
// --------------------------------------------
async function getServerInfo() {
  try {
    const res = await fetch("/api/server-info");
    serverInfo = await res.json();

    const badge = el("serverStatus");
    const mode = el("serverMode");
    const count = el("productCount");

    if (badge) {
      badge.classList.remove("online", "dev");
      badge.classList.add("online");
      badge.innerHTML = `🟢 En ligne`;
    }
    if (mode) mode.textContent = serverInfo.mode || "development";
    if (count) count.textContent = serverInfo.productCount ?? "0";
  } catch (err) {
    log("❌ Impossible de récupérer les infos serveur: " + err.message, "error");
  }
}

// --------------------------------------------
// Stock
// --------------------------------------------
async function refreshStock() {
  ensureCatalogControls();
  log("⏳ Actualisation du stock...", "info");

  try {
    const url = new URL(window.location.origin + "/api/stock");
    if (sortAlpha) url.searchParams.set("sort", "alpha");
    if (currentCategoryFilter) url.searchParams.set("category", currentCategoryFilter);

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();

    // Nouveau format
    if (data && Array.isArray(data.products)) {
      catalogData = data;
      categories = Array.isArray(data.categories) ? data.categories : [];

      const map = {};
      for (const p of data.products) {
        map[String(p.productId)] = {
          name: p.name,
          totalGrams: p.totalGrams,
          variants: p.variants || {},
          categoryIds: p.categoryIds || [],
        };
      }
      stockData = map;

      updateCategoryFilterOptions();
      displayProducts(stockData);
      updateStats(stockData);

      log("✅ Stock actualisé (catalog)\n\n" + JSON.stringify(data, null, 2), "success");
      return;
    }

    // Legacy format
    stockData = data || {};
    displayProducts(stockData);
    updateStats(stockData);

    log("✅ Stock actualisé\n\n" + JSON.stringify(stockData, null, 2), "success");
  } catch (err) {
    log("❌ ERREUR: " + err.message, "error");
  }
}

function updateStats(stock) {
  const products = Object.values(stock || {});
  const totalProducts = products.length;
  const totalGrams = products.reduce((acc, p) => acc + Number(p.totalGrams || 0), 0);

  el("statProducts") && (el("statProducts").textContent = totalProducts);
  el("statGrams") && (el("statGrams").textContent = `${totalGrams}g`);
  el("lastUpdate") && (el("lastUpdate").textContent = new Date().toLocaleString("fr-FR"));
}

// --------------------------------------------
// Produits groupés par catégorie (affichage principal)
// --------------------------------------------
function displayProducts(stock) {
  const productList = el("productList");
  if (!productList) return;

  const entries = Object.entries(stock || {});
  if (!entries.length) {
    productList.innerHTML = `<div style="text-align:center; padding:40px; color:#a0aec0;">Aucun produit configuré</div>`;
    return;
  }

  const groups = {};          // { catId: [[id, product], ...] }
  const uncategorized = [];   // [[id, product], ...]

  for (const [id, product] of entries) {
    const ids = Array.isArray(product.categoryIds) ? product.categoryIds : [];
    if (!ids.length) {
      uncategorized.push([id, product]);
      continue;
    }
    for (const cid of ids) {
      const key = String(cid);
      if (!groups[key]) groups[key] = [];
      groups[key].push([id, product]);
    }
  }

  const sortedCatIds = Object.keys(groups).sort((a, b) => {
    const an = String(catNameById(a) || "").toLowerCase();
    const bn = String(catNameById(b) || "").toLowerCase();
    return an.localeCompare(bn, "fr", { sensitivity: "base" });
  });

  const sortEntries = (arr) => arr.slice().sort((A, B) => {
    const a = String(A[1]?.name || "");
    const b = String(B[1]?.name || "");
    return a.localeCompare(b, "fr", { sensitivity: "base" });
  });

  function renderProductCard(id, product) {
    const total = Number(product.totalGrams || 0);
    const percent = Math.max(0, Math.min(100, Math.round((total / 200) * 100)));
    const lowClass = total <= Number(serverInfo?.lowStockThreshold || 10) ? " low" : "";

    const cats = Array.isArray(product.categoryIds) ? product.categoryIds : [];
    const catNames = cats.map(catNameById).filter(Boolean);

    return `
      <div class="product-item${lowClass}" onclick="openProductModal('${escapeHtml(String(id))}')">
        <div class="product-header" style="display:flex; justify-content:space-between; gap:10px;">
          <div style="min-width:0;">
            <div class="product-name" style="font-weight:900;">${escapeHtml(product.name)}</div>
            ${catNames.length ? `
              <div class="product-cats" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px;">
                ${catNames.map(n => `
                  <span class="pill" style="border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.04); padding:3px 8px; border-radius:999px; font-size:12px;">
                    ${escapeHtml(n)}
                  </span>`).join("")}
              </div>` : ""}
          </div>
          <div class="product-stock" style="font-weight:900; white-space:nowrap;">${total}g</div>
        </div>

        <div class="stock-bar" style="margin-top:10px; height:8px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden;">
          <div class="stock-bar-fill" style="height:100%; width:${percent}%; background:rgba(167,139,250,.9);"></div>
        </div>
      </div>
    `;
  }

  let html = "";

  for (const cid of sortedCatIds) {
    const name = catNameById(cid) || "Catégorie";
    const items = sortEntries(groups[cid]);
    html += `
      <div class="category-section">
        <div class="category-title">
          <div>${escapeHtml(name)}</div>
          <div class="category-count">${items.length} produit(s)</div>
        </div>
        <div class="product-grid">
          ${items.map(([id, p]) => renderProductCard(id, p)).join("")}
        </div>
      </div>
    `;
  }

  if (uncategorized.length) {
    const items = sortEntries(uncategorized);
    html += `
      <div class="category-section">
        <div class="category-title">
          <div>Sans catégorie</div>
          <div class="category-count">${items.length} produit(s)</div>
        </div>
        <div class="product-grid">
          ${items.map(([id, p]) => renderProductCard(id, p)).join("")}
        </div>
      </div>
    `;
  }

  productList.innerHTML = html;
}

// --------------------------------------------
// Variantes (lisibles)
// --------------------------------------------
function displayVariants(variants) {
  const variantsList = el("variantsList");
  if (!variantsList) return;

  const variantsArray = Object.entries(variants || {})
    .map(([label, variant]) => [String(label), variant])
    .sort((a, b) => (parseFloat(a[0]) || 0) - (parseFloat(b[0]) || 0));

  if (!variantsArray.length) {
    variantsList.innerHTML = `<div class="muted" style="padding:12px;">Aucune variante configurée</div>`;
    return;
  }

  variantsList.innerHTML = variantsArray.map(([label, variant]) => {
    const canSell = Number(variant.canSell ?? 0);
    let stockClass = "high";
    if (canSell <= 2) stockClass = "low";
    else if (canSell <= 10) stockClass = "medium";

    return `
      <div class="variant-item ${stockClass}">
        <div class="variant-label">${escapeHtml(label)}g</div>
        <div class="variant-stock">${canSell} unité(s)</div>
      </div>
    `;
  }).join("");
}

// --------------------------------------------
// Modal produit : catégories (multi-select)
// --------------------------------------------
function ensureProductCategoriesUI() {
  const modalContent = qs("#productModal .modal-content");
  if (!modalContent) return;
  if (el("productCategoriesSelect")) return;

  const block = document.createElement("div");
  block.className = "form-group";
  block.innerHTML = `
    <label>Catégories</label>
    <select id="productCategoriesSelect" multiple size="6" style="width:100%;"></select>
    <div class="hint muted">Ctrl (Windows) / Cmd (Mac) pour sélectionner plusieurs catégories.</div>
    <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary btn-sm" id="btnSaveCategories">💾 Enregistrer catégories</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btnClearCategories">🧹 Tout enlever</button>
    </div>
    <div id="categoriesSaveState" class="muted" style="margin-top:8px;"></div>
  `;

  // Place juste après Variantes si possible
  const variantsList = el("variantsList");
  const variantsGroup = variantsList ? variantsList.closest(".form-group") : null;
  if (variantsGroup && variantsGroup.parentNode) {
    variantsGroup.parentNode.insertBefore(block, variantsGroup.nextSibling);
  } else {
    modalContent.appendChild(block);
  }

  el("btnSaveCategories")?.addEventListener("click", saveProductCategories);
  el("btnClearCategories")?.addEventListener("click", () => {
    const sel = el("productCategoriesSelect");
    if (!sel) return;
    Array.from(sel.options).forEach(o => (o.selected = false));
  });
}

function updateProductCategoriesOptions() {
  const sel = el("productCategoriesSelect");
  if (!sel) return;

  const prevSelected = new Set(Array.from(sel.selectedOptions).map(o => String(o.value)));

  sel.innerHTML = categories
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }))
    .map(c => `<option value="${escapeHtml(String(c.id))}">${escapeHtml(String(c.name))}</option>`)
    .join("");

  Array.from(sel.options).forEach(o => {
    o.selected = prevSelected.has(String(o.value));
  });
}

async function saveProductCategories() {
  if (!currentProductId) return;

  const sel = el("productCategoriesSelect");
  const state = el("categoriesSaveState");
  if (!sel) return;

  const categoryIds = Array.from(sel.selectedOptions).map(o => String(o.value));

  try {
    if (state) state.textContent = "⏳ Enregistrement...";
    const res = await fetch(`/api/products/${encodeURIComponent(String(currentProductId))}/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur API catégories");

    if (state) state.textContent = "✅ Catégories enregistrées";
    log("✅ Catégories enregistrées\n\n" + JSON.stringify(data, null, 2), "success");

    await refreshStock();
  } catch (e) {
    if (state) state.textContent = "❌ " + e.message;
    log("❌ Erreur catégories: " + e.message, "error");
    alert("Erreur en enregistrant les catégories : " + e.message);
  }
}

// --------------------------------------------
// Modal produit : ajuster stock (unités) par variante
// --------------------------------------------
function ensureProductAdjustUnitsUI() {
  const modalContent = qs("#productModal .modal-content");
  if (!modalContent) return;
  if (el("adjustUnitsBox")) return;

  const block = document.createElement("div");
  block.className = "form-group";
  block.id = "adjustUnitsBox";
  block.innerHTML = `
    <label>Stock (par unités)</label>

    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
      <div style="flex:1; min-width:160px;">
        <div class="hint muted" style="margin-bottom:6px;">Variante</div>
        <select id="adjustVariantKey" style="width:100%;"></select>
      </div>

      <div style="width:160px;">
        <div class="hint muted" style="margin-bottom:6px;">Unités</div>
        <input id="adjustUnitsValue" type="number" min="1" step="1" value="1" style="width:100%;" />
      </div>

      <button class="btn btn-secondary btn-sm" type="button" id="btnRemoveUnits">➖ Enlever</button>
      <button class="btn btn-primary btn-sm" type="button" id="btnAddUnits">➕ Ajouter</button>
    </div>

    <div id="adjustUnitsState" class="muted" style="margin-top:8px;"></div>
  `;

  // Place sous Variantes si possible
  const variantsList = el("variantsList");
  const variantsGroup = variantsList ? variantsList.closest(".form-group") : null;
  if (variantsGroup && variantsGroup.parentNode) {
    variantsGroup.parentNode.insertBefore(block, variantsGroup.nextSibling);
  } else {
    modalContent.appendChild(block);
  }

  el("btnRemoveUnits")?.addEventListener("click", () => adjustUnits("remove"));
  el("btnAddUnits")?.addEventListener("click", () => adjustUnits("add"));
}

function fillAdjustUnitsVariants(product) {
  const sel = el("adjustVariantKey");
  if (!sel) return;

  const variants = product?.variants || {};
  const keys = Object.keys(variants)
    .map(k => String(k))
    .sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0));

  sel.innerHTML = keys.map(k => {
    const v = variants[k];
    const canSell = Number(v?.canSell ?? 0);
    return `<option value="${escapeHtml(k)}">${escapeHtml(k)}g — ${canSell} unité(s)</option>`;
  }).join("");
}

async function adjustUnits(op) {
  if (!currentProductId) return;
  const product = stockData[currentProductId];
  if (!product) return;

  const state = el("adjustUnitsState");
  const variantKey = el("adjustVariantKey")?.value;
  const units = Number(el("adjustUnitsValue")?.value || 0);

  if (!variantKey) return alert("Choisis une variante.");
  if (!Number.isFinite(units) || units <= 0) return alert("Nombre d’unités invalide.");

  try {
    if (state) state.textContent = "⏳ Mise à jour...";

    const res = await fetch(`/api/products/${encodeURIComponent(String(currentProductId))}/adjust-units`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantKey, units, op }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur ajustement stock");

    if (state) state.textContent = "✅ Stock mis à jour";
    log("✅ Stock mis à jour\n\n" + JSON.stringify(data, null, 2), "success");

    await refreshStock();

    // Ré-ouvrir pour rafraîchir stocks variantes + historique
    openProductModal(currentProductId);

    // Refresh historique global + produit si présents
    if (typeof refreshMovements === "function") refreshMovements();
    if (typeof refreshProductHistory === "function") refreshProductHistory(currentProductId);

  } catch (e) {
    if (state) state.textContent = "❌ " + e.message;
    log("❌ Erreur adjustUnits: " + e.message, "error");
    alert("Erreur: " + e.message);
  }
}

// --------------------------------------------
// Historique produit (dans modal)
// --------------------------------------------
function ensureProductHistoryUI() {
  const modalContent = qs("#productModal .modal-content");
  if (!modalContent) return;
  if (el("productHistoryBox")) return;

  const block = document.createElement("div");
  block.className = "product-history";
  block.id = "productHistoryBox";
  block.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
      <div style="font-weight:900;">🕒 Historique du produit</div>
      <div style="display:flex; gap:8px; align-items:center;">
        <select id="productHistoryDays" class="btn btn-secondary btn-sm" style="padding:6px 10px;">
          <option value="7">7j</option>
          <option value="30" selected>30j</option>
          <option value="90">90j</option>
        </select>
        <button class="btn btn-secondary btn-sm" type="button" id="btnRefreshProductHistory">🔄</button>
      </div>
    </div>
    <div id="productHistoryList" class="history-list">
      <div class="muted" style="padding:10px;">-</div>
    </div>
  `;

  modalContent.appendChild(block);

  el("btnRefreshProductHistory")?.addEventListener("click", () => refreshProductHistory(currentProductId));
  el("productHistoryDays")?.addEventListener("change", () => refreshProductHistory(currentProductId));
}

async function refreshProductHistory(productId) {
  const list = el("productHistoryList");
  if (!list) return;

  if (!productId) {
    list.innerHTML = `<div class="muted" style="padding:10px;">Aucun produit</div>`;
    return;
  }

  const days = Number(el("productHistoryDays")?.value || 30);
  list.innerHTML = `<div class="muted" style="padding:10px;">⏳ Chargement...</div>`;

  try {
    const url = new URL(window.location.origin + "/api/movements");
    url.searchParams.set("days", String(days));
    url.searchParams.set("limit", "250");

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur historique");

    const rows = (Array.isArray(data.movements) ? data.movements : [])
      .filter(m => String(m.productId || "") === String(productId))
      .slice(0, 80);

    if (!rows.length) {
      list.innerHTML = `<div class="muted" style="padding:10px;">Aucun mouvement sur ${days} jour(s).</div>`;
      return;
    }

    list.innerHTML = rows.map(m => {
      const ts = fmtDateFR(m.ts || m.createdAt || "");
      const type = m.type || m.source || "mouvement";
      const delta = Number(m.deltaGrams ?? m.gramsDelta ?? m.delta ?? 0);
      const after = (m.gramsAfter ?? m.totalAfter ?? m.after ?? null);

      const extra = m.orderName
        ? ` • ${escapeHtml(m.orderName)}`
        : (m.orderId ? ` • #${escapeHtml(m.orderId)}` : "");

      return `
        <div class="history-item">
          <div style="min-width:0;">
            <div class="h-title">${escapeHtml(type)}${extra}</div>
            <div class="h-sub">${escapeHtml(ts)}${after != null ? ` • Stock après: ${escapeHtml(String(after))}g` : ""}</div>
          </div>
          <div class="h-delta">${deltaBadge(delta)} ${escapeHtml(fmtDelta(delta))}</div>
        </div>
      `;
    }).join("");

  } catch (e) {
    list.innerHTML = `<div style="color:#ef4444; padding:10px;">❌ ${escapeHtml(e.message)}</div>`;
  }
}

// --------------------------------------------
// Modal produit : ouverture/fermeture
// --------------------------------------------
function openProductModal(productId) {
  currentProductId = String(productId);
  const product = stockData[currentProductId];
  if (!product) return;

  el("productModalTitle") && (el("productModalTitle").textContent = `📦 ${product.name}`);
  el("totalGramsInput") && (el("totalGramsInput").value = Number(product.totalGrams || 0));

  displayVariants(product.variants);

  // Ajuster stock (unités)
  ensureProductAdjustUnitsUI();
  fillAdjustUnitsVariants(product);

  // Catégories
  ensureProductCategoriesUI();
  updateProductCategoriesOptions();

  const catSelect = el("productCategoriesSelect");
  if (catSelect) {
    const ids = Array.isArray(product.categoryIds) ? product.categoryIds.map(String) : [];
    for (const opt of Array.from(catSelect.options)) {
      opt.selected = ids.includes(String(opt.value));
    }
  }

  // Historique du produit
  ensureProductHistoryUI();
  refreshProductHistory(currentProductId);

  el("productModal")?.classList.add("active");
}

function closeProductModal() {
  el("productModal")?.classList.remove("active");
  currentProductId = null;
}

// --------------------------------------------
// Restock modal (celui de ton index.html)
// --------------------------------------------
function openRestockModal() {
  const modal = el("restockModal");
  const select = el("productSelect");
  if (!modal || !select) return;

  select.innerHTML =
    `<option value="">Sélectionnez un produit...</option>` +
    Object.entries(stockData).map(([id, p]) =>
      `<option value="${escapeHtml(String(id))}">${escapeHtml(p.name)} (Stock: ${Number(p.totalGrams || 0)}g)</option>`
    ).join("");

  modal.classList.add("active");
}

function closeRestockModal() {
  el("restockModal")?.classList.remove("active");
  el("restockForm")?.reset?.();
}

// --------------------------------------------
// Test order
// --------------------------------------------
async function testOrder() {
  log("⏳ Traitement de la commande test en cours...", "info");
  try {
    const res = await fetch("/api/test-order", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur test-order");
    log("✅ COMMANDE TEST TRAITÉE\n\n" + JSON.stringify(data, null, 2), "success");
    await refreshStock();
    if (typeof refreshMovements === "function") refreshMovements();
  } catch (err) {
    log("❌ ERREUR: " + err.message, "error");
  }
}

// --------------------------------------------
// Global movements (si ton index.html a la zone)
// (facultatif : ne casse rien si absent)
// --------------------------------------------
async function refreshMovements() {
  const box = el("movementsList");
  if (!box) return;

  const days = Number(el("movementsDays")?.value || 7);
  box.innerHTML = `<div style="color:#9ca3af; padding:8px 2px;">⏳ Chargement...</div>`;

  try {
    const url = new URL(window.location.origin + "/api/movements");
    url.searchParams.set("days", String(days));
    url.searchParams.set("limit", "80");

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur chargement mouvements");

    const rows = Array.isArray(data.movements) ? data.movements : [];
    if (!rows.length) {
      box.innerHTML = `<div style="color:#9ca3af; padding:8px 2px;">Aucun mouvement sur ${days} jour(s).</div>`;
      return;
    }

    box.innerHTML = rows.map((m) => {
      const ts = fmtDateFR(m.ts || m.createdAt || m.time || "");
      const name = m.productName || (stockData[m.productId]?.name) || m.productId || "-";
      const delta = Number(m.deltaGrams ?? m.gramsDelta ?? m.delta ?? 0);
      const type = m.type || m.source || "mouvement";
      const extra = m.orderName
        ? ` • ${escapeHtml(m.orderName)}`
        : (m.orderId ? ` • #${escapeHtml(m.orderId)}` : "");

      return `
        <div style="
          display:flex;
          justify-content:space-between;
          align-items:flex-start;
          gap:10px;
          padding:10px 10px;
          border:1px solid rgba(255,255,255,.08);
          border-radius:12px;
          background:rgba(15,23,42,.6);
          margin-bottom:8px;">
          <div style="min-width:0;">
            <div style="font-weight:800; line-height:1.2;">${escapeHtml(name)}</div>
            <div style="color:#9ca3af; font-size:12px; margin-top:4px;">
              ${escapeHtml(ts)} • ${escapeHtml(type)}${extra}
            </div>
          </div>
          <div style="
            flex:0 0 auto;
            border:1px solid rgba(255,255,255,.12);
            background:rgba(255,255,255,.04);
            border-radius:999px;
            padding:6px 10px;
            font-weight:900;
            white-space:nowrap;">
            ${deltaBadge(delta)} ${escapeHtml(fmtDelta(delta))}
          </div>
        </div>
      `;
    }).join("");

  } catch (e) {
    box.innerHTML = `<div style="color:#ef4444; padding:8px 2px;">❌ ${escapeHtml(e.message)}</div>`;
  }
}

// --------------------------------------------
// Modals : Catégories (CRUD)
// --------------------------------------------
function openCategoriesModal() {
  let modal = el("categoriesModal");

  if (!modal) {
    modal = document.createElement("div");
    modal.id = "categoriesModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-title">📁 Catégories</div>

        <div class="info-box">
          Crée des catégories pour trier tes produits (ex: Fleurs, Résines, Gummies…).
        </div>

        <div class="catalog-modal-row">
          <input id="newCategoryName" placeholder="Nom de catégorie (ex: Fleurs)" />
          <button class="btn btn-primary btn-sm" id="btnAddCategory">Ajouter</button>
        </div>

        <div id="categoriesList" class="categories-list"></div>

        <div class="modal-buttons">
          <button class="btn btn-secondary" id="btnCloseCategories">Fermer</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    el("btnCloseCategories")?.addEventListener("click", () => modal.classList.remove("active"));

    el("btnAddCategory")?.addEventListener("click", async () => {
      const name = el("newCategoryName")?.value?.trim();
      if (!name) return;
      try {
        const res = await fetch("/api/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Erreur création catégorie");

        el("newCategoryName").value = "";
        await loadCategories();
        await refreshStock();
        renderCategoriesList();
      } catch (e) {
        log("❌ Erreur création catégorie: " + e.message, "error");
      }
    });
  }

  ensureModalBackdrop(modal, () => {});
  renderCategoriesList();
  modal.classList.add("active");
}

async function loadCategories() {
  try {
    const res = await fetch("/api/categories");
    const data = await res.json();
    categories = Array.isArray(data.categories) ? data.categories : [];

    updateCategoryFilterOptions();
    updateProductCategoriesOptions();
  } catch (e) {
    log("❌ Erreur chargement catégories: " + e.message, "error");
  }
}

function renderCategoriesList() {
  const list = el("categoriesList");
  if (!list) return;

  const sorted = categories.slice().sort((a, b) =>
    String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" })
  );

  if (!sorted.length) {
    list.innerHTML = `<div style="color:#a0aec0; padding:10px;">Aucune catégorie</div>`;
    return;
  }

  list.innerHTML = sorted.map(c => `
    <div class="category-item">
      <div class="category-name">${escapeHtml(c.name)}</div>
      <div class="category-actions">
        <button class="btn btn-secondary btn-sm" data-act="rename" data-id="${escapeHtml(String(c.id))}">Renommer</button>
        <button class="btn btn-secondary btn-sm" data-act="delete" data-id="${escapeHtml(String(c.id))}">Supprimer</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");

      try {
        if (act === "rename") {
          const name = prompt("Nouveau nom de la catégorie ?");
          if (!name) return;

          const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim() }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || "Erreur rename");
        }

        if (act === "delete") {
          if (!confirm("Supprimer cette catégorie ?")) return;

          const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || "Erreur delete");
        }

        await loadCategories();
        await refreshStock();
        renderCategoriesList();
      } catch (e) {
        log("❌ Erreur catégorie: " + e.message, "error");
      }
    });
  });
}

// --------------------------------------------
// Modals : Import Shopify
// --------------------------------------------
function openImportModal() {
  let modal = el("importModal");

  if (!modal) {
    modal = document.createElement("div");
    modal.id = "importModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content modal-wide">
        <div class="modal-title">➕ Import depuis Shopify</div>

        <div class="import-toolbar">
          <input id="importQuery" placeholder="Rechercher un produit (ex: amnesia)" />
          <button class="btn btn-info btn-sm" id="btnSearchShopify">Rechercher</button>

          <div class="field">
            <label>Catégorie (optionnel)</label>
            <select id="importCategory">
              <option value="">Aucune</option>
            </select>
          </div>
        </div>

        <div id="importResults" class="import-results"></div>

        <div class="modal-buttons">
          <button class="btn btn-secondary" id="btnCloseImport">Fermer</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    el("btnCloseImport")?.addEventListener("click", () => modal.classList.remove("active"));
    el("btnSearchShopify")?.addEventListener("click", () => searchShopifyProducts());
  }

  // Fill categories dropdown
  const sel = el("importCategory");
  if (sel) {
    sel.innerHTML =
      `<option value="">Aucune</option>` +
      categories
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }))
        .map(c => `<option value="${escapeHtml(String(c.id))}">${escapeHtml(String(c.name))}</option>`)
        .join("");
  }

  el("importResults") && (el("importResults").innerHTML =
    `<div style="color:#a0aec0; padding:10px;">Lance une recherche pour afficher tes produits Shopify.</div>`);

  ensureModalBackdrop(modal, () => {});
  modal.classList.add("active");
}

async function searchShopifyProducts() {
  const q = el("importQuery")?.value?.trim() || "";
  const results = el("importResults");
  if (!results) return;

  results.innerHTML = `<div class="import-loading">⏳ Recherche en cours...</div>`;

  try {
    const url = new URL(window.location.origin + "/api/shopify/products");
    url.searchParams.set("limit", "100");
    if (q) url.searchParams.set("query", q);

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur");

    const items = Array.isArray(data.products) ? data.products : [];
    if (!items.length) {
      results.innerHTML = `<div style="color:#a0aec0; padding:10px;">Aucun produit trouvé.</div>`;
      return;
    }

    results.innerHTML = items.map(p => `
      <div class="import-item">
        <div class="import-main">
          <div class="import-title">${escapeHtml(p.title)}</div>
          <div class="import-sub">ID: ${escapeHtml(p.id)} • Variantes: ${escapeHtml(p.variantsCount ?? "?")}</div>
        </div>
        <button class="btn btn-primary btn-sm" data-import="${escapeHtml(p.id)}">Importer</button>
      </div>
    `).join("");

    results.querySelectorAll("button[data-import]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const productId = btn.getAttribute("data-import");
        await importProduct(productId);
      });
    });
  } catch (e) {
    results.innerHTML = `<div style="color:#f56565; padding:10px;">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function importProduct(productId) {
  const cat = el("importCategory")?.value || "";
  const categoryIds = cat ? [cat] : [];

  log(`⏳ Import du produit Shopify ${productId}...`, "info");
  try {
    const res = await fetch("/api/import/product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, categoryIds, gramsMode: "parse_title" }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erreur import");

    log("✅ Produit importé\n\n" + JSON.stringify(data, null, 2), "success");

    await refreshStock();
    refreshMovements();
  } catch (e) {
    log("❌ Import échoué: " + e.message, "error");
  }
}

// --------------------------------------------
// Init
// --------------------------------------------
window.addEventListener("load", async () => {
  await getServerInfo();
  await loadCategories();
  await refreshStock();

  // si historique global existe dans ton index.html
  if (el("movementsList")) {
    await refreshMovements();
    el("movementsDays")?.addEventListener("change", refreshMovements);
  }

  // Expose pour les onclick HTML
  window.openProductModal = openProductModal;
  window.closeProductModal = closeProductModal;

  window.openRestockModal = openRestockModal;
  window.closeRestockModal = closeRestockModal;

  window.testOrder = testOrder;

  // expose si tu as un bouton "refresh"
  window.refreshMovements = refreshMovements;
  window.refreshProductHistory = refreshProductHistory;
});

// ============================================
// BULK STOCK MANAGER - Front (Admin UI)
// + Import produits Shopify
// + Catégories (tri/filtre)
// + Tri alphabétique
// + Alertes stock bas
// + Export CSV
// + Historique mouvements (au-dessus console)
// + Affichage produits groupés par catégorie
// ============================================

// --------------------------------------------
// Références DOM existantes
// --------------------------------------------
const result = document.getElementById('result');
let stockData = {};       // legacy map: { [productId]: {name,totalGrams,variants,...} }
let catalogData = null;   // new API: { products:[], categories:[] }
let serverInfo = {};
let currentProductId = null;

let currentCategoryFilter = '';
let sortAlpha = true; // par défaut A->Z
let categories = [];  // [{id,name}]

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('fr-FR');
  if (!result) return;
  result.textContent = `[${timestamp}] ${message}`;
  result.className = 'result-content ' + type;
  result.scrollTop = result.scrollHeight;
}

function qs(sel) { return document.querySelector(sel); }
function el(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtDateFR(iso) {
  try { return new Date(iso).toLocaleString('fr-FR'); }
  catch { return String(iso || ''); }
}

function fmtDelta(delta) {
  const n = Number(delta || 0);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}g`;
}

function deltaBadge(delta) {
  const n = Number(delta || 0);
  if (n > 0) return '✅';
  if (n < 0) return '🔻';
  return '•';
}

// ============================================
// HISTORIQUE DES MOUVEMENTS (au-dessus console)
// Requiert : GET /api/movements -> { movements: [...] }
// ============================================
async function refreshMovements() {
  const box = el('movementsList');
  if (!box) return;

  const days = Number(el('movementsDays')?.value || 7);

  box.innerHTML = `<div style="color:#9ca3af; padding:8px 2px;">⏳ Chargement...</div>`;

  try {
    const url = new URL(window.location.origin + '/api/movements');
    url.searchParams.set('days', String(days));
    url.searchParams.set('limit', '80');

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Erreur chargement mouvements');

    const rows = Array.isArray(data.movements) ? data.movements : [];
    if (!rows.length) {
      box.innerHTML = `<div style="color:#9ca3af; padding:8px 2px;">Aucun mouvement sur ${days} jour(s).</div>`;
      return;
    }

    box.innerHTML = rows.map((m) => {
      const ts = fmtDateFR(m.ts || m.createdAt || m.time || '');
      const name = m.productName || (stockData[m.productId]?.name) || m.productId || '-';
      const delta = Number(m.deltaGrams ?? m.gramsDelta ?? m.delta ?? 0);
      const type = m.type || m.source || 'mouvement';
      const extra = m.orderName
        ? ` • ${escapeHtml(m.orderName)}`
        : (m.orderId ? ` • #${escapeHtml(m.orderId)}` : '');

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
          margin-bottom:8px;
        ">
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
            white-space:nowrap;
          ">
            ${deltaBadge(delta)} ${escapeHtml(fmtDelta(delta))}
          </div>
        </div>
      `;
    }).join('');

  } catch (e) {
    box.innerHTML = `<div style="color:#ef4444; padding:8px 2px;">❌ ${escapeHtml(e.message)}</div>`;
  }
}

// ============================================
// UI: Ajout barre de tri/filtre/import si absente
// ============================================
function ensureCatalogControls() {
  const header = document.querySelector('.header');
  if (!header) return;

  if (document.getElementById('catalogControls')) return;

  const wrap = document.createElement('div');
  wrap.id = 'catalogControls';
  wrap.className = 'catalog-controls';

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

  el('categoryFilter').addEventListener('change', async (e) => {
    currentCategoryFilter = e.target.value || '';
    await refreshStock();
  });
  el('sortMode').addEventListener('change', async (e) => {
    sortAlpha = e.target.value === 'alpha';
    await refreshStock();
  });
  el('btnImport').addEventListener('click', openImportModal);
  el('btnCategories').addEventListener('click', openCategoriesModal);
  el('btnExportStock').addEventListener('click', () => {
    window.location.href = '/api/stock.csv';
  });
  el('btnExportMovements').addEventListener('click', () => {
    window.location.href = '/api/movements.csv';
  });
}

// ============================================
// SERVER INFO
// ============================================
async function getServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    serverInfo = await res.json();

    const badge = document.getElementById('serverStatus');
    const mode = document.getElementById('serverMode');
    const count = document.getElementById('productCount');

    if (badge) {
      badge.classList.remove('online', 'dev');
      badge.classList.add('online');
      badge.innerHTML = `🟢 En ligne`;
    }
    if (mode) mode.textContent = serverInfo.mode || 'development';
    if (count) count.textContent = serverInfo.productCount ?? '0';
  } catch (err) {
    log('❌ Impossible de récupérer les infos serveur: ' + err.message, 'error');
  }
}

// ============================================
// STOCK (supporte 2 formats API)
// - Ancien: { [id]: {name,totalGrams,variants} }
// - Nouveau: { products:[...], categories:[...] }
// ============================================
async function refreshStock() {
  ensureCatalogControls();

  log('⏳ Actualisation du stock...', 'info');
  try {
    const url = new URL(window.location.origin + '/api/stock');
    if (sortAlpha) url.searchParams.set('sort', 'alpha');
    if (currentCategoryFilter) url.searchParams.set('category', currentCategoryFilter);

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();

    // Format nouveau
    if (data && Array.isArray(data.products)) {
      catalogData = data;
      categories = Array.isArray(data.categories) ? data.categories : [];

      const map = {};
      for (const p of data.products) {
        map[p.productId] = {
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

      log('✅ Stock actualisé (catalog)\n\n' + JSON.stringify(data, null, 2), 'success');
      return;
    }

    // Format legacy
    stockData = data || {};
    displayProducts(stockData);
    updateStats(stockData);
    log('✅ Stock actualisé\n\n' + JSON.stringify(stockData, null, 2), 'success');
  } catch (err) {
    log('❌ ERREUR: ' + err.message, 'error');
  }
}

function updateCategoryFilterOptions() {
  const sel = el('categoryFilter');
  if (!sel) return;

  const current = sel.value;

  sel.innerHTML = `<option value="">Toutes</option>` + categories
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'))
    .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
    .join('');

  if (current) sel.value = current;
}

// ============================================
// AFFICHAGE PRODUITS (groupés par catégorie)
// ============================================
function displayProducts(stock) {
  const productList = document.getElementById('productList');
  if (!productList) return;

  const entries = Object.entries(stock || {});
  if (entries.length === 0) {
    productList.innerHTML = '<div style="text-align:center; padding:40px; color:#a0aec0;">Aucun produit configuré</div>';
    return;
  }

  const catNameById = (cid) => categories.find(c => c.id === cid)?.name || null;

  // Groupes : { catId: [ [productId, product] ] }
  const groups = {};
  const uncategorized = [];

  for (const [id, product] of entries) {
    const ids = Array.isArray(product.categoryIds) ? product.categoryIds : [];
    if (!ids.length) {
      uncategorized.push([id, product]);
      continue;
    }
    for (const cid of ids) {
      if (!groups[cid]) groups[cid] = [];
      groups[cid].push([id, product]);
    }
  }

  const sortedCatIds = Object.keys(groups).sort((a, b) => {
    const an = String(catNameById(a) || '').toLowerCase();
    const bn = String(catNameById(b) || '').toLowerCase();
    return an.localeCompare(bn, 'fr', { sensitivity: 'base' });
  });

  const sortEntries = (arr) => arr.slice().sort((A, B) => {
    const a = String(A[1]?.name || '');
    const b = String(B[1]?.name || '');
    return a.localeCompare(b, 'fr', { sensitivity: 'base' });
  });

  function renderProductCard(id, product) {
    const total = Number(product.totalGrams || 0);
    const percent = Math.max(0, Math.min(100, Math.round((total / 200) * 100)));
    const lowClass = total <= Number(serverInfo?.lowStockThreshold || 10) ? ' low' : '';

    const cats = Array.isArray(product.categoryIds) ? product.categoryIds : [];
    const catNames = cats.map(catNameById).filter(Boolean);

    return `
      <div class="product-item${lowClass}" onclick="openProductModal('${id}')">
        <div class="product-header" style="display:flex; justify-content:space-between; gap:10px;">
          <div style="min-width:0;">
            <div class="product-name" style="font-weight:900;">${escapeHtml(product.name)}</div>
            ${catNames.length ? `<div class="product-cats" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px;">
              ${catNames.map(n => `<span class="pill" style="border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.04); padding:3px 8px; border-radius:999px; font-size:12px;">${escapeHtml(n)}</span>`).join('')}
            </div>` : ''}
          </div>
          <div class="product-stock" style="font-weight:900; white-space:nowrap;">${total}g</div>
        </div>
        <div class="stock-bar" style="margin-top:10px; height:8px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden;">
          <div class="stock-bar-fill" style="height:100%; width:${percent}%; background:rgba(167,139,250,.9);"></div>
        </div>
      </div>
    `;
  }

  let html = '';

  // Catégories
  for (const cid of sortedCatIds) {
    const name = catNameById(cid) || 'Catégorie';
    const items = sortEntries(groups[cid]);

    html += `
      <div class="category-section">
        <div class="category-title">
          <div>${escapeHtml(name)}</div>
          <div class="category-count">${items.length} produit(s)</div>
        </div>
        <div class="product-grid">
          ${items.map(([id, p]) => renderProductCard(id, p)).join('')}
        </div>
      </div>
    `;
  }

  // Sans catégorie
  if (uncategorized.length) {
    const items = sortEntries(uncategorized);
    html += `
      <div class="category-section">
        <div class="category-title">
          <div>Sans catégorie</div>
          <div class="category-count">${items.length} produit(s)</div>
        </div>
        <div class="product-grid">
          ${items.map(([id, p]) => renderProductCard(id, p)).join('')}
        </div>
      </div>
    `;
  }

  productList.innerHTML = html;
}

// ============================================
// STATS
// ============================================
function updateStats(stock) {
  const products = Object.values(stock || {});
  const totalProducts = products.length;
  const totalGrams = products.reduce((acc, p) => acc + Number(p.totalGrams || 0), 0);

  const countEl = document.getElementById('statProducts');
  const gramsEl = document.getElementById('statGrams');
  const lastEl = document.getElementById('lastUpdate');

  if (countEl) countEl.textContent = totalProducts;
  if (gramsEl) gramsEl.textContent = `${totalGrams}g`;
  if (lastEl) lastEl.textContent = new Date().toLocaleString('fr-FR');
}

// ============================================
// TEST COMMANDE
// ============================================
async function testOrder() {
  log('⏳ Traitement de la commande test en cours...', 'info');
  try {
    const res = await fetch('/api/test-order', { method: 'POST' });
    const data = await res.json();
    log('✅ COMMANDE TEST TRAITÉE\n\n' + JSON.stringify(data, null, 2), 'success');
    await refreshStock();
    await refreshMovements();
  } catch (err) {
    log('❌ ERREUR: ' + err.message, 'error');
  }
}

// ============================================
// RÉAPPROVISIONNEMENT
// ============================================
function openRestockModal() {
  const modal = document.getElementById('restockModal');
  const select = document.getElementById('productSelect');
  if (!modal || !select) return;

  select.innerHTML = '<option value="">Sélectionnez un produit...</option>' +
    Object.entries(stockData).map(([id, product]) =>
      `<option value="${id}">${escapeHtml(product.name)} (Stock actuel: ${Number(product.totalGrams || 0)}g)</option>`
    ).join('');

  modal.classList.add('active');
}

function closeRestockModal() {
  const m = el('restockModal');
  if (m) m.classList.remove('active');
  const f = el('restockForm');
  if (f) f.reset();
}

// ============================================
// MODAL PRODUIT (assign catégories)
// ============================================
function openProductModal(productId) {
  currentProductId = productId;
  const product = stockData[productId];
  if (!product) return;

  const title = el('productModalTitle');
  const totalInput = el('totalGramsInput');

  if (title) title.textContent = `📦 ${product.name}`;
  if (totalInput) totalInput.value = Number(product.totalGrams || 0);

  displayVariants(product.variants);

  ensureProductCategoriesUI();

  const catSelect = el('productCategoriesSelect');
  if (catSelect) {
    const ids = Array.isArray(product.categoryIds) ? product.categoryIds : [];
    for (const opt of Array.from(catSelect.options)) {
      opt.selected = ids.includes(opt.value);
    }
  }

  el('productModal')?.classList.add('active');
}

function closeProductModal() {
  el('productModal')?.classList.remove('active');
  currentProductId = null;
}

function displayVariants(variants) {
  const variantsList = document.getElementById('variantsList');
  if (!variantsList) return;

  const variantsArray = Object.entries(variants || {});
  if (variantsArray.length === 0) {
    variantsList.innerHTML = '<div style="text-align: center; padding: 20px; color: #a0aec0;">Aucune variante configurée</div>';
    return;
  }

  variantsList.innerHTML = variantsArray.map(([label, variant]) => {
    const canSell = Number(variant.canSell ?? 0);
    let stockClass = 'high';
    if (canSell <= 2) stockClass = 'low';
    else if (canSell <= 10) stockClass = 'medium';

    return `
      <div class="variant-item ${stockClass}">
        <div class="variant-label">${escapeHtml(label)}g</div>
        <div class="variant-stock">${canSell} unité(s)</div>
      </div>
    `;
  }).join('');
}

function ensureProductCategoriesUI() {
  const modalContent = document.querySelector('#productModal .modal-content');
  if (!modalContent) return;
  if (el('productCategoriesSelect')) return;

  const block = document.createElement('div');
  block.className = 'form-group';
  block.innerHTML = `
    <label>Catégories</label>
    <select id="productCategoriesSelect" multiple size="5"></select>
    <div class="hint">Astuce : Ctrl (Windows) / Cmd (Mac) pour sélectionner plusieurs.</div>
    <div style="margin-top:10px; display:flex; gap:10px;">
      <button type="button" class="btn btn-secondary btn-sm" id="btnSaveCategories">💾 Enregistrer catégories</button>
    </div>
  `;

  const buttons = modalContent.querySelector('.modal-buttons');
  if (buttons) modalContent.insertBefore(block, buttons);
  else modalContent.appendChild(block);

  updateProductCategoriesOptions();
  el('btnSaveCategories')?.addEventListener('click', saveProductCategories);
}

function updateProductCategoriesOptions() {
  const sel = el('productCategoriesSelect');
  if (!sel) return;

  sel.innerHTML = categories
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'))
    .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
    .join('');
}

async function saveProductCategories() {
  if (!currentProductId) return;
  const sel = el('productCategoriesSelect');
  if (!sel) return;

  const categoryIds = Array.from(sel.selectedOptions).map(o => o.value);

  try {
    const res = await fetch(`/api/products/${encodeURIComponent(currentProductId)}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryIds }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Erreur');

    log('✅ Catégories enregistrées\n\n' + JSON.stringify(data, null, 2), 'success');
    await refreshStock();
  } catch (e) {
    log('❌ Erreur catégories: ' + e.message, 'error');
  }
}

// ============================================
// MODAL: Catégories (CRUD)
// ============================================
function openCategoriesModal() {
  let modal = el('categoriesModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'categoriesModal';
    modal.className = 'modal';
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

    el('btnCloseCategories').addEventListener('click', () => modal.classList.remove('active'));
    el('btnAddCategory').addEventListener('click', async () => {
      const name = el('newCategoryName').value.trim();
      if (!name) return;
      try {
        const res = await fetch('/api/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Erreur');
        el('newCategoryName').value = '';
        await loadCategories();
        await refreshStock();
      } catch (e) {
        log('❌ Erreur création catégorie: ' + e.message, 'error');
      }
    });
  }

  renderCategoriesList();
  modal.classList.add('active');
}

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    categories = Array.isArray(data.categories) ? data.categories : [];
    updateCategoryFilterOptions();
    updateProductCategoriesOptions();
  } catch (e) {
    log('❌ Erreur chargement catégories: ' + e.message, 'error');
  }
}

function renderCategoriesList() {
  const list = el('categoriesList');
  if (!list) return;

  const sorted = categories.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  if (!sorted.length) {
    list.innerHTML = `<div style="color:#a0aec0; padding:10px;">Aucune catégorie</div>`;
    return;
  }

  list.innerHTML = sorted.map(c => `
    <div class="category-item">
      <div class="category-name">${escapeHtml(c.name)}</div>
      <div class="category-actions">
        <button class="btn btn-secondary btn-sm" data-act="rename" data-id="${escapeHtml(c.id)}">Renommer</button>
        <button class="btn btn-secondary btn-sm" data-act="delete" data-id="${escapeHtml(c.id)}">Supprimer</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      try {
        if (act === 'rename') {
          const name = prompt('Nouveau nom de la catégorie ?');
          if (!name) return;
          const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim() }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || 'Erreur');
        } else if (act === 'delete') {
          if (!confirm('Supprimer cette catégorie ?')) return;
          const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || 'Erreur');
        }
        await loadCategories();
        await refreshStock();
        renderCategoriesList();
      } catch (e) {
        log('❌ Erreur catégorie: ' + e.message, 'error');
      }
    });
  });
}

// ============================================
// MODAL: Import Shopify
// ============================================
function openImportModal() {
  let modal = el('importModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'importModal';
    modal.className = 'modal';
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

    el('btnCloseImport').addEventListener('click', () => modal.classList.remove('active'));
    el('btnSearchShopify').addEventListener('click', () => searchShopifyProducts());
  }

  const sel = el('importCategory');
  if (sel) {
    sel.innerHTML = `<option value="">Aucune</option>` + categories
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'))
      .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
      .join('');
  }

  el('importResults').innerHTML = `<div style="color:#a0aec0; padding:10px;">Lance une recherche pour afficher tes produits Shopify.</div>`;
  modal.classList.add('active');
}

async function searchShopifyProducts() {
  const q = el('importQuery')?.value?.trim() || '';
  const results = el('importResults');
  if (!results) return;

  results.innerHTML = `<div class="import-loading">⏳ Recherche en cours...</div>`;

  try {
    const url = new URL(window.location.origin + '/api/shopify/products');
    url.searchParams.set('limit', '100');
    if (q) url.searchParams.set('query', q);

    const res = await fetch(url.pathname + url.search);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Erreur');

    const items = Array.isArray(data.products) ? data.products : [];
    if (!items.length) {
      results.innerHTML = `<div style="color:#a0aec0; padding:10px;">Aucun produit trouvé.</div>`;
      return;
    }

    results.innerHTML = items.map(p => `
      <div class="import-item">
        <div class="import-main">
          <div class="import-title">${escapeHtml(p.title)}</div>
          <div class="import-sub">ID: ${escapeHtml(p.id)} • Variantes: ${escapeHtml(p.variantsCount ?? '?')}</div>
        </div>
        <button class="btn btn-primary btn-sm" data-import="${escapeHtml(p.id)}">Importer</button>
      </div>
    `).join('');

    results.querySelectorAll('button[data-import]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const productId = btn.getAttribute('data-import');
        await importProduct(productId);
      });
    });
  } catch (e) {
    results.innerHTML = `<div style="color:#f56565; padding:10px;">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function importProduct(productId) {
  const cat = el('importCategory')?.value || '';
  const categoryIds = cat ? [cat] : [];

  log(`⏳ Import du produit Shopify ${productId}...`, 'info');
  try {
    const res = await fetch('/api/import/product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, categoryIds, gramsMode: 'parse_title' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Erreur');

    log('✅ Produit importé\n\n' + JSON.stringify(data, null, 2), 'success');

    await refreshStock();
    await refreshMovements();
  } catch (e) {
    log('❌ Import échoué: ' + e.message, 'error');
  }
}

// ============================================
// INITIALISATION
// ============================================
window.addEventListener('load', async () => {
  await getServerInfo();
  await loadCategories();
  await refreshStock();

  // Historique mouvements
  await refreshMovements();
  el('movementsDays')?.addEventListener('change', refreshMovements);

  // expose functions used in onclick in HTML
  window.openProductModal = openProductModal;
  window.openRestockModal = openRestockModal;
  window.closeRestockModal = closeRestockModal;
  window.closeProductModal = closeProductModal;
  window.testOrder = testOrder;

  // expose movements refresh for the button in index.html
  window.refreshMovements = refreshMovements;
});

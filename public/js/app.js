// public/js/app.js - ENRICHI + FIXES
// ✅ NOUVEAUTÉS :
//    - Carte "Valeur totale du stock"
//    - Barre de répartition par catégorie
//    - Formulaire restock avec prix d'achat (CMP)
//    - Feedback visuel coloré selon type de mouvement
//    - Affichage du CMP dans les produits
// ✅ FIXES :
//    - window.log exposé (utilisé par le script inline index.html)
//    - apiFetch centralisé + Authorization auto si token dispo
//    - refreshMovements auto quand #movementsDays change
//    - restockForm bind safe (n’empêche pas ton script inline)

(() => {
  // ---------------- SHOP CONTEXT ----------------
  function shopFromHost() {
    try {
      const host = new URLSearchParams(window.location.search).get("host") || "";
      if (!host) return "";
      const decoded = atob(host);
      const domain = decoded.split("/")[0].trim();
      return domain || "";
    } catch {
      return "";
    }
  }

  const SHOP = new URLSearchParams(window.location.search).get("shop") || shopFromHost() || "";

  const APP_PREFIX = (() => {
    const m = window.location.pathname.match(/^(\/apps\/[^/]+)/);
    return m ? m[1] : "";
  })();

  function withPrefix(path) {
    const p = String(path || "");
    if (!p) return APP_PREFIX || "";
    const normalized = p.startsWith("/") ? p : "/" + p;
    return (APP_PREFIX || "") + normalized;
  }

  function apiPath(path) {
    const base = withPrefix(path);
    if (!SHOP) return base;
    const hasQuery = base.includes("?");
    const sep = hasQuery ? "&" : "?";
    return `${base}${sep}shop=${encodeURIComponent(SHOP)}`;
  }

// ---------------- AUTH (Shopify Session Token via App Bridge) ----------------
let _appBridgeApp = null;
let _cfg = null;
let _tokenCache = { token: "", ts: 0 }; // cache ~20s

async function loadPublicConfig() {
  if (_cfg) return _cfg;
  try {
    const res = await fetch(apiPath("/api/public/config"));
    const data = await res.json();
    _cfg = data || {};
  } catch {
    _cfg = { apiKey: "", apiAuthRequired: false };
  }
  return _cfg;
}

function getHostParam() {
  return new URLSearchParams(window.location.search).get("host") || "";
}

function ensureAppBridge(apiKey) {
  if (_appBridgeApp) return _appBridgeApp;

  const host = getHostParam();
  if (!apiKey || !host) return null;

  // CDN UMD peut exposer plusieurs formes selon version/build
  const ABGlobal = window["app-bridge"] || window.AppBridge || window.shopifyAppBridge || null;

  const createApp =
    (ABGlobal && typeof ABGlobal.createApp === "function" && ABGlobal.createApp) ||
    (ABGlobal && ABGlobal.default && typeof ABGlobal.default.createApp === "function" && ABGlobal.default.createApp) ||
    null;

  if (!createApp) return null;

  _appBridgeApp = createApp({ apiKey, host, forceRedirect: true });
  return _appBridgeApp;
}

async function getSessionTokenStrict() {
  // cache 20s
  const now = Date.now();
  if (_tokenCache.token && now - _tokenCache.ts < 20000) return _tokenCache.token;

  // fallback si déjà injecté par toi
  const t1 = String(window.__SHOPIFY_SESSION_TOKEN__ || "").trim();
  if (t1) return (_tokenCache = { token: t1, ts: now }).token;

  const t2 = String(sessionStorage.getItem("shopify_session_token") || "").trim();
  if (t2) return (_tokenCache = { token: t2, ts: now }).token;

  const cfg = await loadPublicConfig();
  const apiKey = String(cfg.apiKey || "").trim();
  const app = ensureAppBridge(apiKey);
  if (!app) return "";

  const Utils = window["app-bridge-utils"];
  if (!Utils || typeof Utils.getSessionToken !== "function") return "";

  const token = await Utils.getSessionToken(app);
  if (token) _tokenCache = { token, ts: now };
  return token || "";
}

async function apiFetch(path, options = {}) {
  const opts = { ...options };
  opts.headers = new Headers(options.headers || {});

  if (opts.body && !opts.headers.has("Content-Type")) {
    opts.headers.set("Content-Type", "application/json");
  }

  // ✅ Ajout automatique du token
  const token = await getSessionTokenStrict();
  if (token && !opts.headers.has("Authorization")) {
    opts.headers.set("Authorization", `Bearer ${token}`);
    if (!opts.headers.has("X-Shopify-Session-Token")) {
      opts.headers.set("X-Shopify-Session-Token", token);
    }
  }

  return fetch(apiPath(path), opts);
}

  // ---------------- STATE ----------------
  const result = document.getElementById("result");

  let stockData = {};
  let catalogData = null;
  let serverInfo = {};
  let currentProductId = null;

  let currentCategoryFilter = "";
  let sortAlpha = true;
  let categories = [];

  let shopifyLocations = [];
  let currentLocationId = null;

  // ✅ NOUVEAU : État pour valeur stock et stats catégories
  let stockValue = { totalValue: 0, currency: "EUR", products: [] };
  let categoryStats = { totalGrams: 0, categories: [] };

  // ---------------- UTILS ----------------
  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function log(message, type = "info") {
    const timestamp = new Date().toLocaleTimeString("fr-FR");
    if (!result) return;

    result.textContent = `[${timestamp}] ${message}`;

    // ✅ Feedback visuel coloré
    result.className = "result-content";
    if (type === "success") result.classList.add("success");
    if (type === "error") result.classList.add("error");
    if (type === "info") result.classList.add("info");

    result.scrollTop = result.scrollHeight;
  }

  // ✅ IMPORTANT: exposé pour ton script inline index.html
  window.log = log;

  function formatDateTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("fr-FR");
  }

  function formatCurrency(value) {
    const n = Number(value || 0);
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(n);
  }

  async function safeJson(res) {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const txt = await res.text().catch(() => "");
      const err = new Error("Réponse non-JSON du serveur");
      err._raw = txt?.slice?.(0, 1000);
      throw err;
    }
    return res.json();
  }

  // ---------------- MODALS ----------------
  function ensureModalLayout(modalEl) {
    if (!modalEl) return;
    const panel = modalEl.querySelector(".modal-panel");
    if (!panel) return;

    panel.style.maxHeight = "92vh";
    panel.style.overflow = "hidden";

    const content = panel.querySelector(".modal-content") || panel.querySelector(".modal-body");
    if (content) {
      content.style.overflowY = "auto";
      content.style.webkitOverflowScrolling = "touch";
      content.style.maxHeight = "calc(92vh - 60px)";
    }
  }

  function closeTopmostModal() {
    const actives = Array.from(document.querySelectorAll(".modal.active"));
    if (!actives.length) return;
    const top = actives[actives.length - 1];
    top.classList.remove("active");
    document.body.classList.remove("modal-open");
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTopmostModal();
  });

  function ensureModalBackdrop(modalEl) {
    if (!modalEl) return;
    if (modalEl.querySelector(".modal-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.addEventListener("click", () => {
      modalEl.classList.remove("active");
      document.body.classList.remove("modal-open");
    });
    modalEl.prepend(backdrop);
  }

  function openModal(modalEl) {
    if (!modalEl) return;
    ensureModalBackdrop(modalEl);
    ensureModalLayout(modalEl);
    modalEl.classList.add("active");
    document.body.classList.add("modal-open");
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.remove("active");
    document.body.classList.remove("modal-open");
  }

  // ---------------- HEADER CONTROLS ----------------
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

        <div class="field" style="min-width:240px;">
          <label>Location Shopify</label>
          <select id="locationSelect">
            <option value="">Chargement...</option>
          </select>
          <div class="hint">Stock Shopify écrasé sur cette location.</div>
        </div>

        <div class="catalog-actions">
          <button class="btn btn-secondary btn-sm" id="btnCategories" type="button">🏷️ Catégories</button>
          <button class="btn btn-primary btn-sm" id="btnImport" type="button">➕ Import Shopify</button>
          <button class="btn btn-info btn-sm" id="btnExportStock" type="button">⬇️ Stock CSV</button>
          <button class="btn btn-secondary btn-sm" id="btnExportMovements" type="button">⬇️ Mouvements CSV</button>
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

    el("btnExportStock")?.addEventListener("click", () => (window.location.href = apiPath("/api/stock.csv")));
    el("btnExportMovements")?.addEventListener("click", () => (window.location.href = apiPath("/api/movements.csv")));

    el("locationSelect")?.addEventListener("change", async (e) => {
      const v = Number(e.target.value || 0);
      if (!v) return;
      await saveLocationId(v);
    });

    // ✅ refresh mouvements auto quand l’utilisateur change la période
    el("movementsDays")?.addEventListener("change", () => refreshMovements());
  }

  // ---------------- ✅ VALEUR TOTALE DU STOCK ----------------
  async function refreshStockValue() {
    try {
      const res = await apiFetch("/api/stock/value");
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur /api/stock/value");
      stockValue = data || { totalValue: 0, currency: "EUR", products: [] };
      displayStockValue();
    } catch (e) {
      console.error("Erreur chargement valeur stock:", e.message);
    }
  }

  function displayStockValue() {
    let card = el("stockValueCard");
    const statsGrid = document.querySelector(".stats-grid");
    if (!statsGrid) return;

    if (!card) {
      card = document.createElement("div");
      card.id = "stockValueCard";
      card.className = "card";
      card.style.gridColumn = "span 3";
      statsGrid.appendChild(card);
    }

    const value = Number(stockValue.totalValue || 0);

    card.innerHTML = `
      <div class="card-title">💰 Valeur totale du stock</div>
      <div class="card-sub">Coût réel de l'inventaire (CMP)</div>
      <div class="card-value" style="color: var(--success); -webkit-text-fill-color: unset;">${formatCurrency(value)}</div>
      <div class="card-foot">
        Basé sur le coût moyen pondéré de ${stockValue.products?.length || 0} produit(s)
      </div>
    `;
  }

  // ---------------- ✅ RÉPARTITION PAR CATÉGORIE ----------------
  async function refreshCategoryStats() {
    try {
      const res = await apiFetch("/api/stats/categories");
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur /api/stats/categories");
      categoryStats = data || { totalGrams: 0, categories: [] };
      displayCategoryBar();
    } catch (e) {
      console.error("Erreur chargement stats catégories:", e.message);
    }
  }

  function displayCategoryBar() {
    let container = el("categoryBarContainer");
    const statsGrid = document.querySelector(".stats-grid");
    if (!statsGrid) return;

    if (!container) {
      container = document.createElement("div");
      container.id = "categoryBarContainer";
      container.className = "card";
      container.style.gridColumn = "span 3";
      statsGrid.appendChild(container);
    }

    const cats = categoryStats.categories || [];
    const total = Number(categoryStats.totalGrams || 0);

    if (!cats.length || total <= 0) {
      container.innerHTML = `
        <div class="card-title">📊 Répartition du stock par catégorie</div>
        <div class="hint" style="margin-top: 12px;">Aucune donnée disponible</div>
      `;
      return;
    }

    const colors = [
      "#8b7fc8",
      "#10b981",
      "#f59e0b",
      "#ef4444",
      "#3b82f6",
      "#ec4899",
      "#14b8a6",
      "#f97316",
    ];

    const legend = cats
      .map((cat, i) => {
        const color = colors[i % colors.length];
        const percent = Number(cat.percentage || 0);
        const grams = Number(cat.totalGrams || 0);
        return `
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="width:16px; height:16px; background:${color}; border-radius:4px;"></div>
            <span style="font-size:13px; font-weight:600;">${escapeHtml(cat.categoryName)}</span>
            <span style="font-size:12px; color: var(--text-secondary); margin-left:auto;">${percent.toFixed(
              1
            )}% (${grams}g)</span>
          </div>
        `;
      })
      .join("");

    const barSegments = cats
      .map((cat, i) => {
        const color = colors[i % colors.length];
        const percent = Number(cat.percentage || 0);
        return `<div style="width:${percent}%; background:${color}; height:100%;" title="${escapeHtml(
          cat.categoryName
        )}: ${percent.toFixed(1)}%"></div>`;
      })
      .join("");

    container.innerHTML = `
      <div class="card-title">📊 Répartition du stock par catégorie</div>
      <div class="card-sub">Total: ${total}g répartis en ${cats.length} catégorie(s)</div>

      <div style="margin:16px 0;">
        <div style="height:32px; border-radius: var(--radius-md); overflow:hidden; display:flex; background: var(--surface); border: 1px solid var(--border);">
          ${barSegments}
        </div>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-top:16px;">
        ${legend}
      </div>
    `;
  }

  // ---------------- SERVER INFO ----------------
  async function getServerInfo() {
    try {
      const res = await apiFetch("/api/server-info");
      const data = await safeJson(res);

      serverInfo = data || {};

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

  // ---------------- SETTINGS / LOCATIONS ----------------
  function renderLocationSelect() {
    const sel = el("locationSelect");
    if (!sel) return;

    const locs = Array.isArray(shopifyLocations) ? shopifyLocations.slice() : [];
    locs.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" }));

    if (!locs.length) {
      sel.innerHTML = `<option value="">Aucune location</option>`;
      return;
    }

    sel.innerHTML = locs
      .map((l) => {
        const id = Number(l.id);
        const name = String(l.name || `Location ${id}`);
        const active = l.active ? "" : " (inactive)";
        return `<option value="${id}">${escapeHtml(name + active)} — ${id}</option>`;
      })
      .join("");

    if (currentLocationId) {
      sel.value = String(currentLocationId);
    } else {
      const firstActive = locs.find((l) => l.active)?.id || locs[0].id;
      sel.value = String(firstActive);
    }
  }

  async function loadShopifyLocations() {
    try {
      const res = await apiFetch("/api/shopify/locations");
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur /api/shopify/locations");
      shopifyLocations = Array.isArray(data.locations) ? data.locations : [];
      renderLocationSelect();
    } catch (e) {
      shopifyLocations = [];
      renderLocationSelect();
      log("❌ Erreur chargement locations Shopify: " + e.message, "error");
    }
  }

  async function loadSettings() {
    try {
      const res = await apiFetch("/api/settings");
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur /api/settings");
      currentLocationId = Number(data?.settings?.locationId || 0) || null;
      renderLocationSelect();
    } catch {
      currentLocationId = null;
      renderLocationSelect();
    }
  }

  async function saveLocationId(locationId) {
    try {
      const res = await apiFetch("/api/settings/location", {
        method: "POST",
        body: JSON.stringify({ locationId }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur save location");
      currentLocationId = Number(data?.settings?.locationId || locationId) || locationId;
      renderLocationSelect();
      log(`✅ Location Shopify enregistrée: ${currentLocationId}`, "success");
    } catch (e) {
      log("❌ Erreur enregistrement location: " + e.message, "error");
      alert("Erreur: " + e.message);
      renderLocationSelect();
    }
  }

  // ---------------- CATEGORIES ----------------
  async function loadCategories() {
    try {
      const res = await apiFetch("/api/categories");
      const data = await safeJson(res);
      categories = Array.isArray(data.categories) ? data.categories : [];
      updateCategoryFilterOptions();
      updateProductCategoriesOptions();
    } catch (e) {
      log("❌ Erreur chargement catégories: " + e.message, "error");
    }
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
        .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
        .join("");

    if (current) sel.value = current;
  }

  function updateProductCategoriesOptions() {
    const sel = el("productCategoriesSelect");
    if (!sel) return;

    sel.innerHTML = categories
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }))
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
      .join("");
  }

  // ---------------- STOCK ----------------
  async function refreshStock() {
    ensureCatalogControls();
    log("⏳ Actualisation du stock...", "info");

    try {
      const qs = new URLSearchParams();
      if (sortAlpha) qs.set("sort", "alpha");
      if (currentCategoryFilter) qs.set("category", currentCategoryFilter);

      const path = "/api/stock" + (qs.toString() ? `?${qs.toString()}` : "");
      const res = await apiFetch(path);
      const data = await safeJson(res);

      if (!res.ok) throw new Error(data?.error || "Erreur /api/stock");

      if (data && Array.isArray(data.products)) {
        catalogData = data;
        categories = Array.isArray(data.categories) ? data.categories : categories;

        const map = {};
        for (const p of data.products) {
          map[p.productId] = {
            name: p.name,
            totalGrams: p.totalGrams,
            averageCostPerGram: p.averageCostPerGram || 0,
            variants: p.variants || {},
            categoryIds: p.categoryIds || [],
          };
        }
        stockData = map;

        updateCategoryFilterOptions();
        displayProductsGrouped(stockData);
        updateStats(stockData);

        await refreshStockValue();
        await refreshCategoryStats();

        log("✅ Stock actualisé", "success");
        return;
      }

      stockData = data || {};
      displayProductsGrouped(stockData);
      updateStats(stockData);

      await refreshStockValue();
      await refreshCategoryStats();

      log("✅ Stock actualisé", "success");
    } catch (err) {
      log("❌ ERREUR: " + err.message, "error");
      const list = el("productList");
      if (list) {
        list.innerHTML = `<div style="padding:12px;color:#fca5a5;">Erreur de chargement stock: ${escapeHtml(
          err.message
        )}</div>`;
      }
    }
  }

  function updateStats(stock) {
    const products = Object.values(stock || {});
    const totalProducts = products.length;
    const totalGrams = products.reduce((acc, p) => acc + Number(p.totalGrams || 0), 0);

    const countEl = el("statProducts");
    const gramsEl = el("statGrams");
    const lastEl = el("lastUpdate");

    if (countEl) countEl.textContent = totalProducts;
    if (gramsEl) gramsEl.textContent = `${totalGrams}g`;
    if (lastEl) lastEl.textContent = new Date().toLocaleString("fr-FR");
  }

  // ---------------- GROUPED DISPLAY ----------------
  function getCategoryNameById(id) {
    return categories.find((c) => String(c.id) === String(id))?.name || null;
  }

  function displayProductsGrouped(stock) {
    const productList = el("productList");
    if (!productList) return;

    const entries = Object.entries(stock || {});
    if (!entries.length) {
      productList.innerHTML = `<div class="muted" style="padding:12px;">Aucun produit configuré</div>`;
      return;
    }

    const groups = new Map();

    for (const [id, p] of entries) {
      const catIds = Array.isArray(p.categoryIds) ? p.categoryIds : [];
      const first = catIds[0] || "__uncat__";
      const groupName = first === "__uncat__" ? "Sans catégorie" : getCategoryNameById(first) || "Sans catégorie";

      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push([id, p]);
    }

    const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));

    productList.innerHTML = groupNames
      .map((gName) => {
        const items = groups.get(gName) || [];

        if (sortAlpha) {
          items.sort((a, b) => String(a[1].name).localeCompare(String(b[1].name), "fr", { sensitivity: "base" }));
        }

        const cards = items
          .map(([id, product]) => {
            const total = Number(product.totalGrams || 0);
            const avgCost = Number(product.averageCostPerGram || 0);
            const percent = Math.max(0, Math.min(100, Math.round((total / 200) * 100)));
            const lowClass = total <= Number(serverInfo?.lowStockThreshold || 10) ? " low" : "";

            const costBadge =
              avgCost > 0
                ? `<div style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">CMP: ${avgCost.toFixed(
                    2
                  )}€/g</div>`
                : "";

            return `
              <button class="product-item${lowClass}" type="button" data-open-product="${escapeHtml(id)}">
                <div class="product-header">
                  <div>
                    <div class="product-name">${escapeHtml(product.name)}</div>
                    ${costBadge}
                  </div>
                  <div class="product-stock">${total}g</div>
                </div>
                <div class="stock-bar">
                  <div class="stock-bar-fill" style="width:${percent}%"></div>
                </div>
              </button>
            `;
          })
          .join("");

        return `
          <div class="category-section">
            <div class="category-title">
              <div>${escapeHtml(gName)}</div>
              <div class="category-count">${items.length} produit(s)</div>
            </div>
            <div class="product-grid">${cards}</div>
          </div>
        `;
      })
      .join("");

    productList.querySelectorAll("[data-open-product]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-open-product");
        openProductModal(String(id));
      });
    });
  }

  // ---------------- MOVEMENTS ----------------
  async function refreshMovements() {
    const box = el("movementsList");
    if (!box) return;

    const days = Number(el("movementsDays")?.value || 7);
    box.innerHTML = `<div class="muted" style="padding:10px;">Chargement...</div>`;

    try {
      const qs = new URLSearchParams();
      qs.set("limit", "300");
      qs.set("days", String(days));

      const path = "/api/movements" + (qs.toString() ? `?${qs.toString()}` : "");
      const res = await apiFetch(path);
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur /api/movements");

      let items = Array.isArray(data.data) ? data.data : [];
      if (!items.length) {
        box.innerHTML = `<div class="muted" style="padding:10px;">Aucun mouvement.</div>`;
        return;
      }

      items = items.slice().sort((a, b) => {
        const ta = new Date(a.ts || 0).getTime();
        const tb = new Date(b.ts || 0).getTime();
        return tb - ta;
      });

      box.innerHTML = items
        .map((m) => {
          const when = formatDateTime(m.ts);
          const delta = Number(m.gramsDelta ?? m.deltaGrams ?? 0);
          const sign = delta > 0 ? "+" : "";
          const source = m.source || m.type || "movement";
          const pname = m.productName ? ` • ${escapeHtml(m.productName)}` : "";
          const after = Number.isFinite(Number(m.totalAfter)) ? ` → ${Number(m.totalAfter)}g` : "";

          const deltaClass = delta > 0 ? "positive" : "negative";

          return `
            <div class="history-item">
              <div class="h-left">
                <div class="h-title">${escapeHtml(source)}${pname}</div>
                <div class="h-sub">${escapeHtml(when)}</div>
              </div>
              <div class="h-delta ${deltaClass}">${sign}${delta}g${after}</div>
            </div>
          `;
        })
        .join("");
    } catch (e) {
      box.innerHTML = `<div style="color:#fca5a5; padding:10px;">Erreur mouvements: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------------- TEST ORDER ----------------
  async function testOrder() {
    log("⏳ Traitement de la commande test en cours...", "info");
    try {
      const res = await apiFetch("/api/test-order", { method: "POST" });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur test-order");

      log("✅ COMMANDE TEST OK\n\n" + JSON.stringify(data, null, 2), "success");
      await refreshStock();
      await refreshMovements();
    } catch (err) {
      log("❌ ERREUR: " + err.message, "error");
      alert("Erreur: " + err.message);
    }
  }

  // ---------------- RESTOCK MODAL ----------------
  function openRestockModal() {
    const modal = el("restockModal");
    const select = el("productSelect");
    if (!modal || !select) return;

    ensureModalBackdrop(modal);

    select.innerHTML =
      '<option value="">Sélectionnez un produit...</option>' +
      Object.entries(stockData)
        .sort((a, b) => String(a[1]?.name || "").localeCompare(String(b[1]?.name || ""), "fr", { sensitivity: "base" }))
        .map(([id, product]) => {
          const avgCost = Number(product.averageCostPerGram || 0);
          const costInfo = avgCost > 0 ? ` (CMP: ${avgCost.toFixed(2)}€/g)` : "";
          return `<option value="${escapeHtml(id)}">${escapeHtml(product.name)} - Stock: ${Number(
            product.totalGrams || 0
          )}g${costInfo}</option>`;
        })
        .join("");

    openModal(modal);
  }

  function closeRestockModal() {
    const m = el("restockModal");
    if (m) closeModal(m);
    const f = el("restockForm");
    if (f) f.reset();
  }

  // ✅ bind safe : si tu gardes ton script inline, ça ne casse pas.
  function bindRestockFormOnce() {
    const form = el("restockForm");
    if (!form) return;
    if (form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    form.addEventListener("submit", async (e) => {
      // si ton inline script gère déjà, on laisse faire
      // (il fait e.preventDefault() aussi) => ici on ne bloque pas si déjà preventDefault.
      if (e.defaultPrevented) return;

      e.preventDefault();

      const productId = String(el("productSelect")?.value || "").trim();
      const grams = Number(el("restockGrams")?.value || 0);
      const purchasePricePerGram = Number(el("restockPurchasePrice")?.value || 0);

      if (!productId || !Number.isFinite(grams) || grams <= 0) return;

      try {
        const body = { productId, grams };
        if (purchasePricePerGram > 0) body.purchasePricePerGram = purchasePricePerGram;

        const res = await apiFetch("/api/restock", {
          method: "POST",
          body: JSON.stringify(body),
        });

        const data = await safeJson(res);
        if (!res.ok) throw new Error(data?.error || "Erreur restock");

        const message = data.cmpUpdated
          ? `✅ Stock réapprovisionné (+${grams}g) - CMP mis à jour`
          : `✅ Stock réapprovisionné (+${grams}g)`;

        log(message, "success");
        closeRestockModal();
        await refreshMovements();
        await refreshStock();
      } catch (err) {
        log("❌ Erreur restock: " + err.message, "error");
        alert("Erreur: " + err.message);
      }
    });
  }

  // ---------------- PRODUCT MODAL ----------------
  function openProductModal(productId) {
    const pid = String(productId);
    currentProductId = pid;

    const product = stockData[pid];
    if (!product) return;

    const modal = el("productModal");
    ensureModalBackdrop(modal);

    const title = el("productModalTitle");
    const totalInput = el("totalGramsInput");

    if (title) title.textContent = `📦 ${product.name}`;
    if (totalInput) totalInput.value = Number(product.totalGrams || 0);

    displayVariants(product.variants);
    ensureProductControlsUI();
    ensureProductCategoriesUI();

    const catSelect = el("productCategoriesSelect");
    if (catSelect) {
      const ids = Array.isArray(product.categoryIds) ? product.categoryIds.map(String) : [];
      for (const opt of Array.from(catSelect.options)) {
        opt.selected = ids.includes(String(opt.value));
      }
    }

    loadProductHistory(pid);
    openModal(modal);
  }

  function closeProductModal() {
    const modal = el("productModal");
    if (modal) closeModal(modal);
    currentProductId = null;
  }

  function displayVariants(variants) {
    const variantsList = el("variantsList");
    if (!variantsList) return;

    const arr = Object.entries(variants || {});
    if (!arr.length) {
      variantsList.innerHTML = `<div class="muted" style="padding:12px;">Aucune variante configurée</div>`;
      return;
    }

    arr.sort((a, b) => Number(a[0]) - Number(b[0]));

    variantsList.innerHTML = arr
      .map(([label, variant]) => {
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
      })
      .join("");
  }

  // ---------------- PRODUCT CONTROLS ----------------
  function ensureProductControlsUI() {
    const modalContent = document.querySelector("#productModal .modal-content");
    if (!modalContent) return;
    if (el("productAdjustBlock")) return;

    const block = document.createElement("div");
    block.id = "productAdjustBlock";
    block.className = "form-group";
    block.innerHTML = `
      <label>Stock total (ajouter / enlever en grammes)</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex: 1; min-width: 120px;">
          <input id="adjustTotalGrams" type="number" min="1" step="1" placeholder="Grammes" style="width:100%;" />
        </div>
        <div style="flex: 1; min-width: 120px;">
          <input id="adjustPurchasePrice" type="number" min="0" step="0.01" placeholder="Prix €/g (opt.)" style="width:100%;" />
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="btnAddTotal">➕ Ajouter</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnRemoveTotal">➖ Enlever</button>
        <div style="flex:1"></div>
        <button type="button" class="btn btn-danger btn-sm" id="btnDeleteProduct">🗑️ Supprimer produit</button>
      </div>
      <div class="hint">
        💡 Si vous renseignez le prix d'achat lors d'un ajout, le CMP sera recalculé automatiquement.
      </div>
    `;

    modalContent.appendChild(block);

    el("btnAddTotal")?.addEventListener("click", () => adjustTotal(+1));
    el("btnRemoveTotal")?.addEventListener("click", () => adjustTotal(-1));
    el("btnDeleteProduct")?.addEventListener("click", deleteCurrentProduct);
  }

  async function adjustTotal(sign) {
    if (!currentProductId) return;

    const grams = Number(el("adjustTotalGrams")?.value || 0);
    const purchasePrice = Number(el("adjustPurchasePrice")?.value || 0);

    if (!grams || grams <= 0) return alert("Entre une quantité de grammes valide");

    const gramsDelta = sign * grams;

    try {
      const body = { gramsDelta };
      if (sign > 0 && purchasePrice > 0) body.purchasePricePerGram = purchasePrice;

      const res = await apiFetch(`/api/products/${encodeURIComponent(currentProductId)}/adjust-total`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur ajustement total");

      const message = data.cmpUpdated
        ? `✅ Stock mis à jour (${gramsDelta > 0 ? "+" : ""}${gramsDelta}g) - CMP recalculé: ${Number(
            data.product?.averageCostPerGram || 0
          ).toFixed(2)}€/g`
        : `✅ Stock mis à jour (${gramsDelta > 0 ? "+" : ""}${gramsDelta}g)`;

      log(message, "success");

      await refreshStock();
      await refreshMovements();

      const updated = stockData[currentProductId];
      if (updated) {
        const totalInput = el("totalGramsInput");
        if (totalInput) totalInput.value = Number(updated.totalGrams || 0);
        displayVariants(updated.variants);
        loadProductHistory(currentProductId);
      }

      if (el("adjustTotalGrams")) el("adjustTotalGrams").value = "";
      if (el("adjustPurchasePrice")) el("adjustPurchasePrice").value = "";
    } catch (e) {
      log("❌ Erreur ajustement total: " + e.message, "error");
      alert("Erreur: " + e.message);
    }
  }

  async function deleteCurrentProduct() {
    if (!currentProductId) return;

    const p = stockData[currentProductId];
    const name = p?.name || currentProductId;

    if (!confirm(`Supprimer "${name}" de l'interface ? (cela ne supprime PAS le produit Shopify)`)) return;

    try {
      const res = await apiFetch(`/api/products/${encodeURIComponent(currentProductId)}`, { method: "DELETE" });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur suppression");

      log(`✅ Produit supprimé: ${name}`, "success");
      closeProductModal();
      await refreshStock();
      await refreshMovements();
    } catch (e) {
      log("❌ Erreur suppression produit: " + e.message, "error");
      alert("Erreur: " + e.message);
    }
  }

  function ensureProductCategoriesUI() {
    const modalContent = document.querySelector("#productModal .modal-content");
    if (!modalContent) return;
    if (el("productCategoriesSelect")) return;

    const block = document.createElement("div");
    block.className = "form-group";
    block.innerHTML = `
      <label>Catégories</label>
      <select id="productCategoriesSelect" multiple size="6"></select>
      <div class="hint">Ctrl (Windows) / Cmd (Mac) pour sélectionner plusieurs. (Aucune sélection = Sans catégorie)</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
        <button type="button" class="btn btn-secondary btn-sm" id="btnClearCategories">🧹 Tout enlever</button>
        <button type="button" class="btn btn-primary btn-sm" id="btnSaveCategories">💾 Enregistrer</button>
      </div>
    `;

    modalContent.appendChild(block);
    updateProductCategoriesOptions();

    el("btnSaveCategories")?.addEventListener("click", saveProductCategories);
    el("btnClearCategories")?.addEventListener("click", () => {
      const sel = el("productCategoriesSelect");
      if (!sel) return;
      for (const opt of Array.from(sel.options)) opt.selected = false;
    });
  }

  async function saveProductCategories() {
    if (!currentProductId) return;
    const sel = el("productCategoriesSelect");
    if (!sel) return;

    const categoryIds = Array.from(sel.selectedOptions).map((o) => o.value);

    try {
      const res = await apiFetch(`/api/products/${encodeURIComponent(currentProductId)}/categories`, {
        method: "POST",
        body: JSON.stringify({ categoryIds }),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur");

      log("✅ Catégories enregistrées", "success");
      await refreshStock();
      await refreshMovements();

      const updated = stockData[currentProductId];
      if (updated) {
        const ids = Array.isArray(updated.categoryIds) ? updated.categoryIds.map(String) : [];
        for (const opt of Array.from(sel.options)) opt.selected = ids.includes(String(opt.value));
      }

      loadProductHistory(currentProductId);
    } catch (e) {
      log("❌ Erreur catégories: " + e.message, "error");
      alert("Erreur: " + e.message);
    }
  }

  async function loadProductHistory(productId) {
    const modalContent = document.querySelector("#productModal .modal-content");
    if (!modalContent) return;

    let block = el("productHistoryBlock");
    if (!block) {
      block = document.createElement("div");
      block.id = "productHistoryBlock";
      block.className = "product-history";
      block.innerHTML = `
        <div class="card-title">🕐 Historique du produit</div>
        <div class="hint" style="margin-top:6px;">Derniers mouvements liés à ce produit (récents en haut).</div>
        <div id="productHistoryList" class="history-list"></div>
      `;
      modalContent.appendChild(block);
    }

    const list = el("productHistoryList");
    if (!list) return;

    list.innerHTML = `<div class="muted" style="padding:10px;">Chargement...</div>`;

    try {
      const res = await apiFetch(`/api/products/${encodeURIComponent(productId)}/history?limit=200`);
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur history");

      let items = Array.isArray(data.data) ? data.data : [];
      if (!items.length) {
        list.innerHTML = `<div class="muted" style="padding:10px;">Aucun mouvement.</div>`;
        return;
      }

      items = items.slice().sort((a, b) => {
        const ta = new Date(a.ts || 0).getTime();
        const tb = new Date(b.ts || 0).getTime();
        return tb - ta;
      });

      list.innerHTML = items
        .map((m) => {
          const when = formatDateTime(m.ts);
          const delta = Number(m.gramsDelta ?? 0);
          const sign = delta > 0 ? "+" : "";
          const source = m.source || "movement";
          const totalAfter = Number(m.totalAfter ?? NaN);
          const deltaClass = delta > 0 ? "positive" : "negative";

          return `
            <div class="history-item">
              <div class="h-left">
                <div class="h-title">${escapeHtml(source)}</div>
                <div class="h-sub">${escapeHtml(when)}</div>
              </div>
              <div class="h-delta ${deltaClass}">${sign}${delta}g ${Number.isFinite(totalAfter) ? `→ ${totalAfter}g` : ""}</div>
            </div>
          `;
        })
        .join("");
    } catch (e) {
      list.innerHTML = `<div style="color:#fca5a5; padding:10px;">Erreur: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------------- CATEGORIES MODAL ----------------
  function openCategoriesModal() {
    let modal = el("categoriesModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "categoriesModal";
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-panel">
          <div class="modal-content">
            <div class="modal-head">
              <div class="modal-title">🏷️ Catégories</div>
              <button class="btn btn-close" type="button" id="btnCloseCategories">✖</button>
            </div>

            <div class="modal-body">
              <div class="info-box">
                Crée des catégories pour trier tes produits (ex: Fleurs, Résines, Gummies…).
              </div>

              <div style="display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;">
                <input id="newCategoryName" placeholder="Nom de catégorie (ex: Fleurs)" style="flex:1; min-width:220px;" />
                <button class="btn btn-primary btn-sm" id="btnAddCategory" type="button">➕ Ajouter</button>
              </div>

              <div id="categoriesList" class="categories-list"></div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      ensureModalBackdrop(modal);
      ensureModalLayout(modal);

      el("btnCloseCategories")?.addEventListener("click", () => closeModal(modal));
      el("btnAddCategory")?.addEventListener("click", async () => {
        const input = el("newCategoryName");
        const name = input?.value?.trim() || "";
        if (!name) return;

        try {
          const res = await apiFetch("/api/categories", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          const data = await safeJson(res);
          if (!res.ok) throw new Error(data?.error || "Erreur");

          if (input) input.value = "";
          await loadCategories();
          await refreshStock();
          renderCategoriesList();
          await refreshMovements();
          log(`✅ Catégorie créée: ${name}`, "success");
        } catch (e) {
          log("❌ Erreur création catégorie: " + e.message, "error");
          alert("Erreur: " + e.message);
        }
      });
    }

    renderCategoriesList();
    openModal(modal);
  }

  function renderCategoriesList() {
    const list = el("categoriesList");
    if (!list) return;

    const sorted = categories
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }));

    if (!sorted.length) {
      list.innerHTML = `<div class="muted" style="padding:10px;">Aucune catégorie</div>`;
      return;
    }

    list.innerHTML = sorted
      .map(
        (c) => `
        <div class="category-item">
          <div class="category-name">${escapeHtml(c.name)}</div>
          <div class="category-actions">
            <button class="btn btn-secondary btn-sm" data-act="rename" data-id="${escapeHtml(c.id)}" type="button">✏️ Renommer</button>
            <button class="btn btn-danger btn-sm" data-act="delete" data-id="${escapeHtml(c.id)}" type="button">🗑️ Supprimer</button>
          </div>
        </div>
      `
      )
      .join("");

    list.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        const act = btn.getAttribute("data-act");

        try {
          if (act === "rename") {
            const name = prompt("Nouveau nom de la catégorie ?");
            if (!name) return;

            const res = await apiFetch(`/api/categories/${encodeURIComponent(id)}`, {
              method: "PUT",
              body: JSON.stringify({ name: name.trim() }),
            });
            const data = await safeJson(res);
            if (!res.ok) throw new Error(data?.error || "Erreur");
            log(`✅ Catégorie renommée: ${name}`, "success");
          }

          if (act === "delete") {
            if (!confirm("Supprimer cette catégorie ?")) return;

            const res = await apiFetch(`/api/categories/${encodeURIComponent(id)}`, { method: "DELETE" });
            const data = await safeJson(res);
            if (!res.ok) throw new Error(data?.error || "Erreur");
            log(`✅ Catégorie supprimée`, "success");
          }

          await loadCategories();
          await refreshStock();
          renderCategoriesList();
          await refreshMovements();
        } catch (e) {
          log("❌ Erreur catégorie: " + e.message, "error");
          alert("Erreur: " + e.message);
        }
      });
    });
  }

  // ---------------- IMPORT MODAL ----------------
  function openImportModal() {
    let modal = el("importModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "importModal";
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-panel modal-wide">
          <div class="modal-content">
            <div class="modal-head">
              <div class="modal-title">➕ Import depuis Shopify</div>
              <button class="btn btn-close" type="button" id="btnCloseImport">✖</button>
            </div>

            <div class="modal-body">
              <div class="import-toolbar">
                <input id="importQuery" placeholder="Rechercher un produit (ex: amnesia)" style="flex:1;min-width:260px;" />
                <button class="btn btn-info btn-sm" id="btnSearchShopify" type="button">🔍 Rechercher</button>

                <div class="field" style="min-width:220px;">
                  <label>Catégorie (optionnel)</label>
                  <select id="importCategory">
                    <option value="">Aucune</option>
                  </select>
                </div>
              </div>

              <div id="importResults" class="import-results"></div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      ensureModalBackdrop(modal);
      ensureModalLayout(modal);

      el("btnCloseImport")?.addEventListener("click", () => closeModal(modal));
      el("btnSearchShopify")?.addEventListener("click", () => searchShopifyProducts());
    }

    const sel = el("importCategory");
    if (sel) {
      sel.innerHTML =
        `<option value="">Aucune</option>` +
        categories
          .slice()
          .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }))
          .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
          .join("");
    }

    const results = el("importResults");
    if (results) {
      results.innerHTML = `<div class="muted" style="padding:10px;">Lance une recherche pour afficher tes produits Shopify.</div>`;
    }

    openModal(modal);
  }

  async function searchShopifyProducts() {
    const q = el("importQuery")?.value?.trim() || "";
    const results = el("importResults");
    if (!results) return;

    results.innerHTML = `<div class="muted" style="padding:10px;">⏳ Recherche en cours...</div>`;

    try {
      const qs = new URLSearchParams();
      qs.set("limit", "100");
      if (q) qs.set("query", q);

      const path = "/api/shopify/products" + (qs.toString() ? `?${qs.toString()}` : "");
      const res = await apiFetch(path);
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur");

      const items = Array.isArray(data.products) ? data.products : [];
      if (!items.length) {
        results.innerHTML = `<div class="muted" style="padding:10px;">Aucun produit trouvé.</div>`;
        return;
      }

      results.innerHTML = items
        .map(
          (p) => `
          <div class="import-item">
            <div class="import-main">
              <div class="import-title">${escapeHtml(p.title)}</div>
              <div class="import-sub">ID: ${escapeHtml(p.id)} • Variantes: ${escapeHtml(p.variantsCount ?? "?")}</div>
            </div>
            <button class="btn btn-primary btn-sm" data-import="${escapeHtml(p.id)}" type="button">➕ Importer</button>
          </div>
        `
        )
        .join("");

      results.querySelectorAll("button[data-import]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const productId = btn.getAttribute("data-import");
          await importProduct(productId);
        });
      });
    } catch (e) {
      results.innerHTML = `<div style="color:#fca5a5; padding:10px;">Erreur: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function importProduct(productId) {
    const cat = el("importCategory")?.value || "";
    const categoryIds = cat ? [cat] : [];

    log(`⏳ Import du produit Shopify ${productId}...`, "info");

    try {
      const res = await apiFetch("/api/import/product", {
        method: "POST",
        body: JSON.stringify({ productId, categoryIds }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur");

      log("✅ Produit importé", "success");
      await refreshStock();
      await refreshMovements();
    } catch (e) {
      log("❌ Import échoué: " + e.message, "error");
      alert("Erreur: " + e.message);
    }
  }

  // ---------------- INIT ----------------
  window.addEventListener("load", async () => {
    document.body.classList.add("full-width");

    injectAppCss();
    ensureCatalogControls();
    bindRestockFormOnce();

    await getServerInfo();
    await loadSettings();
    await loadShopifyLocations();
    await loadCategories();

    await refreshStock();
    await refreshMovements();

    // Expose global functions (index.html boutons)
    window.openProductModal = openProductModal;
    window.openRestockModal = openRestockModal;
    window.closeRestockModal = closeRestockModal;
    window.closeProductModal = closeProductModal;
    window.testOrder = testOrder;
    window.refreshMovements = refreshMovements;
    window.refreshStock = refreshStock;
  });
})();

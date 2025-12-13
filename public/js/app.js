// ============================================
// BULK STOCK MANAGER - Front (Admin UI)
// - Produits groupés par catégorie
// - Modals avec backdrop (lisibilité)
// - Catégories : assignation produit OK
// - Ajustement stock TOTAL (+ / - en grammes)
// - Suppression produit (config uniquement)
// - Historique produit (date+heure, récent en haut)
// ============================================

(() => {
  // ---------------- DOM / state ----------------
  const result = document.getElementById("result");

  let stockData = {};      // map { [productId]: {name,totalGrams,variants,categoryIds} }
  let catalogData = null;  // { products:[], categories:[] }
  let serverInfo = {};
  let currentProductId = null;

  let currentCategoryFilter = "";
  let sortAlpha = true;
  let categories = []; // [{id,name}]

  // ---------------- utils ----------------
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

  function formatDateTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("fr-FR"); // date + heure
  }

  async function safeJson(res) {
    // évite les crash si le serveur renvoie HTML
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const txt = await res.text().catch(() => "");
      const err = new Error("Réponse non-JSON du serveur");
      err._raw = txt?.slice?.(0, 5000);
      throw err;
    }
    return res.json();
  }

  // ---------------- modal backdrop ----------------
  function ensureModalBackdrop(modalEl) {
    if (!modalEl) return;
    if (modalEl.querySelector(".modal-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.addEventListener("click", () => modalEl.classList.remove("active"));

    // backdrop derrière le panel
    modalEl.prepend(backdrop);
  }

  function openModal(modalEl) {
    if (!modalEl) return;
    ensureModalBackdrop(modalEl);
    modalEl.classList.add("active");
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.remove("active");
  }

  // ---------------- header controls ----------------
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
          <button class="btn btn-secondary btn-sm" id="btnCategories" type="button">📁 Catégories</button>
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

    el("btnExportStock")?.addEventListener("click", () => (window.location.href = "/api/stock.csv"));
    el("btnExportMovements")?.addEventListener("click", () => (window.location.href = "/api/movements.csv"));
  }

  // ---------------- server info ----------------
  async function getServerInfo() {
    try {
      const res = await fetch("/api/server-info");
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

  // ---------------- categories ----------------
  async function loadCategories() {
    try {
      const res = await fetch("/api/categories");
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

  // ---------------- stock ----------------
  async function refreshStock() {
    ensureCatalogControls();
    log("⏳ Actualisation du stock...", "info");

    try {
      const url = new URL(window.location.origin + "/api/stock");
      if (sortAlpha) url.searchParams.set("sort", "alpha");
      if (currentCategoryFilter) url.searchParams.set("category", currentCategoryFilter);

      const res = await fetch(url.pathname + url.search);
      const data = await safeJson(res);

      if (data && Array.isArray(data.products)) {
        catalogData = data;
        categories = Array.isArray(data.categories) ? data.categories : categories;

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
        displayProductsGrouped(stockData);
        updateStats(stockData);

        log("✅ Stock actualisé", "success");
        return;
      }

      // fallback legacy
      stockData = data || {};
      displayProductsGrouped(stockData);
      updateStats(stockData);
      log("✅ Stock actualisé", "success");
    } catch (err) {
      // si le serveur renvoie HTML, err._raw contiendra un extrait
      log("❌ ERREUR: " + err.message, "error");
      const list = el("productList");
      if (list) {
        list.innerHTML = `<div style="padding:12px;color:#fca5a5;">Erreur de chargement stock: ${escapeHtml(err.message)}</div>`;
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

  // ---------------- grouped display ----------------
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

    // Group by first category or "Sans catégorie"
    const groups = new Map();

    for (const [id, p] of entries) {
      const catIds = Array.isArray(p.categoryIds) ? p.categoryIds : [];
      const first = catIds[0] || "__uncat__";
      const groupName =
        first === "__uncat__" ? "Sans catégorie" : (getCategoryNameById(first) || "Sans catégorie");

      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push([id, p]);
    }

    const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));

    productList.innerHTML = groupNames
      .map((gName) => {
        const items = groups.get(gName) || [];

        if (sortAlpha) {
          items.sort((a, b) =>
            String(a[1].name).localeCompare(String(b[1].name), "fr", { sensitivity: "base" })
          );
        }

        const cards = items
          .map(([id, product]) => {
            const total = Number(product.totalGrams || 0);
            const percent = Math.max(0, Math.min(100, Math.round((total / 200) * 100)));
            const lowClass = total <= Number(serverInfo?.lowStockThreshold || 10) ? " low" : "";

            return `
              <button class="product-item${lowClass}" type="button" data-open-product="${escapeHtml(id)}">
                <div class="product-header">
                  <div>
                    <div class="product-name">${escapeHtml(product.name)}</div>
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

    // Bind open product events (no inline onclick)
    productList.querySelectorAll("[data-open-product]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-open-product");
        openProductModal(String(id));
      });
    });
  }

  // ---------------- test order ----------------
  async function testOrder() {
    log("⏳ Traitement de la commande test en cours...", "info");
    try {
      const res = await fetch("/api/test-order", { method: "POST" });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur test-order");

      log("✅ COMMANDE TEST OK\n\n" + JSON.stringify(data, null, 2), "success");
      await refreshStock();
    } catch (err) {
      log("❌ ERREUR: " + err.message, "error");
      alert("Erreur: " + err.message);
    }
  }

  // ---------------- restock modal (total grams) ----------------
  function openRestockModal() {
    const modal = el("restockModal");
    const select = el("productSelect");
    if (!modal || !select) return;

    ensureModalBackdrop(modal);

    select.innerHTML =
      '<option value="">Sélectionnez un produit...</option>' +
      Object.entries(stockData)
        .sort((a, b) => String(a[1]?.name || "").localeCompare(String(b[1]?.name || ""), "fr", { sensitivity: "base" }))
        .map(([id, product]) =>
          `<option value="${escapeHtml(id)}">${escapeHtml(product.name)} (Stock: ${Number(product.totalGrams || 0)}g)</option>`
        )
        .join("");

    openModal(modal);
  }

  function closeRestockModal() {
    const m = el("restockModal");
    if (m) closeModal(m);
    const f = el("restockForm");
    if (f) f.reset();
  }

  // ---------------- product modal ----------------
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

    // apply current categories selection
    const catSelect = el("productCategoriesSelect");
    if (catSelect) {
      const ids = Array.isArray(product.categoryIds) ? product.categoryIds.map(String) : [];
      for (const opt of Array.from(catSelect.options)) {
        opt.selected = ids.includes(String(opt.value));
      }
    }

    // load history (recent first)
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

    // tri par grammes si label numérique
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

  // ---------------- product controls: adjust total + delete ----------------
  function ensureProductControlsUI() {
    const modalContent = document.querySelector("#productModal .modal-content");
    if (!modalContent) return;
    if (el("productAdjustBlock")) return;

    const block = document.createElement("div");
    block.id = "productAdjustBlock";
    block.className = "form-group";
    block.innerHTML = `
      <label>Stock total (ajouter / enlever en grammes)</label>
      <div class="product-adjust-row">
        <input id="adjustTotalGrams" type="number" min="1" step="1" placeholder="Ex: 50" />
        <button type="button" class="btn btn-primary btn-sm" id="btnAddTotal">➕ Ajouter</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnRemoveTotal">➖ Enlever</button>
        <div class="spacer"></div>
        <button type="button" class="btn btn-secondary btn-sm" id="btnDeleteProduct">🗑️ Supprimer produit</button>
      </div>
      <div class="hint muted">Ici on ajuste directement le stock total (pas par variante).</div>
    `;

    modalContent.appendChild(block);

    el("btnAddTotal")?.addEventListener("click", () => adjustTotal(+1));
    el("btnRemoveTotal")?.addEventListener("click", () => adjustTotal(-1));
    el("btnDeleteProduct")?.addEventListener("click", deleteCurrentProduct);
  }

  async function adjustTotal(sign) {
    if (!currentProductId) return;

    const grams = Number(el("adjustTotalGrams")?.value || 0);
    if (!grams || grams <= 0) return alert("Entre une quantité de grammes valide");

    const gramsDelta = sign * grams;

    try {
      const res = await fetch(`/api/products/${encodeURIComponent(currentProductId)}/adjust-total`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gramsDelta }),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur ajustement total");

      log(`✅ Stock total mis à jour (${gramsDelta > 0 ? "+" : ""}${gramsDelta}g)`, "success");

      await refreshStock();

      // refresh modal content
      const updated = stockData[currentProductId];
      if (updated) {
        const totalInput = el("totalGramsInput");
        if (totalInput) totalInput.value = Number(updated.totalGrams || 0);
        displayVariants(updated.variants);
        loadProductHistory(currentProductId);
      }
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
      const res = await fetch(`/api/products/${encodeURIComponent(currentProductId)}`, { method: "DELETE" });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur suppression");

      log(`✅ Produit supprimé: ${name}`, "success");
      closeProductModal();
      await refreshStock();
    } catch (e) {
      log("❌ Erreur suppression produit: " + e.message, "error");
      alert("Erreur: " + e.message);
    }
  }

  // ---------------- categories in product modal ----------------
  function ensureProductCategoriesUI() {
    const modalContent = document.querySelector("#productModal .modal-content");
    if (!modalContent) return;
    if (el("productCategoriesSelect")) return;

    const block = document.createElement("div");
    block.className = "form-group";
    block.innerHTML = `
      <label>Catégories</label>
      <select id="productCategoriesSelect" multiple size="6"></select>
      <div class="hint muted">Ctrl (Windows) / Cmd (Mac) pour sélectionner plusieurs. (Aucune sélection = Sans catégorie)</div>
      <div class="row" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
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
      const res = await fetch(`/api/products/${encodeURIComponent(currentProductId)}/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryIds }),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur");

      log("✅ Catégories enregistrées", "success");
      await refreshStock();

      // reselection based on updated
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

  // ---------------- product history ----------------
  async function loadProductHistory(productId) {
    const modalContent = document.querySelector("#productModal .modal-content");
    if (!modalContent) return;

    let block = el("productHistoryBlock");
    if (!block) {
      block = document.createElement("div");
      block.id = "productHistoryBlock";
      block.className = "product-history";
      block.innerHTML = `
        <div class="card-title">🕒 Historique du produit</div>
        <div class="muted" style="margin-top:6px;">Derniers mouvements liés à ce produit (récents en haut).</div>
        <div id="productHistoryList" class="history-list"></div>
      `;
      modalContent.appendChild(block);
    }

    const list = el("productHistoryList");
    if (!list) return;

    list.innerHTML = `<div class="muted" style="padding:10px;">Chargement...</div>`;

    try {
      const res = await fetch(`/api/products/${encodeURIComponent(productId)}/history?limit=200`);
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur history");

      let items = Array.isArray(data.data) ? data.data : (Array.isArray(data.movements) ? data.movements : []);
      if (!items.length) {
        list.innerHTML = `<div class="muted" style="padding:10px;">Aucun mouvement.</div>`;
        return;
      }

      // ✅ tri récent en haut (au cas où l'API ne trie pas)
      items = items.slice().sort((a, b) => {
        const ta = new Date(a.ts || a.createdAt || 0).getTime();
        const tb = new Date(b.ts || b.createdAt || 0).getTime();
        return tb - ta;
      });

      list.innerHTML = items
        .map((m) => {
          const when = formatDateTime(m.ts || m.createdAt);
          const delta = Number(m.gramsDelta || 0);
          const sign = delta > 0 ? "+" : "";
          const source = m.source || "movement";
          const totalAfter = Number(m.totalAfter ?? NaN);

          return `
            <div class="history-item">
              <div class="h-left">
                <div class="h-title">${escapeHtml(source)}</div>
                <div class="h-sub">${escapeHtml(when)}</div>
              </div>
              <div class="h-delta">${sign}${delta}g ${Number.isFinite(totalAfter) ? `→ ${totalAfter}g` : ""}</div>
            </div>
          `;
        })
        .join("");
    } catch (e) {
      list.innerHTML = `<div style="color:#fca5a5; padding:10px;">Erreur: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------------- Categories modal ----------------
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
              <div class="modal-title">📁 Catégories</div>
              <button class="btn btn-close" type="button" id="btnCloseCategories">✖</button>
            </div>

            <div class="info-box">
              Crée des catégories pour trier tes produits (ex: Fleurs, Résines, Gummies…).
            </div>

            <div class="catalog-modal-row">
              <input id="newCategoryName" placeholder="Nom de catégorie (ex: Fleurs)" />
              <button class="btn btn-primary btn-sm" id="btnAddCategory" type="button">Ajouter</button>
            </div>

            <div id="categoriesList" class="categories-list"></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      ensureModalBackdrop(modal);

      el("btnCloseCategories")?.addEventListener("click", () => closeModal(modal));
      el("btnAddCategory")?.addEventListener("click", async () => {
        const input = el("newCategoryName");
        const name = input?.value?.trim() || "";
        if (!name) return;

        try {
          const res = await fetch("/api/categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          const data = await safeJson(res);
          if (!res.ok) throw new Error(data?.error || "Erreur");

          if (input) input.value = "";
          await loadCategories();
          await refreshStock();
          renderCategoriesList();
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

    const sorted = categories.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" }));
    if (!sorted.length) {
      list.innerHTML = `<div class="muted" style="padding:10px;">Aucune catégorie</div>`;
      return;
    }

    list.innerHTML = sorted
      .map((c) => `
        <div class="category-item">
          <div class="category-name">${escapeHtml(c.name)}</div>
          <div class="category-actions">
            <button class="btn btn-secondary btn-sm" data-act="rename" data-id="${escapeHtml(c.id)}" type="button">Renommer</button>
            <button class="btn btn-secondary btn-sm" data-act="delete" data-id="${escapeHtml(c.id)}" type="button">Supprimer</button>
          </div>
        </div>
      `)
      .join("");

    list.querySelectorAll("button[data-act]").forEach((btn) => {
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
            const data = await safeJson(res);
            if (!res.ok) throw new Error(data?.error || "Erreur");
          }

          if (act === "delete") {
            if (!confirm("Supprimer cette catégorie ?")) return;

            const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, { method: "DELETE" });
            const data = await safeJson(res);
            if (!res.ok) throw new Error(data?.error || "Erreur");
          }

          await loadCategories();
          await refreshStock();
          renderCategoriesList();
        } catch (e) {
          log("❌ Erreur catégorie: " + e.message, "error");
          alert("Erreur: " + e.message);
        }
      });
    });
  }

  // ---------------- Import modal ----------------
  function openImportModal() {
    let modal = el("importModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "importModal";
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-panel">
          <div class="modal-content modal-wide">
            <div class="modal-head">
              <div class="modal-title">➕ Import depuis Shopify</div>
              <button class="btn btn-close" type="button" id="btnCloseImport">✖</button>
            </div>

            <div class="import-toolbar">
              <input id="importQuery" placeholder="Rechercher un produit (ex: amnesia)" />
              <button class="btn btn-info btn-sm" id="btnSearchShopify" type="button">Rechercher</button>

              <div class="field">
                <label>Catégorie (optionnel)</label>
                <select id="importCategory">
                  <option value="">Aucune</option>
                </select>
              </div>
            </div>

            <div id="importResults" class="import-results"></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      ensureModalBackdrop(modal);

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
      const url = new URL(window.location.origin + "/api/shopify/products");
      url.searchParams.set("limit", "100");
      if (q) url.searchParams.set("query", q);

      const res = await fetch(url.pathname + url.search);
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur");

      const items = Array.isArray(data.products) ? data.products : [];
      if (!items.length) {
        results.innerHTML = `<div class="muted" style="padding:10px;">Aucun produit trouvé.</div>`;
        return;
      }

      results.innerHTML = items
        .map((p) => `
          <div class="import-item">
            <div class="import-main">
              <div class="import-title">${escapeHtml(p.title)}</div>
              <div class="import-sub">ID: ${escapeHtml(p.id)} • Variantes: ${escapeHtml(p.variantsCount ?? "?")}</div>
            </div>
            <button class="btn btn-primary btn-sm" data-import="${escapeHtml(p.id)}" type="button">Importer</button>
          </div>
        `)
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
      const res = await fetch("/api/import/product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, categoryIds }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || "Erreur");

      log("✅ Produit importé", "success");
      await refreshStock();
    } catch (e) {
      log("❌ Import échoué: " + e.message, "error");
      alert("Erreur: " + e.message);
    }
  }

  // ---------------- init ----------------
  window.addEventListener("load", async () => {
    // Affichage pleine largeur via CSS si tu gères body.full-width
    document.body.classList.add("full-width");

    await getServerInfo();
    await loadCategories();
    ensureCatalogControls();
    await refreshStock();

    // expose functions used by index.html buttons
    window.openProductModal = openProductModal;
    window.openRestockModal = openRestockModal;
    window.closeRestockModal = closeRestockModal;
    window.closeProductModal = closeProductModal;
    window.testOrder = testOrder;
  });
})();

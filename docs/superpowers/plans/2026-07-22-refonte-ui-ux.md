# Refonte UI/UX — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implémenter la refonte UI/UX validée dans `docs/superpowers/specs/2026-07-22-refonte-ui-ux-design.md` : tableaux scannables avec actions au survol, actions pré-remplies avec presets et undo, dashboard actionnable, deep-linking hash et navigation unifiée.

**Architecture:** 100 % frontend (`public/`). Monolithe `public/js/app.js` (IIFE exposant `window.app`), CSS dans `public/css/style.css` (design system OKLCH existant). Aucun bundler, aucune route backend modifiée. Chaque tâche est un commit indépendant vérifié en navigateur.

**Tech Stack:** Vanilla JS (ES5-style, concaténation de strings HTML), Lucide icons (`lucide.createIcons()` après toute injection HTML), Chart.js (sparklines), localStorage (persistance client), i18n via `t(key, fallback)`.

## Global Constraints

- Ne jamais renommer/supprimer une méthode exposée sur `window.app` — les `onclick="app.X()"` s'y attachent par nom. Toute nouvelle fonction appelée depuis du HTML injecté DOIT être ajoutée à l'objet `window.app` (chercher `window.app = {` dans `app.js`).
- Après toute injection de HTML contenant `<i data-lucide="...">`, appeler `if (typeof lucide !== "undefined") lucide.createIcons();`.
- Toute chaîne visible passe par `t("clé", "fallback FR")`. Les nouvelles clés sont listées par tâche et ajoutées à `public/js/i18n.js` (FR + EN) en Tâche 12 — `t()` retombe sur le fallback entre-temps.
- `API_BASE` reste `"/api"` ; les appels réseau passent par `authFetch(apiUrl(...))` existant.
- Interdiction de toucher : auth/App Bridge (`index.html` head), OAuth, webhooks, `syncShopifyProducts`, tout `server*.js`.
- Pas de framework, pas de bundler, pas de découpage d'`app.js`.
- **Pas de tests automatisés dans ce repo** (aucune infra jest exploitable pour un monolithe navigateur) : chaque tâche se vérifie manuellement en navigateur — étapes de vérification explicites, à exécuter sur la boutique de dev (`bulk-stock-manager-2.myshopify.com`) ou en local (`$env:NODE_ENV="development"; npx nodemon server.js` sous PowerShell).
- Échappement systématique : toute donnée dynamique injectée en HTML passe par `esc(...)`.
- Localisation des ancres : les numéros de ligne cités datent du 2026-07-22 — toujours relocaliser par recherche du nom de fonction avant d'éditer.

---

## Phase 1 — Socle CSS + tableaux Catalogue

### Task 1: Socle CSS de la refonte

**Files:**
- Modify: `public/css/style.css` (ajout d'une section en fin de fichier)

**Interfaces:**
- Produces (classes CSS consommées par les tâches 2-8) : `.u-num`, `.stock-gauge` (+ `__fill`, `is-critical|is-low|is-ok`), `.row-actions`, `.row-menu` (+ `.open`, `__item`, `.is-danger`), `.row-menu-btn`, `.table-sticky` (wrapper), `.qty-presets` / `.qty-preset`, `.toast-action`, `.modal-product-context` (+ `__name`, `__meta`), `.filter-chips` / `.filter-chip` (+ `__clear`), `.results-count`.

- [ ] **Step 1: Ajouter la section CSS en fin de `public/css/style.css`**

Ajouter à la toute fin du fichier :

```css
/* =====================================================
   REFONTE UI/UX 2026-07 — tableaux, actions, filtres
   Spec: docs/superpowers/specs/2026-07-22-refonte-ui-ux-design.md
   ===================================================== */

/* --- Numérique : chiffres tabulaires alignés à droite --- */
.u-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.u-num .unit { color: var(--text-tertiary); font-size: 0.85em; margin-left: 2px; }

/* --- Densité tableaux (style Linear) --- */
.data-table th { position: sticky; top: 0; z-index: 2; background: var(--bg-tertiary); }
.data-table td { padding-top: 8px; padding-bottom: 8px; }
.table-sticky { max-height: calc(100vh - var(--topbar-height) - 220px); overflow: auto; }

/* --- Jauge de stock --- */
.stock-gauge {
  width: 64px; height: 4px; border-radius: var(--radius-full);
  background: var(--bg-tertiary); overflow: hidden;
  display: inline-block; vertical-align: middle; margin-left: 8px;
}
.stock-gauge__fill { height: 100%; border-radius: inherit; transition: width var(--transition-normal); }
.stock-gauge.is-critical .stock-gauge__fill { background: var(--danger); }
.stock-gauge.is-low      .stock-gauge__fill { background: var(--warning); }
.stock-gauge.is-ok       .stock-gauge__fill { background: var(--success); }

/* --- Actions de ligne au survol --- */
.data-table td.cell-actions { text-align: right; white-space: nowrap; }
.row-actions { display: inline-flex; gap: 4px; opacity: 0; transition: opacity var(--transition-fast); }
.data-table tbody tr:hover .row-actions,
.data-table tbody tr:focus-within .row-actions { opacity: 1; }

/* --- Menu kebab de ligne --- */
.row-menu-wrap { position: relative; display: inline-block; }
.row-menu {
  display: none; position: absolute; right: 0; top: calc(100% + 4px); z-index: 30;
  min-width: 180px; padding: 4px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
}
.row-menu.open { display: block; }
.row-menu__item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px; border: 0; background: transparent; cursor: pointer;
  color: var(--text-primary); font-size: 13px; border-radius: var(--radius-sm);
  text-align: left;
}
.row-menu__item:hover { background: var(--surface-hover); }
.row-menu__item.is-danger { color: var(--danger); }
.row-menu__item .icon, .row-menu__item svg { width: 14px; height: 14px; }

/* --- Presets de quantité (modales restock/ajustement) --- */
.qty-presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 8px; }
.qty-preset {
  padding: 4px 10px; font-size: 12px; cursor: pointer;
  background: var(--bg-tertiary); color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: var(--radius-full);
  transition: all var(--transition-fast);
}
.qty-preset:hover { border-color: var(--accent-primary); color: var(--text-primary); }

/* --- Contexte produit verrouillé dans les modales --- */
.modal-product-context {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; margin-bottom: 12px;
  background: var(--bg-tertiary); border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.modal-product-context__name { font-weight: 600; font-size: 14px; }
.modal-product-context__meta { font-size: 12px; color: var(--text-secondary); }

/* --- Toast avec action (undo) --- */
.toast .toast-action {
  margin-left: 8px; flex-shrink: 0;
  color: var(--accent-primary); font-weight: 600;
  background: transparent; border: 0; cursor: pointer; font-size: 13px;
}
.toast .toast-action:hover { text-decoration: underline; }

/* --- Chips de filtres actifs + compteur de résultats --- */
.filter-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px 3px 10px; font-size: 12px;
  background: var(--accent-primary-glow); color: var(--text-primary);
  border: 1px solid var(--accent-primary); border-radius: var(--radius-full);
}
.filter-chip__clear { background: none; border: 0; cursor: pointer; color: inherit; padding: 0; line-height: 1; }
.results-count { font-size: 12px; color: var(--text-tertiary); }
```

- [ ] **Step 2: Vérifier en navigateur**

Charger l'app, ouvrir Catalogue et Dashboard : aucun changement visuel cassé attendu (les nouvelles classes ne sont pas encore consommées ; seuls `th` sticky et le padding des `td` changent légèrement). Vérifier : en-têtes de tableaux restent lisibles au scroll, aucune régression sur les deux thèmes (`data-theme="dark"` par défaut et light via Paramètres).

- [ ] **Step 3: Commit**

```powershell
git add public/css/style.css
git commit -m "feat(refonte): socle CSS tableaux, jauge stock, actions hover, presets"
```

### Task 2: renderTable v2 — jauge de stock, actions au survol, menu kebab

**Files:**
- Modify: `public/js/app.js` — `renderTable` (~6120), nouveaux helpers à placer juste au-dessus de `renderTable`, export `window.app` (chercher `window.app = {`)

**Interfaces:**
- Consumes: classes CSS Task 1 ; `getStatus`, `formatWeight`, `formatPricePerUnit`, `formatCurrency`, `esc`, `t`, `settingsData`, `selectedProducts` existants.
- Produces: `_statusOf(p)` → `"critical" | "low" | "ok"` ; `_stockGaugeHtml(p)` → string HTML ; `app.toggleRowMenu(pid, event)`. Consommés par les tâches 3, 7, 8.

- [ ] **Step 1: Ajouter les helpers au-dessus de `renderTable`**

```javascript
  // Statut stock aligné sur la logique dashboard (renderDashboard) :
  // mêmes seuils settings, mêmes bornes.
  function _statusOf(p) {
    var g = p.totalGrams || 0;
    var critT = (settingsData && settingsData.stock && Number(settingsData.stock.criticalThreshold)) || 0;
    var lowT = (settingsData && settingsData.stock && Number(settingsData.stock.lowStockThreshold)) || 0;
    if (g === 0 || (critT > 0 && g < critT)) return "critical";
    if (lowT > 0 && g < lowT) return "low";
    return "ok";
  }

  function _stockGaugeHtml(p) {
    var g = p.totalGrams || 0;
    var lowT = (settingsData && settingsData.stock && Number(settingsData.stock.lowStockThreshold)) || 0;
    var pct = lowT > 0 ? Math.max(0, Math.min(100, Math.round((g / (lowT * 2)) * 100))) : (g > 0 ? 100 : 0);
    return '<span class="stock-gauge is-' + _statusOf(p) + '" aria-hidden="true"><span class="stock-gauge__fill" style="width:' + pct + '%"></span></span>';
  }

  function toggleRowMenu(pid, ev) {
    if (ev) ev.stopPropagation();
    var menu = document.getElementById("rowmenu-" + pid);
    var open = document.querySelector(".row-menu.open");
    if (open && open !== menu) open.classList.remove("open");
    if (menu) menu.classList.toggle("open");
  }
```

Et enregistrer un unique listener global (à placer près des autres `document.addEventListener` du boot, ex. dans `setupNavigation`) :

```javascript
    document.addEventListener("click", function() {
      var open = document.querySelector(".row-menu.open");
      if (open) open.classList.remove("open");
    });
```

- [ ] **Step 2: Remplacer le corps de `renderTable`**

Remplacer la génération des lignes et des actions (les 5 boutons visibles) par :

```javascript
  function renderTable(products) {
    var rows = products
      .map(function (p) {
        var s = p.totalGrams || 0,
          cost = p.averageCostPerGram || 0;
        var st = getStatus(s);

        var stockClass = "";
        if (s === 0) {
          stockClass = cost > 0 ? " is-stock-out-recent" : " is-stock-out-empty";
        }

        var catChips = "";
        if (Array.isArray(p.categoryIds) && p.categoryIds.length > 0) {
          catChips = p.categoryIds.map(function(catId) {
            var cat = state.categories.find(function(c) { return c.id === catId; });
            return cat ? '<span class="category-chip">' + esc(cat.name) + '</span>' : "";
          }).join("");
        } else {
          catChips = '<span class="category-chip category-chip-empty">-</span>';
        }

        var isChecked = selectedProducts.has(p.productId) ? " checked" : "";
        var pid = esc(p.productId);

        return (
          '<tr class="product-row' + stockClass + '" data-product-id="' + pid + '" onclick="app.openProductDetails(\'' + pid + '\')" style="cursor:pointer">' +
          '<td onclick="event.stopPropagation()"><input type="checkbox" class="product-cb" data-id="' + pid + '"' + isChecked + ' onchange="app.toggleProductSelect(\'' + pid + '\', event)" style="cursor:pointer;width:16px;height:16px"></td>' +
          "<td>" + esc(p.name || p.title || t("products.unnamed", "Sans nom")) + "</td>" +
          '<td class="cell-categories" onclick="event.stopPropagation();app.showAssignCategoriesModal(\'' + pid + '\')">' + catChips + '</td>' +
          '<td class="u-num">' + formatWeight(s) + _stockGaugeHtml(p) + '</td>' +
          '<td class="u-num">' + formatPricePerUnit(cost) + '</td>' +
          '<td class="u-num">' + formatCurrency(s * cost) + '</td>' +
          '<td><span class="stock-badge ' + st.c + '">' + st.i + " " + st.l + "</span></td>" +
          '<td class="cell-actions" onclick="event.stopPropagation()">' +
            '<span class="row-actions">' +
              '<button class="btn btn-ghost btn-xs" onclick="app.showRestockModal(\'' + pid + '\')" title="' + t("action.restock", "Réappro") + '"><i data-lucide="package-plus" style="width:14px;height:14px"></i></button>' +
              '<button class="btn btn-ghost btn-xs" onclick="app.showAdjustModal(\'' + pid + '\')" title="' + t("products.adjustStock", "Ajuster") + '"><i data-lucide="sliders" style="width:14px;height:14px"></i></button>' +
            '</span>' +
            '<span class="row-menu-wrap">' +
              '<button class="btn btn-ghost btn-xs" onclick="app.toggleRowMenu(\'' + pid + '\', event)" aria-haspopup="true" title="' + t("action.more", "Plus d'actions") + '"><i data-lucide="more-horizontal" style="width:14px;height:14px"></i></button>' +
              '<span class="row-menu" id="rowmenu-' + pid + '" role="menu">' +
                '<button class="row-menu__item" onclick="app.openProductDetails(\'' + pid + '\')"><i data-lucide="eye"></i> ' + t("action.details", "Détails") + '</button>' +
                '<button class="row-menu__item" onclick="app.showAssignCategoriesModal(\'' + pid + '\')"><i data-lucide="tags"></i> ' + t("categories.title", "Catégories") + '</button>' +
                '<button class="row-menu__item" onclick="app.archiveProduct(\'' + pid + '\')"><i data-lucide="archive"></i> ' + t("products.archive", "Mettre hors catalogue") + '</button>' +
                '<button class="row-menu__item is-danger" onclick="app.deleteProduct(\'' + pid + '\')"><i data-lucide="trash-2"></i> ' + t("action.delete", "Supprimer") + '</button>' +
              '</span>' +
            '</span>' +
          '</td></tr>'
        );
      })
      .join("");
```

Conserver tel quel le bloc `thSort` + `<thead>` existant, en remplaçant seulement les flèches texte `▲`/`▼` par des icônes lucide `chevron-up`/`chevron-down` (`<i data-lucide="chevron-up" style="width:12px;height:12px;vertical-align:-1px"></i>`).

- [ ] **Step 3: Exposer `toggleRowMenu` sur `window.app`**

Chercher `window.app = {` dans `app.js` et ajouter `toggleRowMenu: toggleRowMenu,` dans l'objet.

- [ ] **Step 4: Vérifier en navigateur**

Catalogue : les lignes n'affichent plus 5 boutons ; au survol d'une ligne apparaissent Réappro + Ajuster + `⋯` ; le menu `⋯` s'ouvre, se ferme au clic ailleurs, et chaque item fonctionne (Détails, Catégories, Archiver → confirmation, Supprimer → confirmation). La jauge de stock est colorée selon les seuils de Paramètres > Gestion du stock. Colonnes Stock/CMP/Valeur alignées à droite en chiffres tabulaires. Dashboard : la card « Stocks à surveiller » (même `renderTable`) hérite du même rendu. Tri par clic sur en-têtes toujours fonctionnel.

- [ ] **Step 5: Commit**

```powershell
git add public/js/app.js
git commit -m "feat(refonte): renderTable v2 - jauge stock, actions hover, menu kebab"
```

### Task 3: Filtre statut Catalogue + persistance des filtres

**Files:**
- Modify: `public/js/app.js` — `state.filters` (~319), `renderProducts` (~3309), `onSearchChange`/`onCategoryChange`/`onSortChange` (~12450), export `window.app`

**Interfaces:**
- Consumes: `_statusOf(p)` (Task 2).
- Produces: `state.filters.status` (`"" | "critical" | "low" | "ok"`) ; `app.onStatusChange(value)` ; `app.resetCatalogFilters()` ; helpers `_loadCatalogFilters()` / `_saveCatalogFilters()`. La Task 7 consomme `state.filters.status`.

- [ ] **Step 1: Étendre `state.filters` et persister**

Dans l'init de `state` (~319), ajouter `status: ""` :

```javascript
    filters: {
      search: "",
      category: "",
      sort: "stock_asc",
      status: ""
    }
```

Ajouter près de `onSearchChange` (~12450) :

```javascript
  var CATALOG_FILTERS_KEY = function() { return "sm_filters_products_" + (state.shop || ""); };

  function _saveCatalogFilters() {
    try { localStorage.setItem(CATALOG_FILTERS_KEY(), JSON.stringify(state.filters)); } catch (e) {}
  }

  function _loadCatalogFilters() {
    try {
      var raw = localStorage.getItem(CATALOG_FILTERS_KEY());
      if (!raw) return;
      var f = JSON.parse(raw);
      if (f && typeof f === "object") {
        state.filters.search = f.search || "";
        state.filters.category = f.category || "";
        state.filters.sort = f.sort || "stock_asc";
        state.filters.status = f.status || "";
      }
    } catch (e) {}
  }

  function onStatusChange(value) {
    state.filters.status = value;
    _saveCatalogFilters();
    applyFilters();
  }

  function resetCatalogFilters() {
    state.filters = { search: "", category: "", sort: "stock_asc", status: "" };
    _saveCatalogFilters();
    applyFilters();
  }
```

Appeler `_saveCatalogFilters()` à la fin de `onSearchChange` (dans le setTimeout, après `state.filters.search = ...`), `onCategoryChange`, `onSortChange` et `sortByColumn`. Appeler `_loadCatalogFilters()` au boot : chercher la fonction d'init (celle qui appelle `setupNavigation()`) et l'appeler avant le premier `loadProducts`.

- [ ] **Step 2: Toolbar `renderProducts` — select statut, suppression du dropdown tri, chips + compteur**

Dans `renderProducts` (~3335) : supprimer le `<select id="sortFilter">` et son `filter-group` (le tri vit dans les en-têtes depuis Task 2 — supprimer aussi la construction de `sortOptions`/`sortOptionsHtml`). Ajouter à la place un select statut :

```javascript
      '<div class="filter-group">' +
      '<select class="form-select" id="statusFilter" onchange="app.onStatusChange(this.value)">' +
        '<option value=""' + (state.filters.status === "" ? " selected" : "") + '>' + t("filter.allStatuses", "Tous les statuts") + '</option>' +
        '<option value="critical"' + (state.filters.status === "critical" ? " selected" : "") + '>' + t("filter.statusCritical", "Rupture / critique") + '</option>' +
        '<option value="low"' + (state.filters.status === "low" ? " selected" : "") + '>' + t("filter.statusLow", "Stock bas") + '</option>' +
        '<option value="ok"' + (state.filters.status === "ok" ? " selected" : "") + '>' + t("filter.statusOk", "Stock OK") + '</option>' +
      '</select>' +
      '</div>' +
```

Après la toolbar, injecter chips + compteur. ⚠️ Ce bloc référence `filteredWeight` (défini au Step 3) : le construire APRÈS le calcul de `filteredWeight`, et l'insérer dans le HTML entre la toolbar et `sectionsHtml` :

```javascript
    var activeChips = "";
    if (state.filters.search)   activeChips += '<span class="filter-chip">' + esc(state.filters.search) + ' <button class="filter-chip__clear" onclick="app.onSearchClear()" aria-label="Retirer">&times;</button></span>';
    if (state.filters.category) activeChips += '<span class="filter-chip">' + t("filter.category", "Catégorie") + ' <button class="filter-chip__clear" onclick="app.onCategoryChange(\'\')" aria-label="Retirer">&times;</button></span>';
    if (state.filters.status)   activeChips += '<span class="filter-chip">' + t("filter.status", "Statut") + ' <button class="filter-chip__clear" onclick="app.onStatusChange(\'\')" aria-label="Retirer">&times;</button></span>';
    if (activeChips) {
      activeChips = '<div class="filter-chips">' + activeChips +
        '<button class="btn btn-ghost btn-xs" onclick="app.resetCatalogFilters()">' + t("filter.reset", "Réinitialiser") + '</button>' +
        '<span class="results-count">' + (filteredWeight.length + accessoryProducts.length) + ' ' + t("products.productCount", "produit(s)") + '</span></div>';
    }
```

avec `onSearchClear` :

```javascript
  function onSearchClear() {
    state.filters.search = "";
    _saveCatalogFilters();
    applyFilters();
  }
```

- [ ] **Step 3: Appliquer le filtre statut côté client dans `renderProducts`**

Le backend `/stock` ne connaît pas `status` : filtrer client-side. Remplacer le split existant :

```javascript
    var statusF = state.filters.status;
    var byStatus = function(p) { return !statusF || _statusOf(p) === statusF; };
    var filteredWeight = state.products.filter(function(p) { return !p.trackByUnit && byStatus(p); });
    var accessoryProducts = state.products.filter(function(p) { return p.trackByUnit; });
```

(utiliser `filteredWeight` à la place de `weightProducts` dans la suite ; la section Accessoires n'est pas filtrée par statut — les seuils grammes n'ont pas de sens à l'unité).

- [ ] **Step 4: Exposer sur `window.app`**

Ajouter `onStatusChange`, `onSearchClear`, `resetCatalogFilters` à l'objet `window.app`.

- [ ] **Step 5: Vérifier en navigateur**

Catalogue : le select Statut filtre (Rupture/critique, Stock bas, OK) conformément aux seuils Paramètres ; chips affichées avec suppression individuelle + Réinitialiser + compteur ; le dropdown de tri a disparu et le tri par en-têtes fonctionne toujours ; recharger la page → les filtres sont restaurés ; changer de page et revenir → restaurés aussi.

- [ ] **Step 6: Commit**

```powershell
git add public/js/app.js
git commit -m "feat(refonte): filtre statut catalogue + persistance filtres localStorage"
```

---

## Phase 2 — Système d'actions

### Task 4: Modales Restock/Ajustement v2 — contexte verrouillé, presets, Entrée valide

**Files:**
- Modify: `public/js/app.js` — `showRestockModal` (~8383), `showAdjustModal` (~8413), `saveRestock` (~8702), `saveAdjust` (~8734), export `window.app`

**Interfaces:**
- Consumes: `showModal`, `esc`, `formatWeight`, `formatPricePerUnit`, `getWeightUnit`, `getCurrencySymbol`, `state.products`.
- Produces: `app.setQtyPreset(inputId, val)` ; helpers `_qtyPresetsHtml(inputId)`, `_productContextHtml(p)`, `_saveLastQty(qty)`. Les ids `#rProd`, `#rQty`, `#rPrice`, `#aProd`, `#aQty` sont **conservés** (compat `saveRestock`/`saveAdjust`).

- [ ] **Step 1: Ajouter les helpers (au-dessus de `showRestockModal`)**

```javascript
  var QTY_PRESETS = [10, 25, 50, 100];

  function _lastQtyKey() { return "sm_last_qty_" + (state.shop || ""); }

  function _saveLastQty(qty) {
    try { if (qty > 0) localStorage.setItem(_lastQtyKey(), String(qty)); } catch (e) {}
  }

  function _qtyPresetsHtml(inputId) {
    var last = 0;
    try { last = Number(localStorage.getItem(_lastQtyKey())) || 0; } catch (e) {}
    var vals = QTY_PRESETS.slice();
    if (last > 0 && vals.indexOf(last) === -1) vals.push(last);
    return '<div class="qty-presets">' + vals.map(function(v) {
      return '<button type="button" class="qty-preset" onclick="app.setQtyPreset(\'' + inputId + '\', ' + v + ')">' + v + ' g</button>';
    }).join("") + '</div>';
  }

  function setQtyPreset(inputId, val) {
    var inp = document.getElementById(inputId);
    if (!inp) return;
    inp.value = val;
    inp.focus();
  }

  function _productContextHtml(p, hiddenInputId) {
    return '<div class="modal-product-context">' +
      '<i data-lucide="package" aria-hidden="true"></i>' +
      '<div><div class="modal-product-context__name">' + esc(p.name || p.title) + '</div>' +
      '<div class="modal-product-context__meta">' + formatWeight(p.totalGrams || 0) + ' · CMP ' + formatPricePerUnit(p.averageCostPerGram || 0) + '</div></div>' +
      '</div>' +
      '<input type="hidden" id="' + hiddenInputId + '" value="' + esc(p.productId) + '">';
  }
```

- [ ] **Step 2: Réécrire `showRestockModal`**

```javascript
  function showRestockModal(pid) {
    var weightUnit = getWeightUnit();
    var currSymbol = getCurrencySymbol();
    var prod = pid ? state.products.find(function(p) { return p.productId === pid; }) : null;

    var productBlock;
    if (prod) {
      productBlock = _productContextHtml(prod, "rProd");
    } else {
      var opts = state.products.map(function (p) {
        return '<option value="' + p.productId + '">' + esc(p.name || p.title) + "</option>";
      }).join("");
      productBlock = '<div class="form-group"><label class="form-label">' + t("products.product", "Produit") + '</label><select class="form-select" id="rProd">' + opts + '</select></div>';
    }

    showModal({
      title: t("products.restock", "Restock"),
      content:
        productBlock +
        '<div class="form-row-mobile">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("products.quantity", "Quantité") + ' (' + weightUnit + ')</label>' +
          _qtyPresetsHtml("rQty") +
          '<input type="number" class="form-input" id="rQty" placeholder="500" autofocus onkeydown="if(event.key===\'Enter\')app.saveRestock()"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("products.price", "Prix") + ' (' + currSymbol + '/' + weightUnit + ')</label><input type="number" class="form-input" id="rPrice" placeholder="4.50" step="0.01" onkeydown="if(event.key===\'Enter\')app.saveRestock()"></div></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button><button class="btn btn-primary" onclick="app.saveRestock()">' + t("action.validate", "Valider") + '</button>',
    });
    if (typeof lucide !== "undefined") lucide.createIcons();
    setTimeout(function() { var i = document.getElementById("rQty"); if (i) i.focus(); }, 100);
  }
```

- [ ] **Step 3: Réécrire `showAdjustModal` sur le même modèle**

Même structure : `_productContextHtml(prod, "aProd")` si `pid` fourni, sinon le `<select id="aProd">` existant (avec stock dans le label d'option, comme aujourd'hui) ; radios Ajouter/Retirer inchangées ; `_qtyPresetsHtml("aQty")` au-dessus du champ ; `onkeydown` Enter → `app.saveAdjust()` ; focus différé sur `#aQty`.

- [ ] **Step 4: Enregistrer la dernière quantité**

Dans `saveRestock`, après le `if (res.ok) {` ajouter `_saveLastQty(qty);`. Idem dans `saveAdjust`.

- [ ] **Step 5: Exposer `setQtyPreset` sur `window.app`**

- [ ] **Step 6: Vérifier en navigateur**

Depuis une ligne du Catalogue → Réappro : la modale montre le produit verrouillé (nom + stock + CMP, pas de select), le champ quantité a le focus, presets 10/25/50/100 g cliquables, `Entrée` valide. Valider 25 g → rouvrir : preset « 25 g » présent (dernier utilisé). Depuis Dashboard → bouton Réappro rapide global (sans pid) : le select produit est toujours là. Ajustement : mêmes comportements. Vérifier qu'un restock passe bien (stock mis à jour après validation).

- [ ] **Step 7: Commit**

```powershell
git add public/js/app.js
git commit -m "feat(refonte): modales restock/ajust v2 - contexte verrouille, presets, Enter"
```

### Task 5: Undo dans les toasts de confirmation

**Files:**
- Modify: `public/js/app.js` — `showToast` (~8549), `saveRestock` (~8702), `saveAdjust` (~8734)

**Interfaces:**
- Consumes: `undoMovementConfirmed(movementId)` (~3015, existant), `authFetch`, `apiUrl`.
- Produces: `showToast(msg, type, dur, action)` — 4e param optionnel `{ label, onClick }`, rétro-compatible (tous les appels existants à 2-3 args inchangés) ; `_fetchLastMovementId(productId)`.

- [ ] **Step 1: Étendre `showToast`**

```javascript
  function showToast(msg, type, dur, action) {
    var ct = document.getElementById("toastContainer");
    if (!ct) return;
    var el = document.createElement("div");
    el.className = "toast " + (type || "info");
    var iconName = { success: "check", error: "x", warning: "alert-triangle", info: "info" }[type] || "info";
    el.innerHTML =
      '<span class="toast-icon"><i data-lucide="' + iconName + '"></i></span>' +
      '<div class="toast-message">' + esc(msg) + '</div>' +
      (action && action.label ? '<button class="toast-action" type="button">' + esc(action.label) + '</button>' : '') +
      '<button class="toast-close" onclick="this.parentElement.remove()"><i data-lucide="x"></i></button>';
    if (action && typeof action.onClick === "function") {
      var btn = el.querySelector(".toast-action");
      if (btn) btn.addEventListener("click", function() { el.remove(); action.onClick(); });
    }
    ct.appendChild(el);
    if (typeof lucide !== "undefined") lucide.createIcons();
    setTimeout(function () { el.classList.add("visible"); }, 10);
    setTimeout(function () { el.remove(); }, dur || 4000);
  }
```

⚠️ La fonction actuelle nomme sa variable locale `t` (masque le helper i18n `t()` dans son scope) — la renommer `el` comme ci-dessus.

- [ ] **Step 2: Ajouter `_fetchLastMovementId`**

**Vérification préalable :** ouvrir `_renderActivityFiltered` (~1654) et confirmer les noms de champs du mouvement utilisés par le bouton Annuler existant (`m.id`, `m.productId`). Utiliser exactement les mêmes ici :

```javascript
  // type: "restock" | "adjustment" — filtre anti-course : un mouvement webhook
  // (vente) sur le même produit entre le save et ce fetch ne doit jamais
  // devenir la cible de l'undo.
  async function _fetchLastMovementId(productId, type) {
    try {
      var res = await authFetch(apiUrl("/movements?limit=5"));
      if (!res.ok) return null;
      var data = await res.json();
      var list = data.movements || [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m && m.productId === productId && (!type || m.type === type) && m.id) return m.id;
      }
      return null;
    } catch (e) { return null; }
  }
```

Les savers passent le type : `_fetchLastMovementId(pid, "restock")` dans `saveRestock`,
`_fetchLastMovementId(pid, "adjustment")` dans `saveAdjust` (vérifier les valeurs réelles
de `m.type` dans `_updateActivityCounts`/`_renderActivityFiltered` et les utiliser).

- [ ] **Step 3: Brancher dans `saveRestock` et `saveAdjust`**

Dans `saveRestock`, remplacer le bloc succès :

```javascript
      if (res.ok) {
        _saveLastQty(qty);
        closeModal();
        await loadProducts();
        renderTab(state.currentTab);
        var undoId = await _fetchLastMovementId(pid);
        showToast(t("msg.stockUpdated", "Stock mis à jour"), "success", 6000,
          undoId ? { label: t("activity.undo", "Annuler"), onClick: function() { undoMovementConfirmed(undoId); } } : null);
      }
```

Même modification dans `saveAdjust` (message `t("msg.adjustOk", "Ajustement OK")`).

- [ ] **Step 4: Vérifier en navigateur**

Faire un restock de 10 g → toast « Stock mis à jour · Annuler » pendant 6 s ; cliquer Annuler → le stock revient à sa valeur d'avant (vérifier dans la ligne produit), un toast de confirmation d'annulation s'affiche. Idem pour un ajustement. Vérifier qu'un toast sans action (ex. erreur de validation) s'affiche toujours normalement.

- [ ] **Step 5: Commit**

```powershell
git add public/js/app.js
git commit -m "feat(refonte): undo direct dans les toasts restock/ajustement"
```

### Task 6: Actions rapides dans la recherche globale

**Files:**
- Modify: `public/js/app.js` — `performGlobalSearch` (~505), `renderSearchDropdown` (~590)

**Interfaces:**
- Consumes: `showRestockModal(pid)` / `showAdjustModal(pid)` (Task 4), `hideSearchDropdown`.

- [ ] **Step 1: Vérifier la structure des items produits**

Lire `performGlobalSearch` (~505-587) : identifier le champ qui porte l'id produit dans les items du groupe `products` (celui que `selectSearchResultByIndex` utilise pour naviguer). L'appeler `item.id` ci-dessous — adapter si le champ réel diffère.

- [ ] **Step 2: Ajouter `searchQuickAction` et les boutons dans `renderSearchDropdown`**

Ajouter près de `hideSearchDropdown` (~657) :

```javascript
  function searchQuickAction(kind, pid) {
    hideSearchDropdown();
    var input = document.getElementById("globalSearch");
    if (input) input.value = "";
    if (kind === "restock") showRestockModal(pid);
    else showAdjustModal(pid);
  }
```

Exposer `searchQuickAction` sur `window.app`. Puis dans la boucle `group.items.forEach` (~621), pour le groupe `products` uniquement, ajouter un bloc actions avant la fermeture du div :

```javascript
        var actionsHtml = "";
        if (group.category === "products" && item.id) {
          actionsHtml = '<div class="search-result-actions" onclick="event.stopPropagation()">' +
            '<button class="btn btn-ghost btn-xs" title="' + t("action.restock", "Réappro") + '" onclick="app.searchQuickAction(\'restock\', \'' + esc(item.id) + '\')"><i data-lucide="package-plus" style="width:13px;height:13px"></i></button>' +
            '<button class="btn btn-ghost btn-xs" title="' + t("products.adjustStock", "Ajuster") + '" onclick="app.searchQuickAction(\'adjust\', \'' + esc(item.id) + '\')"><i data-lucide="sliders" style="width:13px;height:13px"></i></button>' +
            '</div>';
        }
        html += '<div class="search-result-item" data-index="' + globalIndex + '" onclick="app.selectSearchResultByIndex(' + globalIndex + ')">' +
          '<div class="search-result-icon ' + item.type + '"><i data-lucide="' + item.icon + '"></i></div>' +
          '<div class="search-result-info">' +
          '<div class="search-result-title">' + highlighted + '</div>' +
          '<div class="search-result-meta">' + esc(item.meta) + '</div>' +
          '</div>' +
          actionsHtml +
          '</div>';
```

Ajouter le CSS (fin de la section refonte de `style.css`) :

```css
.search-result-actions { display: none; gap: 2px; margin-left: auto; }
.search-result-item:hover .search-result-actions { display: inline-flex; }
```

- [ ] **Step 3: Vérifier en navigateur**

Taper 2+ caractères d'un produit dans la recherche topbar : au survol d'un résultat produit, deux boutons Réappro/Ajuster apparaissent ; cliquer Réappro ferme le dropdown, vide la recherche, ouvre la modale pré-remplie sur ce produit. La navigation clavier ↑↓/Enter/Esc fonctionne comme avant.

- [ ] **Step 4: Commit**

```powershell
git add public/js/app.js public/css/style.css
git commit -m "feat(refonte): actions restock/ajust inline dans la recherche globale"
```

---

## Phase 3 — Dashboard actionnable

### Task 7: Deep-linking hash + urgence → catalogue filtré

**Files:**
- Modify: `public/js/app.js` — `navigateTo` (~931), boot (fonction d'init qui appelle `setupNavigation`), `renderDashboard` bloc urgence (~1424-1449), `switchAnalyticsTab` (~10732)

**Interfaces:**
- Consumes: `state.filters.status` + `_saveCatalogFilters()` (Task 3), `TAB_SUBVIEWS`/`isParentTab` (~874).
- Produces: `navigateTo(tab, params)` — 2e param optionnel `{ status: "critical"|"low" }` ; hash `#<tab>` / `#analytics/<subtab>` / `#products?status=critical` ; `_applyHash()`. Consommé par Task 10.

- [ ] **Step 1: Parser + écrire le hash**

Ajouter au-dessus de `navigateTo` :

```javascript
  var _hashNavigating = false;

  function _setHash(tab, sub, params) {
    var h = "#" + tab + (sub ? "/" + sub : "");
    var qs = [];
    if (params) {
      Object.keys(params).forEach(function(k) {
        if (params[k]) qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      });
    }
    if (qs.length) h += "?" + qs.join("&");
    if (location.hash === h) return;
    _hashNavigating = true;
    location.hash = h;
    setTimeout(function() { _hashNavigating = false; }, 0);
  }

  function _parseHash() {
    // try/catch : un hash malformé (ex. "%" isolé) ferait jeter
    // decodeURIComponent en plein boot — traiter comme absence de hash.
    try {
      var h = (location.hash || "").replace(/^#/, "");
      if (!h) return null;
      var parts = h.split("?");
      var path = parts[0].split("/");
      var params = {};
      if (parts[1]) {
        parts[1].split("&").forEach(function(kv) {
          var p = kv.split("=");
          if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
        });
      }
      return { tab: path[0], sub: path[1] || null, params: params };
    } catch (e) { return null; }
  }

  function _applyHash() {
    if (_hashNavigating) return;
    var parsed = _parseHash();
    if (!parsed || !parsed.tab) return;
    navigateTo(parsed.tab, parsed.params, parsed.sub);
  }
```

- [ ] **Step 2: Étendre `navigateTo`**

```javascript
  function navigateTo(tab, params, sub) {
    if (isParentTab(tab)) {
      var first = firstAvailableSub(tab);
      tab = first ? first.id : tab;
    }
    // Paramètres de pré-filtrage (ex. status depuis le bloc urgence dashboard,
    // sort depuis les KPIs cliquables)
    if (params && tab === "products") {
      var dirty = false;
      if (typeof params.status === "string") { state.filters.status = params.status; dirty = true; }
      if (typeof params.sort === "string")   { state.filters.sort = params.sort; dirty = true; }
      if (dirty) _saveCatalogFilters();
    }
    if (tab === "analytics" && sub) {
      _pendingAnalyticsTab = sub; // consommé par renderAnalytics (Task 10)
    }
    state.currentTab = tab;
    var sidebarKey = sidebarKeyFor(tab);
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.tab === sidebarKey);
    });
    closeSidebarOnMobile();
    _setHash(tab, sub || null, params || null);
    renderTab(tab);
  }
```

Déclarer `var _pendingAnalyticsTab = null;` près des autres vars analytics (~10729) — Task 10 le consommera ; d'ici là il reste inerte.

Au boot (dans la fonction d'init, après le premier rendu) :

```javascript
    window.addEventListener("hashchange", _applyHash);
    if (location.hash) _applyHash();
```

- [ ] **Step 3: Bloc urgence → catalogue filtré**

Dans `renderDashboard`, remplacer les `onclick` des deux items d'urgence :
- ligne ~1426 : `onclick="app.showOutOfStockModal()"` → `onclick="app.navigateTo('products', { status: 'critical' })"`
- ligne ~1439 : `onclick="app.showLowStockModal()"` → `onclick="app.navigateTo('products', { status: 'low' })"`

⚠️ Un objet littéral dans un attribut HTML : écrire `onclick="app.navigateTo('products', {status:'critical'})"` (guillemets simples internes, pas d'espaces superflus). `showOutOfStockModal`/`showLowStockModal` restent définis et exposés (compat API `app.X`), plus aucun appel interne — les marquer d'un commentaire `// Depuis la refonte 2026-07 : plus appelé par le dashboard (flux remplacé par catalogue filtré).`

- [ ] **Step 4: Vérifier en navigateur**

Dashboard avec produits sous seuil : cliquer l'item urgence « à réapprovisionner » → arrive sur Catalogue, filtre statut « Rupture / critique » appliqué, chip visible, URL contient `#products?status=critical`. Bouton retour navigateur → revient au dashboard. Recharger la page avec `#products?status=critical` → arrive directement sur le catalogue filtré. Navigation sidebar normale → le hash suit (`#dashboard`, `#batches`…).

- [ ] **Step 5: Commit**

```powershell
git add public/js/app.js
git commit -m "feat(refonte): deep-linking hash + urgence dashboard vers catalogue filtre"
```

### Task 8: Réorganisation du dashboard

**Files:**
- Modify: `public/js/app.js` — `renderDashboard` (~1328-1617)

**Interfaces:**
- Consumes: `renderTable` v2 (Task 2 — la watchlist en hérite déjà), `navigateTo` v2 (Task 7).
- Note : les sparklines sont **déjà réelles** (`_drawSparkline` + Chart.js, `loadDashboardSalesKpis` ~1683) — rien à faire sur ce point.

- [ ] **Step 1: Fusionner les actions rapides dans le header de page**

Supprimer le bloc `quick-actions-bar` (~1565-1575). Remplacer `primaryCta` (~1505) par une barre compacte dans `dashboard-today__actions` :

```javascript
    var headerActions = isEmpty ? '' :
      '<button class="btn btn-primary btn-sm" onclick="app.showQuickRestockModal()" data-tooltip="' + t("tooltip.quickRestock", "Ajouter du stock et mettre a jour le CMP du produit") + '" data-tooltip-pos="bottom">' +
        '<i data-lucide="package-plus" aria-hidden="true"></i> ' + t("dashboard.quickRestock", "Réappro rapide") + '</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="app.showQuickAdjustModal()" aria-label="' + t("dashboard.quickAdjust", "Ajustement") + '" data-tooltip="' + t("tooltip.quickAdjust", "Corriger le stock (vol, casse, comptage) sans toucher au CMP") + '" data-tooltip-pos="bottom"><i data-lucide="sliders" aria-hidden="true"></i></button>' +
      '<button class="btn btn-ghost btn-sm" onclick="app.showManualSaleModal()" aria-label="' + t("dashboard.manualSale", "Vente manuelle") + '" data-tooltip="' + t("tooltip.manualSale", "Enregistrer une vente effectuee hors Shopify (boutique physique, etc.)") + '" data-tooltip-pos="bottom"><i data-lucide="shopping-cart" aria-hidden="true"></i></button>' +
      '<button class="btn btn-ghost btn-sm" onclick="app.showScannerModal()" aria-label="' + t("dashboard.scanBarcode", "Scanner") + '" data-tooltip="' + t("tooltip.scanner", "Scanner un code-barre pour acceder rapidement au produit") + '" data-tooltip-pos="bottom"><i data-lucide="scan-barcode" aria-hidden="true"></i></button>' +
      (hasFeature("hasInventoryCount") ? '<button class="btn btn-ghost btn-sm" onclick="app.navigateTo(\'inventory\')" aria-label="' + t("dashboard.inventory", "Inventaire") + '" data-tooltip="' + t("tooltip.inventory", "Lancer une session d\'inventaire physique") + '" data-tooltip-pos="bottom"><i data-lucide="clipboard-check" aria-hidden="true"></i></button>' : '') +
      '<button class="btn btn-ghost btn-sm" onclick="app.showAddProductModal()" aria-label="' + t("dashboard.addProduct", "Produit") + '" data-tooltip="' + t("tooltip.addProduct", "Creer un nouveau produit dans le catalogue") + '" data-tooltip-pos="bottom"><i data-lucide="plus" aria-hidden="true"></i></button>';
```

et utiliser `headerActions` dans `dashboard-today__actions`.

- [ ] **Step 2: Réordonner les blocs dans `c.innerHTML`**

Nouvel ordre de composition (~1539) :

1. `<header class="dashboard-today">` (avec `headerActions`)
2. `urgencyHtml`
3. `kpiStrip`
4. Card **Stocks à surveiller** (watchlist) en pleine largeur — sortie de `dashboard-grid`, placée directement ici
5. `<div class="dashboard-grid">` avec card **Activité récente** + `batchesCardHtml` (lots qui expirent)
6. Card **Étiquette dernière commande** en dernier, en version compacte : ajouter la classe `card-compact` et déplacer le bloc entier après `dashboard-grid`.

Ajouter au CSS refonte (`style.css`) :

```css
.card-compact .card-header { padding-top: 10px; padding-bottom: 10px; }
.card-compact .card-body { max-height: 200px; overflow: auto; }
/* Watchlist sortie de la grille : si les lots (PRO) sont absents, la card
   activité reste seule dans dashboard-grid — elle doit occuper toute la ligne. */
.dashboard-grid > .card:only-child { grid-column: 1 / -1; }
```

- [ ] **Step 3: Rendre les KPIs Stock total et Valeur cliquables**

Remplacer les deux `<div class="kpi-strip__item">` statiques (~1468-1475) par des boutons `is-link` :

```javascript
        '<button type="button" class="kpi-strip__item is-link" onclick="app.navigateTo(\'products\')" ' +
        'data-tooltip="' + t("tooltip.kpiStock", "Ouvrir le catalogue trié par stock") + '" data-tooltip-pos="bottom">' +
          '<span class="kpi-strip__label">' + t("dashboard.totalStock", "Stock total") + '</span>' +
          '<span class="kpi-strip__value">' + formatWeight(totalStock) + '</span>' +
        '</button>' +
        '<button type="button" class="kpi-strip__item is-link" onclick="app.navigateTo(\'products\', {sort:\'value_desc\'})" ' +
        'data-tooltip="' + t("tooltip.kpiValue", "Ouvrir le catalogue trié par valeur") + '" data-tooltip-pos="bottom">' +
          '<span class="kpi-strip__label">' + t("dashboard.value", "Valeur") + '</span>' +
          '<span class="kpi-strip__value">' + formatCurrency(totalValue) + '</span>' +
        '</button>' +
```

- [ ] **Step 4: Vérifier en navigateur**

Dashboard : ordre des blocs = urgence → KPIs → watchlist → activité + lots → étiquette compacte en bas ; plus de barre « Actions rapides » séparée, toutes les actions dans le header ; chaque KPI est cliquable et mène au bon endroit ; la watchlist a les actions au survol et le bouton Réappro pré-rempli ; l'activité conserve ses onglets et l'undo ; les sparklines Ventes 7j / Commandes 7j s'affichent (plan PRO).

- [ ] **Step 5: Commit**

```powershell
git add public/js/app.js public/css/style.css
git commit -m "feat(refonte): dashboard reorganise - watchlist remontee, actions fusionnees, KPIs cliquables"
```

---

## Phase 4 — Navigation complète + propagation

### Task 9: Style d'onglet unique

**Files:**
- Modify: `public/css/style.css` — `.detail-tab` (~4299), `.activity-tabs` (chercher `.activity-tabs`), section refonte

**Interfaces:**
- Consumes: style `.tab-btn` underline existant (chercher `.tab-btn` dans style.css, utilisé par `.analytics-tabs-row`).

- [ ] **Step 1: Aligner `.detail-tab` et `.activity-tabs button` sur les métriques de `.tab-btn`**

Repérer le bloc `.tab-btn` (style underline utilisé par Analyse). Ajouter en fin de section refonte de `style.css` un bloc qui applique les mêmes tokens aux deux autres familles (padding, taille de police, `border-bottom: 2px solid transparent`, état actif `border-bottom-color: var(--accent-primary); color: var(--text-primary)`, hover `color: var(--text-primary)`) en surchargeant les propriétés divergentes de `.detail-tab` et `.activity-tabs button` (fond, bordures, radius) :

```css
/* --- Onglets unifiés : tous alignés sur le style underline (.tab-btn) --- */
.detail-tab,
.activity-tabs [role="tab"] {
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);
}
.detail-tab:hover,
.activity-tabs [role="tab"]:hover { color: var(--text-primary); }
.detail-tab.active,
.activity-tabs [role="tab"].active {
  color: var(--text-primary);
  border-bottom-color: var(--accent-primary);
  background: transparent;
}
```

Vérifier les sélecteurs réels avant d'écrire : si les boutons de `.activity-tabs` n'ont pas `role="tab"` dans le DOM généré (voir `renderDashboard` ~1587 : ils l'ont), adapter le sélecteur.

- [ ] **Step 2: Compteur sur l'onglet « Récap commandes » d'Analyse**

Dans `loadOrdersDebugTab` (chercher `function loadOrdersDebugTab` dans `app.js`), après réception des données, mettre à jour le libellé de l'onglet avec le nombre de commandes de la période :

```javascript
      var ordersTabBtn = document.querySelector('.analytics-tabs-row .tab-btn[data-tab="orders"]');
      if (ordersTabBtn && Array.isArray(orders)) {
        var badge = ordersTabBtn.querySelector(".badge-count");
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "badge-count";
          badge.style.marginLeft = "6px";
          ordersTabBtn.appendChild(badge);
        }
        badge.textContent = String(orders.length);
      }
```

(`orders` = la variable locale contenant la liste des commandes dans ce loader — adapter son nom à celui du code réel.)

- [ ] **Step 3: Vérifier en navigateur**

Dashboard (onglets Tout/Ventes/Restocks/Ajustements), fiche fournisseur (Infos/Produits/Lots/Analytics), Analyse (Ventes/Stock/…): les trois familles d'onglets ont le même look underline vert ; les compteurs (`badge-count`) restent lisibles ; l'onglet Récap commandes affiche son compteur après ouverture ; les deux thèmes OK.

- [ ] **Step 4: Commit**

```powershell
git add public/css/style.css
git commit -m "feat(refonte): style d'onglet unique underline sur toutes les familles de tabs"
```

### Task 10: Mémoire des sous-onglets + hash sous-vues + sidebar dépliable

**Files:**
- Modify: `public/js/app.js` — `renderAnalytics` (fin, ~10723-10727), `switchAnalyticsTab` (~10732), `translateNavigationLabels`/`setupNavigation` (~748), section refonte CSS de `public/css/style.css`

**Interfaces:**
- Consumes: `_pendingAnalyticsTab` + `_setHash` (Task 7), `TAB_SUBVIEWS`/`TAB_PARENTS` (~874), `hasFeature`.

- [ ] **Step 1: Mémoire + hash des onglets Analyse**

Dans `switchAnalyticsTab` (~10732), au début :

```javascript
    try { localStorage.setItem("sm_lasttab_analytics_" + (state.shop || ""), tab); } catch (e) {}
    _setHash("analytics", tab, null);
```

À la fin de `renderAnalytics` (~10725), remplacer `analyticsTab = "sales"; loadAnalyticsSales();` par :

```javascript
    var initialTab = _pendingAnalyticsTab;
    _pendingAnalyticsTab = null;
    if (!initialTab) {
      try { initialTab = localStorage.getItem("sm_lasttab_analytics_" + (state.shop || "")); } catch (e) {}
    }
    if (initialTab && ["sales", "stock", "manual", "orders", "treasury"].indexOf(initialTab) !== -1 && initialTab !== "sales") {
      switchAnalyticsTab(initialTab);
    } else {
      analyticsTab = "sales";
      loadAnalyticsSales();
    }
```

- [ ] **Step 2: Sous-items dépliables dans la sidebar**

Ajouter une fonction appelée depuis `setupNavigation()` après `translateNavigationLabels()` :

```javascript
  function injectSidebarSubnav() {
    Object.keys(TAB_SUBVIEWS).forEach(function(parentId) {
      var navItem = document.querySelector('.nav-item[data-tab="' + parentId + '"]');
      if (!navItem || navItem.parentElement.querySelector('.nav-subitems[data-parent="' + parentId + '"]')) return;
      var subs = TAB_SUBVIEWS[parentId];
      var html = subs.map(function(s) {
        var locked = !!(s.feature && !hasFeature(s.feature));
        return '<a href="#" class="nav-subitem' + (locked ? ' is-locked' : '') + '" data-subtab="' + s.id + '">' +
          '<i data-lucide="' + s.icon + '" class="icon" aria-hidden="true"></i>' +
          '<span>' + t(s.labelKey, s.labelFr) + '</span>' +
          (locked ? '<i data-lucide="lock" class="icon nav-subitem__lock" aria-hidden="true"></i>' : '') +
          '</a>';
      }).join("");
      var wrap = document.createElement("div");
      wrap.className = "nav-subitems";
      wrap.setAttribute("data-parent", parentId);
      wrap.innerHTML = html;
      navItem.insertAdjacentElement("afterend", wrap);
      wrap.querySelectorAll(".nav-subitem").forEach(function(el) {
        el.addEventListener("click", function(e) {
          e.preventDefault();
          var sid = el.dataset.subtab;
          var sub = subs.find(function(s) { return s.id === sid; });
          if (sub && sub.feature && !hasFeature(sub.feature)) { showLockedModal(sub.feature); return; }
          navigateTo(sid);
        });
      });
    });
    if (typeof lucide !== "undefined") lucide.createIcons();
  }
```

CSS (section refonte de `style.css`) :

```css
/* --- Sous-items sidebar --- */
.nav-subitems { display: none; flex-direction: column; padding-left: 28px; }
.nav-item.active + .nav-subitems,
.nav-subitems.is-open { display: flex; }
.nav-subitem {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; font-size: 12.5px;
  color: var(--text-tertiary); text-decoration: none;
  border-radius: var(--radius-sm);
}
.nav-subitem:hover { color: var(--text-primary); background: var(--surface-hover); }
.nav-subitem .icon { width: 14px; height: 14px; }
.nav-subitem__lock { margin-left: auto; }
.sidebar.collapsed .nav-subitems { display: none; }
```

Les sous-items ne s'affichent que quand le parent est actif (`nav-item.active + .nav-subitems`) — pas de chevron à gérer, l'état suit la navigation.

- [ ] **Step 3: Vérifier en navigateur**

Sidebar : cliquer Analyse → les sous-items Performance/Prévisions apparaissent sous l'entrée active ; cliquer Prévisions → navigue ; les items verrouillés (plan insuffisant) montrent le cadenas et ouvrent la modale upgrade. Analyse : aller sur Trésorerie, naviguer ailleurs, revenir sur Analyse → Trésorerie est rouverte ; l'URL `#analytics/treasury` recharge directement Trésorerie ; bouton retour navigateur passe d'un sous-onglet à l'autre. Sidebar repliée : pas de sous-items affichés.

- [ ] **Step 4: Commit**

```powershell
git add public/js/app.js public/css/style.css
git commit -m "feat(refonte): memoire sous-onglets analyse + hash sous-vues + sidebar depliable"
```

### Task 11: Propagation du système de tableaux (Lots, Fournisseurs, Achats, Ventes)

**Files:**
- Modify: `public/js/app.js` — `renderBatchesTable` (~3533), `renderSuppliersTable` (~4596), `renderPurchaseTable` (~5129), `renderSalesTable` (~5796)

**Interfaces:**
- Consumes: classes `.u-num`, `.row-actions`, `.cell-actions` (Task 1). Le sticky header est automatique (Task 1 style `.data-table th`).

- [ ] **Step 1: Exemple travaillé — `renderBatchesTable` (~3533)**

Deux modifications mécaniques, à appliquer sur chaque `<td>`/bouton du renderer :

1. **Colonnes numériques** (quantités, poids, prix, valeurs, dates relatives « J-x ») : ajouter `class="u-num"` au `<td>` (fusionner avec les classes existantes le cas échéant : `class="u-num text-danger"`).
2. **Boutons d'action de fin de ligne** : envelopper le groupe de boutons existant dans `<td class="cell-actions"><span class="row-actions">…boutons existants inchangés…</span></td>`. Ne pas changer les `onclick`.

- [ ] **Step 2: Répéter à l'identique sur les trois autres renderers**

Appliquer exactement les deux mêmes modifications (classes `u-num` sur `<td>` numériques, wrapper `.row-actions` sur les groupes de boutons d'action) dans :
- `renderSuppliersTable` (~4596)
- `renderPurchaseTable` (~5129)
- `renderSalesTable` (~5796)

Ne pas toucher aux `<td>` textuels (noms, statuts, contacts) ni aux lignes dépliables/détails.

- [ ] **Step 3: Vérifier en navigateur**

Pages Lots et DLC, Achats > Fournisseurs, Achats > Commandes (+ onglet ventes) : chiffres alignés à droite en tabular-nums, actions visibles uniquement au survol de la ligne, en-têtes sticky au scroll, aucun bouton cassé (tester réception commande, édition fournisseur, actions lot). Les pages non prioritaires ne doivent avoir AUCUNE régression fonctionnelle.

- [ ] **Step 4: Commit**

```powershell
git add public/js/app.js
git commit -m "feat(refonte): propagation tableaux v2 aux pages lots, fournisseurs, achats, ventes"
```

---

## Phase 5 — Passe finale

### Task 12: i18n, cohérence visuelle et QA globale

**Files:**
- Modify: `public/js/i18n.js` (dictionnaires FR + EN), `public/css/style.css`, retouches ciblées `public/js/app.js`

- [ ] **Step 1: Ajouter les clés i18n FR + EN**

Ajouter dans les deux dictionnaires de `public/js/i18n.js` (respecter la structure existante — chercher une clé voisine comme `"action.delete"` pour localiser les sections) :

| Clé | FR | EN |
|---|---|---|
| `action.restock` | Réappro | Restock |
| `action.more` | Plus d'actions | More actions |
| `filter.allStatuses` | Tous les statuts | All statuses |
| `filter.statusCritical` | Rupture / critique | Out of stock / critical |
| `filter.statusLow` | Stock bas | Low stock |
| `filter.statusOk` | Stock OK | In stock |
| `filter.status` | Statut | Status |
| `filter.category` | Catégorie | Category |
| `filter.reset` | Réinitialiser | Reset |
| `activity.undo` | Annuler | Undo |
| `msg.stockUpdated` | Stock mis à jour | Stock updated |
| `msg.adjustOk` | Ajustement OK | Adjustment saved |
| `tooltip.kpiStock` | Ouvrir le catalogue trié par stock | Open catalog sorted by stock |
| `tooltip.kpiValue` | Ouvrir le catalogue trié par valeur | Open catalog sorted by value |

Vérifier ensuite en basculant la langue dans Paramètres que toutes les nouvelles zones sont traduites.

- [ ] **Step 2: Nettoyage CSS ciblé**

- `style.css` contient deux définitions de `.toolbar-filters` (~2191 et ~4127) : fusionner en une seule (garder la plus complète, supprimer l'autre, vérifier visuellement les toolbars Catalogue/Lots/Achats après).
- Supprimer les styles devenus morts s'ils ne sont référencés nulle part ailleurs (`grep` dans `app.js` + `index.html` avant chaque suppression) : styles du dropdown de tri du catalogue si spécifiques.

- [ ] **Step 3: QA transversale (checklist complète)**

Sur la boutique de dev, dans l'ordre, vérifier chaque page dans les deux thèmes (dark par défaut + light) :

1. **Dashboard** : ordre des blocs, urgence → catalogue filtré, KPIs cliquables, watchlist hover-actions, activité + undo, étiquette compacte.
2. **Catalogue** : filtres (statut/catégorie/recherche) + persistance après reload, tri en-têtes, actions hover + kebab, sélection multiple + bulk (checkboxes), archivage/suppression.
3. **Lots et DLC**, **Inventaire**, **Achats** (Fournisseurs + Commandes), **Analyse** (5 onglets + mémoire + hash), **Paramètres** : aucune régression fonctionnelle, tableaux propagés OK.
4. **Modales** : restock/ajust depuis ligne (contexte verrouillé), depuis header (select), presets, Enter, undo toast.
5. **Recherche globale** : résultats, actions inline, navigation clavier.
6. **Navigation** : hash sur chaque page, retour navigateur, reload profond, sidebar sous-items, sidebar repliée, largeur mobile (~375px : sidebar overlay, tableaux scrollables horizontalement).
7. **i18n** : bascule FR → EN → FR.

Corriger inline tout problème trouvé (retouches dans les fichiers concernés).

- [ ] **Step 4: Commit final**

```powershell
git add public/js/i18n.js public/css/style.css public/js/app.js
git commit -m "feat(refonte): i18n FR/EN, nettoyage CSS, QA transversale finale"
```

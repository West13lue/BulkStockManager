// app.js - Stock Manager Pro (FIXED v4 - no ?shop= on API calls; rely on Session Token)
(function () {
  "use strict";

  var API_BASE = "/api";
  var appBridgeApp = null;
  var sessionToken = null;
  var apiKeyCache = null;

  function getHostFromUrl() {
    var urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("host");
  }

  function getShopFromUrl() {
    var urlParams = new URLSearchParams(window.location.search);
    var shop = urlParams.get("shop");
    if (shop) return shop;

    var host = urlParams.get("host");
    if (host) {
      try {
        var d = atob(host);
        var m = d.match(/([^/]+\.myshopify\.com)/);
        if (m) return m[1];
      } catch (e) {}
    }

    return localStorage.getItem("stockmanager_shop") || null;
  }

  var CURRENT_SHOP = getShopFromUrl();
  if (CURRENT_SHOP) {
    localStorage.setItem("stockmanager_shop", CURRENT_SHOP);
    console.log("[Shop]", CURRENT_SHOP);
  }

  // âœ… IMPORTANT: API calls should NOT include ?shop=... in an embedded app.
  // The server should resolve shop from the Session Token (JWT) for security + Shopify review.
  function apiUrl(endpoint) {
    return API_BASE + endpoint;
  }

  async function loadPublicConfig() {
    if (apiKeyCache) return apiKeyCache;
    var res = await fetch("/api/public/config", { headers: { Accept: "application/json" } });
    var json = await res.json().catch(function () {
      return {};
    });
    apiKeyCache = String(json.apiKey || "").trim();
    return apiKeyCache;
  }

  async function initAppBridge() {
    var host = getHostFromUrl();
    if (!host) {
      console.warn("[AppBridge] host manquant");
      return false;
    }
    var apiKey = await loadPublicConfig();
    if (!apiKey) {
      console.warn("[AppBridge] apiKey introuvable");
      return false;
    }
    var AB = window["app-bridge"];
    if (!AB || typeof AB.createApp !== "function") {
      console.warn("[AppBridge] non charge");
      return false;
    }
    appBridgeApp = AB.createApp({ apiKey: apiKey, host: host, forceRedirect: true });
    console.log("[AppBridge] OK");
    return true;
  }

  async function getSessionToken() {
    if (sessionToken) return sessionToken;
    if (!appBridgeApp) return null;
    var ABU = window["app-bridge-utils"];
    if (!ABU || typeof ABU.getSessionToken !== "function") return null;
    try {
      sessionToken = await ABU.getSessionToken(appBridgeApp);
      return sessionToken;
    } catch (e) {
      console.warn("[AppBridge] Erreur:", e);
      return null;
    }
  }

  function clearSessionToken() {
    sessionToken = null;
  }

  // âœ… authFetch correctly closed + sends Session Token
  async function authFetch(url, options) {
    options = options || {};
    var token = await getSessionToken();

    var headers = Object.assign({}, options.headers || {}, { Accept: "application/json" });
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = "Bearer " + token;

    var doFetch = function () {
      return fetch(url, Object.assign({}, options, { headers: headers }));
    };

    var res = await doFetch();

    // retry 401 once
    if (res.status === 401 && token) {
      clearSessionToken();
      var t2 = await getSessionToken();
      if (t2) headers["Authorization"] = "Bearer " + t2;
      res = await doFetch();
    }

    // ðŸ” OAuth AUTO if token missing/revoked
    if (res.status === 401) {
      var data = null;
      try {
        data = await res.clone().json();
      } catch (e) {}

      if (data && data.error === "reauth_required" && data.reauthUrl) {
        console.warn("[OAuth] Redirection automatique:", data.reauthUrl);
        if (window.top) window.top.location.href = data.reauthUrl;
        else window.location.href = data.reauthUrl;
        throw new Error("OAuth redirect");
      }
    }

    return res;
  }

  var PLAN_HIERARCHY = ["free", "starter", "pro", "business", "enterprise"];

  var state = {
    currentTab: "dashboard",
    planId: "free",
    planName: "Free",
    limits: {},
    products: [],
    categories: [],
    shop: CURRENT_SHOP,
    // Trial info
    trial: { active: false, daysLeft: null, planId: null },
    effective: { planId: "free", reason: "default" },
    // Filtres produits
    filters: {
      search: "",
      category: "",
      sort: "alpha"
    }
  };

  function hasFeature(key) {
    if (state.limits[key] === true) return true;

    var featurePlans = {
      hasCategories: "starter",
      hasShopifyImport: "starter",
      hasStockValue: "starter",
      hasAdvancedExports: "starter",
      hasAnalytics: "pro",
      hasBatchTracking: "pro",
      hasSuppliers: "pro",
      hasInventoryCount: "pro",
      hasTrends: "pro",
      hasNotifications: "pro",
      hasFreebies: "pro",
      hasPurchaseOrders: "business",
      hasForecast: "business",
      hasKits: "business",
      hasMultiUsers: "business",
      hasAutomations: "business",
      hasIntegrations: "business",
      hasReports: "business",
      hasMultiStore: "enterprise",
      hasApi: "enterprise",
    };

    var reqPlan = featurePlans[key] || "free";
    var myIdx = PLAN_HIERARCHY.indexOf(state.planId);
    var reqIdx = PLAN_HIERARCHY.indexOf(reqPlan);
    return myIdx >= reqIdx;
  }

  async function ensureSessionOrRedirect() {
    try {
      var token = await getSessionToken();
      if (!token) {
        console.warn("[OAuth] Aucun session token â†’ redirection");
        var shop = CURRENT_SHOP;
        if (!shop) throw new Error("Shop manquant");
        var url = "/api/auth/start?shop=" + encodeURIComponent(shop);
        if (window.top) window.top.location.href = url;
        else window.location.href = url;
        return false;
      }
      return true;
    } catch (e) {
      console.warn("[OAuth] Erreur session â†’ redirection", e);
      var shop2 = CURRENT_SHOP;
      if (shop2) {
        var url2 = "/api/auth/start?shop=" + encodeURIComponent(shop2);
        if (window.top) window.top.location.href = url2;
        else window.location.href = url2;
      }
      return false;
    }
  }

  async function init() {
    console.log("[Init] Stock Manager Pro");

    var host = getHostFromUrl();

    // 1) If not embedded, force OAuth
    if (window.top === window.self) {
      if (CURRENT_SHOP) {
        window.location.href = "/api/auth/start?shop=" + encodeURIComponent(CURRENT_SHOP);
        return;
      }
      document.body.innerHTML =
        '<div style="padding:40px"><h2>Application Shopify</h2><p>Parametre shop manquant.</p></div>';
      return;
    }

    // 2) embedded but host missing â†’ OAuth
    if (!host && CURRENT_SHOP) {
      window.top.location.href = "/api/auth/start?shop=" + encodeURIComponent(CURRENT_SHOP);
      return;
    }

    // 3) shop missing
    if (!CURRENT_SHOP) {
      document.body.innerHTML =
        '<div style="padding:40px"><h2>Application Shopify</h2><p>Parametre shop manquant.</p></div>';
      return;
    }

    var ready = await initAppBridge();
    if (!ready) {
      console.warn("[Init] AppBridge fail");
      return;
    }

    var okSession = await ensureSessionOrRedirect();
    if (!okSession) return;

    setupNavigation();
    await ensureOAuthInstalled();
    await loadPlanInfo();
    await loadSettingsDataSilent();  // Charger les settings pour getStatus
    await loadProducts();
    renderTab("dashboard");
    updateUI();
    console.log("[Init] Ready - Plan:", state.planId, "Features:", state.limits);
  }

  // Charger les settings silencieusement (pour getStatus)
  async function loadSettingsDataSilent() {
    try {
      var res = await authFetch(apiUrl("/settings"));
      if (res.ok) {
        var data = await res.json();
        settingsData = data.settings || {};
        settingsOptions = data.options || {};
        
        // Initialiser i18n avec la langue des settings
        if (typeof I18N !== "undefined" && settingsData.general) {
          I18N.init(settingsData.general.language);
        }
      }
    } catch (e) {
      console.warn("[Settings] Silent load failed:", e);
    }
  }

  function setupNavigation() {
    document.querySelectorAll(".nav-item[data-tab]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        var tab = el.dataset.tab;
        var feat = el.dataset.feature;
        if (feat && !hasFeature(feat)) {
          showLockedModal(feat);
          return;
        }
        navigateTo(tab);
      });
    });
  }

  function navigateTo(tab) {
    state.currentTab = tab;
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.tab === tab);
    });
    closeSidebarOnMobile();
    renderTab(tab);
  }

  function toggleSidebar() {
    var sb = document.getElementById("sidebar");
    if (!sb) return;
    
    // Sur mobile, utiliser la classe 'open' au lieu de 'collapsed'
    if (window.innerWidth <= 768) {
      sb.classList.toggle("open");
      
      // Gerer l'overlay
      var overlay = document.getElementById("sidebarOverlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "sidebarOverlay";
        overlay.className = "sidebar-overlay";
        overlay.onclick = function() { toggleSidebar(); };
        document.body.appendChild(overlay);
      }
      overlay.classList.toggle("visible", sb.classList.contains("open"));
    } else {
      sb.classList.toggle("collapsed");
    }
  }
  
  // Fermer le sidebar quand on navigue sur mobile
  function closeSidebarOnMobile() {
    if (window.innerWidth <= 768) {
      var sb = document.getElementById("sidebar");
      var overlay = document.getElementById("sidebarOverlay");
      if (sb) sb.classList.remove("open");
      if (overlay) overlay.classList.remove("visible");
    }
  }

  function renderTab(tab) {
    var c = document.getElementById("pageContent");
    if (!c) return;

    switch (tab) {
      case "dashboard":
        renderDashboard(c);
        break;
      case "products":
        renderProducts(c);
        break;
      case "batches":
        renderBatches(c);
        break;
      case "suppliers":
        renderSuppliers(c);
        break;
      case "orders":
        renderFeature(c, "hasPurchaseOrders", "Commandes", "clipboard-list");
        break;
      case "forecast":
        renderFeature(c, "hasForecast", "Previsions", "trending-up");
        break;
      case "kits":
        renderFeature(c, "hasKits", "Kits et Bundles", "puzzle");
        break;
      case "analytics":
        renderAnalytics(c);
        break;
      case "inventory":
        renderFeature(c, "hasInventoryCount", "Inventaire", "clipboard-check");
        break;
      case "settings":
        renderSettings(c);
        break;
      default:
        renderDashboard(c);
    }
    // Refresh Lucide icons after rendering
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function renderFeature(c, key, title, iconName) {
    var iconHtml = '<i data-lucide="' + iconName + '"></i>';
    if (!hasFeature(key)) {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title">' +
        iconHtml +
        " " +
        title +
        "</h1></div>" +
        '<div class="card" style="min-height:400px;display:flex;align-items:center;justify-content:center"><div class="text-center">' +
        '<div class="lock-icon"><i data-lucide="lock"></i></div><h2>Fonctionnalite verrouillee</h2>' +
        '<p class="text-secondary">Passez a un plan superieur pour debloquer.</p>' +
        '<button class="btn btn-upgrade mt-lg" onclick="app.showUpgradeModal()">Upgrader</button></div></div>';
    } else {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title">' +
        iconHtml +
        " " +
        title +
        "</h1></div>" +
        '<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon"><i data-lucide="package-open"></i></div>' +
        "<p>Aucun element</p></div></div></div>";
    }
    // Refresh Lucide icons
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function renderDashboard(c) {
    var totalStock = state.products.reduce(function (s, p) {
      return s + (p.totalGrams || 0);
    }, 0);
    var totalValue = state.products.reduce(function (s, p) {
      return s + (p.totalGrams || 0) * (p.averageCostPerGram || 0);
    }, 0);
    var lowStock = state.products.filter(function (p) {
      return (p.totalGrams || 0) < 100;
    }).length;

    c.innerHTML =
      '<div class="page-header"><div><h1 class="page-title">' + t("dashboard.title", "Tableau de bord") + '</h1><p class="page-subtitle">' + t("dashboard.subtitle", "Vue d\'ensemble") + '</p></div>' +
      '<div class="page-actions"><button class="btn btn-secondary" onclick="app.syncShopify()">' + t("dashboard.sync", "Sync") + '</button>' +
      '<button class="btn btn-primary" onclick="app.showAddProductModal()">' + t("dashboard.addProduct", "+ Produit") + '</button></div></div>' +
      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="boxes"></i></div><div class="stat-value">' +
      state.products.length +
      '</div><div class="stat-label">' + t("dashboard.products", "Produits") + '</div></div>' +
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="scale"></i></div><div class="stat-value">' +
      formatWeight(totalStock) +
      '</div><div class="stat-label">' + t("dashboard.totalStock", "Stock total") + '</div></div>' +
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="coins"></i></div><div class="stat-value">' +
      formatCurrency(totalValue) +
      '</div><div class="stat-label">' + t("dashboard.value", "Valeur") + '</div></div>' +
      '<div class="stat-card stat-warning"><div class="stat-icon"><i data-lucide="alert-triangle"></i></div><div class="stat-value">' +
      lowStock +
      '</div><div class="stat-label">' + t("dashboard.lowStock", "Stock bas") + '</div></div>' +
      "</div>" +
      
      '<div class="dashboard-grid">' +
      '<div class="card"><div class="card-header"><h3 class="card-title"><i data-lucide="boxes"></i> ' + t("dashboard.products", "Produits") + '</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="app.navigateTo(\'products\')">' + t("dashboard.viewAll", "Voir tout") + '</button></div>' +
      '<div class="card-body" style="padding:0">' +
      (state.products.length ? renderTable(state.products.slice(0, 5)) : renderEmpty()) +
      "</div></div>" +
      
      '<div class="card"><div class="card-header"><h3 class="card-title"><i data-lucide="activity"></i> ' + t("dashboard.recentMovements", "Mouvements recents") + '</h3>' +
      '</div>' +
      '<div class="card-body" id="dashboardMovements"><div class="text-center py-lg"><div class="spinner"></div></div></div></div>' +
      
      '</div>';
    
    loadDashboardMovements();
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  async function loadDashboardMovements() {
    try {
      var res = await authFetch(apiUrl("/movements?limit=10"));
      var container = document.getElementById("dashboardMovements");
      if (!container) return;
      
      if (!res.ok) {
        container.innerHTML = '<p class="text-secondary text-center">' + t("msg.error", "Erreur") + '</p>';
        return;
      }
      
      var data = await res.json();
      var movements = data.movements || [];
      
      if (movements.length === 0) {
        container.innerHTML = '<div class="empty-state-small"><div class="empty-icon"><i data-lucide="activity"></i></div><p class="text-secondary">' + t("dashboard.noMovements", "Aucun mouvement") + '</p></div>';
        if (typeof lucide !== "undefined") lucide.createIcons();
        return;
      }
      
      var html = '<div class="movements-list">';
      movements.forEach(function(m) {
        var typeIcon = getMovementIcon(m.type);
        var typeClass = getMovementClass(m.type);
        var typeLabel = getMovementLabel(m.type);
        var delta = m.delta || 0;
        var deltaStr = delta >= 0 ? '+' + formatWeight(delta) : formatWeight(delta);
        var dateStr = formatRelativeDate(m.createdAt || m.date);
        
        html += '<div class="movement-item">' +
          '<div class="movement-icon ' + typeClass + '"><i data-lucide="' + typeIcon + '"></i></div>' +
          '<div class="movement-info">' +
          '<div class="movement-product">' + esc(m.productName || m.product || 'Produit') + '</div>' +
          '<div class="movement-meta"><span class="movement-type">' + typeLabel + '</span><span class="movement-date">' + dateStr + '</span></div>' +
          '</div>' +
          '<div class="movement-delta ' + typeClass + '">' + deltaStr + '</div>' +
          '</div>';
      });
      html += '</div>';
      
      container.innerHTML = html;
      if (typeof lucide !== "undefined") lucide.createIcons();
      
    } catch (e) {
      var container = document.getElementById("dashboardMovements");
      if (container) {
        container.innerHTML = '<p class="text-secondary text-center">' + t("msg.error", "Erreur") + '</p>';
      }
    }
  }

  function getMovementIcon(type) {
    var icons = {
      'restock': 'package-plus',
      'sale': 'shopping-cart',
      'adjustment': 'sliders',
      'transfer': 'repeat',
      'return': 'rotate-ccw',
      'loss': 'trash-2',
      'production': 'factory',
      'inventory': 'clipboard-check'
    };
    return icons[type] || 'activity';
  }

  function getMovementClass(type) {
    var classes = {
      'restock': 'success',
      'sale': 'primary',
      'adjustment': 'warning',
      'transfer': 'info',
      'return': 'info',
      'loss': 'danger',
      'production': 'success',
      'inventory': 'secondary'
    };
    return classes[type] || '';
  }

  function getMovementLabel(type) {
    var labels = {
      'restock': t("movement.restock", "Reappro"),
      'sale': t("movement.sale", "Vente"),
      'adjustment': t("movement.adjustment", "Ajustement"),
      'transfer': t("movement.transfer", "Transfert"),
      'return': t("movement.return", "Retour"),
      'loss': t("movement.loss", "Perte"),
      'production': t("movement.production", "Production"),
      'inventory': t("movement.inventory", "Inventaire")
    };
    return labels[type] || type;
  }

  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    var date = new Date(dateStr);
    var now = new Date();
    var diffMs = now - date;
    var diffMins = Math.floor(diffMs / 60000);
    var diffHours = Math.floor(diffMs / 3600000);
    var diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return t("time.justNow", "A l\'instant");
    if (diffMins < 60) return diffMins + ' ' + t("time.minutesAgo", "min");
    if (diffHours < 24) return diffHours + ' ' + t("time.hoursAgo", "h");
    if (diffDays < 7) return diffDays + ' ' + t("time.daysAgo", "j");
    
    return date.toLocaleDateString();
  }

  function renderProducts(c) {
    // Options categories pour le select
    var catOptions = '<option value="">Toutes les categories</option>';
    catOptions += '<option value="uncategorized"' + (state.filters.category === "uncategorized" ? " selected" : "") + '>Sans categorie</option>';
    state.categories.forEach(function(cat) {
      var count = cat.productCount || 0;
      catOptions += '<option value="' + esc(cat.id) + '"' + (state.filters.category === cat.id ? " selected" : "") + '>' + esc(cat.name) + ' (' + count + ')</option>';
    });

    // Options tri
    var sortOptions = [
      { value: "alpha", label: "Nom A-Z" },
      { value: "alpha_desc", label: "Nom Z-A" },
      { value: "stock_asc", label: "Stock croissant" },
      { value: "stock_desc", label: "Stock decroissant" },
      { value: "value_asc", label: "Valeur croissante" },
      { value: "value_desc", label: "Valeur decroissante" }
    ];
    var sortOptionsHtml = sortOptions.map(function(opt) {
      return '<option value="' + opt.value + '"' + (state.filters.sort === opt.value ? " selected" : "") + '>' + opt.label + '</option>';
    }).join("");

    c.innerHTML =
      '<div class="page-header"><div><h1 class="page-title">Produits</h1><p class="page-subtitle">' +
      state.products.length + " produit(s)</p></div>" +
      '<div class="page-actions">' +
      '<button class="btn btn-ghost" onclick="app.showCategoriesModal()">Categories</button>' +
      '<button class="btn btn-secondary" onclick="app.showImportModal()">Import Shopify</button>' +
      '<button class="btn btn-primary" onclick="app.showAddProductModal()">+ Ajouter</button></div></div>' +
      
      // Toolbar filtres
      '<div class="toolbar-filters">' +
      '<div class="filter-group">' +
      '<input type="text" class="form-input" id="searchInput" placeholder="Rechercher..." value="' + esc(state.filters.search) + '" onkeyup="app.onSearchChange(event)">' +
      '</div>' +
      '<div class="filter-group">' +
      '<select class="form-select" id="categoryFilter" onchange="app.onCategoryChange(this.value)">' + catOptions + '</select>' +
      '</div>' +
      '<div class="filter-group">' +
      '<select class="form-select" id="sortFilter" onchange="app.onSortChange(this.value)">' + sortOptionsHtml + '</select>' +
      '</div>' +
      '</div>' +
      
      '<div class="card"><div class="card-body" style="padding:0">' +
      (state.products.length ? renderTable(state.products) : renderEmpty()) +
      "</div></div>";
  }

  // ============================================
  // LOTS & DLC (Plan PRO)
  // ============================================
  
  var batchesData = null;
  var batchFilters = { status: "", productId: "", expiring: "" };

  function renderBatches(c) {
    // Verifier le plan PRO
    if (!hasFeature("hasBatchTracking")) {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title"><i data-lucide="tags"></i> ' + t("batches.title", "Lots & DLC") + '</h1></div>' +
        '<div class="card" style="min-height:400px;display:flex;align-items:center;justify-content:center"><div class="text-center">' +
        '<div class="lock-icon"><i data-lucide="lock"></i></div>' +
        '<h2>' + t("msg.featureLocked", "Fonctionnalite PRO") + '</h2>' +
        '<p class="text-secondary">' + t("batches.lockedDesc", "Gerez vos lots, tracez vos DLC et anticipez les pertes avec le plan Pro.") + '</p>' +
        '<div class="feature-preview mt-lg">' +
        '<div class="preview-item"><i data-lucide="layers"></i> ' + t("batches.feature1", "Tracabilite complete") + '</div>' +
        '<div class="preview-item"><i data-lucide="calendar-clock"></i> ' + t("batches.feature2", "Alertes DLC automatiques") + '</div>' +
        '<div class="preview-item"><i data-lucide="arrow-down-up"></i> ' + t("batches.feature3", "FIFO / FEFO automatique") + '</div>' +
        '</div>' +
        '<button class="btn btn-upgrade mt-lg" onclick="app.showUpgradeModal()">' + t("action.upgrade", "Passer a PRO") + '</button>' +
        '</div></div>';
      return;
    }

    // Afficher loading
    c.innerHTML =
      '<div class="page-header"><div><h1 class="page-title"><i data-lucide="tags"></i> ' + t("batches.title", "Lots & DLC") + '</h1>' +
      '<p class="page-subtitle">' + t("batches.subtitle", "Tracabilite et gestion des dates limites") + '</p></div>' +
      '<div class="page-actions">' +
      '<button class="btn btn-secondary" onclick="app.markExpiredBatches()"><i data-lucide="alert-triangle"></i> ' + t("batches.markExpired", "Marquer expires") + '</button>' +
      '<button class="btn btn-primary" onclick="app.showAddBatchModal()"><i data-lucide="plus"></i> ' + t("batches.addBatch", "Nouveau lot") + '</button>' +
      '</div></div>' +
      '<div id="batchesKpis"><div class="text-center py-lg"><div class="spinner"></div></div></div>' +
      '<div id="batchesFilters"></div>' +
      '<div id="batchesContent"><div class="text-center py-lg"><div class="spinner"></div></div></div>';

    loadBatchesData();
  }

  async function loadBatchesData() {
    try {
      var params = new URLSearchParams();
      if (batchFilters.status) params.append("status", batchFilters.status);
      if (batchFilters.productId) params.append("productId", batchFilters.productId);
      if (batchFilters.expiring) params.append("expiringDays", batchFilters.expiring);

      var res = await authFetch(apiUrl("/lots?" + params.toString()));
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        if (err.error === "plan_limit") {
          showUpgradeModal();
          return;
        }
        throw new Error(err.error || "Erreur chargement");
      }

      batchesData = await res.json();
      renderBatchesKpis();
      renderBatchesFilters();
      renderBatchesTable();

    } catch (e) {
      document.getElementById("batchesContent").innerHTML =
        '<div class="card"><div class="card-body text-center"><p class="text-danger">' + t("msg.error", "Erreur") + ': ' + e.message + '</p></div></div>';
    }
  }

  function renderBatchesKpis() {
    if (!batchesData || !batchesData.kpis) return;
    var k = batchesData.kpis;

    var html =
      '<div class="stats-grid stats-grid-5">' +
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="layers"></i></div>' +
      '<div class="stat-value">' + k.totalLots + '</div>' +
      '<div class="stat-label">' + t("batches.totalLots", "Total lots") + '</div></div>' +
      
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="check-circle"></i></div>' +
      '<div class="stat-value">' + k.activeLots + '</div>' +
      '<div class="stat-label">' + t("batches.activeLots", "Lots actifs") + '</div></div>' +
      
      '<div class="stat-card stat-warning"><div class="stat-icon"><i data-lucide="clock"></i></div>' +
      '<div class="stat-value">' + k.expiringWithin30 + '</div>' +
      '<div class="stat-label">' + t("batches.expiringSoon", "Expirent sous 30j") + '</div></div>' +
      
      '<div class="stat-card stat-danger"><div class="stat-icon"><i data-lucide="alert-octagon"></i></div>' +
      '<div class="stat-value">' + k.expiredLots + '</div>' +
      '<div class="stat-label">' + t("batches.expiredLots", "Expires") + '</div></div>' +
      
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="alert-triangle"></i></div>' +
      '<div class="stat-value">' + formatCurrency(k.totalValueAtRisk) + '</div>' +
      '<div class="stat-label">' + t("batches.valueAtRisk", "Valeur a risque") + '</div></div>' +
      '</div>';

    document.getElementById("batchesKpis").innerHTML = html;
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function renderBatchesFilters() {
    // Options produits
    var productOptions = '<option value="">' + t("batches.allProducts", "Tous les produits") + '</option>';
    state.products.forEach(function(p) {
      productOptions += '<option value="' + esc(p.productId) + '"' + (batchFilters.productId === p.productId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    });

    var html =
      '<div class="toolbar-filters mb-md">' +
      '<div class="filter-group">' +
      '<select class="form-select" onchange="app.onBatchProductChange(this.value)">' + productOptions + '</select>' +
      '</div>' +
      '<div class="filter-group">' +
      '<select class="form-select" onchange="app.onBatchStatusChange(this.value)">' +
      '<option value="">' + t("batches.allStatus", "Tous les statuts") + '</option>' +
      '<option value="active"' + (batchFilters.status === "active" ? " selected" : "") + '>' + t("batches.statusActive", "Actifs") + '</option>' +
      '<option value="depleted"' + (batchFilters.status === "depleted" ? " selected" : "") + '>' + t("batches.statusDepleted", "Epuises") + '</option>' +
      '<option value="expired"' + (batchFilters.status === "expired" ? " selected" : "") + '>' + t("batches.statusExpired", "Expires") + '</option>' +
      '</select>' +
      '</div>' +
      '<div class="filter-group">' +
      '<select class="form-select" onchange="app.onBatchExpiringChange(this.value)">' +
      '<option value="">' + t("batches.allDates", "Toutes les dates") + '</option>' +
      '<option value="7"' + (batchFilters.expiring === "7" ? " selected" : "") + '>' + t("batches.expiring7", "Expire sous 7j") + '</option>' +
      '<option value="15"' + (batchFilters.expiring === "15" ? " selected" : "") + '>' + t("batches.expiring15", "Expire sous 15j") + '</option>' +
      '<option value="30"' + (batchFilters.expiring === "30" ? " selected" : "") + '>' + t("batches.expiring30", "Expire sous 30j") + '</option>' +
      '</select>' +
      '</div>' +
      '</div>';

    document.getElementById("batchesFilters").innerHTML = html;
  }

  function renderBatchesTable() {
    if (!batchesData || !batchesData.lots) return;
    var lots = batchesData.lots;

    if (lots.length === 0) {
      document.getElementById("batchesContent").innerHTML =
        '<div class="card"><div class="card-body">' +
        '<div class="empty-state"><div class="empty-icon"><i data-lucide="package-open"></i></div>' +
        '<h3>' + t("batches.noLots", "Aucun lot") + '</h3>' +
        '<p class="text-secondary">' + t("batches.noLotsDesc", "Creez votre premier lot pour commencer la tracabilite.") + '</p>' +
        '<button class="btn btn-primary mt-md" onclick="app.showAddBatchModal()">' + t("batches.addBatch", "Nouveau lot") + '</button>' +
        '</div></div></div>';
      if (typeof lucide !== "undefined") lucide.createIcons();
      return;
    }

    var rows = lots.map(function(lot) {
      var statusBadge = getBatchStatusBadge(lot);
      var dlcBadge = getBatchDlcBadge(lot);
      
      return '<tr class="batch-row" onclick="app.openBatchDetails(\'' + esc(lot.productId) + '\',\'' + esc(lot.id) + '\')">' +
        '<td><span class="batch-id">' + esc(lot.id) + '</span></td>' +
        '<td>' + esc(lot.productName || "Produit") + '</td>' +
        '<td>' + formatWeight(lot.currentGrams) + ' / ' + formatWeight(lot.initialGrams) + '</td>' +
        '<td>' + (lot.expiryDate ? lot.expiryDate : '-') + '</td>' +
        '<td>' + dlcBadge + '</td>' +
        '<td>' + formatPricePerUnit(lot.purchasePricePerGram || 0) + '</td>' +
        '<td>' + formatCurrency(lot.valueRemaining || 0) + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td class="cell-actions" onclick="event.stopPropagation()">' +
        '<button class="btn btn-ghost btn-xs" onclick="app.showAdjustBatchModal(\'' + esc(lot.productId) + '\',\'' + esc(lot.id) + '\')"><i data-lucide="sliders"></i></button>' +
        '</td>' +
        '</tr>';
    }).join("");

    var html =
      '<div class="card"><div class="card-body" style="padding:0">' +
      '<table class="data-table">' +
      '<thead><tr>' +
      '<th>' + t("batches.lotId", "Lot") + '</th>' +
      '<th>' + t("batches.product", "Produit") + '</th>' +
      '<th>' + t("batches.stock", "Stock") + '</th>' +
      '<th>' + t("batches.dlc", "DLC") + '</th>' +
      '<th>' + t("batches.daysLeft", "Jours") + '</th>' +
      '<th>' + t("batches.cost", "Cout") + '</th>' +
      '<th>' + t("batches.value", "Valeur") + '</th>' +
      '<th>' + t("batches.status", "Statut") + '</th>' +
      '<th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';

    document.getElementById("batchesContent").innerHTML = html;
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function getBatchStatusBadge(lot) {
    var status = lot.status || "active";
    var labels = {
      active: { class: "success", label: t("batches.statusActive", "Actif") },
      depleted: { class: "secondary", label: t("batches.statusDepleted", "Epuise") },
      expired: { class: "danger", label: t("batches.statusExpired", "Expire") },
      recalled: { class: "warning", label: t("batches.statusRecalled", "Rappele") }
    };
    var s = labels[status] || labels.active;
    return '<span class="badge badge-' + s.class + '">' + s.label + '</span>';
  }

  function getBatchDlcBadge(lot) {
    if (lot.daysLeft === null || lot.daysLeft === undefined) {
      return '<span class="text-secondary">-</span>';
    }
    
    var days = lot.daysLeft;
    if (days <= 0) {
      return '<span class="badge badge-danger">' + t("batches.expired", "Expire") + '</span>';
    } else if (days <= 7) {
      return '<span class="badge badge-danger">' + days + 'j</span>';
    } else if (days <= 15) {
      return '<span class="badge badge-warning">' + days + 'j</span>';
    } else if (days <= 30) {
      return '<span class="badge badge-info">' + days + 'j</span>';
    }
    return '<span class="text-success">' + days + 'j</span>';
  }

  function onBatchProductChange(productId) {
    batchFilters.productId = productId;
    loadBatchesData();
  }

  function onBatchStatusChange(status) {
    batchFilters.status = status;
    loadBatchesData();
  }

  function onBatchExpiringChange(days) {
    batchFilters.expiring = days;
    loadBatchesData();
  }

  function showAddBatchModal() {
    // Options produits
    var productOptions = state.products.map(function(p) {
      return '<option value="' + esc(p.productId) + '">' + esc(p.name) + '</option>';
    }).join("");

    showModal({
      title: t("batches.addBatch", "Nouveau lot"),
      size: "md",
      content:
        '<div class="form-group"><label class="form-label">' + t("batches.product", "Produit") + ' *</label>' +
        '<select class="form-select" id="batchProduct">' + productOptions + '</select></div>' +
        
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.quantity", "Quantite") + ' (' + getWeightUnit() + ') *</label>' +
        '<input type="number" class="form-input" id="batchGrams" placeholder="500" step="0.1"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.costPerUnit", "Cout") + ' (' + getCurrencySymbol() + '/' + getWeightUnit() + ')</label>' +
        '<input type="number" class="form-input" id="batchCost" placeholder="4.50" step="0.01"></div>' +
        '</div>' +
        
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.expiryType", "Type date") + '</label>' +
        '<select class="form-select" id="batchExpiryType">' +
        '<option value="dlc">DLC (Date Limite Consommation)</option>' +
        '<option value="dluo">DLUO / DDM (A consommer de preference)</option>' +
        '<option value="none">Aucune</option>' +
        '</select></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.expiryDate", "Date limite") + '</label>' +
        '<input type="date" class="form-input" id="batchExpiryDate"></div>' +
        '</div>' +
        
        '<div class="form-group"><label class="form-label">' + t("batches.supplierRef", "Ref. fournisseur") + '</label>' +
        '<input type="text" class="form-input" id="batchSupplierRef" placeholder="LOT-FOURNISSEUR-001"></div>' +
        
        '<div class="form-group"><label class="form-label">' + t("batches.notes", "Notes") + '</label>' +
        '<textarea class="form-input" id="batchNotes" rows="2" placeholder="Notes optionnelles..."></textarea></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
        '<button class="btn btn-primary" onclick="app.saveBatch()">' + t("action.save", "Enregistrer") + '</button>'
    });
  }

  async function saveBatch() {
    var productId = document.getElementById("batchProduct").value;
    var grams = parseFloat(document.getElementById("batchGrams").value);
    var costPerGram = parseFloat(document.getElementById("batchCost").value) || 0;
    var expiryType = document.getElementById("batchExpiryType").value;
    var expiryDate = document.getElementById("batchExpiryDate").value;
    var supplierRef = document.getElementById("batchSupplierRef").value;
    var notes = document.getElementById("batchNotes").value;

    if (!productId || !grams || grams <= 0) {
      showToast(t("batches.errorRequired", "Produit et quantite requis"), "error");
      return;
    }

    try {
      var res = await authFetch(apiUrl("/lots/" + productId), {
        method: "POST",
        body: JSON.stringify({
          grams: grams,
          costPerGram: costPerGram,
          expiryType: expiryType,
          expiryDate: expiryDate || null,
          supplierRef: supplierRef,
          notes: notes
        })
      });

      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || "Erreur");
      }

      closeModal();
      showToast(t("batches.lotCreated", "Lot cree avec succes"), "success");
      loadBatchesData();

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  function showAdjustBatchModal(productId, lotId) {
    showModal({
      title: t("batches.adjustBatch", "Ajuster le lot"),
      content:
        '<div class="form-group"><label class="form-label">' + t("batches.adjustment", "Ajustement") + ' (' + getWeightUnit() + ')</label>' +
        '<input type="number" class="form-input" id="adjustDelta" placeholder="-50 ou +100"></div>' +
        '<div class="form-group"><label class="form-label">' + t("batches.reason", "Raison") + '</label>' +
        '<input type="text" class="form-input" id="adjustReason" placeholder="Perte, correction inventaire..."></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
        '<button class="btn btn-primary" onclick="app.saveAdjustBatch(\'' + productId + '\',\'' + lotId + '\')">' + t("action.save", "Enregistrer") + '</button>'
    });
  }

  async function saveAdjustBatch(productId, lotId) {
    var delta = parseFloat(document.getElementById("adjustDelta").value);
    var reason = document.getElementById("adjustReason").value;

    if (isNaN(delta) || delta === 0) {
      showToast(t("batches.errorAdjustment", "Entrez une valeur d'ajustement"), "error");
      return;
    }

    try {
      var res = await authFetch(apiUrl("/lots/" + productId + "/" + lotId + "/adjust"), {
        method: "POST",
        body: JSON.stringify({ delta: delta, reason: reason })
      });

      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || "Erreur");
      }

      closeModal();
      showToast(t("batches.lotAdjusted", "Lot ajuste"), "success");
      loadBatchesData();

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  async function openBatchDetails(productId, lotId) {
    try {
      var res = await authFetch(apiUrl("/lots/" + productId + "/" + lotId));
      if (!res.ok) throw new Error("Lot non trouve");

      var data = await res.json();
      var lot = data.lot;
      var movements = data.movements || [];

      var statusBadge = getBatchStatusBadge(lot);
      var dlcBadge = getBatchDlcBadge(lot);

      // Historique mouvements
      var movementsHtml = movements.length > 0 
        ? movements.slice(0, 10).map(function(m) {
            return '<div class="movement-item-small">' +
              '<span class="movement-date-small">' + (m.createdAt || m.date || "").slice(0, 10) + '</span>' +
              '<span class="movement-type-small">' + (m.type || "?") + '</span>' +
              '<span class="movement-delta-small">' + (m.delta >= 0 ? "+" : "") + formatWeight(m.delta) + '</span>' +
              '</div>';
          }).join("")
        : '<p class="text-secondary">' + t("batches.noMovements", "Aucun mouvement") + '</p>';

      showModal({
        title: t("batches.lotDetails", "Details du lot") + " " + lot.id,
        size: "lg",
        content:
          '<div class="batch-detail-grid">' +
          '<div class="batch-detail-main">' +
          
          '<div class="detail-section">' +
          '<h4>' + t("batches.info", "Informations") + '</h4>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.product", "Produit") + '</span><span class="detail-value">' + esc(lot.productName || productId) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.status", "Statut") + '</span><span class="detail-value">' + statusBadge + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.received", "Recu le") + '</span><span class="detail-value">' + (lot.receivedAt || "").slice(0, 10) + '</span></div>' +
          '</div>' +
          
          '<div class="detail-section">' +
          '<h4>' + t("batches.stock", "Stock") + '</h4>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.initial", "Initial") + '</span><span class="detail-value">' + formatWeight(lot.initialGrams) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.remaining", "Restant") + '</span><span class="detail-value">' + formatWeight(lot.currentGrams) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.used", "Utilise") + '</span><span class="detail-value">' + formatWeight(lot.usedGrams || 0) + '</span></div>' +
          '<div class="batch-progress"><div class="batch-progress-bar" style="width:' + Math.round(((lot.currentGrams || 0) / (lot.initialGrams || 1)) * 100) + '%"></div></div>' +
          '</div>' +
          
          '<div class="detail-section">' +
          '<h4>' + t("batches.expiry", "Peremption") + '</h4>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.type", "Type") + '</span><span class="detail-value">' + (lot.expiryType || "none").toUpperCase() + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.date", "Date") + '</span><span class="detail-value">' + (lot.expiryDate || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.daysLeft", "Jours restants") + '</span><span class="detail-value">' + dlcBadge + '</span></div>' +
          '</div>' +
          
          '<div class="detail-section">' +
          '<h4>' + t("batches.cost", "Cout") + '</h4>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.costPerUnit", "Cout unitaire") + '</span><span class="detail-value">' + formatPricePerUnit(lot.purchasePricePerGram || 0) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.totalCost", "Cout total") + '</span><span class="detail-value">' + formatCurrency(lot.totalCost || 0) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + t("batches.valueRemaining", "Valeur restante") + '</span><span class="detail-value">' + formatCurrency(lot.valueRemaining || 0) + '</span></div>' +
          '</div>' +
          
          '</div>' +
          
          '<div class="batch-detail-sidebar">' +
          '<div class="detail-section">' +
          '<h4>' + t("batches.history", "Historique") + '</h4>' +
          movementsHtml +
          '</div>' +
          
          (lot.notes ? '<div class="detail-section"><h4>' + t("batches.notes", "Notes") + '</h4><p class="text-secondary">' + esc(lot.notes) + '</p></div>' : '') +
          '</div>' +
          
          '</div>',
        footer:
          '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.close", "Fermer") + '</button>' +
          '<button class="btn btn-secondary" onclick="app.showAdjustBatchModal(\'' + productId + '\',\'' + lotId + '\')">' + t("batches.adjust", "Ajuster") + '</button>' +
          (lot.status === "active" ? '<button class="btn btn-danger" onclick="app.deactivateBatch(\'' + productId + '\',\'' + lotId + '\')">' + t("batches.deactivate", "Desactiver") + '</button>' : '')
      });

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  async function deactivateBatch(productId, lotId) {
    if (!confirm(t("batches.confirmDeactivate", "Voulez-vous vraiment desactiver ce lot ?"))) return;

    try {
      var res = await authFetch(apiUrl("/lots/" + productId + "/" + lotId), {
        method: "PUT",
        body: JSON.stringify({ status: "recalled" })
      });

      if (!res.ok) throw new Error("Erreur");

      closeModal();
      showToast(t("batches.lotDeactivated", "Lot desactive"), "success");
      loadBatchesData();

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  async function markExpiredBatches() {
    try {
      var res = await authFetch(apiUrl("/lots/mark-expired"), { method: "POST" });
      if (!res.ok) throw new Error("Erreur");

      var data = await res.json();
      showToast(t("batches.markedExpired", "lots marques expires").replace("{count}", data.markedCount), "success");
      loadBatchesData();

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  // ============================================
  // FOURNISSEURS (Plan PRO)
  // ============================================
  
  var suppliersData = null;
  var supplierFilters = { status: "", search: "" };

  function renderSuppliers(c) {
    // Verifier le plan
    if (!hasFeature("hasSuppliers")) {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title"><i data-lucide="factory"></i> ' + t("suppliers.title", "Fournisseurs") + '</h1></div>' +
        '<div class="card" style="min-height:400px;display:flex;align-items:center;justify-content:center"><div class="text-center">' +
        '<div class="lock-icon"><i data-lucide="lock"></i></div>' +
        '<h2>' + t("msg.featureLocked", "Fonctionnalite PRO") + '</h2>' +
        '<p class="text-secondary">' + t("suppliers.lockedDesc", "Gerez vos fournisseurs, comparez les prix et optimisez vos achats.") + '</p>' +
        '<div class="feature-preview mt-lg">' +
        '<div class="preview-item"><i data-lucide="users"></i> ' + t("suppliers.feature1", "Carnet fournisseurs") + '</div>' +
        '<div class="preview-item"><i data-lucide="git-compare"></i> ' + t("suppliers.feature2", "Comparaison des prix") + '</div>' +
        '<div class="preview-item"><i data-lucide="file-text"></i> ' + t("suppliers.feature3", "Historique achats") + '</div>' +
        '</div>' +
        '<button class="btn btn-upgrade mt-lg" onclick="app.showUpgradeModal()">' + t("action.upgrade", "Passer a PRO") + '</button>' +
        '</div></div>';
      return;
    }

    // Afficher loading
    c.innerHTML =
      '<div class="page-header"><div><h1 class="page-title"><i data-lucide="factory"></i> ' + t("suppliers.title", "Fournisseurs") + '</h1>' +
      '<p class="page-subtitle">' + t("suppliers.subtitle", "Gerez vos fournisseurs et optimisez vos achats") + '</p></div>' +
      '<div class="page-actions">' +
      '<button class="btn btn-primary" onclick="app.showAddSupplierModal()"><i data-lucide="plus"></i> ' + t("suppliers.add", "Ajouter") + '</button>' +
      '</div></div>' +
      '<div id="suppliersKpis"><div class="text-center py-lg"><div class="spinner"></div></div></div>' +
      '<div id="suppliersFilters"></div>' +
      '<div id="suppliersContent"><div class="text-center py-lg"><div class="spinner"></div></div></div>';

    loadSuppliersData();
  }

  async function loadSuppliersData() {
    try {
      var params = new URLSearchParams();
      if (supplierFilters.status) params.append("status", supplierFilters.status);
      if (supplierFilters.search) params.append("search", supplierFilters.search);

      var res = await authFetch(apiUrl("/suppliers?" + params.toString()));
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        if (err.error === "plan_limit") {
          showUpgradeModal();
          return;
        }
        throw new Error(err.error || "Erreur chargement");
      }

      suppliersData = await res.json();
      renderSuppliersKpis();
      renderSuppliersFilters();
      renderSuppliersTable();

    } catch (e) {
      document.getElementById("suppliersContent").innerHTML =
        '<div class="card"><div class="card-body text-center"><p class="text-danger">' + t("msg.error", "Erreur") + ': ' + e.message + '</p></div></div>';
    }
  }

  function renderSuppliersKpis() {
    if (!suppliersData || !suppliersData.stats) return;
    var s = suppliersData.stats;
    var suppliers = suppliersData.suppliers || [];
    
    var totalPurchased = suppliers.reduce(function(sum, sup) { return sum + (sup.totalPurchased || 0); }, 0);

    var html =
      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="factory"></i></div>' +
      '<div class="stat-value">' + s.total + '</div>' +
      '<div class="stat-label">' + t("suppliers.total", "Fournisseurs") + '</div></div>' +
      
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="check-circle"></i></div>' +
      '<div class="stat-value">' + s.active + '</div>' +
      '<div class="stat-label">' + t("suppliers.active", "Actifs") + '</div></div>' +
      
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="boxes"></i></div>' +
      '<div class="stat-value">' + s.withProducts + '</div>' +
      '<div class="stat-label">' + t("suppliers.withProducts", "Avec produits") + '</div></div>' +
      
      '<div class="stat-card"><div class="stat-icon"><i data-lucide="scale"></i></div>' +
      '<div class="stat-value">' + formatWeight(totalPurchased) + '</div>' +
      '<div class="stat-label">' + t("suppliers.totalPurchased", "Total achete") + '</div></div>' +
      '</div>';

    document.getElementById("suppliersKpis").innerHTML = html;
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function renderSuppliersFilters() {
    var html =
      '<div class="toolbar-filters mb-md">' +
      '<div class="filter-group" style="flex:2">' +
      '<input type="text" class="form-input" placeholder="' + t("suppliers.search", "Rechercher...") + '" value="' + esc(supplierFilters.search) + '" onkeyup="app.onSupplierSearchChange(event)">' +
      '</div>' +
      '<div class="filter-group">' +
      '<select class="form-select" onchange="app.onSupplierStatusChange(this.value)">' +
      '<option value="">' + t("suppliers.allStatus", "Tous les statuts") + '</option>' +
      '<option value="active"' + (supplierFilters.status === "active" ? " selected" : "") + '>' + t("suppliers.statusActive", "Actifs") + '</option>' +
      '<option value="inactive"' + (supplierFilters.status === "inactive" ? " selected" : "") + '>' + t("suppliers.statusInactive", "Inactifs") + '</option>' +
      '</select>' +
      '</div>' +
      '</div>';

    document.getElementById("suppliersFilters").innerHTML = html;
  }

  function renderSuppliersTable() {
    if (!suppliersData || !suppliersData.suppliers) return;
    var suppliers = suppliersData.suppliers;

    if (suppliers.length === 0) {
      document.getElementById("suppliersContent").innerHTML =
        '<div class="card"><div class="card-body">' +
        '<div class="empty-state"><div class="empty-icon"><i data-lucide="factory"></i></div>' +
        '<h3>' + t("suppliers.noSuppliers", "Aucun fournisseur") + '</h3>' +
        '<p class="text-secondary">' + t("suppliers.noSuppliersDesc", "Ajoutez votre premier fournisseur pour commencer.") + '</p>' +
        '<button class="btn btn-primary mt-md" onclick="app.showAddSupplierModal()">' + t("suppliers.add", "Ajouter un fournisseur") + '</button>' +
        '</div></div></div>';
      if (typeof lucide !== "undefined") lucide.createIcons();
      return;
    }

    var rows = suppliers.map(function(sup) {
      var statusBadge = getSupplierStatusBadge(sup.status);
      var typeBadge = sup.type ? '<span class="badge badge-secondary">' + esc(sup.type) + '</span>' : '';
      
      return '<tr class="supplier-row" onclick="app.openSupplierDetails(\'' + esc(sup.id) + '\')">' +
        '<td><div class="supplier-name-cell"><strong>' + esc(sup.name) + '</strong>' + (sup.code ? '<span class="supplier-code">' + esc(sup.code) + '</span>' : '') + '</div></td>' +
        '<td>' + typeBadge + '</td>' +
        '<td>' + (sup.contact ? esc(sup.contact.email || '-') : '-') + '</td>' +
        '<td>' + (sup.productsCount || 0) + '</td>' +
        '<td>' + (sup.lotsCount || 0) + '</td>' +
        '<td>' + formatWeight(sup.totalPurchased || 0) + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td class="cell-actions" onclick="event.stopPropagation()">' +
        '<button class="btn btn-ghost btn-xs" onclick="app.showEditSupplierModal(\'' + esc(sup.id) + '\')"><i data-lucide="edit"></i></button>' +
        '</td>' +
        '</tr>';
    }).join("");

    var html =
      '<div class="card"><div class="card-body" style="padding:0">' +
      '<table class="data-table">' +
      '<thead><tr>' +
      '<th>' + t("suppliers.name", "Nom") + '</th>' +
      '<th>' + t("suppliers.type", "Type") + '</th>' +
      '<th>' + t("suppliers.email", "Email") + '</th>' +
      '<th>' + t("suppliers.products", "Produits") + '</th>' +
      '<th>' + t("suppliers.lots", "Lots") + '</th>' +
      '<th>' + t("suppliers.purchased", "Achats") + '</th>' +
      '<th>' + t("suppliers.status", "Statut") + '</th>' +
      '<th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';

    document.getElementById("suppliersContent").innerHTML = html;
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function getSupplierStatusBadge(status) {
    var labels = {
      active: { class: "success", label: t("suppliers.statusActive", "Actif") },
      inactive: { class: "secondary", label: t("suppliers.statusInactive", "Inactif") },
      blocked: { class: "danger", label: t("suppliers.statusBlocked", "Bloque") }
    };
    var s = labels[status] || labels.active;
    return '<span class="badge badge-' + s.class + '">' + s.label + '</span>';
  }

  var supplierSearchTimeout = null;
  function onSupplierSearchChange(e) {
    clearTimeout(supplierSearchTimeout);
    supplierSearchTimeout = setTimeout(function() {
      supplierFilters.search = e.target.value;
      loadSuppliersData();
    }, 300);
  }

  function onSupplierStatusChange(status) {
    supplierFilters.status = status;
    loadSuppliersData();
  }

  function showAddSupplierModal() {
    showModal({
      title: t("suppliers.add", "Nouveau fournisseur"),
      size: "lg",
      content:
        '<div class="form-section"><h4>' + t("suppliers.generalInfo", "Informations generales") + '</h4>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:2"><label class="form-label">' + t("suppliers.name", "Nom") + ' *</label>' +
        '<input type="text" class="form-input" id="supplierName" placeholder="Nom du fournisseur"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.code", "Code") + '</label>' +
        '<input type="text" class="form-input" id="supplierCode" placeholder="ABC" maxlength="10"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.type", "Type") + '</label>' +
        '<select class="form-select" id="supplierType">' +
        '<option value="">-- Selectionner --</option>' +
        '<option value="grossiste">' + t("suppliers.typeWholesaler", "Grossiste") + '</option>' +
        '<option value="producteur">' + t("suppliers.typeProducer", "Producteur") + '</option>' +
        '<option value="importateur">' + t("suppliers.typeImporter", "Importateur") + '</option>' +
        '<option value="distributeur">' + t("suppliers.typeDistributor", "Distributeur") + '</option>' +
        '<option value="autre">' + t("suppliers.typeOther", "Autre") + '</option>' +
        '</select></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.country", "Pays") + '</label>' +
        '<input type="text" class="form-input" id="supplierCountry" placeholder="France"></div>' +
        '</div></div>' +
        
        '<div class="form-section"><h4>' + t("suppliers.contact", "Contact") + '</h4>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.contactName", "Nom contact") + '</label>' +
        '<input type="text" class="form-input" id="supplierContactName" placeholder="Jean Dupont"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.email", "Email") + '</label>' +
        '<input type="email" class="form-input" id="supplierEmail" placeholder="contact@exemple.com"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.phone", "Telephone") + '</label>' +
        '<input type="tel" class="form-input" id="supplierPhone" placeholder="+33 1 23 45 67 89"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.website", "Site web") + '</label>' +
        '<input type="url" class="form-input" id="supplierWebsite" placeholder="https://..."></div>' +
        '</div></div>' +
        
        '<div class="form-section"><h4>' + t("suppliers.terms", "Conditions commerciales") + '</h4>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.paymentTerms", "Paiement") + '</label>' +
        '<select class="form-select" id="supplierPaymentTerms">' +
        '<option value="immediate">' + t("suppliers.paymentImmediate", "Comptant") + '</option>' +
        '<option value="net30">' + t("suppliers.paymentNet30", "30 jours") + '</option>' +
        '<option value="net60">' + t("suppliers.paymentNet60", "60 jours") + '</option>' +
        '</select></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.deliveryDays", "Delai livraison (j)") + '</label>' +
        '<input type="number" class="form-input" id="supplierDeliveryDays" placeholder="3" min="0"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.minOrder", "Commande min") + ' (' + getCurrencySymbol() + ')</label>' +
        '<input type="number" class="form-input" id="supplierMinOrder" placeholder="500" min="0" step="0.01"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("suppliers.moq", "MOQ") + ' (' + getWeightUnit() + ')</label>' +
        '<input type="number" class="form-input" id="supplierMOQ" placeholder="1000" min="0"></div>' +
        '</div></div>' +
        
        '<div class="form-group"><label class="form-label">' + t("suppliers.notes", "Notes") + '</label>' +
        '<textarea class="form-input" id="supplierNotes" rows="2" placeholder="Notes internes..."></textarea></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
        '<button class="btn btn-primary" onclick="app.saveSupplier()">' + t("action.save", "Enregistrer") + '</button>'
    });
  }

  async function saveSupplier(supplierId) {
    var name = document.getElementById("supplierName").value.trim();
    if (!name) {
      showToast(t("suppliers.errorName", "Le nom est requis"), "error");
      return;
    }

    var data = {
      name: name,
      code: document.getElementById("supplierCode").value.trim(),
      type: document.getElementById("supplierType").value,
      contact: {
        name: document.getElementById("supplierContactName").value.trim(),
        email: document.getElementById("supplierEmail").value.trim(),
        phone: document.getElementById("supplierPhone").value.trim(),
        website: document.getElementById("supplierWebsite").value.trim(),
      },
      address: {
        country: document.getElementById("supplierCountry").value.trim(),
      },
      terms: {
        paymentTerms: document.getElementById("supplierPaymentTerms").value,
        deliveryDays: parseInt(document.getElementById("supplierDeliveryDays").value) || 0,
        minOrderAmount: parseFloat(document.getElementById("supplierMinOrder").value) || 0,
        minOrderGrams: parseFloat(document.getElementById("supplierMOQ").value) || 0,
      },
      notes: document.getElementById("supplierNotes").value.trim(),
    };

    try {
      var url = supplierId ? "/suppliers/" + supplierId : "/suppliers";
      var method = supplierId ? "PUT" : "POST";
      
      var res = await authFetch(apiUrl(url), {
        method: method,
        body: JSON.stringify(data)
      });

      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || err.message || "Erreur");
      }

      closeModal();
      showToast(t("suppliers.saved", "Fournisseur enregistre"), "success");
      loadSuppliersData();

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  async function openSupplierDetails(supplierId) {
    try {
      var res = await authFetch(apiUrl("/suppliers/" + supplierId));
      if (!res.ok) throw new Error("Fournisseur non trouve");

      var data = await res.json();
      var sup = data.supplier;
      var lots = data.lots || [];
      var analytics = data.analytics || {};

      var statusBadge = getSupplierStatusBadge(sup.status);

      // Onglets
      var tabs = 
        '<div class="detail-tabs">' +
        '<button class="detail-tab active" onclick="app.switchSupplierTab(\'info\')">' + t("suppliers.tabInfo", "Infos") + '</button>' +
        '<button class="detail-tab" onclick="app.switchSupplierTab(\'products\')">' + t("suppliers.tabProducts", "Produits") + '</button>' +
        '<button class="detail-tab" onclick="app.switchSupplierTab(\'lots\')">' + t("suppliers.tabLots", "Lots") + '</button>' +
        '<button class="detail-tab" onclick="app.switchSupplierTab(\'analytics\')">' + t("suppliers.tabAnalytics", "Analytics") + '</button>' +
        '</div>';

      // Contenu Info
      var infoContent = 
        '<div class="detail-section"><h4>' + t("suppliers.contact", "Contact") + '</h4>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.contactName", "Contact") + '</span><span class="detail-value">' + esc(sup.contact?.name || '-') + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.email", "Email") + '</span><span class="detail-value">' + (sup.contact?.email ? '<a href="mailto:' + esc(sup.contact.email) + '">' + esc(sup.contact.email) + '</a>' : '-') + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.phone", "Telephone") + '</span><span class="detail-value">' + esc(sup.contact?.phone || '-') + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.website", "Site web") + '</span><span class="detail-value">' + (sup.contact?.website ? '<a href="' + esc(sup.contact.website) + '" target="_blank">' + esc(sup.contact.website) + '</a>' : '-') + '</span></div>' +
        '</div>' +
        '<div class="detail-section"><h4>' + t("suppliers.terms", "Conditions") + '</h4>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.paymentTerms", "Paiement") + '</span><span class="detail-value">' + esc(sup.terms?.paymentTerms || '-') + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.deliveryDays", "Delai livraison") + '</span><span class="detail-value">' + (sup.terms?.deliveryDays || 0) + ' ' + t("common.days", "jours") + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.minOrder", "Commande min") + '</span><span class="detail-value">' + formatCurrency(sup.terms?.minOrderAmount || 0) + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">' + t("suppliers.moq", "MOQ") + '</span><span class="detail-value">' + formatWeight(sup.terms?.minOrderGrams || 0) + '</span></div>' +
        '</div>' +
        (sup.notes ? '<div class="detail-section"><h4>' + t("suppliers.notes", "Notes") + '</h4><p class="text-secondary">' + esc(sup.notes) + '</p></div>' : '');

      // Contenu Produits
      var productsContent = '';
      if ((sup.products || []).length > 0) {
        var prodRows = sup.products.map(function(p) {
          return '<tr>' +
            '<td>' + esc(p.productName || p.productId) + '</td>' +
            '<td>' + formatPricePerUnit(p.pricePerGram || 0) + '</td>' +
            '<td>' + formatWeight(p.currentStock || 0) + '</td>' +
            '<td>' + (p.lastUpdated || '-').slice(0, 10) + '</td>' +
            '</tr>';
        }).join('');
        productsContent = '<table class="data-table data-table-compact"><thead><tr><th>Produit</th><th>Prix</th><th>Stock actuel</th><th>Maj</th></tr></thead><tbody>' + prodRows + '</tbody></table>';
      } else {
        productsContent = '<div class="empty-state-small"><p class="text-secondary">' + t("suppliers.noProducts", "Aucun produit lie") + '</p>' +
          '<button class="btn btn-sm btn-primary mt-sm" onclick="app.showLinkProductModal(\'' + supplierId + '\')">' + t("suppliers.linkProduct", "Lier un produit") + '</button></div>';
      }

      // Contenu Lots
      var lotsContent = '';
      if (lots.length > 0) {
        var lotRows = lots.slice(0, 10).map(function(l) {
          return '<tr onclick="app.closeModal();app.openBatchDetails(\'' + l.productId + '\',\'' + l.id + '\')">' +
            '<td><span class="batch-id">' + esc(l.id) + '</span></td>' +
            '<td>' + esc(l.productName || '-') + '</td>' +
            '<td>' + formatWeight(l.initialGrams) + '</td>' +
            '<td>' + formatPricePerUnit(l.purchasePricePerGram || 0) + '</td>' +
            '<td>' + (l.createdAt || '').slice(0, 10) + '</td>' +
            '</tr>';
        }).join('');
        lotsContent = '<table class="data-table data-table-compact"><thead><tr><th>Lot</th><th>Produit</th><th>Quantite</th><th>Prix</th><th>Date</th></tr></thead><tbody>' + lotRows + '</tbody></table>';
        if (lots.length > 10) lotsContent += '<p class="text-secondary text-sm mt-sm">' + (lots.length - 10) + ' autres lots...</p>';
      } else {
        lotsContent = '<div class="empty-state-small"><p class="text-secondary">' + t("suppliers.noLots", "Aucun lot de ce fournisseur") + '</p></div>';
      }

      // Contenu Analytics
      var analyticsContent = 
        '<div class="analytics-mini-grid">' +
        '<div class="analytics-mini-card"><div class="analytics-mini-value">' + analytics.totalLots + '</div><div class="analytics-mini-label">' + t("suppliers.totalLots", "Lots") + '</div></div>' +
        '<div class="analytics-mini-card"><div class="analytics-mini-value">' + formatWeight(analytics.totalPurchased) + '</div><div class="analytics-mini-label">' + t("suppliers.totalPurchased", "Achete") + '</div></div>' +
        '<div class="analytics-mini-card"><div class="analytics-mini-value">' + formatCurrency(analytics.totalSpent) + '</div><div class="analytics-mini-label">' + t("suppliers.totalSpent", "Depense") + '</div></div>' +
        '<div class="analytics-mini-card"><div class="analytics-mini-value">' + formatPricePerUnit(analytics.avgPricePerGram) + '</div><div class="analytics-mini-label">' + t("suppliers.avgPrice", "Prix moyen") + '</div></div>' +
        '</div>' +
        (analytics.lastPurchase ? '<p class="text-secondary text-sm mt-md">' + t("suppliers.lastPurchase", "Dernier achat") + ': ' + analytics.lastPurchase.slice(0, 10) + '</p>' : '');

      var content = 
        '<div class="supplier-detail-header">' +
        '<div><h2>' + esc(sup.name) + '</h2>' + (sup.code ? '<span class="supplier-code">' + esc(sup.code) + '</span>' : '') + '</div>' +
        '<div>' + statusBadge + '</div>' +
        '</div>' +
        tabs +
        '<div class="supplier-tab-content" id="supplierTabInfo">' + infoContent + '</div>' +
        '<div class="supplier-tab-content" id="supplierTabProducts" style="display:none">' + productsContent + '</div>' +
        '<div class="supplier-tab-content" id="supplierTabLots" style="display:none">' + lotsContent + '</div>' +
        '<div class="supplier-tab-content" id="supplierTabAnalytics" style="display:none">' + analyticsContent + '</div>';

      showModal({
        title: t("suppliers.details", "Fiche fournisseur"),
        size: "xl",
        content: content,
        footer:
          '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.close", "Fermer") + '</button>' +
          '<button class="btn btn-secondary" onclick="app.showEditSupplierModal(\'' + supplierId + '\')">' + t("action.edit", "Modifier") + '</button>'
      });

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  function switchSupplierTab(tab) {
    document.querySelectorAll('.detail-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab.toLowerCase().slice(0, 4)));
    });
    document.querySelectorAll('.supplier-tab-content').forEach(function(content) {
      content.style.display = 'none';
    });
    var activeContent = document.getElementById('supplierTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (activeContent) activeContent.style.display = 'block';
  }

  async function showEditSupplierModal(supplierId) {
    try {
      var res = await authFetch(apiUrl("/suppliers/" + supplierId));
      if (!res.ok) throw new Error("Fournisseur non trouve");

      var data = await res.json();
      var sup = data.supplier;

      closeModal();
      showAddSupplierModal();

      // Pre-remplir les champs
      setTimeout(function() {
        document.getElementById("supplierName").value = sup.name || '';
        document.getElementById("supplierCode").value = sup.code || '';
        document.getElementById("supplierType").value = sup.type || '';
        document.getElementById("supplierCountry").value = sup.address?.country || '';
        document.getElementById("supplierContactName").value = sup.contact?.name || '';
        document.getElementById("supplierEmail").value = sup.contact?.email || '';
        document.getElementById("supplierPhone").value = sup.contact?.phone || '';
        document.getElementById("supplierWebsite").value = sup.contact?.website || '';
        document.getElementById("supplierPaymentTerms").value = sup.terms?.paymentTerms || 'immediate';
        document.getElementById("supplierDeliveryDays").value = sup.terms?.deliveryDays || '';
        document.getElementById("supplierMinOrder").value = sup.terms?.minOrderAmount || '';
        document.getElementById("supplierMOQ").value = sup.terms?.minOrderGrams || '';
        document.getElementById("supplierNotes").value = sup.notes || '';

        // Modifier le bouton pour update
        var footer = document.querySelector('.modal-footer');
        if (footer) {
          footer.innerHTML = 
            '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
            '<button class="btn btn-danger" onclick="app.deleteSupplier(\'' + supplierId + '\')">' + t("action.delete", "Supprimer") + '</button>' +
            '<button class="btn btn-primary" onclick="app.updateSupplier(\'' + supplierId + '\')">' + t("action.save", "Enregistrer") + '</button>';
        }
      }, 100);

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  async function updateSupplier(supplierId) {
    await saveSupplier(supplierId);
  }

  async function deleteSupplier(supplierId) {
    if (!confirm(t("suppliers.confirmDelete", "Voulez-vous vraiment supprimer ce fournisseur ?"))) return;

    try {
      var res = await authFetch(apiUrl("/suppliers/" + supplierId), { method: "DELETE" });
      if (!res.ok) throw new Error("Erreur");

      closeModal();
      showToast(t("suppliers.deleted", "Fournisseur supprime"), "success");
      loadSuppliersData();

    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  function renderTable(products) {
    var rows = products
      .map(function (p) {
        var s = p.totalGrams || 0,
          cost = p.averageCostPerGram || 0;
        var st = getStatus(s);
        
        // Generer les chips categories
        var catChips = "";
        if (Array.isArray(p.categoryIds) && p.categoryIds.length > 0) {
          catChips = p.categoryIds.map(function(catId) {
            var cat = state.categories.find(function(c) { return c.id === catId; });
            if (cat) {
              return '<span class="category-chip">' + esc(cat.name) + '</span>';
            }
            return "";
          }).join("");
        } else {
          catChips = '<span class="category-chip category-chip-empty">-</span>';
        }
        
        return (
          '<tr class="product-row" data-product-id="' + esc(p.productId) + '" onclick="app.openProductDetails(\'' + esc(p.productId) + '\')" style="cursor:pointer">' +
          "<td>" + esc(p.name || p.title || "Sans nom") + "</td>" +
          '<td class="cell-categories" onclick="event.stopPropagation();app.showAssignCategoriesModal(\'' + esc(p.productId) + '\')">' + catChips + '</td>' +
          "<td>" + formatWeight(s) + "</td>" +
          "<td>" + formatPricePerUnit(cost) + "</td>" +
          "<td>" + formatCurrency(s * cost) + "</td>" +
          '<td><span class="stock-badge ' + st.c + '">' + st.i + " " + st.l + "</span></td>" +
          '<td class="cell-actions" onclick="event.stopPropagation()">' +
          '<button class="btn btn-ghost btn-xs" onclick="app.showRestockModal(\'' + p.productId + "')\">+</button>" +
          '<button class="btn btn-ghost btn-xs" onclick="app.showAdjustModal(\'' + p.productId + "')\">Edit</button>" +
          '<button class="btn btn-ghost btn-xs" onclick="app.openProductDetails(\'' + p.productId + "')\">Details</button></td></tr>"
        );
      })
      .join("");
    return (
      '<table class="data-table"><thead><tr><th>Produit</th><th>Categories</th><th>Stock</th><th>CMP</th><th>Valeur</th><th>Statut</th><th></th></tr></thead><tbody>' +
      rows +
      "</tbody></table>"
    );
  }

  function renderEmpty() {
    return (
      '<div class="empty-state"><div class="empty-icon"><i data-lucide="package-open"></i></div><h3>Aucun produit</h3>' +
      '<p class="text-secondary">Ajoutez ou importez des produits.</p>' +
      '<button class="btn btn-primary" onclick="app.showAddProductModal()">+ Ajouter</button> ' +
      '<button class="btn btn-secondary" onclick="app.showImportModal()">Import Shopify</button></div>'
    );
  }

  // ============================================
  // PARAMETRES COMPLETS
  // ============================================
  var settingsData = null;
  var settingsOptions = null;

  function renderSettings(c) {
    c.innerHTML =
      '<div class="page-header"><h1 class="page-title">Parametres</h1></div>' +
      '<div id="settingsContent"><div class="text-center" style="padding:40px"><div class="spinner"></div></div></div>';
    
    loadSettingsData();
  }

  async function loadSettingsData() {
    try {
      var res = await authFetch(apiUrl("/settings"));
      if (!res.ok) {
        document.getElementById("settingsContent").innerHTML = '<div class="card"><div class="card-body"><p class="text-danger">Erreur chargement parametres</p></div></div>';
        return;
      }
      var data = await res.json();
      settingsData = data.settings || {};
      settingsOptions = data.options || {};
      renderSettingsContent();
    } catch (e) {
      document.getElementById("settingsContent").innerHTML = '<div class="card"><div class="card-body"><p class="text-danger">Erreur: ' + e.message + '</p></div></div>';
    }
  }

  function renderSettingsContent() {
    if (!settingsData) return;
    var s = settingsData;
    var o = settingsOptions || {};

    // Section Plan
    var max = state.limits.maxProducts;
    max = max === Infinity || max > 9999 ? "Illimite" : max;
    var trialInfo = "";
    if (state.trial && state.trial.active) {
      trialInfo = '<div class="setting-trial-info"><span class="badge badge-warning">ESSAI</span> ' + state.trial.daysLeft + ' jours restants</div>';
    }

    var planSection = 
      '<div class="settings-section">' +
      '<div class="settings-section-header"><h3>Mon abonnement</h3></div>' +
      '<div class="settings-section-body">' +
      '<div class="setting-plan-card">' +
      '<div class="plan-current"><div class="plan-name-big">' + state.planName + '</div>' + trialInfo +
      '<div class="plan-usage">' + state.products.length + ' / ' + max + ' produits</div></div>' +
      (state.planId !== "enterprise" ? '<button class="btn btn-upgrade" onclick="app.showUpgradeModal()">Changer de plan</button>' : '<span class="badge badge-success">ENTERPRISE</span>') +
      '</div></div></div>';

    // Section Langue & Region
    var langOptions = (o.languages || []).map(function(l) {
      var sel = (s.general && s.general.language === l.value) ? ' selected' : '';
      return '<option value="' + l.value + '"' + sel + '>' + l.label + '</option>';
    }).join('');

    var tzOptions = (o.timezones || []).map(function(t) {
      var sel = (s.general && s.general.timezone === t.value) ? ' selected' : '';
      return '<option value="' + t.value + '"' + sel + '>' + t.label + '</option>';
    }).join('');

    var dateOptions = (o.dateFormats || []).map(function(d) {
      var sel = (s.general && s.general.dateFormat === d.value) ? ' selected' : '';
      return '<option value="' + d.value + '"' + sel + '>' + d.label + '</option>';
    }).join('');

    var langSection = 
      '<div class="settings-section">' +
      '<div class="settings-section-header"><h3>Langue & Region</h3><p class="text-secondary">Personnalisez l\'affichage selon votre pays</p></div>' +
      '<div class="settings-section-body">' +
      '<div class="setting-row"><label class="setting-label">Langue de l\'application</label>' +
      '<select class="form-select setting-input" onchange="app.updateSetting(\'general\',\'language\',this.value)">' + langOptions + '</select></div>' +
      '<div class="setting-row"><label class="setting-label">Fuseau horaire</label>' +
      '<select class="form-select setting-input" onchange="app.updateSetting(\'general\',\'timezone\',this.value)">' + tzOptions + '</select></div>' +
      '<div class="setting-row"><label class="setting-label">Format de date</label>' +
      '<select class="form-select setting-input" onchange="app.updateSetting(\'general\',\'dateFormat\',this.value)">' + dateOptions + '</select></div>' +
      '<div class="setting-row"><label class="setting-label">Format horaire</label>' +
      '<div class="setting-toggle-group">' +
      '<button class="btn btn-sm ' + (s.general && s.general.timeFormat === '24h' ? 'btn-primary' : 'btn-ghost') + '" onclick="app.updateSetting(\'general\',\'timeFormat\',\'24h\')">24h</button>' +
      '<button class="btn btn-sm ' + (s.general && s.general.timeFormat === '12h' ? 'btn-primary' : 'btn-ghost') + '" onclick="app.updateSetting(\'general\',\'timeFormat\',\'12h\')">12h</button>' +
      '</div></div></div></div>';

    // Section Devise & Unites
    var currOptions = (o.currencies || []).map(function(c) {
      var sel = (s.currency && s.currency.code === c.value) ? ' selected' : '';
      return '<option value="' + c.value + '"' + sel + '>' + c.symbol + ' ' + c.label + '</option>';
    }).join('');

    var weightOptions = (o.weightUnits || []).map(function(w) {
      var sel = (s.units && s.units.weightUnit === w.value) ? ' selected' : '';
      return '<option value="' + w.value + '"' + sel + '>' + w.label + '</option>';
    }).join('');

    var currencySection = 
      '<div class="settings-section">' +
      '<div class="settings-section-header"><h3>Devise & Unites</h3><p class="text-secondary">Configurez vos preferences monetaires</p></div>' +
      '<div class="settings-section-body">' +
      '<div class="setting-row"><label class="setting-label">Devise principale</label>' +
      '<select class="form-select setting-input" onchange="app.updateSetting(\'currency\',\'code\',this.value)">' + currOptions + '</select></div>' +
      '<div class="setting-row"><label class="setting-label">Position du symbole</label>' +
      '<div class="setting-toggle-group">' +
      '<button class="btn btn-sm ' + (s.currency && s.currency.position === 'before' ? 'btn-primary' : 'btn-ghost') + '" onclick="app.updateSetting(\'currency\',\'position\',\'before\')">$100</button>' +
      '<button class="btn btn-sm ' + (s.currency && s.currency.position === 'after' ? 'btn-primary' : 'btn-ghost') + '" onclick="app.updateSetting(\'currency\',\'position\',\'after\')">100$</button>' +
      '</div></div>' +
      '<div class="setting-row"><label class="setting-label">Unite de poids</label>' +
      '<select class="form-select setting-input" onchange="app.updateSetting(\'units\',\'weightUnit\',this.value)">' + weightOptions + '</select></div>' +
      '</div></div>';

    // Section Stock
    var criticalThreshold = (s.stock && s.stock.criticalThreshold) || 50;
    var lowThreshold = (s.stock && s.stock.lowStockThreshold) || 200;
    
    var stockSection = 
      '<div class="settings-section">' +
      '<div class="settings-section-header"><h3>Gestion du stock</h3><p class="text-secondary">Regles de calcul et seuils d\'alerte</p></div>' +
      '<div class="settings-section-body">' +
      
      '<div class="setting-group-title">Seuils de statut</div>' +
      '<div class="setting-row"><label class="setting-label"><span class="status-dot critical"></span> Seuil critique (g)</label>' +
      '<div class="setting-input-help"><input type="number" class="form-input setting-input-sm" value="' + criticalThreshold + '" onchange="app.updateSetting(\'stock\',\'criticalThreshold\',parseInt(this.value))">' +
      '<span class="help-text">Stock &lt; ce seuil = Rouge</span></div></div>' +
      
      '<div class="setting-row"><label class="setting-label"><span class="status-dot low"></span> Seuil bas (g)</label>' +
      '<div class="setting-input-help"><input type="number" class="form-input setting-input-sm" value="' + lowThreshold + '" onchange="app.updateSetting(\'stock\',\'lowStockThreshold\',parseInt(this.value))">' +
      '<span class="help-text">Stock &lt; ce seuil = Jaune</span></div></div>' +
      
      '<div class="setting-info"><span class="status-dot good"></span> Au-dessus du seuil bas = Vert (OK)</div>' +
      
      '<div class="setting-group-title" style="margin-top:var(--space-lg)">Alertes</div>' +
      '<div class="setting-row"><label class="setting-label">Alertes stock bas</label>' +
      '<label class="toggle"><input type="checkbox" ' + (s.stock && s.stock.lowStockEnabled !== false ? 'checked' : '') + ' onchange="app.updateSetting(\'stock\',\'lowStockEnabled\',this.checked)"><span class="toggle-slider"></span></label></div>' +
      
      '<div class="setting-group-title" style="margin-top:var(--space-lg)">Valorisation</div>' +
      '<div class="setting-row"><label class="setting-label">Methode de valorisation</label>' +
      '<select class="form-select setting-input" onchange="app.updateSetting(\'stock\',\'costMethod\',this.value)">' +
      '<option value="cmp"' + (s.stock && s.stock.costMethod === 'cmp' ? ' selected' : '') + '>CMP (Cout Moyen Pondere)</option>' +
      '<option value="fifo"' + (s.stock && s.stock.costMethod === 'fifo' ? ' selected' : '') + '>FIFO (Premier Entre, Premier Sorti)</option>' +
      '</select></div>' +
      '<div class="setting-row"><label class="setting-label">Figer le CMP</label>' +
      '<label class="toggle"><input type="checkbox" ' + (s.stock && s.stock.freezeCMP ? 'checked' : '') + ' onchange="app.updateSetting(\'stock\',\'freezeCMP\',this.checked)"><span class="toggle-slider"></span></label></div>' +
      '<div class="setting-row"><label class="setting-label">Autoriser stock negatif</label>' +
      '<label class="toggle"><input type="checkbox" ' + (s.units && !s.units.neverNegative ? 'checked' : '') + ' onchange="app.updateSetting(\'units\',\'neverNegative\',!this.checked)"><span class="toggle-slider"></span></label></div>' +
      '</div></div>';

    // Section Notifications (PRO)
    var notifSection = '';
    if (hasFeature('hasNotifications')) {
      notifSection = 
        '<div class="settings-section">' +
        '<div class="settings-section-header"><h3>Notifications</h3><span class="badge badge-pro">PRO</span><p class="text-secondary">Configurez vos alertes</p></div>' +
        '<div class="settings-section-body">' +
        '<div class="setting-row"><label class="setting-label">Notifications activees</label>' +
        '<label class="toggle"><input type="checkbox" ' + (s.notifications && s.notifications.enabled ? 'checked' : '') + ' onchange="app.updateSetting(\'notifications\',\'enabled\',this.checked)"><span class="toggle-slider"></span></label></div>' +
        '<div class="setting-row"><label class="setting-label">Alerte stock bas</label>' +
        '<label class="toggle"><input type="checkbox" ' + (s.notifications && s.notifications.triggers && s.notifications.triggers.lowStock ? 'checked' : '') + ' onchange="app.updateNestedSetting(\'notifications\',\'triggers\',\'lowStock\',this.checked)"><span class="toggle-slider"></span></label></div>' +
        '</div></div>';
    } else {
      notifSection = 
        '<div class="settings-section settings-locked">' +
        '<div class="settings-section-header"><h3>Notifications</h3><span class="badge badge-pro">PRO</span></div>' +
        '<div class="settings-section-body">' +
        '<div class="locked-overlay"><p>Passez au plan Pro pour configurer les notifications.</p>' +
        '<button class="btn btn-upgrade btn-sm" onclick="app.showUpgradeModal()">Passer a Pro</button></div>' +
        '</div></div>';
    }

    // Section Avancee (BUSINESS)
    var advSection = '';
    if (hasFeature('hasAutomations')) {
      advSection = 
        '<div class="settings-section">' +
        '<div class="settings-section-header"><h3>Parametres avances</h3><span class="badge badge-business">BIZ</span></div>' +
        '<div class="settings-section-body">' +
        '<div class="setting-row"><label class="setting-label">Freebies par commande (g)</label>' +
        '<input type="number" class="form-input setting-input" value="' + ((s.freebies && s.freebies.deductionPerOrder) || 0) + '" onchange="app.updateSetting(\'freebies\',\'deductionPerOrder\',parseFloat(this.value))"></div>' +
        '<div class="setting-row"><label class="setting-label">Freebies actives</label>' +
        '<label class="toggle"><input type="checkbox" ' + (s.freebies && s.freebies.enabled ? 'checked' : '') + ' onchange="app.updateSetting(\'freebies\',\'enabled\',this.checked)"><span class="toggle-slider"></span></label></div>' +
        '</div></div>';
    }

    // Section Donnees
    var dataSection = 
      '<div class="settings-section">' +
      '<div class="settings-section-header"><h3>Donnees & Securite</h3></div>' +
      '<div class="settings-section-body">' +
      '<div class="setting-row"><label class="setting-label">Mode lecture seule</label>' +
      '<label class="toggle"><input type="checkbox" ' + (s.security && s.security.readOnlyMode ? 'checked' : '') + ' onchange="app.updateSetting(\'security\',\'readOnlyMode\',this.checked)"><span class="toggle-slider"></span></label></div>' +
      '<div class="setting-row"><label class="setting-label">Exporter les donnees</label>' +
      '<button class="btn btn-secondary btn-sm" onclick="app.exportSettings()">Telecharger backup</button></div>' +
      '<div class="setting-row"><label class="setting-label">Reinitialiser les parametres</label>' +
      '<button class="btn btn-ghost btn-sm text-danger" onclick="app.resetAllSettings()">Reinitialiser</button></div>' +
      '</div></div>';

    document.getElementById("settingsContent").innerHTML = 
      planSection + langSection + currencySection + stockSection + notifSection + advSection + dataSection;
  }

  async function updateSetting(section, key, value) {
    try {
      var body = {};
      body[key] = value;
      var res = await authFetch(apiUrl("/settings/" + section), {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast(t("settings.saved", "Parametre enregistre"), "success");
        // Mettre a jour le cache local
        if (!settingsData[section]) settingsData[section] = {};
        settingsData[section][key] = value;
        
        // Si c'est la langue, mettre a jour i18n
        if (section === "general" && key === "language" && typeof I18N !== "undefined") {
          I18N.setLang(value);
        }
        
        // Rafraichir l'affichage si c'est un parametre d'affichage
        if (section === "currency" || section === "units" || section === "general") {
          // Re-render la page courante pour appliquer les nouveaux formats
          renderTab(state.currentTab);
        }
      } else {
        var e = await res.json();
        showToast(e.error || t("msg.error", "Erreur"), "error");
      }
    } catch (e) {
      showToast(t("msg.error", "Erreur") + ": " + e.message, "error");
    }
  }

  async function updateNestedSetting(section, subSection, key, value) {
    try {
      var body = {};
      body[subSection] = {};
      body[subSection][key] = value;
      var res = await authFetch(apiUrl("/settings/" + section), {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast("Parametre enregistre", "success");
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  async function exportSettings() {
    try {
      var res = await authFetch(apiUrl("/settings/backup"));
      if (res.ok) {
        var data = await res.json();
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "stock-manager-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
        URL.revokeObjectURL(url);
        showToast("Backup telecharge", "success");
      }
    } catch (e) {
      showToast("Erreur export", "error");
    }
  }

  async function resetAllSettings() {
    if (!confirm("Reinitialiser tous les parametres aux valeurs par defaut ?")) return;
    try {
      var res = await authFetch(apiUrl("/settings/reset"), { method: "POST" });
      if (res.ok) {
        showToast("Parametres reinitialises", "success");
        loadSettingsData();
      }
    } catch (e) {
      showToast("Erreur", "error");
    }
  }

  function showModal(opts) {
    closeModal();
    var ct = document.getElementById("modalsContainer");
    if (!ct) return;
    ct.innerHTML =
      '<div class="modal-backdrop active" onclick="app.closeModal()"></div>' +
      '<div class="modal active ' +
      (opts.size ? "modal-" + opts.size : "") +
      '">' +
      '<div class="modal-header"><h2 class="modal-title">' +
      opts.title +
      '</h2><button class="modal-close" onclick="app.closeModal()">X</button></div>' +
      '<div class="modal-body">' +
      opts.content +
      "</div>" +
      (opts.footer ? '<div class="modal-footer">' + opts.footer + "</div>" : "") +
      "</div>";
  }

  function closeModal() {
    var el = document.getElementById("modalsContainer");
    if (el) el.innerHTML = "";
  }

  function showAddProductModal() {
    showModal({
      title: "Ajouter un produit",
      content:
        '<div class="form-group"><label class="form-label">Nom</label><input class="form-input" id="pName" placeholder="CBD Premium"></div>' +
        '<div style="display:flex;gap:16px"><div class="form-group" style="flex:1"><label class="form-label">Stock (g)</label><input type="number" class="form-input" id="pStock" value="0"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">Cout (" + getCurrencySymbol() + "/" + getWeightUnit() + ")</label><input type="number" class="form-input" id="pCost" value="0" step="0.01"></div></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button><button class="btn btn-primary" onclick="app.saveProduct()">Ajouter</button>',
    });
  }

  function showImportModal() {
    showModal({
      title: "Import Shopify",
      content:
        '<p class="text-secondary mb-lg">Selectionnez les produits a importer.</p><div id="shopifyList">Chargement...</div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button><button class="btn btn-primary" id="btnImport" onclick="app.doImport()" disabled>Importer</button>',
    });
    loadShopifyList();
  }

  async function loadShopifyList() {
    var ct = document.getElementById("shopifyList");
    try {
      var res = await authFetch(apiUrl("/shopify/products"));
      var data = await res.json();
      var prods = data.products || data || [];
      if (!prods.length) {
        ct.innerHTML = '<p class="text-secondary">Aucun produit Shopify.</p>';
        return;
      }
      ct.innerHTML =
        '<div style="max-height:300px;overflow:auto">' +
        prods
          .map(function (p) {
            return (
              '<label style="display:flex;padding:8px;border-bottom:1px solid var(--border-primary);cursor:pointer">' +
              '<input type="checkbox" class="cb-prod" value="' +
              p.id +
              '" style="margin-right:12px">' +
              esc(p.title) +
              "</label>"
            );
          })
          .join("") +
        "</div>";
      document.getElementById("btnImport").disabled = false;
    } catch (e) {
      ct.innerHTML = '<p class="text-danger">Erreur: ' + e.message + "</p>";
    }
  }

  async function doImport() {
    var cbs = document.querySelectorAll(".cb-prod:checked");
    if (!cbs.length) {
      showToast("Selectionnez au moins un produit", "warning");
      return;
    }
    var btn = document.getElementById("btnImport");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Import...";
    }
    var ok = 0,
      err = 0;
    for (var i = 0; i < cbs.length; i++) {
      try {
        var r = await authFetch(apiUrl("/import/product"), {
          method: "POST",
          body: JSON.stringify({ productId: cbs[i].value }),
        });
        if (r.ok) ok++;
        else err++;
      } catch (e) {
        err++;
      }
    }
    closeModal();
    if (ok) {
      showToast(ok + " produit(s) importe(s)", "success");
      await loadProducts();
      renderTab(state.currentTab);
    }
    if (err) showToast(err + " erreur(s)", "error");
  }

  function showRestockModal(pid) {
    var opts = state.products
      .map(function (p) {
        return (
          '<option value="' +
          p.productId +
          '"' +
          (p.productId === pid ? " selected" : "") +
          ">" +
          esc(p.name || p.title) +
          "</option>"
        );
      })
      .join("");
    showModal({
      title: "Reapprovisionner",
      content:
        '<div class="form-group"><label class="form-label">Produit</label><select class="form-select" id="rProd">' +
        opts +
        '</select></div>' +
        '<div style="display:flex;gap:16px"><div class="form-group" style="flex:1"><label class="form-label">Quantite (g)</label><input type="number" class="form-input" id="rQty" placeholder="500"></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">Prix (" + getCurrencySymbol() + "/" + getWeightUnit() + ")</label><input type="number" class="form-input" id="rPrice" placeholder="4.50" step="0.01"></div></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button><button class="btn btn-primary" onclick="app.saveRestock()">Valider</button>',
    });
  }

  function showAdjustModal(pid) {
    var opts = state.products
      .map(function (p) {
        return (
          '<option value="' +
          p.productId +
          '"' +
          (p.productId === pid ? " selected" : "") +
          ">" +
          esc(p.name || p.title) +
          " (" +
          formatWeight(p.totalGrams || 0) +
          ")</option>"
        );
      })
      .join("");
    showModal({
      title: "Ajuster le stock",
      content:
        '<div class="form-group"><label class="form-label">Produit</label><select class="form-select" id="aProd">' +
        opts +
        '</select></div>' +
        '<div class="form-group"><label class="form-label">Type</label><div style="display:flex;gap:16px">' +
        '<label><input type="radio" name="aType" value="add" checked> Ajouter</label>' +
        '<label><input type="radio" name="aType" value="remove"> Retirer</label></div></div>' +
        '<div class="form-group"><label class="form-label">Quantite (g)</label><input type="number" class="form-input" id="aQty" placeholder="100"></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button><button class="btn btn-primary" onclick="app.saveAdjust()">Appliquer</button>',
    });
  }

  function showUpgradeModal() {
    var plans = [
      { id: "starter", name: "Starter", price: 14.99, prods: "15", feats: ["Categories", "Import Shopify", "Valeur stock"] },
      { id: "pro", name: "Pro", price: 39.99, prods: "75", badge: "POPULAIRE", feats: ["Lots & DLC", "Fournisseurs", "Analytics", "Inventaire"] },
      { id: "business", name: "Business", price: 79.99, prods: "Illimite", badge: "BEST", feats: ["Previsions IA", "Kits", "Commandes", "Multi-users"] },
    ];
    var cards = plans
      .map(function (p) {
        var fl = p.feats.map(function (f) { return "<li>âœ“ " + f + "</li>"; }).join("");
        var isCurrent = state.planId === p.id;
        return (
          '<div class="card" style="' + (p.badge ? "border:2px solid var(--accent-primary)" : "") + '">' +
          (p.badge ? '<div class="badge badge-info" style="position:absolute;top:-8px;right:16px">' + p.badge + "</div>" : "") +
          '<div class="card-body text-center" style="position:relative"><h3>' + p.name + "</h3>" +
          '<div style="font-size:28px;font-weight:700">' + p.price + "<small>EUR/mois</small></div>" +
          '<div class="text-secondary text-sm mb-md">' + p.prods + " produits</div>" +
          '<ul style="text-align:left;list-style:none">' + fl + "</ul>" +
          '<button class="btn ' + (isCurrent ? "btn-secondary" : "btn-primary") + ' btn-sm" style="width:100%;margin-top:16px" ' +
          (isCurrent ? "disabled" : 'onclick="app.upgradeTo(\'' + p.id + "')\"") +
          ">" + (isCurrent ? "Actuel" : "Choisir") + "</button></div></div>"
        );
      })
      .join("");
    showModal({
      title: "Choisir un plan",
      size: "xl",
      content: '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">' + cards + "</div>",
      footer: '<button class="btn btn-ghost" onclick="app.closeModal()">Fermer</button>',
    });
  }

  function showLockedModal(key) {
    showModal({
      title: "Fonctionnalite verrouillee",
      content:
        '<div class="text-center"><div class="lock-icon"><i data-lucide="lock"></i></div><p class="text-secondary mt-lg">Passez a un plan superieur pour debloquer cette fonctionnalite.</p></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Fermer</button><button class="btn btn-upgrade" onclick="app.showUpgradeModal()">Upgrader</button>',
    });
  }

  function showToast(msg, type, dur) {
    var ct = document.getElementById("toastContainer");
    if (!ct) return;
    var t = document.createElement("div");
    t.className = "toast " + (type || "info");
    t.innerHTML =
      '<span class="toast-icon">' +
      ({ success: "âœ“", error: "X", warning: "!", info: "i" }[type] || "i") +
      '</span><div class="toast-message">' +
      esc(msg) +
      '</div><button class="toast-close" onclick="this.parentElement.remove()">X</button>';
    ct.appendChild(t);
    setTimeout(function () { t.classList.add("visible"); }, 10);
    setTimeout(function () { t.remove(); }, dur || 4000);
  }

  async function ensureOAuthInstalled() {
    try {
      var res = await authFetch(apiUrl("/debug/shopify"));
      if (res.status === 401) {
        var j = await res.json().catch(function () { return null; });
        if (j && j.reauthUrl) {
          window.top.location.href = j.reauthUrl;
          return false;
        }
      }
    } catch (e) {}
    return true;
  }

  async function loadPlanInfo() {
    try {
      var res = await authFetch(apiUrl("/plan"));
      if (!res.ok) return;
      var data = await res.json();

      state.planId = (data.current && data.current.planId) || data.planId || "free";
      state.planName = (data.current && data.current.name) || state.planId.charAt(0).toUpperCase() + state.planId.slice(1);
      state.limits = data.limits || {};
      
      // Infos trial
      state.trial = data.trial || {};
      state.effective = data.effective || {};
      
      console.log("[Plan] Effective:", state.planId, "Trial active:", state.trial.active, "Days left:", state.trial.daysLeft);
    } catch (e) {
      console.warn("[Plan] Error:", e);
    }
  }

  async function loadProducts(useFilters) {
    try {
      var url = "/stock";
      if (useFilters) {
        var params = [];
        if (state.filters.search) params.push("q=" + encodeURIComponent(state.filters.search));
        if (state.filters.category) params.push("category=" + encodeURIComponent(state.filters.category));
        if (state.filters.sort) params.push("sort=" + encodeURIComponent(state.filters.sort));
        if (params.length) url += "?" + params.join("&");
      }
      var res = await authFetch(apiUrl(url));
      if (!res.ok) {
        state.products = [];
        state.categories = [];
        return;
      }
      var data = await res.json();
      state.products = Array.isArray(data.products) ? data.products : [];
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      console.log("[Products] Loaded:", state.products.length, "Categories:", state.categories.length);
    } catch (e) {
      state.products = [];
      state.categories = [];
    }
    updateUI();
  }

  function applyFilters() {
    loadProducts(true).then(function() {
      renderTab(state.currentTab);
    });
  }

  async function saveProduct() {
    var name = (document.getElementById("pName") || {}).value;
    var stockv = parseFloat((document.getElementById("pStock") || {}).value) || 0;
    var cost = parseFloat((document.getElementById("pCost") || {}).value) || 0;
    if (!name) {
      showToast("Nom requis", "error");
      return;
    }
    try {
      var res = await authFetch(apiUrl("/products"), {
        method: "POST",
        body: JSON.stringify({ name: name, totalGrams: stockv, averageCostPerGram: cost }),
      });
      if (res.ok) {
        showToast("Produit ajoute", "success");
        closeModal();
        await loadProducts();
        renderTab(state.currentTab);
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur", "error");
    }
  }

  async function saveRestock() {
    var pid = (document.getElementById("rProd") || {}).value;
    var qty = parseFloat((document.getElementById("rQty") || {}).value);
    var price = parseFloat((document.getElementById("rPrice") || {}).value) || 0;
    if (!pid || !qty) {
      showToast("Champs requis", "error");
      return;
    }
    try {
      var res = await authFetch(apiUrl("/restock"), {
        method: "POST",
        body: JSON.stringify({ productId: pid, grams: qty, purchasePricePerGram: price }),
      });
      if (res.ok) {
        showToast("Stock mis a jour", "success");
        closeModal();
        await loadProducts();
        renderTab(state.currentTab);
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur", "error");
    }
  }

  async function saveAdjust() {
    var pid = (document.getElementById("aProd") || {}).value;
    var type = (document.querySelector('input[name="aType"]:checked') || {}).value;
    var qty = parseFloat((document.getElementById("aQty") || {}).value);
    if (!pid || !qty) {
      showToast("Champs requis", "error");
      return;
    }
    var delta = type === "remove" ? -Math.abs(qty) : Math.abs(qty);
    try {
      var res = await authFetch(apiUrl("/products/" + encodeURIComponent(pid) + "/adjust-total"), {
        method: "POST",
        body: JSON.stringify({ gramsDelta: delta }),
      });
      if (res.ok) {
        showToast("Ajustement OK", "success");
        closeModal();
        await loadProducts();
        renderTab(state.currentTab);
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur", "error");
    }
  }

  function syncShopify() {
    showToast("Sync...", "info");
  }

  async function upgradeTo(planId) {
    try {
      showToast("Redirection...", "info", 2000);
      var res = await authFetch(apiUrl("/plan/upgrade"), { method: "POST", body: JSON.stringify({ planId: planId }) });
      var data = await res.json();
      if (data.bypass) {
        showToast("Plan active", "success");
        await loadPlanInfo();
        closeModal();
        updateUI();
        return;
      }
      if (data.confirmationUrl) {
        window.top.location.href = data.confirmationUrl;
        return;
      }
    } catch (e) {
      showToast("Erreur", "error");
    }
  }

  function updateUI() {
    // Bandeau trial
    var trialBanner = document.getElementById("trialBanner");
    if (trialBanner) {
      if (state.trial && state.trial.active && state.trial.daysLeft > 0) {
        trialBanner.innerHTML = 
          '<div class="trial-banner-content">' +
          '<span class="trial-icon">TRIAL</span>' +
          '<span class="trial-text">Essai Starter gratuit - <strong>' + state.trial.daysLeft + ' jour(s) restant(s)</strong></span>' +
          '<button class="btn btn-sm btn-upgrade" onclick="app.showUpgradeModal()">Garder les fonctionnalites</button>' +
          '</div>';
        trialBanner.style.display = "block";
      } else if (state.trial && state.trial.expired) {
        trialBanner.innerHTML = 
          '<div class="trial-banner-content trial-expired">' +
          '<span class="trial-icon">!</span>' +
          '<span class="trial-text">Votre essai est termine. Passez a Starter pour continuer.</span>' +
          '<button class="btn btn-sm btn-upgrade" onclick="app.showUpgradeModal()">Choisir un plan</button>' +
          '</div>';
        trialBanner.style.display = "block";
      } else {
        trialBanner.style.display = "none";
      }
    }

    // Widget plan sidebar
    var w = document.getElementById("planWidget");
    if (w) {
      var max = state.limits.maxProducts;
      max = max === Infinity || max > 9999 ? "INF" : max;
      
      var trialBadge = "";
      if (state.trial && state.trial.active) {
        trialBadge = '<span class="trial-badge">' + state.trial.daysLeft + 'j</span>';
      }
      
      w.innerHTML =
        '<div class="plan-info"><span class="plan-name">' +
        state.planName + trialBadge +
        '</span><span class="plan-usage">' +
        state.products.length + "/" + max +
        "</span></div>" +
        (state.planId !== "enterprise"
          ? '<button class="btn btn-upgrade btn-sm" onclick="app.showUpgradeModal()">Upgrade</button>'
          : '<span style="color:var(--success);font-size:11px">ENTERPRISE OK</span>');
    }
  }

  function formatWeight(grams) {
    // Utiliser les settings si disponibles
    var unit = "g";
    var precision = 0;
    
    if (settingsData && settingsData.units) {
      unit = settingsData.units.weightUnit || "g";
      precision = settingsData.units.weightPrecision || 1;
    }
    
    // Facteurs de conversion depuis grammes
    var factors = {
      g: 1,
      kg: 1000,
      oz: 28.3495,
      lb: 453.592
    };
    
    var factor = factors[unit] || 1;
    var value = grams / factor;
    
    // Formater selon la precision
    if (unit === "g" && value >= 1000 && (!settingsData || !settingsData.units)) {
      // Fallback: convertir en kg si > 1000g et pas de settings
      return (grams / 1000).toFixed(2) + " kg";
    }
    
    return value.toFixed(precision) + " " + unit;
  }
  
  function formatCurrency(value) {
    // Utiliser les settings si disponibles
    var code = "EUR";
    var locale = "fr-FR";
    var position = "after";
    var symbol = "EUR";
    
    if (settingsData && settingsData.currency) {
      code = settingsData.currency.code || "EUR";
      symbol = settingsData.currency.symbol || code;
      position = settingsData.currency.position || "after";
    }
    
    if (settingsData && settingsData.general) {
      var lang = settingsData.general.language || "fr";
      var localeMap = {
        fr: "fr-FR",
        en: "en-US",
        de: "de-DE",
        es: "es-ES",
        it: "it-IT"
      };
      locale = localeMap[lang] || "fr-FR";
    }
    
    try {
      return new Intl.NumberFormat(locale, { 
        style: "currency", 
        currency: code 
      }).format(value);
    } catch (e) {
      // Fallback si devise invalide
      var formatted = value.toFixed(2);
      return position === "before" ? symbol + formatted : formatted + " " + symbol;
    }
  }
  
  // Helper: obtenir l'unite de poids courante
  function getWeightUnit() {
    if (settingsData && settingsData.units && settingsData.units.weightUnit) {
      return settingsData.units.weightUnit;
    }
    return "g";
  }
  
  // Helper: obtenir le symbole de devise courant
  function getCurrencySymbol() {
    if (settingsData && settingsData.currency && settingsData.currency.symbol) {
      return settingsData.currency.symbol;
    }
    return "EUR";
  }
  
  // Helper: formater un prix par unite de poids (ex: "1.50 EUR/g")
  function formatPricePerUnit(value) {
    return formatCurrency(value) + "/" + getWeightUnit();
  }
  
  function getStatus(g) {
    // Utiliser les seuils des settings si disponibles
    var criticalThreshold = 50;
    var lowThreshold = 200;
    
    if (settingsData && settingsData.stock) {
      criticalThreshold = settingsData.stock.criticalThreshold || 50;
      lowThreshold = settingsData.stock.lowStockThreshold || 200;
    }
    
    if (g <= 0) return { c: "critical", l: "Rupture", i: "[!]" };
    if (g < criticalThreshold) return { c: "critical", l: "Critique", i: "[!]" };
    if (g < lowThreshold) return { c: "low", l: "Bas", i: "[~]" };
    return { c: "good", l: "OK", i: "[OK]" };
  }
  function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function toggleNotifications() {
    showToast("Bientot", "info");
  }
  function toggleUserMenu() {
    showToast("Bientot", "info");
  }

  // ============================================
  // ✅ FICHE DÉTAIL PRODUIT
  // ============================================
  async function openProductDetails(productId) {
    if (!productId) return;

    // Afficher loading
    showModal({
      title: "Chargement...",
      size: "xl",
      content: '<div class="text-center" style="padding:40px"><div class="spinner"></div></div>',
    });

    try {
      var res = await authFetch(apiUrl("/products/" + encodeURIComponent(productId)));
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        showToast(err.error || "Erreur chargement", "error");
        closeModal();
        return;
      }
      var data = await res.json();
      renderProductDetails(data);
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
      closeModal();
    }
  }

  function renderProductDetails(data) {
    var p = data.product;
    var variants = data.variantStats || [];
    var summary = data.summary || {};

    // Status badge
    var statusClass = p.stockStatus || "good";
    var statusLabel = p.stockLabel || "OK";
    var statusIcon = statusClass === "critical" ? "🔴" : statusClass === "low" ? "🟡" : "🟢";

    // Categories chips
    var categoriesHtml = "";
    if (p.categories && p.categories.length) {
      categoriesHtml = p.categories.map(function(c) {
        return '<span class="tag">' + esc(c.name) + '</span>';
      }).join(" ");
    } else {
      categoriesHtml = '<span class="text-secondary text-sm">Aucune categorie</span>';
    }

    // Variants table
    var variantsRows = variants.map(function(v, i) {
      var barWidth = Math.min(100, Math.max(5, v.shareByUnits || 0));
      return (
        '<tr>' +
        '<td class="cell-primary">' + v.gramsPerUnit + 'g</td>' +
        '<td class="cell-mono">' + (v.inventoryItemId || '-') + '</td>' +
        '<td style="font-weight:600">' + v.canSell + ' unites</td>' +
        '<td>' + formatWeight(v.gramsEquivalent) + '</td>' +
        '<td style="width:150px">' +
        '<div class="variant-bar-container">' +
        '<div class="variant-bar" style="width:' + barWidth + '%"></div>' +
        '<span class="variant-bar-label">' + v.shareByUnits.toFixed(1) + '%</span>' +
        '</div>' +
        '</td>' +
        '</tr>'
      );
    }).join("");

    // Chart data (simple bar chart via CSS)
    var chartBars = variants.map(function(v, i) {
      var maxCanSell = Math.max.apply(null, variants.map(function(x) { return x.canSell; })) || 1;
      var heightPercent = Math.round((v.canSell / maxCanSell) * 100);
      var colors = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
      var color = colors[i % colors.length];
      return (
        '<div class="chart-bar-wrapper">' +
        '<div class="chart-bar" style="height:' + heightPercent + '%;background:' + color + '"></div>' +
        '<div class="chart-bar-label">' + v.gramsPerUnit + 'g</div>' +
        '<div class="chart-bar-value">' + v.canSell + '</div>' +
        '</div>'
      );
    }).join("");

    var content = 
      // Header KPIs
      '<div class="product-detail-header">' +
      '<div class="product-detail-title">' +
      '<h2>' + esc(p.name) + '</h2>' +
      '<span class="stock-badge ' + statusClass + '">' + statusIcon + ' ' + statusLabel + '</span>' +
      '</div>' +
      '<div class="product-detail-categories">' + categoriesHtml + '</div>' +
      '</div>' +

      // Stats grid
      '<div class="product-detail-stats">' +
      '<div class="detail-stat"><div class="detail-stat-value">' + formatWeight(p.totalGrams) + '</div><div class="detail-stat-label">Stock total</div></div>' +
      '<div class="detail-stat"><div class="detail-stat-value">' + formatPricePerUnit(p.averageCostPerGram) + '</div><div class="detail-stat-label">Cout moyen (CMP)</div></div>' +
      '<div class="detail-stat"><div class="detail-stat-value">' + formatCurrency(p.stockValue) + '</div><div class="detail-stat-label">Valeur stock</div></div>' +
      '<div class="detail-stat"><div class="detail-stat-value">' + summary.variantCount + '</div><div class="detail-stat-label">Variantes</div></div>' +
      '</div>' +

      // Actions rapides
      '<div class="product-detail-actions">' +
      '<button class="btn btn-primary btn-sm" onclick="app.closeModal();app.showRestockModal(\'' + p.productId + '\')"><i data-lucide="package-plus"></i> Reappro</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="app.closeModal();app.showAdjustModal(\'' + p.productId + '\')"><i data-lucide="sliders"></i> Ajuster</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="app.showEditCMPModal(\'' + p.productId + '\',' + p.averageCostPerGram + ')"><i data-lucide="coins"></i> Modifier CMP</button>' +
      (hasFeature("hasBatchTracking") ? '<button class="btn btn-ghost btn-sm" onclick="app.closeModal();app.showAddBatchForProduct(\'' + p.productId + '\',\'' + esc(p.name).replace(/'/g, "\\'") + '\')"><i data-lucide="layers"></i> + Lot</button>' : '') +
      '</div>' +

      // Section Lots (si PRO)
      (hasFeature("hasBatchTracking") ? 
        '<div class="product-detail-section">' +
        '<h3 class="section-title"><i data-lucide="layers"></i> Lots actifs</h3>' +
        '<div id="productLotsContainer" data-product-id="' + p.productId + '"><div class="text-center py-md"><div class="spinner"></div></div></div>' +
        '</div>'
        : '') +

      // Graphique capacite de vente
      '<div class="product-detail-section">' +
      '<h3 class="section-title">📊 Capacite de vente par variante</h3>' +
      '<p class="text-secondary text-sm mb-md">Nombre d\'unites vendables si le stock etait vendu uniquement via cette variante</p>' +
      '<div class="chart-container">' +
      '<div class="simple-bar-chart">' + chartBars + '</div>' +
      '</div>' +
      '</div>' +

      // Tableau variantes
      '<div class="product-detail-section">' +
      '<h3 class="section-title">📦 Detail des variantes</h3>' +
      '<div class="table-container">' +
      '<table class="data-table data-table-compact">' +
      '<thead><tr><th>Grammage</th><th>Inventory ID</th><th>Unites dispo</th><th>Équivalent stock</th><th>Repartition</th></tr></thead>' +
      '<tbody>' + variantsRows + '</tbody>' +
      '</table>' +
      '</div>' +
      '</div>' +

      // Info pool global
      '<div class="product-detail-info">' +
      '<div class="info-icon">ℹ️</div>' +
      '<div class="info-text">' +
      '<strong>Mode Pool Global</strong><br>' +
      '<span class="text-secondary">Le stock est partage entre toutes les variantes. Les "unites dispo" representent la capacite maximale de vente pour chaque grammage.</span>' +
      '</div>' +
      '</div>';

    showModal({
      title: "Fiche produit",
      size: "xl",
      content: content,
      footer: '<button class="btn btn-ghost" onclick="app.closeModal()">Fermer</button>',
    });

    // Charger les lots du produit si PRO
    if (hasFeature("hasBatchTracking")) {
      loadProductLots(p.productId);
    }
    
    // Refresh icons
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  async function loadProductLots(productId) {
    var container = document.getElementById("productLotsContainer");
    if (!container) return;

    try {
      var res = await authFetch(apiUrl("/lots?productId=" + productId));
      if (!res.ok) throw new Error("Erreur");

      var data = await res.json();
      var lots = data.lots || [];

      if (lots.length === 0) {
        container.innerHTML = 
          '<div class="empty-state-inline">' +
          '<p class="text-secondary">' + t("batches.noLotsForProduct", "Aucun lot pour ce produit") + '</p>' +
          '<button class="btn btn-sm btn-primary mt-sm" onclick="app.closeModal();app.showAddBatchForProduct(\'' + productId + '\')">' +
          '<i data-lucide="plus"></i> ' + t("batches.createFirstLot", "Creer le premier lot") +
          '</button>' +
          '</div>';
        if (typeof lucide !== "undefined") lucide.createIcons();
        return;
      }

      // Afficher les lots
      var lotsHtml = '<div class="product-lots-list">';
      lots.forEach(function(lot) {
        var dlcBadge = getBatchDlcBadge(lot);
        var statusBadge = getBatchStatusBadge(lot);
        var progress = Math.round(((lot.currentGrams || 0) / (lot.initialGrams || 1)) * 100);

        lotsHtml += 
          '<div class="product-lot-item" onclick="app.closeModal();app.openBatchDetails(\'' + lot.productId + '\',\'' + lot.id + '\')">' +
          '<div class="lot-item-header">' +
          '<span class="batch-id">' + esc(lot.id) + '</span>' +
          statusBadge +
          '</div>' +
          '<div class="lot-item-body">' +
          '<div class="lot-item-stock">' +
          '<span class="lot-stock-value">' + formatWeight(lot.currentGrams) + '</span>' +
          '<span class="lot-stock-label">/ ' + formatWeight(lot.initialGrams) + '</span>' +
          '</div>' +
          '<div class="lot-item-progress"><div class="lot-progress-bar" style="width:' + progress + '%"></div></div>' +
          '<div class="lot-item-meta">' +
          '<span class="lot-dlc">' + (lot.expiryDate ? 'DLC: ' + lot.expiryDate : 'Sans DLC') + '</span>' +
          '<span class="lot-days">' + dlcBadge + '</span>' +
          '</div>' +
          '</div>' +
          '<div class="lot-item-value">' + formatCurrency(lot.valueRemaining || 0) + '</div>' +
          '</div>';
      });
      lotsHtml += '</div>';

      lotsHtml += '<button class="btn btn-sm btn-ghost mt-sm" onclick="app.closeModal();app.showAddBatchForProduct(\'' + productId + '\')">' +
        '<i data-lucide="plus"></i> ' + t("batches.addAnotherLot", "Ajouter un lot") +
        '</button>';

      container.innerHTML = lotsHtml;
      if (typeof lucide !== "undefined") lucide.createIcons();

    } catch (e) {
      container.innerHTML = '<p class="text-secondary text-sm">' + t("msg.error", "Erreur") + '</p>';
    }
  }

  function showAddBatchForProduct(productId, productName) {
    // Ouvrir le modal de création de lot avec le produit pré-sélectionné
    showModal({
      title: t("batches.addBatchFor", "Nouveau lot pour") + ' ' + (productName || 'ce produit'),
      size: "md",
      content:
        '<input type="hidden" id="batchProduct" value="' + esc(productId) + '">' +
        
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.quantity", "Quantite") + ' (' + getWeightUnit() + ') *</label>' +
        '<input type="number" class="form-input" id="batchGrams" placeholder="500" step="0.1" autofocus></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.costPerUnit", "Cout") + ' (' + getCurrencySymbol() + '/' + getWeightUnit() + ')</label>' +
        '<input type="number" class="form-input" id="batchCost" placeholder="4.50" step="0.01"></div>' +
        '</div>' +
        
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.expiryType", "Type date") + '</label>' +
        '<select class="form-select" id="batchExpiryType">' +
        '<option value="dlc">DLC (Date Limite Consommation)</option>' +
        '<option value="dluo">DLUO / DDM</option>' +
        '<option value="none">Aucune</option>' +
        '</select></div>' +
        '<div class="form-group" style="flex:1"><label class="form-label">' + t("batches.expiryDate", "Date limite") + '</label>' +
        '<input type="date" class="form-input" id="batchExpiryDate"></div>' +
        '</div>' +
        
        '<div class="form-group"><label class="form-label">' + t("batches.supplierRef", "Ref. fournisseur") + '</label>' +
        '<input type="text" class="form-input" id="batchSupplierRef" placeholder="LOT-FOURNISSEUR-001"></div>' +
        
        '<div class="form-group"><label class="form-label">' + t("batches.notes", "Notes") + '</label>' +
        '<textarea class="form-input" id="batchNotes" rows="2" placeholder="Notes optionnelles..."></textarea></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
        '<button class="btn btn-primary" onclick="app.saveBatch()">' + t("action.save", "Enregistrer") + '</button>'
    });
  }

  function showEditCMPModal(productId, currentCMP) {
    closeModal();
    showModal({
      title: "Modifier le cout moyen (CMP)",
      content:
        '<p class="text-secondary mb-md">Le CMP actuel est de <strong>' + formatPricePerUnit(currentCMP) + '</strong>.</p>' +
        '<div class="form-group"><label class="form-label">Nouveau CMP (" + getCurrencySymbol() + "/" + getWeightUnit() + ")</label>' +
        '<input type="number" class="form-input" id="newCMP" value="' + currentCMP + '" step="0.01" min="0"></div>' +
        '<p class="form-hint">⚠️ La modification manuelle du CMP ecrase le calcul automatique.</p>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button>' +
        '<button class="btn btn-primary" onclick="app.saveCMP(\'' + productId + '\')">Enregistrer</button>',
    });
  }

  async function saveCMP(productId) {
    var input = document.getElementById("newCMP");
    var newCMP = parseFloat(input ? input.value : 0);
    if (!Number.isFinite(newCMP) || newCMP < 0) {
      showToast("Valeur invalide", "error");
      return;
    }
    try {
      var res = await authFetch(apiUrl("/products/" + encodeURIComponent(productId) + "/average-cost"), {
        method: "PATCH",
        body: JSON.stringify({ averageCostPerGram: newCMP }),
      });
      if (res.ok) {
        showToast("CMP mis a jour", "success");
        closeModal();
        await loadProducts();
        renderTab(state.currentTab);
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  // ============================================
  // ANALYTICS PRO
  // ============================================
  var analyticsData = null;
  var analyticsPeriod = "30";

  function renderAnalytics(c) {
    if (!hasFeature("hasAnalytics")) {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title"><i data-lucide="bar-chart-3"></i> Analytics</h1></div>' +
        '<div class="card" style="min-height:400px;display:flex;align-items:center;justify-content:center"><div class="text-center">' +
        '<div class="lock-icon"><i data-lucide="lock"></i></div><h2>' + t("msg.featureLocked", "Fonctionnalite PRO") + '</h2>' +
        '<p class="text-secondary">Debloquez les marges, profits et analyses avancees avec le plan PRO</p>' +
        '<div class="analytics-preview">' +
        '<div class="preview-kpi blurred"><span class="preview-value">12 450 EUR</span><span class="preview-label">CA total</span></div>' +
        '<div class="preview-kpi blurred"><span class="preview-value">4 230 EUR</span><span class="preview-label">Marge brute</span></div>' +
        '<div class="preview-kpi blurred"><span class="preview-value">34%</span><span class="preview-label">Marge %</span></div>' +
        '</div>' +
        '<button class="btn btn-upgrade mt-lg" onclick="app.showUpgradeModal()">Passer a PRO</button></div></div>';
      return;
    }

    // Afficher loading puis charger les donnees
    c.innerHTML =
      '<div class="page-header"><div><h1 class="page-title"><i data-lucide="bar-chart-3"></i> Analytics PRO</h1><p class="page-subtitle">Ventes, marges et performance</p></div>' +
      '<div class="page-actions">' +
      '<select class="form-select" id="analyticsPeriod" onchange="app.changeAnalyticsPeriod(this.value)">' +
      '<option value="7"' + (analyticsPeriod === "7" ? " selected" : "") + '>7 derniers jours</option>' +
      '<option value="30"' + (analyticsPeriod === "30" ? " selected" : "") + '>30 derniers jours</option>' +
      '<option value="90"' + (analyticsPeriod === "90" ? " selected" : "") + '>90 derniers jours</option>' +
      '</select>' +
      '<div class="analytics-tabs">' +
      '<button class="tab-btn active" data-tab="sales" onclick="app.switchAnalyticsTab(\'sales\')">Ventes</button>' +
      '<button class="tab-btn" data-tab="stock" onclick="app.switchAnalyticsTab(\'stock\')">Stock</button>' +
      '</div>' +
      '</div></div>' +
      '<div id="analyticsContent"><div class="text-center" style="padding:60px"><div class="spinner"></div><p class="text-secondary mt-md">Chargement des analytics...</p></div></div>';

    analyticsTab = "sales";
    loadAnalyticsSales();
  }

  var analyticsTab = "sales";
  var analyticsSalesData = null;

  function switchAnalyticsTab(tab) {
    analyticsTab = tab;
    document.querySelectorAll(".analytics-tabs .tab-btn").forEach(function(btn) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    
    if (tab === "sales") {
      if (analyticsSalesData) {
        renderSalesAnalytics();
      } else {
        loadAnalyticsSales();
      }
    } else {
      if (analyticsData) {
        renderAnalyticsContent();
      } else {
        loadAnalytics();
      }
    }
  }

  async function loadAnalyticsSales() {
    try {
      document.getElementById("analyticsContent").innerHTML = 
        '<div class="text-center" style="padding:60px"><div class="spinner"></div><p class="text-secondary mt-md">Chargement des ventes...</p></div>';
      
      var res = await authFetch(apiUrl("/analytics/sales?period=" + analyticsPeriod));
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        if (err.error === "plan_limit") {
          showUpgradeModal();
          return;
        }
        document.getElementById("analyticsContent").innerHTML = 
          '<div class="card"><div class="card-body text-center"><p class="text-danger">Erreur: ' + (err.error || err.message || "Impossible de charger") + '</p></div></div>';
        return;
      }
      analyticsSalesData = await res.json();
      renderSalesAnalytics();
    } catch (e) {
      document.getElementById("analyticsContent").innerHTML = 
        '<div class="card"><div class="card-body text-center"><p class="text-danger">Erreur: ' + e.message + '</p></div></div>';
    }
  }

  function renderSalesAnalytics() {
    if (!analyticsSalesData) return;
    var d = analyticsSalesData;
    var k = d.kpis || {};

    // KPI Cards - Ventes & Marges
    var marginClass = k.marginPercent >= 30 ? "success" : k.marginPercent >= 15 ? "warning" : "danger";
    
    var kpiCards = 
      '<div class="analytics-kpis analytics-kpis-sales">' +
      '<div class="kpi-card kpi-large"><div class="kpi-icon"><i data-lucide="trending-up"></i></div><div class="kpi-value">' + formatCurrency(k.totalRevenue || 0) + '</div><div class="kpi-label">Chiffre d\'affaires</div><div class="kpi-sub">' + (k.totalOrders || 0) + ' commandes</div></div>' +
      '<div class="kpi-card kpi-large"><div class="kpi-icon"><i data-lucide="piggy-bank"></i></div><div class="kpi-value">' + formatCurrency(k.totalMargin || 0) + '</div><div class="kpi-label">Marge brute</div><div class="kpi-sub ' + marginClass + '">' + (k.marginPercent || 0) + '% de marge</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + formatCurrency(k.totalCost || 0) + '</div><div class="kpi-label">Cout des ventes</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + formatWeight(k.totalGramsSold || 0) + '</div><div class="kpi-label">Quantite vendue</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + formatCurrency(k.avgOrderValue || 0) + '</div><div class="kpi-label">Panier moyen</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + formatPricePerUnit(k.avgSellingPrice || 0) + '</div><div class="kpi-label">Prix vente moy.</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + formatPricePerUnit(k.avgCMP || 0) + '</div><div class="kpi-label">CMP moyen</div></div>' +
      '</div>';

    // Top produits par CA
    var tops = d.topProducts || {};
    var topRevenueHtml = '<div class="top-list"><h4><i data-lucide="trophy"></i> Top CA</h4>';
    (tops.byRevenue || []).forEach(function(p, i) {
      topRevenueHtml += '<div class="top-item"><span class="top-rank">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value">' + formatCurrency(p.revenue) + '</span></div>';
    });
    if (!(tops.byRevenue || []).length) topRevenueHtml += '<p class="text-secondary text-sm">Aucune vente</p>';
    topRevenueHtml += '</div>';

    // Top produits par marge
    var topMarginHtml = '<div class="top-list"><h4><i data-lucide="piggy-bank"></i> Top Marge EUR</h4>';
    (tops.byMargin || []).forEach(function(p, i) {
      topMarginHtml += '<div class="top-item"><span class="top-rank success">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value success">' + formatCurrency(p.margin) + '</span></div>';
    });
    if (!(tops.byMargin || []).length) topMarginHtml += '<p class="text-secondary text-sm">Aucune vente</p>';
    topMarginHtml += '</div>';

    // Top produits par marge %
    var topMarginPctHtml = '<div class="top-list"><h4><i data-lucide="percent"></i> Top Marge %</h4>';
    (tops.byMarginPercent || []).forEach(function(p, i) {
      topMarginPctHtml += '<div class="top-item"><span class="top-rank success">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value success">' + p.marginPercent + '%</span></div>';
    });
    if (!(tops.byMarginPercent || []).length) topMarginPctHtml += '<p class="text-secondary text-sm">Pas assez de donnees</p>';
    topMarginPctHtml += '</div>';

    // Top produits par volume
    var topVolumeHtml = '<div class="top-list"><h4><i data-lucide="scale"></i> Top Volume</h4>';
    (tops.byVolume || []).forEach(function(p, i) {
      topVolumeHtml += '<div class="top-item"><span class="top-rank">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value">' + formatWeight(p.gramsSold) + '</span></div>';
    });
    if (!(tops.byVolume || []).length) topVolumeHtml += '<p class="text-secondary text-sm">Aucune vente</p>';
    topVolumeHtml += '</div>';

    // Pires marges
    var worstMarginHtml = '<div class="top-list"><h4><i data-lucide="alert-triangle"></i> A optimiser (marge faible)</h4>';
    (tops.worstMargin || []).forEach(function(p, i) {
      var badgeClass = p.marginPercent < 10 ? "danger" : "warning";
      worstMarginHtml += '<div class="top-item"><span class="top-rank ' + badgeClass + '">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value ' + badgeClass + '">' + p.marginPercent + '%</span></div>';
    });
    if (!(tops.worstMargin || []).length) worstMarginHtml += '<p class="text-secondary text-sm">Tous vos produits ont une bonne marge!</p>';
    worstMarginHtml += '</div>';

    var topsSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'topsales\')">' +
      '<h3>Performance produits</h3><span class="section-toggle" id="toggle-topsales">-</span></div>' +
      '<div class="section-content" id="section-topsales">' +
      '<div class="tops-grid tops-grid-5">' + topRevenueHtml + topMarginHtml + topMarginPctHtml + topVolumeHtml + worstMarginHtml + '</div>' +
      '</div></div>';

    // Tableau des produits vendus
    var productsHtml = '';
    var products = d.products || [];
    if (products.length > 0) {
      productsHtml = '<table class="data-table"><thead><tr>' +
        '<th>Produit</th><th>Qte vendue</th><th>CA</th><th>Cout</th><th>Marge</th><th>Marge %</th><th>Action</th>' +
        '</tr></thead><tbody>';
      products.slice(0, 20).forEach(function(p) {
        var marginClass = p.marginPercent >= 30 ? "success" : p.marginPercent >= 15 ? "" : "danger";
        productsHtml += '<tr>' +
          '<td>' + esc(p.name) + '</td>' +
          '<td>' + formatWeight(p.gramsSold) + '</td>' +
          '<td>' + formatCurrency(p.revenue) + '</td>' +
          '<td>' + formatCurrency(p.cost) + '</td>' +
          '<td class="' + marginClass + '">' + formatCurrency(p.margin) + '</td>' +
          '<td class="' + marginClass + '">' + p.marginPercent + '%</td>' +
          '<td>' + (p.marginPercent < 15 ? '<button class="btn btn-ghost btn-xs" onclick="app.showToast(\'Augmentez le prix ou reduisez le CMP\',\'info\')">Optimiser</button>' : '') + '</td>' +
          '</tr>';
      });
      productsHtml += '</tbody></table>';
      if (products.length > 20) {
        productsHtml += '<p class="text-secondary text-sm mt-sm">' + (products.length - 20) + ' autres produits...</p>';
      }
    } else {
      productsHtml = '<div class="empty-state-small"><p class="text-secondary">Aucune vente sur cette periode</p></div>';
    }

    var productsSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'soldproducts\')">' +
      '<h3>Detail des ventes par produit</h3><span class="section-toggle" id="toggle-soldproducts">-</span></div>' +
      '<div class="section-content" id="section-soldproducts">' + productsHtml + '</div></div>';

    // Assembler
    document.getElementById("analyticsContent").innerHTML = kpiCards + topsSection + productsSection;
    
    // Refresh Lucide icons
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  async function loadAnalytics() {
    try {
      var res = await authFetch(apiUrl("/analytics/dashboard?period=" + analyticsPeriod));
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        if (err.error === "plan_limit") {
          showUpgradeModal();
          return;
        }
        document.getElementById("analyticsContent").innerHTML = 
          '<div class="card"><div class="card-body text-center"><p class="text-danger">Erreur: ' + (err.error || "Impossible de charger") + '</p></div></div>';
        return;
      }
      analyticsData = await res.json();
      renderAnalyticsContent();
    } catch (e) {
      document.getElementById("analyticsContent").innerHTML = 
        '<div class="card"><div class="card-body text-center"><p class="text-danger">Erreur: ' + e.message + '</p></div></div>';
    }
  }

  function changeAnalyticsPeriod(period) {
    analyticsPeriod = period;
    loadAnalytics();
  }

  function renderAnalyticsContent() {
    if (!analyticsData) return;
    var d = analyticsData;
    var k = d.kpis || {};
    var h = d.stockHealth || {};

    // KPI Cards
    var kpiCards = 
      '<div class="analytics-kpis">' +
      '<div class="kpi-card"><div class="kpi-value">' + formatCurrency(k.totalStockValue || 0) + '</div><div class="kpi-label">Valeur stock</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + formatCurrency((h.vendable || {}).value || 0) + '</div><div class="kpi-label">Stock vendable</div><div class="kpi-sub success">' + ((h.vendable || {}).percent || 0) + '%</div></div>' +
      '<div class="kpi-card' + (k.alertsCount > 0 ? ' kpi-warning' : '') + '"><div class="kpi-value">' + (k.alertsCount || 0) + '</div><div class="kpi-label">Alertes</div></div>' +
      '<div class="kpi-card"><div class="kpi-value">' + (k.avgRotationDays ? k.avgRotationDays + 'j' : '--') + '</div><div class="kpi-label">Rotation moy.</div></div>' +
      '</div>';

    // Score de sante
    var scoreClass = k.healthScore >= 70 ? 'success' : k.healthScore >= 40 ? 'warning' : 'danger';
    var healthSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'health\')">' +
      '<h3>Sante du stock</h3><span class="section-toggle" id="toggle-health">-</span></div>' +
      '<div class="section-content" id="section-health">' +
      '<div class="health-score-container">' +
      '<div class="health-score ' + scoreClass + '">' + (k.healthScore || 0) + '</div>' +
      '<div class="health-score-label">Score de sante</div>' +
      '</div>' +
      '<div class="health-bars">' +
      '<div class="health-bar-item"><div class="health-bar-label">Vendable (&lt;30j)</div><div class="health-bar-track"><div class="health-bar-fill success" style="width:' + ((h.vendable || {}).percent || 0) + '%"></div></div><div class="health-bar-value">' + formatCurrency((h.vendable || {}).value || 0) + ' (' + ((h.vendable || {}).percent || 0) + '%)</div></div>' +
      '<div class="health-bar-item"><div class="health-bar-label">Lent (30-60j)</div><div class="health-bar-track"><div class="health-bar-fill warning" style="width:' + ((h.lent || {}).percent || 0) + '%"></div></div><div class="health-bar-value">' + formatCurrency((h.lent || {}).value || 0) + ' (' + ((h.lent || {}).percent || 0) + '%)</div></div>' +
      '<div class="health-bar-item"><div class="health-bar-label">Dormant (&gt;60j)</div><div class="health-bar-track"><div class="health-bar-fill danger" style="width:' + ((h.dormant || {}).percent || 0) + '%"></div></div><div class="health-bar-value">' + formatCurrency((h.dormant || {}).value || 0) + ' (' + ((h.dormant || {}).percent || 0) + '%)</div></div>' +
      '</div>' +
      '</div></div>';

    // Alertes
    var alerts = d.alerts || {};
    var alertsHtml = '';
    
    if ((alerts.rupture || []).length > 0) {
      alertsHtml += '<div class="alert-group alert-danger"><div class="alert-title">Rupture de stock (' + alerts.rupture.length + ')</div>';
      alerts.rupture.forEach(function(a) {
        alertsHtml += '<div class="alert-item"><span class="alert-product">' + esc(a.name) + '</span><span class="alert-action">Reapprovisionner</span></div>';
      });
      alertsHtml += '</div>';
    }
    
    if ((alerts.lowStock || []).length > 0) {
      alertsHtml += '<div class="alert-group alert-warning"><div class="alert-title">Stock critique (' + alerts.lowStock.length + ')</div>';
      alerts.lowStock.forEach(function(a) {
        alertsHtml += '<div class="alert-item"><span class="alert-product">' + esc(a.name) + '</span><span class="alert-days">' + (a.daysLeft || '?') + 'j restants</span><span class="alert-action">Commander</span></div>';
      });
      alertsHtml += '</div>';
    }
    
    if ((alerts.dormant || []).length > 0) {
      alertsHtml += '<div class="alert-group alert-info"><div class="alert-title">Stock dormant (' + alerts.dormant.length + ')</div>';
      alerts.dormant.slice(0, 5).forEach(function(a) {
        alertsHtml += '<div class="alert-item"><span class="alert-product">' + esc(a.name) + '</span><span class="alert-value">' + formatCurrency(a.value) + ' immobilises</span><span class="alert-action">Promo?</span></div>';
      });
      alertsHtml += '</div>';
    }

    if (!alertsHtml) {
      alertsHtml = '<div class="empty-state-small"><p class="text-secondary">Aucune alerte</p></div>';
    }

    var alertsSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'alerts\')">' +
      '<h3>Alertes & Actions</h3><span class="section-toggle" id="toggle-alerts">-</span></div>' +
      '<div class="section-content" id="section-alerts">' + alertsHtml + '</div></div>';

    // Top produits
    var tops = d.topProducts || {};
    var topsHtml = '<div class="tops-grid">';
    
    // Top vendus
    topsHtml += '<div class="top-list"><h4>Plus vendus</h4>';
    if ((tops.vendus || []).length > 0) {
      tops.vendus.forEach(function(p, i) {
        topsHtml += '<div class="top-item"><span class="top-rank">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value">' + formatWeight(p.totalSoldGrams) + '</span></div>';
      });
    } else {
      topsHtml += '<p class="text-secondary text-sm">Pas de donnees</p>';
    }
    topsHtml += '</div>';

    // Top valeur
    topsHtml += '<div class="top-list"><h4>Plus haute valeur</h4>';
    if ((tops.valeur || []).length > 0) {
      tops.valeur.forEach(function(p, i) {
        topsHtml += '<div class="top-item"><span class="top-rank">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value">' + formatCurrency(p.value) + '</span></div>';
      });
    } else {
      topsHtml += '<p class="text-secondary text-sm">Pas de donnees</p>';
    }
    topsHtml += '</div>';

    // Plus lents
    topsHtml += '<div class="top-list"><h4>Rotation lente</h4>';
    if ((tops.lents || []).length > 0) {
      tops.lents.forEach(function(p, i) {
        topsHtml += '<div class="top-item"><span class="top-rank danger">' + (i + 1) + '</span><span class="top-name">' + esc(p.name) + '</span><span class="top-value">' + (p.rotationDays ? p.rotationDays + 'j' : 'Dormant') + '</span></div>';
      });
    } else {
      topsHtml += '<p class="text-secondary text-sm">Pas de donnees</p>';
    }
    topsHtml += '</div></div>';

    var topsSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'tops\')">' +
      '<h3>Top Produits</h3><span class="section-toggle" id="toggle-tops">-</span></div>' +
      '<div class="section-content" id="section-tops">' + topsHtml + '</div></div>';

    // Par categorie
    var cats = d.categories || [];
    var catsHtml = '';
    if (cats.length > 0) {
      catsHtml = '<table class="data-table data-table-compact"><thead><tr><th>Categorie</th><th>Produits</th><th>Stock</th><th>Valeur</th><th>Rotation</th><th>Sante</th></tr></thead><tbody>';
      cats.forEach(function(cat) {
        var healthBadge = cat.health === 'good' ? '<span class="badge badge-success">OK</span>' : 
                          cat.health === 'slow' ? '<span class="badge badge-warning">Lent</span>' : 
                          cat.health === 'dormant' ? '<span class="badge badge-danger">Dormant</span>' : 
                          '<span class="badge badge-secondary">--</span>';
        catsHtml += '<tr><td>' + esc(cat.name) + '</td><td>' + cat.productCount + '</td><td>' + formatWeight(cat.stockGrams) + '</td><td>' + formatCurrency(cat.stockValue) + '</td><td>' + (cat.avgRotationDays ? cat.avgRotationDays + 'j' : '--') + '</td><td>' + healthBadge + '</td></tr>';
      });
      catsHtml += '</tbody></table>';
    } else {
      catsHtml = '<div class="empty-state-small"><p class="text-secondary">Creez des categories pour voir cette analyse</p></div>';
    }

    var catsSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'categories\')">' +
      '<h3>Par Categorie</h3><span class="section-toggle" id="toggle-categories">-</span></div>' +
      '<div class="section-content" id="section-categories">' + catsHtml + '</div></div>';

    // Par format
    var formats = d.formats || [];
    var formatsHtml = '';
    if (formats.length > 0) {
      formatsHtml = '<div class="formats-grid">';
      formats.forEach(function(f) {
        var recClass = f.percentStock > 40 ? 'success' : f.percentStock > 20 ? 'warning' : 'secondary';
        formatsHtml += '<div class="format-card"><div class="format-label">' + f.label + '</div><div class="format-percent">' + f.percentStock + '%</div><div class="format-value">' + formatCurrency(f.stockValue) + '</div><div class="format-bar"><div class="format-bar-fill ' + recClass + '" style="width:' + f.percentStock + '%"></div></div></div>';
      });
      formatsHtml += '</div>';
    } else {
      formatsHtml = '<div class="empty-state-small"><p class="text-secondary">Pas de donnees de format</p></div>';
    }

    var formatsSection = 
      '<div class="analytics-section">' +
      '<div class="section-header" onclick="app.toggleSection(\'formats\')">' +
      '<h3>Par Format</h3><span class="section-toggle" id="toggle-formats">-</span></div>' +
      '<div class="section-content" id="section-formats">' + formatsHtml + '</div></div>';

    // Assembler
    document.getElementById("analyticsContent").innerHTML = 
      kpiCards + healthSection + alertsSection + topsSection + catsSection + formatsSection;
  }

  function toggleSection(sectionId) {
    var content = document.getElementById("section-" + sectionId);
    var toggle = document.getElementById("toggle-" + sectionId);
    if (content && toggle) {
      var isHidden = content.style.display === "none";
      content.style.display = isHidden ? "block" : "none";
      toggle.textContent = isHidden ? "-" : "+";
    }
  }

  // ============================================
  // FILTRES ET TRI
  // ============================================
  var searchTimeout = null;
  
  function onSearchChange(event) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function() {
      state.filters.search = event.target.value;
      applyFilters();
    }, 300);
  }
  
  function onCategoryChange(value) {
    state.filters.category = value;
    applyFilters();
  }
  
  function onSortChange(value) {
    state.filters.sort = value;
    applyFilters();
  }

  // ============================================
  // GESTION CATEGORIES
  // ============================================
  function showCategoriesModal() {
    var categoriesList = "";
    if (state.categories.length === 0) {
      categoriesList = '<div class="empty-state-small"><p class="text-secondary">Aucune categorie</p></div>';
    } else {
      categoriesList = '<div class="categories-list">' + state.categories.map(function(cat) {
        var count = cat.productCount || 0;
        return '<div class="category-item">' +
          '<div class="category-item-info">' +
          '<span class="category-item-name">' + esc(cat.name) + '</span>' +
          '<span class="category-item-count">' + count + ' produit(s)</span>' +
          '</div>' +
          '<div class="category-item-actions">' +
          '<button class="btn btn-ghost btn-xs" onclick="app.showRenameCategoryModal(\'' + esc(cat.id) + '\',\'' + esc(cat.name) + '\')">Renommer</button>' +
          '<button class="btn btn-ghost btn-xs text-danger" onclick="app.deleteCategory(\'' + esc(cat.id) + '\')">Supprimer</button>' +
          '</div>' +
          '</div>';
      }).join("") + '</div>';
    }

    showModal({
      title: "Gerer les categories",
      content:
        '<div class="form-group">' +
        '<div style="display:flex;gap:8px">' +
        '<input type="text" class="form-input" id="newCatName" placeholder="Nouvelle categorie...">' +
        '<button class="btn btn-primary" onclick="app.createCategory()">Ajouter</button>' +
        '</div>' +
        '</div>' +
        '<div class="categories-container">' + categoriesList + '</div>',
      footer: '<button class="btn btn-ghost" onclick="app.closeModal()">Fermer</button>',
    });
  }

  async function createCategory() {
    var input = document.getElementById("newCatName");
    var name = input ? input.value.trim() : "";
    if (!name) {
      showToast("Nom requis", "error");
      return;
    }
    try {
      var res = await authFetch(apiUrl("/categories"), {
        method: "POST",
        body: JSON.stringify({ name: name }),
      });
      if (res.ok) {
        showToast("Categorie creee", "success");
        await loadProducts(true);
        showCategoriesModal(); // Refresh modal
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  function showRenameCategoryModal(catId, currentName) {
    closeModal();
    showModal({
      title: "Renommer la categorie",
      content:
        '<div class="form-group"><label class="form-label">Nouveau nom</label>' +
        '<input type="text" class="form-input" id="renameCatInput" value="' + esc(currentName) + '"></div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.showCategoriesModal()">Annuler</button>' +
        '<button class="btn btn-primary" onclick="app.renameCategory(\'' + esc(catId) + '\')">Enregistrer</button>',
    });
  }

  async function renameCategory(catId) {
    var input = document.getElementById("renameCatInput");
    var name = input ? input.value.trim() : "";
    if (!name) {
      showToast("Nom requis", "error");
      return;
    }
    try {
      var res = await authFetch(apiUrl("/categories/" + encodeURIComponent(catId)), {
        method: "PUT",
        body: JSON.stringify({ name: name }),
      });
      if (res.ok) {
        showToast("Categorie renommee", "success");
        await loadProducts(true);
        showCategoriesModal();
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  async function deleteCategory(catId) {
    if (!confirm("Supprimer cette categorie ?")) return;
    try {
      var res = await authFetch(apiUrl("/categories/" + encodeURIComponent(catId)), {
        method: "DELETE",
      });
      if (res.ok) {
        showToast("Categorie supprimee", "success");
        await loadProducts(true);
        showCategoriesModal();
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  // ============================================
  // ASSIGNER CATEGORIES A UN PRODUIT
  // ============================================
  function showAssignCategoriesModal(productId) {
    var product = state.products.find(function(p) { return p.productId === productId; });
    if (!product) return;

    var currentCatIds = Array.isArray(product.categoryIds) ? product.categoryIds : [];

    var checkboxes = "";
    if (state.categories.length === 0) {
      checkboxes = '<p class="text-secondary">Aucune categorie. <a href="#" onclick="app.closeModal();app.showCategoriesModal();return false;">Creer une categorie</a></p>';
    } else {
      checkboxes = state.categories.map(function(cat) {
        var checked = currentCatIds.includes(cat.id) ? " checked" : "";
        return '<label class="checkbox-item">' +
          '<input type="checkbox" class="cat-checkbox" value="' + esc(cat.id) + '"' + checked + '>' +
          '<span>' + esc(cat.name) + '</span>' +
          '</label>';
      }).join("");
    }

    showModal({
      title: "Categories pour " + esc(product.name || "Produit"),
      content:
        '<div class="categories-checkboxes">' + checkboxes + '</div>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button>' +
        '<button class="btn btn-primary" onclick="app.saveProductCategories(\'' + esc(productId) + '\')">Enregistrer</button>',
    });
  }

  async function saveProductCategories(productId) {
    var checkboxes = document.querySelectorAll(".cat-checkbox:checked");
    var categoryIds = [];
    checkboxes.forEach(function(cb) { categoryIds.push(cb.value); });

    try {
      var res = await authFetch(apiUrl("/products/" + encodeURIComponent(productId) + "/categories"), {
        method: "POST",
        body: JSON.stringify({ categoryIds: categoryIds }),
      });
      if (res.ok) {
        showToast("Categories mises a jour", "success");
        closeModal();
        await loadProducts(true);
        renderTab(state.currentTab);
      } else {
        var e = await res.json();
        showToast(e.error || "Erreur", "error");
      }
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  window.app = {
    init: init,
    navigateTo: navigateTo,
    toggleSidebar: toggleSidebar,
    toggleNotifications: toggleNotifications,
    toggleUserMenu: toggleUserMenu,
    showModal: showModal,
    closeModal: closeModal,
    showAddProductModal: showAddProductModal,
    showImportModal: showImportModal,
    doImport: doImport,
    showRestockModal: showRestockModal,
    showAdjustModal: showAdjustModal,
    showUpgradeModal: showUpgradeModal,
    showLockedModal: showLockedModal,
    saveProduct: saveProduct,
    saveRestock: saveRestock,
    saveAdjust: saveAdjust,
    syncShopify: syncShopify,
    upgradeTo: upgradeTo,
    showToast: showToast,
    hasFeature: hasFeature,
    openProductDetails: openProductDetails,
    showEditCMPModal: showEditCMPModal,
    saveCMP: saveCMP,
    // Filtres
    onSearchChange: onSearchChange,
    onCategoryChange: onCategoryChange,
    onSortChange: onSortChange,
    // Categories
    showCategoriesModal: showCategoriesModal,
    createCategory: createCategory,
    showRenameCategoryModal: showRenameCategoryModal,
    renameCategory: renameCategory,
    deleteCategory: deleteCategory,
    showAssignCategoriesModal: showAssignCategoriesModal,
    saveProductCategories: saveProductCategories,
    // Analytics
    changeAnalyticsPeriod: changeAnalyticsPeriod,
    toggleSection: toggleSection,
    switchAnalyticsTab: switchAnalyticsTab,
    // Batches / Lots
    onBatchProductChange: onBatchProductChange,
    onBatchStatusChange: onBatchStatusChange,
    onBatchExpiringChange: onBatchExpiringChange,
    showAddBatchModal: showAddBatchModal,
    showAddBatchForProduct: showAddBatchForProduct,
    saveBatch: saveBatch,
    showAdjustBatchModal: showAdjustBatchModal,
    saveAdjustBatch: saveAdjustBatch,
    openBatchDetails: openBatchDetails,
    deactivateBatch: deactivateBatch,
    markExpiredBatches: markExpiredBatches,
    // Suppliers
    onSupplierSearchChange: onSupplierSearchChange,
    onSupplierStatusChange: onSupplierStatusChange,
    showAddSupplierModal: showAddSupplierModal,
    saveSupplier: saveSupplier,
    openSupplierDetails: openSupplierDetails,
    switchSupplierTab: switchSupplierTab,
    showEditSupplierModal: showEditSupplierModal,
    updateSupplier: updateSupplier,
    deleteSupplier: deleteSupplier,
    // Settings
    updateSetting: updateSetting,
    updateNestedSetting: updateNestedSetting,
    exportSettings: exportSettings,
    resetAllSettings: resetAllSettings,
    get state() {
      return state;
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
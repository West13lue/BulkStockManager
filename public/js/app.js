// app.js - Stock Manager Pro (FIXED v3)
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

  // ✅ IMPORTANT: authFetch DOIT être correctement fermée, sinon tout le reste du fichier casse.
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

    // retry 401 une fois
    if (res.status === 401 && token) {
      clearSessionToken();
      var t2 = await getSessionToken();
      if (t2) headers["Authorization"] = "Bearer " + t2;
      res = await doFetch();
    }

    // 🔐 OAuth AUTO si token manquant / révoqué
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
  } // ✅ FIN authFetch

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

  function apiUrl(endpoint) {
    if (!CURRENT_SHOP) return null;
    return API_BASE + endpoint + (endpoint.includes("?") ? "&" : "?") + "shop=" + encodeURIComponent(CURRENT_SHOP);
  }

  var PLAN_HIERARCHY = ["free", "starter", "pro", "business", "enterprise"];

  var state = {
    currentTab: "dashboard",
    planId: "free",
    planName: "Free",
    limits: {},
    products: [],
    shop: CURRENT_SHOP,
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
        console.warn("[OAuth] Aucun session token → redirection");
        var shop = CURRENT_SHOP;
        if (!shop) throw new Error("Shop manquant");
        var url = "/api/auth/start?shop=" + encodeURIComponent(shop);
        if (window.top) window.top.location.href = url;
        else window.location.href = url;
        return false;
      }
      return true;
    } catch (e) {
      console.warn("[OAuth] Erreur session → redirection", e);
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

    // 1) Si on est hors iframe, on force OAuth
    if (window.top === window.self) {
      if (CURRENT_SHOP) {
        window.location.href = "/api/auth/start?shop=" + encodeURIComponent(CURRENT_SHOP);
        return;
      }
      document.body.innerHTML =
        '<div style="padding:40px"><h2>Application Shopify</h2><p>Paramètre shop manquant.</p></div>';
      return;
    }

    // 2) embedded mais host manquant → OAuth
    if (!host && CURRENT_SHOP) {
      window.top.location.href = "/api/auth/start?shop=" + encodeURIComponent(CURRENT_SHOP);
      return;
    }

    // 3) shop manquant
    if (!CURRENT_SHOP) {
      document.body.innerHTML =
        '<div style="padding:40px"><h2>Application Shopify</h2><p>Paramètre shop manquant.</p></div>';
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
    await loadProducts();
    renderTab("dashboard");
    updateUI();
    console.log("[Init] Ready - Plan:", state.planId, "Features:", state.limits);
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
    renderTab(tab);
  }

  function toggleSidebar() {
    var sb = document.getElementById("sidebar");
    if (sb) sb.classList.toggle("collapsed");
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
        renderFeature(c, "hasBatchTracking", "Lots & DLC", "📦");
        break;
      case "suppliers":
        renderFeature(c, "hasSuppliers", "Fournisseurs", "🏭");
        break;
      case "orders":
        renderFeature(c, "hasPurchaseOrders", "Commandes", "📝");
        break;
      case "forecast":
        renderFeature(c, "hasForecast", "Previsions", "🔮");
        break;
      case "kits":
        renderFeature(c, "hasKits", "Kits", "🧩");
        break;
      case "analytics":
        renderFeature(c, "hasAnalytics", "Analytics", "📈");
        break;
      case "inventory":
        renderFeature(c, "hasInventoryCount", "Inventaire", "📋");
        break;
      case "settings":
        renderSettings(c);
        break;
      default:
        renderDashboard(c);
    }
  }

  function renderFeature(c, key, title, icon) {
    if (!hasFeature(key)) {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title">' +
        icon +
        " " +
        title +
        "</h1></div>" +
        '<div class="card" style="min-height:400px;display:flex;align-items:center;justify-content:center"><div class="text-center">' +
        '<div style="font-size:64px">🔒</div><h2>Fonctionnalite verrouillee</h2>' +
        '<p class="text-secondary">Passez a un plan superieur pour debloquer.</p>' +
        '<button class="btn btn-upgrade mt-lg" onclick="app.showUpgradeModal()">Upgrader</button></div></div>';
    } else {
      c.innerHTML =
        '<div class="page-header"><h1 class="page-title">' +
        icon +
        " " +
        title +
        "</h1></div>" +
        '<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">' +
        icon +
        "</div>" +
        "<p>Aucun element</p></div></div></div>";
    }
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
      '<div class="page-header"><div><h1 class="page-title">Tableau de bord</h1><p class="page-subtitle">Vue d\'ensemble</p></div>' +
      '<div class="page-actions"><button class="btn btn-secondary" onclick="app.syncShopify()">Sync</button>' +
      '<button class="btn btn-primary" onclick="app.showAddProductModal()">+ Produit</button></div></div>' +
      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-icon">📦</div><div class="stat-value">' +
      state.products.length +
      '</div><div class="stat-label">Produits</div></div>' +
      '<div class="stat-card"><div class="stat-icon">⚖️</div><div class="stat-value">' +
      formatWeight(totalStock) +
      '</div><div class="stat-label">Stock total</div></div>' +
      '<div class="stat-card"><div class="stat-icon">💰</div><div class="stat-value">' +
      formatCurrency(totalValue) +
      '</div><div class="stat-label">Valeur</div></div>' +
      '<div class="stat-card"><div class="stat-icon">⚠️</div><div class="stat-value">' +
      lowStock +
      '</div><div class="stat-label">Stock bas</div></div>' +
      "</div>" +
      '<div class="card mt-lg"><div class="card-header"><h3 class="card-title">Produits</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="app.navigateTo(\'products\')">Voir tout</button></div>' +
      '<div class="card-body" style="padding:0">' +
      (state.products.length ? renderTable(state.products.slice(0, 5)) : renderEmpty()) +
      "</div></div>";
  }

  function renderProducts(c) {
    c.innerHTML =
      '<div class="page-header"><div><h1 class="page-title">Produits</h1><p class="page-subtitle">' +
      state.products.length +
      " produit(s)</p></div>" +
      '<div class="page-actions"><button class="btn btn-secondary" onclick="app.showImportModal()">Import Shopify</button>' +
      '<button class="btn btn-primary" onclick="app.showAddProductModal()">+ Ajouter</button></div></div>' +
      '<div class="card"><div class="card-body" style="padding:0">' +
      (state.products.length ? renderTable(state.products) : renderEmpty()) +
      "</div></div>";
  }

  function renderTable(products) {
    var rows = products
      .map(function (p) {
        var s = p.totalGrams || 0,
          cost = p.averageCostPerGram || 0;
        var st = getStatus(s);
        return (
          "<tr><td>" +
          esc(p.name || p.title || "Sans nom") +
          "</td>" +
          "<td>" +
          formatWeight(s) +
          "</td><td>" +
          formatCurrency(cost) +
          "/g</td>" +
          "<td>" +
          formatCurrency(s * cost) +
          "</td>" +
          '<td><span class="stock-badge ' +
          st.c +
          '">' +
          st.i +
          " " +
          st.l +
          "</span></td>" +
          '<td><button class="btn btn-ghost btn-xs" onclick="app.showRestockModal(\'' +
          p.productId +
          "')\">+</button>" +
          '<button class="btn btn-ghost btn-xs" onclick="app.showAdjustModal(\'' +
          p.productId +
          "')\">Edit</button></td></tr>"
        );
      })
      .join("");
    return (
      '<table class="data-table"><thead><tr><th>Produit</th><th>Stock</th><th>CMP</th><th>Valeur</th><th>Statut</th><th></th></tr></thead><tbody>' +
      rows +
      "</tbody></table>"
    );
  }

  function renderEmpty() {
    return (
      '<div class="empty-state"><div class="empty-icon">📦</div><h3>Aucun produit</h3>' +
      '<p class="text-secondary">Ajoutez ou importez des produits.</p>' +
      '<button class="btn btn-primary" onclick="app.showAddProductModal()">+ Ajouter</button> ' +
      '<button class="btn btn-secondary" onclick="app.showImportModal()">Import Shopify</button></div>'
    );
  }

  function renderSettings(c) {
    var max = state.limits.maxProducts;
    max = max === Infinity || max > 9999 ? "Illimite" : max;
    c.innerHTML =
      '<div class="page-header"><h1 class="page-title">Parametres</h1></div>' +
      '<div class="card"><div class="card-header"><h3>Mon plan</h3></div><div class="card-body">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      "<div><strong>" +
      state.planName +
      "</strong><br><span class=\"text-secondary\">" +
      state.products.length +
      "/" +
      max +
      " produits</span></div>" +
      (state.planId !== "enterprise"
        ? '<button class="btn btn-upgrade" onclick="app.showUpgradeModal()">Upgrader</button>'
        : '<span class="badge badge-success">ENTERPRISE</span>') +
      "</div></div></div>";
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
        '<div class="form-group" style="flex:1"><label class="form-label">Cout (EUR/g)</label><input type="number" class="form-input" id="pCost" value="0" step="0.01"></div></div>',
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
        '<div class="form-group" style="flex:1"><label class="form-label">Prix (EUR/g)</label><input type="number" class="form-input" id="rPrice" placeholder="4.50" step="0.01"></div></div>',
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
    // inchangé (ton code original)
    var plans = [
      { id: "starter", name: "Starter", price: 14.99, prods: "15", feats: ["Categories", "Import Shopify", "Valeur stock"] },
      { id: "pro", name: "Pro", price: 39.99, prods: "75", badge: "POPULAIRE", feats: ["Lots & DLC", "Fournisseurs", "Analytics", "Inventaire"] },
      { id: "business", name: "Business", price: 79.99, prods: "Illimite", badge: "BEST", feats: ["Previsions IA", "Kits", "Commandes", "Multi-users"] },
    ];
    var cards = plans
      .map(function (p) {
        var fl = p.feats.map(function (f) { return "<li>✓ " + f + "</li>"; }).join("");
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
        '<div class="text-center"><div style="font-size:64px">🔒</div><p class="text-secondary mt-lg">Passez a un plan superieur pour debloquer cette fonctionnalite.</p></div>',
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
      ({ success: "✓", error: "X", warning: "!", info: "i" }[type] || "i") +
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
    var url = apiUrl("/plan");
    if (!url) return;
    try {
      var res = await authFetch(url);
      if (!res.ok) return;
      var data = await res.json();
      console.log("[Plan] API response:", data);

      state.planId = (data.current && data.current.planId) || data.planId || "free";
      state.planName = (data.current && data.current.name) || state.planId.charAt(0).toUpperCase() + state.planId.slice(1);
      state.limits = data.limits || {};

      console.log("[Plan] Loaded:", state.planId, state.limits);
    } catch (e) {
      console.warn("[Plan] Error:", e);
    }
  }

  async function loadProducts() {
    var url = apiUrl("/stock");
    if (!url) return;
    try {
      var res = await authFetch(url);
      if (!res.ok) {
        state.products = [];
        return;
      }
      var data = await res.json();
      state.products = Array.isArray(data.products) ? data.products : [];
      console.log("[Products] Loaded:", state.products.length);
    } catch (e) {
      state.products = [];
    }
    updateUI();
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
    var w = document.getElementById("planWidget");
    if (w) {
      var max = state.limits.maxProducts;
      max = max === Infinity || max > 9999 ? "∞" : max;
      w.innerHTML =
        '<div class="plan-info"><span class="plan-name">' +
        state.planName +
        '</span><span class="plan-usage">' +
        state.products.length +
        "/" +
        max +
        "</span></div>" +
        (state.planId !== "enterprise"
          ? '<button class="btn btn-upgrade btn-sm" onclick="app.showUpgradeModal()">Upgrade</button>'
          : '<span style="color:var(--success);font-size:11px">ENTERPRISE ✓</span>');
    }
  }

  function formatWeight(g) {
    return g >= 1000 ? (g / 1000).toFixed(2) + " kg" : g.toFixed(0) + " g";
  }
  function formatCurrency(v) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
  }
  function getStatus(g) {
    if (g <= 0) return { c: "critical", l: "Rupture", i: "⛔" };
    if (g < 50) return { c: "critical", l: "Critique", i: "🔴" };
    if (g < 200) return { c: "low", l: "Bas", i: "🟡" };
    return { c: "good", l: "OK", i: "🟢" };
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
    get state() {
      return state;
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

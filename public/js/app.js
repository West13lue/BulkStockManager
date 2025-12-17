// app.js — Stock Manager Pro - Main Application
(function() {
  'use strict';

  const API_BASE = '/api';

  // ============================================
  // SHOPIFY APP BRIDGE & SESSION TOKEN (FIX)
  // ============================================

  let appBridgeApp = null;     // instance createApp()
  let sessionToken = null;
  let apiKeyCache = null;

  function getHostFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('host');
  }

  async function loadPublicConfig() {
    if (apiKeyCache) return apiKeyCache;
    const res = await fetch('/api/public/config', { headers: { 'Accept': 'application/json' } });
    const json = await res.json().catch(() => ({}));
    apiKeyCache = String(json.apiKey || '').trim();
    return apiKeyCache;
  }

  async function initAppBridge() {
    const host = getHostFromUrl();
    if (!host) {
      console.warn('⚠️ host manquant dans l’URL (app embedded ?)');
      return false;
    }

    const apiKey = await loadPublicConfig();
    if (!apiKey) {
      console.warn('⚠️ apiKey introuvable via /api/public/config');
      return false;
    }

    const AB = window['app-bridge'];
    if (!AB || typeof AB.createApp !== 'function') {
      console.warn('⚠️ @shopify/app-bridge non chargé (window["app-bridge"] absent)');
      return false;
    }

    appBridgeApp = AB.createApp({
      apiKey,
      host,
      forceRedirect: true,
    });

    console.log('🔗 App Bridge créé (createApp)');
    return true;
  }

  async function getSessionToken() {
    if (sessionToken) return sessionToken;
    if (!appBridgeApp) return null;

    const ABU = window['app-bridge-utils'];
    if (!ABU || typeof ABU.getSessionToken !== 'function') {
      console.warn('⚠️ @shopify/app-bridge-utils non chargé (getSessionToken indisponible)');
      return null;
    }

    try {
      sessionToken = await ABU.getSessionToken(appBridgeApp);
      return sessionToken;
    } catch (e) {
      console.warn('⚠️ Erreur getSessionToken(App Bridge):', e);
      return null;
    }
  }

  function clearSessionToken() {
    sessionToken = null;
  }

  // Fetch avec authentification automatique (+ retry 401)
  async function authFetch(url, options = {}) {
    const token = await getSessionToken();

    const headers = {
      ...(options.headers || {}),
      'Accept': 'application/json',
    };

    // On ne met Content-Type: application/json que si on envoie vraiment un body JSON
    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !(options.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      console.warn('⚠️ Session token absent -> requête non authentifiée:', url);
    }

    const doFetch = () => fetch(url, { ...options, headers });

    let res = await doFetch();

    // Si token expiré / invalide : on clear et on retente 1 fois
    if (res.status === 401 && token) {
      console.warn('⚠️ 401 détecté -> refresh session token et retry:', url);
      clearSessionToken();

      const token2 = await getSessionToken();
      if (token2) {
        headers['Authorization'] = `Bearer ${token2}`;
      } else {
        delete headers['Authorization'];
      }

      res = await doFetch();
    }

    return res;
  }

  // ============================================
  // SHOP DETECTION
  // ============================================

  function getShopFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);

    // 1. Depuis l'URL (query param)
    const shopParam = urlParams.get('shop');
    if (shopParam) return shopParam;

    // 2. Depuis le host param (Shopify embedded)
    const hostParam = urlParams.get('host');
    if (hostParam) {
      try {
        const decoded = atob(hostParam);
        const match = decoded.match(/([^/]+\.myshopify\.com)/);
        if (match) return match[1];
      } catch (e) {}
    }

    // 3. Depuis localStorage (cache)
    const cached = localStorage.getItem('stockmanager_shop');
    if (cached) return cached;

    return null;
  }

  const CURRENT_SHOP = getShopFromUrl();

  if (CURRENT_SHOP) {
    localStorage.setItem('stockmanager_shop', CURRENT_SHOP);
    console.log('🏪 Shop détecté:', CURRENT_SHOP);
  }

function apiUrl(endpoint) {
  if (!CURRENT_SHOP) return null;
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${API_BASE}${endpoint}${separator}shop=${encodeURIComponent(CURRENT_SHOP)}`;
}


  const FEATURES = {
    hasBatchTracking: { plan: 'pro', name: 'Lots & DLC', icon: '🏷️' },
    hasSuppliers: { plan: 'pro', name: 'Fournisseurs', icon: '🏭' },
    hasPurchaseOrders: { plan: 'business', name: 'Bons de commande', icon: '📝' },
    hasForecast: { plan: 'business', name: 'Prévisions', icon: '🔮' },
    hasKits: { plan: 'business', name: 'Kits & Bundles', icon: '🧩' },
    hasAnalytics: { plan: 'pro', name: 'Analytics', icon: '📈' },
    hasInventoryCount: { plan: 'pro', name: 'Inventaire', icon: '📋' },
  };

  const PLAN_HIERARCHY = ['free', 'starter', 'pro', 'business', 'enterprise'];

  const state = {
    currentTab: 'dashboard',
    plan: { id: 'free', limits: { maxProducts: 2 } },
    products: [],
    loading: false,
    sidebarOpen: true,
    shop: CURRENT_SHOP,
  };

  // ============================================
  // INIT
  // ============================================

async function init() {
  console.log('🚀 Stock Manager Pro initializing...');
  console.log('🏪 Shop:', CURRENT_SHOP || 'NON DÉTECTÉ');

if (!CURRENT_SHOP || window.top === window.self) {
  console.warn('⛔ App ouverte hors iframe Shopify');

  const msg = document.createElement('div');
  msg.style.padding = '40px';
  msg.style.fontFamily = 'sans-serif';
  msg.innerHTML = `
    <h2>⚠️ Application Shopify</h2>
    <p>Cette application doit être ouverte depuis l’admin Shopify.</p>
  `;

  document.body.innerHTML = '';
  document.body.appendChild(msg);
  return;
}

  // ⛔ STOP si App Bridge non prêt
  const bridgeReady = await initAppBridge();
  if (!bridgeReady) {
    console.warn('⏳ App Bridge non prêt');
    return;
  }

  setupNavigation();
  await loadPlanInfo();
  await loadProducts();

  renderTab('dashboard');
  updatePlanWidget();
  console.log('✅ Ready');
}


  // ============================================
  // NAVIGATION
  // ============================================

  function setupNavigation() {
    document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = item.dataset.tab;
        const feature = item.dataset.feature;
        if (feature && !hasFeature(feature)) {
          showFeatureLockedModal(feature);
          return;
        }
        navigateTo(tab);
      });
    });
  }

  function navigateTo(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tab);
    });
    renderTab(tab);
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    document.getElementById('sidebar')?.classList.toggle('collapsed', !state.sidebarOpen);
  }

  // ============================================
  // TAB RENDERING
  // ============================================

  function renderTab(tab) {
    const content = document.getElementById('pageContent');
    if (!content) return;

    const renderers = {
      dashboard: renderDashboard,
      products: renderProducts,
      batches: () => renderLockedOrContent('hasBatchTracking', renderBatches),
      suppliers: () => renderLockedOrContent('hasSuppliers', renderSuppliers),
      orders: () => renderLockedOrContent('hasPurchaseOrders', renderOrders),
      forecast: () => renderLockedOrContent('hasForecast', renderForecast),
      kits: () => renderLockedOrContent('hasKits', renderKits),
      analytics: () => renderLockedOrContent('hasAnalytics', renderAnalytics),
      inventory: () => renderLockedOrContent('hasInventoryCount', renderInventory),
      settings: renderSettings,
    };

    const renderer = renderers[tab] || renderDashboard;
    if (typeof renderer === 'function') {
      const result = renderer(content);
      if (typeof result === 'string') content.innerHTML = result;
    }
  }

  function renderLockedOrContent(featureKey, contentRenderer) {
    const content = document.getElementById('pageContent');
    if (!content) return;
    if (!hasFeature(featureKey)) {
      renderLockedFeature(content, featureKey);
    } else {
      contentRenderer(content);
    }
  }

  // ============================================
  // DASHBOARD
  // ============================================

  function renderDashboard(c) {
    const totalStock = state.products.reduce((s, p) => s + (p.totalGrams || 0), 0);
    const totalValue = state.products.reduce((s, p) => s + ((p.totalGrams || 0) * (p.averageCostPerGram || 0)), 0);
    const lowStock = state.products.filter(p => (p.totalGrams || 0) < 100).length;

    c.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Tableau de bord</h1>
          <p class="page-subtitle">Vue d'ensemble de votre stock</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-secondary" onclick="app.syncShopify()">🔄 Sync</button>
          <button class="btn btn-primary" onclick="app.showAddProductModal()">➕ Produit</button>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📦</div>
          <div class="stat-value">${state.products.length}</div>
          <div class="stat-label">Produits</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⚖️</div>
          <div class="stat-value">${formatWeight(totalStock)}</div>
          <div class="stat-label">Stock total</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💰</div>
          <div class="stat-value">${formatCurrency(totalValue)}</div>
          <div class="stat-label">Valeur</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⚠️</div>
          <div class="stat-value ${lowStock > 0 ? 'text-warning' : ''}">${lowStock}</div>
          <div class="stat-label">Stock bas</div>
        </div>
      </div>

      <div class="card mt-lg">
        <div class="card-header">
          <h3 class="card-title">📦 Produits récents</h3>
          <button class="btn btn-ghost btn-sm" onclick="app.navigateTo('products')">Voir tout →</button>
        </div>
        <div class="card-body" style="padding:0">
          ${state.products.length > 0 ? renderProductsTable(state.products.slice(0, 5)) : renderEmptyProducts()}
        </div>
      </div>

      ${renderLockedFeatureCards()}
    `;
  }

  function renderLockedFeatureCards() {
    if (state.plan.id === 'enterprise') return '';
    const locked = Object.entries(FEATURES).filter(([k]) => !hasFeature(k));
    if (locked.length === 0) return '';

    return `
      <div class="mt-xl">
        <h3 class="mb-lg text-secondary">🔓 Débloquez plus de fonctionnalités</h3>
        <div class="stats-grid">
          ${locked.slice(0, 3).map(([k, f]) => `
            <div class="stat-card" style="cursor:pointer;opacity:0.7" onclick="app.showFeatureLockedModal('${k}')">
              <div class="stat-icon">${f.icon}</div>
              <div class="stat-value" style="font-size:16px">${f.name}</div>
              <span class="badge badge-${f.plan === 'pro' ? 'info' : 'warning'}">${f.plan.toUpperCase()}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // ============================================
  // PRODUCTS
  // ============================================

  function renderProducts(c) {
    c.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Produits</h1>
          <p class="page-subtitle">${state.products.length} produit(s)</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-secondary" onclick="app.importFromShopify()">📥 Import</button>
          <button class="btn btn-primary" onclick="app.showAddProductModal()">➕ Ajouter</button>
        </div>
      </div>
      <div class="card">
        <div class="card-body" style="padding:0">
          ${state.products.length > 0 ? renderProductsTable(state.products) : renderEmptyProducts()}
        </div>
      </div>
    `;
  }

  function renderProductsTable(products) {
    return `
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>Produit</th><th>Stock</th><th>CMP</th><th>Valeur</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${products.map(p => {
              const stock = p.totalGrams || 0;
              const cmp = p.averageCostPerGram || 0;
              const status = getStockStatus(stock);
              return `
                <tr>
                  <td><div class="cell-primary">${escapeHtml(p.name || p.title || 'Sans nom')}</div></td>
                  <td class="cell-mono font-bold">${formatWeight(stock)}</td>
                  <td class="cell-mono">${formatCurrency(cmp)}/g</td>
                  <td class="cell-mono">${formatCurrency(stock * cmp)}</td>
                  <td><span class="stock-badge ${status.class}">${status.icon} ${status.label}</span></td>
                  <td class="cell-actions">
                    <button class="btn btn-ghost btn-xs" onclick="app.showRestockModal('${p.productId}')">📥</button>
                    <button class="btn btn-ghost btn-xs" onclick="app.showAdjustModal('${p.productId}')">✏️</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderEmptyProducts() {
    return `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <h3 class="empty-title">Aucun produit</h3>
        <p class="empty-description">Ajoutez votre premier produit pour commencer.</p>
        <button class="btn btn-primary" onclick="app.showAddProductModal()">➕ Ajouter</button>
      </div>
    `;
  }

  // ============================================
  // LOCKED FEATURES
  // ============================================

  function renderBatches(c) { c.innerHTML = renderFeaturePage('Lots & DLC', '🏷️', 'Traçabilité et DLC', 'showAddBatchModal'); }
  function renderSuppliers(c) { c.innerHTML = renderFeaturePage('Fournisseurs', '🏭', 'Gérez vos fournisseurs', 'showAddSupplierModal'); }
  function renderOrders(c) { c.innerHTML = renderFeaturePage('Commandes', '📝', 'Bons de commande', 'showCreateOrderModal'); }
  function renderForecast(c) { c.innerHTML = renderFeaturePage('Prévisions', '🔮', 'Anticipez les ruptures', null); }
  function renderKits(c) { c.innerHTML = renderFeaturePage('Kits', '🧩', 'Produits composés', 'showCreateKitModal'); }
  function renderAnalytics(c) { c.innerHTML = renderFeaturePage('Analytics', '📈', 'Statistiques', null); }
  function renderInventory(c) { c.innerHTML = renderFeaturePage('Inventaire', '📋', 'Comptage physique', 'startInventory'); }

  function renderFeaturePage(title, icon, subtitle, action) {
    return `
      <div class="page-header">
        <div><h1 class="page-title">${icon} ${title}</h1><p class="page-subtitle">${subtitle}</p></div>
        ${action ? `<button class="btn btn-primary" onclick="app.${action}()">➕ Nouveau</button>` : ''}
      </div>
      <div class="card"><div class="card-body">
        <div class="empty-state" style="min-height:250px">
          <div class="empty-icon">${icon}</div>
          <p class="empty-description">Aucun élément pour le moment</p>
        </div>
      </div></div>
    `;
  }

  function renderLockedFeature(c, featureKey) {
    const f = FEATURES[featureKey];
    const benefits = getFeatureBenefits(featureKey);

    c.innerHTML = `
      <div class="page-header"><h1 class="page-title">${f.icon} ${f.name}</h1></div>
      <div class="card feature-locked" style="min-height:450px;position:relative">
        <div style="opacity:0.1;padding:var(--space-xl)">
          <div class="stats-grid">
            <div class="stat-card"><div class="skeleton" style="height:50px"></div></div>
            <div class="stat-card"><div class="skeleton" style="height:50px"></div></div>
          </div>
          <div class="card mt-lg"><div class="card-body"><div class="skeleton" style="height:150px"></div></div></div>
        </div>
        <div class="lock-overlay">
          <div class="lock-icon">🔒</div>
          <h2 class="lock-title">Fonctionnalité ${f.plan.toUpperCase()}</h2>
          <p class="lock-description">${getFeatureDescription(featureKey)}</p>
          <div class="lock-benefits">
            ${benefits.map(b => `<span class="lock-benefit"><span class="lock-benefit-icon">✓</span>${b}</span>`).join('')}
          </div>
          <button class="btn btn-upgrade btn-lg" onclick="app.showUpgradeModal('${f.plan}')">⬆️ Passer au ${f.plan.toUpperCase()}</button>
          <p class="lock-plan">À partir de <strong>${getPlanPrice(f.plan)}€/mois</strong></p>
        </div>
      </div>
    `;
  }

  function hasFeature(featureKey) {
    const planIdx = PLAN_HIERARCHY.indexOf(state.plan.id);
    const reqIdx = PLAN_HIERARCHY.indexOf(FEATURES[featureKey]?.plan || 'free');
    return planIdx >= reqIdx;
  }

  function getFeatureDescription(k) {
    const d = {
      hasBatchTracking: 'Suivez vos lots avec les dates de péremption et assurez une traçabilité complète.',
      hasSuppliers: 'Gérez votre carnet fournisseurs, comparez les prix et l\'historique achats.',
      hasPurchaseOrders: 'Créez des bons de commande, suivez les réceptions et créez les lots auto.',
      hasForecast: 'L\'IA analyse vos ventes pour prédire les ruptures et suggérer les commandes.',
      hasKits: 'Créez des produits composés avec stock et coût calculés automatiquement.',
      hasAnalytics: 'Statistiques détaillées : CA, marges, tendances et top produits.',
      hasInventoryCount: 'Inventaires physiques assistés avec rapport d\'écarts et ajustements auto.',
    };
    return d[k] || 'Fonctionnalité premium.';
  }

  function getFeatureBenefits(k) {
    const b = {
      hasBatchTracking: ['Traçabilité', 'Alertes DLC', 'FIFO auto'],
      hasSuppliers: ['Comparaison prix', 'Historique', 'Contacts'],
      hasPurchaseOrders: ['Workflow complet', 'Réceptions', 'Lots auto'],
      hasForecast: ['Prédiction IA', 'Suggestions', 'Zéro rupture'],
      hasKits: ['Stock calculé', 'Coût auto', 'Bundles'],
      hasAnalytics: ['CA & marges', 'Graphiques', 'Export'],
      hasInventoryCount: ['Comptage guidé', 'Écarts', 'Ajustements'],
    };
    return b[k] || ['Premium'];
  }

  // ============================================
  // SETTINGS
  // ============================================

  function renderSettings(c) {
    c.innerHTML = `
      <div class="page-header"><h1 class="page-title">Paramètres</h1></div>
      <div class="card mb-lg">
        <div class="card-header"><h3 class="card-title">👤 Mon plan</h3></div>
        <div class="card-body">
          <div class="flex items-center justify-between">
            <div>
              <div class="font-bold">${getPlanName(state.plan.id)}</div>
              <div class="text-secondary text-sm">${state.products.length}/${state.plan.limits.maxProducts === Infinity ? '∞' : state.plan.limits.maxProducts} produits</div>
            </div>
            ${state.plan.id !== 'enterprise' ? '<button class="btn btn-upgrade" onclick="app.showUpgradeModal()">⬆️ Upgrade</button>' : ''}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title">⚙️ Général</h3></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">Langue</label>
            <select class="form-select" style="max-width:300px"><option>Français</option></select>
          </div>
        </div>
      </div>
    `;
  }

  // ============================================
  // MODALS
  // ============================================

  function showModal(opts) {
    closeModal();
    const { title, content, footer, size = '' } = opts;
    const container = document.getElementById('modalsContainer');
    if (!container) return;

    container.innerHTML = `
      <div class="modal-backdrop active" onclick="app.closeModal()"></div>
      <div class="modal active ${size ? `modal-${size}` : ''}">
        <div class="modal-header">
          <h2 class="modal-title">${title}</h2>
          <button class="modal-close" onclick="app.closeModal()">×</button>
        </div>
        <div class="modal-body">${content}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div>
    `;
  }

  function closeModal() {
    const el = document.getElementById('modalsContainer');
    if (el) el.innerHTML = '';
  }

  function showAddProductModal() {
    showModal({
      title: '➕ Ajouter un produit',
      content: `
        <div class="form-group">
          <label class="form-label required">Nom</label>
          <input type="text" class="form-input" id="productName" placeholder="CBD Premium">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Stock initial</label>
            <div class="input-group">
              <input type="number" class="form-input" id="productStock" value="0" min="0">
              <span class="input-suffix">g</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Coût</label>
            <div class="input-group">
              <input type="number" class="form-input" id="productCost" value="0" min="0" step="0.01">
              <span class="input-suffix">€/g</span>
            </div>
          </div>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button>
        <button class="btn btn-primary" onclick="app.saveProduct()">Ajouter</button>
      `,
    });
  }

  function showRestockModal(productId) {
    showModal({
      title: '📥 Réapprovisionner',
      content: `
        <div class="form-group">
          <label class="form-label">Produit</label>
          <select class="form-select" id="restockProduct">
            ${state.products.map(p => `
              <option value="${p.id}" ${p.id === productId ? 'selected' : ''}>
                ${escapeHtml(p.name || p.title || 'Sans nom')}
              </option>
            `).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label required">Quantité</label>
            <div class="input-group">
              <input type="number" class="form-input" id="restockQty" min="1" placeholder="500">
              <span class="input-suffix">g</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Prix d'achat</label>
            <div class="input-group">
              <input type="number" class="form-input" id="restockPrice" min="0" step="0.01" placeholder="4.50">
              <span class="input-suffix">€/g</span>
            </div>
          </div>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button>
        <button class="btn btn-primary" onclick="app.saveRestock()">Valider</button>
      `,
    });
  }

  function showAdjustModal(productId) {
    showModal({
      title: '✏️ Ajuster le stock',
      content: `
        <div class="form-group">
          <label class="form-label">Produit</label>
          <select class="form-select" id="adjustProduct">
            ${state.products.map(p => `
              <option value="${p.id}" ${p.id === productId ? 'selected' : ''}>
                ${escapeHtml(p.name || p.title || 'Sans nom')} (${formatWeight(p.totalGrams || 0)})
              </option>
            `).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <div style="display:flex;gap:var(--space-lg)">
            <label><input type="radio" name="adjustType" value="add" checked> ➕ Ajouter</label>
            <label><input type="radio" name="adjustType" value="remove"> ➖ Retirer</label>
            <label><input type="radio" name="adjustType" value="set"> 🎯 Définir</label>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label required">Quantité</label>
          <div class="input-group">
            <input type="number" class="form-input" id="adjustQty" min="0" placeholder="100">
            <span class="input-suffix">g</span>
          </div>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="app.closeModal()">Annuler</button>
        <button class="btn btn-primary" onclick="app.saveAdjustment()">Appliquer</button>
      `,
    });
  }

  function showUpgradeModal(recommended) {
    const plans = [
      { id: 'starter', name: 'Starter', price: 14.99, products: 15, features: ['Catégories', 'Import Shopify', 'Valeur stock'] },
      { id: 'pro', name: 'Pro', price: 39.99, products: 75, badge: 'POPULAIRE', features: ['Lots & DLC', 'Fournisseurs', 'Analytics', 'Inventaire'] },
      { id: 'business', name: 'Business', price: 79.99, products: '∞', badge: 'BEST', features: ['Prévisions IA', 'Kits', 'Commandes', 'Multi-users'] },
    ];

    showModal({
      title: '⬆️ Choisir un plan',
      size: 'xl',
      content: `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-lg)">
          ${plans.map(p => `
            <div class="card" style="${p.id === recommended ? 'border:2px solid var(--accent-primary)' : ''}">
              ${p.badge ? `<div class="badge badge-${p.badge === 'POPULAIRE' ? 'info' : 'warning'}" style="position:absolute;top:-8px;right:16px">${p.badge}</div>` : ''}
              <div class="card-body text-center" style="position:relative">
                <h3>${p.name}</h3>
                <div style="font-size:28px;font-weight:700">${p.price}<span style="font-size:12px;color:var(--text-secondary)">€/mois</span></div>
                <div class="text-secondary text-sm mb-md">${p.products} produits</div>
                <ul style="text-align:left;list-style:none;margin-bottom:var(--space-lg)">
                  ${p.features.map(f => `<li style="padding:4px 0"><span style="color:var(--success)">✓</span> ${f}</li>`).join('')}
                </ul>
                <button class="btn ${state.plan.id === p.id ? 'btn-secondary' : 'btn-primary'} btn-sm" style="width:100%" ${state.plan.id === p.id ? 'disabled' : `onclick="app.upgradeTo('${p.id}')"`}>
                  ${state.plan.id === p.id ? 'Actuel' : 'Choisir'}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `,
      footer: '<button class="btn btn-ghost" onclick="app.closeModal()">Fermer</button>',
    });
  }

  function showFeatureLockedModal(featureKey) {
    const f = FEATURES[featureKey];
    const benefits = getFeatureBenefits(featureKey);
    showModal({
      title: `🔒 ${f.name}`,
      content: `
        <div class="text-center">
          <div style="font-size:48px;margin-bottom:var(--space-lg)">${f.icon}</div>
          <h3>Passez au ${f.plan.toUpperCase()}</h3>
          <p class="text-secondary mb-lg">${getFeatureDescription(featureKey)}</p>
          <div class="lock-benefits mb-lg" style="justify-content:center">
            ${benefits.map(b => `<span class="lock-benefit"><span class="lock-benefit-icon">✓</span>${b}</span>`).join('')}
          </div>
          <p class="text-secondary text-sm">À partir de <strong class="text-accent">${getPlanPrice(f.plan)}€/mois</strong></p>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="app.closeModal()">Plus tard</button>
        <button class="btn btn-upgrade" onclick="app.showUpgradeModal('${f.plan}')">⬆️ Upgrader</button>
      `,
    });
  }

  // ============================================
  // TOAST
  // ============================================

  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><div class="toast-content"><div class="toast-message">${escapeHtml(message)}</div></div><button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    if (duration > 0) setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); }, duration);
  }

  // ============================================
  // API
  // ============================================

async function loadPlanInfo() {
  const url = apiUrl('/plan');
  if (!url) return;

  try {
    const res = await authFetch(url);
    if (res.ok) {
      const data = await res.json();
      state.plan = { id: data.current?.planId || 'free', limits: data.limits || { maxProducts: 2 } };
      console.log('📋 Plan chargé:', state.plan.id);
      updatePlanWidget();
    }
  } catch (e) {
    console.warn('Plan load error', e);
  }
}

async function loadProducts() {
  const url = apiUrl('/stock'); // ✅ route existante côté server
  if (!url) return;

  try {
    const res = await authFetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Products load error', err);
      state.products = [];
      return;
    }

    const data = await res.json().catch(() => ({}));
    // server renvoie { products, categories }
    state.products = Array.isArray(data.products) ? data.products : [];
  } catch (e) {
    console.warn('Products load error', e);
    state.products = [];
  } finally {
    updatePlanWidget();
  }
}

  async function saveProduct() {
    const name = document.getElementById('productName')?.value;
    const stock = parseFloat(document.getElementById('productStock')?.value) || 0;
    const cost = parseFloat(document.getElementById('productCost')?.value) || 0;
    if (!name) { showToast('Nom requis', 'error'); return; }

    try {
      const res = await authFetch(apiUrl('/products'), {
        method: 'POST',
        body: JSON.stringify({ name, totalGrams: stock, averageCostPerGram: cost })
      });

      if (res.ok) {
        showToast('Produit ajouté', 'success');
        closeModal();
        await loadProducts();
        renderTab(state.currentTab);
        updatePlanWidget();
      } else {
        throw new Error();
      }
    } catch (e) {
      showToast('Erreur', 'error');
    }
  }

async function saveRestock() {
  const productId = document.getElementById('restockProduct')?.value;
  const qty = parseFloat(document.getElementById('restockQty')?.value);
  const price = parseFloat(document.getElementById('restockPrice')?.value) || 0;

  if (!productId || !qty) { showToast('Champs requis', 'error'); return; }

  try {
    const res = await authFetch(apiUrl('/restock'), {
      method: 'POST',
      body: JSON.stringify({
        productId,
        grams: qty,
        purchasePricePerGram: price
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('Restock error:', data);
      showToast(data?.error || 'Erreur', 'error');
      return;
    }

    showToast('Stock mis à jour', 'success');
    closeModal();
    await loadProducts();
    renderTab(state.currentTab);
    updatePlanWidget();
  } catch (e) {
    console.error(e);
    showToast('Erreur', 'error');
  }
}


async function saveAdjustment() {
  const productId = document.getElementById('adjustProduct')?.value;
  const type = document.querySelector('input[name="adjustType"]:checked')?.value;
  const qty = parseFloat(document.getElementById('adjustQty')?.value);

  if (!productId || !qty) { showToast('Champs requis', 'error'); return; }

  // Backend: /api/products/:productId/adjust-total attend gramsDelta (positif/negatif)
  let gramsDelta = qty;
  if (type === 'remove') gramsDelta = -Math.abs(qty);
  if (type === 'add') gramsDelta = Math.abs(qty);

  if (type === 'set') {
    showToast("Mode 'Définir' pas supporté par l’API actuelle (ajustement delta uniquement).", 'warning');
    return;
  }

  try {
    const res = await authFetch(apiUrl(`/products/${encodeURIComponent(productId)}/adjust-total`), {
      method: 'POST',
      body: JSON.stringify({ gramsDelta })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('Adjust error:', data);
      showToast(data?.error || 'Erreur', 'error');
      return;
    }

    showToast('Ajustement appliqué', 'success');
    closeModal();
    await loadProducts();
    renderTab(state.currentTab);
    updatePlanWidget();
  } catch (e) {
    console.error(e);
    showToast('Erreur', 'error');
  }
}

  function syncShopify() { showToast('Synchronisation...', 'info'); }
  function importFromShopify() { showToast('Import Shopify...', 'info'); }
  async function upgradeTo(planId, interval = 'monthly') {
  try {
    showToast('Redirection vers Shopify Billing…', 'info', 2000);

    const res = await authFetch(apiUrl('/plan/upgrade'), {
      method: 'POST',
      body: JSON.stringify({ planId, interval })
    });

    const data = await res.json();

    // 🟣 Cas bypass (/ dev)
    if (data.bypass) {
      showToast('Plan activé (bypass)', 'success');
      await loadPlanInfo();
      updatePlanWidget();
      closeModal();
      return;
    }

    // 🟣 Cas NORMAL Shopify Billing
    if (data.confirmationUrl) {
      // ⚠️ OBLIGATOIRE : redirection top-level
      window.top.location.href = data.confirmationUrl;
      return;
    }

    throw new Error('Aucune confirmationUrl retournée');
  } catch (e) {
    console.error('Billing error', e);
    showToast('Erreur lors de l’activation du plan', 'error');
  }
}

  // ============================================
  // HELPERS
  // ============================================

  function updatePlanWidget() {
    const w = document.getElementById('planWidget');
    if (!w) return;
    const max = state.plan?.limits?.maxProducts ?? 2;

    w.innerHTML = `
      <div class="plan-info">
        <span class="plan-name">Plan ${getPlanName(state.plan.id)}</span>
        <span class="plan-usage">${state.products.length}/${max === Infinity ? '∞' : max} produits</span>
      </div>
      ${state.plan.id !== 'enterprise' ? '<button class="btn btn-upgrade btn-sm" onclick="app.showUpgradeModal()">Upgrade</button>' : ''}
    `;
  }

  function getPlanName(id) { return { free: 'Free', starter: 'Starter', pro: 'Pro', business: 'Business', enterprise: 'Enterprise' }[id] || 'Free'; }
  function getPlanPrice(id) { return { starter: 14.99, pro: 39.99, business: 79.99, enterprise: 199 }[id] || 0; }
  function formatWeight(g) { return g >= 1000 ? (g / 1000).toFixed(2) + ' kg' : g.toFixed(0) + ' g'; }
  function formatCurrency(a) { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(a); }

  function getStockStatus(g) {
    if (g <= 0) return { class: 'critical', label: 'Rupture', icon: '❌' };
    if (g < 50) return { class: 'critical', label: 'Critique', icon: '🔴' };
    if (g < 200) return { class: 'low', label: 'Bas', icon: '🟡' };
    return { class: 'good', label: 'OK', icon: '🟢' };
  }

  function escapeHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

function toggleNotifications() {
  showToast('Notifications bientôt disponibles', 'info');
}

function toggleUserMenu() {
  showToast('Menu utilisateur bientôt disponible', 'info');
}

  // ============================================
  // EXPORTS
  // ============================================

window.app = {
  init, navigateTo, toggleSidebar,
  toggleNotifications, toggleUserMenu,
  showModal, closeModal, showAddProductModal, showRestockModal, showAdjustModal, showUpgradeModal, showFeatureLockedModal,
  saveProduct, saveRestock, saveAdjustment, syncShopify, importFromShopify, upgradeTo,
  showToast,
  get state() { return state; },
};

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

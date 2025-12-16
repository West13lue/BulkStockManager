// public/js/analytics.js — Dashboard Analytics UI
// Intégré avec app.js existant, utilise les mêmes patterns (apiFetch, modals, etc.)

(() => {
  // ============================================
  // CONFIG & STATE
  // ============================================
  
  const CHART_COLORS = {
    revenue: "#8b7fc8",
    margin: "#10b981",
    cost: "#ef4444",
    grams: "#3b82f6",
    quantity: "#f59e0b",
  };

  let analyticsState = {
    summary: null,
    timeseries: null,
    topProducts: null,
    recentOrders: null,
    loading: false,
    dateRange: {
      from: getDefaultFromDate(),
      to: new Date().toISOString().slice(0, 10),
    },
    bucket: "day",
  };

  let chartInstance = null;

  // ============================================
  // HELPERS
  // ============================================

  function getDefaultFromDate() {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }

  function formatCurrency(value, currency = "EUR") {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
    }).format(Number(value || 0));
  }

  function formatNumber(value, decimals = 0) {
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Number(value || 0));
  }

  function formatPercent(value) {
    return `${Number(value || 0).toFixed(1)}%`;
  }

  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function formatDateTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function el(id) {
    return document.getElementById(id);
  }

  // Utilise apiFetch de app.js si disponible
  async function fetchApi(path) {
    if (typeof window.apiFetch === "function") {
      return window.apiFetch(path);
    }
    // Fallback
    const res = await fetch(path);
    return res;
  }

  async function safeJson(res) {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new Error("Réponse non-JSON");
    }
    return res.json();
  }

  // ============================================
  // TAB SYSTEM
  // ============================================

  window.switchTab = function(tabName) {
    // Update buttons
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    // Update content
    document.querySelectorAll(".tab-content").forEach(content => {
      content.classList.toggle("active", content.id === `${tabName}-tab`);
    });

    // Load analytics data when switching to analytics tab
    if (tabName === "analytics" && !analyticsState.summary) {
      loadAnalyticsData();
    }
  };

  // ============================================
  // DATA LOADING
  // ============================================

  async function loadAnalyticsData() {
    if (analyticsState.loading) return;
    analyticsState.loading = true;

    showLoading(true);

    const { from, to } = analyticsState.dateRange;
    const bucket = analyticsState.bucket;

    try {
      // Charger toutes les données en parallèle
      const [summaryRes, timeseriesRes, topProductsRes, ordersRes] = await Promise.all([
        fetchApi(`/api/analytics/summary?from=${from}&to=${to}`),
        fetchApi(`/api/analytics/timeseries?from=${from}&to=${to}&bucket=${bucket}`),
        fetchApi(`/api/analytics/products/top?from=${from}&to=${to}&by=revenue&limit=10`),
        fetchApi(`/api/analytics/orders?from=${from}&to=${to}&limit=20`),
      ]);

      const [summary, timeseries, topProducts, orders] = await Promise.all([
        safeJson(summaryRes),
        safeJson(timeseriesRes),
        safeJson(topProductsRes),
        safeJson(ordersRes),
      ]);

      analyticsState.summary = summary;
      analyticsState.timeseries = timeseries;
      analyticsState.topProducts = topProducts;
      analyticsState.recentOrders = orders;

      // Render everything
      renderKPIs();
      renderChart();
      renderTopProducts();
      renderRecentOrders();

    } catch (e) {
      console.error("Erreur chargement analytics:", e);
      showError("Impossible de charger les données analytics: " + e.message);
    } finally {
      analyticsState.loading = false;
      showLoading(false);
    }
  }

  function showLoading(show) {
    const loader = el("analyticsLoader");
    if (loader) {
      loader.style.display = show ? "flex" : "none";
    }
  }

  function showError(message) {
    const container = el("analyticsError");
    if (container) {
      container.innerHTML = `<div class="analytics-error">${escapeHtml(message)}</div>`;
      container.style.display = "block";
    }
  }

  // ============================================
  // RENDER FUNCTIONS
  // ============================================

  function renderKPIs() {
    const container = el("analyticsKPIs");
    if (!container || !analyticsState.summary) return;

    const s = analyticsState.summary;
    const currency = s.currency || "EUR";

    container.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-icon">💰</div>
        <div class="kpi-content">
          <div class="kpi-title">Chiffre d'affaires</div>
          <div class="kpi-value">${formatCurrency(s.totalRevenue, currency)}</div>
          <div class="kpi-sub">${formatNumber(s.uniqueOrders)} commande(s)</div>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-icon">📈</div>
        <div class="kpi-content">
          <div class="kpi-title">Marge brute</div>
          <div class="kpi-value ${s.totalMargin >= 0 ? 'positive' : 'negative'}">${formatCurrency(s.totalMargin, currency)}</div>
          <div class="kpi-sub">${formatPercent(s.averageMarginPercent)} de marge</div>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-icon">⚖️</div>
        <div class="kpi-content">
          <div class="kpi-title">Quantité vendue</div>
          <div class="kpi-value">${formatNumber(s.totalGrams, 1)}g</div>
          <div class="kpi-sub">${formatNumber(s.totalQuantity)} unité(s)</div>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-icon">🛒</div>
        <div class="kpi-content">
          <div class="kpi-title">Panier moyen</div>
          <div class="kpi-value">${formatCurrency(s.averageOrderValue, currency)}</div>
          <div class="kpi-sub">${formatNumber(s.averageGramsPerOrder, 1)}g / commande</div>
        </div>
      </div>
    `;
  }

  function renderChart() {
    const canvas = el("analyticsChart");
    if (!canvas || !analyticsState.timeseries?.data) return;

    const data = analyticsState.timeseries.data;

    // Destroy previous chart if exists
    if (chartInstance) {
      chartInstance.destroy();
    }

    const ctx = canvas.getContext("2d");

    // Check if Chart.js is loaded
    if (typeof Chart === "undefined") {
      console.warn("Chart.js non chargé");
      return;
    }

    chartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: data.map(d => formatChartLabel(d.date)),
        datasets: [
          {
            label: "Chiffre d'affaires (€)",
            data: data.map(d => d.revenue),
            backgroundColor: CHART_COLORS.revenue + "80",
            borderColor: CHART_COLORS.revenue,
            borderWidth: 2,
            yAxisID: "y",
            order: 2,
          },
          {
            label: "Marge (€)",
            data: data.map(d => d.margin),
            backgroundColor: CHART_COLORS.margin + "80",
            borderColor: CHART_COLORS.margin,
            borderWidth: 2,
            yAxisID: "y",
            order: 3,
          },
          {
            label: "Grammes vendus",
            data: data.map(d => d.grams),
            type: "line",
            borderColor: CHART_COLORS.grams,
            backgroundColor: "transparent",
            borderWidth: 3,
            pointRadius: 4,
            pointBackgroundColor: CHART_COLORS.grams,
            yAxisID: "y1",
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: "rgba(255, 255, 255, 0.8)",
              usePointStyle: true,
              padding: 20,
            },
          },
          tooltip: {
            backgroundColor: "rgba(26, 31, 46, 0.95)",
            titleColor: "#fff",
            bodyColor: "rgba(255, 255, 255, 0.8)",
            borderColor: "rgba(255, 255, 255, 0.1)",
            borderWidth: 1,
            padding: 12,
            callbacks: {
              label: function(context) {
                const label = context.dataset.label || "";
                const value = context.parsed.y;
                if (label.includes("€")) {
                  return `${label}: ${formatCurrency(value)}`;
                }
                if (label.includes("Grammes")) {
                  return `${label}: ${formatNumber(value, 1)}g`;
                }
                return `${label}: ${value}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              color: "rgba(255, 255, 255, 0.05)",
            },
            ticks: {
              color: "rgba(255, 255, 255, 0.6)",
            },
          },
          y: {
            type: "linear",
            position: "left",
            grid: {
              color: "rgba(255, 255, 255, 0.05)",
            },
            ticks: {
              color: "rgba(255, 255, 255, 0.6)",
              callback: value => formatCurrency(value),
            },
          },
          y1: {
            type: "linear",
            position: "right",
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              color: CHART_COLORS.grams,
              callback: value => `${value}g`,
            },
          },
        },
      },
    });
  }

  function formatChartLabel(dateStr) {
    if (!dateStr) return "";
    const bucket = analyticsState.bucket;
    
    if (bucket === "month") {
      const [year, month] = dateStr.split("-");
      const months = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
      return months[parseInt(month) - 1] + " " + year.slice(2);
    }
    
    if (bucket === "week") {
      return "Sem. " + dateStr.slice(5);
    }
    
    // day
    const d = new Date(dateStr);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  }

  function renderTopProducts() {
    const container = el("analyticsTopProducts");
    if (!container || !analyticsState.topProducts?.products) return;

    const products = analyticsState.topProducts.products;

    if (!products.length) {
      container.innerHTML = `<div class="empty-state"><p>Aucune vente sur cette période</p></div>`;
      return;
    }

    container.innerHTML = `
      <table class="analytics-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Produit</th>
            <th>CA</th>
            <th>Marge</th>
            <th>%</th>
            <th>Grammes</th>
            <th>Ventes</th>
          </tr>
        </thead>
        <tbody>
          ${products.map(p => `
            <tr>
              <td><span class="rank-badge rank-${p.rank}">${p.rank}</span></td>
              <td class="product-name">${escapeHtml(p.productName)}</td>
              <td>${formatCurrency(p.revenue)}</td>
              <td class="${p.margin >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(p.margin)}</td>
              <td>${formatPercent(p.marginPercent)}</td>
              <td>${formatNumber(p.grams, 1)}g</td>
              <td>${p.salesCount}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function renderRecentOrders() {
    const container = el("analyticsRecentOrders");
    if (!container || !analyticsState.recentOrders?.orders) return;

    const orders = analyticsState.recentOrders.orders;

    if (!orders.length) {
      container.innerHTML = `<div class="empty-state"><p>Aucune commande sur cette période</p></div>`;
      return;
    }

    container.innerHTML = `
      <table class="analytics-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Commande</th>
            <th>Articles</th>
            <th>Grammes</th>
            <th>Total</th>
            <th>Marge</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(o => `
            <tr>
              <td>${formatDateTime(o.orderDate)}</td>
              <td><strong>#${escapeHtml(o.orderNumber || o.orderId?.slice(-6) || "?")}</strong></td>
              <td>${o.itemCount} article(s)</td>
              <td>${formatNumber(o.totalGrams, 1)}g</td>
              <td>${formatCurrency(o.totalRevenue)}</td>
              <td class="${o.totalMargin >= 0 ? 'text-success' : 'text-danger'}">
                ${formatCurrency(o.totalMargin)} (${formatPercent(o.marginPercent)})
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  // ============================================
  // EVENT HANDLERS
  // ============================================

  function setupEventListeners() {
    // Date range
    const fromInput = el("analyticsFrom");
    const toInput = el("analyticsTo");
    const bucketSelect = el("analyticsBucket");
    const refreshBtn = el("analyticsRefresh");

    if (fromInput) {
      fromInput.value = analyticsState.dateRange.from;
      fromInput.addEventListener("change", (e) => {
        analyticsState.dateRange.from = e.target.value;
      });
    }

    if (toInput) {
      toInput.value = analyticsState.dateRange.to;
      toInput.addEventListener("change", (e) => {
        analyticsState.dateRange.to = e.target.value;
      });
    }

    if (bucketSelect) {
      bucketSelect.value = analyticsState.bucket;
      bucketSelect.addEventListener("change", (e) => {
        analyticsState.bucket = e.target.value;
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        analyticsState.summary = null; // Force reload
        loadAnalyticsData();
      });
    }

    // Export buttons
    el("analyticsExportCSV")?.addEventListener("click", exportCSV);
    el("analyticsExportJSON")?.addEventListener("click", exportJSON);
  }

  async function exportCSV() {
    const { from, to } = analyticsState.dateRange;
    
    try {
      if (typeof window.downloadFile === "function") {
        await window.downloadFile(
          `/api/analytics/export.csv?from=${from}&to=${to}`,
          `analytics-${from}-${to}.csv`
        );
      } else {
        window.location.href = `/api/analytics/export.csv?from=${from}&to=${to}`;
      }
    } catch (e) {
      alert("Erreur export CSV: " + e.message);
    }
  }

  async function exportJSON() {
    const { from, to } = analyticsState.dateRange;
    
    try {
      if (typeof window.downloadFile === "function") {
        await window.downloadFile(
          `/api/analytics/export.json?from=${from}&to=${to}`,
          `analytics-${from}-${to}.json`
        );
      } else {
        window.location.href = `/api/analytics/export.json?from=${from}&to=${to}`;
      }
    } catch (e) {
      alert("Erreur export JSON: " + e.message);
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  function injectAnalyticsTab() {
    // Check if tabs already exist
    if (el("analytics-tab")) return;

    const container = document.querySelector(".container");
    if (!container) return;

    // Find header
    const header = document.querySelector(".header");
    if (!header) return;

    // Create tabs container after header
    const tabsHtml = `
      <div class="tabs-container">
        <button class="tab-btn active" data-tab="stock" onclick="switchTab('stock')">
          📦 Stock
        </button>
        <button class="tab-btn" data-tab="analytics" onclick="switchTab('analytics')">
          📊 Analytics
        </button>
      </div>
    `;

    // Wrap existing content in stock-tab
    const existingContent = container.innerHTML;
    const headerHtml = header.outerHTML;
    
    // Find where header ends
    const afterHeader = existingContent.indexOf("</div>", existingContent.indexOf("header")) + 6;
    const beforeContent = existingContent.slice(0, afterHeader);
    const mainContent = existingContent.slice(afterHeader);

    container.innerHTML = `
      ${beforeContent}
      ${tabsHtml}
      <div id="stock-tab" class="tab-content active">
        ${mainContent}
      </div>
      <div id="analytics-tab" class="tab-content">
        ${getAnalyticsTabHtml()}
      </div>
    `;

    setupEventListeners();
  }

  function getAnalyticsTabHtml() {
    return `
      <div class="analytics-dashboard">
        <!-- Toolbar -->
        <div class="analytics-toolbar">
          <div class="analytics-filters">
            <div class="field">
              <label>Du</label>
              <input type="date" id="analyticsFrom" />
            </div>
            <div class="field">
              <label>Au</label>
              <input type="date" id="analyticsTo" />
            </div>
            <div class="field">
              <label>Agrégation</label>
              <select id="analyticsBucket">
                <option value="day">Par jour</option>
                <option value="week">Par semaine</option>
                <option value="month">Par mois</option>
              </select>
            </div>
          </div>
          <div class="analytics-actions">
            <button class="btn btn-primary" id="analyticsRefresh" type="button">🔄 Actualiser</button>
            <button class="btn btn-secondary" id="analyticsExportCSV" type="button">⬇️ CSV</button>
            <button class="btn btn-secondary" id="analyticsExportJSON" type="button">⬇️ JSON</button>
          </div>
        </div>

        <!-- Loading / Error -->
        <div id="analyticsLoader" class="analytics-loader" style="display: none;">
          <div class="loading"></div>
          <p>Chargement des données...</p>
        </div>
        <div id="analyticsError" style="display: none;"></div>

        <!-- KPIs -->
        <div id="analyticsKPIs" class="analytics-kpis">
          <!-- Filled by JS -->
        </div>

        <!-- Chart -->
        <div class="card analytics-chart-card">
          <div class="card-title">📈 Évolution des ventes</div>
          <div class="chart-wrapper">
            <canvas id="analyticsChart"></canvas>
          </div>
        </div>

        <!-- Tables Grid -->
        <div class="analytics-grid">
          <!-- Top Products -->
          <div class="card">
            <div class="card-title">🏆 Top produits</div>
            <div id="analyticsTopProducts" class="table-wrapper">
              <!-- Filled by JS -->
            </div>
          </div>

          <!-- Recent Orders -->
          <div class="card">
            <div class="card-title">🛒 Commandes récentes</div>
            <div id="analyticsRecentOrders" class="table-wrapper">
              <!-- Filled by JS -->
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Load Chart.js from CDN
  function loadChartJs() {
    return new Promise((resolve, reject) => {
      if (typeof Chart !== "undefined") {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load Chart.js"));
      document.head.appendChild(script);
    });
  }

  // Init on page load
  async function init() {
    try {
      await loadChartJs();
    } catch (e) {
      console.warn("Chart.js loading failed:", e);
    }

    // Wait for DOM
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectAnalyticsTab);
    } else {
      // Small delay to let app.js initialize first
      setTimeout(injectAnalyticsTab, 100);
    }
  }

  init();

  // Export for external use
  window.analyticsState = analyticsState;
  window.loadAnalyticsData = loadAnalyticsData;
})();

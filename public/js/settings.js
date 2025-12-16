// settings.js — Interface utilisateur pour les paramètres avancés
// Version simplifiée pour l'intégration

(function () {
  "use strict";

  const settingsState = {
    settings: null,
    options: null,
    loading: false,
    dirty: false,
    activeSections: new Set(["general"]),
  };

  function el(id) { return document.getElementById(id); }
  
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async function fetchApi(url, options = {}) {
    return (window.apiFetch || fetch)(url, options);
  }

  function showToast(message, type = "success") {
    if (window.showToast) { window.showToast(message, type); return; }
    alert(message);
  }

  const SECTIONS = [
    { id: "general", icon: "🌐", title: "Général", subtitle: "Langue, timezone, formats" },
    { id: "units", icon: "⚖️", title: "Unités", subtitle: "Poids, arrondis" },
    { id: "currency", icon: "💰", title: "Monnaie", subtitle: "Devise, séparateurs" },
    { id: "stock", icon: "📦", title: "Stock", subtitle: "Seuils, CMP, sync" },
    { id: "exports", icon: "📤", title: "Exports", subtitle: "CSV, formats" },
    { id: "security", icon: "🔒", title: "Sécurité", subtitle: "Permissions" },
    { id: "support", icon: "🛠️", title: "Support", subtitle: "Diagnostic" },
  ];

  async function loadSettingsData() {
    settingsState.loading = true;
    try {
      const res = await fetchApi("/api/settings");
      const data = await res.json();
      settingsState.settings = data?.settings || {};
      settingsState.options = data?.options || {};
      renderSections();
    } catch (e) {
      console.error("Erreur chargement settings:", e);
    }
    settingsState.loading = false;
  }

  function renderSections() {
    const container = el("settingsSections");
    if (!container || !settingsState.settings) return;

    container.innerHTML = SECTIONS.map(s => `
      <div class="settings-section" data-section="${s.id}">
        <div class="section-header" onclick="settingsUI.toggleSection('${s.id}')">
          <span class="section-icon">${s.icon}</span>
          <div class="section-info"><h3>${s.title}</h3><span>${s.subtitle}</span></div>
          <span class="section-toggle">${settingsState.activeSections.has(s.id) ? '▼' : '▶'}</span>
        </div>
        <div class="section-content" style="display:${settingsState.activeSections.has(s.id)?'block':'none'}">
          ${renderSection(s.id)}
        </div>
      </div>
    `).join("");
  }

  function renderSection(id) {
    const s = settingsState.settings;
    const o = settingsState.options || {};
    
    if (id === "general") return `
      <div class="settings-grid">
        <div class="setting-field">
          <label>Langue</label>
          <select data-path="general.language" onchange="settingsUI.onChange(this)">
            ${(o.languages||[]).map(l=>`<option value="${l.value}" ${s.general?.language===l.value?'selected':''}>${l.label}</option>`).join('')}
          </select>
        </div>
        <div class="setting-field">
          <label>Timezone</label>
          <select data-path="general.timezone" onchange="settingsUI.onChange(this)">
            ${(o.timezones||[]).map(t=>`<option value="${t.value}" ${s.general?.timezone===t.value?'selected':''}>${t.label}</option>`).join('')}
          </select>
        </div>
        <div class="setting-field">
          <label>Format date</label>
          <select data-path="general.dateFormat" onchange="settingsUI.onChange(this)">
            ${(o.dateFormats||[]).map(f=>`<option value="${f.value}" ${s.general?.dateFormat===f.value?'selected':''}>${f.label}</option>`).join('')}
          </select>
        </div>
      </div>`;

    if (id === "units") return `
      <div class="settings-grid">
        <div class="setting-field">
          <label>Unité de poids</label>
          <select data-path="units.weightUnit" onchange="settingsUI.onChange(this)">
            ${(o.weightUnits||[]).map(u=>`<option value="${u.value}" ${s.units?.weightUnit===u.value?'selected':''}>${u.label}</option>`).join('')}
          </select>
        </div>
        <div class="setting-field">
          <label>Précision</label>
          <select data-path="units.weightPrecision" onchange="settingsUI.onChange(this)">
            <option value="0" ${s.units?.weightPrecision===0?'selected':''}>0 décimale</option>
            <option value="1" ${s.units?.weightPrecision===1?'selected':''}>1 décimale</option>
            <option value="2" ${s.units?.weightPrecision===2?'selected':''}>2 décimales</option>
          </select>
        </div>
        <div class="setting-field checkbox-field">
          <label class="checkbox-label">
            <input type="checkbox" data-path="units.neverNegative" ${s.units?.neverNegative?'checked':''} onchange="settingsUI.onChange(this)">
            <span>Ne jamais descendre sous 0</span>
          </label>
        </div>
      </div>`;

    if (id === "currency") return `
      <div class="settings-grid">
        <div class="setting-field">
          <label>Devise</label>
          <select data-path="currency.code" onchange="settingsUI.onChange(this)">
            ${(o.currencies||[]).map(c=>`<option value="${c.value}" ${s.currency?.code===c.value?'selected':''}>${c.symbol} ${c.label}</option>`).join('')}
          </select>
        </div>
        <div class="setting-field">
          <label>Position symbole</label>
          <select data-path="currency.position" onchange="settingsUI.onChange(this)">
            <option value="before" ${s.currency?.position==='before'?'selected':''}>Avant (€100)</option>
            <option value="after" ${s.currency?.position==='after'?'selected':''}>Après (100€)</option>
          </select>
        </div>
        <div class="setting-field">
          <label>Séparateur décimal</label>
          <select data-path="currency.decimalSeparator" onchange="settingsUI.onChange(this)">
            <option value="," ${s.currency?.decimalSeparator===','?'selected':''}>Virgule (,)</option>
            <option value="." ${s.currency?.decimalSeparator==='.'?'selected':''}>Point (.)</option>
          </select>
        </div>
      </div>`;

    if (id === "stock") return `
      <div class="settings-grid">
        <div class="setting-field checkbox-field">
          <label class="checkbox-label">
            <input type="checkbox" data-path="stock.lowStockEnabled" ${s.stock?.lowStockEnabled?'checked':''} onchange="settingsUI.onChange(this)">
            <span>Activer alertes stock bas</span>
          </label>
        </div>
        <div class="setting-field">
          <label>Seuil stock bas (g)</label>
          <input type="number" data-path="stock.lowStockThreshold" value="${s.stock?.lowStockThreshold||10}" min="0" onchange="settingsUI.onChange(this)">
        </div>
        <div class="setting-field checkbox-field">
          <label class="checkbox-label">
            <input type="checkbox" data-path="stock.freezeCMP" ${s.stock?.freezeCMP?'checked':''} onchange="settingsUI.onChange(this)">
            <span>Figer le CMP</span>
          </label>
          <span class="field-hint">Le CMP ne sera plus recalculé</span>
        </div>
        <div class="setting-field">
          <label>Source de vérité</label>
          <select data-path="stock.sourceOfTruth" onchange="settingsUI.onChange(this)">
            <option value="app" ${s.stock?.sourceOfTruth==='app'?'selected':''}>Application</option>
            <option value="shopify" ${s.stock?.sourceOfTruth==='shopify'?'selected':''}>Shopify</option>
          </select>
        </div>
      </div>`;

    if (id === "exports") return `
      <div class="settings-grid">
        <div class="setting-field">
          <label>Délimiteur CSV</label>
          <select data-path="exports.delimiter" onchange="settingsUI.onChange(this)">
            <option value=";" ${s.exports?.delimiter===';'?'selected':''}>Point-virgule (;)</option>
            <option value="," ${s.exports?.delimiter===','?'selected':''}>Virgule (,)</option>
          </select>
        </div>
        <div class="setting-field">
          <label>Encodage</label>
          <select data-path="exports.encoding" onchange="settingsUI.onChange(this)">
            <option value="utf-8" ${s.exports?.encoding==='utf-8'?'selected':''}>UTF-8</option>
            <option value="utf-8-bom" ${s.exports?.encoding==='utf-8-bom'?'selected':''}>UTF-8 BOM (Excel)</option>
          </select>
        </div>
        <div class="setting-field">
          <label>Période par défaut</label>
          <select data-path="exports.defaultPeriodDays" onchange="settingsUI.onChange(this)">
            <option value="7" ${s.exports?.defaultPeriodDays===7?'selected':''}>7 jours</option>
            <option value="30" ${s.exports?.defaultPeriodDays===30?'selected':''}>30 jours</option>
            <option value="90" ${s.exports?.defaultPeriodDays===90?'selected':''}>90 jours</option>
          </select>
        </div>
      </div>`;

    if (id === "security") return `
      <div class="settings-grid">
        <div class="setting-field checkbox-field">
          <label class="checkbox-label">
            <input type="checkbox" data-path="security.readOnlyMode" ${s.security?.readOnlyMode?'checked':''} onchange="settingsUI.onChange(this)">
            <span>Mode lecture seule</span>
          </label>
          <span class="field-hint">Désactive toutes les écritures Shopify</span>
        </div>
        <div class="setting-field checkbox-field">
          <label class="checkbox-label">
            <input type="checkbox" data-path="security.confirmDestructive" ${s.security?.confirmDestructive?'checked':''} onchange="settingsUI.onChange(this)">
            <span>Confirmer actions destructrices</span>
          </label>
        </div>
      </div>`;

    if (id === "support") return `
      <div class="settings-grid">
        <div class="setting-field full-width">
          <button class="btn btn-outline" onclick="settingsUI.runDiagnostic()">🔍 Diagnostic</button>
          <div id="diagnosticResult" style="margin-top:12px;display:none;"></div>
        </div>
        <div class="setting-field full-width">
          <button class="btn btn-outline" onclick="settingsUI.exportConfig()">💾 Exporter config</button>
        </div>
        <div class="setting-field full-width">
          <button class="btn btn-danger" onclick="settingsUI.resetAllSettings()">🗑️ Reset paramètres</button>
        </div>
      </div>`;

    return "<p>Section non implémentée</p>";
  }

  function toggleSection(id) {
    if (settingsState.activeSections.has(id)) {
      settingsState.activeSections.delete(id);
    } else {
      settingsState.activeSections.add(id);
    }
    renderSections();
  }

  function onChange(element) {
    settingsState.dirty = true;
    const btn = el("saveSettingsBtn");
    if (btn) btn.disabled = false;
    
    const path = element.getAttribute("data-path");
    if (!path) return;
    
    let value = element.type === "checkbox" ? element.checked : 
                element.type === "number" ? Number(element.value) : element.value;
    
    const parts = path.split(".");
    let obj = settingsState.settings;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }

  async function saveAllSettings() {
    if (!settingsState.dirty) return;
    try {
      // Sauvegarder section par section
      for (const section of Object.keys(settingsState.settings)) {
        if (section.startsWith("_")) continue;
        await fetchApi(`/api/settings/${section}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settingsState.settings[section]),
        });
      }
      settingsState.dirty = false;
      const btn = el("saveSettingsBtn");
      if (btn) btn.disabled = true;
      showToast("Paramètres enregistrés ✓");
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  async function exportConfig() {
    try {
      const res = await fetchApi("/api/settings/backup");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `config-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
    } catch (e) {
      showToast("Erreur export: " + e.message, "error");
    }
  }

  async function runDiagnostic() {
    const div = el("diagnosticResult");
    if (!div) return;
    div.style.display = "block";
    div.innerHTML = "Diagnostic...";
    try {
      const res = await fetchApi("/api/settings/diagnostic");
      const data = await res.json();
      div.innerHTML = `
        <p>✅ Shopify: ${data.shopify?.status || 'unknown'}</p>
        <p>📦 Produits: ${data.data?.productCount || 0}</p>
        <p>📋 Plan: ${data.plan?.id || 'free'}</p>
      `;
    } catch (e) {
      div.innerHTML = `<p class="text-danger">Erreur: ${e.message}</p>`;
    }
  }

  async function resetAllSettings() {
    if (!confirm("Réinitialiser tous les paramètres ?")) return;
    try {
      await fetchApi("/api/settings/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      showToast("Paramètres réinitialisés ✓");
      await loadSettingsData();
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
  }

  function injectSettingsTab() {
    const tabs = document.querySelector(".tabs-container");
    if (!tabs || document.querySelector('[data-tab="settings"]')) return;

    const btn = document.createElement("button");
    btn.className = "tab-btn";
    btn.setAttribute("data-tab", "settings");
    btn.innerHTML = "⚙️ Paramètres";
    btn.onclick = switchToSettings;
    tabs.appendChild(btn);

    const main = document.querySelector(".main-content") || document.body;
    const tab = document.createElement("div");
    tab.id = "settings-tab";
    tab.className = "tab-content";
    tab.innerHTML = `
      <div class="settings-container">
        <div class="settings-header">
          <h2>⚙️ Paramètres</h2>
          <button class="btn btn-primary" id="saveSettingsBtn" disabled onclick="settingsUI.saveAllSettings()">💾 Enregistrer</button>
        </div>
        <div id="settingsSections"></div>
      </div>
    `;
    main.appendChild(tab);
  }

  function switchToSettings() {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelector('[data-tab="settings"]')?.classList.add("active");
    el("settings-tab")?.classList.add("active");
    if (!settingsState.settings) loadSettingsData();
  }

  function init() {
    setTimeout(() => {
      injectSettingsTab();
    }, 1000);
  }

  window.settingsUI = {
    init, toggleSection, onChange, saveAllSettings,
    exportConfig, runDiagnostic, resetAllSettings
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

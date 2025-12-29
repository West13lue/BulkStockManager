// alertChecker.js - Service de vérification et génération des alertes
const notificationStore = require("./notificationStore");
const stockState = require("./stockState");
const batchStore = require("./batchStore");
const settingsStore = require("./settingsStore");

/**
 * Vérifier toutes les alertes pour un shop
 */
async function checkAllAlerts(shopId) {
  console.log(`[AlertChecker] Checking alerts for ${shopId}...`);
  
  const results = {
    checked: new Date().toISOString(),
    newAlerts: 0,
    resolvedAlerts: 0,
    errors: []
  };
  
  try {
    // 1. Alertes de stock
    const stockAlerts = await checkStockAlerts(shopId);
    results.newAlerts += stockAlerts.new;
    results.resolvedAlerts += stockAlerts.resolved;
  } catch (e) {
    results.errors.push({ type: "stock", error: e.message });
  }
  
  try {
    // 2. Alertes DLC/Lots
    const lotAlerts = await checkLotAlerts(shopId);
    results.newAlerts += lotAlerts.new;
    results.resolvedAlerts += lotAlerts.resolved;
  } catch (e) {
    results.errors.push({ type: "lots", error: e.message });
  }
  
  try {
    // 3. Alertes de prévisions (si disponible)
    const forecastAlerts = await checkForecastAlerts(shopId);
    results.newAlerts += forecastAlerts.new;
  } catch (e) {
    // Forecast peut ne pas être disponible
    if (!e.message.includes("not found")) {
      results.errors.push({ type: "forecast", error: e.message });
    }
  }
  
  // Mettre à jour le timestamp
  notificationStore.updateLastCheck(shopId);
  
  // Nettoyer les anciennes alertes
  notificationStore.cleanupOldAlerts(shopId, 30);
  
  console.log(`[AlertChecker] ${shopId}: ${results.newAlerts} new, ${results.resolvedAlerts} resolved`);
  return results;
}

/**
 * Vérifier les alertes de stock
 */
async function checkStockAlerts(shopId) {
  const result = { new: 0, resolved: 0 };
  
  // Charger les données
  const stock = stockState.loadStock(shopId);
  const products = stock.products || [];
  const settings = settingsStore.loadSettings(shopId);
  
  // Seuils
  const criticalThreshold = settings.stock?.criticalThreshold || 50;
  const lowThreshold = settings.stock?.lowStockThreshold || 200;
  
  for (const product of products) {
    const stockGrams = product.stockGrams || 0;
    const productId = product.productId;
    const productName = product.name || "Produit inconnu";
    
    // Rupture de stock
    if (stockGrams <= 0) {
      const alert = notificationStore.addAlert(shopId, {
        type: "out_of_stock",
        priority: "critical",
        productId,
        productName,
        title: "Rupture de stock",
        message: `${productName} est en rupture de stock (0g)`,
        icon: "package-x",
        color: "danger",
        action: {
          type: "restock",
          label: "Réapprovisionner",
          tab: "products"
        },
        data: { stockGrams: 0 }
      });
      if (alert) result.new++;
      
      // Résoudre les alertes de stock bas/critique si en rupture
      result.resolved += notificationStore.resolveAlertsForProduct(shopId, productId, ["critical_stock", "low_stock"]);
    }
    // Stock critique
    else if (stockGrams < criticalThreshold) {
      const alert = notificationStore.addAlert(shopId, {
        type: "critical_stock",
        priority: "high",
        productId,
        productName,
        title: "Stock critique",
        message: `${productName}: ${formatWeight(stockGrams)} restants (seuil: ${formatWeight(criticalThreshold)})`,
        icon: "alert-triangle",
        color: "warning",
        action: {
          type: "restock",
          label: "Commander",
          tab: "products"
        },
        data: { stockGrams, threshold: criticalThreshold }
      });
      if (alert) result.new++;
      
      // Résoudre les alertes de rupture si stock > 0
      result.resolved += notificationStore.resolveAlertsForProduct(shopId, productId, ["out_of_stock"]);
      // Résoudre les alertes de stock bas
      result.resolved += notificationStore.resolveAlertsForProduct(shopId, productId, ["low_stock"]);
    }
    // Stock bas
    else if (stockGrams < lowThreshold) {
      const alert = notificationStore.addAlert(shopId, {
        type: "low_stock",
        priority: "normal",
        productId,
        productName,
        title: "Stock bas",
        message: `${productName}: ${formatWeight(stockGrams)} restants`,
        icon: "package",
        color: "info",
        action: {
          type: "view",
          label: "Voir",
          tab: "products"
        },
        data: { stockGrams, threshold: lowThreshold }
      });
      if (alert) result.new++;
      
      // Résoudre les alertes plus critiques
      result.resolved += notificationStore.resolveAlertsForProduct(shopId, productId, ["out_of_stock", "critical_stock"]);
    }
    // Stock OK - résoudre toutes les alertes de stock
    else {
      result.resolved += notificationStore.resolveAlertsForProduct(shopId, productId, ["out_of_stock", "critical_stock", "low_stock"]);
    }
  }
  
  return result;
}

/**
 * Vérifier les alertes de lots/DLC
 */
async function checkLotAlerts(shopId) {
  const result = { new: 0, resolved: 0 };
  
  // Charger les lots
  let allLots;
  try {
    allLots = batchStore.loadBatches(shopId);
  } catch (e) {
    return result; // Pas de lots
  }
  
  const now = new Date();
  
  for (const [productId, lots] of Object.entries(allLots)) {
    for (const lot of lots) {
      // Ignorer les lots inactifs ou sans date
      if (lot.status !== "active" || !lot.expiryDate) continue;
      
      const expiryDate = new Date(lot.expiryDate);
      const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      const productName = lot.productName || "Produit";
      const lotNumber = lot.lotNumber || lot.id;
      
      // Lot expiré
      if (daysLeft < 0) {
        const alert = notificationStore.addAlert(shopId, {
          type: "lot_expired",
          priority: "critical",
          productId,
          lotId: lot.id,
          productName,
          title: "Lot expiré",
          message: `Lot ${lotNumber} de ${productName} a expiré le ${formatDate(lot.expiryDate)}`,
          icon: "calendar-x",
          color: "danger",
          action: {
            type: "view_lot",
            label: "Traiter",
            tab: "batches"
          },
          data: { lotNumber, expiryDate: lot.expiryDate, daysLeft }
        });
        if (alert) result.new++;
      }
      // Expire dans 7 jours
      else if (daysLeft <= 7) {
        const alert = notificationStore.addAlert(shopId, {
          type: "lot_expiring_7",
          priority: "high",
          productId,
          lotId: lot.id,
          productName,
          title: "Expiration imminente",
          message: `Lot ${lotNumber} de ${productName} expire dans ${daysLeft} jour(s)`,
          icon: "calendar-clock",
          color: "warning",
          action: {
            type: "view_lot",
            label: "Voir",
            tab: "batches"
          },
          data: { lotNumber, expiryDate: lot.expiryDate, daysLeft }
        });
        if (alert) result.new++;
      }
      // Expire dans 15 jours
      else if (daysLeft <= 15) {
        const alert = notificationStore.addAlert(shopId, {
          type: "lot_expiring_15",
          priority: "normal",
          productId,
          lotId: lot.id,
          productName,
          title: "Expiration proche",
          message: `Lot ${lotNumber} de ${productName} expire dans ${daysLeft} jours`,
          icon: "calendar",
          color: "info",
          action: {
            type: "view_lot",
            label: "Voir",
            tab: "batches"
          },
          data: { lotNumber, expiryDate: lot.expiryDate, daysLeft }
        });
        if (alert) result.new++;
      }
      // Expire dans 30 jours
      else if (daysLeft <= 30) {
        const alert = notificationStore.addAlert(shopId, {
          type: "lot_expiring_30",
          priority: "low",
          productId,
          lotId: lot.id,
          productName,
          title: "Expiration à surveiller",
          message: `Lot ${lotNumber} de ${productName} expire dans ${daysLeft} jours`,
          icon: "calendar",
          color: "secondary",
          action: {
            type: "view_lot",
            label: "Voir",
            tab: "batches"
          },
          data: { lotNumber, expiryDate: lot.expiryDate, daysLeft }
        });
        if (alert) result.new++;
      }
    }
  }
  
  return result;
}

/**
 * Vérifier les alertes de prévisions
 */
async function checkForecastAlerts(shopId) {
  const result = { new: 0 };
  
  // Essayer de charger le forecastManager
  let forecastManager;
  try {
    forecastManager = require("./forecastManager");
  } catch (e) {
    return result; // Module non disponible
  }
  
  try {
    const forecast = await forecastManager.getForecast(shopId, { windowDays: 14 });
    
    for (const item of (forecast.items || [])) {
      if (item.status === "critical" || item.status === "out") {
        const alert = notificationStore.addAlert(shopId, {
          type: "forecast_critical",
          priority: "high",
          productId: item.productId,
          productName: item.productName,
          title: "Rupture prévue",
          message: `${item.productName}: rupture estimée ${item.stockoutDate ? "le " + item.stockoutDate : "imminente"}`,
          icon: "trending-down",
          color: "danger",
          action: {
            type: "create_po",
            label: "Commander",
            tab: "forecast"
          },
          data: {
            daysOfStock: item.daysOfStock,
            stockoutDate: item.stockoutDate,
            reorderQty: item.reorderQty
          }
        });
        if (alert) result.new++;
      }
      else if (item.status === "urgent") {
        const alert = notificationStore.addAlert(shopId, {
          type: "forecast_urgent",
          priority: "normal",
          productId: item.productId,
          productName: item.productName,
          title: "Stock à surveiller",
          message: `${item.productName}: ${item.daysOfStock} jours de stock restants`,
          icon: "eye",
          color: "warning",
          action: {
            type: "view",
            label: "Voir",
            tab: "forecast"
          },
          data: {
            daysOfStock: item.daysOfStock,
            stockoutDate: item.stockoutDate
          }
        });
        if (alert) result.new++;
      }
    }
  } catch (e) {
    // Forecast non disponible ou erreur
  }
  
  return result;
}

/**
 * Vérifier si une vente a une marge négative
 */
function checkSaleMargin(shopId, sale) {
  if (sale.margin < 0 || sale.marginPercent < 0) {
    return notificationStore.addAlert(shopId, {
      type: "negative_margin",
      priority: "high",
      productId: sale.productId,
      productName: sale.productName,
      orderId: sale.orderId,
      title: "Marge négative",
      message: `Vente de ${sale.productName} avec marge de ${sale.marginPercent.toFixed(1)}%`,
      icon: "trending-down",
      color: "danger",
      action: {
        type: "view_order",
        label: "Voir",
        tab: "orders"
      },
      data: {
        revenue: sale.revenue,
        cost: sale.cost,
        margin: sale.margin,
        marginPercent: sale.marginPercent
      }
    });
  }
  return null;
}

// Helpers
function formatWeight(grams) {
  if (grams >= 1000) {
    return (grams / 1000).toFixed(2) + " kg";
  }
  return grams.toFixed(0) + " g";
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("fr-FR");
}

module.exports = {
  checkAllAlerts,
  checkStockAlerts,
  checkLotAlerts,
  checkForecastAlerts,
  checkSaleMargin
};

// notificationStore.js - Gestion des notifications et alertes
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getNotificationsPath(shopId) {
  return path.join(DATA_DIR, shopId, "notifications.json");
}

function loadNotifications(shopId) {
  const filePath = getNotificationsPath(shopId);
  ensureDir(path.dirname(filePath));
  
  if (!fs.existsSync(filePath)) {
    return {
      alerts: [],
      settings: {
        enabled: true,
        emailEnabled: false,
        emailAddress: "",
        digestFrequency: "daily", // daily, weekly, realtime
        triggers: {
          outOfStock: true,
          criticalStock: true,
          lowStock: true,
          lotExpiring7: true,
          lotExpiring15: false,
          lotExpiring30: false,
          lotExpired: true,
          forecastCritical: true,
          forecastUrgent: false,
          poToReceive: true,
          negativeSale: true
        },
        quietHours: {
          enabled: false,
          start: "22:00",
          end: "08:00"
        }
      },
      lastCheck: null,
      lastEmailSent: null
    };
  }
  
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error("[NotificationStore] Error loading:", e.message);
    return { alerts: [], settings: {}, lastCheck: null };
  }
}

function saveNotifications(shopId, data) {
  const filePath = getNotificationsPath(shopId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Ajoute une alerte (évite les doublons)
 */
function addAlert(shopId, alert) {
  const data = loadNotifications(shopId);
  
  // Vérifier si l'alerte est activée dans les settings
  const triggerKey = mapAlertTypeToTrigger(alert.type);
  if (triggerKey && data.settings.triggers && data.settings.triggers[triggerKey] === false) {
    return data.alerts; // Alerte désactivée par l'utilisateur
  }
  
  // Éviter les doublons (même type + même produit/lot + non ignoré)
  const exists = data.alerts.find(a => 
    a.type === alert.type && 
    a.productId === alert.productId && 
    a.lotId === alert.lotId &&
    !a.dismissed &&
    !a.resolved
  );
  
  if (!exists) {
    const newAlert = {
      id: "alert_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
      ...alert,
      createdAt: new Date().toISOString(),
      read: false,
      dismissed: false,
      resolved: false,
      emailSent: false
    };
    
    data.alerts.unshift(newAlert);
    
    // Garder max 200 alertes
    if (data.alerts.length > 200) {
      data.alerts = data.alerts.slice(0, 200);
    }
    
    saveNotifications(shopId, data);
    return newAlert;
  }
  
  return null;
}

/**
 * Map type d'alerte vers clé de trigger
 */
function mapAlertTypeToTrigger(type) {
  const map = {
    "out_of_stock": "outOfStock",
    "critical_stock": "criticalStock",
    "low_stock": "lowStock",
    "lot_expired": "lotExpired",
    "lot_expiring_7": "lotExpiring7",
    "lot_expiring_15": "lotExpiring15",
    "lot_expiring_30": "lotExpiring30",
    "forecast_critical": "forecastCritical",
    "forecast_urgent": "forecastUrgent",
    "po_to_receive": "poToReceive",
    "negative_margin": "negativeSale"
  };
  return map[type] || null;
}

/**
 * Récupérer les alertes avec filtres
 */
function getAlerts(shopId, options = {}) {
  const data = loadNotifications(shopId);
  let alerts = data.alerts || [];
  
  // Filtrer par statut
  if (options.unreadOnly) {
    alerts = alerts.filter(a => !a.read && !a.dismissed && !a.resolved);
  }
  if (options.excludeDismissed !== false) {
    alerts = alerts.filter(a => !a.dismissed);
  }
  if (options.excludeResolved !== false) {
    alerts = alerts.filter(a => !a.resolved);
  }
  
  // Filtrer par priorité
  if (options.priority) {
    alerts = alerts.filter(a => a.priority === options.priority);
  }
  
  // Filtrer par type
  if (options.type) {
    alerts = alerts.filter(a => a.type === options.type);
  }
  
  // Limiter
  if (options.limit) {
    alerts = alerts.slice(0, options.limit);
  }
  
  return alerts;
}

/**
 * Compter les alertes non lues
 */
function getUnreadCount(shopId) {
  const data = loadNotifications(shopId);
  return (data.alerts || []).filter(a => !a.read && !a.dismissed && !a.resolved).length;
}

/**
 * Compter par priorité
 */
function getCountByPriority(shopId) {
  const data = loadNotifications(shopId);
  const active = (data.alerts || []).filter(a => !a.dismissed && !a.resolved);
  
  return {
    critical: active.filter(a => a.priority === "critical").length,
    high: active.filter(a => a.priority === "high").length,
    normal: active.filter(a => a.priority === "normal").length,
    total: active.length
  };
}

/**
 * Marquer comme lu
 */
function markAsRead(shopId, alertId) {
  const data = loadNotifications(shopId);
  const alert = data.alerts.find(a => a.id === alertId);
  if (alert) {
    alert.read = true;
    alert.readAt = new Date().toISOString();
    saveNotifications(shopId, data);
    return true;
  }
  return false;
}

/**
 * Marquer tout comme lu
 */
function markAllAsRead(shopId) {
  const data = loadNotifications(shopId);
  let count = 0;
  data.alerts.forEach(a => {
    if (!a.read && !a.dismissed) {
      a.read = true;
      a.readAt = new Date().toISOString();
      count++;
    }
  });
  saveNotifications(shopId, data);
  return count;
}

/**
 * Ignorer une alerte
 */
function dismissAlert(shopId, alertId) {
  const data = loadNotifications(shopId);
  const alert = data.alerts.find(a => a.id === alertId);
  if (alert) {
    alert.dismissed = true;
    alert.dismissedAt = new Date().toISOString();
    saveNotifications(shopId, data);
    return true;
  }
  return false;
}

/**
 * Résoudre une alerte (problème corrigé)
 */
function resolveAlert(shopId, alertId) {
  const data = loadNotifications(shopId);
  const alert = data.alerts.find(a => a.id === alertId);
  if (alert) {
    alert.resolved = true;
    alert.resolvedAt = new Date().toISOString();
    saveNotifications(shopId, data);
    return true;
  }
  return false;
}

/**
 * Résoudre les alertes d'un produit (quand le problème est corrigé)
 */
function resolveAlertsForProduct(shopId, productId, types = []) {
  const data = loadNotifications(shopId);
  let count = 0;
  
  data.alerts.forEach(a => {
    if (a.productId === productId && !a.resolved && !a.dismissed) {
      if (types.length === 0 || types.includes(a.type)) {
        a.resolved = true;
        a.resolvedAt = new Date().toISOString();
        count++;
      }
    }
  });
  
  if (count > 0) {
    saveNotifications(shopId, data);
  }
  return count;
}

/**
 * Mettre à jour les paramètres
 */
function updateSettings(shopId, newSettings) {
  const data = loadNotifications(shopId);
  data.settings = { ...data.settings, ...newSettings };
  saveNotifications(shopId, data);
  return data.settings;
}

/**
 * Récupérer les paramètres
 */
function getSettings(shopId) {
  const data = loadNotifications(shopId);
  return data.settings || {};
}

/**
 * Mettre à jour le timestamp de dernière vérification
 */
function updateLastCheck(shopId) {
  const data = loadNotifications(shopId);
  data.lastCheck = new Date().toISOString();
  saveNotifications(shopId, data);
}

/**
 * Nettoyer les anciennes alertes (> 30 jours)
 */
function cleanupOldAlerts(shopId, daysToKeep = 30) {
  const data = loadNotifications(shopId);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);
  
  const before = data.alerts.length;
  data.alerts = data.alerts.filter(a => {
    const createdAt = new Date(a.createdAt);
    return createdAt > cutoff || (!a.dismissed && !a.resolved);
  });
  
  const removed = before - data.alerts.length;
  if (removed > 0) {
    saveNotifications(shopId, data);
  }
  return removed;
}

module.exports = {
  loadNotifications,
  saveNotifications,
  addAlert,
  getAlerts,
  getUnreadCount,
  getCountByPriority,
  markAsRead,
  markAllAsRead,
  dismissAlert,
  resolveAlert,
  resolveAlertsForProduct,
  updateSettings,
  getSettings,
  updateLastCheck,
  cleanupOldAlerts
};
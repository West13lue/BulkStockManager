// planManager.js — Gestion des plans (Free/Starter/Pro/Business/Enterprise)
// v2.0 - Nouveau pricing avec fonctionnalités avancées

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// BYPASS BILLING - Boutiques avec accès gratuit
// ============================================

const BYPASS_BILLING = {
  // Ta boutique - accès Enterprise gratuit
  "e4vkqa-ea.myshopify.com": "enterprise",
  
  // Ajoute d'autres boutiques ici si besoin :
  // "autre-boutique.myshopify.com": "business",
  // "test-store.myshopify.com": "pro",
};

/**
 * Vérifie si une boutique a un bypass billing
 * @param {string} shop - Domaine de la boutique
 * @returns {string|null} - Plan accordé ou null
 */
function getBypassPlan(shop) {
  if (!shop) return null;
  
  // Normaliser le shop pour matcher toutes les variantes possibles
  let normalizedShop = String(shop).toLowerCase().trim();
  normalizedShop = normalizedShop.replace(/^https?:\/\//, ''); // Enlever http(s)://
  normalizedShop = normalizedShop.replace(/\/$/, '');          // Enlever trailing slash
  normalizedShop = normalizedShop.replace(/^www\./, '');       // Enlever www.
  
  // Essayer le match direct
  if (BYPASS_BILLING[normalizedShop]) {
    return BYPASS_BILLING[normalizedShop];
  }
  
  // Essayer avec .myshopify.com si pas présent
  if (!normalizedShop.includes('.myshopify.com')) {
    const withSuffix = normalizedShop + '.myshopify.com';
    if (BYPASS_BILLING[withSuffix]) {
      return BYPASS_BILLING[withSuffix];
    }
  }
  
  // Essayer juste le préfixe (avant .myshopify.com)
  const prefix = normalizedShop.replace('.myshopify.com', '');
  for (const [key, plan] of Object.entries(BYPASS_BILLING)) {
    if (key.startsWith(prefix) || prefix.startsWith(key.replace('.myshopify.com', ''))) {
      return plan;
    }
  }
  
  return null;
}

/**
 * Vérifie si une boutique bypass le billing
 * @param {string} shop - Domaine de la boutique
 * @returns {boolean}
 */
function hasBypassBilling(shop) {
  return getBypassPlan(shop) !== null;
}

// ============================================
// DÉFINITION DES PLANS v2.0
// ============================================

const PLANS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    priceYearly: 0,
    currency: "EUR",
    badge: null,
    limits: {
      maxProducts: 2,
      maxUsers: 1,
      movementHistoryDays: 7,
      hasCategories: false,
      hasShopifyImport: false,
      hasStockValue: false,
      hasAnalytics: false,
      hasAdvancedExports: false,
      hasTrends: false,
      hasBatchTracking: false,
      hasSuppliers: false,
      hasPurchaseOrders: false,
      hasInventoryCount: false,
      hasForecast: false,
      hasKits: false,
      hasMultiUsers: false,
      hasAutomations: false,
      hasIntegrations: false,
      hasReports: false,
      hasMultiStore: false,
      hasApi: false,
      hasPrioritySupport: false,
      hasNotifications: false,
      hasFreebies: false,
    },
    features: [
      "2 produits maximum",
      "Gestion stock + sync Shopify",
      "CMP (coût moyen) basique",
      "Ajustements manuels",
      "Export CSV simple",
    ],
    cta: "Commencer gratuitement",
  },

  starter: {
    id: "starter",
    name: "Starter",
    price: 14.99,
    priceYearly: 143.90,
    currency: "EUR",
    badge: null,
    limits: {
      maxProducts: 15,
      maxUsers: 1,
      movementHistoryDays: 30,
      hasCategories: true,
      hasShopifyImport: true,
      hasStockValue: true,
      hasAnalytics: false,
      hasAdvancedExports: true,
      hasTrends: false,
      hasBatchTracking: false,
      hasSuppliers: false,
      hasPurchaseOrders: false,
      hasInventoryCount: false,
      hasForecast: false,
      hasKits: false,
      hasMultiUsers: false,
      hasAutomations: false,
      hasIntegrations: false,
      hasReports: false,
      hasMultiStore: false,
      hasApi: false,
      hasPrioritySupport: false,
      hasNotifications: false,
      hasFreebies: false,
    },
    features: [
      "15 produits",
      "Tout Free +",
      "Catégories & filtres",
      "Import Shopify",
      "Valeur totale stock",
      "Historique 30 jours",
      "Exports CSV avancés",
    ],
    cta: "Essai gratuit 14 jours",
  },

  pro: {
    id: "pro",
    name: "Pro",
    price: 39.99,
    priceYearly: 383.90,
    currency: "EUR",
    badge: "POPULAIRE",
    limits: {
      maxProducts: 75,
      maxUsers: 2,
      movementHistoryDays: 90,
      hasCategories: true,
      hasShopifyImport: true,
      hasStockValue: true,
      hasAnalytics: true,
      hasAdvancedExports: true,
      hasTrends: true,
      hasBatchTracking: true,
      hasSuppliers: true,
      hasPurchaseOrders: false,
      hasInventoryCount: true,
      hasForecast: false,
      hasKits: false,
      hasMultiUsers: false,
      hasAutomations: false,
      hasIntegrations: false,
      hasReports: false,
      hasMultiStore: false,
      hasApi: false,
      hasPrioritySupport: false,
      hasNotifications: true,
      hasFreebies: true,
    },
    features: [
      "75 produits",
      "Tout Starter +",
      "📦 Lots / DLC / Traçabilité",
      "🏭 Gestion fournisseurs",
      "📋 Inventaire physique",
      "📊 Analytics (CA, marges)",
      "🔔 Notifications Slack/Discord",
      "🎁 Gestion freebies",
      "Historique 90 jours",
    ],
    cta: "Essai gratuit 14 jours",
  },

  business: {
    id: "business",
    name: "Business",
    price: 79.99,
    priceYearly: 767.90,
    currency: "EUR",
    badge: "BEST VALUE",
    limits: {
      maxProducts: Infinity,
      maxUsers: 5,
      movementHistoryDays: 365,
      hasCategories: true,
      hasShopifyImport: true,
      hasStockValue: true,
      hasAnalytics: true,
      hasAdvancedExports: true,
      hasTrends: true,
      hasBatchTracking: true,
      hasSuppliers: true,
      hasPurchaseOrders: true,
      hasInventoryCount: true,
      hasForecast: true,
      hasKits: true,
      hasMultiUsers: true,
      hasAutomations: true,
      hasIntegrations: true,
      hasReports: true,
      hasMultiStore: false,
      hasApi: false,
      hasPrioritySupport: true,
      hasNotifications: true,
      hasFreebies: true,
    },
    features: [
      "Produits illimités",
      "Tout Pro +",
      "🔮 Prévisions de rupture (IA)",
      "🧩 Kits / Bundles / Composés",
      "📝 Bons de commande (PO)",
      "👥 Multi-utilisateurs (5)",
      "⚡ Automatisations",
      "🔗 Intégrations (Zapier)",
      "📧 Rapports auto par email",
      "⭐ Support prioritaire",
      "Historique 1 an",
    ],
    cta: "Essai gratuit 14 jours",
  },

  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 199,
    priceYearly: 1990,
    currency: "EUR",
    badge: "ENTREPRISE",
    limits: {
      maxProducts: Infinity,
      maxUsers: Infinity,
      movementHistoryDays: Infinity,
      hasCategories: true,
      hasShopifyImport: true,
      hasStockValue: true,
      hasAnalytics: true,
      hasAdvancedExports: true,
      hasTrends: true,
      hasBatchTracking: true,
      hasSuppliers: true,
      hasPurchaseOrders: true,
      hasInventoryCount: true,
      hasForecast: true,
      hasKits: true,
      hasMultiUsers: true,
      hasAutomations: true,
      hasIntegrations: true,
      hasReports: true,
      hasMultiStore: true,
      hasApi: true,
      hasPrioritySupport: true,
      hasNotifications: true,
      hasFreebies: true,
    },
    features: [
      "Tout Business +",
      "🏪 Multi-boutiques",
      "👥 Utilisateurs illimités",
      "🔌 Accès API complet",
      "📊 Historique illimité",
      "🎯 Account manager dédié",
      "📞 Support téléphonique",
      "🔧 Onboarding personnalisé",
      "📜 SLA garanti 99.9%",
    ],
    cta: "Contacter les ventes",
    contactSales: true,
  },
};

const PLAN_ORDER = ["free", "starter", "pro", "business", "enterprise"];

const FEATURE_DESCRIPTIONS = {
  hasCategories: { name: "Catégories", icon: "🏷️", description: "Organiser vos produits" },
  hasShopifyImport: { name: "Import Shopify", icon: "📥", description: "Importer depuis Shopify" },
  hasStockValue: { name: "Valeur stock", icon: "💰", description: "Valeur totale du stock" },
  hasAnalytics: { name: "Analytics", icon: "📊", description: "Stats ventes et marges" },
  hasBatchTracking: { name: "Lots & DLC", icon: "📦", description: "Traçabilité, péremption" },
  hasSuppliers: { name: "Fournisseurs", icon: "🏭", description: "Gestion fournisseurs" },
  hasPurchaseOrders: { name: "Bons de commande", icon: "📝", description: "PO fournisseurs" },
  hasInventoryCount: { name: "Inventaire", icon: "📋", description: "Comptage physique" },
  hasForecast: { name: "Prévisions", icon: "🔮", description: "Prédiction ruptures" },
  hasKits: { name: "Kits & Bundles", icon: "🧩", description: "Produits composés" },
  hasMultiUsers: { name: "Multi-utilisateurs", icon: "👥", description: "Équipe" },
  hasAutomations: { name: "Automatisations", icon: "⚡", description: "Règles auto" },
  hasIntegrations: { name: "Intégrations", icon: "🔗", description: "Zapier, webhooks" },
  hasReports: { name: "Rapports auto", icon: "📧", description: "Emails hebdo" },
  hasMultiStore: { name: "Multi-boutiques", icon: "🏪", description: "Plusieurs shops" },
  hasApi: { name: "Accès API", icon: "🔌", description: "API REST" },
  hasNotifications: { name: "Notifications", icon: "🔔", description: "Slack, Discord" },
  hasFreebies: { name: "Freebies", icon: "🎁", description: "Échantillons" },
};

// ============================================
// Helpers
// ============================================

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s ? s.replace(/[^a-z0-9._-]/g, "_") : "default";
}

function shopDir(shop) {
  return path.join(DATA_DIR, sanitizeShop(shop));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function planFile(shop) {
  ensureDir(shopDir(shop));
  return path.join(shopDir(shop), "plan.json");
}

// ============================================
// CRUD Plan
// ============================================

function getShopPlan(shop) {
  // ============================================
  // BYPASS BILLING CHECK - Priorité absolue
  // ============================================
  console.log(`🔍 PLAN CHECK for shop: "${shop}"`);
  
  const bypassPlan = getBypassPlan(shop);
  if (bypassPlan) {
    const plan = PLANS[bypassPlan] || PLANS.enterprise;
    console.log(`🎁 BYPASS BILLING ACTIVATED: "${shop}" → Plan ${plan.name} (gratuit)`);
    return {
      planId: plan.id,
      plan,
      subscription: {
        id: "bypass_" + Date.now(),
        status: "active",
        startedAt: "2024-01-01T00:00:00.000Z",
        expiresAt: null, // Jamais d'expiration
        chargeId: null,
        interval: "lifetime",
        bypass: true, // Marqueur bypass
      },
      limits: plan.limits,
      features: plan.features,
      trialEndsAt: null,
      grandfathered: true,
      bypass: true,
    };
  } else {
    console.log(`❌ NO BYPASS for "${shop}" - checking normal plan...`);
  }

  // ============================================
  // Fonctionnement normal
  // ============================================
  const file = planFile(shop);
  let data = { planId: "free" };

  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    console.warn("Erreur lecture plan:", e.message);
  }

  // Migration anciens plans
  let planId = String(data.planId || "free").toLowerCase();
  if (planId === "standard") planId = "starter";
  if (planId === "premium") planId = "pro";

  const plan = PLANS[planId] || PLANS.free;

  return {
    planId: plan.id,
    plan,
    subscription: data.subscription || null,
    limits: plan.limits,
    features: plan.features,
    trialEndsAt: data.trialEndsAt || null,
    grandfathered: data.grandfathered || false,
  };
}

function setShopPlan(shop, planId, subscription = null, options = {}) {
  const file = planFile(shop);
  const normalizedPlanId = String(planId || "free").toLowerCase();

  if (!PLANS[normalizedPlanId]) throw new Error(`Plan inconnu: ${planId}`);

  const existing = getShopPlan(shop);

  const data = {
    planId: normalizedPlanId,
    subscription: subscription ? {
      id: subscription.id || null,
      status: subscription.status || "active",
      startedAt: subscription.startedAt || new Date().toISOString(),
      expiresAt: subscription.expiresAt || null,
      chargeId: subscription.chargeId || null,
      interval: subscription.interval || "monthly",
    } : null,
    trialEndsAt: options.trialEndsAt || null,
    grandfathered: options.grandfathered || existing.grandfathered || false,
    previousPlan: existing.planId,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);

  return getShopPlan(shop);
}

function startTrial(shop, planId, durationDays = 14) {
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + durationDays);

  return setShopPlan(shop, planId, {
    id: `trial_${Date.now()}`,
    status: "trialing",
    startedAt: new Date().toISOString(),
  }, { trialEndsAt: trialEndsAt.toISOString() });
}

function isTrialExpired(shop) {
  const { subscription, trialEndsAt } = getShopPlan(shop);
  if (subscription?.status !== "trialing" || !trialEndsAt) return false;
  return new Date(trialEndsAt) < new Date();
}

function cancelSubscription(shop) {
  return setShopPlan(shop, "free", null);
}

// ============================================
// VÉRIFICATION DES LIMITES
// ============================================

function checkLimit(shop, action, context = {}) {
  const { limits, planId, subscription } = getShopPlan(shop);

  if (subscription?.status === "trialing" && isTrialExpired(shop)) {
    return { allowed: false, reason: "Période d'essai terminée", upgrade: "starter", trialExpired: true };
  }

  const featureChecks = {
    import_shopify: ["hasShopifyImport", "Import Shopify", "starter"],
    view_categories: ["hasCategories", "Catégories", "starter"],
    manage_categories: ["hasCategories", "Catégories", "starter"],
    view_stock_value: ["hasStockValue", "Valeur stock", "starter"],
    view_analytics: ["hasAnalytics", "Analytics", "pro"],
    export_analytics: ["hasAnalytics", "Analytics", "pro"],
    view_trends: ["hasTrends", "Tendances", "pro"],
    manage_batches: ["hasBatchTracking", "Lots & DLC", "pro"],
    view_batches: ["hasBatchTracking", "Lots & DLC", "pro"],
    manage_suppliers: ["hasSuppliers", "Fournisseurs", "pro"],
    view_suppliers: ["hasSuppliers", "Fournisseurs", "pro"],
    manage_purchase_orders: ["hasPurchaseOrders", "Bons de commande", "business"],
    view_purchase_orders: ["hasPurchaseOrders", "Bons de commande", "business"],
    inventory_count: ["hasInventoryCount", "Inventaire", "pro"],
    view_forecast: ["hasForecast", "Prévisions", "business"],
    manage_kits: ["hasKits", "Kits & Bundles", "business"],
    view_kits: ["hasKits", "Kits & Bundles", "business"],
    manage_users: ["hasMultiUsers", "Multi-utilisateurs", "business"],
    manage_automations: ["hasAutomations", "Automatisations", "business"],
    use_integrations: ["hasIntegrations", "Intégrations", "business"],
    manage_reports: ["hasReports", "Rapports auto", "business"],
    multi_store: ["hasMultiStore", "Multi-boutiques", "enterprise"],
    use_api: ["hasApi", "Accès API", "enterprise"],
    manage_notifications: ["hasNotifications", "Notifications", "pro"],
    manage_freebies: ["hasFreebies", "Freebies", "pro"],
    advanced_export: ["hasAdvancedExports", "Exports avancés", "starter"],
  };

  if (action === "add_product") {
    const currentCount = Number(context.currentProductCount || 0);
    if (limits.maxProducts !== Infinity && currentCount >= limits.maxProducts) {
      return {
        allowed: false,
        reason: `Limite de ${limits.maxProducts} produit(s) atteinte`,
        upgrade: getNextPlan(planId),
        limit: limits.maxProducts,
        current: currentCount,
      };
    }
    return { allowed: true };
  }

  if (action === "add_user") {
    const currentUsers = Number(context.currentUserCount || 1);
    if (limits.maxUsers !== Infinity && currentUsers >= limits.maxUsers) {
      return {
        allowed: false,
        reason: `Limite de ${limits.maxUsers} utilisateur(s)`,
        upgrade: "business",
      };
    }
    return { allowed: true };
  }

  if (action === "view_movements") {
    const requestedDays = Number(context.days || 7);
    const maxDays = limits.movementHistoryDays === Infinity ? 9999 : limits.movementHistoryDays;
    if (requestedDays > maxDays) {
      return { allowed: true, limitedTo: maxDays, reason: `Historique limité à ${maxDays} jours` };
    }
    return { allowed: true };
  }

  if (featureChecks[action]) {
    const [key, name, required] = featureChecks[action];
    if (!limits[key]) {
      return { allowed: false, reason: `${name} non disponible`, upgrade: required, feature: name };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

function getNextPlan(currentPlanId) {
  const idx = PLAN_ORDER.indexOf(currentPlanId);
  return PLAN_ORDER[idx + 1] || "enterprise";
}

function applyMovementDaysLimit(shop, requestedDays) {
  const { limits } = getShopPlan(shop);
  const max = limits.movementHistoryDays === Infinity ? 9999 : limits.movementHistoryDays;
  return Math.min(Number(requestedDays || 7), max);
}

function canAddProduct(shop, currentProductCount) {
  return checkLimit(shop, "add_product", { currentProductCount }).allowed;
}

function getRemainingProducts(shop, currentProductCount) {
  const { limits } = getShopPlan(shop);
  if (limits.maxProducts === Infinity) return Infinity;
  return Math.max(0, limits.maxProducts - currentProductCount);
}

function hasFeature(shop, featureKey) {
  const { limits } = getShopPlan(shop);
  return limits[featureKey] === true;
}

// ============================================
// INFOS POUR LE FRONTEND
// ============================================

function getPlanInfoForUI(shop, currentProductCount = 0, currentUserCount = 1) {
  const { planId, plan, subscription, limits, features, trialEndsAt, grandfathered } = getShopPlan(shop);

  let trialDaysLeft = null;
  if (subscription?.status === "trialing" && trialEndsAt) {
    const diff = new Date(trialEndsAt) - new Date();
    trialDaysLeft = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  return {
    current: {
      planId,
      name: plan.name,
      price: plan.price,
      priceYearly: plan.priceYearly,
      currency: plan.currency,
      badge: plan.badge,
      features,
    },
    limits: {
      maxProducts: limits.maxProducts === Infinity ? "Illimité" : limits.maxProducts,
      maxProductsNum: limits.maxProducts,
      maxUsers: limits.maxUsers === Infinity ? "Illimité" : limits.maxUsers,
      maxUsersNum: limits.maxUsers,
      movementHistoryDays: limits.movementHistoryDays === Infinity ? "Illimité" : limits.movementHistoryDays,
      ...limits,
    },
    usage: {
      productCount: currentProductCount,
      userCount: currentUserCount,
      remainingProducts: getRemainingProducts(shop, currentProductCount),
      productLimitReached: !canAddProduct(shop, currentProductCount),
      percentUsed: limits.maxProducts === Infinity ? 0 : Math.round((currentProductCount / limits.maxProducts) * 100),
    },
    subscription: subscription ? {
      status: subscription.status,
      startedAt: subscription.startedAt,
      expiresAt: subscription.expiresAt,
      interval: subscription.interval,
    } : null,
    trial: {
      active: subscription?.status === "trialing",
      endsAt: trialEndsAt,
      daysLeft: trialDaysLeft,
      expired: isTrialExpired(shop),
    },
    grandfathered,
    availablePlans: PLAN_ORDER.map(id => {
      const p = PLANS[id];
      return {
        id: p.id,
        name: p.name,
        price: p.price,
        priceYearly: p.priceYearly,
        currency: p.currency,
        badge: p.badge,
        features: p.features,
        isCurrent: p.id === planId,
        isUpgrade: PLAN_ORDER.indexOf(p.id) > PLAN_ORDER.indexOf(planId),
        cta: p.cta,
        contactSales: p.contactSales || false,
      };
    }),
    featureDescriptions: FEATURE_DESCRIPTIONS,
  };
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  FEATURE_DESCRIPTIONS,
  
  // Bypass billing
  BYPASS_BILLING,
  getBypassPlan,
  hasBypassBilling,
  
  // CRUD
  getShopPlan,
  setShopPlan,
  startTrial,
  isTrialExpired,
  cancelSubscription,
  checkLimit,
  applyMovementDaysLimit,
  canAddProduct,
  getRemainingProducts,
  hasFeature,
  getPlanInfoForUI,
  sanitizeShop,
};

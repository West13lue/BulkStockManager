// planManager.js â€” Gestion des plans (Free/Starter/Pro/Business/Enterprise)
// v2.0 - Nouveau pricing avec fonctionnalites avancees

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ============================================
// BYPASS BILLING - Boutiques avec acces gratuit
// ============================================

const BYPASS_BILLING = {
  // Ta boutique - acces Enterprise gratuit (tous les formats possibles)
  "e4vkqa-ea.myshopify.com": "enterprise",
  "cloud-store-cbd.com": "enterprise",
  "www.cloud-store-cbd.com": "enterprise",
  
  // Ajoute d'autres boutiques ici si besoin :
  // "autre-boutique.myshopify.com": "business",
};

/**
 * Verifie si une boutique a un bypass billing
 * @param {string} shop - Domaine de la boutique
 * @returns {string|null} - Plan accorde ou null
 */
function getBypassPlan(shop) {
  if (!shop) return null;
  
  // Normaliser le shop pour matcher toutes les variantes possibles
  let normalizedShop = String(shop).toLowerCase().trim();
  normalizedShop = normalizedShop.replace(/^https?:\/\//, ''); // Enlever http(s)://
  normalizedShop = normalizedShop.replace(/\/$/, '');          // Enlever trailing slash
  
  console.log(`ðŸ”Ž BYPASS CHECK: original="${shop}" normalized="${normalizedShop}"`);
  
  // Essayer le match direct (avec et sans www)
  if (BYPASS_BILLING[normalizedShop]) {
    console.log(`âœ… BYPASS MATCH DIRECT: ${normalizedShop}`);
    return BYPASS_BILLING[normalizedShop];
  }
  
  // Essayer sans www
  const withoutWww = normalizedShop.replace(/^www\./, '');
  if (BYPASS_BILLING[withoutWww]) {
    console.log(`âœ… BYPASS MATCH (sans www): ${withoutWww}`);
    return BYPASS_BILLING[withoutWww];
  }
  
  // Essayer avec www
  const withWww = 'www.' + withoutWww;
  if (BYPASS_BILLING[withWww]) {
    console.log(`âœ… BYPASS MATCH (avec www): ${withWww}`);
    return BYPASS_BILLING[withWww];
  }
  
  // Essayer avec .myshopify.com si pas present
  if (!normalizedShop.includes('.myshopify.com') && !normalizedShop.includes('.')) {
    const withSuffix = normalizedShop + '.myshopify.com';
    if (BYPASS_BILLING[withSuffix]) {
      console.log(`âœ… BYPASS MATCH (avec .myshopify.com): ${withSuffix}`);
      return BYPASS_BILLING[withSuffix];
    }
  }
  
  // Chercher par inclusion partielle
  for (const [key, plan] of Object.entries(BYPASS_BILLING)) {
    const keyNorm = key.toLowerCase().replace(/^www\./, '');
    const shopNorm = withoutWww;
    if (keyNorm.includes(shopNorm) || shopNorm.includes(keyNorm)) {
      console.log(`âœ… BYPASS MATCH PARTIEL: ${key} ~ ${shopNorm}`);
      return plan;
    }
  }
  
  console.log(`âŒ NO BYPASS MATCH for: ${normalizedShop}`);
  return null;
}

/**
 * Verifie si une boutique bypass le billing
 * @param {string} shop - Domaine de la boutique
 * @returns {boolean}
 */
function hasBypassBilling(shop) {
  return getBypassPlan(shop) !== null;
}

// ============================================
// DEFINITION DES PLANS v2.0
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
      "CMP (cout moyen) basique",
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
      "Categories & filtres",
      "Import Shopify",
      "Valeur totale stock",
      "Historique 30 jours",
      "Exports CSV avances",
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
      "ðŸ“¦ Lots / DLC / Tracabilite",
      "ðŸ­ Gestion fournisseurs",
      "ðŸ“‹ Inventaire physique",
      "ðŸ“Š Analytics (CA, marges)",
      "ðŸ”” Notifications Slack/Discord",
      "[GIFT] Gestion freebies",
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
      "Produits illimites",
      "Tout Pro +",
      "ðŸ”® Previsions de rupture (IA)",
      "ðŸ§© Kits / Bundles / Composes",
      "ðŸ“ Bons de commande (PO)",
      "ðŸ‘¥ Multi-utilisateurs (5)",
      "âš¡ Automatisations",
      "ðŸ”— Integrations (Zapier)",
      "ðŸ“§ Rapports auto par email",
      "â­ Support prioritaire",
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
      "ðŸª Multi-boutiques",
      "ðŸ‘¥ Utilisateurs illimites",
      "ðŸ”Œ Acces API complet",
      "ðŸ“Š Historique illimite",
      "[GIFT]¯ Account manager dedie",
      "ðŸ“ž Support telephonique",
      "ðŸ”§ Onboarding personnalise",
      "ðŸ“œ SLA garanti 99.9%",
    ],
    cta: "Contacter les ventes",
    contactSales: true,
  },
};

const PLAN_ORDER = ["free", "starter", "pro", "business", "enterprise"];

const FEATURE_DESCRIPTIONS = {
  hasCategories: { name: "Categories", icon: "ðŸ·ï¸", description: "Organiser vos produits" },
  hasShopifyImport: { name: "Import Shopify", icon: "ðŸ“¥", description: "Importer depuis Shopify" },
  hasStockValue: { name: "Valeur stock", icon: "ðŸ’°", description: "Valeur totale du stock" },
  hasAnalytics: { name: "Analytics", icon: "ðŸ“Š", description: "Stats ventes et marges" },
  hasBatchTracking: { name: "Lots & DLC", icon: "ðŸ“¦", description: "Tracabilite, peremption" },
  hasSuppliers: { name: "Fournisseurs", icon: "ðŸ­", description: "Gestion fournisseurs" },
  hasPurchaseOrders: { name: "Bons de commande", icon: "ðŸ“", description: "PO fournisseurs" },
  hasInventoryCount: { name: "Inventaire", icon: "ðŸ“‹", description: "Comptage physique" },
  hasForecast: { name: "Previsions", icon: "ðŸ”®", description: "Prediction ruptures" },
  hasKits: { name: "Kits & Bundles", icon: "ðŸ§©", description: "Produits composes" },
  hasMultiUsers: { name: "Multi-utilisateurs", icon: "ðŸ‘¥", description: "Ã‰quipe" },
  hasAutomations: { name: "Automatisations", icon: "âš¡", description: "Regles auto" },
  hasIntegrations: { name: "Integrations", icon: "ðŸ”—", description: "Zapier, webhooks" },
  hasReports: { name: "Rapports auto", icon: "ðŸ“§", description: "Emails hebdo" },
  hasMultiStore: { name: "Multi-boutiques", icon: "ðŸª", description: "Plusieurs shops" },
  hasApi: { name: "Acces API", icon: "ðŸ”Œ", description: "API REST" },
  hasNotifications: { name: "Notifications", icon: "ðŸ””", description: "Slack, Discord" },
  hasFreebies: { name: "Freebies", icon: "[GIFT]", description: "Ã‰chantillons" },
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
  // BYPASS BILLING CHECK - Priorite absolue
  // ============================================
  console.log(`ðŸ” PLAN CHECK for shop: "${shop}"`);
  
  const bypassPlan = getBypassPlan(shop);
  if (bypassPlan) {
    const plan = PLANS[bypassPlan] || PLANS.enterprise;
    console.log(`[GIFT] BYPASS BILLING ACTIVATED: "${shop}" â†’ Plan ${plan.name} (gratuit)`);
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
      effectivePlanId: bypassPlan,
      effectivePlan: plan,
      effectiveReason: "bypass",
      trialPlanId: null,
    };
  } else {
    console.log(`[Plan] NO BYPASS for "${shop}" - checking normal plan...`);
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
  const subscription = data.subscription || null;
  const trialEndsAt = data.trialEndsAt || null;
  const trialPlanId = data.trialPlanId || null;

  // ============================================
  // LOGIQUE EFFECTIVE PLAN (CRITIQUE)
  // Priorite: 1) Abonnement paye actif > 2) Trial actif > 3) Free
  // ============================================
  
  let effectivePlanId = "free";
  let effectiveReason = "default";

  // 1) Verifier si abonnement paye actif (non-bypass, non-trialing)
  if (subscription && subscription.status === "active" && !subscription.bypass) {
    effectivePlanId = planId;
    effectiveReason = "paid_subscription";
  }
  // 2) Verifier si trial actif avec trialPlanId (nouveau format)
  else if (trialPlanId && trialEndsAt) {
    const trialEnd = new Date(trialEndsAt);
    const now = new Date();
    if (trialEnd > now) {
      effectivePlanId = trialPlanId;
      effectiveReason = "trial_active";
    } else {
      effectiveReason = "trial_expired";
    }
  }
  // 3) Si trialing dans subscription (ancien format)
  else if (subscription && subscription.status === "trialing" && trialEndsAt) {
    const trialEnd = new Date(trialEndsAt);
    const now = new Date();
    if (trialEnd > now) {
      effectivePlanId = planId;
      effectiveReason = "trial_active_legacy";
    } else {
      effectiveReason = "trial_expired_legacy";
    }
  }

  const effectivePlan = PLANS[effectivePlanId] || PLANS.free;

  return {
    planId: plan.id,
    plan,
    subscription,
    limits: effectivePlan.limits,
    features: effectivePlan.features,
    trialEndsAt,
    trialPlanId,
    grandfathered: data.grandfathered || false,
    effectivePlanId,
    effectivePlan,
    effectiveReason,
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
    trialPlanId: options.trialPlanId || null,  // Nouveau: plan du trial
    grandfathered: options.grandfathered || existing.grandfathered || false,
    previousPlan: existing.planId,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);

  return getShopPlan(shop);
}

// Demarrer un trial Starter automatique (7 jours)
function startStarterTrial(shop) {
  const existing = getShopPlan(shop);
  
  // Ne pas ecraser un abonnement paye actif
  if (existing.subscription && existing.subscription.status === "active" && !existing.subscription.bypass) {
    console.log(`[Trial] Shop ${shop} a deja un abonnement actif, pas de trial`);
    return existing;
  }
  
  // Ne pas redemarrer un trial si deja en trial ou si trial expire
  if (existing.trialPlanId || existing.trialEndsAt) {
    console.log(`[Trial] Shop ${shop} a deja eu un trial`);
    return existing;
  }

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 7); // 7 jours

  const file = planFile(shop);
  const data = {
    planId: "free",  // Plan de base reste free
    subscription: null,
    trialEndsAt: trialEndsAt.toISOString(),
    trialPlanId: "starter",  // Trial sur Starter
    grandfathered: false,
    previousPlan: existing.planId,
    updatedAt: new Date().toISOString(),
    trialStartedAt: new Date().toISOString(),
  };

  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);

  console.log(`[Trial] Started Starter trial for ${shop} until ${trialEndsAt.toISOString()}`);
  return getShopPlan(shop);
}

function startTrial(shop, planId, durationDays = 14) {
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + durationDays);

  return setShopPlan(shop, "free", null, { 
    trialEndsAt: trialEndsAt.toISOString(),
    trialPlanId: planId,
  });
}

function isTrialExpired(shop) {
  const { trialEndsAt, trialPlanId, subscription } = getShopPlan(shop);
  
  // Nouveau format avec trialPlanId
  if (trialPlanId && trialEndsAt) {
    return new Date(trialEndsAt) < new Date();
  }
  
  // Ancien format avec subscription.status = trialing
  if (subscription?.status === "trialing" && trialEndsAt) {
    return new Date(trialEndsAt) < new Date();
  }
  
  return false;
}

function isTrialActive(shop) {
  const { trialEndsAt, trialPlanId, effectiveReason } = getShopPlan(shop);
  return effectiveReason === "trial_active" || effectiveReason === "trial_active_legacy";
}

function getTrialDaysLeft(shop) {
  const { trialEndsAt, trialPlanId } = getShopPlan(shop);
  if (!trialEndsAt) return null;
  
  const diff = new Date(trialEndsAt) - new Date();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function cancelSubscription(shop) {
  return setShopPlan(shop, "free", null);
}

// ============================================
// VÃ‰RIFICATION DES LIMITES
// ============================================

function checkLimit(shop, action, context = {}) {
  const shopPlan = getShopPlan(shop);
  const { limits, effectivePlanId, effectiveReason } = shopPlan;

  // Si trial expire, bloquer
  if (effectiveReason === "trial_expired" || effectiveReason === "trial_expired_legacy") {
    return { allowed: false, reason: "Periode d'essai terminee", upgrade: "starter", trialExpired: true };
  }

  const featureChecks = {
    import_shopify: ["hasShopifyImport", "Import Shopify", "starter"],
    view_categories: ["hasCategories", "Categories", "starter"],
    manage_categories: ["hasCategories", "Categories", "starter"],
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
    view_forecast: ["hasForecast", "Previsions", "business"],
    manage_kits: ["hasKits", "Kits & Bundles", "business"],
    view_kits: ["hasKits", "Kits & Bundles", "business"],
    manage_users: ["hasMultiUsers", "Multi-utilisateurs", "business"],
    manage_automations: ["hasAutomations", "Automatisations", "business"],
    use_integrations: ["hasIntegrations", "Integrations", "business"],
    manage_reports: ["hasReports", "Rapports auto", "business"],
    multi_store: ["hasMultiStore", "Multi-boutiques", "enterprise"],
    use_api: ["hasApi", "Acces API", "enterprise"],
    manage_notifications: ["hasNotifications", "Notifications", "pro"],
    manage_freebies: ["hasFreebies", "Freebies", "pro"],
    advanced_export: ["hasAdvancedExports", "Exports avances", "starter"],
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
      return { allowed: true, limitedTo: maxDays, reason: `Historique limite Ã  ${maxDays} jours` };
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
  const shopPlan = getShopPlan(shop);
  const { planId, plan, subscription, limits, features, trialEndsAt, trialPlanId, grandfathered, effectivePlanId, effectivePlan, effectiveReason } = shopPlan;

  const trialDaysLeft = getTrialDaysLeft(shop);
  const trialActive = isTrialActive(shop);

  return {
    current: {
      planId: effectivePlanId,           // Utiliser le plan EFFECTIF
      name: effectivePlan.name,
      price: effectivePlan.price,
      priceYearly: effectivePlan.priceYearly,
      currency: effectivePlan.currency,
      badge: effectivePlan.badge,
      features: effectivePlan.features,
    },
    limits: {
      maxProducts: limits.maxProducts === Infinity ? "Illimite" : limits.maxProducts,
      maxProductsNum: limits.maxProducts,
      maxUsers: limits.maxUsers === Infinity ? "Illimite" : limits.maxUsers,
      maxUsersNum: limits.maxUsers,
      movementHistoryDays: limits.movementHistoryDays === Infinity ? "Illimite" : limits.movementHistoryDays,
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
      active: trialActive,
      planId: trialPlanId,
      endsAt: trialEndsAt,
      daysLeft: trialDaysLeft,
      expired: isTrialExpired(shop),
    },
    effective: {
      planId: effectivePlanId,
      reason: effectiveReason,
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
        isCurrent: p.id === effectivePlanId,
        isUpgrade: PLAN_ORDER.indexOf(p.id) > PLAN_ORDER.indexOf(effectivePlanId),
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
  startStarterTrial,  // Nouveau
  isTrialExpired,
  isTrialActive,      // Nouveau
  getTrialDaysLeft,   // Nouveau
  cancelSubscription,
  checkLimit,
  applyMovementDaysLimit,
  canAddProduct,
  getRemainingProducts,
  hasFeature,
  getPlanInfoForUI,
  sanitizeShop,
};
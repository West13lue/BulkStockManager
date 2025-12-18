// i18n.js - Systeme de traduction simple pour Stock Manager Pro

var I18N = {
  // Langue courante (defaut: fr)
  currentLang: "fr",
  
  // Traductions
  translations: {
    fr: {
      // Navigation
      "nav.dashboard": "Tableau de bord",
      "nav.products": "Produits",
      "nav.batches": "Lots et DLC",
      "nav.suppliers": "Fournisseurs",
      "nav.orders": "Commandes",
      "nav.forecast": "Previsions",
      "nav.kits": "Kits et Bundles",
      "nav.analytics": "Analytics",
      "nav.inventory": "Inventaire",
      "nav.settings": "Parametres",
      
      // Dashboard
      "dashboard.title": "Tableau de bord",
      "dashboard.subtitle": "Vue d'ensemble",
      "dashboard.products": "Produits",
      "dashboard.totalStock": "Stock total",
      "dashboard.value": "Valeur",
      "dashboard.lowStock": "Stock bas",
      "dashboard.sync": "Sync",
      "dashboard.addProduct": "+ Produit",
      "dashboard.viewAll": "Voir tout",
      
      // Produits
      "products.title": "Produits",
      "products.search": "Rechercher...",
      "products.allCategories": "Toutes les categories",
      "products.noCategory": "Sans categorie",
      "products.sortBy": "Trier par",
      "products.name": "Nom",
      "products.stock": "Stock",
      "products.cmp": "CMP",
      "products.value": "Valeur",
      "products.status": "Statut",
      "products.categories": "Categories",
      "products.noProducts": "Aucun produit",
      "products.addFirst": "Commencez par synchroniser vos produits Shopify",
      
      // Statuts
      "status.ok": "OK",
      "status.low": "Bas",
      "status.critical": "Critique",
      "status.outOfStock": "Rupture",
      
      // Actions
      "action.save": "Enregistrer",
      "action.cancel": "Annuler",
      "action.close": "Fermer",
      "action.edit": "Modifier",
      "action.delete": "Supprimer",
      "action.add": "Ajouter",
      "action.sync": "Synchroniser",
      "action.export": "Exporter",
      "action.import": "Importer",
      "action.upgrade": "Upgrader",
      
      // Settings
      "settings.title": "Parametres",
      "settings.subscription": "Mon abonnement",
      "settings.language": "Langue et Region",
      "settings.languageDesc": "Personnalisez l'affichage selon votre pays",
      "settings.appLanguage": "Langue de l'application",
      "settings.timezone": "Fuseau horaire",
      "settings.dateFormat": "Format de date",
      "settings.timeFormat": "Format horaire",
      "settings.currency": "Devise et Unites",
      "settings.currencyDesc": "Configurez vos preferences monetaires",
      "settings.mainCurrency": "Devise principale",
      "settings.symbolPosition": "Position du symbole",
      "settings.weightUnit": "Unite de poids",
      "settings.stock": "Gestion du stock",
      "settings.stockDesc": "Regles de calcul et seuils d'alerte",
      "settings.thresholds": "Seuils de statut",
      "settings.criticalThreshold": "Seuil critique",
      "settings.lowThreshold": "Seuil bas",
      "settings.alerts": "Alertes",
      "settings.lowStockAlerts": "Alertes stock bas",
      "settings.valuation": "Valorisation",
      "settings.valuationMethod": "Methode de valorisation",
      "settings.freezeCMP": "Figer le CMP",
      "settings.allowNegative": "Autoriser stock negatif",
      "settings.saved": "Parametre enregistre",
      
      // Messages
      "msg.loading": "Chargement...",
      "msg.saving": "Enregistrement...",
      "msg.success": "Succes",
      "msg.error": "Erreur",
      "msg.confirm": "Confirmer",
      "msg.featureLocked": "Fonctionnalite verrouillee",
      "msg.upgradeRequired": "Passez a un plan superieur pour debloquer.",
      
      // Plan
      "plan.free": "Free",
      "plan.starter": "Starter",
      "plan.pro": "Pro",
      "plan.business": "Business",
      "plan.enterprise": "Enterprise",
      "plan.trial": "Essai",
      "plan.daysLeft": "jours restants",
      "plan.products": "produits",
      "plan.unlimited": "Illimite",
      "plan.changePlan": "Changer de plan",
    },
    
    en: {
      // Navigation
      "nav.dashboard": "Dashboard",
      "nav.products": "Products",
      "nav.batches": "Batches & Expiry",
      "nav.suppliers": "Suppliers",
      "nav.orders": "Orders",
      "nav.forecast": "Forecast",
      "nav.kits": "Kits & Bundles",
      "nav.analytics": "Analytics",
      "nav.inventory": "Inventory",
      "nav.settings": "Settings",
      
      // Dashboard
      "dashboard.title": "Dashboard",
      "dashboard.subtitle": "Overview",
      "dashboard.products": "Products",
      "dashboard.totalStock": "Total Stock",
      "dashboard.value": "Value",
      "dashboard.lowStock": "Low Stock",
      "dashboard.sync": "Sync",
      "dashboard.addProduct": "+ Product",
      "dashboard.viewAll": "View all",
      
      // Products
      "products.title": "Products",
      "products.search": "Search...",
      "products.allCategories": "All categories",
      "products.noCategory": "Uncategorized",
      "products.sortBy": "Sort by",
      "products.name": "Name",
      "products.stock": "Stock",
      "products.cmp": "Avg Cost",
      "products.value": "Value",
      "products.status": "Status",
      "products.categories": "Categories",
      "products.noProducts": "No products",
      "products.addFirst": "Start by syncing your Shopify products",
      
      // Status
      "status.ok": "OK",
      "status.low": "Low",
      "status.critical": "Critical",
      "status.outOfStock": "Out of Stock",
      
      // Actions
      "action.save": "Save",
      "action.cancel": "Cancel",
      "action.close": "Close",
      "action.edit": "Edit",
      "action.delete": "Delete",
      "action.add": "Add",
      "action.sync": "Sync",
      "action.export": "Export",
      "action.import": "Import",
      "action.upgrade": "Upgrade",
      
      // Settings
      "settings.title": "Settings",
      "settings.subscription": "My subscription",
      "settings.language": "Language & Region",
      "settings.languageDesc": "Customize display for your country",
      "settings.appLanguage": "App language",
      "settings.timezone": "Timezone",
      "settings.dateFormat": "Date format",
      "settings.timeFormat": "Time format",
      "settings.currency": "Currency & Units",
      "settings.currencyDesc": "Configure your currency preferences",
      "settings.mainCurrency": "Main currency",
      "settings.symbolPosition": "Symbol position",
      "settings.weightUnit": "Weight unit",
      "settings.stock": "Stock management",
      "settings.stockDesc": "Calculation rules and alert thresholds",
      "settings.thresholds": "Status thresholds",
      "settings.criticalThreshold": "Critical threshold",
      "settings.lowThreshold": "Low threshold",
      "settings.alerts": "Alerts",
      "settings.lowStockAlerts": "Low stock alerts",
      "settings.valuation": "Valuation",
      "settings.valuationMethod": "Valuation method",
      "settings.freezeCMP": "Freeze avg cost",
      "settings.allowNegative": "Allow negative stock",
      "settings.saved": "Setting saved",
      
      // Messages
      "msg.loading": "Loading...",
      "msg.saving": "Saving...",
      "msg.success": "Success",
      "msg.error": "Error",
      "msg.confirm": "Confirm",
      "msg.featureLocked": "Feature locked",
      "msg.upgradeRequired": "Upgrade to a higher plan to unlock.",
      
      // Plan
      "plan.free": "Free",
      "plan.starter": "Starter",
      "plan.pro": "Pro",
      "plan.business": "Business",
      "plan.enterprise": "Enterprise",
      "plan.trial": "Trial",
      "plan.daysLeft": "days left",
      "plan.products": "products",
      "plan.unlimited": "Unlimited",
      "plan.changePlan": "Change plan",
    },
    
    de: {
      // Navigation
      "nav.dashboard": "Dashboard",
      "nav.products": "Produkte",
      "nav.batches": "Chargen & MHD",
      "nav.suppliers": "Lieferanten",
      "nav.orders": "Bestellungen",
      "nav.forecast": "Prognose",
      "nav.kits": "Kits & Bundles",
      "nav.analytics": "Analysen",
      "nav.inventory": "Inventar",
      "nav.settings": "Einstellungen",
      
      // Dashboard
      "dashboard.title": "Dashboard",
      "dashboard.subtitle": "Ubersicht",
      "dashboard.products": "Produkte",
      "dashboard.totalStock": "Gesamtbestand",
      "dashboard.value": "Wert",
      "dashboard.lowStock": "Niedriger Bestand",
      "dashboard.sync": "Sync",
      "dashboard.addProduct": "+ Produkt",
      "dashboard.viewAll": "Alle anzeigen",
      
      // Status
      "status.ok": "OK",
      "status.low": "Niedrig",
      "status.critical": "Kritisch",
      "status.outOfStock": "Ausverkauft",
      
      // Actions
      "action.save": "Speichern",
      "action.cancel": "Abbrechen",
      "action.close": "Schliessen",
      "action.upgrade": "Upgraden",
      
      // Settings
      "settings.title": "Einstellungen",
      "settings.saved": "Einstellung gespeichert",
      
      // Messages
      "msg.loading": "Laden...",
      "msg.error": "Fehler",
    },
    
    es: {
      // Navigation
      "nav.dashboard": "Panel",
      "nav.products": "Productos",
      "nav.settings": "Configuracion",
      
      // Dashboard
      "dashboard.title": "Panel de control",
      "dashboard.products": "Productos",
      "dashboard.totalStock": "Stock total",
      "dashboard.value": "Valor",
      "dashboard.lowStock": "Stock bajo",
      
      // Status
      "status.ok": "OK",
      "status.low": "Bajo",
      "status.critical": "Critico",
      "status.outOfStock": "Agotado",
      
      // Actions
      "action.save": "Guardar",
      "action.cancel": "Cancelar",
      "action.close": "Cerrar",
      
      // Settings
      "settings.saved": "Configuracion guardada",
      
      // Messages
      "msg.loading": "Cargando...",
      "msg.error": "Error",
    },
    
    it: {
      // Navigation
      "nav.dashboard": "Pannello",
      "nav.products": "Prodotti",
      "nav.settings": "Impostazioni",
      
      // Dashboard
      "dashboard.title": "Pannello di controllo",
      "dashboard.products": "Prodotti",
      "dashboard.totalStock": "Stock totale",
      "dashboard.value": "Valore",
      "dashboard.lowStock": "Stock basso",
      
      // Status
      "status.ok": "OK",
      "status.low": "Basso",
      "status.critical": "Critico",
      "status.outOfStock": "Esaurito",
      
      // Actions
      "action.save": "Salva",
      "action.cancel": "Annulla",
      "action.close": "Chiudi",
      
      // Settings
      "settings.saved": "Impostazione salvata",
      
      // Messages
      "msg.loading": "Caricamento...",
      "msg.error": "Errore",
    }
  },
  
  // Initialiser la langue depuis les settings
  init: function(lang) {
    if (lang && lang !== "auto" && this.translations[lang]) {
      this.currentLang = lang;
    } else {
      // Detecter depuis le navigateur
      var browserLang = (navigator.language || "fr").substring(0, 2);
      this.currentLang = this.translations[browserLang] ? browserLang : "fr";
    }
    console.log("[i18n] Language set to:", this.currentLang);
  },
  
  // Obtenir une traduction
  t: function(key, fallback) {
    var lang = this.currentLang || "fr";
    var translations = this.translations[lang] || this.translations.fr;
    
    if (translations[key]) {
      return translations[key];
    }
    
    // Fallback vers francais si la cle n'existe pas dans la langue courante
    if (this.translations.fr[key]) {
      return this.translations.fr[key];
    }
    
    // Retourner le fallback ou la cle elle-meme
    return fallback || key;
  },
  
  // Changer la langue
  setLang: function(lang) {
    if (lang === "auto") {
      var browserLang = (navigator.language || "fr").substring(0, 2);
      this.currentLang = this.translations[browserLang] ? browserLang : "fr";
    } else if (this.translations[lang]) {
      this.currentLang = lang;
    }
    console.log("[i18n] Language changed to:", this.currentLang);
  }
};

// Raccourci global
function t(key, fallback) {
  return I18N.t(key, fallback);
}

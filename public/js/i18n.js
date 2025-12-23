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
      // Mouvements
      "dashboard.recentMovements": "Mouvements recents",
      "dashboard.noMovements": "Aucun mouvement",
      "movement.restock": "Reappro",
      "movement.sale": "Vente",
      "movement.adjustment": "Ajustement",
      "movement.transfer": "Transfert",
      "movement.return": "Retour",
      "movement.loss": "Perte",
      "movement.production": "Production",
      "movement.inventory": "Inventaire",
      
      // Temps
      "time.justNow": "A l'instant",
      "time.minutesAgo": "min",
      "time.hoursAgo": "h",
      "time.daysAgo": "j",
      // Lots & DLC
      "batches.title": "Lots & DLC",
      "batches.subtitle": "Tracabilite et gestion des dates limites",
      "batches.lockedDesc": "Gerez vos lots, tracez vos DLC et anticipez les pertes avec le plan Pro.",
      "batches.feature1": "Tracabilite complete",
      "batches.feature2": "Alertes DLC automatiques",
      "batches.feature3": "FIFO / FEFO automatique",
      "batches.addBatch": "Nouveau lot",
      "batches.markExpired": "Marquer expires",
      "batches.totalLots": "Total lots",
      "batches.activeLots": "Lots actifs",
      "batches.expiringSoon": "Expirent sous 30j",
      "batches.expiredLots": "Expires",
      "batches.valueAtRisk": "Valeur a risque",
      "batches.allProducts": "Tous les produits",
      "batches.allStatus": "Tous les statuts",
      "batches.allDates": "Toutes les dates",
      "batches.statusActive": "Actif",
      "batches.statusDepleted": "Epuise",
      "batches.statusExpired": "Expire",
      "batches.statusRecalled": "Rappele",
      "batches.expiring7": "Expire sous 7j",
      "batches.expiring15": "Expire sous 15j",
      "batches.expiring30": "Expire sous 30j",
      "batches.noLots": "Aucun lot",
      "batches.noLotsDesc": "Creez votre premier lot pour commencer la tracabilite.",
      "batches.lotId": "Lot",
      "batches.product": "Produit",
      "batches.stock": "Stock",
      "batches.dlc": "DLC",
      "batches.daysLeft": "Jours",
      "batches.cost": "Cout",
      "batches.value": "Valeur",
      "batches.status": "Statut",
      "batches.expired": "Expire",
      "batches.quantity": "Quantite",
      "batches.costPerUnit": "Cout unitaire",
      "batches.expiryType": "Type date",
      "batches.expiryDate": "Date limite",
      "batches.supplierRef": "Ref. fournisseur",
      "batches.notes": "Notes",
      "batches.errorRequired": "Produit et quantite requis",
      "batches.lotCreated": "Lot cree avec succes",
      "batches.adjustBatch": "Ajuster le lot",
      "batches.adjustment": "Ajustement",
      "batches.reason": "Raison",
      "batches.errorAdjustment": "Entrez une valeur",
      "batches.lotAdjusted": "Lot ajuste",
      "batches.lotDetails": "Details du lot",
      "batches.info": "Informations",
      "batches.received": "Recu le",
      "batches.initial": "Initial",
      "batches.remaining": "Restant",
      "batches.used": "Utilise",
      "batches.expiry": "Peremption",
      "batches.type": "Type",
      "batches.date": "Date",
      "batches.totalCost": "Cout total",
      "batches.valueRemaining": "Valeur restante",
      "batches.history": "Historique",
      "batches.noMovements": "Aucun mouvement",
      "batches.adjust": "Ajuster",
      "batches.deactivate": "Desactiver",
      "batches.confirmDeactivate": "Voulez-vous vraiment desactiver ce lot ?",
      "batches.lotDeactivated": "Lot desactive",
      "batches.markedExpired": "{count} lots marques expires",
      "batches.noLotsForProduct": "Aucun lot pour ce produit",
      "batches.createFirstLot": "Creer le premier lot",
      "batches.addAnotherLot": "Ajouter un lot",
      "batches.addBatchFor": "Nouveau lot pour",
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
      // Movements
      "dashboard.recentMovements": "Recent movements",
      "dashboard.noMovements": "No movements",
      "movement.restock": "Restock",
      "movement.sale": "Sale",
      "movement.adjustment": "Adjustment",
      "movement.transfer": "Transfer",
      "movement.return": "Return",
      "movement.loss": "Loss",
      "movement.production": "Production",
      "movement.inventory": "Inventory",
      
      // Time
      "time.justNow": "Just now",
      "time.minutesAgo": "min ago",
      "time.hoursAgo": "h ago",
      "time.daysAgo": "d ago",
      // Batches & Expiry
      "batches.title": "Batches & Expiry",
      "batches.subtitle": "Traceability and expiry management",
      "batches.lockedDesc": "Manage your batches, track expiry dates and anticipate losses with Pro plan.",
      "batches.feature1": "Full traceability",
      "batches.feature2": "Automatic expiry alerts",
      "batches.feature3": "Automatic FIFO / FEFO",
      "batches.addBatch": "New batch",
      "batches.markExpired": "Mark expired",
      "batches.totalLots": "Total batches",
      "batches.activeLots": "Active batches",
      "batches.expiringSoon": "Expiring within 30d",
      "batches.expiredLots": "Expired",
      "batches.valueAtRisk": "Value at risk",
      "batches.allProducts": "All products",
      "batches.allStatus": "All statuses",
      "batches.allDates": "All dates",
      "batches.statusActive": "Active",
      "batches.statusDepleted": "Depleted",
      "batches.statusExpired": "Expired",
      "batches.statusRecalled": "Recalled",
      "batches.expiring7": "Expiring in 7d",
      "batches.expiring15": "Expiring in 15d",
      "batches.expiring30": "Expiring in 30d",
      "batches.noLots": "No batches",
      "batches.noLotsDesc": "Create your first batch to start traceability.",
      "batches.lotId": "Batch",
      "batches.product": "Product",
      "batches.stock": "Stock",
      "batches.dlc": "Expiry",
      "batches.daysLeft": "Days",
      "batches.cost": "Cost",
      "batches.value": "Value",
      "batches.status": "Status",
      "batches.expired": "Expired",
      "batches.quantity": "Quantity",
      "batches.costPerUnit": "Unit cost",
      "batches.expiryType": "Date type",
      "batches.expiryDate": "Expiry date",
      "batches.supplierRef": "Supplier ref",
      "batches.notes": "Notes",
      "batches.errorRequired": "Product and quantity required",
      "batches.lotCreated": "Batch created successfully",
      "batches.adjustBatch": "Adjust batch",
      "batches.adjustment": "Adjustment",
      "batches.reason": "Reason",
      "batches.errorAdjustment": "Enter a value",
      "batches.lotAdjusted": "Batch adjusted",
      "batches.lotDetails": "Batch details",
      "batches.info": "Information",
      "batches.received": "Received",
      "batches.initial": "Initial",
      "batches.remaining": "Remaining",
      "batches.used": "Used",
      "batches.expiry": "Expiry",
      "batches.type": "Type",
      "batches.date": "Date",
      "batches.totalCost": "Total cost",
      "batches.valueRemaining": "Remaining value",
      "batches.history": "History",
      "batches.noMovements": "No movements",
      "batches.adjust": "Adjust",
      "batches.deactivate": "Deactivate",
      "batches.confirmDeactivate": "Do you really want to deactivate this batch?",
      "batches.lotDeactivated": "Batch deactivated",
      "batches.markedExpired": "{count} batches marked as expired",
      "batches.noLotsForProduct": "No batches for this product",
      "batches.createFirstLot": "Create first batch",
      "batches.addAnotherLot": "Add a batch",
      "batches.addBatchFor": "New batch for",
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
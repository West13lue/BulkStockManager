# Pack découverte — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** Ajouter dans la fenêtre Étiquettes un bouton « Pack découverte » qui sélectionne automatiquement les N produits au plus gros stock, génère une étiquette 1,5 g par produit imprimables en une fois, et déduit 1,5 g du stock de chaque produit à l'impression.

**Architecture :** Réutilise la fenêtre Étiquettes existante (`showLabelsModal` / `labelConfigs` / `printLabels`). Sélection top-N côté client à partir d'un rechargement frais de `/api/products`. À l'impression, la liste réellement imprimée est POSTée à un nouvel endpoint `/api/discovery-pack/commit` qui décrémente le stock de façon autoritative (revalidation), enregistre un mouvement et pousse vers Shopify — calqué sur le flux « pochon cadeau » (`/api/sales/gift` + `recordGiftLines`), **sans** écriture analytics.

**Tech Stack :** Node.js + Express (monolithe `server.js`), JS vanilla navigateur (monolithe `public/js/app.js`, IIFE, pas de bundler), persistance fichier JSON via les stores existants.

## Global Constraints

- **Pas de bundler / transpileur.** JS vanilla navigateur + Node direct. Style de concaténation de chaînes existant à respecter.
- **`safeJson(req, res, async () => {...})` obligatoire** pour tout handler d'API qui parle à Shopify (purge le token invalide + reauth). Ne jamais retourner un 401 brut.
- **`movementStore` peut être `null`** (chargé via try/require) → toujours garder la garde `if (movementStore && movementStore.addMovement)`.
- **Aucune écriture analytics** pour le pack découverte (c'est une préparation, pas une vente).
- **Décrément stock uniquement via `stock.applyOrderToProduct(shop, productId, grams)`** (helper existant, gère l'écriture atomique). Push Shopify via `pushProductInventoryToShopify(shop, updatedProduct)` en best-effort (erreur loggée, non bloquante).
- **API publique `app.X()` stable.** Toute fonction appelée depuis un `onclick="app.foo()"` doit être ajoutée **à la fois** au tableau `fnNames` (~ligne 28-101) **et** à l'objet `_real` retourné (~ligne 12551). Le proxy `window.app` ne forwarde que les noms présents dans `fnNames`.
- **`API_BASE` reste `/api`** : utiliser `apiUrl("/chemin")` + `authFetch(...)` (ajoute le JWT). Ne pas hardcoder l'URL Render.
- **Interdiction de `window.prompt` / `window.alert` / `window.confirm`** : l'app tourne dans un iframe cross-origin Shopify où `prompt()` est bloqué. Utiliser un champ `<input>` inline dans la fenêtre.
- **UI en français** : les appels `t(key, "fallback français")` fournissent déjà le texte FR inline, donc la fonctionnalité est complète en français sans toucher `i18n.js` (Task 5 optionnelle pour l'anglais).
- **Poids par pochon : 1,5 g** (constante `GRAMS = 1.5`). **N par défaut : 6**, éditable, mémorisé dans `localStorage` (clé `discoveryPackCount`).
- **Éligibilité produit** : `!trackByUnit && !archived && totalGrams >= 1.5`. Tri : `totalGrams` décroissant.
- Le repo n'a **aucun harnais de test** en pratique (jest configuré mais 0 test). Vérification = `node --check` (syntaxe) + dogfood manuel dans l'app. Ne pas introduire de framework de test pour cette feature.

---

## Task 0 : Branche de travail

**Files :** (aucun — opération git)

- [ ] **Step 1 : Créer la branche depuis `main`**

On est sur `main` (branche par défaut). Créer une branche dédiée avant toute modif.

```bash
git checkout -b feat/pack-decouverte-etiquettes
```

Expected : `Switched to a new branch 'feat/pack-decouverte-etiquettes'`

---

## Task 1 : Backend — endpoint `POST /api/discovery-pack/commit`

**Files :**
- Modify : `server.js` — insérer un nouveau bloc `router.post(...)` **juste après** la fin du handler `/api/sales/gift` (ligne 3590, le `});` qui précède `router.post("/api/test-order", ...)`).

**Interfaces :**
- Consumes : `getShop(req)`, `apiError(res, code, msg)`, `safeJson(req, res, fn)`, `stock.getProductSnapshot(shop, productId) -> { productId, name, totalGrams, averageCostPerGram, categoryIds } | null`, `stock.applyOrderToProduct(shop, productId, grams)` (async, décrémente), `movementStore.addMovement(record, shop)` (peut être null), `pushProductInventoryToShopify(shop, productSnapshot)` (async), `logEvent(event, data, level)`.
- Produces : route `POST /api/discovery-pack/commit`. Body attendu : `{ lines: [ { productId: string, grams: number } ] }`. Réponse : `{ success: true, prepared: number, totalGramsDeducted: number, preparedLines: [{productId, productName, grams, totalAfter}], skipped: [{productId, productName, reason}] }`.

- [ ] **Step 1 : Insérer le handler**

Repérer la fin du handler gift dans `server.js` :

```js
    res.json({
      success: true,
      orderId,
      productId,
      productName,
      quantity,
      totalGrams,
      totalCost: Math.round(totalCost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      newStock: updatedProduct ? updatedProduct.totalGrams : null,
    });
  });
});

router.post("/api/test-order", (req, res) => {
```

Insérer le nouveau bloc **entre** le `});` de clôture du handler gift et la ligne `router.post("/api/test-order", ...)` :

```js
// Préparation "pack découverte" : déduit un poids (1,5 g) par produit sélectionné
// (les plus gros stocks, sélection faite côté client). Enregistre un mouvement par
// ligne + push Shopify. AUCUNE écriture analytics (préparation, pas une vente).
// Calqué sur /api/sales/gift sans la partie analytics.
router.post("/api/discovery-pack/commit", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (rawLines.length === 0) return apiError(res, 400, "Aucune ligne à préparer");

    const prepared = [];
    const skipped = [];
    let totalGramsDeducted = 0;

    for (const line of rawLines) {
      const productId = String(line?.productId || "").trim();
      const grams = Number(line?.grams || 0);

      if (!productId || !Number.isFinite(grams) || grams <= 0) {
        skipped.push({ productId, productName: "", reason: "ligne invalide" });
        continue;
      }

      const snapshot = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
      if (!snapshot) {
        skipped.push({ productId, productName: "", reason: "produit introuvable" });
        continue;
      }

      const productName = snapshot.name || productId;
      const currentGrams = Number(snapshot.totalGrams || 0);
      if (currentGrams < grams) {
        skipped.push({ productId, productName, reason: "stock insuffisant" });
        continue;
      }

      // 1. Décrémenter le stock
      try {
        if (typeof stock.applyOrderToProduct === "function") {
          await stock.applyOrderToProduct(shop, productId, grams);
        }
      } catch (e) {
        skipped.push({ productId, productName, reason: "erreur déduction: " + e.message });
        continue;
      }

      const updated = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
      const totalAfter = updated ? Number(updated.totalGrams || 0) : currentGrams - grams;

      // 2. Mouvement (source: discovery_pack) — distinct des ventes pour filtrage
      if (movementStore && movementStore.addMovement) {
        try {
          movementStore.addMovement({
            source: "discovery_pack",
            type: "discovery_pack_prep",
            productId,
            productName,
            gramsDelta: -Math.abs(grams),
            totalAfter,
            shop,
          }, shop);
        } catch (e) {
          logEvent("discovery_pack_movement_error", { shop, productId, error: e.message }, "error");
        }
      }

      // 3. Sync Shopify (best-effort)
      if (updated) {
        try {
          await pushProductInventoryToShopify(shop, updated);
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId, error: e.message }, "error");
        }
      }

      prepared.push({ productId, productName, grams, totalAfter });
      totalGramsDeducted += grams;
    }

    logEvent("discovery_pack_prepared", {
      shop,
      prepared: prepared.length,
      skipped: skipped.length,
      totalGramsDeducted,
    }, "info");

    res.json({
      success: true,
      prepared: prepared.length,
      totalGramsDeducted: Math.round(totalGramsDeducted * 100) / 100,
      preparedLines: prepared,
      skipped,
    });
  });
});

```

- [ ] **Step 2 : Vérifier la syntaxe**

Run : `node --check server.js`
Expected : aucune sortie, code de retour 0 (pas d'erreur de parsing).

- [ ] **Step 3 : Vérifier l'enregistrement de la route (démarrage local, auth désactivée)**

Démarrer en dev sans auth (PowerShell) :

```powershell
$env:NODE_ENV="development"; $env:API_AUTH_REQUIRED="false"; $env:SHOP_NAME="default"; node server.js
```

Dans un autre terminal, appeler l'endpoint avec un `productId` réel (ex. voir la réponse de `GET http://localhost:3000/api/stock`, qui est la route listant les produits) :

```bash
curl -s -X POST http://localhost:3000/api/discovery-pack/commit \
  -H "Content-Type: application/json" \
  -d '{"lines":[{"productId":"<PRODUCT_ID_REEL>","grams":1.5}]}'
```

Expected : JSON `{ "success": true, "prepared": 1, "totalGramsDeducted": 1.5, "preparedLines":[...], "skipped":[] }`. Un `GET /api/products` ensuite montre `totalGrams` diminué de 1,5 pour ce produit. Le push Shopify loggue une erreur en local (pas de token) — **c'est attendu et non bloquant**. Un `POST` avec un `grams` supérieur au stock renvoie la ligne dans `skipped` avec `reason: "stock insuffisant"`. Arrêter le serveur (Ctrl+C).

- [ ] **Step 4 : Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
feat(labels): endpoint /api/discovery-pack/commit (déduction stock pack découverte)

Déduit N pochons (1,5 g) sur les produits sélectionnés, enregistre un
mouvement par ligne + push Shopify. Calqué sur /api/sales/gift, sans analytics.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 : Frontend — bouton, sélection top-N, pré-remplissage

**Files :**
- Modify : `public/js/app.js` — tableau `fnNames` (~ligne 59), objet `_real` (~ligne 12558), `renderLabelTabs()` (~3868-3896), `renderLabelConfig()` (~3913-3921), et ajout de la fonction `startDiscoveryPack()` après `addGiftLabelConfig()` (~3968).

**Interfaces :**
- Consumes : `loadProducts()` (async, peuple `state.products` depuis `/api/stock`), `state.products` (chaque produit : `{ productId, name, totalGrams, trackByUnit?, archived? }`), `showToast`, `t`, `labelConfigs` (var module), `activeLabelTab` (var module), `renderLabelTabs()`, `renderLabelConfig()`, `loadLabelLots(idx)`.
- ⚠️ **La route de liste des produits est `/api/stock`, pas `/api/products`.** Ne pas fetch `/api/products` (n'existe qu'en `:productId`). Réutiliser `loadProducts()`.
- Produces : `app.startDiscoveryPack()`. Marque chaque config générée avec `isDiscoveryPack: true`, `weight: 1.5`, `qty: 1`. Ajoute un `<input id="discoveryPackN">` dans la barre d'onglets.

- [ ] **Step 1 : Exposer `startDiscoveryPack` dans `fnNames`**

Dans `public/js/app.js`, repérer (~ligne 59) :

```js
    'switchLabelTab', 'addLabelConfig', 'addGiftLabelConfig', 'removeLabelConfig',
```

Remplacer par :

```js
    'switchLabelTab', 'addLabelConfig', 'addGiftLabelConfig', 'removeLabelConfig',
    'startDiscoveryPack',
```

- [ ] **Step 2 : Exposer `startDiscoveryPack` dans l'objet `_real`**

Repérer (~ligne 12558) :

```js
    removeLabelConfig: removeLabelConfig,
```

Remplacer par :

```js
    removeLabelConfig: removeLabelConfig,
    startDiscoveryPack: startDiscoveryPack,
```

- [ ] **Step 3 : Badge d'onglet « pack découverte » dans `renderLabelTabs()`**

Repérer dans `renderLabelTabs()` :

```js
      var isGift = !!cfg.isGift;
      var activeColor = isGift ? "#f59e0b" : "var(--primary,#6366f1)";
```

Remplacer par :

```js
      var isGift = !!cfg.isGift;
      var isDiscovery = !!cfg.isDiscoveryPack;
      var activeColor = isGift ? "#f59e0b" : (isDiscovery ? "#14b8a6" : "var(--primary,#6366f1)");
```

Puis repérer :

```js
      var giftPrefix = isGift ? '🎁 ' : ''; // 🎁
```

Remplacer par :

```js
      var giftPrefix = isGift ? '🎁 ' : (isDiscovery ? '🧪 ' : '');
```

- [ ] **Step 4 : Bouton « Pack découverte » + champ N dans `renderLabelTabs()`**

Repérer (le bouton « + Ajouter », ~ligne 3889) :

```js
    html += '<button onclick="app.addLabelConfig()" style="padding:6px 14px;border:1px dashed var(--border-color);border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:transparent;color:var(--primary,#6366f1)">+ ' + t("labels.addLabel", "Ajouter") + '</button>';
```

Ajouter **juste après** cette ligne :

```js
    var dpDefault = parseInt(localStorage.getItem("discoveryPackCount"), 10) || 6;
    html += '<span style="display:inline-flex;align-items:center;gap:6px;padding:0 4px 0 10px;border:1px dashed #14b8a6;border-radius:6px">' +
      '<button onclick="app.startDiscoveryPack()" style="padding:6px 6px 6px 0;border:none;background:transparent;color:#14b8a6;cursor:pointer;font-size:13px;font-weight:600" title="' + t("labels.discoveryPackHint", "Sélectionne les N produits au plus gros stock, une étiquette 1,5 g chacun. 1,5 g déduit du stock à l\'impression.") + '">🧪 ' + t("labels.discoveryPack", "Pack découverte") + '</button>' +
      '<input type="number" id="discoveryPackN" min="1" max="50" value="' + dpDefault + '" title="' + t("labels.discoveryPackCountLabel", "Nombre de produits") + '" style="width:46px;padding:4px;border:1px solid var(--border-color);border-radius:4px;font-size:13px">' +
      '</span>';
```

- [ ] **Step 5 : Bandeau info dans `renderLabelConfig()`**

Repérer le bloc `giftBanner` (se termine par `: '';`) puis la ligne `container.innerHTML =` suivie de `giftBanner +`. Repérer précisément :

```js
    container.innerHTML =
      giftBanner +
      '<div class="form-row-mobile">' +
```

Remplacer par (ajoute la déclaration `discoveryBanner` puis l'insère) :

```js
    var discoveryBanner = cfg.isDiscoveryPack
      ? '<div style="margin-bottom:12px;padding:10px 12px;background:rgba(20,184,166,0.08);border-left:3px solid #14b8a6;border-radius:6px;font-size:12px;line-height:1.4">' +
          '<strong style="color:#0f766e">🧪 ' + t("labels.discoveryBadge", "Pack découverte") + '</strong> &middot; ' +
          t("labels.discoveryHint", "Produit sélectionné parmi les plus gros stocks. 1,5 g sera déduit du stock à l\'impression.") +
        '</div>'
      : '';

    container.innerHTML =
      giftBanner +
      discoveryBanner +
      '<div class="form-row-mobile">' +
```

- [ ] **Step 6 : Définir `startDiscoveryPack()`**

Repérer la fin de `addGiftLabelConfig()` :

```js
  function addGiftLabelConfig() {
    if (!labelsOrderContext || !labelsOrderContext.orderId) return;
    saveLabelConfigFromForm();
    labelConfigs.push({ productId: "", lotId: "", qty: 1, weight: "", price: "", lotData: null, isGift: true });
    activeLabelTab = labelConfigs.length - 1;
    renderLabelTabs();
    renderLabelConfig();
  }
```

Insérer **juste après** cette fonction :

```js
  // Pack découverte : sélectionne automatiquement les N produits au plus gros
  // stock (suivis au gramme, non archivés, stock >= 1,5 g) et pré-remplit la
  // fenêtre avec une étiquette 1,5 g par produit. La déduction stock se fait à
  // l'impression (voir commitDiscoveryPack, appelé depuis printLabels).
  async function startDiscoveryPack() {
    var GRAMS = 1.5;
    var nInput = document.getElementById("discoveryPackN");
    var n = parseInt(nInput ? nInput.value : "", 10);
    if (!Number.isFinite(n) || n <= 0) {
      showToast(t("labels.discoveryPackInvalidN", "Nombre de produits invalide"), "warning");
      return;
    }
    try { localStorage.setItem("discoveryPackCount", String(n)); } catch (e) {}

    // Recharger les produits pour un stock à jour. loadProducts() peuple
    // state.products depuis /api/stock (la vraie route de liste), sans filtre
    // recherche/catégorie. La fenêtre reste ouverte (updateUI ne touche pas la modale).
    try {
      await loadProducts();
    } catch (e) {
      console.warn("startDiscoveryPack: rechargement produits échoué", e);
    }
    var products = state.products || [];

    // Éligibilité : suivi au gramme (pas trackByUnit), non archivé, stock >= 1,5 g.
    var eligible = products.filter(function (p) {
      return !p.trackByUnit && !p.archived && Number(p.totalGrams || 0) >= GRAMS;
    });
    eligible.sort(function (a, b) { return Number(b.totalGrams || 0) - Number(a.totalGrams || 0); });

    if (eligible.length === 0) {
      showToast(t("labels.discoveryPackNone", "Aucun produit éligible (stock suffisant introuvable)"), "warning");
      return;
    }

    var selected = eligible.slice(0, n);

    labelConfigs = selected.map(function (p) {
      return { productId: p.productId, lotId: "", qty: 1, weight: GRAMS, price: "", lotData: null, isGift: false, isDiscoveryPack: true };
    });
    activeLabelTab = 0;
    renderLabelTabs();
    renderLabelConfig();
    labelConfigs.forEach(function (cfg, idx) { if (cfg.productId) loadLabelLots(idx); });

    if (selected.length < n) {
      showToast(t("labels.discoveryPackFewer", "Seulement {count} produit(s) éligible(s)").replace("{count}", selected.length), "info");
    } else {
      showToast(t("labels.discoveryPackReady", "{count} produit(s) prêt(s) — vérifiez puis imprimez").replace("{count}", selected.length), "success");
    }
  }
```

- [ ] **Step 7 : Vérifier la syntaxe**

Run : `node --check public/js/app.js`
Expected : aucune sortie, code retour 0.

- [ ] **Step 8 : Dogfood — la sélection pré-remplit la fenêtre**

Dans l'app (embedded ou dev), ouvrir la fenêtre Étiquettes (icône tag du bandeau). Vérifier :
- Un bouton « 🧪 Pack découverte » + un champ nombre (valeur 6) apparaissent à côté de « + Ajouter ».
- Cliquer « Pack découverte » → la fenêtre se remplit de N onglets (badge 🧪 teal), chacun sur un produit différent, poids = 1,5, avec bandeau info teal.
- Les produits sont bien les plus gros stocks (comparer à la page Produits triée par stock).
- Changer le champ à 3 puis recliquer → 3 onglets. Rouvrir la fenêtre → le champ mémorise 3.
- (Ne pas encore imprimer : la déduction arrive en Task 3.)

- [ ] **Step 9 : Commit**

```bash
git add public/js/app.js
git commit -m "$(cat <<'EOF'
feat(labels): bouton Pack découverte (sélection top-N + pré-remplissage 1,5 g)

Ajoute le bouton + champ N (mémorisé), la sélection des plus gros stocks
éligibles, le badge/bandeau teal, et expose app.startDiscoveryPack.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 : Frontend — déduction stock à l'impression

**Files :**
- Modify : `public/js/app.js` — `getAllLabelData()` (~4046-4064), `printLabels()` (bloc après le traitement gift, ~4203-4208), et ajout de `commitDiscoveryPack()` après `recordGiftLines()` (~4271).

**Interfaces :**
- Consumes : `getAllLabelData() -> [{ productId, productName, qty, weight, isGift, isDiscoveryPack, ... }]`, `authFetch`, `apiUrl`, `showToast`, `t`, `loadLatestOrderLabels` (peut ne pas exister), endpoint `POST /api/discovery-pack/commit` (Task 1).
- Produces : `commitDiscoveryPack(discoveryLines)` — POST `{ lines: [{ productId, grams }] }` où `grams = weight * qty`.

- [ ] **Step 1 : Propager `isDiscoveryPack` dans `getAllLabelData()`**

Repérer la fin de l'objet retourné par `getAllLabelData()` :

```js
        showSupplier: showSupplier,
        isGift: !!cfg.isGift
      };
```

Remplacer par :

```js
        showSupplier: showSupplier,
        isGift: !!cfg.isGift,
        isDiscoveryPack: !!cfg.isDiscoveryPack
      };
```

- [ ] **Step 2 : Déclencher le commit dans `printLabels()`**

Repérer le bloc gift dans `printLabels()` :

```js
    var giftLines = allData.filter(function (d) { return d.isGift && d.productId && d.qty > 0 && d.weight > 0; });
    if (giftLines.length > 0 && labelsOrderContext && labelsOrderContext.orderId) {
      recordGiftLines(labelsOrderContext.orderId, labelsOrderContext.orderNumber, giftLines);
    } else if (giftLines.length > 0 && (!labelsOrderContext || !labelsOrderContext.orderId)) {
      showToast(t("labels.giftNoOrder", "Pochon cadeau ignore (commande inconnue)."), "warning");
    }
```

Ajouter **juste après** ce bloc (donc après le contrôle popup bloquée, avant `printWindow.document.write(`) :

```js
    // Préparation pack découverte : déduit le poids (1,5 g x qté) de chaque produit.
    var discoveryLines = allData.filter(function (d) { return d.isDiscoveryPack && d.productId && d.weight > 0; });
    if (discoveryLines.length > 0) {
      commitDiscoveryPack(discoveryLines);
    }
```

- [ ] **Step 3 : Définir `commitDiscoveryPack()`**

Repérer la fin de `recordGiftLines()` (la fonction se termine par `  }` juste avant le commentaire `// FOURNISSEURS (Plan PRO)`) :

```js
    if (failed > 0) {
      showToast(
        t("labels.giftFailed", "{count} ligne(s) cadeau non enregistree(s)").replace("{count}", failed),
        "error"
      );
    }
  }

  // ============================================
  // FOURNISSEURS (Plan PRO)
```

Insérer la nouvelle fonction **entre** le `  }` de fin de `recordGiftLines` et le commentaire `// ====...FOURNISSEURS` :

```js
  // POST la liste des pochons du pack découverte : le backend déduit le stock
  // (grams = 1,5 g x qté par produit), enregistre un mouvement et pousse vers
  // Shopify. Aucune écriture analytics. Calqué sur recordGiftLines.
  async function commitDiscoveryPack(discoveryLines) {
    var payload = discoveryLines.map(function (d) {
      return { productId: d.productId, grams: (Number(d.weight) || 0) * (Number(d.qty) || 1) };
    });
    try {
      var res = await authFetch(apiUrl("/discovery-pack/commit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: payload })
      });
      if (!res.ok) {
        showToast(t("labels.discoveryPackError", "Erreur préparation pack découverte"), "error");
        return;
      }
      var data = await res.json();
      showToast(
        t("labels.discoveryPackDone", "{count} pochon(s) préparé(s), {grams} g déduits")
          .replace("{count}", data.prepared || 0)
          .replace("{grams}", data.totalGramsDeducted || 0),
        "success"
      );
      if (data.skipped && data.skipped.length > 0) {
        showToast(
          t("labels.discoveryPackSkipped", "{count} produit(s) ignoré(s) (stock insuffisant)").replace("{count}", data.skipped.length),
          "warning"
        );
      }
      if (typeof loadLatestOrderLabels === "function") loadLatestOrderLabels();
    } catch (e) {
      console.warn("commitDiscoveryPack error", e);
      showToast(t("labels.discoveryPackError", "Erreur préparation pack découverte"), "error");
    }
  }
```

- [ ] **Step 4 : Vérifier la syntaxe**

Run : `node --check public/js/app.js`
Expected : aucune sortie, code retour 0.

- [ ] **Step 5 : Dogfood — l'impression déduit le stock**

Dans l'app : ouvrir Étiquettes → « Pack découverte » (N=2) → **Imprimer**. Vérifier :
- La feuille d'étiquettes s'ouvre (N produits, 1,5 g chacun).
- Un toast « 2 pochon(s) préparé(s), 3 g déduits » apparaît.
- Sur la page Produits, le stock des 2 produits a baissé de 1,5 g chacun ; l'historique des mouvements montre 2 lignes `discovery_pack_prep` (-1,5 g).
- Cas popup bloquée (bloquer les popups pour le site) : message d'erreur popup **et aucune** déduction de stock.

- [ ] **Step 6 : Commit**

```bash
git add public/js/app.js
git commit -m "$(cat <<'EOF'
feat(labels): déduction stock à l'impression du pack découverte

printLabels POST les lignes isDiscoveryPack à /api/discovery-pack/commit
(grams = 1,5 x qté). Toast résumé + lignes skippées si stock insuffisant.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 : Vérification end-to-end

**Files :** (aucun — vérification)

- [ ] **Step 1 : Parcours complet**

1. Ouvrir Étiquettes, cliquer « Pack découverte » avec N=6.
2. Vérifier que les 6 produits sont bien les plus gros stocks éligibles (pas d'accessoire `trackByUnit`, pas d'archivé).
3. Retirer un onglet (bouton x), changer le format en 50x30, décocher QR.
4. Aperçu → 6 (moins celui retiré = 5) étiquettes s'affichent.
5. Imprimer → feuille correcte + toast « 5 pochon(s) préparé(s), 7.5 g déduits ».
6. Vérifier stock -1,5 g sur les 5 produits + 5 mouvements `discovery_pack_prep`.
7. Vérifier qu'**aucune vente** n'apparaît dans Analytics (pas d'écriture analytics).

- [ ] **Step 2 : Cas limites**

- N supérieur au nombre de produits éligibles → toast « Seulement X produit(s) éligible(s) » + X onglets.
- Champ N vide ou 0 → toast « Nombre de produits invalide », rien ne se passe.
- Stock d'un produit ramené sous 1,5 g → il n'est plus proposé au tour suivant.

---

## Task 5 (optionnelle) : Traductions anglaises

**Files :**
- Modify : `public/js/i18n.js` — ajouter les clés dans le bloc de langue FR (~380-410) et dans **chaque** bloc EN (`labels.giftBadge` apparaît à ~1424, 2368, 3297, 4226, 5155 : ajouter à côté dans chaque bloc).

> Non requis pour la mise en prod : les appels `t(key, "fallback FR")` affichent déjà le français partout. Cette tâche ne sert qu'à l'affichage en anglais.

- [ ] **Step 1 : Ajouter les clés FR** (à côté des clés `labels.gift*` du bloc FR ~403-408)

```js
      "labels.discoveryPack": "Pack découverte",
      "labels.discoveryPackHint": "Sélectionne les N produits au plus gros stock, une étiquette 1,5 g chacun. 1,5 g déduit du stock à l'impression.",
      "labels.discoveryPackCountLabel": "Nombre de produits",
      "labels.discoveryBadge": "Pack découverte",
      "labels.discoveryHint": "Produit sélectionné parmi les plus gros stocks. 1,5 g sera déduit du stock à l'impression.",
      "labels.discoveryPackInvalidN": "Nombre de produits invalide",
      "labels.discoveryPackNone": "Aucun produit éligible (stock suffisant introuvable)",
      "labels.discoveryPackFewer": "Seulement {count} produit(s) éligible(s)",
      "labels.discoveryPackReady": "{count} produit(s) prêt(s) — vérifiez puis imprimez",
      "labels.discoveryPackDone": "{count} pochon(s) préparé(s), {grams} g déduits",
      "labels.discoveryPackSkipped": "{count} produit(s) ignoré(s) (stock insuffisant)",
      "labels.discoveryPackError": "Erreur préparation pack découverte",
```

- [ ] **Step 2 : Ajouter les clés EN** (à côté des clés `labels.gift*` de **chaque** bloc anglais)

```js
      "labels.discoveryPack": "Discovery pack",
      "labels.discoveryPackHint": "Selects the N products with the largest stock, one 1.5 g label each. 1.5 g deducted from stock at print time.",
      "labels.discoveryPackCountLabel": "Number of products",
      "labels.discoveryBadge": "Discovery pack",
      "labels.discoveryHint": "Product picked from the largest stocks. 1.5 g will be deducted from stock at print time.",
      "labels.discoveryPackInvalidN": "Invalid number of products",
      "labels.discoveryPackNone": "No eligible product (no sufficient stock found)",
      "labels.discoveryPackFewer": "Only {count} eligible product(s)",
      "labels.discoveryPackReady": "{count} product(s) ready — review then print",
      "labels.discoveryPackDone": "{count} pouch(es) prepared, {grams} g deducted",
      "labels.discoveryPackSkipped": "{count} product(s) skipped (insufficient stock)",
      "labels.discoveryPackError": "Discovery pack preparation error",
```

- [ ] **Step 3 : Vérifier la syntaxe + commit**

Run : `node --check public/js/i18n.js`
Expected : aucune sortie.

```bash
git add public/js/i18n.js
git commit -m "$(cat <<'EOF'
i18n(labels): traductions FR/EN du pack découverte

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Notes de fin

- **Hors périmètre (v1)** : sélection FEFO d'un lot précis par produit, aperçu autoritatif côté serveur, raccourci dashboard, vente du pack en tant que produit Shopify (kit/bundle).
- **Risque connu** : `pushProductInventoryToShopify` en échec est loggé mais non bloquant — le stock local est déjà décrémenté (comportement aligné sur le flux cadeau). Acceptable en single-instance Render.
- Après validation, fusionner `feat/pack-decouverte-etiquettes` dans `main` (PR ou merge selon préférence).

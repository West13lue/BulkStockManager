# Retour en arrière (undo) sur activités récentes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** Permettre d'annuler (contre-passation) une opération de stock manuelle récente depuis la carte « Activité récente » — v1 : packs découverte (pack entier ou ligne), ajustements de total, restocks — en restaurant le stock (et le CMP quand l'opération l'avait changé) et en re-synchronisant Shopify.

**Architecture :** Nouvel endpoint `POST /api/movements/undo` calqué sur `cancelManualSales` (contre-passation, pas d'effacement — `movementStore` est append-only). Pré-requis de données : `batchId` sur les mouvements de pack découverte (annulation groupée) et `cmpBefore` sur restock/adjust_total (restauration exacte du CMP). Frontend : bouton « ↩︎ Annuler » sur les lignes éligibles.

**Tech Stack :** Node.js + Express (`server.js`), JS vanilla navigateur (`public/js/app.js`, IIFE), persistance fichier JSON via stores existants.

## Global Constraints

- **Pas de bundler / transpileur.** JS vanilla, style de concaténation de chaînes existant.
- **`safeJson(req, res, async () => {...})`** obligatoire pour tout handler parlant à Shopify.
- **`movementStore` append-only** : jamais d'effacement. On écrit un mouvement inverse (`source:"reversal"`).
- **Décrément/crédit stock uniquement via les helpers** : `stock.restockProduct(shop, pid, grams[, price])` (crédit) et `stock.applyOrderToProduct(shop, pid, grams)` (déduction, clampe à 0). Restauration CMP via la nouvelle `stock.setAverageCostPerGram`.
- **Aucune écriture analytics** dans ce périmètre (les sources visées n'ont pas d'analytics).
- **Liste blanche autoritative côté serveur** : `discovery_pack`, `adjust_total`, `restock`. Refus de `sale`, `manual`, `gift`, `order_webhook`, créations/suppressions produit.
- **API publique `app.X()` stable** : toute fonction appelée depuis un `onclick="app.foo()"` doit être ajoutée **à la fois** au tableau `fnNames` (~l.28-101) **et** à l'objet `_real` retourné (~l.12551).
- **Interdiction de `window.prompt/alert/confirm`** (iframe cross-origin) : confirmations via `showModal`.
- **`API_BASE` = `/api`** via `apiUrl(...)` + `authFetch(...)`.
- **UI en français** via `t(key, "fallback FR")` (i18n EN optionnelle, Task 6).
- Repo **sans harnais de test** : vérification = `node --check`, un test unitaire `node -e` ciblé (Task 1), tests live des garde-fous, et dogfood.

---

## Task 0 : Branche de travail

**Files :** (git)

- [ ] **Step 1 : Créer la branche depuis `main`**

```bash
git checkout main && git pull --ff-only origin main && git checkout -b feat/undo-activites-recentes
```

Expected : `Switched to a new branch 'feat/undo-activites-recentes'`

---

## Task 1 : `stockManager.setAverageCostPerGram`

**Files :**
- Modify : `stockManager.js` — ajouter la fonction (après `getProductSnapshot`, ~l.573) et l'exporter (bloc `module.exports`, ~l.575-594).

**Interfaces :**
- Consumes : `getStore(shop)`, `persistState(shop)`, `clampMin0(n)` (tous au niveau module).
- Produces : `setAverageCostPerGram(shop, productId, cmp) -> boolean` (pose `cfg.averageCostPerGram = cmp`, persiste, renvoie `false` si produit introuvable).

- [ ] **Step 1 : Ajouter la fonction**

Repérer la fin de `getProductSnapshot` :

```js
  return {
    productId: pid,
    name: String(cfg.name || pid),
    totalGrams: clampMin0(cfg.totalGrams),
    averageCostPerGram: clampMin0(cfg.averageCostPerGram || 0),
    categoryIds: Array.isArray(cfg.categoryIds) ? cfg.categoryIds.slice() : [],
  };
}
```

Insérer **juste après** cette fonction :

```js

/**
 * Pose directement le CMP (coût moyen pondéré) d'un produit et persiste.
 * Utilisé par l'undo pour restaurer le cmpBefore d'un restock/adjust_total.
 * Renvoie false si le produit n'existe pas.
 */
function setAverageCostPerGram(shop, productId, cmp) {
  const sh = String(shop || "default");
  const pid = String(productId || "");
  const store = getStore(sh);
  const cfg = store[pid];
  if (!cfg) return false;
  cfg.averageCostPerGram = clampMin0(Number(cmp) || 0);
  persistState(sh);
  return true;
}
```

- [ ] **Step 2 : Exporter la fonction**

Repérer :

```js
  // a... NOUVEAU pour Analytics
  getProductCMPSnapshot,
  getProductSnapshot,
};
```

Remplacer par :

```js
  // a... NOUVEAU pour Analytics
  getProductCMPSnapshot,
  getProductSnapshot,
  setAverageCostPerGram,
};
```

- [ ] **Step 3 : Vérifier la syntaxe**

Run : `node --check stockManager.js`
Expected : aucune sortie.

- [ ] **Step 4 : Test unitaire ciblé (`node -e`)**

```bash
DATA_DIR="$TEMP/undo_test_stockmgr" node -e "const s=require('./stockManager');const shop='default';s.upsertImportedProductConfig(shop,{productId:'t1',name:'T',variants:{'1':{gramsPerUnit:1,inventoryItemId:99}},totalGrams:10,averageCostPerGram:2});console.log('ret',s.setAverageCostPerGram(shop,'t1',4.5));console.log('after',s.getProductCMPSnapshot(shop,'t1'));console.log('missing',s.setAverageCostPerGram(shop,'nope',1));"
```

Expected : `ret true`, `after 4.5`, `missing false`.

- [ ] **Step 5 : Commit**

```bash
git add stockManager.js
git commit -m "$(cat <<'EOF'
feat(stock): setAverageCostPerGram pour restaurer le CMP à l'undo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 : Capturer `batchId` et `cmpBefore` (données forward-looking)

**Files :**
- Modify : `server.js` — `POST /api/discovery-pack/commit` (~l.3596), `POST /api/restock` + `POST /api/products/:productId/restock` (blocs identiques ~l.3135/3188 et l.3145/3198), `POST /api/products/:productId/adjust-total` (~l.1631/1641).

**Interfaces :**
- Produces : les mouvements `discovery_pack` portent `batchId` (commun à un même pack) ; les mouvements `restock` et `adjust_total` portent `cmpBefore` quand l'opération a changé le CMP (ajout de stock avec prix > 0). Consommés par l'endpoint undo (Task 3).

- [ ] **Step 1 : `batchId` dans discovery-pack/commit — générer l'id**

Repérer :

```js
    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (rawLines.length === 0) return apiError(res, 400, "Aucune ligne à préparer");

    const prepared = [];
```

Remplacer par :

```js
    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (rawLines.length === 0) return apiError(res, 400, "Aucune ligne à préparer");

    // Identifiant commun à toutes les lignes de ce pack -> permet d'annuler
    // le pack entier d'un coup (voir POST /api/movements/undo).
    const batchId = "dp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    const prepared = [];
```

- [ ] **Step 2 : `batchId` dans discovery-pack/commit — l'écrire dans le mouvement**

Repérer :

```js
          movementStore.addMovement({
            source: "discovery_pack",
            type: "discovery_pack_prep",
            productId,
            productName,
            gramsDelta: -Math.abs(grams),
            totalAfter,
            shop,
          }, shop);
```

Remplacer par :

```js
          movementStore.addMovement({
            source: "discovery_pack",
            type: "discovery_pack_prep",
            productId,
            productName,
            gramsDelta: -Math.abs(grams),
            totalAfter,
            batchId,
            shop,
          }, shop);
```

- [ ] **Step 3 : `cmpBefore` dans les deux routes restock (replace_all)**

Repérer la ligne (présente **2 fois**, identiques) :

```js
    const updated = await stock.restockProduct(shop, productId, grams, purchasePricePerGram);
```

La remplacer (activer **replace_all**) par :

```js
    const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, productId) : 0;
    const updated = await stock.restockProduct(shop, productId, grams, purchasePricePerGram);
```

Puis repérer le bloc mouvement restock (présent **2 fois**, identiques) :

```js
          source: "restock",
          productId,
          productName: updated.name,
          gramsDelta: Math.abs(grams),
          purchasePricePerGram: purchasePricePerGram > 0 ? purchasePricePerGram : undefined,
          totalAfter: updated.totalGrams,
```

Le remplacer (activer **replace_all**) par :

```js
          source: "restock",
          productId,
          productName: updated.name,
          gramsDelta: Math.abs(grams),
          purchasePricePerGram: purchasePricePerGram > 0 ? purchasePricePerGram : undefined,
          cmpBefore: purchasePricePerGram > 0 ? cmpBefore : undefined,
          totalAfter: updated.totalGrams,
```

- [ ] **Step 4 : `cmpBefore` dans adjust-total**

Repérer :

```js
    const updated = await stock.restockProduct(shop, productId, gramsDelta, purchasePricePerGram);
    if (!updated) return apiError(res, 404, "Produit introuvable");
```

Remplacer par :

```js
    const cmpBefore = stock.getProductCMPSnapshot ? stock.getProductCMPSnapshot(shop, productId) : 0;
    const updated = await stock.restockProduct(shop, productId, gramsDelta, purchasePricePerGram);
    if (!updated) return apiError(res, 404, "Produit introuvable");
```

Puis repérer, dans le mouvement `adjust_total` :

```js
          source: "adjust_total",
          productId,
          productName: updated.name,
          gramsDelta,
          purchasePricePerGram: gramsDelta > 0 && purchasePricePerGram > 0 ? purchasePricePerGram : undefined,
          totalAfter: updated.totalGrams,
```

Remplacer par :

```js
          source: "adjust_total",
          productId,
          productName: updated.name,
          gramsDelta,
          purchasePricePerGram: gramsDelta > 0 && purchasePricePerGram > 0 ? purchasePricePerGram : undefined,
          cmpBefore: gramsDelta > 0 && purchasePricePerGram > 0 ? cmpBefore : undefined,
          totalAfter: updated.totalGrams,
```

- [ ] **Step 5 : Vérifier la syntaxe**

Run : `node --check server.js`
Expected : aucune sortie.

- [ ] **Step 6 : Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
feat(movements): batchId (pack découverte) + cmpBefore (restock/adjust) pour l'undo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 : Endpoint `POST /api/movements/undo`

**Files :**
- Modify : `server.js` — insérer un nouveau bloc **juste après** la fin du handler `/api/discovery-pack/commit` (le `});` qui précède `router.post("/api/test-order", ...)`).

**Interfaces :**
- Consumes : `getShop`, `apiError`, `safeJson`, `movementStore.listMovements({shop,days,limit})`, `stock.restockProduct`, `stock.applyOrderToProduct`, `stock.setAverageCostPerGram` (Task 1), `stock.getProductSnapshot`, `movementStore.addMovement`, `pushProductInventoryToShopify`, `logEvent`.
- Produces : `POST /api/movements/undo`. Body `{ movementId }` **ou** `{ batchId }`. Réponse `{ success, undone, netStockDelta, cmpRestored, undoneLines:[{id,productId,productName,gramsRestored}], skipped:[{id,reason}] }`.

- [ ] **Step 1 : Insérer le handler**

Repérer la fin de `/api/discovery-pack/commit` :

```js
    res.json({
      success: true,
      prepared: prepared.length,
      totalGramsDeducted: Math.round(totalGramsDeducted * 100) / 100,
      preparedLines: prepared,
      skipped,
    });
  });
});

router.post("/api/test-order", (req, res) => {
```

Insérer le nouveau bloc **entre** le `});` de clôture et `router.post("/api/test-order", ...)` :

```js
// Retour en arrière (contre-passation) d'une opération de stock manuelle récente.
// Append-only : on n'efface pas le mouvement d'origine, on applique l'inverse + on
// écrit un mouvement "reversal". v1 : discovery_pack, adjust_total, restock.
router.post("/api/movements/undo", (req, res) => {
  safeJson(req, res, async () => {
    const shop = getShop(req);
    if (!shop) return apiError(res, 400, "Shop introuvable");

    const UNDOABLE = new Set(["discovery_pack", "adjust_total", "restock"]);
    const movementId = String(req.body?.movementId || "").trim();
    const batchId = String(req.body?.batchId || "").trim();
    if (!movementId && !batchId) return apiError(res, 400, "movementId ou batchId requis");

    const all = movementStore.listMovements ? movementStore.listMovements({ shop, days: 90, limit: 10000 }) : [];
    const reversedIds = new Set(all.filter((m) => m.reversalOf).map((m) => String(m.reversalOf)));

    let targets;
    if (batchId) {
      targets = all.filter((m) => m.batchId === batchId && m.source === "discovery_pack");
    } else {
      targets = all.filter((m) => String(m.id) === movementId);
    }

    // Uniquement les cibles annulables et non déjà annulées.
    targets = targets.filter((m) =>
      UNDOABLE.has(m.source) && !m.reversalOf && m.source !== "reversal" && !reversedIds.has(String(m.id))
    );

    if (targets.length === 0) {
      return apiError(res, 400, "Rien à annuler (déjà annulé ou non annulable)");
    }

    const undoneLines = [];
    const skipped = [];
    const touched = new Set();
    let netStockDelta = 0;
    let cmpRestored = false;

    for (const m of targets) {
      const productId = String(m.productId || "");
      const delta = Number(m.gramsDelta || 0);
      if (!productId || !Number.isFinite(delta) || delta === 0) {
        skipped.push({ id: m.id, reason: "mouvement sans effet stock" });
        continue;
      }

      try {
        if (delta < 0) {
          // L'opération avait déduit -> on restocke (CMP neutre : pas de prix).
          await stock.restockProduct(shop, productId, Math.abs(delta));
        } else {
          // L'opération avait ajouté -> on déduit.
          await stock.applyOrderToProduct(shop, productId, delta);
        }
      } catch (e) {
        skipped.push({ id: m.id, reason: "stock: " + e.message });
        continue;
      }

      // Restaurer le CMP si l'opération d'origine l'avait changé.
      if (m.cmpBefore !== undefined && m.cmpBefore !== null && typeof stock.setAverageCostPerGram === "function") {
        try {
          stock.setAverageCostPerGram(shop, productId, Number(m.cmpBefore));
          cmpRestored = true;
        } catch (e) {
          logEvent("undo_cmp_restore_error", { shop, productId, error: e.message }, "error");
        }
      }

      const snap = stock.getProductSnapshot ? stock.getProductSnapshot(shop, productId) : null;
      const totalAfter = snap ? Number(snap.totalGrams || 0) : undefined;

      if (movementStore && movementStore.addMovement) {
        movementStore.addMovement({
          source: "reversal",
          type: "undo",
          productId,
          productName: m.productName || productId,
          gramsDelta: -delta,
          totalAfter,
          reversalOf: m.id,
          batchId: m.batchId || undefined,
          note: "Annulation de " + (m.source || "?"),
          shop,
        }, shop);
      }

      touched.add(productId);
      netStockDelta += -delta;
      undoneLines.push({ id: m.id, productId, productName: m.productName || productId, gramsRestored: -delta });
    }

    // Sync Shopify 1x par produit touché (best-effort).
    for (const pid of touched) {
      const snap = stock.getProductSnapshot ? stock.getProductSnapshot(shop, pid) : null;
      if (snap) {
        try {
          await pushProductInventoryToShopify(shop, snap);
        } catch (e) {
          logEvent("inventory_push_error", { shop, productId: pid, error: e.message }, "error");
        }
      }
    }

    logEvent("movement_undone", { shop, undone: undoneLines.length, batchId: batchId || undefined }, "info");

    res.json({
      success: true,
      undone: undoneLines.length,
      netStockDelta: Math.round(netStockDelta * 100) / 100,
      cmpRestored,
      undoneLines,
      skipped,
    });
  });
});

```

- [ ] **Step 2 : Vérifier la syntaxe**

Run : `node --check server.js`
Expected : aucune sortie.

- [ ] **Step 3 : Tester les garde-fous en live**

Démarrer le serveur (auth off) :

```powershell
$env:NODE_ENV="development"; $env:API_AUTH_REQUIRED="false"; $env:SHOP_NAME="default"; $env:PORT="3012"; node server.js
```

Dans un autre terminal :

```bash
echo "== ni movementId ni batchId (400) =="; curl -s -X POST http://localhost:3012/api/movements/undo -H "Content-Type: application/json" -d '{}'; echo
echo "== id inconnu (400 rien à annuler) =="; curl -s -X POST http://localhost:3012/api/movements/undo -H "Content-Type: application/json" -d '{"movementId":"nope"}'; echo
echo "== batchId inconnu (400) =="; curl -s -X POST http://localhost:3012/api/movements/undo -H "Content-Type: application/json" -d '{"batchId":"dp_x"}'; echo
```

Expected :
- `{"error":"movementId ou batchId requis"}`
- `{"error":"Rien à annuler (déjà annulé ou non annulable)"}`
- `{"error":"Rien à annuler (déjà annulé ou non annulable)"}`

Arrêter le serveur (Ctrl+C). (Le chemin happy-path — vraie annulation — se vérifie au dogfood, Task 5, faute de produit semable en local.)

- [ ] **Step 4 : Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
feat(movements): endpoint /api/movements/undo (contre-passation stock)

Annule discovery_pack (par id ou batchId), adjust_total, restock : inverse
le stock, restaure cmpBefore si présent, écrit un mouvement reversal, sync Shopify.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 : Frontend — bouton « Annuler » + logique undo

**Files :**
- Modify : `public/js/app.js` — `renderDashboardActivityList` (~l.2928-2968), `loadFullActivityLog` (~l.3028-3050), ajout des fonctions undo (après `renderDashboardActivityList`), tableau `fnNames` (~l.95, section dashboard) et objet `_real` (~l.12822, près de `switchDashboardActivity`).

**Interfaces :**
- Consumes : `dashboardActivityCache` (var module), `authFetch`, `apiUrl`, `showToast`, `showModal`, `closeModal`, `esc`, `t`, `state`, `loadProducts`, `renderTab`, `loadDashboardMovementsAndActivity`, `loadFullActivityLog`, endpoint `POST /api/movements/undo` (Task 3).
- Produces : `app.undoMovement(id)`, `app.undoMovementConfirmed(id)`, `app.undoDiscoveryBatch(batchId, lineId)`, `app.undoBatchConfirmed(batchId)`.

- [ ] **Step 1 : Bouton « Annuler » dans `renderDashboardActivityList`**

Repérer le début de la boucle de rendu :

```js
    var html = '<div class="activity-list" style="max-height:280px;overflow-y:auto">';
    movements.forEach(function(m) {
      var mType = m.type || m.source || 'adjustment';
```

Remplacer par (ajoute le calcul `reversedIds` + les flags d'éligibilité) :

```js
    var UNDOABLE = { discovery_pack: 1, adjust_total: 1, restock: 1 };
    var reversedIds = {};
    (dashboardActivityCache || []).forEach(function(x) { if (x.reversalOf) reversedIds[String(x.reversalOf)] = 1; });

    var html = '<div class="activity-list" style="max-height:280px;overflow-y:auto">';
    movements.forEach(function(m) {
      var mType = m.type || m.source || 'adjustment';
      var mid = m.id ? String(m.id) : '';
      var isReversal = m.source === 'reversal' || !!m.reversalOf;
      var alreadyUndone = mid && reversedIds[mid];
      var canUndo = !isReversal && UNDOABLE[m.source] && mid && !alreadyUndone;
      var undoBtn = canUndo
        ? '<button class="btn btn-ghost btn-sm" style="flex-shrink:0" title="' + t("activity.undo", "Annuler") + '" onclick="app.' +
            (m.source === 'discovery_pack' && m.batchId
              ? 'undoDiscoveryBatch(\'' + esc(String(m.batchId)) + '\',\'' + esc(mid) + '\')'
              : 'undoMovement(\'' + esc(mid) + '\')') +
          '"><i data-lucide="undo-2"></i></button>'
        : (alreadyUndone
            ? '<span class="badge" style="flex-shrink:0;opacity:0.6;font-size:10px">' + t("activity.undone", "Annulé") + '</span>'
            : '');
```

- [ ] **Step 2 : Insérer le bouton dans le HTML de la ligne (dashboard)**

Repérer la fermeture de l'`activity-item` dans la même boucle :

```js
        '<div class="activity-details" style="display:flex;align-items:center;gap:8px;margin-top:2px">' +
        '<span class="badge badge-' + typeClass + '" style="font-size:10px">' + typeLabel + '</span>' +
        '<span style="font-weight:600;color:var(--' + (delta >= 0 ? 'success' : 'danger') + ')">' + deltaStr + '</span>' +
        '<span style="color:var(--text-tertiary);font-size:12px">' + dateStr + '</span>' +
        '</div>' +
        '</div>' +
        '</div>';
```

Remplacer par (ajoute `undoBtn` comme dernier enfant de l'`activity-item`) :

```js
        '<div class="activity-details" style="display:flex;align-items:center;gap:8px;margin-top:2px">' +
        '<span class="badge badge-' + typeClass + '" style="font-size:10px">' + typeLabel + '</span>' +
        '<span style="font-weight:600;color:var(--' + (delta >= 0 ? 'success' : 'danger') + ')">' + deltaStr + '</span>' +
        '<span style="color:var(--text-tertiary);font-size:12px">' + dateStr + '</span>' +
        '</div>' +
        '</div>' +
        undoBtn +
        '</div>';
```

- [ ] **Step 3 : Définir les fonctions undo**

Repérer la fin de `renderDashboardActivityList` :

```js
    html += '</div>';

    container.innerHTML = html;
  }

  function getActivityVerb(type) {
```

Insérer **entre** le `}` de `renderDashboardActivityList` et `function getActivityVerb` :

```js

  // ---- Retour en arrière (undo) d'une activité récente ----
  function undoMovement(movementId) {
    showModal({
      title: '<i data-lucide="undo-2"></i> ' + t("activity.undoTitle", "Annuler l'operation"),
      size: "sm",
      content: '<p>' + t("activity.undoConfirm", "Le stock de cette operation sera restaure. Confirmer ?") + '</p>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
        '<button class="btn btn-primary" onclick="app.undoMovementConfirmed(\'' + esc(String(movementId)) + '\')"><i data-lucide="undo-2"></i> ' + t("activity.undoConfirmBtn", "Oui, annuler") + '</button>'
    });
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function undoDiscoveryBatch(batchId, lineId) {
    showModal({
      title: '<i data-lucide="undo-2"></i> ' + t("activity.undoTitle", "Annuler l'operation"),
      size: "sm",
      content: '<p>' + t("activity.undoBatchQ", "Annuler tout le pack decouverte, ou seulement cette ligne ?") + '</p>',
      footer:
        '<button class="btn btn-ghost" onclick="app.closeModal()">' + t("action.cancel", "Annuler") + '</button>' +
        '<button class="btn btn-secondary" onclick="app.undoMovementConfirmed(\'' + esc(String(lineId)) + '\')">' + t("activity.undoLineBtn", "Cette ligne") + '</button>' +
        '<button class="btn btn-primary" onclick="app.undoBatchConfirmed(\'' + esc(String(batchId)) + '\')">' + t("activity.undoBatchBtn", "Tout le pack") + '</button>'
    });
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  function undoMovementConfirmed(movementId) {
    closeModal();
    _postUndo({ movementId: movementId });
  }

  function undoBatchConfirmed(batchId) {
    closeModal();
    _postUndo({ batchId: batchId });
  }

  async function _postUndo(body) {
    try {
      var res = await authFetch(apiUrl("/movements/undo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        showToast((data && data.error) || t("activity.undoError", "Erreur lors de l'annulation"), "error");
        return;
      }
      var g = Number(data.netStockDelta) || 0;
      var msg = g >= 0
        ? t("activity.undoneRestored", "Annule — {g} g remis en stock").replace("{g}", g)
        : t("activity.undoneRemoved", "Annule — {g} g retires").replace("{g}", Math.abs(g));
      showToast(msg, "success");
      if (data.cmpRestored === false) {
        showToast(t("activity.undoCmpWarn", "Stock remis, mais le cout moyen n'a pas pu etre restaure (operation ancienne)."), "warning");
      }
      // Recalcul : recharger produits + re-rendre l'onglet courant + le journal si ouvert.
      if (typeof loadProducts === "function") await loadProducts();
      if (typeof renderTab === "function" && state.currentTab) renderTab(state.currentTab);
      if (document.getElementById("fullActivityContent") && typeof loadFullActivityLog === "function") loadFullActivityLog();
    } catch (e) {
      console.warn("undo error", e);
      showToast(t("activity.undoError", "Erreur lors de l'annulation"), "error");
    }
  }
```

- [ ] **Step 4 : Bouton « Annuler » dans le journal complet (`loadFullActivityLog`)**

Repérer, dans `loadFullActivityLog`, le début du groupe par date :

```js
      var html = '';
      Object.keys(groupedByDate).sort().reverse().forEach(function(dateKey) {
```

Remplacer par :

```js
      var UNDOABLE = { discovery_pack: 1, adjust_total: 1, restock: 1 };
      var reversedIds = {};
      movements.forEach(function(x) { if (x.reversalOf) reversedIds[String(x.reversalOf)] = 1; });

      var html = '';
      Object.keys(groupedByDate).sort().reverse().forEach(function(dateKey) {
```

Puis repérer la fermeture de la ligne de log :

```js
            '<span class="badge badge-' + typeClass + '" style="font-size:10px">' + typeLabel + '</span>' +
            '<span style="font-weight:600;color:var(--' + (delta >= 0 ? 'success' : 'danger') + ');min-width:70px;text-align:right">' + deltaStr + '</span>' +
            '</div>';
```

Remplacer par :

```js
            '<span class="badge badge-' + typeClass + '" style="font-size:10px">' + typeLabel + '</span>' +
            '<span style="font-weight:600;color:var(--' + (delta >= 0 ? 'success' : 'danger') + ');min-width:70px;text-align:right">' + deltaStr + '</span>' +
            (function() {
              var mid = m.id ? String(m.id) : '';
              var isReversal = m.source === 'reversal' || !!m.reversalOf;
              var alreadyUndone = mid && reversedIds[mid];
              if (!isReversal && UNDOABLE[m.source] && mid && !alreadyUndone) {
                return '<button class="btn btn-ghost btn-sm" title="' + t("activity.undo", "Annuler") + '" onclick="app.' +
                  (m.source === 'discovery_pack' && m.batchId
                    ? 'undoDiscoveryBatch(\'' + esc(String(m.batchId)) + '\',\'' + esc(mid) + '\')'
                    : 'undoMovement(\'' + esc(mid) + '\')') +
                  '"><i data-lucide="undo-2"></i></button>';
              }
              if (alreadyUndone) return '<span class="badge" style="opacity:0.6;font-size:10px">' + t("activity.undone", "Annule") + '</span>';
              return '';
            })() +
            '</div>';
```

- [ ] **Step 5 : Exposer les fonctions — `fnNames`**

Repérer :

```js
    // Dashboard refonte
    'switchDashboardActivity',
```

Remplacer par :

```js
    // Dashboard refonte
    'switchDashboardActivity',
    'undoMovement', 'undoMovementConfirmed', 'undoDiscoveryBatch', 'undoBatchConfirmed',
```

- [ ] **Step 6 : Exposer les fonctions — objet `_real`**

Repérer :

```js
    switchDashboardActivity: switchDashboardActivity,
```

Remplacer par :

```js
    switchDashboardActivity: switchDashboardActivity,
    undoMovement: undoMovement,
    undoMovementConfirmed: undoMovementConfirmed,
    undoDiscoveryBatch: undoDiscoveryBatch,
    undoBatchConfirmed: undoBatchConfirmed,
```

- [ ] **Step 7 : Vérifier la syntaxe + câblage**

Run : `node --check public/js/app.js`
Expected : aucune sortie.

Run : `grep -nE "undoMovement|undoDiscoveryBatch|undoBatchConfirmed|_postUndo" public/js/app.js`
Expected : chaque fonction est définie **et** exposée (fnNames + _real) ; `undoMovement`/`undoDiscoveryBatch` référencés dans les `onclick`.

- [ ] **Step 8 : Commit**

```bash
git add public/js/app.js
git commit -m "$(cat <<'EOF'
feat(activity): bouton Annuler sur les activités récentes (dashboard + journal)

Contre-passation via /api/movements/undo : pack entier ou ligne, confirmation
modale, badge "Annulé", rechargement produits/dashboard après coup.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 : Vérification end-to-end (dogfood utilisateur)

**Files :** (aucun — nécessite l'app authentifiée sur la boutique réelle)

- [ ] **Step 1 : Pack découverte — annuler tout le pack**

1. Faire un pack découverte (N=3) et imprimer (stock −1,5 g × 3).
2. Dashboard → carte « Activité récente » : 3 lignes `discovery_pack` avec bouton ↩︎.
3. Cliquer ↩︎ sur une ligne → modale « tout le pack / cette ligne ».
4. « Tout le pack » → toast « Annulé — 4.5 g remis en stock ».
5. Vérifier : stock **+1,5 g** restauré sur les 3 produits ; 3 nouvelles lignes `reversal`/`undo` (+1,5 g) ; les 3 lignes d'origine grisées « Annulé ».

- [ ] **Step 2 : Pack découverte — annuler une seule ligne**

Refaire un pack, annuler via « Cette ligne » → seul ce produit est restauré ; les autres lignes gardent leur bouton ↩︎.

- [ ] **Step 3 : Ajustement de total + restock**

1. Faire un ajustement de total (ex. +50 g) puis l'annuler → stock revient à l'état initial ; si un prix d'achat était saisi, le CMP est restauré (sinon toast « coût moyen non restauré »).
2. Faire un restock avec prix d'achat, vérifier le CMP, puis annuler → stock −grammes **et** CMP restauré à sa valeur d'avant.

- [ ] **Step 4 : Garde-fous UI**

- Une vente (manuelle/Shopify) n'affiche **pas** de bouton ↩︎.
- Une ligne déjà annulée affiche « Annulé » (pas de double-annulation).
- Journal complet (« Voir tout ») : mêmes boutons.

---

## Task 6 (optionnelle) : Traductions EN

**Files :**
- Modify : `public/js/i18n.js` — ajouter les clés `activity.undo*` dans le bloc FR (~l.380+) et dans chaque bloc EN.

> Non requis : les fallbacks FR de `t()` rendent déjà le français partout.

- [ ] **Step 1 : Clés FR + EN**

FR :

```js
      "activity.undo": "Annuler",
      "activity.undone": "Annulé",
      "activity.undoTitle": "Annuler l'opération",
      "activity.undoConfirm": "Le stock de cette opération sera restauré. Confirmer ?",
      "activity.undoConfirmBtn": "Oui, annuler",
      "activity.undoBatchQ": "Annuler tout le pack découverte, ou seulement cette ligne ?",
      "activity.undoLineBtn": "Cette ligne",
      "activity.undoBatchBtn": "Tout le pack",
      "activity.undoneRestored": "Annulé — {g} g remis en stock",
      "activity.undoneRemoved": "Annulé — {g} g retirés",
      "activity.undoCmpWarn": "Stock remis, mais le coût moyen n'a pas pu être restauré (opération ancienne).",
      "activity.undoError": "Erreur lors de l'annulation",
```

EN (dans chaque bloc anglais) :

```js
      "activity.undo": "Undo",
      "activity.undone": "Undone",
      "activity.undoTitle": "Undo the operation",
      "activity.undoConfirm": "This operation's stock will be restored. Confirm?",
      "activity.undoConfirmBtn": "Yes, undo",
      "activity.undoBatchQ": "Undo the whole discovery pack, or just this line?",
      "activity.undoLineBtn": "This line",
      "activity.undoBatchBtn": "Whole pack",
      "activity.undoneRestored": "Undone — {g} g restored to stock",
      "activity.undoneRemoved": "Undone — {g} g removed",
      "activity.undoCmpWarn": "Stock restored, but the average cost could not be restored (old operation).",
      "activity.undoError": "Undo failed",
```

- [ ] **Step 2 : Vérifier + commit**

Run : `node --check public/js/i18n.js`

```bash
git add public/js/i18n.js
git commit -m "$(cat <<'EOF'
i18n(activity): traductions FR/EN de l'undo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Notes de fin

- **Hors périmètre v1** : undo des pochons cadeaux (`gift`, analytique) et des ventes (déjà géré / risqué), fenêtre temporelle limitée, regroupement visuel du pack en une ligne.
- **Rétro-compat** : les packs/restocks créés **avant** cette MAJ n'ont ni `batchId` (→ annulation ligne par ligne) ni `cmpBefore` (→ stock restauré, CMP non restauré, signalé).
- **Risque connu** : `pushProductInventoryToShopify` en échec est loggé mais non bloquant (stock local déjà corrigé). Acceptable en single-instance Render.

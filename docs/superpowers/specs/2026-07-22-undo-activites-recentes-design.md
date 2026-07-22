# Retour en arrière (undo) sur les activités récentes

**Date :** 2026-07-22
**App :** Stock Manager Pro (Bulk Stock Manager) — Shopify embedded, Cloud Store CBD
**Statut :** design validé, prêt pour plan d'implémentation

## Problème / besoin

L'utilisateur veut pouvoir **annuler rapidement** une opération de stock récente et
que les chiffres se recalculent. Exemple concret : « j'ai fait un pack découverte de
7,5 g alors qu'il fallait 15 g ; je veux remettre le stock et recommencer ».

## Décisions de cadrage (validées)

| Question | Décision |
|---|---|
| Périmètre | Opérations **manuelles de stock**. v1 = `discovery_pack`, `adjust_total`, `restock`. |
| Exclus | `order_webhook` (vente Shopify auto) ; ventes manuelles (déjà annulables via Analytics) ; `gift` (reporté v2, touche l'analytics d'une commande). |
| Mécanisme | **Contre-passation** (mouvement inverse), pas d'effacement — `movementStore` est append-only. Calqué sur `cancelManualSales` (server.js:3363). |
| Granularité pack | **Les deux** : « annuler tout le pack » (via `batchId` commun) **et** « annuler cette ligne ». |
| CMP | `restock` et `adjust_total` (positif + prix) modifient le CMP. On capture `cmpBefore` à partir de maintenant → l'undo le restaure exactement. Opérations antérieures : restitution stock seule, CMP non restauré (signalé). |

## Flux utilisateur

1. Sur une ligne d'activité récente éligible (dashboard + journal complet), un bouton **« ↩︎ Annuler »**.
2. Clic → confirmation via `showModal` (jamais `window.confirm`, bloqué en iframe).
   - Ligne d'un pack découverte (`batchId` présent) : choix **« Annuler tout le pack (N produits, X g) »** ou **« Seulement cette ligne »**.
   - Autres sources : confirmation simple « Annuler cette opération ? Le stock sera restauré. »
3. Validation → le stock est restauré (contre-passation), Shopify re-synchronisé, un
   mouvement d'annulation est enregistré. Toast résumé.
4. Le dashboard/alertes se rechargent (c'est le « recalcul »).
5. Les lignes déjà annulées sont grisées + badge **« Annulé »** (pas de double-annulation).

## Sémantique de l'inverse (par source)

Pour un mouvement d'origine `m` avec `m.gramsDelta` :

- **Stock** :
  - `m.gramsDelta < 0` (l'opération a **déduit**, ex. `discovery_pack`) → **restock** `|gramsDelta|` via `stock.restockProduct(shop, pid, |delta|)` **sans prix** (CMP neutre).
  - `m.gramsDelta > 0` (l'opération a **ajouté**, ex. `restock`, `adjust_total` positif) → **déduire** `gramsDelta` via `stock.applyOrderToProduct(shop, pid, gramsDelta)`.
- **CMP** : si `m.cmpBefore` est présent (l'opération avait changé le CMP), restaurer via
  `stock.setAverageCostPerGram(shop, pid, m.cmpBefore)`. Sinon, ne pas toucher le CMP.
- **Audit** : écrire un mouvement `source:"reversal"`, `type:"undo"`, `reversalOf:<m.id>`,
  `batchId:<m.batchId?>`, `gramsDelta:-m.gramsDelta`, `totalAfter:<stock recalculé>`.
- **Shopify** : `pushProductInventoryToShopify(shop, snapshotAprès)` (best-effort, 1× par produit).

`discovery_pack` et les `adjust_total` négatifs/sans prix n'ont jamais de `cmpBefore` → restitution stock pure.

## Backend

### Ajouts de champ (forward-looking)

- **`batchId`** : ajouté à chaque mouvement écrit par `POST /api/discovery-pack/commit`
  (un `batchId` unique par appel, partagé par toutes les lignes du même pack).
- **`cmpBefore`** : capturé (via `stock.getProductCMPSnapshot(shop, pid)` **avant** l'opération)
  et stocké dans le mouvement `restock` (server.js:3145, 3198) et `adjust_total`
  (server.js:1641) **uniquement quand l'opération change le CMP** (ajout de stock avec prix > 0).

### Nouvelle fonction stockManager

- `setAverageCostPerGram(shop, productId, cmp)` : pose `cfg.averageCostPerGram = cmp` et
  persiste (même patron que la route `PATCH /average-cost`, server.js:1666-1703). Exportée.

### Nouvel endpoint

`POST /api/movements/undo` (Free, `safeJson`). Body : `{ movementId }` **ou** `{ batchId }`.

1. `shop = getShop(req)`.
2. Charger une fenêtre récente : `const all = movementStore.listMovements({ shop, days: 90, limit: 10000 })`.
3. Construire `reversedIds = new Set(all.filter(x => x.reversalOf).map(x => x.reversalOf))`.
4. Déterminer les cibles :
   - si `batchId` : `all.filter(x => x.batchId === batchId && x.source === "discovery_pack")` ;
   - sinon : `all.filter(x => x.id === movementId)`.
5. Filtrer : garder celles dont `source ∈ {discovery_pack, adjust_total, restock}`,
   **non déjà annulées** (`!reversedIds.has(x.id)`), et non `reversalOf`/`reversal`.
   Si aucune cible valide → `apiError(400, "Rien à annuler (déjà annulé ou non annulable)")`.
6. Pour chaque cible : appliquer l'inverse (règles ci-dessus), écrire le mouvement de
   contre-passation, marquer le produit comme touché.
7. Sync Shopify 1× par produit touché.
8. `logEvent("movement_undone", { shop, count, batchId? }, "info")`.
9. Réponse : `{ success:true, undone:<n>, restoredGrams:<g>, cmpRestored:<bool>, skipped:[{id, reason}] }`.

**Liste blanche** codée en dur côté serveur (autorité). Refus explicite de `order_webhook`,
`sale`, `manual`, `gift`, créations/suppressions produit, etc.

## Frontend — `public/js/app.js`

- **`renderDashboardActivityList`** (et le rendu du journal complet `loadFullActivityLog`) :
  ajouter un bouton **« ↩︎ Annuler »** sur les lignes éligibles.
  - Éligible = `source ∈ liste blanche` **et** `id ∉ reversedIds` **et** la ligne n'est
    pas elle-même une contre-passation (`source !== "reversal"` et `!m.reversalOf`).
  - `reversedIds` calculé côté client à partir de la liste de mouvements reçue
    (`m.reversalOf`).
  - Lignes déjà annulées : grisées + badge « Annulé ».
- **`undoMovement(movementId)`** / **`undoDiscoveryBatch(batchId)`** :
  - ouvrir une confirmation `showModal` ; pour un pack, proposer « tout le pack » vs « cette ligne » ;
  - POST `/api/movements/undo` avec `{ movementId }` ou `{ batchId }` ;
  - au succès : toast résumé (`undone`, `restoredGrams`, alerte si `cmpRestored===false`),
    puis recharger le dashboard (`loadDashboardMovementsAndActivity` + `loadProducts` /
    `renderTab`) ; si le journal complet est ouvert, le rafraîchir.
- Exposer `undoMovement` et `undoDiscoveryBatch` dans `fnNames` **et** l'objet `_real`
  (contrainte proxy `window.app`).

## Éligibilité (résumé)

| Source | Annulable v1 | Effet inverse |
|---|---|---|
| `discovery_pack` | ✅ (pack + ligne) | restock +grammes (CMP neutre) |
| `adjust_total` | ✅ | inverse le signe ; restaure `cmpBefore` si présent |
| `restock` | ✅ | déduit les grammes ; restaure `cmpBefore` si présent |
| `gift` | ❌ v2 | — (touche l'analytics d'une commande) |
| `sale` / `manual` | ❌ (déjà : Analytics → Annuler la vente) | — |
| `order_webhook` | ❌ | — (désync commande Shopify) |

## Cas limites

- **Déjà annulé** : bouton masqué côté client ; refusé côté serveur (garde `reversedIds`).
- **Stock insuffisant pour ré-inverser un restock** (ventes survenues entre-temps) :
  `applyOrderToProduct` clampe à 0 ; l'écart est signalé dans le résumé. Rare (activités récentes).
- **Mouvement sans `cmpBefore`** (opération antérieure à cette MAJ) : stock restauré,
  CMP non restauré → `cmpRestored:false` + avertissement toast.
- **Pack sans `batchId`** (préparé avant la MAJ) : seulement l'annulation ligne par ligne.
- **Push Shopify en échec** : loggé, non bloquant (stock local déjà corrigé).

## Fichiers touchés

- `server.js` — endpoint `POST /api/movements/undo` ; ajout `batchId` dans
  `/api/discovery-pack/commit` ; ajout `cmpBefore` dans `restock` (x2) et `adjust_total`.
- `stockManager.js` — nouvelle fonction exportée `setAverageCostPerGram(shop, productId, cmp)`.
- `public/js/app.js` — bouton « Annuler » + `undoMovement` / `undoDiscoveryBatch`,
  détection `reversedIds`, badge « Annulé », exposition `app.*`, rechargement post-undo.
- `public/js/i18n.js` — libellés (optionnel ; fallbacks FR déjà fournis inline).

## Hors périmètre (v1)

- Annulation des pochons cadeaux (`gift`) et de leur analytics (v2).
- Annulation des ventes webhook / créations / suppressions de produit.
- Fenêtre temporelle limitée / expiration du droit d'annulation.
- Regroupement visuel du pack en une seule ligne dans le feed (on garde N lignes ;
  le bouton « tout le pack » suffit).

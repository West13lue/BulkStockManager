# Pack découverte — impression d'étiquettes en masse + décrément stock

**Date :** 2026-07-22
**App :** Stock Manager Pro (Bulk Stock Manager) — Shopify embedded, Cloud Store CBD
**Statut :** design validé, prêt pour plan d'implémentation

## Problème / besoin

L'utilisateur prépare des « packs découverte » : des assortiments de plusieurs
pochons de **1,5 g** de fleurs/résines différentes. Aujourd'hui il faut ouvrir la
fenêtre Étiquettes et ajouter chaque produit à la main. Il veut un bouton qui :

1. **sélectionne automatiquement** les produits ayant le **plus gros stock** (en g),
2. génère **une étiquette 1,5 g par produit**, imprimables **en une fois**,
3. **décrémente 1,5 g** du stock de chaque produit sélectionné (mouvement enregistré).

## Décisions de cadrage (validées)

| Question | Décision |
|---|---|
| Composition du pack | **Top N plus gros stocks**, N réglable à chaque impression (défaut **6**, mémorisé). |
| Impact stock | **Décrémenter 1,5 g** par produit à l'impression, mouvement enregistré + sync Shopify. |
| Analytics | **Aucune écriture analytics** — c'est une préparation, pas une vente (pas de CA, pas de marge de commande). |
| Point d'entrée | **Dans la fenêtre Étiquettes** (bouton à côté de « + Ajouter »). |
| Poids par pochon | 1,5 g par défaut, modifiable. |

## Flux utilisateur

1. Fenêtre Étiquettes → bouton **« 🧪 Pack découverte »**.
2. Invite : **Nombre de produits** (défaut 6, éditable, mémorisé en `localStorage`) + poids (défaut 1,5 g).
3. L'app recharge le stock à jour, sélectionne les **N produits éligibles au plus gros stock**,
   et remplit la fenêtre avec **N onglets d'étiquettes** (1 par produit, 1,5 g, qté 1),
   marqués visuellement « pack découverte » (badge + bandeau, calqués sur le badge cadeau).
4. L'utilisateur peut revoir / retirer un onglet, changer format / QR / ligne perso.
5. Clic **Imprimer** → la feuille d'étiquettes s'ouvre **et** l'app décrémente 1,5 g du
   stock de chaque produit du pack (mouvement + push Shopify). Toast résumé :
   « 6 pochons préparés, 9 g déduits ».

## Approche retenue

**A — Réutiliser la fenêtre Étiquettes + 1 endpoint de commit.**
Sélection top-N côté client à partir du stock fraîchement rechargé ; à l'impression,
POST de la liste **réellement imprimée** vers un nouvel endpoint qui décrémente
(revalidation stock côté serveur = autoritatif). Le rendu / l'impression réutilisent
`buildLabelHTML` + la fenêtre d'impression existante.

Alternatives écartées :
- **B** — tout côté serveur (sélection + décrément en un appel) : plus atomique mais
  interdit de revoir/retirer un produit avant impression → moins souple.
- **C** — sans décrément : écarté (décrément demandé).

Cohérent avec le flux « pochon cadeau » (`recordGiftLines` / `/api/sales/gift`) déjà éprouvé.

## Backend — `server.js`

Nouvel endpoint, **Free** (pas de gating plan), enveloppé dans `safeJson` :

```
POST /api/discovery-pack/commit
Body: { lines: [ { productId, grams } ] }
```

Pour chaque ligne, **exactement** le pattern de `/api/sales/gift` **sans la partie analytics** :

1. Valider `productId`, `grams > 0`. Récupérer `stock.getProductSnapshot(shop, productId)`.
2. Revalider `productSnapshot.totalGrams >= grams` ; sinon la ligne est **skippée** (ajoutée à `skipped`), pas d'échec global.
3. `await stock.applyOrderToProduct(shop, productId, grams)` (décrément).
4. `movementStore.addMovement({ source: "discovery_pack", type: "discovery_pack_prep",
   productId, productName, gramsDelta: -grams, totalAfter, shop }, shop)`.
5. `await pushProductInventoryToShopify(shop, updatedProduct)` en best-effort
   (erreur loggée via `logEvent(..., "error")`, non bloquante).

**Pas** d'appel à `analyticsStore.addSale`.

Réponse :
```
{ success: true, prepared: <n>, totalGramsDeducted: <g>,
  skipped: [ { productId, productName, reason } ] }
```

`logEvent("discovery_pack_prepared", { shop, prepared, totalGramsDeducted }, "info")`.

## Frontend — `public/js/app.js`

Zone Étiquettes (autour de `renderLabelTabs` / `printLabels`, ~ lignes 3785-4265).

- **Bouton** dans `renderLabelTabs()` : `« 🧪 Pack découverte »` → `app.startDiscoveryPack()`.
- **`startDiscoveryPack()`** :
  - lire N (invite ou petit champ, défaut 6, lu/écrit dans `localStorage`),
  - **recharger `/api/products`** (via `authFetch(apiUrl("/products"))`) pour un stock frais,
  - filtrer `!trackByUnit && !archived && totalGrams >= 1.5`,
  - trier `totalGrams` décroissant, prendre N,
  - si 0 éligible → toast d'avertissement, ne rien ouvrir,
  - si `< N` éligibles → prendre ce qu'il y a + info « seulement X produits éligibles »,
  - remplir `labelConfigs` : `{ productId, lotId:"", qty:1, weight:1.5, price:"",
    lotData:null, isGift:false, isDiscoveryPack:true }`,
  - `renderLabelTabs()` + `renderLabelConfig()`.
- **Badge « pack découverte »** : dans `renderLabelTabs()` (couleur dédiée, ex. vert/teal,
  distincte du orange cadeau) et un bandeau info dans `renderLabelConfig()` (calqué sur `giftBanner`).
- **`getAllLabelData()`** : propager `isDiscoveryPack` dans l'objet retourné.
- **`printLabels()`** : après ouverture de la fenêtre d'impression (donc **pas** si popup
  bloquée), si des lignes `isDiscoveryPack` existent → `commitDiscoveryPack(lines)`.
- **`commitDiscoveryPack(lines)`** (calqué sur `recordGiftLines`) :
  POST `/api/discovery-pack/commit` avec `lines = [{ productId, grams: weight }]`,
  toast résumé (`prepared`, `totalGramsDeducted`, `skipped`), refresh dashboard
  (`loadLatestOrderLabels` si dispo pour refléter le stock).
- **API publique** : ajouter `startDiscoveryPack` (et helpers exposés au besoin) à la
  liste des méthodes `app.*` exportées (cf. tableau ~ ligne 58 et l'objet retourné ~ 12554).

## Éligibilité & tri

- Éligibles : produits **suivis au gramme** (`!trackByUnit`), **non archivés**,
  `totalGrams >= 1.5`.
- Tri : `totalGrams` décroissant.
- Poids par pochon : 1,5 g (constant du flux, modifiable si besoin ultérieur).

## Cas limites

- **Popup bloquée** → message existant `labels.popupBlocked`, **aucun décrément**.
- **Stock insuffisant au commit** (vente webhook entre aperçu et impression) → ligne
  skippée et signalée dans le toast ; les autres passent.
- **Aucun produit éligible** → toast d'avertissement, rien ne s'ouvre.
- **Push Shopify en échec** → loggé, non bloquant (le stock local reste décrémenté,
  comme dans le flux cadeau).

## Fichiers touchés

- `server.js` — endpoint `POST /api/discovery-pack/commit`.
- `public/js/app.js` — bouton + `startDiscoveryPack`, `commitDiscoveryPack`,
  marquage `isDiscoveryPack`, hook dans `printLabels`, badge/bandeau, exposition `app.*`.
- `public/js/i18n.js` — libellés FR/EN (`labels.discoveryPack`, invite N, badge,
  toast résumé, messages d'éligibilité).

## Hors périmètre (v1)

- Sélection FEFO d'un lot précis par produit (décrément au niveau lot).
- Aperçu autoritatif côté serveur (endpoint GET dédié).
- Raccourci sur le tableau de bord.
- Vente / facturation du pack en tant que produit Shopify (kit/bundle).

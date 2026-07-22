# Refonte UI/UX — Design

**Date** : 2026-07-22
**Statut** : validé section par section avec l'utilisateur (brainstorming)

## Contexte et objectif

Stock Manager Pro a déjà un design system solide (OKLCH, thème sombre, accent vert acide,
lane Linear/Raycast dans `public/css/style.css`) mais son *application* est inégale et
l'ergonomie quotidienne souffre de quatre frictions confirmées :

1. **Actions trop enfouies** — trop de clics et de modales (re-sélection du produit, empilement).
2. **Dashboard peu actionnable** — l'info est là, mais chaque élément renvoie vers une
   modale-liste ou une page où il faut recommencer.
3. **Tableaux peu efficaces** — 5 boutons visibles par ligne, tri en double mécanisme,
   pas de header sticky, état du stock difficile à scanner.
4. **Sous-onglets illisibles** — 3 styles de tabs coexistent, l'état se perd à chaque navigation.

**Direction visuelle** : conserver l'identité (sombre + vert acide) et pousser l'exécution —
refonte de l'exécution, pas de l'identité.

**Pages prioritaires** : Dashboard, Catalogue, Analyse. Achats/Lots/Inventaire bénéficient
par propagation des systèmes transversaux.

**Approche retenue** : refonte par systèmes transversaux (et non page par page) — les
frictions viennent de composants partagés ; chaque amélioration profite à toutes les pages.

## Contraintes (non négociables)

- Architecture inchangée : vanilla JS, pas de bundler, pas de framework.
- API publique `window.app.X()` stable (les `onclick="app.foo()"` s'y attachent par nom).
- Aucune route backend modifiée — refonte 100 % front (`public/`).
- Zones sensibles intouchées : auth, App Bridge, OAuth, webhooks, sync Shopify.
- i18n : toute nouvelle chaîne passe par `i18n.js` (FR/EN), clés existantes conservées.
- `API_BASE` reste `"/api"` relatif.
- Non-régression responsive (le mobile n'est pas un objectif, mais ne doit pas casser).

## Système 0 — Fondations visuelles (transversal)

- **Normalisation des composants** : une seule variante par usage pour boutons
  (tailles/styles), badges, chips, cards. Audit des incohérences (ex. bouton `+` seul,
  « Edit », icônes de tailles variables dans `renderTable`).
- **Densité** : lignes de tableau plus compactes (style Linear), paddings de cards revus.
- **Numérique** : `tabular-nums` + alignement à droite sur toutes les colonnes chiffrées
  (grammes, CMP, valeur, €) ; unités en couleur tertiaire.
- **Styles inline → classes utilitaires** : remplacement progressif des `style="..."`
  dans le JS, au fur et à mesure que chaque zone est touchée (pas de big-bang).

## Système 1 — Tableaux

Référence actuelle : `renderTable` (`public/js/app.js:6120`) + tables ad-hoc des pages
Lots, Fournisseurs, Achats, Ventes, Analyse.

- **Actions au survol** : 2 actions directes (Restock, Ajuster) visibles au hover de la
  ligne + menu `⋯` (kebab) regroupant Détails / Catégories / Archiver / Supprimer.
  La ligne reste cliquable → détails produit.
- **Colonne stock visuelle** : mini-jauge de niveau colorée selon les seuils utilisateur
  (critique/bas/OK) à côté de la valeur en grammes.
- **En-têtes triables unifiés** : icônes lucide (pas de ▲▼ texte), header sticky au scroll,
  suppression du dropdown de tri (le tri vit dans les en-têtes uniquement).
- **Filtres persistants** par page (localStorage scopé par shop) + chips des filtres
  actifs + compteur de résultats + bouton reset.
- **Nouveau filtre statut au Catalogue** (Tous / Critique / Bas / OK) dans la toolbar —
  prérequis du flux « urgence → catalogue filtré » du Système 3.
- **Propagation** : le même markup/CSS s'applique ensuite aux tableaux Lots, Fournisseurs,
  Achats, Analyse (récap commandes), Inventaire.

## Système 2 — Actions rapides

- **Contexte pré-rempli** : toute action lancée depuis une ligne, la watchlist ou
  l'activité ouvre sa modale avec le produit déjà sélectionné, champ quantité auto-focus,
  `Entrée` valide.
- **Une seule modale à l'écran** : jamais d'empilement — si une action en déclenche une
  autre, la première se ferme.
- **Presets de quantité** dans Restock/Ajustement : 10 g / 25 g / 50 g / 100 g + dernier
  montant utilisé, au-dessus du champ libre.
- **Modales à 1 écran** : le secondaire (note, lot, fournisseur) replié dans un bloc
  « Options » dépliable.
- **Undo systématique** : le pattern « Annuler » des activités récentes devient la norme —
  chaque toast de confirmation d'action stock propose Annuler quelques secondes
  (s'appuie sur `/api/movements/undo` existant).
- **Recherche globale (Ctrl+K)** : boutons Restock/Ajuster inline sur les produits dans
  le dropdown de résultats.

## Système 3 — Dashboard actionnable

Référence actuelle : `renderDashboard` (`public/js/app.js:1328`).

- **Urgence → catalogue filtré** : les items du bloc urgence naviguent vers le Catalogue
  avec le filtre statut pré-appliqué (plus de modales-listes `showOutOfStockModal` /
  `showLowStockModal`).
- **Watchlist opérationnelle** : remontée juste sous les KPIs ; nouveau tableau avec
  jauge de stock + Restock au survol pré-rempli.
- **KPIs cohérents** : tous cliquables avec destination logique (Produits → catalogue ;
  Stock/Valeur → catalogue trié par valeur ; Ventes 7j / Commandes 7j → Analyse) ;
  sparklines réelles sur les KPIs ventes (les conteneurs existent, vides aujourd'hui).
- **Ordre vertical** : Urgence → KPIs → Watchlist → Activité (avec undo) + Lots qui
  expirent côte à côte → Étiquette dernière commande compactée en bas de page.
- **Dédoublonnage** : fusion de la barre « Actions rapides » et du CTA header en une
  seule barre d'actions compacte dans le header de page.

## Système 4 — Navigation & sous-onglets

- **Un seul style d'onglet** : l'underline d'Analyse (`.analytics-tabs-row .tab-btn`)
  devient le style unique ; `.detail-tab` et `.activity-tabs` migrent dessus.
  Compteurs affichés quand pertinent (ex. « Récap commandes · 12 »).
- **Deep-linking par hash** : `#analyse/tresorerie`, `#catalogue?statut=critique`…
  Sous-onglets et filtres importants adressables ; bouton retour fonctionnel ;
  rechargement sans perte d'état. Prérequis du flux « urgence → catalogue filtré ».
- **Mémoire du dernier sous-onglet** par page (localStorage).
- **Sidebar** : sous-items dépliables sous Analyse (et Achats) pour accéder directement
  aux sous-vues (ex. Trésorerie) sans transiter par l'onglet par défaut.

## Hors périmètre

- Refonte technique (bundler, framework, découpage d'`app.js`).
- Backend / routes API.
- Refonte mobile au-delà de la non-régression.
- Changement d'identité visuelle (couleurs, thème).

## Risques et garde-fous

- **Composants partagés dans un monolithe de 670 KB** : chaque phase est committée
  séparément et vérifiée sur *toutes* les pages consommant le composant modifié,
  pas seulement les 3 prioritaires.
- **`onclick` par nom** : ne jamais renommer/supprimer une méthode `app.X` sans vérifier
  ses usages dans `index.html` + `app.js` (recherche exhaustive).
- **Modales-listes supprimées** (`showOutOfStockModal`, `showLowStockModal`) : vérifier
  tous leurs points d'appel avant retrait.
- **Icônes lucide** : tout HTML injecté dynamiquement doit rappeler
  `lucide.createIcons()` (pattern existant).

## Phasage indicatif (détaillé dans le plan d'implémentation)

1. Fondations visuelles + système de tableaux sur Catalogue (le socle).
2. Système d'actions (modales, presets, undo, Ctrl+K).
3. Dashboard actionnable (dépend de 1 et 2 + deep-linking minimal).
4. Navigation complète (hash, mémoire, sidebar) + propagation tableaux aux autres pages.
5. Passe finale de cohérence visuelle sur Analyse et pages secondaires.

## Critères de succès

- Réappro du matin réalisable entièrement depuis le dashboard en ≤ 3 clics par produit.
- Aucune action courante (restock, ajustement) ne demande de re-sélectionner un produit
  déjà visible à l'écran.
- Une seule modale à l'écran à tout moment.
- État de navigation (page + sous-onglet + filtres clés) survit à un rechargement.
- Aucune régression : sync Shopify, auth, i18n FR/EN, undo activités, responsive.

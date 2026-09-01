# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Aujourd'hui — un seul utilisateur réel** : Frédéric, propriétaire de Cloud Store CBD (e-commerce CBD légal en France). Travaille sur desktop, dans l'iframe embedded Shopify, en sessions concentrées (sync, restock, inventaire physique, gestion DLC). Il a déjà rempli son catalogue à la main dans l'admin Shopify et sait à quel point c'est lent dès qu'on dépasse 30 SKUs.

**Demain — ambition, pas encore un fait** : autres marchands Shopify dans des verticales à fort besoin de gestion de stock — produits réglementés (CBD, alcool, cosmétique), produits avec DLC (alimentaire, soins), grossistes. Profil : opérateur business, pas développeur, utilise Shopify Admin tous les jours mais cherche un outil dédié quand il franchit le seuil de "trop de SKUs pour le natif". Aucun marchand tiers n'utilise l'app à ce jour.

**Contexte d'usage** : ouvert dans un onglet pendant la journée de travail. Pas une app qu'on consulte 30 secondes — on y passe 20 à 60 minutes par session, plusieurs fois par semaine.

## Product Purpose

Un gestionnaire de stock dense, rapide et orienté opérations pour les marchands Shopify qui ont dépassé les limites de l'admin natif. L'app remplace les workflows lents (clic-clic-clic dans Shopify Admin pour ajuster 50 produits) par des opérations en masse, et ajoute ce qui manque dans l'admin : suivi des lots/DLC, fournisseurs, prévisions, kits/bundles, inventaires physiques.

**Succès = le marchand gagne 30+ minutes par jour sur les opérations de stock et arrête d'expédier des produits expirés ou en rupture invisible.**

Monétisation par tiers (Free → Starter → Pro → Business → Enterprise) qui débloquent les modules avancés. Le tier Free est une **démonstration** (2 produits), pas un outil autonome : il sert à prouver le fonctionnement, la valeur réelle commence à Starter.

## Positioning

Monter et maintenir un stock en masse via la gestion d'inventaire native de Shopify est compliqué et lent : chaque ajustement se fait produit par produit, variante par variante, sans vue d'ensemble ni historique exploitable. Le mécanisme de l'app est de faire cette même opération **en une passe**, sur des dizaines de SKUs, avec la trace de ce qui a bougé et pourquoi.

Tout le reste (lots/DLC, fournisseurs, achats, prévisions, kits, trésorerie/CMP) est construit au-dessus de cette opération en masse — ce sont des extensions du même geste, pas des produits séparés.

## Operating Context

- **Dans l'iframe Shopify Admin**, app embedded (App Bridge v4, session tokens JWT). Le marchand n'ouvre pas un onglet séparé : l'app vit à l'intérieur de son outil de travail quotidien.
- **Desktop d'abord.** Les sessions longues (inventaire physique, réappro, contrôle DLC) se font assis, sur grand écran. Le mobile n'est pas le scénario principal.
- **Multi-boutique par construction** : toute donnée est scopée par shop (`<DATA_DIR>/<shop>/`). Rien n'est global.
- **Boutique réelle de référence** : Cloud Store CBD — ordre de grandeur ~39 produits, 2 emplacements (Saint Roch en principal), variantes exprimées en poids (grammes). Ces valeurs dérivent avec le catalogue ; ne pas les traiter comme figées.
- **Hébergement Render, instance unique.** L'état anti-CSRF OAuth et la déduplication des webhooks vivent en mémoire du process : l'app ne supporte pas l'autoscaling horizontal en l'état.

## Capabilities and Constraints

**Sept surfaces** : dashboard, catalogue, lots/DLC, inventaire, achats, analyse, réglages. Les onglets sont masqués ou verrouillés par tier via `data-feature`.

**Tiers et limites** (source de vérité : `planManager.js`, prix en EUR, mensuel ou annuel) :

| Tier | Prix / mois | Produits max | Débloque |
|---|---|---|---|
| Free | 0 € | 2 | stock + sync Shopify, CMP basique, 1 fournisseur, export CSV |
| Starter | 9,99 € | 15 | fournisseurs, catégories, import Shopify |
| Pro | 24,99 € | 75 | lots/DLC, analytics, inventaires, prévisions, commandes vente |
| Business | 59,99 € | illimité | commandes d'achat, kits & bundles |
| Enterprise | 199 € | illimité | présent dans le code ; commercialisation non confirmée |

Le gating passe par `planManager.hasFeature(shop, key)` — `hasSuppliers`, `hasBatchTracking`, `hasAnalytics`, `hasInventoryCount`, `hasPurchaseOrders`, `hasForecast`, `hasKits`.

**Contraintes techniques durables :**

- **Scopes Shopify** : `read_products, write_inventory, read_locations, read_orders`. L'app **écrit l'inventaire, jamais les produits** — aucun flux ne peut modifier titre, prix ou variante côté Shopify. Toute fonctionnalité qui l'exigerait demande un nouveau scope et une réinstallation.
- **Persistance fichier JSON, pas de base de données.** Un store par domaine (stock, mouvements, lots, fournisseurs, commandes, kits, inventaires, réglages), écritures atomiques `.tmp` + `rename`, disque persistant Render.
- **Pas de bundler, pas de transpileur.** Backend Express monolithique ; frontend SPA en JS vanilla (`app.js` ~13 000 lignes) chargé directement par le navigateur. Toute dépendance nouvelle est un coût réel, pas une ligne de `package.json`.
- **Bilingue FR/EN obligatoire** via `i18n.js` : tout texte visible passe par `t(...)`, jamais de chaîne en dur.
- **Aucun test automatisé** aujourd'hui (`npm test` lance jest, la suite est vide). Les régressions se voient en prod.

**Vocabulaire métier à respecter** (il est déjà celui de l'UI et du marchand) : CMP (coût moyen pondéré), DLC, lot, mouvement, restock, patrimoine / trésorerie, kit, session d'inventaire, override produit.

**Fait produit tranché** : le plafond de 2 produits du Free est volontaire — le Free démontre, il ne remplace pas Shopify Admin.

## Brand Commitments

- **Deux noms coexistent** : "Bulk Stock Manager" est le nom officiel Shopify (TOML, listing), "Stock Manager Pro" apparaît dans l'interface, `stock-cbd-manager` est le nom de package. Ne pas en inventer un troisième ; toute unification est une décision du propriétaire.
- **Français en langue première**, anglais en parité fonctionnelle.
- **Pages légales publiées** et livrées avec l'app : `privacy-policy.html`, `terms-of-service.html`.
- **Identité visuelle existante** : `BulkStockManager icon.png`, `nav-icon.svg`.

## Brand Personality

**Confiant. Moderne. Légèrement audacieux.**

Voix : française, directe, sans fioritures ni condescendance. Pas de "Bonjour cher utilisateur, nous sommes ravis…". Plutôt "12 produits en rupture. On s'en occupe ?" Du ton mais pas du chichi.

Émotion visée : contrôle + vitesse + souveraineté. Le merchant doit avoir le sentiment "je sais où est mon stock, et je le pilote, je ne le subis pas."

Lane visuelle : Linear / Vercel / Stripe / Raycast — outils pro dotés d'une vraie identité, pas du *Bootstrap-admin-template*. Un accent fort et stratégique plutôt que dix couleurs timides.

## Anti-references

**Bannis explicitement :**

- **SaaS-template générique 2018-2022** : grille de cartes identiques (icône + titre + texte), gradients violet→bleu, hero stat-blocks avec gros chiffre + petit label, modales Bootstrap. Toute UI qui ressemble à un theme purchased on ThemeForest.
- **Minimalisme froid / wireframe** : tout en niveaux de gris, zéro accent, aucune respiration, design "livré comme un Figma de page de devis". Refusé même si "propre".
- **Glassmorphism / clinquant** : blurs gratuits, gradients partout, ombres colorées, neon edges. Effet *démo Dribbble qui ne tient pas en prod*.
- **Polaris pur** : on est embedded *dans* Shopify Admin, donc il faut sentir qu'on est ailleurs — un outil dédié, pas une rallonge native.

## Evidence on Hand

**Ce qui existe réellement :**

- Une app en production sur Render, installée sur Cloud Store CBD et sur la dev store `bulk-stock-manager-2.myshopify.com`.
- Des données de stock, mouvements, lots et commandes réelles issues de l'exploitation quotidienne de Cloud Store CBD.
- Les pages légales, l'icône, et les captures possibles de l'interface existante.

**Absences à ne jamais combler par invention :**

- **Aucun marchand tiers**, donc aucun témoignage, aucun logo client, aucun "utilisé par X boutiques".
- **Aucun listing App Store publié** : l'app est privée à ce jour.
- **Aucune métrique d'usage ou de performance mesurée** — le "30+ minutes par jour" est l'objectif produit, pas un résultat constaté. Ne jamais le présenter comme un chiffre validé.
- Aucune étude de cas, aucun benchmark concurrentiel chiffré.

## Product Principles

1. **L'opération en masse est le produit.** Toute fonctionnalité se juge au nombre de gestes qu'elle retire face à Shopify Admin. Une feature qui ajoute un écran sans supprimer des clics n'a pas sa place.
2. **L'urgence remonte d'elle-même.** Rupture, DLC proche, restock attendu : l'app dit quoi faire, pas seulement ce qu'il y a en stock. Ce qui exige une action se lit avant ce qui informe.
3. **Le Free démontre, Starter travaille.** Ne pas concevoir le tier gratuit comme un produit autonome ni chercher à le rendre suffisant.
4. **Un seul marchand réel.** Aucune preuve sociale, aucun chiffre d'usage, aucun client fictif — dans l'UI comme dans toute surface publique.
5. **Rien n'est global, tout est scopé par boutique.** Chaque donnée, chaque réglage, chaque token appartient à un shop. Une fonctionnalité qui suppose un état partagé est un bug de conception.

## Accessibility & Inclusion

- Cible **WCAG 2.1 AA** (recommandé Shopify App Store, et bonne hygiène).
- **Clavier d'abord** : tous les flux opérationnels (édition de stock, ajout, recherche, navigation entre onglets) doivent être pilotables au clavier. Le bouton "raccourcis clavier" déjà présent dans la topbar suggère que l'intention existe ; vérifier qu'elle est tenue.
- **Couleur jamais seule** : statut stock (OK / faible / rupture / DLC proche) doit être reconnaissable sans la couleur — icône + texte ou pattern. Daltonisme et impressions noir-et-blanc.
- **Reduced motion respecté** (`prefers-reduced-motion: reduce`) : les animations décoratives s'éteignent, les transitions essentielles passent à `0.01ms`.
- **Internationalisation** : déjà bilingue FR/EN via `i18n.js`. Tout texte nouveau doit passer par `t(...)`. Format des nombres et devises au niveau locale, pas hardcodé.
- **Densité lisible** : contraste ≥ 4.5:1 sur le texte body, ≥ 3:1 sur les composants UI. Tailles de police ≥ 13px pour le texte secondaire, jamais en dessous.

## Design Principles

1. **Densité gagnée, pas subie.** Beaucoup d'information à l'écran — c'est un outil métier, pas une landing — mais hiérarchie typographique et rythme visuel font le tri. Le merchant doit pouvoir scanner sans être étouffé.
2. **Une affirmation visuelle par écran.** Le ton "audacieux" ne veut pas dire "tout crie". Sur chaque vue, *un* élément porte le caractère (un graphique, un bouton d'action principal, un état d'alerte) et le reste se fait sobre pour le mettre en valeur.
3. **L'urgence en premier.** Sur le dashboard et chaque section, ce qui demande une action immédiate (ruptures, DLC proche, restocks attendus) est lisible en moins de 2 secondes. Le reste peut attendre un scroll.
4. **Vitesse visible.** Toute interaction (sync, save, filter, search) déclenche un retour visuel <100ms — skeleton, optimistic update, transition courte. La perception de vitesse compte autant que la vitesse réelle.
5. **Différencié de Polaris, pas hostile à Shopify.** L'app vit dans l'iframe Shopify mais a son propre ADN. On respecte la cohérence générale (focus rings, comportements clavier, locale) sans imiter les couleurs ni les composants Polaris.

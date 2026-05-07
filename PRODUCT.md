# Product

## Register

product

## Users

**Aujourd'hui** : Frédéric, propriétaire de Cloud Store CBD (e-commerce CBD légal en France). Travaille sur desktop, dans l'iframe embedded Shopify, en sessions concentrées (sync, restock, inventaire physique, gestion DLC). Il a déjà rempli son catalogue à la main dans l'admin Shopify et sait à quel point c'est lent dès qu'on dépasse 30 SKUs.

**Demain** : autres marchands Shopify dans des verticales à fort besoin de gestion de stock — produits réglementés (CBD, alcool, cosmétique), produits avec DLC (alimentaire, soins), grossistes. Profil : opérateur business, pas développeur, utilise Shopify Admin tous les jours mais cherche un outil dédié quand il franchit le seuil de "trop de SKUs pour le natif".

**Contexte d'usage** : ouvert dans un onglet pendant la journée de travail. Pas une app qu'on consulte 30 secondes — on y passe 20 à 60 minutes par session, plusieurs fois par semaine.

## Product Purpose

Un gestionnaire de stock dense, rapide et orienté opérations pour les marchands Shopify qui ont dépassé les limites de l'admin natif. L'app remplace les workflows lents (clic-clic-clic dans Shopify Admin pour ajuster 50 produits) par des opérations en masse, et ajoute ce qui manque dans l'admin : suivi des lots/DLC, fournisseurs, prévisions, kits/bundles, inventaires physiques.

**Succès = le marchand gagne 30+ minutes par jour sur les opérations de stock et arrête d'expédier des produits expirés ou en rupture invisible.**

L'app est monétisée par tiers (Free → Starter → Pro → Business) qui débloquent les modules avancés (lots, fournisseurs, achats, kits, prévisions). Le tier Free doit déjà rendre le bulk-edit plus agréable que Shopify Admin — c'est l'argument d'entrée.

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

## Design Principles

1. **Densité gagnée, pas subie.** Beaucoup d'information à l'écran — c'est un outil métier, pas une landing — mais hiérarchie typographique et rythme visuel font le tri. Le merchant doit pouvoir scanner sans être étouffé.
2. **Une affirmation visuelle par écran.** Le ton "audacieux" ne veut pas dire "tout crie". Sur chaque vue, *un* élément porte le caractère (un graphique, un bouton d'action principal, un état d'alerte) et le reste se fait sobre pour le mettre en valeur.
3. **L'urgence en premier.** Sur le dashboard et chaque section, ce qui demande une action immédiate (ruptures, DLC proche, restocks attendus) est lisible en moins de 2 secondes. Le reste peut attendre un scroll.
4. **Vitesse visible.** Toute interaction (sync, save, filter, search) déclenche un retour visuel <100ms — skeleton, optimistic update, transition courte. La perception de vitesse compte autant que la vitesse réelle.
5. **Différencié de Polaris, pas hostile à Shopify.** L'app vit dans l'iframe Shopify mais a son propre ADN. On respecte la cohérence générale (focus rings, comportements clavier, locale) sans imiter les couleurs ni les composants Polaris.

## Accessibility & Inclusion

- Cible **WCAG 2.1 AA** (recommandé Shopify App Store, et bonne hygiène).
- **Clavier d'abord** : tous les flux opérationnels (édition de stock, ajout, recherche, navigation entre onglets) doivent être pilotables au clavier. Le bouton "raccourcis clavier" déjà présent dans la topbar suggère que l'intention existe ; vérifier qu'elle est tenue.
- **Couleur jamais seule** : statut stock (OK / faible / rupture / DLC proche) doit être reconnaissable sans la couleur — icône + texte ou pattern. Daltonisme et impressions noir-et-blanc.
- **Reduced motion respecté** (`prefers-reduced-motion: reduce`) : les animations décoratives s'éteignent, les transitions essentielles passent à `0.01ms`.
- **Internationalisation** : déjà bilingue FR/EN via `i18n.js`. Tout texte nouveau doit passer par `t(...)`. Format des nombres et devises au niveau locale, pas hardcodé.
- **Densité lisible** : contraste ≥ 4.5:1 sur le texte body, ≥ 3:1 sur les composants UI. Tailles de police ≥ 13px pour le texte secondaire, jamais en dessous.

---
version: 1
slug: "public-js-app-js"
primary_target: "public/js/app.js"
related_targets: ["public/css/style.css","public/index.html"]
---

# Dashboard — surface brief

**Scope.** L'onglet `dashboard` rendu par `renderDashboard()` dans `public/js/app.js`. Les six autres onglets ne sont pas dans le périmètre et gardent le vocabulaire de classes partagé.

**Mode visiteur.** Operate. L'expression ne doit jamais masquer la tâche, l'état, ni les affordances déjà apprises.

**Audience et travail.** Un opérateur unique, propriétaire de la boutique, qui ouvre l'app le matin dans l'iframe Shopify Admin, sur desktop. Il ne consulte pas : il reprend le fil. Sa question d'ouverture est « qu'est-ce qui a bougé pendant que je n'étais pas là, et qu'est-ce que je dois faire maintenant », jamais « combien ».

**Action.** Depuis cette surface : réappro rapide, ajustement, vente manuelle, scan, inventaire, création produit. Chaque geste doit rester atteignable sans quitter l'écran, et les lignes du registre doivent mener au produit concerné.

**Contenu et états.** Machine à états d'urgence (vide / clair / alerte / critique), mouvements datés, produits sous seuil, lots à DLC proche, étiquette de la dernière commande, valeur du stock et solde bancaire. L'état « clair » est le cas le plus fréquent : il doit valoir quelque chose à l'écran, pas produire un vide.

**Contraintes tenues par l'utilisateur.** Densité conservée — aucune aération qui ferait scroller ce qui tenait en un écran. Thème sombre par défaut, clair disponible. Vocabulaire de classes partagé intact (`.btn`, `.card`, `.table`, `.modal`, `.badge`, nav) ; les classes nouvelles sont scopées au dashboard.

**Direction choisie.** Le relevé d'ouverture (tirage `0d0d84de`, position 3 de la liste ordonnée). Le dashboard se lit comme un relevé de caisse d'ouverture : lignes datées, filets, quantités tabulaires alignées à droite, delta signé depuis la dernière session. Pas de grille de cartes égales, pas de gabarit gros-chiffre.

**Moment mémorable.** La ligne de delta : au chargement, l'écart depuis la dernière session se compte à sa valeur, une seule fois, et rien d'autre sur la page ne bouge.

**Décisions non tranchées.** La nav et les sept onglets n'ont pas été déclarés intouchables — une refonte de la navigation reste possible mais n'est pas engagée ici. Le sort du bandeau KPI hérité (repli en ligne fine ou suppression) se juge sur la première capture.

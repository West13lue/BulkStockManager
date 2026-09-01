# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vue d'ensemble

**Stock Manager Pro** (alias *Bulk Stock Manager*, package `stock-cbd-manager` v2.1.0) — application Shopify privée embedded pour gestion de stocks en masse. Hébergée sur Render à `https://stock-cbd-manager-1.onrender.com`. Boutique principale visée : Cloud Store CBD. Boutique de dev : `bulk-stock-manager-2.myshopify.com` (déclarée dans `shopify.app.bulk-stock-manager.toml`).

Une seule app Express monolithique (`server.js`, ~325 Ko / 8 823 lignes) qui sert l'API + les fichiers statiques du SPA frontend, plus une quinzaine de modules « stores » (I/O fichier) et « managers » (logique métier) indépendants. Pas de bundler, pas de transpileur — Node.js direct + JS vanilla côté navigateur.

`PRODUCT.md` à la racine est le dossier produit de référence (utilisateurs, positionnement, contraintes durables, tiers tarifaires, ce qu'il ne faut jamais inventer). Le consulter avant tout travail produit ou UI.

## Commandes

```bash
npm start              # node server.js (prod)
npm run dev            # nodemon — ⚠️ script écrit en syntaxe bash (NODE_ENV=development nodemon server.js).
                       #    Sur Windows PowerShell il échoue. Lancer à la place :
                       #    $env:NODE_ENV="development"; npx nodemon server.js
npm test               # jest --coverage — aucun test n'existe dans le repo, la commande ne prouve rien.
```

Pas de lint configuré. Pas de build. Le déploiement Render se fait via push git (la config Render n'est pas dans le repo).

**Lancer en local ne suffit pas à tester l'app.** Le `.env` local ne contient ni `SHOPIFY_API_KEY`, ni `SHOPIFY_API_SECRET`, ni `RENDER_PUBLIC_URL`, ni `SHOPIFY_SCOPES` — ces variables ne vivent que dans le dashboard Render. Avec `NODE_ENV=production` (valeur du `.env` local), `API_AUTH_REQUIRED` vaut `true` et toute route `/api` exige un JWT que rien ne peut signer localement. Le serveur démarre, l'UI se charge, mais l'API répond 401. Pour du vrai test, passer par la boutique de dev et l'app déployée.

## Architecture

### Backend Express — `server.js`

Tout est monté sur **un seul Router** déclaré dans `server.js`, lui-même monté à deux endroits (`server.js:8790-8791`) :

```js
app.use("/", router);
app.use("/apps/:appSlug", router);   // double-mount pour App Proxy
```

Pipeline de middlewares **dans cet ordre** sur `/api` :

1. `apiLimiter` — express-rate-limit (`server.js:825`).
2. `express.json({ limit: "2mb" })` (`server.js:830`).
3. CORS + headers autorisés (`Authorization`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Session-Token`).
4. `Content-Security-Policy: frame-ancestors https://admin.shopify.com <shop>` — c'est ce qui autorise l'iframe Shopify. Ne pas y toucher sans comprendre l'embedding.
5. **`requireApiAuth`** (`server.js:861`) — vérifie le JWT App Bridge. Exemptions explicites : `/auth/start`, `/auth/callback`, `/public/config`, `/billing/return` **et** `/api/billing/return`.
6. **`enforceAuthShopMatch`** (`server.js:864`) — refuse une requête si le shop demandé par le client (query/header) ne correspond pas à celui du JWT (anti cross-shop).
7. Handlers `/api/*` (~150 routes : stock, products, categories, movements, batches, suppliers, orders, kits, forecast, finance, settings, billing, etc.), puis un 404 JSON attrape-tout (`server.js:8396`).

Les **webhooks** (`server.js:8453-8664`) sont enregistrés sur `app` *avant* le montage du router (8790) et utilisent `express.raw({ type: "application/json" })` pour préserver le body brut nécessaire à la vérification HMAC. Topics : `app/uninstalled`, `orders/create`, `refunds/create`, `customers/data_request`, `customers/redact`, `shop/redact`, `app_subscriptions/update`. La config canonique est dans `shopify.app.bulk-stock-manager.toml`. ⚠️ Ajouter un topic au TOML ne l'enregistre chez Shopify qu'après un `shopify app deploy` (les webhooks ne sont PAS enregistrés programmatiquement) — un push Render seul laisse le handler inerte.

Une **dédup webhook** in-memory (`processedWebhooks` Map, TTL 24h) protège contre les retries Shopify sur `orders/create`.

### Auth Shopify — double système

L'app combine **deux mécanismes** d'authentification, qui doivent rester cohérents :

**1. OAuth (install / token offline)** — `/api/auth/start` → `/api/auth/callback`
- Vérifie le HMAC de l'install, échange le code contre un access token, le stocke via `utils/tokenStore.js` sur le **disque Render persistant** : `${DATA_DIR}/<shop_sanitized>/token.json`.
- État anti-CSRF en mémoire (`_oauthStateByShop` Map, `server.js:207`) — OK pour une seule instance Render, KO en horizontal scaling.
- `redirect_urls` du TOML doit pointer EXACTEMENT vers `${RENDER_PUBLIC_URL}/api/auth/callback`.

**2. Session token App Bridge (JWT, par requête API)** — `requireApiAuth` (`server.js:434`)
- Frontend obtient un JWT via `shopify.idToken()` (App Bridge v4 chargé en CDN dans `public/index.html`) et l'envoie en header `Authorization: Bearer <jwt>` ou `X-Shopify-Session-Token`.
- Le serveur vérifie HS256 avec `SHOPIFY_API_SECRET`, contrôle `aud === SHOPIFY_API_KEY`, vérifie `exp`/`nbf`, extrait le shop depuis `dest` ou `iss`, et le pose sur `req.shopDomain`.
- ⚠️ **Le contrôle `aud` est conditionnel** (`server.js:415` : `if (SHOPIFY_API_KEY) { ... }`). Si la variable est absente ou vide, la vérification d'audience est silencieusement sautée — le JWT d'une autre app Shopify passerait. Ne jamais déployer sans `SHOPIFY_API_KEY`.
- **Le shop ne doit donc PAS dépendre de `?shop=` dans les appels API** une fois le JWT en place. `getShop(req)` (`server.js:256`) a une chaîne de fallbacks (JWT → query.shop → query.host base64 → header → env `SHOP_NAME`) — l'ordre est important, le JWT prime toujours.

**Helper `safeJson(req, res, fn)`** (`server.js:482`) : wrapper standard pour les handlers. Sur erreur 401 (token Shopify invalidé), il **supprime automatiquement le token disque** via `tokenStore.removeToken(shop)` et renvoie `{ error: "reauth_required", reauthUrl: "/api/auth/start?shop=..." }` au frontend. C'est ce qui permet la récupération automatique après uninstall/reinstall — ne pas court-circuiter ce mécanisme.

`API_AUTH_REQUIRED` (`server.js:202-205`) : si la variable d'env est vide, la valeur par défaut est `NODE_ENV === "production"`. Sinon, tout sauf la chaîne `"false"` active l'auth.

### Persistance — multi-shop sur Render Disk

Persistance fichier JSON, pas de DB. Toutes les données sont scopées par shop sous `${DATA_DIR}/<shop_sanitized>/` (default `/var/data/<shop>/`). `sanitizeShop()` remplace tout caractère hors `[a-z0-9._-]` par `_`.

| Store | Contenu | Plan |
|---|---|---|
| `utils/tokenStore.js` | `token.json` | (auth) |
| `stockState.js` (loadState/saveState) | `stock.json` | Free |
| `catalogStore.js` | `categories.json` | Free |
| `movementStore.js` | mouvements stock | Free |
| `notificationStore.js` | notifications app | Free |
| `settingsStore.js` | settings (incl. `locationId`) | Free |
| `productOverridesStore.js` | overrides par produit | Free |
| `supplierStore.js` | fournisseurs | Starter |
| `batchStore.js` | lots / DLC | Pro |
| `analyticsStore.js` | analytics | Pro |
| `inventoryCountStore.js` | sessions d'inventaire | Pro |
| `salesOrderStore.js` | commandes vente | Pro |
| `purchaseOrderStore.js` | commandes achat | Business |
| `kitStore.js` | kits & bundles | Business |
| `userProfileStore.js` | profils utilisateurs | — |

Toutes les écritures utilisent un **pattern atomique `.tmp` + `rename`** pour éviter les corruptions. Toujours respecter ce pattern dans les nouveaux stores.

**Stores vs managers.** Les `*Store.js` font l'I/O fichier ; les `*Manager.js` portent la logique métier et ne devraient jamais écrire directement :

| Manager | Rôle |
|---|---|
| `stockManager.js` | calcul du CMP (coût moyen pondéré), application des mouvements |
| `settingsManager.js` | paramètres avancés multi-shop |
| `planManager.js` | définition des tiers, limites, `hasFeature()` |
| `analyticsManager.js` | calculs analytics (trésorerie, patrimoine) |
| `forecastManager.js` | prévisions de rupture, recommandations d'achat |
| `alertChecker.js` | génération des alertes (rupture, DLC, seuils) |
| `notificationDispatcher.js` | envoi des notifications externes |

Aucun scheduler dans le repo (pas de `setInterval`, pas de cron) : `alertChecker` et consorts tournent à la demande, déclenchés par une requête ou un webhook.

Les modules par tier (Starter/Pro/Business) sont chargés via `try/require` dans `server.js` lignes 84–180 — leur absence ne doit jamais crasher l'app. Le **gating** est fait par `planManager.hasFeature(shop, featureKey)` (`hasSuppliers`, `hasBatchTracking`, `hasAnalytics`, `hasInventoryCount`, `hasPurchaseOrders`, `hasForecast`, `hasKits`).

`server-pro-routes.js` (586 lignes) exporte `function(router, helpers)` et définit les routes des modules Pro. Invoqué une seule fois, tard dans le fichier :

```js
// server.js:8391
require("./server-pro-routes")(router, { getShop, apiError, safeJson });
```

Les helpers passés sont limités à ces trois-là : un besoin d'autre chose côté pro-routes implique d'élargir cet objet.

### Couche Shopify API — `shopifyClient.js`

- `getShopifyClient(shop)` retourne un client `shopify-api-node` mémoïsé par `(shop, token[:8])`. Tape une **erreur 401 `missing_oauth_token`** si aucun token disque n'est trouvé pour le shop — c'est ce qui déclenche le flow `reauth_required` côté `safeJson`. Ne JAMAIS attraper ce 401 silencieusement.
- `graphqlRequest(shop, query, variables)` — wrapper GraphQL. Utilisé par les helpers de billing (`createAppSubscription`, `getActiveAppSubscriptions`, `cancelAppSubscription`).
- `normalizeShopDomain(s)` : assure que le shop est toujours sous la forme `xxx.myshopify.com` (strip protocol/path/trailing dot, ajoute le suffixe si manquant). À utiliser systématiquement sur toute valeur de shop venant de l'extérieur.

**Scopes = `read_products, write_inventory, read_locations, read_orders`.** L'app écrit l'inventaire mais **jamais les produits** : aucun flux ne peut modifier titre, prix ou variante côté Shopify. Une fonctionnalité qui l'exigerait demande un nouveau scope dans le TOML *et* une réinstallation par le marchand.

### Intégration bancaire Qonto — exception mono-tenant

`server.js:5210-5250` et la route `/api/finance/qonto-treasury` (`server.js:5664`) interrogent `https://thirdparty.qonto.com/v2/organization` pour afficher le solde du compte. Credentials lus **depuis l'env global** (`QONTO_LOGIN`, `QONTO_SECRET_KEY`), pas depuis un store par shop. Cache mémoire de 60 s (limite Qonto : 2 req/s).

⚠️ C'est la seule zone de l'app qui n'est pas scopée par boutique : si un second marchand installe l'app, il verrait le solde Qonto de Cloud Store CBD. À traiter avant toute ouverture à des tiers.

### Frontend — `public/`

- `index.html` (150 lignes) : structure statique minimale (sidebar + topbar + `#pageContent` vide) ; tout est rendu dynamiquement par `app.js`. Sept onglets : `dashboard`, `catalogue`, `batches`, `inventory`, `achats`, `analyse`, `settings` — les onglets à features portent un `data-feature` (ex. `data-feature="hasBatchTracking"`) qui pilote leur verrouillage.
- `js/app.js` (~687 Ko / 13 256 lignes) : monolithe global `window.app` qui gère navigation par onglets, fetch API, modales, toasts, etc. Pas de framework. **Toute modification doit garder l'API publique `app.X()` stable** (les `onclick="app.foo()"` du HTML s'y attachent par nom).
- `js/i18n.js` (~285 Ko / 5 836 lignes) : dictionnaire de traductions FR/EN inline. Tout texte visible passe par `t(...)`, jamais de chaîne en dur.
- `js/lucide.min.js` : icônes. `lucide.createIcons()` est appelé après `DOMContentLoaded` — à rappeler après tout rendu qui injecte des `<i data-lucide>`.
- `css/style.css` (~144 Ko), `notifications.css` (~10 Ko), `ux-polish.css` (~22 Ko).

App Bridge v4 est chargé en **premier** dans `<head>` via le CDN Shopify (obligatoire avant tout autre script qui appellerait `shopify.idToken()`). La meta `shopify-api-key` doit correspondre au `client_id` Shopify utilisé en runtime — ⚠️ voir Gotchas.

`API_BASE` côté frontend doit rester `"/api"` (chemin relatif) pour que les appels passent par le router auth-protégé. Ne pas hardcoder l'URL Render.

### Logs

`utils/logger.js` exporte `logEvent(event, data, level)` (Winston). Les data sont sanitizées (strings `\n\r` strippées, tronquées à 500 chars, objets imbriqués remplacés par `[Object]`). Toujours utiliser `logEvent` pour les logs structurés, pas `console.log` direct.

## Variables d'environnement

**Obligatoires côté Render** (absentes du `.env` local — l'app ne peut donc pas s'authentifier en local) :
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` — vérification JWT + OAuth (le `client_id` du TOML doit matcher `SHOPIFY_API_KEY`).
- `SHOPIFY_SCOPES` — doit matcher `access_scopes.scopes` du TOML (`read_products,write_inventory,read_locations,read_orders`).
- `RENDER_PUBLIC_URL` — base URL publique, utilisée pour construire `redirect_uri` OAuth.
- `SHOPIFY_WEBHOOK_SECRET` — vérif HMAC des webhooks.

**Importantes** :
- `DATA_DIR` (default `/var/data`) — disque persistant Render.
- `NODE_ENV` — contrôle `API_AUTH_REQUIRED` par défaut (`true` si `production`).
- `API_AUTH_REQUIRED` — override explicite (`false` désactive l'auth API, **ne jamais** mettre en prod).
- `SHOPIFY_API_VERSION` (default `2025-10`).
- `LOG_LEVEL` (default `info`).
- `QONTO_LOGIN`, `QONTO_SECRET_KEY` — intégration bancaire, globales et non scopées par shop.

**Présentes dans le `.env` local, legacy mono-boutique** (voir Gotchas) :
`SHOP_NAME`, `SHOPIFY_ADMIN_TOKEN`, `LOCATION_ID`, `SKIP_HMAC_VALIDATION`, `CATALOG_FILE`, `MOVEMENTS_DIR`, `STOCK_STATE_FILE`, `LOW_STOCK_THRESHOLD`, `MOVEMENT_RETENTION_DAYS`, `PORT`.

`.env` est dans `.gitignore` et contient des secrets — ne jamais committer ni partager dans un PR/issue public.

## Gotchas spécifiques au projet

1. **Double système de tokens.** `.env` contient un `SHOPIFY_ADMIN_TOKEN` statique à côté du `tokenStore` OAuth multi-shop. Le code de production doit utiliser **uniquement** les tokens OAuth via `getShopifyClient(shop)`. Si un chemin appelle encore l'API avec `SHOPIFY_ADMIN_TOKEN`, c'est legacy — à signaler avant de modifier.

2. **Double source de vérité pour `LOCATION_ID`.** L'env `LOCATION_ID` ET `settingsStore.setLocationId(shop)` coexistent. Le bon comportement multi-shop est de toujours résoudre via `getLocationIdForShop(shop)` (`server.js:599`). L'env doit être considéré comme un fallback de dev uniquement.

3. **Discordance `client_id` TOML vs `shopify-api-key` HTML — toujours ouverte.** Le TOML déclare `client_id = "97cfc1521ba544a2196d00c8bec599c9"` ; `public/index.html:10` contient `<meta name="shopify-api-key" content=af29943af7d0b46cd218987c99b15929 />` (sans guillemets, et valeur différente). Le repo ne permet pas de trancher : `SHOPIFY_API_KEY` n'est pas dans le `.env` local, elle n'existe que dans le dashboard Render. **Vérifier là-bas** avant de toucher à l'auth ou App Bridge — un `aud` mismatch casse tous les appels API, et si la variable était vide côté Render le contrôle `aud` serait sauté sans erreur (voir Auth).

4. **`stockState.js` mélange legacy `__dirname/data/` et `/var/data/<shop>/`.** Les fonctions `loadProducts/saveProducts/loadTypes/...` écrivent dans `data/` à la racine du repo (perdu à chaque redéploiement Render, et partagé entre tous les shops). Seuls `loadState(shop)` / `saveState(shop, data)` sont multi-shop persistants. **Tout nouveau code doit passer par `loadState/saveState`.**

5. **État en mémoire single-instance.** `_oauthStateByShop` (CSRF state OAuth) et `processedWebhooks` (dédup webhook) sont des Maps locales au process. Si l'app passe en multi-instance (auto-scaling Render), il faut les externaliser (Redis ou disque). Pour l'instant, rester en single instance.

6. **`safeJson` gère le reauth — ne pas le contourner.** Tous les handlers d'API qui appellent Shopify doivent passer par `safeJson(req, res, async () => { ... })`. C'est ce qui purge les tokens invalides et déclenche le redirect frontend vers `/api/auth/start`. Ne jamais retourner directement un 401 brut depuis un handler qui parle à Shopify.

7. **Webhooks = `express.raw`, jamais `express.json`.** Les routes `/webhooks/*` doivent rester enregistrées sur `app` avant le montage du router (`server.js:8790`) et utiliser le body brut, sinon la vérification HMAC SHA256 échoue.

8. **`SKIP_HMAC_VALIDATION`** existe comme flag de bypass — **ne jamais** le mettre à `true` en prod, et le retirer dès que possible.

9. **`/api/billing/return` est exempté d'auth**, volontairement : Shopify y redirige après acceptation d'un abonnement, hors contexte embedded, donc sans session token. Le handler doit rester défensif sur `?shop=` (valeur non authentifiée).

10. **`app.js` 687 Ko monolithique.** Toute modification d'UI risque d'avoir des effets de bord. Repérer la fonction par nom (`app.fooBar`) avant d'éditer, vérifier qui l'appelle (search dans `index.html` + `app.js` lui-même).

11. **Qonto n'est pas multi-shop** (voir section dédiée) — bloquant avant toute ouverture à des marchands tiers.

12. **Script `npm run dev` Unix-only.** Il faut soit corriger le script (cross-env), soit lancer manuellement sous PowerShell.

13. **Aucun filet de test.** `npm test` lance jest sur une suite vide. Toute régression se découvre en production : privilégier les modifications ciblées et vérifiables à la lecture.

## Workflow de modification (rappel)

Conventions de l'utilisateur (cf. mémoire projet) :
- Réponses en français.
- Avant toute modification, lister les fichiers concernés et demander leur contenu si non lu.
- Pour `server.js`, livrer la **version complète prête à copier-coller** par défaut, sauf demande explicite de patch court.
- Expliquer brièvement l'apport de la modif et signaler les risques.
- Priorité absolue sur la stabilité auth / App Bridge / OAuth / webhook uninstall (zones déjà sources de bugs).

// shopifyClient.js — PRE-PROD / PROD SAFE + ✅ Billing helpers (GraphQL)
const Shopify = require("shopify-api-node");
const crypto = require("crypto");
const tokenStore = require("./utils/tokenStore");

// Cache par shop+token
const _clientCache = new Map();

// ==========================
// Utils
// ==========================
function normalizeShopDomain(shop) {
  const raw = String(shop || "").trim();
  if (!raw) return "";

  let noProto = raw.replace(/^https?:\/\//i, "").trim();
  noProto = noProto.split("/")[0].trim();
  noProto = noProto.replace(/\.+$/, "").trim();

  if (noProto.endsWith(".myshopify.com")) return noProto;
  return `${noProto}.myshopify.com`;
}

// shopify-api-node attend le SLUG (sans .myshopify.com)
function shopDomainToSlug(shopDomain) {
  const d = normalizeShopDomain(shopDomain);
  return d ? d.replace(/\.myshopify\.com$/i, "") : "";
}

// ==========================
// Token handling (OAuth ONLY)
// ==========================
function getAccessTokenForShop(shopDomain) {
  const shop = normalizeShopDomain(shopDomain);
  if (!shop) {
    const err = new Error("Shop invalide (token)");
    err.statusCode = 400;
    err.code = "invalid_shop";
    throw err;
  }

  const token = tokenStore.loadToken(shop);

  // ✅ IMPORTANT: si token manquant => 401 pour que safeJson() renvoie reauth_required
  if (!token) {
    const err = new Error(
      `Aucun token OAuth pour ${shop}. Installe l'app ou relance /api/auth/start?shop=${shop}`
    );
    err.statusCode = 401;
    err.code = "missing_oauth_token";
    err.shop = shop;
    throw err;
  }

  return token;
}

// ==========================
// Client factory
// ==========================
function createShopifyClient(shopDomain, accessToken) {
  const domain = normalizeShopDomain(shopDomain);
  const shopName = shopDomainToSlug(domain);

  if (!shopName) {
    const err = new Error("Shop invalide pour Shopify client");
    err.statusCode = 400;
    err.code = "invalid_shop";
    throw err;
  }

  return new Shopify({
    shopName, // ex: "cloud-store-test"
    accessToken,
    // Version stable Shopify : 2025-10 retiree le 2026-10-16. 2026-07 accessible jusqu'au 2027-07-16.
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  });
}

function getShopifyClient(shop) {
  const shopDomain = normalizeShopDomain(shop);
  if (!shopDomain) {
    const err = new Error("Shop manquant pour Shopify client");
    err.statusCode = 400;
    err.code = "missing_shop";
    throw err;
  }

  const token = getAccessTokenForShop(shopDomain);

  // cache par shop + token (rotation safe)
  const cacheKey = `${shopDomain.toLowerCase()}::${token.slice(0, 8)}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);

  const client = createShopifyClient(shopDomain, token);
  _clientCache.set(cacheKey, client);
  return client;
}

// ==========================
// Helpers produits / boutique (GraphQL Admin API, voir plus bas)
// ==========================
async function searchProducts(shop, opts = {}) {
  const query = String(opts.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit || 50), 1), 250);

  const products = await listProducts(shop, { limit });
  if (!query) return products;

  return products.filter((p) => String(p.title || "").toLowerCase().includes(query));
}

async function fetchProduct(shop, productId) {
  if (!productId) {
    const err = new Error("fetchProduct: productId manquant");
    err.statusCode = 400;
    err.code = "missing_product_id";
    throw err;
  }
  return getProduct(shop, productId);
}

async function testShopifyConnection(shop) {
  const info = await getShopInfo(shop, { plan: true });

  return {
    ok: true,
    shop: info?.myshopify_domain || info?.domain || "",
    name: info?.name || "",
    plan: info?.plan_name || "",
  };
}

// =====================================================
// ✅ Billing / GraphQL helpers
// =====================================================

function toMoneyAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("Montant invalide");
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Wrapper GraphQL sécurisé (shopify-api-node: client.graphql(query, variables))
 *
 * - Token absent => getShopifyClient() lève déjà une erreur 401 (missing_oauth_token).
 * - Token révoqué => Shopify répond HTTP 401 : on propage statusCode 401 (safeJson purge le token).
 * - Erreurs GraphQL de niveau `errors` (renvoyées en HTTP 200) => Error avec message clair
 *   et un statusCode non-2xx (sinon apiError() répondrait un HTTP 200 avec un corps d'erreur).
 * - THROTTLED / HTTP 429 => jusqu'à GRAPHQL_THROTTLE_RETRIES reprises après une courte attente
 *   (une requête refusée pour débit n'est pas exécutée : rejouer une mutation est sans risque).
 */
const GRAPHQL_THROTTLE_RETRIES = 3;
const GRAPHQL_MAX_WAIT_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildGraphqlError(e) {
  const res = e?.response;
  const body = res?.body;
  const gqlErrors = Array.isArray(body?.errors) ? body.errors : [];
  const gqlCode = gqlErrors[0]?.extensions?.code;

  let statusCode = Number(e?.statusCode || res?.statusCode) || undefined;
  if (gqlErrors.length && (!statusCode || (statusCode >= 200 && statusCode < 300))) {
    // Erreur GraphQL en HTTP 200 : on lui donne un statut HTTP exploitable.
    statusCode = gqlCode === "THROTTLED" ? 429 : gqlCode === "ACCESS_DENIED" ? 403 : 500;
  }

  const gqlMessage = gqlErrors.map((x) => x?.message).filter(Boolean).join(" | ");
  const err = new Error(gqlMessage || e?.message || "GraphQL error");
  err.statusCode = statusCode;
  if (gqlCode) err.code = gqlCode;
  err.requestId = res?.headers?.["x-request-id"] || res?.headers?.["x-requestid"];
  err.body = body;
  // Même forme que les erreurs REST de shopify-api-node : extractShopifyError() (server.js) lit err.response.
  err.response = {
    statusCode,
    headers: { "x-request-id": err.requestId, "retry-after": res?.headers?.["retry-after"] },
    body,
  };

  // Attente conseillée avant reprise (THROTTLED / 429)
  if (gqlCode === "THROTTLED" || statusCode === 429) {
    const cost = body?.extensions?.cost;
    const restoreRate = Number(cost?.throttleStatus?.restoreRate);
    const deficit = Number(cost?.requestedQueryCost) - Number(cost?.throttleStatus?.currentlyAvailable);
    const retryAfterSec = Number(res?.headers?.["retry-after"]);
    let waitMs = 1000;
    if (restoreRate > 0 && deficit > 0) waitMs = Math.ceil((deficit / restoreRate) * 1000);
    else if (retryAfterSec > 0) waitMs = retryAfterSec * 1000;
    err.throttled = true;
    err.retryDelayMs = Math.min(Math.max(waitMs, 500), GRAPHQL_MAX_WAIT_MS);
  }
  return err;
}

async function graphqlRequest(shop, query, variables = {}) {
  const client = getShopifyClient(shop);
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.graphql(String(query), variables);
    } catch (e) {
      const err = buildGraphqlError(e);
      if (err.throttled && attempt < GRAPHQL_THROTTLE_RETRIES) {
        await sleep(err.retryDelayMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Pause avant la page suivante d'une pagination si le seuil de coût GraphQL restant est
 * inférieur au coût demandé par la requête précédente (évite les THROTTLED en rafale).
 */
async function paceGraphql(shop) {
  const lim = getShopifyClient(shop).callGraphqlLimits;
  if (!lim || !Number.isFinite(lim.remaining) || !(lim.restoreRate > 0)) return;
  const deficit = (Number(lim.requestedQueryCost) || 0) - lim.remaining;
  if (deficit > 0) await sleep(Math.min(Math.ceil((deficit / lim.restoreRate) * 1000), GRAPHQL_MAX_WAIT_MS));
}

async function getActiveAppSubscriptions(shop) {
  const query = `
    query ActiveSubs {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          trialDays
          createdAt
          lineItems {
            id
            plan {
              pricingDetails {
                __typename
                ... on AppRecurringPricing {
                  interval
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(shop, query, {});
  const subs = data?.currentAppInstallation?.activeSubscriptions || [];
  return Array.isArray(subs) ? subs : [];
}

async function createAppSubscription(shop, opts = {}) {
  const name = String(opts.name || "").trim();
  const returnUrl = String(opts.returnUrl || "").trim();
  if (!name) throw new Error("Billing: name manquant");
  if (!returnUrl) throw new Error("Billing: returnUrl manquant");

  const currencyCode = String(opts.currencyCode || "EUR").trim().toUpperCase();
  const interval = String(opts.interval || "EVERY_30_DAYS").trim().toUpperCase();
  const trialDays = Number.isFinite(Number(opts.trialDays)) ? Number(opts.trialDays) : 0;
  const test = opts.test === true;

  const amount = toMoneyAmount(opts.price);

  const mutation = `
    mutation CreateSub($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $trialDays: Int, $test: Boolean) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        lineItems: $lineItems
        trialDays: $trialDays
        test: $test
      ) {
        confirmationUrl
        appSubscription {
          id
          name
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    name,
    returnUrl,
    trialDays: trialDays > 0 ? trialDays : null,
    test,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount, currencyCode },
            interval,
          },
        },
      },
    ],
  };

  const data = await graphqlRequest(shop, mutation, variables);
  const payload = data?.appSubscriptionCreate || {};
  const userErrors = payload?.userErrors || [];

  return {
    confirmationUrl: payload?.confirmationUrl || null,
    subscriptionId: payload?.appSubscription?.id || null,
    status: payload?.appSubscription?.status || null,
    userErrors,
  };
}

async function cancelAppSubscription(shop, subscriptionGid, opts = {}) {
  const id = String(subscriptionGid || "").trim();
  if (!id) throw new Error("Billing: subscriptionGid manquant");

  const prorate = opts.prorate !== false;
  const reason = String(opts.reason || "OTHER").trim().toUpperCase();

  const mutation = `
    mutation CancelSub($id: ID!, $prorate: Boolean!, $reason: AppSubscriptionCancellationReason) {
      appSubscriptionCancel(id: $id, prorate: $prorate, cancellationReason: $reason) {
        appSubscription {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { id, prorate, reason };

  const data = await graphqlRequest(shop, mutation, variables);
  const payload = data?.appSubscriptionCancel || {};
  const userErrors = payload?.userErrors || [];

  return {
    cancelledId: payload?.appSubscription?.id || null,
    status: payload?.appSubscription?.status || null,
    userErrors,
  };
}

// =====================================================
// ✅ Données boutique via GraphQL Admin API
// =====================================================
// Remplace les anciens appels REST (client.product.list, client.shop.get, client.inventoryLevel.set...).
// Chaque fonction renvoie des objets au FORMAT REST historique (snake_case, IDs NUMÉRIQUES) pour ne
// pas toucher aux appelants ni aux IDs persistés sur disque (stock.json, mouvements, lots...).
// Seuls les champs réellement consommés par l'app sont mappés.
//
// Coût GraphQL : une requête est limitée à 1000 points, calculés sur les `first` demandés
// (connexions imbriquées = produit des `first`) => pages volontairement petites + pagination.

const PRODUCTS_PAGE_SIZE = 10; // produits (avec variantes) par requête
const PRODUCTS_BASIC_PAGE_SIZE = 250; // produits sans variantes par requête
const PRODUCTS_MAX = 2000; // plafond de produits remontés
const VARIANTS_PAGE_SIZE = 10; // variantes chargées avec chaque produit de la liste
const VARIANTS_MORE_PAGE_SIZE = 50; // pages suivantes si un produit dépasse VARIANTS_PAGE_SIZE
const ORDERS_PAGE_SIZE = 10;
const ORDER_LINES_PAGE_SIZE = 10;
const ORDERS_MAX = 1000;

/** "gid://shopify/Product/123" -> 123 (Number, comme les IDs REST). */
function gidToId(gid) {
  const m = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)(?:\?.*)?$/.exec(String(gid || ""));
  return m ? Number(m[1]) : null;
}

/** 123 | "123" | GID -> "gid://shopify/<type>/123" (400 si invalide). */
function toGid(type, id) {
  const raw = String(id ?? "").trim();
  if (/^gid:\/\/shopify\//.test(raw)) return raw;
  if (!/^\d+$/.test(raw)) {
    const err = new Error(`Identifiant Shopify invalide (${type}): ${raw || "vide"}`);
    err.statusCode = 400;
    err.code = "invalid_id";
    throw err;
  }
  return `gid://shopify/${type}/${raw}`;
}

/** Parcourt une connexion GraphQL page par page jusqu'à maxItems. fetchPage(after, remaining) => connexion. */
async function collectConnection(shop, maxItems, fetchPage) {
  const out = [];
  let after = null;
  while (out.length < maxItems) {
    const conn = await fetchPage(after, maxItems - out.length);
    const nodes = Array.isArray(conn?.nodes) ? conn.nodes : [];
    out.push(...nodes);
    const next = conn?.pageInfo;
    if (!nodes.length || !next?.hasNextPage || !next.endCursor) break;
    after = next.endCursor;
    if (out.length < maxItems) await paceGraphql(shop);
  }
  return out.slice(0, maxItems);
}

/** Erreur levée quand une mutation renvoie des userErrors (jamais silencieuses). */
function throwOnUserErrors(operation, userErrors) {
  if (!Array.isArray(userErrors) || !userErrors.length) return;
  const detail = userErrors.map((e) => e?.message).filter(Boolean).join(" | ") || "erreur Shopify";
  const err = new Error(`${operation}: ${detail}`);
  err.statusCode = 422;
  err.code = userErrors[0]?.code || "USER_ERROR";
  err.userErrors = userErrors;
  err.response = { statusCode: 422, headers: {}, body: { errors: userErrors } };
  throw err;
}

/** true si SHOPIFY_API_VERSION (défaut 2026-07) >= minVersion ("YYYY-MM"). "unstable"/inconnu => schéma le plus récent. */
function apiVersionAtLeast(minVersion) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(process.env.SHOPIFY_API_VERSION || "2026-07"));
  return m ? `${m[1]}-${m[2]}` >= minVersion : true;
}

// ---------- Boutique ----------

/**
 * Équivalent de client.shop.get() : { id, name, domain, myshopify_domain, currency, iana_timezone }.
 * opts.locale => ajoute primary_locale (locale par défaut du domaine principal, pas besoin du scope
 *   read_locales ; null si indisponible => l'appelant retombe sur "en" comme avant).
 * opts.plan => ajoute plan_name / plan_display_name (plan_name est une approximation du slug REST).
 */
async function getShopInfo(shop, opts = {}) {
  const build = (withLocale) => `
    query ShopInfo {
      shop {
        id
        name
        myshopifyDomain
        currencyCode
        ianaTimezone
        primaryDomain { host ${withLocale ? "localization { defaultLocale }" : ""} }
        ${opts.plan ? "plan { publicDisplayName shopifyPlus }" : ""}
      }
    }
  `;

  let data;
  try {
    data = await graphqlRequest(shop, build(Boolean(opts.locale)));
  } catch (e) {
    // Le champ de localisation est accessoire : on réessaie sans, sauf si le token est invalide (401 => reauth).
    if (!opts.locale || Number(e?.statusCode) === 401) throw e;
    data = await graphqlRequest(shop, build(false));
  }

  const s = data?.shop;
  if (!s) throw new Error("Réponse Shopify invalide : shop absent");

  const info = {
    id: gidToId(s.id),
    name: s.name ?? null,
    domain: s.primaryDomain?.host || s.myshopifyDomain || null,
    myshopify_domain: s.myshopifyDomain ?? null,
    currency: s.currencyCode ?? null,
    iana_timezone: s.ianaTimezone ?? null,
  };
  if (opts.locale) info.primary_locale = s.primaryDomain?.localization?.defaultLocale || null;
  if (opts.plan && s.plan) {
    const display = String(s.plan.publicDisplayName || "");
    info.plan_display_name = display;
    info.plan_name = s.plan.shopifyPlus ? "shopify_plus" : display.toLowerCase().replace(/\s+/g, "_");
  }
  return info;
}

// ---------- Emplacements ----------

/**
 * Équivalent de client.location.list({ limit }) : [{ id, name, active, address1, city, country }].
 * Actifs + inactifs + legacy (comme REST), triés par NOM : ordre constaté en REST (boutique de dev, 09/10/2026),
 * dont dépend le choix du 1er emplacement dans getLocationIdForShop().
 * `country` = code pays ISO (comme le champ REST `country`).
 */
async function listLocations(shop, opts = {}) {
  const first = Math.min(Math.max(Number(opts.limit) || 50, 1), 250);
  const data = await graphqlRequest(
    shop,
    `
    query ListLocations($first: Int!) {
      locations(first: $first, includeInactive: true, includeLegacy: true, sortKey: NAME) {
        nodes { id name isActive address { address1 city countryCode } }
      }
    }
  `,
    { first }
  );
  return (data?.locations?.nodes || []).map((l) => ({
    id: gidToId(l.id),
    name: l.name ?? "",
    active: Boolean(l.isActive),
    address1: l.address?.address1 ?? null,
    city: l.address?.city ?? null,
    country: l.address?.countryCode ?? null,
  }));
}

// ---------- Produits ----------

const VARIANT_FIELDS = `
  id
  title
  sku
  barcode
  price
  inventoryQuantity
  selectedOptions { name value }
  inventoryItem {
    id
    measurement { weight { value unit } }
  }
`;

const PRODUCTS_QUERY = `
  query ListProducts($first: Int!, $after: String, $variantsFirst: Int!) {
    products(first: $first, after: $after, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        variants(first: $variantsFirst) {
          nodes { ${VARIANT_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCTS_BASIC_QUERY = `
  query ListProductsBasic($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      nodes { id title handle variantsCount { count } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `
  query ProductById($id: ID!, $variantsFirst: Int!) {
    product(id: $id) {
      id
      title
      handle
      variants(first: $variantsFirst) {
        nodes { ${VARIANT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const PRODUCT_VARIANTS_PAGE_QUERY = `
  query ProductVariantsPage($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        nodes { ${VARIANT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const WEIGHT_UNIT_REST = { GRAMS: "g", KILOGRAMS: "kg", POUNDS: "lb", OUNCES: "oz" };
const WEIGHT_UNIT_GRAMS = { g: 1, kg: 1000, lb: 453.59237, oz: 28.349523125 };

/** Poids GraphQL { value, unit } -> champs REST weight / weight_unit / grams (grams arrondi à l'entier comme REST). */
function weightToRest(weight) {
  const unit = WEIGHT_UNIT_REST[weight?.unit] || "g";
  const value = Number(weight?.value) || 0;
  return { weight: value, weight_unit: unit, grams: Math.round(value * WEIGHT_UNIT_GRAMS[unit]) };
}

/** Variante GraphQL -> variante REST (champs consommés : sync, import produit, diagnostic stock). */
function mapVariantNode(v, productId) {
  const options = Array.isArray(v?.selectedOptions) ? v.selectedOptions.map((o) => o?.value ?? null) : [];
  return {
    id: gidToId(v?.id),
    product_id: productId,
    title: v?.title ?? null,
    sku: v?.sku ?? null,
    barcode: v?.barcode ?? null,
    price: v?.price ?? null,
    option1: options[0] ?? null,
    option2: options[1] ?? null,
    option3: options[2] ?? null,
    inventory_item_id: gidToId(v?.inventoryItem?.id),
    inventory_quantity: Number(v?.inventoryQuantity) || 0,
    ...weightToRest(v?.inventoryItem?.measurement?.weight),
  };
}

/** Variantes au-delà de la première page d'un produit (rare : > VARIANTS_PAGE_SIZE variantes). */
async function fetchRemainingVariants(shop, productGid, afterCursor) {
  const out = [];
  let after = afterCursor;
  for (let i = 0; after && i < 50; i++) {
    await paceGraphql(shop);
    const data = await graphqlRequest(shop, PRODUCT_VARIANTS_PAGE_QUERY, {
      id: productGid,
      first: VARIANTS_MORE_PAGE_SIZE,
      after,
    });
    const conn = data?.product?.variants;
    out.push(...(conn?.nodes || []));
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return out;
}

/** Produit GraphQL -> produit REST { id, title, handle, variants[] } (toutes les variantes, paginées). */
async function mapProductWithVariants(shop, p) {
  const nodes = [...(p?.variants?.nodes || [])];
  if (p?.variants?.pageInfo?.hasNextPage) {
    nodes.push(...(await fetchRemainingVariants(shop, p.id, p.variants.pageInfo.endCursor)));
  }
  const id = gidToId(p.id);
  return {
    id,
    title: p.title ?? null,
    handle: p.handle ?? null,
    variants: nodes.map((v) => mapVariantNode(v, id)),
  };
}

/**
 * Équivalent de client.product.list({ limit }) mais paginé (plafond PRODUCTS_MAX, défaut 250 = ancienne limite REST).
 * Triés par titre (ordre constaté en REST, 09/10/2026 : liste du sélecteur d'import). opts.variants === false => liste légère { id, title, handle, variants_count }.
 */
async function listProducts(shop, opts = {}) {
  const max = Math.min(Math.max(Number(opts.limit) || 250, 1), PRODUCTS_MAX);

  if (opts.variants === false) {
    const nodes = await collectConnection(shop, max, async (after, remaining) => {
      const data = await graphqlRequest(shop, PRODUCTS_BASIC_QUERY, {
        first: Math.min(PRODUCTS_BASIC_PAGE_SIZE, remaining),
        after,
      });
      return data?.products;
    });
    return nodes.map((p) => ({
      id: gidToId(p.id),
      title: p.title ?? null,
      handle: p.handle ?? null,
      variants_count: Number(p.variantsCount?.count) || 0,
    }));
  }

  const nodes = await collectConnection(shop, max, async (after, remaining) => {
    const data = await graphqlRequest(shop, PRODUCTS_QUERY, {
      first: Math.min(PRODUCTS_PAGE_SIZE, remaining),
      after,
      variantsFirst: VARIANTS_PAGE_SIZE,
    });
    return data?.products;
  });
  const out = [];
  for (const p of nodes) out.push(await mapProductWithVariants(shop, p));
  return out;
}

/** Équivalent de client.product.get(id). Renvoie null si le produit n'existe pas. */
async function getProduct(shop, productId) {
  const data = await graphqlRequest(shop, PRODUCT_BY_ID_QUERY, {
    id: toGid("Product", productId),
    variantsFirst: VARIANTS_MORE_PAGE_SIZE,
  });
  return data?.product ? mapProductWithVariants(shop, data.product) : null;
}

/**
 * Équivalent de client.productVariant.get(id) :
 * { id, product_id, title, sku, inventory_item_id, inventory_management, inventory_policy }.
 * inventory_management = "shopify" si le suivi de stock est activé, sinon null (comme REST).
 * Lève une erreur 404 si la variante n'existe pas (comme REST : le webhook orders/create est alors rejoué).
 */
async function getVariant(shop, variantId) {
  const data = await graphqlRequest(
    shop,
    `
    query VariantById($id: ID!) {
      productVariant(id: $id) {
        id
        title
        sku
        inventoryPolicy
        product { id }
        inventoryItem { id tracked }
      }
    }
  `,
    { id: toGid("ProductVariant", variantId) }
  );
  const v = data?.productVariant;
  if (!v) {
    const err = new Error(`Variante Shopify introuvable (${variantId})`);
    err.statusCode = 404;
    err.code = "not_found";
    throw err;
  }
  return {
    id: gidToId(v.id),
    product_id: gidToId(v.product?.id),
    title: v.title ?? null,
    sku: v.sku ?? null,
    inventory_item_id: gidToId(v.inventoryItem?.id),
    inventory_management: v.inventoryItem?.tracked ? "shopify" : null,
    inventory_policy: v.inventoryPolicy ? String(v.inventoryPolicy).toLowerCase() : null,
  };
}

// ---------- Inventaire ----------

/**
 * Équivalent de client.inventoryLevel.list({ inventory_item_ids, location_ids }) :
 * [{ inventory_item_id, location_id, available, updated_at }] pour les seuls niveaux existants
 * (un article non stocké à l'emplacement est absent du résultat, comme REST).
 */
async function listInventoryLevels(shop, { inventoryItemIds, locationIds } = {}) {
  const itemGids = (Array.isArray(inventoryItemIds) ? inventoryItemIds : [inventoryItemIds]).map((id) =>
    toGid("InventoryItem", id)
  );
  const locationGids = (Array.isArray(locationIds) ? locationIds : [locationIds]).map((id) => toGid("Location", id));

  const query = `
    query InventoryLevelsAtLocation($ids: [ID!]!, $locationId: ID!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            updatedAt
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  `;

  const levels = [];
  for (const locationId of locationGids) {
    for (let i = 0; i < itemGids.length; i += 50) {
      const data = await graphqlRequest(shop, query, { ids: itemGids.slice(i, i + 50), locationId });
      for (const node of data?.nodes || []) {
        if (!node?.inventoryLevel) continue;
        const available = (node.inventoryLevel.quantities || []).find((q) => q?.name === "available");
        levels.push({
          inventory_item_id: gidToId(node.id),
          location_id: gidToId(locationId),
          available: available ? Number(available.quantity) : null,
          updated_at: node.inventoryLevel.updatedAt ?? null,
        });
      }
    }
  }
  return levels;
}

// inventorySetQuantities / inventoryActivate (API >= 2026-01) : directive @idempotent(key) (optionnelle en
// 2026-01..03, OBLIGATOIRE depuis 2026-04) et champ `changeFromQuantity` fourni explicitement (null = pas de
// contrôle de concurrence ; remplace compareQuantity / ignoreCompareQuantity, retirés en 2026-07).
// Avant 2026-01 (SHOPIFY_API_VERSION forcée à une version plus ancienne) : ancienne forme, sans directive.
const MODERN_INVENTORY_API = "2026-01";
const SET_AVAILABLE_MUTATION = `
  mutation SetAvailable($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { createdAt changes { name delta } }
      userErrors { code field message }
    }
  }
`;

const SET_AVAILABLE_MUTATION_LEGACY = `
  mutation SetAvailable($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt changes { name delta } }
      userErrors { code field message }
    }
  }
`;

const ACTIVATE_MUTATION = `
  mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }
`;

const ACTIVATE_MUTATION_LEGACY = `
  mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }
`;

/**
 * Équivalent de client.inventoryLevel.set({ location_id, inventory_item_id, available }) :
 * fixe la quantité "available" ABSOLUE à l'emplacement, sans contrôle de concurrence (la source de vérité
 * est l'app). Lève une erreur si userErrors non vide ; article non stocké à l'emplacement =>
 * err.code === "ITEM_NOT_STOCKED_AT_LOCATION" (statusCode 422) pour déclencher activateInventoryItem puis retry.
 * La clé d'idempotence est un UUID neuf à CHAQUE appel : une clé déterministe ferait ignorer un second
 * push de la même quantité (alors que le stock Shopify a pu bouger entre-temps).
 */
async function setInventoryAvailable(shop, { inventoryItemId, locationId, available }) {
  const quantity = Math.floor(Number(available));
  if (!Number.isFinite(quantity) || quantity < 0) {
    const err = new Error(`Quantité disponible invalide: ${available}`);
    err.statusCode = 400;
    err.code = "invalid_quantity";
    throw err;
  }

  const item = {
    inventoryItemId: toGid("InventoryItem", inventoryItemId),
    locationId: toGid("Location", locationId),
    quantity,
  };

  let mutation;
  let variables;
  if (apiVersionAtLeast(MODERN_INVENTORY_API)) {
    mutation = SET_AVAILABLE_MUTATION;
    variables = {
      input: {
        name: "available",
        reason: "correction",
        quantities: [{ ...item, changeFromQuantity: null }],
      },
      idempotencyKey: crypto.randomUUID(),
    };
  } else {
    mutation = SET_AVAILABLE_MUTATION_LEGACY;
    variables = {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{ ...item, compareQuantity: null }],
      },
    };
  }

  const data = await graphqlRequest(shop, mutation, variables);
  const payload = data?.inventorySetQuantities;
  if (!payload) throw new Error("inventorySetQuantities: réponse Shopify vide");
  throwOnUserErrors("inventorySetQuantities", payload.userErrors);

  if (!payload.inventoryAdjustmentGroup) {
    // Shopify renvoie un groupe null SANS userErrors dans deux cas : quantité déjà égale (rien à écrire)
    // OU article non stocké à l'emplacement (rien n'est écrit ; constaté sur la boutique de dev le 09/10/2026,
    // là où REST renvoyait une erreur). On relit le niveau pour distinguer : absent => même erreur que REST
    // (« not stocked ») afin que l'appelant active l'article puis réessaie ; présent mais différent => erreur.
    const levels = await listInventoryLevels(shop, { inventoryItemIds: inventoryItemId, locationIds: locationId });
    const level = levels[0];
    if (!level) {
      const err = new Error("inventorySetQuantities: article non stocké à cet emplacement (not stocked at location)");
      err.statusCode = 422;
      err.code = "ITEM_NOT_STOCKED_AT_LOCATION";
      err.response = { statusCode: 422, headers: {}, body: { errors: ["Inventory item not stocked at location"] } };
      throw err;
    }
    if (level.available !== null && Number(level.available) !== quantity) {
      const err = new Error(
        `inventorySetQuantities: quantité non appliquée (Shopify ${level.available}, attendu ${quantity})`
      );
      err.statusCode = 409;
      err.code = "QUANTITY_NOT_APPLIED";
      err.response = { statusCode: 409, headers: {}, body: { errors: [err.message] } };
      throw err;
    }
  }
  return { available: quantity };
}

/**
 * Équivalent de client.inventoryLevel.connect({ location_id, inventory_item_id }) :
 * active l'article à l'emplacement (niveau créé à 0). Lève une erreur si userErrors non vide.
 */
async function activateInventoryItem(shop, { inventoryItemId, locationId }) {
  const ids = {
    inventoryItemId: toGid("InventoryItem", inventoryItemId),
    locationId: toGid("Location", locationId),
  };
  const modern = apiVersionAtLeast(MODERN_INVENTORY_API);
  const data = await graphqlRequest(
    shop,
    modern ? ACTIVATE_MUTATION : ACTIVATE_MUTATION_LEGACY,
    modern ? { ...ids, idempotencyKey: crypto.randomUUID() } : ids
  );
  const payload = data?.inventoryActivate;
  if (!payload) throw new Error("inventoryActivate: réponse Shopify vide");
  throwOnUserErrors("inventoryActivate", payload.userErrors);
  return { inventory_item_id: gidToId(ids.inventoryItemId), location_id: gidToId(ids.locationId) };
}

// ---------- Commandes ----------

const ORDER_LINE_FIELDS = `
  id
  title
  name
  sku
  quantity
  originalUnitPriceSet { shopMoney { amount } }
  product { id }
  variant { id }
`;

// Champs client = "protected customer data" : refusés (ACCESS_DENIED) tant que l'app n'est pas approuvée.
// Ils sont isolés pour pouvoir relancer la requête sans eux (voir listOrders).
const ORDER_CUSTOMER_FIELDS = "email customer { firstName lastName defaultEmailAddress { emailAddress } }";

function buildOrdersQuery(withCustomer) {
  return `
    query ListOrders($first: Int!, $after: String, $query: String) {
      shop { ianaTimezone }
      orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          createdAt
          processedAt
          displayFinancialStatus
          currencyCode
          subtotalPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalPriceSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          ${withCustomer ? ORDER_CUSTOMER_FIELDS : ""}
          lineItems(first: ${ORDER_LINES_PAGE_SIZE}) {
            nodes { ${ORDER_LINE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
}

const ORDER_LINES_MORE_QUERY = `
  query OrderLinesMore($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {
        nodes { ${ORDER_LINE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const VARIANT_WEIGHTS_QUERY = `
  query VariantWeights($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem { measurement { weight { value unit } } }
      }
    }
  }
`;

function isCustomerDataAccessError(e) {
  return (
    e?.code === "ACCESS_DENIED" ||
    Number(e?.statusCode) === 403 ||
    /protected customer data|not approved to access|access denied/i.test(String(e?.message || ""))
  );
}

/** "2026-09-30T10:00:00Z" -> "2026-09-30T12:00:00+02:00" (format REST : heure locale de la boutique). */
function toShopLocalIso(iso, timeZone) {
  const d = new Date(iso);
  if (!iso || !timeZone || Number.isNaN(d.getTime())) return iso || null;
  try {
    const parts = {};
    for (const p of new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(d)) {
      parts[p.type] = p.value;
    }
    const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offsetMin = Math.round((localAsUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
    const abs = Math.abs(offsetMin);
    const sign = offsetMin < 0 ? "-" : "+";
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
  } catch {
    return iso;
  }
}

/** Poids unitaire (g) de chaque variante : Map<variantGid, grams> (équivalent du champ REST line_items[].grams). */
async function fetchVariantGrams(shop, variantGids) {
  const gramsByVariant = new Map();
  const ids = [...new Set(variantGids.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    if (i > 0) await paceGraphql(shop);
    const data = await graphqlRequest(shop, VARIANT_WEIGHTS_QUERY, { ids: ids.slice(i, i + 100) });
    for (const node of data?.nodes || []) {
      if (node?.id) gramsByVariant.set(node.id, weightToRest(node.inventoryItem?.measurement?.weight).grams);
    }
  }
  return gramsByVariant;
}

/**
 * Équivalent de client.order.list({ status: "any", created_at_min, limit }) mais paginé (défaut ORDERS_MAX).
 * Champs REST mappés (ceux lus par salesOrderStore.importFromShopify) : id, created_at, processed_at,
 * financial_status, currency, subtotal_price, total_discounts, total_tax, total_price,
 * total_shipping_price_set.shop_money.amount, email, customer{first_name,last_name,email},
 * line_items[]{ id, title, name, sku, quantity, price, product_id, variant_id, grams }.
 *
 * Données client (email, customer) = "protected customer data" : si Shopify les refuse (ACCESS_DENIED),
 * la requête est relancée SANS ces champs et le résultat porte `customerDataAvailable === false`
 * (propriété non énumérable) ; le reste de l'import fonctionne.
 */
async function listOrders(shop, opts = {}) {
  const max = Math.min(Math.max(Number(opts.limit) || 250, 1), ORDERS_MAX);
  const createdAtMin = opts.createdAtMin ? new Date(opts.createdAtMin) : null;
  const query =
    createdAtMin && !Number.isNaN(createdAtMin.getTime()) ? `created_at:>='${createdAtMin.toISOString()}'` : null;

  let withCustomer = opts.customerData !== false;
  let timeZone = null;

  const nodes = await collectConnection(shop, max, async (after, remaining) => {
    const vars = { first: Math.min(ORDERS_PAGE_SIZE, remaining), after, query };
    let data;
    try {
      data = await graphqlRequest(shop, buildOrdersQuery(withCustomer), vars);
    } catch (e) {
      if (!withCustomer || !isCustomerDataAccessError(e)) throw e;
      withCustomer = false;
      data = await graphqlRequest(shop, buildOrdersQuery(false), vars);
    }
    timeZone = timeZone || data?.shop?.ianaTimezone || null;
    return data?.orders;
  });

  // Lignes au-delà de la première page (commande de plus de ORDER_LINES_PAGE_SIZE lignes)
  for (const o of nodes) {
    const pageInfo = o?.lineItems?.pageInfo;
    let after = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    for (let i = 0; after && i < 20; i++) {
      await paceGraphql(shop);
      const data = await graphqlRequest(shop, ORDER_LINES_MORE_QUERY, { id: o.id, first: 50, after });
      const conn = data?.order?.lineItems;
      o.lineItems.nodes.push(...(conn?.nodes || []));
      after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    }
  }

  const gramsByVariant = await fetchVariantGrams(
    shop,
    nodes.flatMap((o) => (o?.lineItems?.nodes || []).map((li) => li?.variant?.id))
  );

  const money = (set) => set?.shopMoney?.amount ?? null;
  const orders = nodes.map((o) => ({
    id: gidToId(o.id),
    created_at: toShopLocalIso(o.createdAt, timeZone),
    processed_at: toShopLocalIso(o.processedAt, timeZone),
    financial_status: o.displayFinancialStatus ? String(o.displayFinancialStatus).toLowerCase() : null,
    currency: o.currencyCode ?? null,
    subtotal_price: money(o.subtotalPriceSet),
    total_discounts: money(o.totalDiscountsSet),
    total_tax: money(o.totalTaxSet),
    total_price: money(o.totalPriceSet),
    total_shipping_price_set: { shop_money: { amount: money(o.totalShippingPriceSet) } },
    email: o.email ?? null,
    customer: o.customer
      ? {
          first_name: o.customer.firstName ?? null,
          last_name: o.customer.lastName ?? null,
          email: o.customer.defaultEmailAddress?.emailAddress ?? null,
        }
      : null,
    line_items: (o.lineItems?.nodes || []).map((li) => ({
      id: gidToId(li.id),
      title: li.title ?? null,
      name: li.name ?? null,
      sku: li.sku ?? null,
      quantity: Number(li.quantity) || 0,
      price: money(li.originalUnitPriceSet),
      product_id: gidToId(li.product?.id),
      variant_id: gidToId(li.variant?.id),
      grams: gramsByVariant.get(li.variant?.id) || 0,
    })),
  }));

  Object.defineProperty(orders, "customerDataAvailable", { value: withCustomer, enumerable: false });
  return orders;
}

module.exports = {
  getShopifyClient,
  searchProducts,
  fetchProduct,
  normalizeShopDomain,
  testShopifyConnection,

  getShopInfo,
  listLocations,
  listProducts,
  getProduct,
  getVariant,
  listInventoryLevels,
  setInventoryAvailable,
  activateInventoryItem,
  listOrders,

  graphqlRequest,
  getActiveAppSubscriptions,
  createAppSubscription,
  cancelAppSubscription,
};

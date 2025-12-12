// ============================================
// GESTIONNAIRE DE STOCK CBD POUR SHOPIFY
// ============================================

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const { getShopifyClient } = require('./shopifyClient');
const {
  PRODUCT_CONFIG,
  applyOrderToProduct,
  getStockSnapshot,
  restockProduct,
} = require('./stockManager');

const app = express();

// ============================================
// MIDDLEWARE : Servir les fichiers statiques
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// MIDDLEWARE : CORS
// ============================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================
// MIDDLEWARE : CSP pour Shopify Admin
// ============================================
app.use((req, res, next) => {
  const shopDomain = process.env.SHOP_NAME
    ? `https://${process.env.SHOP_NAME}.myshopify.com`
    : '*';
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors https://admin.shopify.com ${shopDomain};`
  );
  next();
});

// ============================================
// CONFIG SHOPIFY
// ============================================
const shopify = getShopifyClient();

// ============================================
// FONCTION : Vérification HMAC Shopify
// ============================================
function verifyShopifyWebhook(data, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('⚠️ SHOPIFY_WEBHOOK_SECRET non défini - Mode DEV');
    return true;
  }
  const hash = crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}

// ============================================
// FONCTION : Mise à jour du stock
// ============================================
async function updateProductStock(productId, gramsToSubtract) {
  const update = applyOrderToProduct(productId, gramsToSubtract);
  if (!update) {
    console.log(`Produit ${productId} non configuré`);
    return;
  }

  console.log(`${update.name} (${productId}) : ${update.totalGrams}g restants`);

  for (const [label, variantCfg] of Object.entries(update.variants)) {
    const unitsAvailable = variantCfg.canSell;
    try {
      await shopify.inventoryLevel.set({
        location_id: process.env.LOCATION_ID,
        inventory_item_id: variantCfg.inventoryItemId,
        available: unitsAvailable,
      });
      console.log(`  ${label} → ${unitsAvailable} unité(s) dispo`);
    } catch (error) {
      console.error(`  Erreur MAJ stock ${label}:`, error.message);
    }
  }

  return update.totalGrams;
}

// ============================================
// WEBHOOK : Commande créée
// ============================================
app.post('/webhooks/orders/create', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const skipHmac = process.env.SKIP_HMAC_VALIDATION === 'true';
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  console.log('\n=== Webhook reçu ===');
  console.log('Mode:', isProduction ? 'PRODUCTION' : 'DÉVELOPPEMENT');

  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));

  req.on('end', async () => {
    try {
      if (chunks.length === 0) {
        console.log('⚠ Aucune donnée reçue');
        return res.sendStatus(400);
      }

      const rawBody = Buffer.concat(chunks);

      // Vérification HMAC en production
      if (isProduction && process.env.SHOPIFY_WEBHOOK_SECRET && !skipHmac) {
        if (!hmacHeader) {
          console.log('❌ HMAC manquant');
          return res.sendStatus(401);
        }
        const isValid = verifyShopifyWebhook(rawBody, hmacHeader);
        if (!isValid) {
          console.log('❌ HMAC invalide');
          return res.sendStatus(401);
        }
        console.log('✅ HMAC valide');
      }

      let order;
      try {
        order = JSON.parse(rawBody.toString('utf8'));
      } catch (e) {
        console.log('⚠ Erreur parsing JSON');
        return res.sendStatus(400);
      }

      if (!order.id || !order.line_items) {
        console.log('⚠ Webhook invalide');
        return res.sendStatus(200);
      }

      console.log(`Commande: ${order.name || 'Sans nom'} (ID: ${order.id})`);

      for (const item of order.line_items) {
        if (!item.product_id) continue;

        const productId = item.product_id.toString();
        const variantTitle = item.variant_title || '';
        const quantity = item.quantity || 0;

        if (!PRODUCT_CONFIG[productId] || !variantTitle) continue;

        const gramsMatch = variantTitle.match(/([\d.,]+)/);
        if (!gramsMatch) continue;

        const gramsPerUnit = parseFloat(gramsMatch[1].replace(',', '.'));
        const totalGrams = gramsPerUnit * quantity;

        console.log(`  ${item.title} - ${variantTitle} x${quantity} = ${totalGrams}g`);
        await updateProductStock(productId, totalGrams);
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Erreur webhook:', err);
      if (!res.headersSent) res.sendStatus(500);
    }
  });

  req.on('error', (err) => {
    console.error('Erreur flux webhook:', err);
    if (!res.headersSent) res.sendStatus(500);
  });
});

// ============================================
// API : Informations serveur
// ============================================
app.get('/api/server-info', (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3000,
    hmacEnabled: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    productCount: Object.keys(PRODUCT_CONFIG).length,
  });
});

// ============================================
// API : Stock actuel
// ============================================
app.get('/api/stock', (req, res) => {
  const stock = getStockSnapshot();
  res.json(stock);
});

// ============================================
// API : Réapprovisionner
// ============================================
app.post('/api/restock', express.json(), async (req, res) => {
  try {
    const { productId, grams } = req.body;
    const g = Number(grams);

    if (!g || g <= 0) {
      return res.status(400).json({ error: 'Quantité invalide' });
    }

    const updated = restockProduct(productId, g);
    if (!updated) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }

    console.log(`Réassort ${updated.name}: +${g}g → ${updated.totalGrams}g`);
    await updateProductStock(productId, 0);

    res.json({
      success: true,
      productId,
      newTotal: updated.totalGrams,
    });
  } catch (error) {
    console.error('Erreur /api/restock:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// API : Définir le stock total manuellement
// ============================================
app.post('/api/set-total-stock', express.json(), async (req, res) => {
  try {
    const { productId, totalGrams } = req.body;
    const newTotal = Number(totalGrams);

    if (isNaN(newTotal) || newTotal < 0) {
      return res.status(400).json({ error: 'Quantité invalide' });
    }

    // Récupérer le produit
    const product = PRODUCT_CONFIG[productId];
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }

    // Calculer la différence
    const currentTotal = product.totalGrams || 0;
    const difference = newTotal - currentTotal;

    // Utiliser restockProduct qui peut gérer des valeurs négatives
    const updated = restockProduct(productId, difference);
    
    console.log(`Stock manuel ${updated.name}: ${currentTotal}g → ${newTotal}g (${difference > 0 ? '+' : ''}${difference}g)`);
    
    // Mettre à jour sur Shopify
    await updateProductStock(productId, 0);

    res.json({
      success: true,
      productId,
      previousTotal: currentTotal,
      newTotal: updated.totalGrams,
      difference: difference,
    });
  } catch (error) {
    console.error('Erreur /api/set-total-stock:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// API : Test de commande
// ============================================
app.post('/api/test-order', express.json(), async (req, res) => {
  try {
    console.log('\n=== Test de commande manuelle ===');

    const testOrder = {
      id: Date.now(),
      name: '#TEST-' + Date.now(),
      line_items: [
        {
          product_id: 10349843513687,
          variant_title: '3',
          quantity: 2,
          title: '3x Filtré',
        },
      ],
    };

    console.log('Commande test:', testOrder.name);

    for (const item of testOrder.line_items) {
      const productId = item.product_id.toString();
      const variantTitle = item.variant_title || '';
      const quantity = item.quantity;

      const gramsMatch = variantTitle.match(/([\d.,]+)/);
      if (!gramsMatch) continue;

      const gramsPerUnit = parseFloat(gramsMatch[1].replace(',', '.'));
      const totalGrams = gramsPerUnit * quantity;

      console.log(`  ${item.title} - ${variantTitle} x${quantity} = ${totalGrams}g`);
      await updateProductStock(productId, totalGrams);
    }

    res.json({
      success: true,
      message: 'Commande test traitée',
      order: testOrder,
    });
  } catch (error) {
    console.error('Erreur test order:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ROUTE : Page d'accueil (sert index.html)
// ============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nServeur démarré sur le port ${PORT}`);
  console.log(`Gestion de ${Object.keys(PRODUCT_CONFIG).length} produits CBD`);
  console.log(`Interface: http://localhost:${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhooks/orders/create\n`);
});
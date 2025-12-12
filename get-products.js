// get-products.js
require('dotenv').config();
const https = require('https');

const shop = process.env.SHOP_NAME;              // cloud-store-cbd
const token = process.env.SHOPIFY_ADMIN_TOKEN;   // shpat_...

// Petit debug pour vérifier qu'on lit bien .env
console.log('SHOP_NAME =', shop);
console.log('ADMIN TOKEN =', token ? token.slice(0, 15) + '...' : 'undefined');

if (!shop || !token) {
  console.error('Erreur : SHOP_NAME ou SHOPIFY_ADMIN_TOKEN manquant dans .env');
  process.exit(1);
}

// Utilise la même version que ton app : 2025-10
const options = {
  hostname: `${shop}.myshopify.com`,
  path: '/admin/api/2025-10/products.json?limit=250',
  method: 'GET',
  headers: {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  },
};

console.log('\nURL appelée :', `https://${options.hostname}${options.path}`);
console.log('Headers envoyés :', options.headers, '\n');

console.log('Récupération de vos produits...\n');

const req = https.request(options, (res) => {
  let data = '';

  console.log('Status:', res.statusCode, res.statusMessage);

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);

      if (!response.products) {
        console.error('Erreur Shopify :', response);
        return;
      }

      console.log(`Produits trouvés : ${response.products.length}\n`);

      response.products.forEach((product) => {
        console.log('-----------------------------');
        console.log('Titre :', product.title);
        console.log('ID produit :', product.id);
        console.log('Variantes :');
        product.variants.forEach((variant) => {
          console.log(
            `  - ${variant.title} (ID variante: ${variant.id}, Inventory item: ${variant.inventory_item_id})`
          );
        });
      });
    } catch (e) {
      console.error('Erreur de parsing JSON :', e.message);
      console.log('Réponse brute :', data);
    }
  });
});

req.on('error', (err) => {
  console.error('Erreur réseau :', err.message);
});

req.end();

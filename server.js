// server.js - VERSION SIMPLIFIÉE ET FONCTIONNELLE
const express = require('express');
const stockState = require('./stockState');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// IMPORTANT: Initialiser le stockage au démarrage
stockState.initialize();

// ==========================================
// ROUTES API
// ==========================================

// Page d'accueil
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Status de l'app
app.get('/api/status', (req, res) => {
  const products = stockState.getProducts();
  const types = stockState.getTypes();
  const movements = stockState.getMovements();
  
  res.json({
    status: 'ok',
    stats: {
      products: products.length,
      types: types.length,
      movements: movements.length,
      lastSync: stockState.getLastSync()
    },
    message: 'Stock CBD Manager fonctionne! 🌿'
  });
});

// Récupérer tous les produits
app.get('/api/products', (req, res) => {
  try {
    const products = stockState.getProducts();
    res.json({ 
      success: true, 
      count: products.length,
      products 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Récupérer un produit par ID
app.get('/api/products/:id', (req, res) => {
  try {
    const product = stockState.getProductById(parseInt(req.params.id));
    if (product) {
      res.json({ success: true, product });
    } else {
      res.status(404).json({ success: false, error: 'Produit non trouvé' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Synchroniser avec Shopify
app.post('/api/sync', async (req, res) => {
  try {
    // Importer shopifyClient seulement si besoin
    const shopifyClient = require('./shopifyClient');
    
    console.log('🔄 Synchronisation Shopify...');
    const products = await shopifyClient.getAllProducts();
    
    // Sauvegarder dans l'état
    stockState.setProducts(products);
    stockState.setLastSync(new Date());
    
    res.json({ 
      success: true, 
      message: `${products.length} produits synchronisés`,
      products 
    });
  } catch (error) {
    console.error('❌ Erreur sync:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Récupérer les types de produits
app.get('/api/types', (req, res) => {
  try {
    const types = stockState.getTypes();
    res.json({ 
      success: true, 
      count: types.length,
      types 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Ajouter un type de produit
app.post('/api/types', (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Le nom est requis' 
      });
    }
    
    const newType = stockState.addType({ name, description });
    res.json({ 
      success: true, 
      message: 'Type ajouté',
      type: newType 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Mettre à jour un type
app.put('/api/types/:id', (req, res) => {
  try {
    const updatedType = stockState.updateType(req.params.id, req.body);
    
    if (updatedType) {
      res.json({ 
        success: true, 
        message: 'Type mis à jour',
        type: updatedType 
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Type non trouvé' 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Récupérer les mouvements
app.get('/api/movements', (req, res) => {
  try {
    const movements = stockState.getMovements();
    res.json({ 
      success: true, 
      count: movements.length,
      movements 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Ajouter un mouvement
app.post('/api/movements', (req, res) => {
  try {
    const movement = stockState.addMovement(req.body);
    res.json({ 
      success: true, 
      message: 'Mouvement ajouté',
      movement 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==========================================
// GESTION DES ERREURS
// ==========================================

// 404
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route non trouvée',
    availableRoutes: [
      'GET  /api/status',
      'GET  /api/products',
      'POST /api/sync',
      'GET  /api/types',
      'POST /api/types',
      'GET  /api/movements'
    ]
  });
});

// Erreurs globales
app.use((err, req, res, next) => {
  console.error('❌ Erreur serveur:', err);
  res.status(500).json({ 
    error: 'Erreur serveur interne',
    message: err.message 
  });
});

// ==========================================
// DÉMARRAGE
// ==========================================

app.listen(PORT, () => {
  console.log('');
  console.log('════════════════════════════════════════');
  console.log('✅ Stock CBD Manager démarré');
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/api/status`);
  console.log(`📦 Types: http://localhost:${PORT}/api/types`);
  console.log('════════════════════════════════════════');
  console.log('');
  
  // Afficher un résumé au démarrage
  const products = stockState.getProducts();
  const types = stockState.getTypes();
  console.log(`📦 ${products.length} produits en mémoire`);
  console.log(`🏷️  ${types.length} types configurés:`);
  types.forEach(t => console.log(`   - ${t.name}`));
  console.log('');
});
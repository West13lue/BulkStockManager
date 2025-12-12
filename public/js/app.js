// ============================================
// VARIABLES GLOBALES
// ============================================
const result = document.getElementById('result');
let stockData = {};
let serverInfo = {};
let currentProductId = null;

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('fr-FR');
  result.textContent = `[${timestamp}] ${message}`;
  result.className = 'result-content ' + type;
  result.scrollTop = result.scrollHeight;
}

// ============================================
// RÉCUPÉRATION DES INFOS SERVEUR
// ============================================
async function getServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    serverInfo = await res.json();
    updateServerInfo(serverInfo);
  } catch (err) {
    console.error('Erreur récupération infos serveur:', err);
  }
}

function updateServerInfo(info) {
  const statusBadge = document.getElementById('statusBadge');
  const isProduction = info.mode === 'production';
  
  statusBadge.className = 'status-badge ' + (isProduction ? 'online' : 'dev');
  statusBadge.textContent = isProduction ? '🔴 Production' : '🟡 Développement';

  document.getElementById('webhookStatus').textContent = '✅';
  document.getElementById('webhookLabel').textContent = `Actif sur port ${info.port}`;

  document.getElementById('hmacStatus').textContent = info.hmacEnabled ? '🔒' : '⚠️';
  document.getElementById('hmacLabel').textContent = info.hmacEnabled ? 'Activée' : 'Désactivée (DEV)';
}

// ============================================
// GESTION DU STOCK
// ============================================
async function refreshStock() {
  log('⏳ Actualisation du stock...', 'info');
  try {
    const res = await fetch('/api/stock');
    stockData = await res.json();
    
    displayProducts(stockData);
    updateStats(stockData);
    
    log('✅ STOCK ACTUALISÉ\n\n' + JSON.stringify(stockData, null, 2), 'success');
  } catch (err) {
    log('❌ ERREUR: ' + err.message, 'error');
  }
}

function displayProducts(stock) {
  const productList = document.getElementById('productList');
  const products = Object.entries(stock);
  
  if (products.length === 0) {
    productList.innerHTML = '<div style="text-align: center; padding: 40px; color: #a0aec0;">Aucun produit configuré</div>';
    return;
  }

  productList.innerHTML = products.map(([id, product]) => {
    const maxGrams = 1000; // Ajustable selon vos besoins
    const percentage = Math.min((product.totalGrams / maxGrams) * 100, 100);
    
    return `
      <div class="product-item" onclick="openProductModal('${id}')">
        <div class="product-header">
          <span class="product-name">${product.name}</span>
          <span class="product-stock">${product.totalGrams}g</span>
        </div>
        <div class="stock-bar">
          <div class="stock-bar-fill" style="width: ${percentage}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function updateStats(stock) {
  const totalGrams = Object.values(stock).reduce((sum, p) => sum + p.totalGrams, 0);
  const productCount = Object.keys(stock).length;
  
  document.getElementById('totalStock').textContent = totalGrams + 'g';
  document.getElementById('productCount').textContent = productCount;
}

// ============================================
// TEST DE COMMANDE
// ============================================
async function testOrder() {
  log('⏳ Traitement de la commande test en cours...', 'info');
  try {
    const res = await fetch('/api/test-order', { method: 'POST' });
    const data = await res.json();
    log('✅ COMMANDE TEST TRAITÉE AVEC SUCCÈS\n\n' + JSON.stringify(data, null, 2), 'success');
    await refreshStock();
  } catch (err) {
    log('❌ ERREUR: ' + err.message, 'error');
  }
}

// ============================================
// RÉAPPROVISIONNEMENT
// ============================================
function openRestockModal() {
  const modal = document.getElementById('restockModal');
  const select = document.getElementById('productSelect');
  
  select.innerHTML = '<option value="">Sélectionnez un produit...</option>' +
    Object.entries(stockData).map(([id, product]) => 
      `<option value="${id}">${product.name} (Stock actuel: ${product.totalGrams}g)</option>`
    ).join('');
  
  modal.classList.add('active');
}

function closeRestockModal() {
  document.getElementById('restockModal').classList.remove('active');
  document.getElementById('restockForm').reset();
}

async function submitRestock(event) {
  event.preventDefault();
  
  const productId = document.getElementById('productSelect').value;
  const grams = document.getElementById('gramsInput').value;
  
  closeRestockModal();
  log(`⏳ Réapprovisionnement de ${grams}g en cours...`, 'info');
  
  try {
    const res = await fetch('/api/restock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, grams: Number(grams) })
    });
    const data = await res.json();
    log(`♻️ RÉAPPROVISIONNEMENT RÉUSSI\n\n${JSON.stringify(data, null, 2)}`, 'success');
    await refreshStock();
  } catch (err) {
    log('❌ ERREUR: ' + err.message, 'error');
  }
}

// ============================================
// EVENT LISTENERS
// ============================================
document.getElementById('restockModal').addEventListener('click', (e) => {
  if (e.target.id === 'restockModal') {
    closeRestockModal();
  }
});

document.getElementById('productModal').addEventListener('click', (e) => {
  if (e.target.id === 'productModal') {
    closeProductModal();
  }
});

// ============================================
// GESTION DU MODAL PRODUIT
// ============================================
function openProductModal(productId) {
  currentProductId = productId;
  const product = stockData[productId];
  
  if (!product) {
    log('❌ Produit introuvable', 'error');
    return;
  }

  // Mettre à jour le titre
  document.getElementById('productModalTitle').textContent = `📦 ${product.name}`;
  
  // Mettre à jour le stock total
  document.getElementById('totalGramsInput').value = product.totalGrams;
  
  // Afficher les variantes
  displayVariants(product.variants);
  
  // Ouvrir le modal
  document.getElementById('productModal').classList.add('active');
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('active');
  currentProductId = null;
}

function displayVariants(variants) {
  const variantsList = document.getElementById('variantsList');
  
  const variantsArray = Object.entries(variants);
  
  if (variantsArray.length === 0) {
    variantsList.innerHTML = '<div style="text-align: center; padding: 20px; color: #a0aec0;">Aucune variante configurée</div>';
    return;
  }

  variantsList.innerHTML = variantsArray.map(([label, variant]) => {
    let stockClass = 'high';
    if (variant.canSell === 0) stockClass = 'low';
    else if (variant.canSell < 5) stockClass = 'medium';
    
    return `
      <div class="variant-item">
        <div class="variant-info">
          <div class="variant-name">${label}</div>
          <div class="variant-details">
            ${variant.gramsPerUnit}g par unité
          </div>
        </div>
        <div class="variant-stock ${stockClass}">
          ${variant.canSell} unité${variant.canSell > 1 ? 's' : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function updateTotalStock() {
  const newTotal = parseFloat(document.getElementById('totalGramsInput').value);
  
  if (isNaN(newTotal) || newTotal < 0) {
    log('❌ Quantité invalide', 'error');
    return;
  }

  log(`⏳ Mise à jour du stock total à ${newTotal}g...`, 'info');
  
  try {
    const res = await fetch('/api/set-total-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        productId: currentProductId, 
        totalGrams: newTotal 
      })
    });
    
    if (!res.ok) {
      throw new Error('Erreur lors de la mise à jour');
    }
    
    const data = await res.json();
    log(`✅ STOCK MIS À JOUR\n\n${JSON.stringify(data, null, 2)}`, 'success');
    
    await refreshStock();
    closeProductModal();
  } catch (err) {
    log('❌ ERREUR: ' + err.message, 'error');
  }
}

// ============================================
// INITIALISATION
// ============================================
window.addEventListener('load', async () => {
  await getServerInfo();
  await refreshStock();
});
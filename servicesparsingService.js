// services/parsingService.js

/**
 * Parse le nombre de grammes depuis le titre d'une variante
 * Supporte: "1.5", "3g", "10 grammes", "1,5", "1/2"
 */
function parseGramsFromVariantTitle(variantTitle = "") {
  if (!variantTitle) return null;

  const str = String(variantTitle).toLowerCase().trim();

  // Format: "1.5", "3", "10g", "25 grammes"
  let match = str.match(/([\d.,]+)\s*(g|grammes?|gr)?/i);
  if (match) {
    const num = parseFloat(match[1].replace(',', '.'));
    if (!isNaN(num) && num > 0) return num;
  }

  // Format: "1/2" (demi)
  match = str.match(/(\d+)\/(\d+)/);
  if (match) {
    const num = parseFloat(match[1]) / parseFloat(match[2]);
    if (!isNaN(num) && num > 0) return num;
  }

  return null;
}

/**
 * Escape HTML pour éviter XSS
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Sanitize string pour logs (éviter injection)
 */
function sanitizeForLog(str) {
  return String(str ?? '')
    .replace(/[\n\r\t]/g, ' ')
    .slice(0, 200);
}

module.exports = {
  parseGramsFromVariantTitle,
  escapeHtml,
  sanitizeForLog,
};
// middleware/rateLimit.js
const rateLimit = require('express-rate-limit');

// Rate limiter pour les API générales
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Trop de requêtes, réessayez plus tard' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter strict pour les webhooks
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Max 60 webhooks/minute
  message: { error: 'Trop de webhooks' },
  skipSuccessfulRequests: false,
});

// Rate limiter pour import Shopify
const importLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10,
  message: { error: 'Limite d\'import atteinte, attendez 5 minutes' },
});

module.exports = {
  apiLimiter,
  webhookLimiter,
  importLimiter,
};
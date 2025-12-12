// middleware/validation.js
const { body, param, query, validationResult } = require('express-validator');

// Middleware pour vérifier les erreurs de validation
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation échouée', 
      details: errors.array() 
    });
  }
  next();
};

// Validations pour le restock
const restockValidation = [
  body('productId')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('productId requis'),
  body('grams')
    .isFloat({ min: 0.1, max: 10000 })
    .withMessage('Quantité invalide (0.1-10000g)'),
  handleValidationErrors,
];

// Validations pour set total stock
const setTotalStockValidation = [
  body('productId')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('productId requis'),
  body('totalGrams')
    .isFloat({ min: 0, max: 100000 })
    .withMessage('Stock total invalide (0-100000g)'),
  handleValidationErrors,
];

// Validations pour catégories
const categoryCreateValidation = [
  body('name')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Nom de catégorie invalide (1-100 caractères)'),
  handleValidationErrors,
];

const categoryUpdateValidation = [
  param('id')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('ID catégorie requis'),
  body('name')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Nom de catégorie invalide (1-100 caractères)'),
  handleValidationErrors,
];

// Validation pour import produit
const importProductValidation = [
  body('productId')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('productId requis'),
  body('totalGrams')
    .optional()
    .isFloat({ min: 0, max: 100000 })
    .withMessage('Stock total invalide'),
  body('categoryIds')
    .optional()
    .isArray()
    .withMessage('categoryIds doit être un tableau'),
  handleValidationErrors,
];

// Validation pour assigner catégories
const assignCategoriesValidation = [
  param('productId')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('productId requis'),
  body('categoryIds')
    .isArray()
    .withMessage('categoryIds doit être un tableau'),
  handleValidationErrors,
];

// Validation pour requêtes de recherche
const searchValidation = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 250 })
    .withMessage('Limite invalide (1-250)'),
  handleValidationErrors,
];

module.exports = {
  restockValidation,
  setTotalStockValidation,
  categoryCreateValidation,
  categoryUpdateValidation,
  importProductValidation,
  assignCategoriesValidation,
  searchValidation,
};
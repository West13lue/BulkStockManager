// utils/logger.js
const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "stock-cbd-manager" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

function sanitizeLogData(data) {
  if (typeof data !== "object" || data === null) {
    return String(data).replace(/[\n\r]/g, " ").slice(0, 1000);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") sanitized[key] = value.replace(/[\n\r]/g, " ").slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean") sanitized[key] = value;
    else if (Array.isArray(value)) sanitized[key] = value.slice(0, 10);
    else sanitized[key] = "[Object]";
  }
  return sanitized;
}

function logEvent(event, data = {}, level = "info") {
  logger.log(level, event, sanitizeLogData(data));
}

module.exports = { logger, logEvent };
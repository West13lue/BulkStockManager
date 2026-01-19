// notificationDispatcher.js - Dispatcher de notifications externes
// Supporte: Discord, Slack, Telegram, Ntfy.sh

const https = require("https");
const http = require("http");
const settingsStore = require("./settingsStore");

// Logger compatible
let logEvent = (event, data = {}, level = "info") =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
try {
  ({ logEvent } = require("./utils/logger"));
} catch {
  try {
    ({ logEvent } = require("./logger"));
  } catch {}
}

// =====================================================
// CONFIGURATION DES CANAUX
// =====================================================

const CHANNEL_CONFIG = {
  discord: {
    name: "Discord",
    icon: "💬",
    validateConfig: (config) => {
      if (!config.webhookUrl) return { valid: false, error: "Webhook URL required" };
      if (!config.webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
        return { valid: false, error: "Invalid Discord webhook URL" };
      }
      return { valid: true };
    }
  },
  slack: {
    name: "Slack",
    icon: "📢",
    validateConfig: (config) => {
      if (!config.webhookUrl) return { valid: false, error: "Webhook URL required" };
      if (!config.webhookUrl.startsWith("https://hooks.slack.com/")) {
        return { valid: false, error: "Invalid Slack webhook URL" };
      }
      return { valid: true };
    }
  },
  telegram: {
    name: "Telegram",
    icon: "📱",
    validateConfig: (config) => {
      if (!config.botToken) return { valid: false, error: "Bot token required" };
      if (!config.chatId) return { valid: false, error: "Chat ID required" };
      return { valid: true };
    }
  },
  ntfy: {
    name: "Ntfy.sh",
    icon: "🔔",
    validateConfig: (config) => {
      if (!config.topic) return { valid: false, error: "Topic required" };
      if (!/^[a-zA-Z0-9_-]+$/.test(config.topic)) {
        return { valid: false, error: "Invalid topic format (alphanumeric, _, - only)" };
      }
      return { valid: true };
    }
  }
};

// =====================================================
// HELPERS HTTP
// =====================================================

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;
    
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "POST",
      headers: options.headers || {},
      timeout: 10000
    };
    
    const req = lib.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// =====================================================
// FORMATTERS PAR CANAL
// =====================================================

/**
 * Obtenir l'emoji de priorité
 */
function getPriorityEmoji(priority) {
  const emojis = {
    critical: "🚨",
    high: "⚠️",
    normal: "ℹ️",
    low: "📝"
  };
  return emojis[priority] || "📌";
}

/**
 * Obtenir la couleur pour Discord/Slack
 */
function getPriorityColor(priority) {
  const colors = {
    critical: 0xFF0000, // Rouge
    high: 0xFFA500,     // Orange
    normal: 0x3498DB,   // Bleu
    low: 0x95A5A6       // Gris
  };
  return colors[priority] || 0x3498DB;
}

/**
 * Formater pour Discord (Embed)
 */
function formatDiscordMessage(alert, shopName) {
  const emoji = getPriorityEmoji(alert.priority);
  const color = getPriorityColor(alert.priority);
  
  return {
    username: "Stock Manager",
    avatar_url: "https://cdn-icons-png.flaticon.com/512/4947/4947506.png",
    embeds: [{
      title: `${emoji} ${alert.title}`,
      description: alert.message,
      color: color,
      fields: [
        {
          name: "🏪 Shop",
          value: shopName || "Unknown",
          inline: true
        },
        {
          name: "📦 Product",
          value: alert.productName || "N/A",
          inline: true
        },
        {
          name: "⏰ Priority",
          value: alert.priority?.toUpperCase() || "NORMAL",
          inline: true
        }
      ],
      footer: {
        text: `Stock CBD Manager • ${alert.type}`
      },
      timestamp: new Date().toISOString()
    }]
  };
}

/**
 * Formater pour Slack (Block Kit)
 */
function formatSlackMessage(alert, shopName) {
  const emoji = getPriorityEmoji(alert.priority);
  
  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} ${alert.title}`,
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: alert.message
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `🏪 *Shop:* ${shopName || "Unknown"}`
          },
          {
            type: "mrkdwn",
            text: `📦 *Product:* ${alert.productName || "N/A"}`
          },
          {
            type: "mrkdwn",
            text: `⏰ *Priority:* ${alert.priority?.toUpperCase() || "NORMAL"}`
          }
        ]
      },
      {
        type: "divider"
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Stock CBD Manager • ${alert.type} • ${new Date().toLocaleString()}_`
          }
        ]
      }
    ]
  };
}

/**
 * Formater pour Telegram (HTML)
 */
function formatTelegramMessage(alert, shopName) {
  const emoji = getPriorityEmoji(alert.priority);
  
  return `${emoji} <b>${escapeHtml(alert.title)}</b>

${escapeHtml(alert.message)}

🏪 <b>Shop:</b> ${escapeHtml(shopName || "Unknown")}
📦 <b>Product:</b> ${escapeHtml(alert.productName || "N/A")}
⏰ <b>Priority:</b> ${alert.priority?.toUpperCase() || "NORMAL"}

<i>Stock CBD Manager • ${alert.type}</i>`;
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formater pour Ntfy (simple)
 */
function formatNtfyMessage(alert, shopName) {
  const emoji = getPriorityEmoji(alert.priority);
  
  return {
    title: `${emoji} ${alert.title}`,
    message: `${alert.message}\n\nShop: ${shopName || "Unknown"}\nProduct: ${alert.productName || "N/A"}`,
    priority: mapNtfyPriority(alert.priority),
    tags: [alert.type, alert.priority].filter(Boolean)
  };
}

function mapNtfyPriority(priority) {
  const map = {
    critical: 5, // Max
    high: 4,
    normal: 3,   // Default
    low: 2
  };
  return map[priority] || 3;
}

// =====================================================
// SENDERS PAR CANAL
// =====================================================

/**
 * Envoyer via Discord Webhook
 */
async function sendDiscord(config, alert, shopName) {
  const payload = formatDiscordMessage(alert, shopName);
  
  await makeRequest(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }, payload);
  
  return { success: true, channel: "discord" };
}

/**
 * Envoyer via Slack Webhook
 */
async function sendSlack(config, alert, shopName) {
  const payload = formatSlackMessage(alert, shopName);
  
  await makeRequest(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }, payload);
  
  return { success: true, channel: "slack" };
}

/**
 * Envoyer via Telegram Bot
 */
async function sendTelegram(config, alert, shopName) {
  const text = formatTelegramMessage(alert, shopName);
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  
  await makeRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }, {
    chat_id: config.chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
  
  return { success: true, channel: "telegram" };
}

/**
 * Envoyer via Ntfy.sh
 */
async function sendNtfy(config, alert, shopName) {
  const { title, message, priority, tags } = formatNtfyMessage(alert, shopName);
  const server = config.server || "https://ntfy.sh";
  const url = `${server}/${config.topic}`;
  
  await makeRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Title": title,
      "Priority": String(priority),
      "Tags": tags.join(",")
    }
  }, message);
  
  return { success: true, channel: "ntfy" };
}

// =====================================================
// DISPATCHER PRINCIPAL
// =====================================================

/**
 * Dispatcher une alerte vers tous les canaux actifs
 */
async function dispatch(shopId, alert) {
  if (!shopId || !alert) {
    return { success: false, error: "Missing shopId or alert" };
  }
  
  const settings = settingsStore.loadSettings(shopId);
  const channels = settings.notificationChannels || {};
  const shopName = settings.shopName || shopId;
  
  const results = {
    success: true,
    dispatched: [],
    errors: []
  };
  
  // Discord
  if (channels.discord?.enabled && channels.discord?.webhookUrl) {
    try {
      await sendDiscord(channels.discord, alert, shopName);
      results.dispatched.push("discord");
      logEvent("notification_sent", { shop: shopId, channel: "discord", alertType: alert.type });
    } catch (e) {
      results.errors.push({ channel: "discord", error: e.message });
      logEvent("notification_error", { shop: shopId, channel: "discord", error: e.message }, "error");
    }
  }
  
  // Slack
  if (channels.slack?.enabled && channels.slack?.webhookUrl) {
    try {
      await sendSlack(channels.slack, alert, shopName);
      results.dispatched.push("slack");
      logEvent("notification_sent", { shop: shopId, channel: "slack", alertType: alert.type });
    } catch (e) {
      results.errors.push({ channel: "slack", error: e.message });
      logEvent("notification_error", { shop: shopId, channel: "slack", error: e.message }, "error");
    }
  }
  
  // Telegram
  if (channels.telegram?.enabled && channels.telegram?.botToken && channels.telegram?.chatId) {
    try {
      await sendTelegram(channels.telegram, alert, shopName);
      results.dispatched.push("telegram");
      logEvent("notification_sent", { shop: shopId, channel: "telegram", alertType: alert.type });
    } catch (e) {
      results.errors.push({ channel: "telegram", error: e.message });
      logEvent("notification_error", { shop: shopId, channel: "telegram", error: e.message }, "error");
    }
  }
  
  // Ntfy
  if (channels.ntfy?.enabled && channels.ntfy?.topic) {
    try {
      await sendNtfy(channels.ntfy, alert, shopName);
      results.dispatched.push("ntfy");
      logEvent("notification_sent", { shop: shopId, channel: "ntfy", alertType: alert.type });
    } catch (e) {
      results.errors.push({ channel: "ntfy", error: e.message });
      logEvent("notification_error", { shop: shopId, channel: "ntfy", error: e.message }, "error");
    }
  }
  
  if (results.errors.length > 0 && results.dispatched.length === 0) {
    results.success = false;
  }
  
  return results;
}

/**
 * Tester un canal spécifique
 */
async function testChannel(shopId, channelName, config) {
  const shopName = shopId || "Test Shop";
  
  // Alerte de test
  const testAlert = {
    type: "test",
    priority: "normal",
    title: "🧪 Test Notification",
    message: "This is a test notification from Stock CBD Manager. If you see this, your configuration is working!",
    productName: "Test Product",
    data: {}
  };
  
  // Valider la configuration
  const channelConfig = CHANNEL_CONFIG[channelName];
  if (!channelConfig) {
    return { success: false, error: `Unknown channel: ${channelName}` };
  }
  
  const validation = channelConfig.validateConfig(config);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  
  // Envoyer le test
  try {
    switch (channelName) {
      case "discord":
        await sendDiscord(config, testAlert, shopName);
        break;
      case "slack":
        await sendSlack(config, testAlert, shopName);
        break;
      case "telegram":
        await sendTelegram(config, testAlert, shopName);
        break;
      case "ntfy":
        await sendNtfy(config, testAlert, shopName);
        break;
      default:
        return { success: false, error: "Channel not implemented" };
    }
    
    logEvent("notification_test_success", { shop: shopId, channel: channelName });
    return { success: true, channel: channelName, message: "Test notification sent!" };
    
  } catch (e) {
    logEvent("notification_test_error", { shop: shopId, channel: channelName, error: e.message }, "error");
    return { success: false, channel: channelName, error: e.message };
  }
}

/**
 * Obtenir la liste des canaux disponibles
 */
function getAvailableChannels() {
  return Object.entries(CHANNEL_CONFIG).map(([key, config]) => ({
    id: key,
    name: config.name,
    icon: config.icon
  }));
}

/**
 * Valider la configuration d'un canal
 */
function validateChannelConfig(channelName, config) {
  const channelConfig = CHANNEL_CONFIG[channelName];
  if (!channelConfig) {
    return { valid: false, error: `Unknown channel: ${channelName}` };
  }
  return channelConfig.validateConfig(config || {});
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  dispatch,
  testChannel,
  getAvailableChannels,
  validateChannelConfig,
  CHANNEL_CONFIG
};
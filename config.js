const fs = require('fs');
const path = require('path');
const pool = require('./db');

/**
 * Business Configuration Module
 *
 * Reads business config from PostgreSQL (bot_config table) so it survives
 * Railway redeploys. Falls back to business_config.json on first run (seed).
 *
 * Sync getters (getBusinessHours, etc.) remain unchanged — they read from the
 * in-memory `businessConfig` object, which init() populates from the DB.
 *
 * New async API:
 *   await configModule.init()      — call once at server startup
 *   await configModule.save(obj)   — full replace + persist
 *   await configModule.patch(obj)  — shallow-merge + persist
 *   configModule.get()             — synchronous read (after init)
 */

let businessConfig = null;
let botMessages = null; // Cache for bot messages

// ── DB helpers ──────────────────────────────────────────────────────────────

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_config (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      data       JSONB   NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * Load config from DB; seed from JSON on first deploy.
 * Updates the shared businessConfig object in-place so all sync getters
 * automatically reflect DB data without any other code changes.
 */
async function init() {
  try {
    await ensureTable();
    const result = await pool.query('SELECT data FROM bot_config WHERE id = 1');

    if (result.rows.length > 0) {
      // Mutate in-place so existing references stay valid
      Object.assign(businessConfig, result.rows[0].data);
      console.log('✅ Business config cargado desde DB');
    } else {
      // First deploy — seed the DB from the local JSON file
      await pool.query(
        `INSERT INTO bot_config (id, data, updated_at) VALUES (1, $1, NOW())`,
        [JSON.stringify(businessConfig)]
      );
      console.log('✅ Business config sembrado desde business_config.json → DB');
    }
  } catch (err) {
    console.error('⚠️  Error cargando config desde DB, usando archivo local:', err.message);
    // businessConfig was already loaded from JSON — keep using it as fallback
  }
}

/** Persist a full config object to DB and update in-memory cache. */
async function save(newConfig) {
  Object.assign(businessConfig, newConfig);
  await pool.query(
    `INSERT INTO bot_config (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
    [JSON.stringify(businessConfig)]
  );
}

/** Shallow-merge partial fields and persist. Returns updated config. */
async function patch(partial) {
  Object.assign(businessConfig, partial);
  await pool.query(
    `INSERT INTO bot_config (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
    [JSON.stringify(businessConfig)]
  );
  return businessConfig;
}

/** Synchronous read — valid after init() resolves. */
function get() {
  return businessConfig;
}

/**
 * Load business configuration from JSON file (initial load at module import)
 * @returns {Object} Business configuration object
 */
function loadBusinessConfig() {
  if (businessConfig) {
    return businessConfig;
  }

  try {
    const configPath = path.join(__dirname, 'business_config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    businessConfig = JSON.parse(configData);
    console.log('✅ Business config loaded from file');
    return businessConfig;
  } catch (error) {
    console.error('❌ Error loading business_config.json:', error.message);
    businessConfig = {};
    return businessConfig;
  }
}

// Load from JSON immediately so all sync getters work before init() is called
const config = loadBusinessConfig();

/**
 * Get business information
 */
function getBusinessInfo() {
  return config.negocio || {};
}

/**
 * Get business name
 */
function getBusinessName() {
  return getBusinessInfo().nombre || 'Nuestro negocio';
}

/**
 * Get business type
 */
function getBusinessType() {
  return getBusinessInfo().tipo || '';
}

/**
 * Get advisor name
 */
function getAdvisorName() {
  return getBusinessInfo().asesora_nombre || '';
}

/**
 * Get business address
 */
function getBusinessAddress() {
  return getBusinessInfo().direccion || '';
}

/**
 * Get business maps link
 */
function getBusinessMapsLink() {
  return getBusinessInfo().maps_link || '';
}

/**
 * Get business hours
 */
function getBusinessHours() {
  return config.horarios || {};
}

/**
 * Get catalog information
 */
function getCatalogInfo() {
  return config.catalogo || {};
}

/**
 * Get catalog link
 */
function getCatalogLink() {
  return getCatalogInfo().link || '';
}

/**
 * Get catalog name
 */
function getCatalogName() {
  return getCatalogInfo().nombre || 'Catálogo';
}

/**
 * Get pricing information
 */
function getPricingInfo() {
  return config.precios || {};
}

/**
 * Get base price
 */
function getBasePrice() {
  return getPricingInfo().precio_base || 0;
}

/**
 * Get payment information
 */
function getPaymentInfo() {
  return config.pagos || {};
}

/**
 * Get FAQs
 */
function getFAQs() {
  return config.faqs || [];
}

function getHolidays() {
  return config.asuetos || [];
}

/**
 * Get conversation flow configuration
 */
function getConversationFlow() {
  return config.flujo_conversacion || {};
}

/**
 * Get response templates
 */
function getResponseTemplates() {
  return config.plantillas_respuesta || {};
}

/**
 * Get a specific response template with variable substitution
 * @param {string} templateKey - Key of the template to get
 * @param {Object} variables - Variables to substitute in the template
 * @returns {string} Processed template string
 */
function getResponseTemplate(templateKey, variables = {}) {
  const templates = getResponseTemplates();
  let template = templates[templateKey] || '';
  
  if (!template) {
    console.warn(`⚠️  Template "${templateKey}" not found`);
    return '';
  }
  
  // Replace variables in template
  // Variables can be: {nombre}, {asesora_nombre}, {direccion}, etc.
  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    template = template.replace(regex, variables[key]);
  });
  
  // Replace business config variables
  const businessInfo = getBusinessInfo();
  template = template.replace(/\{nombre\}/g, businessInfo.nombre || '');
  template = template.replace(/\{asesora_nombre\}/g, businessInfo.asesora_nombre || '');
  template = template.replace(/\{direccion\}/g, businessInfo.direccion || '');
  
  const catalogInfo = getCatalogInfo();
  template = template.replace(/\{catalogo_link\}/g, catalogInfo.link || '');
  template = template.replace(/\{catalogo_nombre\}/g, catalogInfo.nombre || '');
  
  const hours = getBusinessHours();
  template = template.replace(/\{horario_lun_sab\}/g, hours.martes_sabado || '');
  template = template.replace(/\{horario_dom\}/g, hours.domingos || '');
  
  const pricing = getPricingInfo();
  template = template.replace(/\{precio_base\}/g, pricing.precio_base || '');
  
  return template;
}

/**
 * Get default greeting message
 */
function getDefaultGreeting() {
  return getResponseTemplate('info_general') || 
         `¡Hola! 👰 Bienvenida a ${getBusinessName()}.\n\nPara agendar una cita, necesito algunos datos.\n\n¿Cuál es tu nombre?`;
}

/**
 * Get default response when bot doesn't understand
 */
function getDefaultResponse() {
  return `Escribe "cita" para agendar una consulta en ${getBusinessName()}.`;
}

/**
 * Get appointment confirmation message
 * @param {Object} appointmentData - Appointment data (name, date, time, etc.)
 * @returns {string} Confirmation message
 */
function getAppointmentConfirmationMessage(appointmentData) {
  const { name, date, time } = appointmentData;

  // Format date as "Viernes, 15 de marzo 2026"
  let formattedDate = date;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    formattedDate = d.toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    // Capitalize first letter
    formattedDate = formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);
  }

  const address = getBusinessAddress();

  return `✅ ¡Cita confirmada! 👰‍♀️\n\n👤 *Nombre:* ${name}\n📅 *Fecha:* ${formattedDate}\n🕐 *Hora:* ${time}\n📍 *Ubicación:* ${address}\n\nSi necesitas cambiar o cancelar tu cita, solo responde este mensaje 💐`;
}

/**
 * Load bot messages from bot_messages.json
 * @returns {Object} Bot messages object
 */
function loadBotMessages() {
  if (botMessages) {
    return botMessages;
  }

  try {
    const messagesPath = path.join(__dirname, 'bot_messages.json');
    const messagesData = fs.readFileSync(messagesPath, 'utf8');
    botMessages = JSON.parse(messagesData);
    console.log('✅ Bot messages loaded successfully');
    return botMessages;
  } catch (error) {
    console.error('❌ Error loading bot_messages.json:', error.message);
    // Return empty object if file doesn't exist
    return {};
  }
}

/**
 * Reload bot messages from file (useful after updates)
 * This function clears the cache and forces a fresh load from disk
 */
function reloadBotMessages() {
  console.log('🔄 Recargando mensajes del bot desde archivo...');
  botMessages = null; // Clear cache
  const reloaded = loadBotMessages();
  console.log(`✅ Mensajes recargados. Flujos disponibles: ${Object.keys(reloaded).join(', ')}`);
  return reloaded;
}

/**
 * Get a bot message from bot_messages.json
 * @param {string} flow - Flow name (e.g., 'saludo', 'agendar')
 * @param {string} messageId - Message ID within the flow
 * @param {Object} variables - Variables to replace in the message
 * @returns {string} Processed message or empty string if not found
 */
function getBotMessage(flow, messageId, variables = {}) {
  const messages = loadBotMessages();
  
  if (!messages[flow] || !messages[flow].mensajes || !messages[flow].mensajes[messageId]) {
    console.warn(`⚠️  Bot message not found: ${flow}.${messageId}`);
    return '';
  }
  
  let message = messages[flow].mensajes[messageId].texto || '';
  
  // Replace variables
  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    message = message.replace(regex, variables[key] || '');
  });
  
  // Replace business config variables
  const businessInfo = getBusinessInfo();
  message = message.replace(/\{business_name\}/g, businessInfo.nombre || '');
  message = message.replace(/\{asesora\}/g, businessInfo.asesora_nombre || '');
  message = message.replace(/\{business_address\}/g, businessInfo.direccion || '');
  
  const catalogInfo = getCatalogInfo();
  message = message.replace(/\{catalog_link\}/g, catalogInfo.link || '');
  message = message.replace(/\{catalog_name\}/g, catalogInfo.nombre || '');
  
  const hours = getBusinessHours();
  message = message.replace(/\{horarios_martes_sabado\}/g, hours.martes_sabado || '');
  message = message.replace(/\{horarios_domingos\}/g, hours.domingos || '');
  message = message.replace(/\{horarios_lunes\}/g, hours.lunes || '');
  
  const pricing = getPricingInfo();
  message = message.replace(/\{precio_base\}/g, pricing.precio_base || '');
  message = message.replace(/\{moneda\}/g, pricing.moneda || 'MXN');
  message = message.replace(/\{nota\}/g, pricing.nota || '');
  
  return message;
}

// Export everything
module.exports = {
  // DB persistence (async)
  init,
  save,
  patch,
  get,

  // Raw config
  config,
  
  // Business info
  getBusinessInfo,
  getBusinessName,
  getBusinessType,
  getAdvisorName,
  getBusinessAddress,
  getBusinessMapsLink,
  
  // Hours
  getBusinessHours,
  
  // Catalog
  getCatalogInfo,
  getCatalogLink,
  getCatalogName,
  
  // Pricing
  getPricingInfo,
  getBasePrice,
  
  // Payment
  getPaymentInfo,
  
  // FAQs
  getFAQs,

  // Holidays
  getHolidays,

  // Conversation flow
  getConversationFlow,
  
  // Templates
  getResponseTemplates,
  getResponseTemplate,
  getDefaultGreeting,
  getDefaultResponse,
  getAppointmentConfirmationMessage,
  
  // Bot messages
  loadBotMessages,
  reloadBotMessages,
  getBotMessage
};

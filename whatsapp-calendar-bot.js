const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

// Import business configuration
const {
  getBusinessName,
  getBusinessAddress,
  getDefaultGreeting,
  getDefaultResponse,
  getAppointmentConfirmationMessage,
  init: initBizConfig,
  save: saveBizConfig,
  get:  getBizConfig
} = require('./config');

// Import sessions and OpenAI client (legacy, will be replaced)
const sessions = require('./sessions');
const { getAIResponse, extractConversationData } = require('./openai-client');
const { extractAppointmentDate, parseDateFromText } = require('./date-parser');

// Import new intent-based architecture
const sheetsService = require('./bot/sheets-service');
const { logPendingTask, getPendingTasks, resolvePendingTask, resolveMultipleTasks } = sheetsService;
const { classifyIntent } = require('./bot/classifier');
const { extractBrideProfile } = require('./bot/profile-extractor');
const { handlers } = require('./bot/handlers');
const { 
  isSlotAvailable,
  getAvailableSlots: getAvailableSlotsService,
  createCalendarEvent: createCalendarEventService,
  updateCalendarEvent: updateCalendarEventService,
  deleteCalendarEvent: deleteCalendarEventService,
  findEventsByName: findEventsByNameService,
  restoreBlueEvent: restoreBlueEventService
} = require('./bot/calendar-service');

const app = express();

// Sistema de logs en memoria
const logsBuffer = [];
const MAX_LOGS = 1000; // Mantener últimos 1000 logs

// Interceptar console.log, console.error, etc. para capturar logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function addLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch (e) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
  
  const logEntry = {
    timestamp,
    level,
    message
  };
  
  logsBuffer.push(logEntry);
  
  // Mantener solo los últimos MAX_LOGS
  if (logsBuffer.length > MAX_LOGS) {
    logsBuffer.shift();
  }
  
  // Llamar a la función original
  if (level === 'error') {
    originalConsoleError(...args);
  } else if (level === 'warn') {
    originalConsoleWarn(...args);
  } else {
    originalConsoleLog(...args);
  }
}

// Sobrescribir console methods
console.log = (...args) => addLog('log', ...args);
console.error = (...args) => addLog('error', ...args);
console.warn = (...args) => addLog('warn', ...args);

// Log inicial para verificar que el sistema funciona
console.log('✅ Sistema de logs inicializado correctamente');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// API Routes - Definir ANTES de express.static para evitar conflictos
// GET /api/logs - Obtener logs del sistema (definir temprano para que esté disponible)
app.get('/api/logs', (req, res) => {
  try {
    const { limit = 500, level, since } = req.query;
    
    // Usar originalConsoleLog para estos logs (no capturarlos en el buffer)
    // Esto evita que los logs sobre logs aparezcan en los logs
    // originalConsoleLog(`📋 Solicitud de logs - Buffer: ${logsBuffer.length} logs`);
    
    let filteredLogs = [...logsBuffer];
    
    // Filtrar por nivel si se especifica
    if (level && level !== 'all') {
      filteredLogs = filteredLogs.filter(log => log.level === level);
      // originalConsoleLog(`📋 Filtrado por nivel "${level}": ${filteredLogs.length} logs`);
    }
    
    // Filtrar por fecha si se especifica
    if (since) {
      const sinceDate = new Date(since);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) >= sinceDate);
    }
    
    // Limitar cantidad
    const limitNum = parseInt(limit, 10);
    const logs = filteredLogs.slice(-limitNum);
    
    // originalConsoleLog(`📋 Enviando ${logs.length} logs al cliente`);
    
    res.json({
      logs,
      total: logsBuffer.length,
      filtered: filteredLogs.length,
      returned: logs.length
    });
  } catch (error) {
    originalConsoleError('Error en /api/logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Endpoints temporales para regenerar OAuth token ─────────────────────────
app.get('/reauth', (req, res) => {
  try {
    let credentials = null;
    if (process.env.GOOGLE_CREDENTIALS) {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } else if (fs.existsSync('./credentials.json')) {
      credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    }
    if (!credentials) return res.status(500).send('No se encontraron GOOGLE_CREDENTIALS');

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'],
      prompt: 'consent'
    });
    res.send(`<h2>Paso 1: Autorizar</h2><p>Abre este link en tu navegador:</p><a href="${authUrl}" target="_blank">${authUrl}</a><br><br><p>Después de autorizar, copia el <b>code</b> de la URL de redirect y ve a:<br><b>/reauth/token?code=TU_CODE_AQUI</b></p>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.get('/reauth/token', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Falta el parámetro ?code=');

    let credentials = null;
    if (process.env.GOOGLE_CREDENTIALS) {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } else if (fs.existsSync('./credentials.json')) {
      credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    }

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const { tokens } = await oAuth2Client.getToken(code);

    res.send(`<h2>✅ Nuevo token generado</h2><p>Copia este JSON y pégalo como el valor de <b>GOOGLE_TOKEN</b> en Railway:</p><pre style="background:#f0f0f0;padding:16px;word-break:break-all">${JSON.stringify(tokens)}</pre>`);
  } catch (e) {
    res.status(500).send('Error obteniendo token: ' + e.message);
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// Endpoint de prueba para verificar que el servidor responde
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

// Endpoint de diagnóstico para verificar horarios disponibles en una fecha específica
app.get('/api/check-slots/:date', async (req, res) => {
  try {
    const { date } = req.params; // Formato: YYYY-MM-DD
    
    console.log(`📅 [check-slots] Consultando horarios para: ${date}`);
    
    // Validar formato de fecha
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return res.status(400).json({ 
        error: 'Formato de fecha inválido. Use YYYY-MM-DD (ej: 2026-03-04)' 
      });
    }
    
    if (!authClient) {
      console.error('❌ [check-slots] Google Auth no inicializado');
      return res.status(500).json({ error: 'Google Auth no inicializado' });
    }

    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    if (!innoviaCDMXCalendarId) {
      console.error('❌ [check-slots] Calendario "Innovia CDMX" no encontrado');
      return res.status(500).json({ error: 'Calendario "Innovia CDMX" no encontrado' });
    }

    console.log(`📅 [check-slots] Usando calendario: ${innoviaCDMXCalendarId}`);

    // Usar la misma lógica que getAvailableSlots
    const { getAvailableSlots: getAvailableSlotsService } = require('./bot/calendar-service');
    
    const slots = await getAvailableSlotsService(
      date,
      calendar,
      authClient,
      innoviaCDMXCalendarId,
      null
    );

    console.log(`📅 [check-slots] Slots encontrados: ${slots.length}`);

    // Formatear respuesta
    const formattedSlots = slots.map(slot => ({
      time: slot.time,
      start: slot.start,
      end: slot.end,
      eventId: slot.eventId,
      startTimestamp: slot.startTimestamp,
      availableSpots: slot.availableSpots,
      totalSpots: slot.totalSpots
    }));

    res.json({
      date: date,
      totalSlots: slots.length,
      slots: formattedSlots,
      slotsByTime: formattedSlots.map(s => s.time).join(', ')
    });
  } catch (error) {
    console.error('❌ [check-slots] Error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Endpoint temporal de diagnóstico para verificar citas en una fecha específica
app.get('/api/check-appointments/:date', async (req, res) => {
  try {
    const { date } = req.params; // Formato: YYYY-MM-DD
    const { hour, minute } = req.query; // Opcional: hora y minuto específicos
    
    if (!authClient) {
      return res.status(500).json({ error: 'Google Auth no inicializado' });
    }

    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    const targetCalendarId = citasNuevasCalendarId || process.env.CALENDAR_ID || 'primary';
    
    // Crear rango del día
    const [year, month, day] = date.split('-').map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59);

    const events = await calendar.events.list({
      auth: auth,
      calendarId: targetCalendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Mexico_City'
    });

    const eventItems = events.data.items || [];
    
    // Procesar eventos
    const appointments = eventItems.map(e => {
      let start, end;
      
      if (e.start.dateTime) {
        const startStr = e.start.dateTime;
        if (!startStr.endsWith('Z') && !startStr.match(/[+-]\d{2}:\d{2}$/)) {
          start = new Date(`${startStr}-06:00`);
          end = new Date(`${e.end.dateTime}-06:00`);
        } else {
          start = new Date(e.start.dateTime);
          end = new Date(e.end.dateTime);
        }
      } else if (e.start.date) {
        start = new Date(e.start.date + 'T00:00:00');
        end = new Date(e.end.date + 'T23:59:59');
      }

      return {
        id: e.id,
        summary: e.summary || 'Sin título',
        start: start.toISOString(),
        end: end.toISOString(),
        startCDMX: start.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
        endCDMX: end.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
        startTimeCDMX: start.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true })
      };
    });

    // Si se especifica hora, filtrar por bloque
    let result = {
      date,
      total: appointments.length,
      appointments: appointments
    };

    if (hour !== undefined && minute !== undefined) {
      const blockHour = parseInt(hour);
      const blockMinute = parseInt(minute);
      const blockStart = new Date(`${date}T${String(blockHour).padStart(2, '0')}:${String(blockMinute).padStart(2, '0')}:00-06:00`);
      const blockEnd = new Date(blockStart.getTime() + 90 * 60 * 1000);

      const appointmentsInBlock = appointments.filter(apt => {
        const aptStart = new Date(apt.start).getTime();
        const aptEnd = new Date(apt.end).getTime();
        const blockStartTime = blockStart.getTime();
        const blockEndTime = blockEnd.getTime();
        return aptStart < blockEndTime && aptEnd > blockStartTime;
      });

      result.block = {
        hour: blockHour,
        minute: blockMinute,
        start: blockStart.toISOString(),
        end: blockEnd.toISOString(),
        count: appointmentsInBlock.length,
        appointments: appointmentsInBlock
      };
    }

    res.json(result);
  } catch (error) {
    console.error('Error en /api/check-appointments:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve static files from public directory
app.use(express.static('public'));

// Credenciales de Chakra (BSP de WhatsApp)
// Limpiar API key (remover espacios, saltos de línea, etc.)
const CHAKRA_API_KEY = process.env.CHAKRA_API_KEY ? process.env.CHAKRA_API_KEY.trim().replace(/\s+/g, '') : null;
const CHAKRA_PLUGIN_ID = process.env.CHAKRA_PLUGIN_ID ? process.env.CHAKRA_PLUGIN_ID.trim() : null;
const CHAKRA_WHATSAPP_API_VERSION = process.env.CHAKRA_WHATSAPP_API_VERSION || 'v18.0';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mi_token_seguro_123';

// Admin phone number for escalations
// Format: +[country code][number] (e.g., +19179605545 for US, +525521920710 for Mexico)
// Try to load from phone_config.json first, then fallback to env var or default
let ADMIN_PHONE = process.env.ADMIN_PHONE || '+19179605545';
try {
  const phoneConfigPath = path.join(__dirname, 'phone_config.json');
  if (fs.existsSync(phoneConfigPath)) {
    const phoneConfig = JSON.parse(fs.readFileSync(phoneConfigPath, 'utf8'));
    if (phoneConfig.adminPhone) {
      ADMIN_PHONE = phoneConfig.adminPhone;
      console.log(`✅ ADMIN_PHONE cargado desde phone_config.json: ${ADMIN_PHONE}`);
    }
  }
} catch (error) {
  console.warn('⚠️  No se pudo cargar phone_config.json, usando valor por defecto o variable de entorno');
}

// Números del staff — el bot no responde a estos números (matching por sufijo)
// Clientes existentes — el bot ignora estos números silenciosamente
// Populated after initBizConfig() resolves at startup (see server init chain below)
let STAFF_PHONES = [];
let EXISTING_CLIENTS = [];

function loadRuntimePhones() {
  const biz = getBizConfig() || {};
  STAFF_PHONES = (biz.staff_phones || []).map(p => p.replace(/\D/g, ''));
  EXISTING_CLIENTS = (biz.existing_clients || []).map(p => p.replace(/\D/g, ''));
  if (biz._adminPhone) {
    ADMIN_PHONE = biz._adminPhone;
    console.log(`✅ ADMIN_PHONE cargado desde DB: ${ADMIN_PHONE}`);
  }
  console.log(`✅ Staff phones cargados: ${STAFF_PHONES.length} números`);
  console.log(`✅ Clientes existentes cargados: ${EXISTING_CLIENTS.length} números`);
}

// Configuración de Google Calendar
const calendar = google.calendar('v3');
let authClient;
let citasNuevasCalendarId = null; // ID del calendario "CITAS NUEVAS" (donde se guardan las citas agendadas)
let innoviaCDMXCalendarId = null; // ID del calendario "Innovia CDMX" (eventos azules sin nombre = spots disponibles)

// Inicializar autenticación de Google
async function initGoogleAuth() {
  try {
    let credentials = null;
    
    // PRIORIDAD 1: Variable de entorno GOOGLE_CREDENTIALS (para Railway/producción)
    if (process.env.GOOGLE_CREDENTIALS) {
      try {
        credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        console.log('✅ Credenciales de Google cargadas desde variable de entorno GOOGLE_CREDENTIALS');
      } catch (error) {
        console.error('❌ Error parseando GOOGLE_CREDENTIALS:', error.message);
        throw new Error('GOOGLE_CREDENTIALS tiene formato JSON inválido');
      }
    }
    // PRIORIDAD 2: Archivo de credenciales local (para desarrollo)
    else {
      let credentialsFile = null;
      
      // Buscar archivo de credenciales
      if (fs.existsSync('./credentials.json')) {
        credentialsFile = './credentials.json';
      } else {
        // Buscar archivo client_secret_*.json
        const files = fs.readdirSync('.').filter(f => f.startsWith('client_secret_') && f.endsWith('.json'));
        if (files.length > 0) {
          credentialsFile = files[0];
        }
      }
      
      if (!credentialsFile) {
        throw new Error('No se encontró archivo de credenciales ni variable GOOGLE_CREDENTIALS');
      }
      
      credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
      console.log(`✅ Credenciales de Google cargadas desde archivo: ${credentialsFile}`);
    }
    
    // Verificar si es OAuth 2.0 o cuenta de servicio
    if (credentials.installed || credentials.web) {
      // Es OAuth 2.0 - usar OAuth2Client
      const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      
      // Verificar si ya tenemos token guardado
      // PRIORIDAD 1: Variable de entorno GOOGLE_TOKEN (para Railway/producción)
      const TOKEN_PATH = path.join(__dirname, 'token.json');
      let token = null;
      if (process.env.GOOGLE_TOKEN) {
        try {
          token = JSON.parse(process.env.GOOGLE_TOKEN);
          console.log('✅ Token de Google cargado desde variable de entorno GOOGLE_TOKEN');
        } catch (error) {
          console.error('❌ Error parseando GOOGLE_TOKEN:', error.message);
        }
      }
      // PRIORIDAD 2: Archivo token.json local (para desarrollo)
      else {
        if (fs.existsSync(TOKEN_PATH)) {
          token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
          console.log('✅ Token de Google cargado desde archivo token.json');
        }
      }
      
      if (token) {
        oAuth2Client.setCredentials(token);
        authClient = oAuth2Client;
        console.log('✅ Autenticación de Google inicializada (token existente)');
      } else {
        // Necesitamos autenticación interactiva
        console.log('\n🔐 ============================================');
        console.log('   PRIMERA AUTENTICACIÓN CON GOOGLE CALENDAR');
        console.log('============================================\n');
        console.log('📋 Pasos:');
        console.log('   1. Abre esta URL en tu navegador:');
        console.log('   2. Inicia sesión y autoriza la aplicación');
        console.log('   3. Si ves "App no verificada", haz clic en "Avanzado" → "Ir a Calendar Bot"');
        console.log('   4. Después de autorizar, te redirigirá a localhost (ignora el error)');
        console.log('   5. Copia el código de la URL (la parte después de "code=")');
        console.log('   6. Pégalo aquí abajo\n');
        
        const authUrl = oAuth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'],
          prompt: 'consent' // Forzar mostrar pantalla de consentimiento
        });
        
        console.log('🔗 URL de autorización:');
        console.log(authUrl);
        console.log('\n💡 Ejemplo del código que necesitas copiar:');
        console.log('   Si la URL es: http://localhost/?code=4/0Aean...&scope=...');
        console.log('   Copia solo: 4/0Aean...\n');
        console.log('⚠️  Nota: El error de localhost es normal, solo copia el código de la URL\n');
        
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        rl.question('📝 Pega el código de autorización aquí: ', async (code) => {
          rl.close();
          try {
            // Limpiar el código (puede venir con parámetros adicionales de la URL)
            const cleanCode = code.trim().split('&')[0].split('?code=').pop();
            const { tokens } = await oAuth2Client.getToken(cleanCode);
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
            authClient = oAuth2Client;
            console.log('\n✅ Autenticación de Google completada y guardada');
            console.log('✅ El bot ahora puede consultar Google Calendar');
            console.log('✅ No necesitarás autorizar de nuevo\n');
          } catch (error) {
            console.error('\n❌ Error al obtener token:', error.message);
            console.error('   Asegúrate de copiar el código completo de la URL');
            console.warn('⚠️  El bot funcionará pero NO consultará Google Calendar\n');
            authClient = null;
          }
        });
        // Continuar - la autenticación se completará cuando el usuario ingrese el código
        // El bot puede funcionar mientras tanto (usará horarios por defecto)
      }
    } else if (credentials.type === 'service_account') {
      // Es cuenta de servicio - usar GoogleAuth
      authClient = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets']
      });
      console.log('✅ Autenticación de Google inicializada (cuenta de servicio)');
    } else {
      throw new Error('Formato de credenciales no reconocido');
    }
  } catch (error) {
    console.error('❌ Error inicializando Google Auth:', error.message);
    console.warn('⚠️  El bot funcionará pero NO consultará Google Calendar');
  }
  
  // Buscar los calendarios necesarios después de inicializar auth
  if (authClient) {
    await findCitasNuevasCalendar();
    await findInnoviaCDMXCalendar();
  }
}

// Función para buscar el calendario "CITAS NUEVAS" por nombre
async function findCitasNuevasCalendar() {
  try {
    if (!authClient) {
      console.warn('⚠️  Google Auth no inicializado, no se puede buscar calendario');
      return;
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    console.log('🔍 Buscando calendario "CITAS NUEVAS"...');
    
    // Listar todos los calendarios del usuario
    const calendarList = await calendar.calendarList.list({
      auth: auth,
      minAccessRole: 'writer' // Solo calendarios donde podemos escribir
    });

    console.log(`   Calendarios encontrados: ${calendarList.data.items.length}`);
    console.log('   Lista de calendarios:');
    calendarList.data.items.forEach(cal => {
      console.log(`     - ${cal.summary} (ID: ${cal.id})`);
    });

    // Buscar el calendario con nombre exacto "CITAS NUEVAS" (case-insensitive)
    const citasNuevas = calendarList.data.items.find(cal => {
      if (!cal.summary) return false;
      const nameUpper = cal.summary.toUpperCase().trim();
      return nameUpper === 'CITAS NUEVAS' || nameUpper.includes('CITAS NUEVAS');
    });

    if (citasNuevas) {
      citasNuevasCalendarId = citasNuevas.id;
      console.log(`✅ Calendario "CITAS NUEVAS" encontrado: ${citasNuevasCalendarId}`);
      console.log(`   Nombre: ${citasNuevas.summary}`);
      console.log(`   Color: ${citasNuevas.backgroundColor || 'N/A'}`);
      console.log(`   📌 Este será el calendario usado para todas las operaciones de citas`);
    } else {
      console.warn('⚠️  No se encontró calendario "CITAS NUEVAS"');
      console.warn('   Buscando por nombre alternativo...');
      
      // Intentar buscar por variaciones del nombre
      const alternativeNames = ['CITAS', 'NUEVAS', 'CITASNUEVAS'];
      const alternative = calendarList.data.items.find(cal => {
        if (!cal.summary) return false;
        const nameUpper = cal.summary.toUpperCase().trim();
        return alternativeNames.some(alt => nameUpper.includes(alt));
      });
      
      if (alternative) {
        console.warn(`   ⚠️  Se encontró un calendario similar: "${alternative.summary}"`);
        console.warn('   Por favor, asegúrate de que el calendario se llame exactamente "CITAS NUEVAS"');
      }
      
      console.warn('   Usando CALENDAR_ID de variables de entorno o "primary"');
      citasNuevasCalendarId = process.env.CALENDAR_ID || 'primary';
      console.warn(`   ⚠️  Calendar ID a usar: ${citasNuevasCalendarId}`);
    }
  } catch (error) {
    console.error('❌ Error buscando calendario "CITAS NUEVAS":', error.message);
    console.warn('   Usando CALENDAR_ID de variables de entorno o "primary"');
    citasNuevasCalendarId = process.env.CALENDAR_ID || 'primary';
  }
}

// Función para buscar el calendario "Innovia CDMX" por nombre
async function findInnoviaCDMXCalendar() {
  try {
    if (!authClient) {
      console.warn('⚠️  Google Auth no inicializado, no se puede buscar calendario');
      return;
    }

    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    console.log('🔍 Buscando calendario "Innovia CDMX"...');
    
    // Listar todos los calendarios del usuario
    const calendarList = await calendar.calendarList.list({
      auth: auth,
      minAccessRole: 'writer' // Solo calendarios donde podemos escribir
    });

    console.log(`   Calendarios encontrados: ${calendarList.data.items.length}`);
    
    // Buscar el calendario con nombre "Innovia CDMX" (case-insensitive)
    const innoviaCDMX = calendarList.data.items.find(cal => {
      if (!cal.summary) return false;
      const nameUpper = cal.summary.toUpperCase().trim();
      return nameUpper === 'INNOVIA CDMX' || nameUpper.includes('INNOVIA CDMX');
    });

    if (innoviaCDMX) {
      innoviaCDMXCalendarId = innoviaCDMX.id;
      console.log(`✅ Calendario "Innovia CDMX" encontrado: ${innoviaCDMXCalendarId}`);
      console.log(`   Nombre: ${innoviaCDMX.summary}`);
      console.log(`   Color: ${innoviaCDMX.backgroundColor || 'N/A'}`);
      console.log(`   📌 Este calendario contiene los eventos azules (spots disponibles)`);
    } else {
      console.warn('⚠️  No se encontró calendario "Innovia CDMX"');
      console.warn('   Buscando por nombre alternativo...');
      
      // Intentar buscar por variaciones del nombre
      const alternativeNames = ['INNOVIA', 'CDMX'];
      const alternative = calendarList.data.items.find(cal => {
        if (!cal.summary) return false;
        const nameUpper = cal.summary.toUpperCase().trim();
        return alternativeNames.some(alt => nameUpper.includes(alt));
      });
      
      if (alternative) {
        innoviaCDMXCalendarId = alternative.id;
        console.warn(`   ⚠️  Calendario alternativo encontrado: "${alternative.summary}" (ID: ${innoviaCDMXCalendarId})`);
        console.warn('   Por favor, asegúrate de que el calendario se llame exactamente "Innovia CDMX"');
      } else {
        console.error('   ❌ No se encontró calendario "Innovia CDMX"');
        console.error('   El bot NO podrá determinar spots disponibles sin este calendario');
      }
    }
  } catch (error) {
    console.error('❌ Error buscando calendario "Innovia CDMX":', error.message);
    console.error('   El bot NO podrá determinar spots disponibles sin este calendario');
  }
}

// Función para verificar si un día está abierto según horarios del negocio
function isDayOpen(dateString) {
  try {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const dayOfWeek = date.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    
    const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const dayName = dayNames[dayOfWeek];
    
    const { getBusinessHours } = require('./config');
    const hours = getBusinessHours();
    
    // Verificar si el día está cerrado
    if (dayName === 'lunes' && hours.lunes === 'Cerrado') {
      console.log(`   ❌ ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} está cerrado`);
      return false;
    }
    
    // Los demás días están abiertos según la configuración
    return true;
  } catch (error) {
    console.error('Error verificando día:', error);
    return true; // Por defecto permitir si hay error
  }
}

// Función para obtener horarios disponibles desde Google Calendar
// Usa bloques de 90 minutos con máximo 2 citas por bloque
async function getAvailableSlots(date) {
  try {
    // Verificar si el día está abierto
    if (!isDayOpen(date)) {
      console.log(`📅 ${date} está cerrado según horarios del negocio`);
      return []; // Retornar array vacío si está cerrado
    }
    
    if (!authClient) {
      console.warn('⚠️  Google Auth no inicializado, usando horarios por defecto');
      return getDefaultSlots(date);
    }

    // Obtener cliente de autenticación (compatible con OAuth2Client y GoogleAuth)
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      // Es GoogleAuth (cuenta de servicio)
      auth = await authClient.getClient();
    } else {
      // Es OAuth2Client directamente
      auth = authClient;
    }
    
    // Crear fechas en zona horaria local (America/Mexico_City)
    // Formato de entrada: "2025-02-20"
    const [year, month, day] = date.split('-').map(Number);
    const startOfDay = new Date(year, month - 1, day, 11, 0, 0); // 11:00 AM hora local
    const endOfDay = new Date(year, month - 1, day, 20, 0, 0);   // 8:00 PM hora local

    console.log(`📅 Consultando Google Calendar para ${date}`);
    console.log(`   Rango: ${startOfDay.toLocaleString('es-MX')} - ${endOfDay.toLocaleString('es-MX')}`);

    // Usar el calendario "CITAS NUEVAS" si está disponible, sino usar el configurado
    const targetCalendarId = citasNuevasCalendarId || process.env.CALENDAR_ID || 'primary';
    console.log(`   Consultando calendario: ${targetCalendarId === citasNuevasCalendarId ? '"CITAS NUEVAS"' : targetCalendarId}`);

    const events = await calendar.events.list({
      auth: auth,
      calendarId: targetCalendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Mexico_City'
    });

    const eventItems = events.data.items || [];
    console.log(`   Eventos encontrados: ${eventItems.length}`);

    // Procesar eventos y convertir a fechas locales
    const bookedEvents = eventItems.map(e => {
      let start, end;
      
      // Manejar eventos con hora (dateTime) y eventos de todo el día (date)
      if (e.start.dateTime) {
        start = new Date(e.start.dateTime);
        end = new Date(e.end.dateTime);
      } else if (e.start.date) {
        // Evento de todo el día - considerar que ocupa todo el día
        start = new Date(e.start.date + 'T00:00:00');
        end = new Date(e.end.date + 'T23:59:59');
      }
      
      // Solo contar eventos que parecen ser citas (contienen "Cita" en el título)
      const isAppointment = e.summary && e.summary.toLowerCase().includes('cita');
      
      return { start, end, summary: e.summary || 'Sin título', isAppointment };
    }).filter(e => e.isAppointment); // Solo eventos de citas

    console.log(`   Citas encontradas: ${bookedEvents.length}`);

    // Bloques de 90 minutos disponibles
    // Horarios: 11:00am, 12:30pm, 2:00pm, 3:30pm, 5:00pm, 6:30pm
    // Los domingos solo hasta las 5:00pm (no se ofrece 6:30pm)
    const allBlockTimes = [
      { hour: 11, minute: 0 },   // 11:00am - 12:30pm
      { hour: 12, minute: 30 },  // 12:30pm - 2:00pm
      { hour: 14, minute: 0 },   // 2:00pm - 3:30pm
      { hour: 15, minute: 30 },  // 3:30pm - 5:00pm
      { hour: 17, minute: 0 },   // 5:00pm - 6:30pm
      { hour: 18, minute: 30 }   // 6:30pm - 8:00pm
    ];

    // Determinar si es domingo (0 = domingo en JavaScript)
    // Usar zona horaria local de México para evitar problemas de UTC
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay();
    const isSunday = dayOfWeek === 0;

    console.log(`   📅 Verificando día de la semana para ${date}: día ${dayOfWeek} (0=domingo, 1=lunes...)`);

    // Si es domingo, excluir el último bloque (6:30pm)
    const blockTimes = isSunday 
      ? allBlockTimes.slice(0, -1)  // Todos excepto el último
      : allBlockTimes;

    if (isSunday) {
      console.log(`   📅 ✅ Es domingo - solo horarios hasta las 5:00pm (excluyendo 6:30pm)`);
      console.log(`   📅 Bloques disponibles: ${blockTimes.length} (debería ser 5, no 6)`);
    } else {
      console.log(`   📅 No es domingo - todos los horarios disponibles (incluyendo 6:30pm)`);
    }

    const slots = [];
    const MAX_CITAS_POR_BLOQUE = 2;

    for (const blockTime of blockTimes) {
      const blockStart = new Date(year, month - 1, day, blockTime.hour, blockTime.minute, 0);
      const blockEnd = new Date(blockStart.getTime() + 90 * 60 * 1000); // 90 minutos después

      // Contar cuántas citas hay en este bloque
      let citasEnBloque = 0;
      bookedEvents.forEach(booked => {
        // Una cita está en el bloque si se solapa con él
        // Solapamiento: blockStart < booked.end && blockEnd > booked.start
        const overlaps = blockStart < booked.end && blockEnd > booked.start;
        if (overlaps) {
          citasEnBloque++;
          console.log(`   📌 Cita en bloque ${blockTime.hour}:${String(blockTime.minute).padStart(2, '0')}: ${booked.summary}`);
        }
      });

      // El bloque está disponible si tiene menos de 2 citas
      if (citasEnBloque < MAX_CITAS_POR_BLOQUE) {
        const availableSpots = MAX_CITAS_POR_BLOQUE - citasEnBloque;
        slots.push({
          time: blockStart.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true }),
          start: blockStart.toISOString(),
          end: blockEnd.toISOString(),
          availableSpots: availableSpots,
          totalSpots: MAX_CITAS_POR_BLOQUE
        });
        console.log(`   ✅ Bloque ${blockTime.hour}:${String(blockTime.minute).padStart(2, '0')} disponible (${availableSpots}/${MAX_CITAS_POR_BLOQUE} espacios libres)`);
      } else {
        console.log(`   ❌ Bloque ${blockTime.hour}:${String(blockTime.minute).padStart(2, '0')} lleno (${citasEnBloque}/${MAX_CITAS_POR_BLOQUE} citas)`);
      }
    }

    console.log(`   📊 Total bloques disponibles: ${slots.length}`);
    
    if (slots.length === 0) {
      console.warn('   ⚠️  No hay bloques disponibles, usando horarios por defecto');
      return getDefaultSlots(date);
    }
    
    return slots;
  } catch (error) {
    console.error('❌ Error al consultar Google Calendar:', error.message);
    console.error('   Stack:', error.stack);
    console.warn('⚠️  Usando horarios por defecto');
    return getDefaultSlots(date);
  }
}

// Horarios por defecto si no se puede consultar Google Calendar
// Usa bloques de 90 minutos
// Los domingos solo hasta las 5:00pm (no se ofrece 6:30pm)
function getDefaultSlots(date) {
  const [year, month, day] = date.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayOfWeek = dateObj.getDay();
  const isSunday = dayOfWeek === 0;

  console.log(`   📅 [getDefaultSlots] Verificando día de la semana para ${date}: día ${dayOfWeek} (0=domingo, 1=lunes...)`);
  console.log(`   📅 [getDefaultSlots] Es domingo? ${isSunday}`);

  const allSlots = [
    { time: '11:00 AM', start: `${date}T11:00:00`, end: `${date}T12:30:00`, availableSpots: 2, totalSpots: 2 },
    { time: '12:30 PM', start: `${date}T12:30:00`, end: `${date}T14:00:00`, availableSpots: 2, totalSpots: 2 },
    { time: '2:00 PM', start: `${date}T14:00:00`, end: `${date}T15:30:00`, availableSpots: 2, totalSpots: 2 },
    { time: '3:30 PM', start: `${date}T15:30:00`, end: `${date}T17:00:00`, availableSpots: 2, totalSpots: 2 },
    { time: '5:00 PM', start: `${date}T17:00:00`, end: `${date}T18:30:00`, availableSpots: 2, totalSpots: 2 },
    { time: '6:30 PM', start: `${date}T18:30:00`, end: `${date}T20:00:00`, availableSpots: 2, totalSpots: 2 }
  ];

  // Si es domingo, excluir el último slot (6:30pm)
  const slots = isSunday ? allSlots.slice(0, -1) : allSlots;
  
  if (isSunday) {
    console.log(`   📅 ✅ [getDefaultSlots] Es domingo - excluyendo 6:30pm. Slots disponibles: ${slots.length} (debería ser 5)`);
    console.log(`   📅 [getDefaultSlots] Último slot: ${slots[slots.length - 1]?.time || 'N/A'}`);
  } else {
    console.log(`   📅 [getDefaultSlots] No es domingo - todos los slots incluidos. Total: ${slots.length}`);
  }
  
  return slots;
}

// Función para crear evento en Google Calendar
async function createCalendarEvent(name, phone, email, dateStart, fechaBoda = null) {
  try {
    if (!authClient) {
      console.warn('⚠️  Google Auth no inicializado, no se creará evento en Calendar');
      return null;
    }

    // Obtener cliente de autenticación (compatible con OAuth2Client y GoogleAuth)
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      // Es GoogleAuth (cuenta de servicio)
      auth = await authClient.getClient();
    } else {
      // Es OAuth2Client directamente
      auth = authClient;
    }
    
    // Calcular fecha de fin: siempre 90 minutos después del inicio
    const startDate = new Date(dateStart);
    const endDate = new Date(startDate.getTime() + 90 * 60 * 1000); // 90 minutos
    
    // Formatear teléfono: XX XXX XXXX (formato mexicano de 10 dígitos)
    const formatPhone = (phoneNum) => {
      const cleaned = phoneNum.replace(/\D/g, '');
      if (cleaned.length >= 10) {
        // Tomar los últimos 10 dígitos (número mexicano sin código de país)
        const last10 = cleaned.slice(-10);
        // Formato: XX XXX XXXX (ej: 55 219 2071)
        return `${last10.slice(0, 2)} ${last10.slice(2, 5)} ${last10.slice(5)}`;
      }
      // Si tiene menos de 10 dígitos, devolver tal cual
      return cleaned;
    };
    
    // Formatear fecha de boda: DD/MM/AAAA
    const formatFechaBoda = (fecha) => {
      if (!fecha) return 'No especificada';
      try {
        // Si viene en formato YYYY-MM-DD
        if (fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [year, month, day] = fecha.split('-');
          return `${day}/${month}/${year}`;
        }
        // Si ya está en otro formato, intentar parsear
        const dateObj = new Date(fecha);
        if (!isNaN(dateObj.getTime())) {
          const day = String(dateObj.getDate()).padStart(2, '0');
          const month = String(dateObj.getMonth() + 1).padStart(2, '0');
          const year = dateObj.getFullYear();
          return `${day}/${month}/${year}`;
        }
        return fecha;
      } catch (e) {
        return fecha;
      }
    };
    
    // Título: solo el nombre completo de la cliente
    const eventSummary = name || 'Cliente';
    
    // Descripción con formato solicitado
    let description = '';
    if (fechaBoda) {
      description += `FECHA DE BODA: ${formatFechaBoda(fechaBoda)}\n`;
    }
    description += `TELEFONO: ${formatPhone(phone)}\n`;
    if (email) {
      description += `EMAIL: ${email}\n`;
    }
    description += '\n*Cita creada por Calendar bot*';
    
    const event = {
      summary: eventSummary,
      description: description,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'America/Mexico_City'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'America/Mexico_City'
      },
      attendees: email ? [{ email: email }] : []
    };

    // Usar el calendario "CITAS NUEVAS" si está disponible, sino usar el configurado
    const targetCalendarId = citasNuevasCalendarId || process.env.CALENDAR_ID || 'primary';
    
    console.log(`   Creando evento en calendario: ${targetCalendarId}`);
    
    const createdEvent = await calendar.events.insert({
      auth: auth,
      calendarId: targetCalendarId,
      resource: event
    });

    console.log('✅ Evento creado en Google Calendar:', createdEvent.data.id);
    console.log(`   Título: ${eventSummary}`);
    console.log(`   Duración: 90 minutos`);
    return createdEvent.data;
  } catch (error) {
    console.error('❌ Error al crear evento en Calendar:', error.message);
    return null;
  }
}

// Sessions are now managed by sessions.js module
// Removed: const conversations = {};

// Almacenar phone_number_id y display_phone_number del webhook
let whatsappPhoneNumberId = null;
let businessDisplayPhone = null; // número de teléfono real del negocio (ej: 5215533999185)

// Tracking de IDs de mensajes enviados por el bot (para detectar intervención humana)
// Map<messageId, { phone, timestamp }>
const botSentMessageIds = new Map();
const BOT_MSG_ID_TTL_MS = 30 * 60 * 1000; // 30 minutos
const HUMAN_HANDOFF_PAUSE_MS = 10 * 60 * 1000; // 10 minutos
const BOT_MSG_IDS_PATH = path.join(__dirname, 'bot_sent_messages.json');

// Rastrea cuándo el bot envió por última vez a cada teléfono (para evitar race condition)
const botLastSentAt = new Map();
const RACE_CONDITION_WINDOW_MS = 2 * 1000; // 2 segundos — mínimo buffer de timing de red. Los IDs de mensajes ya están persistidos, así que la ventana real es casi innecesaria.

// Debounce de mensajes de texto: acumula mensajes rápidos del mismo número
// antes de procesarlos, para evitar respuestas duplicadas cuando el usuario
// envía varios mensajes o fotos en ráfaga.
const pendingTextMessages = new Map(); // phone → { messages: string[], timer: NodeJS.Timeout }

// Lock para evitar creación concurrente de citas para el mismo teléfono.
// Si dos webhooks llegan casi al mismo tiempo, el segundo es descartado.
const appointmentCreationLocks = new Set(); // Set<phone>
const MESSAGE_DEBOUNCE_MS = 3000; // 3 segundos de ventana

// Debounce de imágenes: igual que texto, acumula imágenes enviadas en ráfaga
// para responder una sola vez con el conteo total.
const pendingImageMessages = new Map(); // phone → { images: string[], sessionData, timer }

function scheduleImageMessage(phone, descripcion, sessionData) {
  if (pendingImageMessages.has(phone)) {
    clearTimeout(pendingImageMessages.get(phone).timer);
    pendingImageMessages.get(phone).images.push(descripcion);
  } else {
    pendingImageMessages.set(phone, { images: [descripcion], sessionData, timer: null });
  }

  const timer = setTimeout(async () => {
    const queued = pendingImageMessages.get(phone);
    pendingImageMessages.delete(phone);
    const count = queued.images.length;

    console.log(`⏱️  [DEBOUNCE IMG] Procesando ${count} imagen(es) agrupada(s) de ${phone}`);

    // Un solo pending task con todas las imágenes
    const combinedDesc = count === 1
      ? queued.images[0]
      : `${count} imágenes recibidas:\n${queued.images.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;

    logPendingTask({
      phone,
      name: queued.sessionData.clientName,
      message: combinedDesc,
      historial: queued.sessionData.historial
    });

    // Una sola respuesta al usuario
    const reply = count === 1
      ? 'Recibí tu imagen 📎. Un miembro de nuestro equipo la revisará y se pondrá en contacto contigo a la brevedad. 🙏'
      : `Recibí tus ${count} imágenes 📎. Un miembro de nuestro equipo las revisará y se pondrá en contacto contigo a la brevedad. 🙏`;

    await sendWhatsAppMessage(phone, reply);
  }, MESSAGE_DEBOUNCE_MS);

  pendingImageMessages.get(phone).timer = timer;
}

// Cancela todos los timers pendientes de texto e imagen para un teléfono dado.
// Se llama cuando se detecta intervención humana para evitar que el bot responda.
function cancelPendingMessages(phone) {
  if (pendingTextMessages.has(phone)) {
    clearTimeout(pendingTextMessages.get(phone).timer);
    pendingTextMessages.delete(phone);
    console.log(`🚫 [HANDOFF] Timers de texto cancelados para ${phone}`);
  }
  if (pendingImageMessages.has(phone)) {
    clearTimeout(pendingImageMessages.get(phone).timer);
    pendingImageMessages.delete(phone);
    console.log(`🚫 [HANDOFF] Timers de imagen cancelados para ${phone}`);
  }
}

function scheduleTextMessage(phone, message, options) {
  if (pendingTextMessages.has(phone)) {
    clearTimeout(pendingTextMessages.get(phone).timer);
    pendingTextMessages.get(phone).messages.push(message);
  } else {
    pendingTextMessages.set(phone, { messages: [message], timer: null });
  }

  const timer = setTimeout(() => {
    const queued = pendingTextMessages.get(phone);
    pendingTextMessages.delete(phone);
    const combined = queued.messages.join('\n');

    // Re-verificar si el bot fue pausado durante la ventana de debounce
    const currentSession = sessions.getSession(phone);
    if (currentSession.bot_paused_until && new Date(currentSession.bot_paused_until) > new Date()) {
      console.log(`⏸️  [DEBOUNCE] Bot pausado (dashboard) — mensaje guardado en historial para ${phone}`);
      sessions.addToHistory(phone, 'user', combined);
      return;
    }

    console.log(`⏱️  [DEBOUNCE] Procesando ${queued.messages.length} mensaje(s) agrupado(s) de ${phone}: "${combined}"`);
    processIncomingMessage(phone, combined, options).catch(err => {
      if (err.message === 'BOT_INACTIVE_BLOCKED' || err.message === 'BOT_TEST_MODE_BLOCKED' || err.message === 'BOT_INVALID_MODE_BLOCKED') {
        console.log(`⏸️  Mensaje bloqueado correctamente — ${err.message}`);
        return;
      }
      console.error('❌ Error procesando mensaje (debounce):', err);
    });
  }, MESSAGE_DEBOUNCE_MS);

  pendingTextMessages.get(phone).timer = timer;
}

// Carga los IDs persistidos al arrancar (sobrevive reinicios de servidor)
function loadBotSentMessages() {
  try {
    if (fs.existsSync(BOT_MSG_IDS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(BOT_MSG_IDS_PATH, 'utf8'));
      const cutoff = Date.now() - BOT_MSG_ID_TTL_MS;
      let loaded = 0;
      for (const [id, data] of Object.entries(raw)) {
        if (data.timestamp > cutoff) {
          botSentMessageIds.set(id, data);
          loaded++;
        }
      }
      console.log(`📂 [BOT MSG IDS] Cargados ${loaded} IDs de mensajes del bot desde archivo`);
    }
  } catch (e) {
    console.log(`⚠️  [BOT MSG IDS] No se pudo cargar bot_sent_messages.json: ${e.message}`);
  }
}

function saveBotSentMessages() {
  try {
    const obj = {};
    for (const [id, data] of botSentMessageIds) {
      obj[id] = data;
    }
    fs.writeFileSync(BOT_MSG_IDS_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.log(`⚠️  [BOT MSG IDS] No se pudo guardar bot_sent_messages.json: ${e.message}`);
  }
}

function registerBotMessage(messageId, recipientPhone) {
  botSentMessageIds.set(messageId, { phone: recipientPhone, timestamp: Date.now() });
  // Limpiar entradas viejas (> 30 min) para no acumular memoria
  const cutoff = Date.now() - BOT_MSG_ID_TTL_MS;
  for (const [id, data] of botSentMessageIds) {
    if (data.timestamp < cutoff) botSentMessageIds.delete(id);
  }
  saveBotSentMessages();
}

function isHumanHandoffMessage(messageId) {
  return !botSentMessageIds.has(messageId);
}

// Cargar IDs persistidos al inicio
loadBotSentMessages();

// Función para enviar mensajes por WhatsApp usando API de Chakra
// Función para enviar indicador de "escribiendo..."
async function sendTypingIndicator(phoneNumber, action = 'typing_on') {
  // Limpiar número de teléfono
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  
  // CAPA DE SEGURIDAD: Verificar estado del bot ANTES de enviar cualquier indicador
  const botMode = getBotMode();
  console.log(`🔍 [TYPING CHECK] Modo del bot: ${botMode}, número: ${phoneNumber} (${cleanPhone})`);
  
  if (botMode === 'inactive') {
    console.log(`⏸️  [TYPING CHECK] Bot INACTIVO - Typing indicator BLOQUEADO`);
    return; // No enviar typing indicator si el bot está inactivo
  } else if (botMode === 'test') {
    const TEST_PHONE_FULL = '525521920710';
    const TEST_PHONE_SHORT = '5521920710';
    const exactMatchFull = cleanPhone === TEST_PHONE_FULL;
    const exactMatchShort = cleanPhone === TEST_PHONE_SHORT;
    const endsWithMatch = cleanPhone.length >= 10 && cleanPhone.length <= 12 && cleanPhone.endsWith(TEST_PHONE_SHORT);
    
    // Comparación por últimos dígitos (para manejar códigos de país diferentes)
    // El número puede venir como 5215521920710 (52 + 1 + 5521920710)
    // Necesitamos comparar los últimos 10 dígitos
    const last10Digits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const last10Match = last10Digits === TEST_PHONE_SHORT;
    
    const phoneMatches = exactMatchFull || exactMatchShort || endsWithMatch || last10Match;
    
    if (!phoneMatches) {
      console.log(`🧪 [TYPING CHECK] MODO DE PRUEBAS - Typing indicator BLOQUEADO para ${phoneNumber} (${cleanPhone})`);
      return; // No enviar typing indicator si no es el número de pruebas
    } else {
      console.log(`🧪 [TYPING CHECK] MODO DE PRUEBAS - Número permitido, enviando typing indicator`);
    }
  } else {
    console.log(`✅ [TYPING CHECK] Bot ACTIVO - Enviando typing indicator`);
  }
  
  try {
    // Verificar que tenemos los datos necesarios
    if (!CHAKRA_PLUGIN_ID || !whatsappPhoneNumberId) {
      // Si no tenemos los datos, simplemente retornar sin error (no crítico)
      return;
    }
    
    // Endpoint para typing indicator
    const endpoint = `https://api.chakrahq.com/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${CHAKRA_WHATSAPP_API_VERSION}/${whatsappPhoneNumberId}/messages`;
    
    // Payload para typing indicator según WhatsApp Business API
    const payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'typing',
      typing: {
        action: action // 'typing_on' o 'typing_off'
      }
    };
    
    // Intentar enviar el typing indicator (no crítico si falla)
    try {
      // Limpiar API key antes de usarlo
      const cleanApiKey = CHAKRA_API_KEY ? CHAKRA_API_KEY.trim().replace(/\s+/g, '') : '';
      
      await axios.post(
        endpoint,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${cleanApiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      if (action === 'typing_on') {
        console.log(`✍️  Indicador de "escribiendo..." activado para ${cleanPhone}`);
      }
    } catch (typingError) {
      // No es crítico si el typing indicator falla, solo loguear
      console.log(`⚠️  No se pudo enviar typing indicator (no crítico): ${typingError.message}`);
    }
  } catch (error) {
    // No lanzar error, solo loguear
    console.log(`⚠️  Error en sendTypingIndicator (no crítico): ${error.message}`);
  }
}

async function sendWhatsAppMessage(phoneNumber, message, options = {}) {
  // Limpiar número de teléfono (remover espacios, guiones, etc.)
  // Definir fuera del try para que esté disponible en el catch
  const cleanPhone = phoneNumber ? phoneNumber.replace(/\D/g, '') : 'unknown';
  
  // CAPA DE SEGURIDAD CRÍTICA: Verificar estado del bot ANTES de enviar cualquier mensaje
  const botMode = getBotMode();
  console.log(`\n🔍 ============================================`);
  console.log(`🔍 [SEND MSG CHECK] VERIFICACIÓN ANTES DE ENVIAR`);
  console.log(`🔍 ============================================`);
  console.log(`🔍 Modo del bot: "${botMode}"`);
  console.log(`🔍 Tipo: ${typeof botMode}`);
  console.log(`🔍 Enviando a: ${phoneNumber} (limpio: ${cleanPhone})`);
  
  // Validación estricta del modo
  const validModes = ['inactive', 'test', 'active'];
  if (!validModes.includes(botMode)) {
    console.error(`❌ [SEND MSG CHECK] Modo inválido: "${botMode}"`);
    console.error(`❌ [SEND MSG CHECK] Por seguridad, bloqueando mensaje`);
    console.log(`🔍 ============================================\n`);
    return { success: false, blocked: true, reason: 'invalid_mode' };
  }
  
  if (botMode === 'inactive') {
    console.log(`⏸️  ============================================`);
    console.log(`⏸️  [SEND MSG CHECK] Bot INACTIVO - MENSAJE BLOQUEADO`);
    console.log(`⏸️  ============================================`);
    console.log(`⏸️  NO se enviará el mensaje`);
    console.log(`⏸️  Return inmediato con blocked=true`);
    console.log(`⏸️  ============================================\n`);
    return { success: false, blocked: true, reason: 'bot_inactive' };
  } else if (botMode === 'test') {
    const TEST_PHONE_FULL = '525521920710';
    const TEST_PHONE_SHORT = '5521920710';
    const exactMatchFull = cleanPhone === TEST_PHONE_FULL;
    const exactMatchShort = cleanPhone === TEST_PHONE_SHORT;
    const endsWithMatch = cleanPhone.length >= 10 && cleanPhone.length <= 12 && cleanPhone.endsWith(TEST_PHONE_SHORT);
    
    // Comparación por últimos dígitos (para manejar códigos de país diferentes)
    // El número puede venir como 5215521920710 (52 + 1 + 5521920710)
    // Necesitamos comparar los últimos 10 dígitos
    const last10Digits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const last10Match = last10Digits === TEST_PHONE_SHORT;
    
    const phoneMatches = exactMatchFull || exactMatchShort || endsWithMatch || last10Match;
    
    if (!phoneMatches) {
      console.log(`🧪 ============================================`);
      console.log(`🧪 [SEND MSG CHECK] MODO DE PRUEBAS - MENSAJE BLOQUEADO`);
      console.log(`🧪 ============================================`);
      console.log(`🧪 Número: ${phoneNumber} (limpio: ${cleanPhone})`);
      console.log(`🧪 NO se enviará el mensaje`);
      console.log(`🧪 Return inmediato con blocked=true`);
      console.log(`🧪 ============================================\n`);
      return { success: false, blocked: true, reason: 'test_mode_active' };
    } else {
      console.log(`🧪 [SEND MSG CHECK] MODO DE PRUEBAS - Número permitido, enviando mensaje`);
    }
  } else {
    console.log(`✅ [SEND MSG CHECK] Bot ACTIVO - Enviando mensaje`);
  }
  console.log(`🔍 ============================================\n`);
  
  try {
    // Verificar que tenemos los datos necesarios
    console.log(`🔍 [SEND MSG] Verificando credenciales de Chakra...`);
    console.log(`🔍 [SEND MSG] CHAKRA_API_KEY existe?: ${!!CHAKRA_API_KEY}`);
    console.log(`🔍 [SEND MSG] CHAKRA_API_KEY length: ${CHAKRA_API_KEY ? CHAKRA_API_KEY.trim().length : 0}`);
    console.log(`🔍 [SEND MSG] CHAKRA_PLUGIN_ID existe?: ${!!CHAKRA_PLUGIN_ID}`);
    console.log(`🔍 [SEND MSG] CHAKRA_PLUGIN_ID value: ${CHAKRA_PLUGIN_ID ? CHAKRA_PLUGIN_ID.trim() : 'null'}`);
    console.log(`🔍 [SEND MSG] CHAKRA_PLUGIN_ID length: ${CHAKRA_PLUGIN_ID ? CHAKRA_PLUGIN_ID.trim().length : 0}`);
    
    if (!CHAKRA_API_KEY || CHAKRA_API_KEY.trim().length === 0) {
      throw new Error('CHAKRA_API_KEY no está configurado. Configúralo en Railway → Variables.');
    }
    
    if (!CHAKRA_PLUGIN_ID || CHAKRA_PLUGIN_ID.trim().length === 0) {
      console.error(`❌ [SEND MSG] CHAKRA_PLUGIN_ID no está configurado o está vacío`);
      console.error(`❌ [SEND MSG] Valor actual: "${CHAKRA_PLUGIN_ID}"`);
      console.error(`❌ [SEND MSG] Verifica en Railway → Variables que CHAKRA_PLUGIN_ID esté configurado`);
      throw new Error('CHAKRA_PLUGIN_ID no está configurado. Obtén el Plugin ID del panel de Chakra.');
    }
    
    if (!whatsappPhoneNumberId) {
      throw new Error('whatsappPhoneNumberId no está disponible. Espera recibir un mensaje primero para obtenerlo del webhook.');
    }
    
    // Endpoint correcto según documentación de Chakra
    const endpoint = `https://api.chakrahq.com/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${CHAKRA_WHATSAPP_API_VERSION}/${whatsappPhoneNumberId}/messages`;
    
    let payload;
    
    // Si hay botones, enviar mensaje interactivo
    if (options.buttons && options.buttons.length > 0) {
      // WhatsApp permite máximo 3 botones
      const buttons = options.buttons.slice(0, 3).map((btn, index) => ({
        type: 'reply',
        reply: {
          id: btn.id || `btn_${index}`,
          title: btn.title || btn.text
        }
      }));
      
      payload = {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: message
          },
          action: {
            buttons: buttons
          }
        }
      };
    } else {
      // Mensaje de texto normal
      payload = {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: {
          body: message
        }
      };
    }
    
    // Log solo si hay error o para debugging importante
    
    // Validar y limpiar API key antes de usarlo
    if (!CHAKRA_API_KEY || CHAKRA_API_KEY.trim().length === 0) {
      throw new Error('CHAKRA_API_KEY no está configurado o está vacío');
    }
    
    const cleanApiKey = CHAKRA_API_KEY.trim().replace(/\s+/g, '');
    
    const response = await axios.post(
      endpoint,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${cleanApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Detener typing indicator después de enviar el mensaje
    // (el mensaje real debería detenerlo automáticamente, pero por si acaso)
    await sendTypingIndicator(cleanPhone, 'typing_off');

    // Registrar cuándo el bot envió a este teléfono (para ventana de gracia anti race-condition)
    botLastSentAt.set(cleanPhone, Date.now());

    // Registrar el ID del mensaje enviado por el bot para detectar intervención humana
    const sentMsgId = response.data?.messages?.[0]?.id;
    if (sentMsgId) {
      registerBotMessage(sentMsgId, cleanPhone);
      console.log(`📝 [BOT MSG ID] Registrado ID: ${sentMsgId} para ${cleanPhone}`);
    } else {
      console.warn(`⚠️  [BOT MSG ID] No se pudo extraer ID del mensaje. response.data keys: ${Object.keys(response.data || {}).join(', ')} | data: ${JSON.stringify(response.data).slice(0, 200)}`);
    }

    return response.data;
    
  } catch (error) {
    console.error(`❌ Error enviando mensaje a ${cleanPhone}`);
    
    // Mostrar información detallada del error
    if (error.response) {
      // Error de respuesta HTTP
      const status = error.response.status;
      console.error(`   HTTP ${status}: ${error.response.statusText}`);
      
      if (status === 401) {
        console.error(`   ⚠️  ERROR DE AUTENTICACIÓN`);
        console.error(`   El API key de Chakra no es válido o no tiene permisos`);
        console.error(`   Verifica en Railway → Variables que CHAKRA_API_KEY sea correcto`);
        console.error(`   Verifica en Chakra que el API key tenga permisos de "Chakra Bot"`);
      }
      
      if (error.response.data) {
        try {
          const errorData = typeof error.response.data === 'string' 
            ? error.response.data 
            : JSON.stringify(error.response.data, null, 2);
          console.error(`   Respuesta: ${errorData.substring(0, 500)}`);
        } catch (e) {
          console.error(`   Respuesta: ${String(error.response.data).substring(0, 200)}`);
        }
      }
    } else if (error.request) {
      // Error de red (no hubo respuesta)
      console.error(`   Error de red: No se recibió respuesta del servidor`);
      console.error(`   Request: ${error.request.method || 'POST'} ${endpoint}`);
    } else {
      // Otro tipo de error
      console.error(`   Error: ${error.message || String(error)}`);
      if (error.stack) {
        console.error(`   Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
      }
    }
    
    throw error;
  }
}

// Endpoint raíz para verificar que el servidor está funcionando
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Bot de WhatsApp funcionando',
    endpoints: {
      test: '/api/test',
      checkSlots: '/api/check-slots/:date',
      checkAppointments: '/api/check-appointments/:date',
      logs: '/api/logs',
      stats: '/api/stats',
      analytics: '/api/analytics',
      webhook: '/webhook (POST para recibir mensajes, GET para verificación)',
      webhookTest: '/api/webhook-test (para probar el webhook)'
    },
    timestamp: new Date().toISOString(),
    botMode: getBotMode()
  });
});

// Endpoint de prueba para verificar que el webhook está accesible
app.get('/api/webhook-test', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Webhook endpoint está accesible',
    instructions: {
      step1: 'Configura el webhook en Chakra con esta URL:',
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook`,
      step2: 'El webhook debe aceptar POST requests',
      step3: 'Suscríbete a los eventos de mensajes',
      step4: 'Verifica que Chakra pueda acceder a esta URL'
    },
    currentBotMode: getBotMode(),
    timestamp: new Date().toISOString()
  });
});

// Endpoint para recibir pruebas del webhook
app.post('/api/webhook-test', (req, res) => {
  console.log('\n🧪 ============================================');
  console.log('🧪 WEBHOOK TEST - POST RECIBIDO');
  console.log('🧪 ============================================');
  console.log('🧪 Body recibido:', JSON.stringify(req.body, null, 2));
  console.log('🧪 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🧪 ============================================\n');
  
  res.json({
    status: 'ok',
    message: 'Webhook test recibido correctamente',
    receivedData: req.body,
    timestamp: new Date().toISOString()
  });
});

// Endpoint de diagnóstico del webhook
app.get('/api/webhook-status', (req, res) => {
  const botMode = getBotMode();
  // CRITICAL: Railway siempre usa HTTPS, forzar HTTPS en la URL
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.get('host') || req.headers.host;
  const webhookUrl = `https://${host}/webhook`;
  const testUrl = `https://${host}/api/webhook-test`;
  
  res.json({
    status: 'ok',
    webhookEndpoint: '/webhook',
    currentBotMode: botMode,
    webhookAccessible: true,
    webhookUrl: webhookUrl,
    instructions: {
      step1: '⚠️ IMPORTANTE: El bot está en modo "' + botMode + '"',
      step1a: botMode === 'inactive' ? 'Cambia el modo a "active" o "test" en el dashboard para que responda' : 'El bot debería responder si recibe mensajes',
      step2: 'Configura el webhook en Chakra con esta URL (HTTPS):',
      webhookUrl: webhookUrl,
      step3: 'Prueba el webhook manualmente con:',
      testCommand: `curl -X POST ${testUrl} -H "Content-Type: application/json" -d '{"test": "data"}'`,
      step4: 'Si no ves logs cuando envías mensajes, Chakra no está enviando al webhook',
      step5: 'Verifica en el panel de Chakra si hay errores del webhook'
    },
    troubleshooting: {
      noLogs: 'Si no ves logs "🌐 WEBHOOK POST RECIBIDO", Chakra no está enviando mensajes',
      solution: 'Reconfigura el webhook en Chakra o verifica que esté activo',
      checkChakra: 'Revisa el panel de Chakra para ver si hay errores del webhook',
      botInactive: botMode === 'inactive' ? 'El bot está inactivo. Cámbialo a "active" o "test" en el dashboard.' : null
    },
    timestamp: new Date().toISOString()
  });
});

// Serve index.html at /dashboard (para no interferir con el endpoint raíz)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Human Handoff: pausar/reanudar bot por agente humano ───────────────────

// Pausa el bot para una conversación (el agente humano toma el control)
app.post('/admin/pause-bot', (req, res) => {
  const { phone, minutes = 120 } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Se requiere el campo "phone"' });
  }

  const pauseUntil = new Date(Date.now() + minutes * 60 * 1000);
  sessions.updateSession(phone, { bot_paused_until: pauseUntil.toISOString() });
  sessions.addToHistory(phone, 'system_event', `⏸ Bot pausado por el equipo (${minutes} min)`);
  cancelPendingMessages(phone);

  console.log(`⏸️  Bot pausado para ${phone} hasta ${pauseUntil.toISOString()} (${minutes} min)`);
  res.json({ ok: true, phone, paused_until: pauseUntil.toISOString(), minutes });
});

// Reanuda el bot manualmente antes de que expire el tiempo
app.post('/admin/resume-bot', (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Se requiere el campo "phone"' });
  }

  sessions.updateSession(phone, { bot_paused_until: null });
  sessions.addToHistory(phone, 'system_event', '▶ Bot reactivado por el equipo');

  console.log(`▶️  Bot reanudado manualmente para ${phone}`);
  res.json({ ok: true, phone });
});

// Consulta el estado de pausa de una conversación
app.get('/admin/pause-status/:phone', (req, res) => {
  const phone = req.params.phone;
  const session = sessions.getSession(phone);

  const paused = session.bot_paused_until && new Date(session.bot_paused_until) > new Date();
  res.json({
    phone,
    paused: !!paused,
    paused_until: session.bot_paused_until || null
  });
});

// ────────────────────────────────────────────────────────────────────────────

// Verificación del webhook (GET) - Chakra puede requerir esto
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Algunos BSPs usan verificación similar a Meta
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    // Si no hay parámetros de verificación, responder 200
    res.sendStatus(200);
  }
});

// Webhook para recibir mensajes de WhatsApp (POST) - Formato Chakra/WhatsApp Cloud API
app.post('/webhook', async (req, res) => {
  // CRITICAL: Asegurar que siempre respondemos, incluso si hay errores
  // Esto es importante para que Chakra no deje de enviar mensajes
  let responseSent = false;
  
  const sendResponse = (status, data) => {
    if (!responseSent) {
      responseSent = true;
      if (data) {
        res.status(status).json(data);
      } else {
        res.sendStatus(status);
      }
    }
  };
  
  // CRITICAL: Logging inmediato para verificar que el webhook está recibiendo requests
  console.log('\n🌐 ============================================');
  console.log('🌐 WEBHOOK POST RECIBIDO - PRIMERA LÍNEA');
  console.log('🌐 ============================================');
  console.log('🌐 Timestamp:', new Date().toISOString());
  console.log('🌐 Method:', req.method);
  console.log('🌐 URL:', req.url);
  console.log('🌐 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🌐 Body type:', typeof req.body);
  console.log('🌐 Body keys:', req.body ? Object.keys(req.body) : 'null');
  console.log('🌐 Body (primeros 500 chars):', req.body ? JSON.stringify(req.body).substring(0, 500) : 'null');
  console.log('🌐 ============================================\n');
  
  // CRITICAL: Verificar estado del bot INMEDIATAMENTE, antes de cualquier procesamiento
  // Si está inactive, responder 200 OK y terminar SIN procesar nada
  // Si está en modo test, verificar el número antes de procesar
  try {
    const botMode = getBotMode();
    const isInactive = String(botMode).trim().toLowerCase() === 'inactive';
    const isTestMode = String(botMode).trim().toLowerCase() === 'test';
    
    if (isInactive) {
      console.log('\n⏸️  ============================================');
      console.log('⏸️  BOT INACTIVO - WEBHOOK BLOQUEADO INMEDIATAMENTE');
      console.log('⏸️  ============================================');
      console.log('⏸️  Modo detectado:', botMode);
      console.log('⏸️  Respondiendo 200 OK sin procesar mensaje');
      console.log('⏸️  NO se procesará ningún mensaje');
      console.log('⏸️  ============================================\n');
      // Responder inmediatamente y terminar
      sendResponse(200, { status: 'ok', message: 'Bot inactive, message ignored' });
      return;
    }
    
    // Si está en modo test, verificar el número ANTES de procesar
    if (isTestMode) {
      // Extraer el número del remitente del body
      let senderPhone = null;
      const body = req.body;
      
      // Intentar extraer el número de diferentes formatos
      if (body.object === 'whatsapp_business_account' && body.entry) {
        for (const entry of body.entry) {
          const changes = entry.changes || [];
          for (const change of changes) {
            const value = change.value || {};
            const messages = value.messages || [];
            if (messages.length > 0) {
              senderPhone = messages[0].from || messages[0].wa_id;
              break;
            }
          }
          if (senderPhone) break;
        }
      } else if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
        senderPhone = body.messages[0].from || body.messages[0].wa_id;
      } else if (body.from) {
        senderPhone = body.from;
      }
      
      // Si no hay senderPhone, verificar si es un status update (no un mensaje real)
      if (!senderPhone && body.object === 'whatsapp_business_account' && body.entry) {
        const isStatusUpdate = body.entry.some(entry =>
          (entry.changes || []).some(change => {
            const statuses = (change.value || {}).statuses;
            return statuses && statuses.length > 0;
          })
        );
        if (isStatusUpdate) {
          // Status updates (sent/delivered/read) se ignoran silenciosamente
          sendResponse(200, { status: 'ok' });
          return;
        }
      }

      if (senderPhone) {
        const cleanPhone = senderPhone.replace(/\D/g, '');
        const TEST_PHONE_FULL = '525521920710';
        const TEST_PHONE_SHORT = '5521920710';
        
        // Comparaciones exactas
        const exactMatchFull = cleanPhone === TEST_PHONE_FULL;
        const exactMatchShort = cleanPhone === TEST_PHONE_SHORT;
        
        // Comparación por terminación (últimos 10 dígitos)
        const endsWithMatch = cleanPhone.length >= 10 && cleanPhone.endsWith(TEST_PHONE_SHORT);
        
        // Comparación por últimos dígitos (para manejar códigos de país diferentes)
        // El número puede venir como 5215521920710 (52 + 1 + 5521920710)
        // Necesitamos comparar los últimos 10 dígitos
        const last10Digits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
        const last10Match = last10Digits === TEST_PHONE_SHORT;
        
        const phoneMatches = exactMatchFull || exactMatchShort || endsWithMatch || last10Match;
        
        console.log('\n🧪 ============================================');
        console.log('🧪 MODO DE PRUEBAS - VERIFICACIÓN EN WEBHOOK');
        console.log('🧪 ============================================');
        console.log('🧪 Número recibido (raw):', senderPhone);
        console.log('🧪 Número limpio:', cleanPhone);
        console.log('🧪 Longitud del número limpio:', cleanPhone.length);
        console.log('🧪 Número permitido FULL:', TEST_PHONE_FULL);
        console.log('🧪 Número permitido SHORT:', TEST_PHONE_SHORT);
        console.log('🧪 Comparaciones detalladas:');
        console.log(`🧪   - exactMatchFull (${cleanPhone} === ${TEST_PHONE_FULL}): ${exactMatchFull}`);
        console.log(`🧪   - exactMatchShort (${cleanPhone} === ${TEST_PHONE_SHORT}): ${exactMatchShort}`);
        console.log(`🧪   - endsWithMatch (endsWith ${TEST_PHONE_SHORT}): ${endsWithMatch} (length: ${cleanPhone.length}, range: 10-12)`);
        console.log(`🧪   - phoneMatches (resultado final): ${phoneMatches}`);
        console.log('🧪 ============================================');
        
        if (!phoneMatches) {
          console.log('🧪 🚫 BLOQUEADO - No es el número de pruebas');
          console.log('🧪 Respondiendo 200 OK sin procesar mensaje');
          console.log('🧪 ============================================\n');
          sendResponse(200, { status: 'ok', message: 'Test mode active, number not allowed' });
          return;
        } else {
          console.log('🧪 ✅ PERMITIDO - Es el número de pruebas');
          console.log('🧪 Continuando con el procesamiento...');
          console.log('🧪 ============================================\n');
        }
      } else {
        console.log('🧪 ⚠️  ============================================');
        console.log('🧪 ⚠️  No se pudo extraer el número del remitente');
        console.log('🧪 ⚠️  Body recibido:', JSON.stringify(req.body, null, 2));
        console.log('🧪 ⚠️  Continuando con procesamiento (puede fallar)...');
        console.log('🧪 ⚠️  ============================================\n');
      }
    }
  } catch (error) {
    // Si hay error leyendo el estado, por seguridad NO procesar
    console.error('❌ Error leyendo estado del bot en webhook:', error);
    console.error('   Stack:', error.stack);
    console.error('   Por seguridad, NO procesando mensaje');
    // IMPORTANTE: Responder 200 OK para que Chakra no reintente, pero loguear el error
    sendResponse(200, { status: 'ok', message: 'Error reading bot status, message ignored' });
    return;
  }
  
  // CRITICAL: Asegurar que siempre respondemos 200 OK al final, incluso si hay errores
  // Pero primero procesamos el mensaje si pasó las verificaciones
  try {
    const body = req.body;
    
    console.log('\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨');
    console.log('🚨 WEBHOOK RECIBIDO - INICIO');
    console.log('🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨');
    console.log('📥 ============================================');
    console.log('📥 WEBHOOK RECIBIDO DE CHAKRA');
    console.log('📥 ============================================');
    console.log('📥 Timestamp:', new Date().toISOString());
    console.log('📥 Body completo:', JSON.stringify(body, null, 2));
    console.log('📥 Headers:', JSON.stringify(req.headers, null, 2));
    console.log('📥 ============================================');

    // Formato estándar WhatsApp Cloud API (usado por Chakra)
    // Puede venir en formato: { object: 'whatsapp_business_account', entry: [...] }
    // O formato simplificado: { messages: [...] }
    
    let messages = [];

    // Formato estándar WhatsApp Cloud API (Meta/Chakra)
    if (body.object === 'whatsapp_business_account' && body.entry) {
      for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.value) {
            // Extraer phone_number_id del webhook para usarlo en el endpoint
            if (change.value.metadata && change.value.metadata.phone_number_id) {
              whatsappPhoneNumberId = change.value.metadata.phone_number_id;
              if (change.value.metadata.display_phone_number) {
                businessDisplayPhone = change.value.metadata.display_phone_number.replace(/\D/g, '');
              }
              console.log(`📱 Phone Number ID extraído: ${whatsappPhoneNumberId}, business phone: ${businessDisplayPhone}`);
            }
            
            if (change.value.messages) {
              messages = messages.concat(change.value.messages);
            }
            
            // Manejar statuses (estados de mensajes enviados)
            if (change.value.statuses && Array.isArray(change.value.statuses)) {
              for (const status of change.value.statuses) {
                const recipientId = status.recipient_id;
                const messageStatus = status.status;
                const messageId = status.id;
                
                console.log(`📊 Estado de mensaje: ${messageStatus} para ${recipientId} (ID: ${messageId})`);

                // Si el mensaje falló, verificar si es el admin y notificar
                if (messageStatus === 'failed' && status.errors && status.errors.length > 0) {
                  const error = status.errors[0];
                  console.error(`❌ Mensaje falló para ${recipientId}:`, error);
                  
                  // Verificar si es el admin (comparar números limpios)
                  const adminPhoneClean = ADMIN_PHONE.replace(/\D/g, '');
                  const recipientClean = recipientId.replace(/\D/g, '');
                  
                  if (recipientClean === adminPhoneClean) {
                    console.error(`\n⚠️  ============================================`);
                    console.error(`⚠️  MENSAJE AL ADMIN FALLÓ`);
                    console.error(`   Admin: ${ADMIN_PHONE} (${adminPhoneClean})`);
                    console.error(`   Error Code: ${error.code}`);
                    console.error(`   Error: ${error.message}`);
                    if (error.error_data?.details) {
                      console.error(`   Detalles: ${error.error_data.details}`);
                    }
                    console.error(`   ⚠️  El admin necesita enviar un mensaje al bot para reanudar la conversación.`);
                    console.error(`============================================\n`);
                    
                    // Opcional: Guardar en una variable para mostrar al usuario
                    // Por ahora solo logueamos
                  }
                }
              }
            }
          }
        }
      }
    }
    // Formato alternativo (si Chakra envía directamente)
    else if (body.messages && Array.isArray(body.messages)) {
      console.log('📥 Formato alternativo detectado: body.messages');
      messages = body.messages;
    }
    // Formato directo (un solo mensaje)
    else if (body.from && body.text) {
      console.log('📥 Formato directo detectado: body.from y body.text');
      messages = [body];
    }
    else {
      console.log('⚠️  Formato de webhook no reconocido. Body keys:', Object.keys(body));
      console.log('⚠️  Body completo:', JSON.stringify(body, null, 2));
    }

    console.log(`📥 Total de mensajes encontrados en webhook: ${messages.length}`);
    
    if (messages.length === 0) {
      console.log('⚠️  No se encontraron mensajes en el webhook. Body recibido:', JSON.stringify(body, null, 2));
    }
    
    // Procesar cada mensaje
    for (const message of messages) {
      const senderPhone = message.from || message.wa_id;
      
      console.log(`📨 Procesando mensaje - Tipo: ${message.type}, De: ${senderPhone}, Contenido:`, JSON.stringify(message, null, 2));
      
      // Manejar mensajes de texto
      if (message.type === 'text' || message.text) {
        const incomingMessage = message.text?.body || message.text || message.body;
        
        if (senderPhone && incomingMessage) {
          console.log(`\n📨 ============================================`);
          console.log(`📨 MENSAJE DE TEXTO RECIBIDO EN WEBHOOK`);
          console.log(`📨 ============================================`);
          console.log(`📨 De: ${senderPhone}`);
          console.log(`📨 Mensaje: ${incomingMessage}`);
          console.log(`📨 Timestamp: ${new Date().toISOString()}`);
          console.log(`📨 ============================================\n`);
          
          // CRITICAL: Verificar estado del bot ANTES de procesar
          console.log(`🔍 [WEBHOOK CHECK] Iniciando verificación del modo del bot...`);
          const botMode = getBotMode();
          const cleanPhone = senderPhone.replace(/\D/g, '');
          const isInactive = String(botMode).trim().toLowerCase() === 'inactive';
          
          console.log(`🔍 [WEBHOOK CHECK] ============================================`);
          console.log(`🔍 [WEBHOOK CHECK] Verificación antes de processIncomingMessage`);
          console.log(`🔍 [WEBHOOK CHECK] Modo del bot leído: "${botMode}"`);
          console.log(`🔍 [WEBHOOK CHECK] Tipo: ${typeof botMode}`);
          console.log(`🔍 [WEBHOOK CHECK] Comparación: String("${botMode}").trim().toLowerCase() === 'inactive'`);
          console.log(`🔍 [WEBHOOK CHECK] Resultado: ${isInactive}`);
          console.log(`🔍 [WEBHOOK CHECK] ============================================\n`);
          
          if (isInactive) {
            console.log(`⏸️  ============================================`);
            console.log(`⏸️  [WEBHOOK CHECK] BOT INACTIVO - BLOQUEO EN WEBHOOK`);
            console.log(`⏸️  ============================================`);
            console.log(`⏸️  NO se llamará a processIncomingMessage`);
            console.log(`⏸️  NO se procesará el mensaje`);
            console.log(`⏸️  Mensaje bloqueado completamente`);
            console.log(`⏸️  ============================================\n`);

            continue; // Saltar este mensaje y continuar con el siguiente (si hay)
          }
          
          console.log(`✅ [WEBHOOK CHECK] Bot no está inactive, continuando con scheduleTextMessage...\n`);

          // Ignorar echoes (mensajes salientes del negocio hacia el cliente)
          const senderClean = senderPhone.replace(/\D/g, '');
          const isBizEcho = businessDisplayPhone && senderClean === businessDisplayPhone;
          if (isBizEcho) {
            console.log(`📤 [ECHO] Mensaje saliente del negocio ignorado — no se procesa como mensaje de cliente`);
            continue;
          }

          // Ignorar mensajes del staff (matching por sufijo)
          const isStaff = STAFF_PHONES.some(suffix => senderClean.endsWith(suffix));
          if (isStaff) {
            console.log(`👥 [STAFF] Mensaje de número del staff ignorado: ${senderClean}`);
            continue;
          }

          // Ignorar clientes existentes (ya pasaron por el flujo inicial)
          const isExistingClient = EXISTING_CLIENTS.some(suffix => senderClean.endsWith(suffix));
          if (isExistingClient) {
            console.log(`🔕 [CLIENTE EXISTENTE] Número ignorado: ${senderClean}`);
            continue;
          }

          // Usar debounce para agrupar mensajes rápidos del mismo número
          // (evita respuestas duplicadas cuando el usuario envía varios textos en ráfaga)
          scheduleTextMessage(senderPhone, incomingMessage, {});
        } else {
          console.log(`⚠️  Mensaje de texto sin senderPhone o incomingMessage. senderPhone: ${senderPhone}, incomingMessage: ${incomingMessage}`);
        }
      }
      // Manejar imágenes (recibos de pago, fotos, etc.) → escalar a humano
      else if (message.type === 'image') {
        const caption = message.image?.caption || '';
        const descripcion = caption
          ? `Imagen recibida: "${caption}"`
          : 'El usuario envió una imagen (posiblemente un recibo de pago u otro documento)';

        console.log(`🖼️  Imagen recibida de ${senderPhone}. Caption: "${caption}". Agrupando con debounce...`);

        // Obtener sesión para contexto
        const imgSession = sessions.getSession(senderPhone) || {};
        const clientName = imgSession.nombre_cliente || imgSession.nombre || '';

        // Agrupar con debounce igual que los mensajes de texto:
        // si el usuario manda varias imágenes seguidas, se responde una sola vez.
        scheduleImageMessage(senderPhone, descripcion, {
          clientName,
          historial: imgSession.historial || []
        });
      }
      // Manejar respuestas de botones interactivos
      else if (message.type === 'interactive' && message.interactive) {
        const interactive = message.interactive;
        
        if (interactive.type === 'button_reply') {
          const buttonId = interactive.button_reply?.id;
          const buttonTitle = interactive.button_reply?.title;
          
          console.log(`🔘 Botón presionado por ${senderPhone}: ${buttonId} - "${buttonTitle}"`);
          
          // CRITICAL: Verificar estado del bot ANTES de procesar botón
          const botMode = getBotMode();
          const isInactive = String(botMode).trim().toLowerCase() === 'inactive';
          
          console.log(`🔍 [WEBHOOK CHECK] Verificación antes de processIncomingMessage (botón)`);
          console.log(`🔍 [WEBHOOK CHECK] Modo del bot: "${botMode}"`);
          console.log(`🔍 [WEBHOOK CHECK] ¿Es inactive?: ${isInactive}`);
          
          if (isInactive) {
            console.log(`⏸️  [WEBHOOK CHECK] Bot INACTIVO - NO se procesará el botón`);
            return; // No procesar el botón
          }
          
          // Procesar la respuesta del botón como si fuera un mensaje de texto
          // El botón puede tener un ID como "slot_0", "slot_1", etc.
          if (senderPhone && buttonId) {
            processIncomingMessage(senderPhone, buttonId, { isButtonClick: true, buttonTitle }).catch(error => {
              // Si el error es porque el bot está inactivo, no es un error real
              if (error.message === 'BOT_INACTIVE_BLOCKED' || error.message === 'BOT_TEST_MODE_BLOCKED' || error.message === 'BOT_INVALID_MODE_BLOCKED') {
                console.log(`⏸️  Botón bloqueado correctamente - ${error.message}`);
                return; // No loguear como error
              }
              console.error('Error procesando respuesta de botón:', error);
            });
          }
        }
      }
      // Manejar mensajes tipo "button" — llegan cuando el usuario hace clic en un
      // anuncio de Meta Ads con mensaje preescrito (CTWA / Click-To-WhatsApp).
      // El payload tiene: message.type === 'button', message.button.text (el texto del botón)
      else if (message.type === 'button') {
        const buttonText = message.button?.text || '';
        console.log(`📣 [META ADS] Mensaje tipo 'button' recibido de ${senderPhone}: "${buttonText}"`);

        if (senderPhone && buttonText) {
          const botMode = getBotMode();
          const isInactive = String(botMode).trim().toLowerCase() === 'inactive';
          if (isInactive) {
            console.log(`⏸️  [META ADS] Bot inactivo — mensaje de anuncio ignorado`);
          } else {
            // Tratar como mensaje de texto normal (con debounce)
            scheduleTextMessage(senderPhone, buttonText, {});
          }
        }
      }
    }

    // Responder 200 inmediatamente para confirmar recepción
    sendResponse(200);
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    console.error('   Stack:', error.stack);
    // CRITICAL: Siempre responder 200 OK para que Chakra no deje de enviar
    // Si respondemos 500, Chakra puede dejar de enviar mensajes
    sendResponse(200, { status: 'ok', message: 'Error processing webhook, but acknowledged' });
  }
});

// Sistema unificado de estado del bot
// Modos: 'inactive' (inactivo), 'test' (solo +525521920710), 'active' (todos)
function getBotMode() {
  try {
    // CRITICAL: Usar path absoluto para Railway
    const statusPath = path.join(__dirname, 'bot_status.json');
    console.log(`🔍 [GET BOT MODE] Leyendo archivo: ${statusPath}`);
    console.log(`🔍 [GET BOT MODE] __dirname: ${__dirname}`);
    console.log(`🔍 [GET BOT MODE] ¿Existe?: ${fs.existsSync(statusPath)}`);
    
    if (fs.existsSync(statusPath)) {
      const statusData = fs.readFileSync(statusPath, 'utf8');
      console.log(`🔍 [GET BOT MODE] Contenido del archivo (raw): ${statusData}`);
      const status = JSON.parse(statusData);
      console.log(`🔍 [GET BOT MODE] status.mode: ${status.mode}, status.active: ${status.active}`);
      
      // CRITICAL: Priorizar el campo 'mode' sobre 'active'
      // Si existe 'mode', usarlo. Si no, migrar desde 'active'
      let mode = null;
      
      if (status.mode && typeof status.mode === 'string') {
        // Formato nuevo: usar 'mode'
        mode = status.mode.trim().toLowerCase();
        console.log(`✅ [GET BOT MODE] Modo encontrado en campo 'mode': "${mode}"`);
      } else if (status.active !== undefined) {
        // Formato antiguo: migrar desde 'active'
        mode = status.active ? 'active' : 'inactive';
        console.log(`⚠️  [GET BOT MODE] Formato antiguo detectado (solo 'active'), migrando: active=${status.active} -> mode="${mode}"`);
        // CRITICAL: Actualizar el archivo al nuevo formato para evitar confusión
        try {
          const updatedStatus = { mode, updatedAt: new Date().toISOString() };
          fs.writeFileSync(statusPath, JSON.stringify(updatedStatus, null, 2), 'utf8');
          console.log(`✅ [GET BOT MODE] Archivo migrado al nuevo formato`);
        } catch (migrateError) {
          console.warn(`⚠️  [GET BOT MODE] No se pudo migrar el archivo: ${migrateError.message}`);
        }
      }
      
      // Validar que el modo sea uno de los valores permitidos
      if (mode && ['inactive', 'test', 'active'].includes(mode)) {
        console.log(`✅ [GET BOT MODE] Modo válido retornado: "${mode}"`);
        return mode;
      } else {
        console.warn(`⚠️  [GET BOT MODE] Modo inválido o no encontrado: "${mode}", usando por defecto: 'inactive' (SEGURIDAD)`);
        return 'inactive'; // Por defecto INACTIVE por seguridad
      }
    }
    // Si el archivo no existe, crearlo con valor por defecto 'inactive'
    console.log(`⚠️  [GET BOT MODE] Archivo no existe, creando con valor por defecto: 'inactive' (SEGURIDAD)`);
    try {
      const defaultStatus = { 
        mode: 'inactive', 
        updatedAt: new Date().toISOString() 
      };
      fs.writeFileSync(statusPath, JSON.stringify(defaultStatus, null, 2), 'utf8');
      console.log(`✅ [GET BOT MODE] Archivo creado con valor por defecto: 'inactive'`);
      return 'inactive';
    } catch (createError) {
      console.error('❌ [GET BOT MODE] Error creando archivo por defecto:', createError);
      console.warn(`⚠️  [GET BOT MODE] Usando valor por defecto en memoria: 'inactive' (SEGURIDAD)`);
      return 'inactive'; // Por defecto INACTIVE por seguridad
    }
  } catch (error) {
    console.error('❌ [GET BOT MODE] Error leyendo estado del bot:', error);
    console.error('   Stack:', error.stack);
    console.warn(`⚠️  [GET BOT MODE] Error en lectura, usando por defecto: 'inactive' (SEGURIDAD)`);
    return 'inactive'; // Por defecto INACTIVE por seguridad si hay error
  }
}

// Función para guardar el estado del bot
function setBotMode(mode) {
  try {
    console.log(`\n💾 ============================================`);
    console.log(`💾 SET BOT MODE - GUARDANDO ESTADO`);
    console.log(`💾 ============================================`);
    console.log(`💾 Modo recibido: "${mode}"`);
    console.log(`💾 Tipo: ${typeof mode}`);
    
    if (!['inactive', 'test', 'active'].includes(mode)) {
      console.error(`❌ Modo inválido: ${mode}. Debe ser 'inactive', 'test', o 'active'`);
      return false;
    }
    
    const statusPath = path.join(__dirname, 'bot_status.json');
    
    // CRITICAL: Limpiar el archivo - solo guardar 'mode', eliminar 'active' si existe
    const statusData = { 
      mode, 
      updatedAt: new Date().toISOString() 
    };
    // NO incluir 'active' para evitar confusión
    
    const jsonData = JSON.stringify(statusData, null, 2);
    console.log(`💾 Datos a escribir (SOLO 'mode', sin 'active'): ${jsonData}`);
    
    fs.writeFileSync(statusPath, jsonData, 'utf8');
    console.log(`💾 Archivo escrito en: ${statusPath}`);
    
    // Verificar que se escribió correctamente
    if (fs.existsSync(statusPath)) {
      const verifyData = fs.readFileSync(statusPath, 'utf8');
      const verifyStatus = JSON.parse(verifyData);
      console.log(`💾 Verificación: archivo existe`);
      console.log(`💾 Contenido verificado: ${verifyData}`);
      console.log(`💾 Modo verificado: ${verifyStatus.mode}`);
      console.log(`💾 ¿Tiene campo 'active'?: ${verifyStatus.active !== undefined ? 'SÍ (PROBLEMA)' : 'NO (correcto)'}`);
      
      // CRITICAL: Si el archivo tiene 'active', eliminarlo
      if (verifyStatus.active !== undefined) {
        console.warn(`⚠️  Archivo tiene campo 'active' residual, limpiando...`);
        const cleanedStatus = { mode: verifyStatus.mode || mode, updatedAt: verifyStatus.updatedAt || new Date().toISOString() };
        fs.writeFileSync(statusPath, JSON.stringify(cleanedStatus, null, 2), 'utf8');
        console.log(`✅ Archivo limpiado - solo tiene 'mode' ahora`);
      }
      
      if (verifyStatus.mode === mode) {
        const modeNames = {
          'inactive': 'INACTIVO',
          'test': 'MODO DE PRUEBAS (solo +525521920710)',
          'active': 'ACTIVO (todos los números)'
        };
        console.log(`✅ Estado del bot actualizado correctamente: ${modeNames[mode]}`);
        console.log(`💾 ============================================\n`);
        return true;
      } else {
        console.error(`❌ Error: El modo guardado (${verifyStatus.mode}) no coincide con el solicitado (${mode})`);
        console.log(`💾 ============================================\n`);
        return false;
      }
    } else {
      console.error(`❌ Error: El archivo no existe después de escribirlo`);
      console.log(`💾 ============================================\n`);
      return false;
    }
  } catch (error) {
    console.error('❌ Error guardando estado del bot:', error);
    console.error('   Stack:', error.stack);
    console.log(`💾 ============================================\n`);
    return false;
  }
}

// Funciones de compatibilidad (deprecadas, usar getBotMode/setBotMode)
function getBotStatus() {
  const mode = getBotMode();
  return mode === 'active' || mode === 'test'; // Activo si está en 'active' o 'test'
}

function setBotStatus(active) {
  return setBotMode(active ? 'active' : 'inactive');
}

// Función de compatibilidad (deprecada, usar getBotMode)
function getTestModeStatus() {
  const mode = getBotMode();
  return mode === 'test';
}

// Función de compatibilidad (deprecada, usar setBotMode)
function setTestModeStatus(active) {
  return setBotMode(active ? 'test' : 'active');
}

// Función para procesar mensajes entrantes (NUEVA ARQUITECTURA BASADA EN INTENTS)
async function processIncomingMessage(senderPhone, incomingMessage, options = {}) {

  // CRITICAL: Verificar estado del bot ANTES de cualquier logging o procesamiento
  // Esto debe ser lo ABSOLUTAMENTE PRIMERO
  console.log(`\n🔒 ============================================`);
  console.log(`🔒 VERIFICACIÓN INMEDIATA - ANTES DE TODO`);
  console.log(`🔒 ============================================`);
  const botMode = getBotMode();
  console.log(`🔒 Modo leído: "${botMode}"`);
  const cleanPhone = senderPhone ? senderPhone.replace(/\D/g, '') : '';

  // Verificación inmediata y estricta
  const isInactive = String(botMode).trim().toLowerCase() === 'inactive';
  console.log(`🔒 Comparación: String("${botMode}").trim().toLowerCase() === 'inactive'`);
  console.log(`🔒 Resultado: ${isInactive}`);

  if (isInactive) {
    // NO hacer NADA más - terminar inmediatamente
    console.log(`⏸️  ============================================`);
    console.log(`⏸️  BOT INACTIVO - BLOQUEO INMEDIATO`);
    console.log(`⏸️  ============================================`);
    console.log(`⏸️  Mensaje de ${senderPhone} BLOQUEADO`);
    console.log(`⏸️  THROW INMEDIATO - FUNCIÓN TERMINA AQUÍ`);
    console.log(`⏸️  ============================================\n`);
    throw new Error('BOT_INACTIVE_BLOCKED');
  }
  console.log(`✅ Bot no está inactive, continuando...\n`);
  
  console.log(`\n🚨 ============================================`);
  console.log(`🚨 INICIO processIncomingMessage`);
  console.log(`🚨 ============================================`);
  console.log(`🚨 Número recibido: ${senderPhone}`);
  console.log(`🚨 Mensaje: ${incomingMessage}`);
  console.log(`🚨 ============================================\n`);
  
  // CRITICAL: Verificar estado del bot PRIMERO, antes de cualquier otra cosa
  // Modos: 'inactive' (bloquear todo), 'test' (solo +525521920710), 'active' (todos)
  console.log(`\n🔍 ============================================`);
  console.log(`🔍 VERIFICACIÓN DE MODO DEL BOT`);
  console.log(`🔍 ============================================`);
  console.log(`🔍 [BOT MODE CHECK] Modo actual del bot: "${botMode}"`);
  console.log(`🔍 [BOT MODE CHECK] Tipo: ${typeof botMode}`);
  console.log(`🔍 [BOT MODE CHECK] ¿Es 'test'?: ${botMode === 'test'}`);
  console.log(`🔍 [BOT MODE CHECK] ¿Es 'inactive'?: ${botMode === 'inactive'}`);
  console.log(`🔍 [BOT MODE CHECK] ¿Es 'active'?: ${botMode === 'active'}`);
  
  // cleanPhone ya está declarado arriba, solo declarar las constantes de prueba
  const TEST_PHONE_FULL = '525521920710'; // Con código de país
  const TEST_PHONE_SHORT = '5521920710'; // Sin código de país
  
  console.log(`🔍 [BOT MODE CHECK] Número recibido: ${senderPhone}`);
  console.log(`🔍 [BOT MODE CHECK] Número limpio: ${cleanPhone}`);
  console.log(`🔍 [BOT MODE CHECK] TEST_PHONE_FULL: ${TEST_PHONE_FULL}`);
  console.log(`🔍 [BOT MODE CHECK] TEST_PHONE_SHORT: ${TEST_PHONE_SHORT}`);
  console.log(`🔍 ============================================\n`);
  
  // Verificar según el modo - CRITICAL: Esto debe ser lo PRIMERO
  // Validación estricta del modo
  const validModes = ['inactive', 'test', 'active'];
  if (!validModes.includes(botMode)) {
    console.error(`❌ [BOT MODE CHECK] Modo inválido detectado: "${botMode}"`);
    console.error(`❌ [BOT MODE CHECK] Por seguridad, bloqueando mensaje`);
    console.log(`⏸️  ============================================\n`);
    throw new Error('BOT_INVALID_MODE_BLOCKED');
  }

  // CRITICAL: Verificación estricta con comparación de strings
  const isInactive2 = String(botMode).trim().toLowerCase() === 'inactive';
  const isTest = String(botMode).trim().toLowerCase() === 'test';
  const isActive = String(botMode).trim().toLowerCase() === 'active';
  
  console.log(`🔍 [BOT MODE CHECK] Comparaciones estrictas:`);
  console.log(`🔍   - isInactive: ${isInactive2}`);
  console.log(`🔍   - isTest: ${isTest}`);
  console.log(`🔍   - isActive: ${isActive}`);
  
  if (isInactive2) {
    console.log(`⏸️  ============================================`);
    console.log(`⏸️  🚫 BOT INACTIVO - BLOQUEO TOTAL (SEGUNDA VERIFICACIÓN)`);
    console.log(`⏸️  ============================================`);
    console.log(`⏸️  Número recibido: ${senderPhone} (limpio: ${cleanPhone})`);
    console.log(`⏸️  ⚠️  NO se procesará`);
    console.log(`⏸️  ⚠️  NO se enviará respuesta`);
    console.log(`⏸️  ⚠️  NO se guardará en historial`);
    console.log(`⏸️  ⚠️  NO se enviará typing indicator`);
    console.log(`⏸️  ⚠️  THROW INMEDIATO - FUNCIÓN TERMINA AQUÍ`);
    console.log(`⏸️  ============================================\n`);
    // CRITICAL: Throw inmediato - NO hacer NADA más
    throw new Error('BOT_INACTIVE_BLOCKED'); // Esto asegura que la función termine
  } else if (isTest) {
    console.log(`🧪 ============================================`);
    console.log(`🧪 MODO DE PRUEBAS ACTIVO - VERIFICANDO NÚMERO`);
    console.log(`🧪 ============================================`);
    
    // Comparación estricta: solo aceptar números exactos
    const exactMatchFull = cleanPhone === TEST_PHONE_FULL;
    const exactMatchShort = cleanPhone === TEST_PHONE_SHORT;
    const endsWithMatch = cleanPhone.length >= 10 && cleanPhone.length <= 12 && cleanPhone.endsWith(TEST_PHONE_SHORT);
    
    // Comparación por últimos dígitos (para manejar códigos de país diferentes)
    // El número puede venir como 5215521920710 (52 + 1 + 5521920710)
    // Necesitamos comparar los últimos 10 dígitos
    const last10Digits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const last10Match = last10Digits === TEST_PHONE_SHORT;
    
    const phoneMatches = exactMatchFull || exactMatchShort || endsWithMatch || last10Match;
    
    console.log(`🧪 Comparaciones detalladas:`);
    console.log(`🧪   - ${cleanPhone} === ${TEST_PHONE_FULL}? ${exactMatchFull}`);
    console.log(`🧪   - ${cleanPhone} === ${TEST_PHONE_SHORT}? ${exactMatchShort}`);
    console.log(`🧪   - endsWith(${TEST_PHONE_SHORT})? ${endsWithMatch} (length: ${cleanPhone.length})`);
    console.log(`🧪   - phoneMatches: ${phoneMatches}`);
    
    if (!phoneMatches) {
      console.log(`🧪 ============================================`);
      console.log(`🧪 🚫 BLOQUEO TOTAL - MODO DE PRUEBAS ACTIVO`);
      console.log(`🧪 ============================================`);
      console.log(`🧪 Número recibido: ${senderPhone} (limpio: ${cleanPhone})`);
      console.log(`🧪 Número permitido: +525521920710 (${TEST_PHONE_FULL} o ${TEST_PHONE_SHORT})`);
      console.log(`🧪 ⚠️  NO se procesará`);
      console.log(`🧪 ⚠️  NO se enviará respuesta`);
      console.log(`🧪 ⚠️  NO se guardará en historial`);
      console.log(`🧪 ⚠️  NO se enviará typing indicator`);
      console.log(`🧪 ⚠️  RETURN INMEDIATO - FUNCIÓN TERMINA AQUÍ`);
      console.log(`🧪 ============================================\n`);
      // CRITICAL: Return inmediato - NO hacer NADA más
      throw new Error('BOT_TEST_MODE_BLOCKED'); // Esto asegura que la función termine
    } else {
      console.log(`🧪 ✅ MODO DE PRUEBAS: Número permitido (${cleanPhone})`);
      console.log(`🧪 ✅ Continuando procesamiento...`);
      console.log(`🧪 ============================================\n`);
    }
  } else if (botMode === 'active') {
    console.log(`✅ [BOT MODE CHECK] Bot ACTIVO - Procesando mensaje normalmente\n`);
  } else {
    console.log(`⚠️  [BOT MODE CHECK] Modo desconocido: "${botMode}" - Procesando como activo\n`);
  }
  // Enviar indicador de "escribiendo..." inmediatamente
  // (solo si no es un click de botón, ya que esos son instantáneos)
  if (!options.isButtonClick) {
    await sendTypingIndicator(senderPhone, 'typing_on');
  }
  
  try {
    const cleanPhone = senderPhone.replace(/\D/g, ''); // Limpiar número
    
    // Import name utilities
    const { getClientName, getClientFirstName } = require('./bot/utils/name-utils');
    
    // Obtener o crear sesión
    let session = sessions.getSession(cleanPhone);
    
    // Check if bot is paused (advisor is handling the conversation)
    if (session.bot_paused_until) {
      const pauseUntil = new Date(session.bot_paused_until);
      const now = new Date();
      
      if (now < pauseUntil) {
        // Bot is still paused - don't process message, just add to history
        console.log(`⏸️  Bot está pausado hasta ${pauseUntil.toISOString()}. Mensaje guardado en historial pero no procesado.`);
        const messageForHistory = options.buttonTitle || incomingMessage;
        sessions.addToHistory(cleanPhone, 'user', messageForHistory);
        return; // Exit without processing
      } else {
        // Pause period has expired - clear the flag and continue processing
        console.log(`▶️  Período de pausa expirado. Bot reanudando procesamiento normal.`);
        sessions.updateSession(cleanPhone, {
          bot_paused_until: null
        });
        // Continue with normal processing below
      }
    }
    
    // Agregar mensaje del usuario al historial (usar el título del botón si es un clic)
    const messageForHistory = options.buttonTitle || incomingMessage;
    sessions.addToHistory(cleanPhone, 'user', messageForHistory);

    // Actualizar sesión después de agregar al historial
    session = sessions.getSession(cleanPhone);

    // ── FAST PATH: Confirmar asistencia ──────────────────────────────────────
    // Si la clienta confirma que va a su cita existente, responder con agradecimiento
    // y escalar al humano. No pasar por el clasificador ni por LLM para evitar que
    // el bot diga "no tengo ninguna cita registrada" o intente crear una nueva.
    {
      const msgLower = incomingMessage.toLowerCase().trim();
      const confirmaPatterns = [
        'confirmo mi asistencia',
        'confirmo asistencia',
        'confirmo mi cita',
        'confirmo que voy',
        'confirmo que asistire',
        'confirmo que asistiré',
        'ahí estaré',
        'ahi estare',
        'allí estaré',
        'alli estare',
        'si voy a ir',
        'sí voy a ir',
        'si asistiré',
        'sí asistiré',
        'si asistire',
        'sí asistire',
      ];
      // "confirmo" solo (sin más contexto) es ambiguo, lo detectamos SOLO si ya hay cita
      const hasAppointment = session.etapa === 'cita_agendada' || !!session.calendar_event_id;
      const isConfirmacion =
        confirmaPatterns.some(p => msgLower.includes(p)) ||
        (hasAppointment && (msgLower === 'confirmo' || msgLower === 'confirmo.' || msgLower === 'confirmo!'));

      if (isConfirmacion) {
        console.log(`✅ [CONFIRMAR ASISTENCIA] Detectado para ${cleanPhone} — respondiendo y escalando a humano`);
        const reply = '¡Gracias! 🤍 Te esperamos. Si necesitas algo antes de tu visita, aquí estamos.';
        await sendWhatsAppMessage(cleanPhone, reply);
        sessions.addToHistory(cleanPhone, 'assistant', reply);

        // Escalar al equipo para que sepan que la novia confirmó
        try {
          logPendingTask({
            phone: cleanPhone,
            name: session.nombre_cliente || session.nombre_novia || 'Clienta',
            message: `[CONFIRMÓ ASISTENCIA] "${incomingMessage}"`,
            historial: session.historial
          });
        } catch (e) {
          console.warn('⚠️  No se pudo loguear confirmación de asistencia:', e.message);
        }

        return;
      }
    }
    // ── FAST PATH: Ajustes / Entrega / Folio ─────────────────────────────────
    // Clientes existentes que ya compraron y quieren gestionar ajustes, entrega
    // o referir su folio. El bot no tiene acceso a registros de compra, por lo
    // que escala inmediatamente al equipo.
    // NOTA: solo captura señales de alta confianza. Las preguntas generales como
    // "¿cuándo se hacen los ajustes?" son respondidas por el LLM con FAQs.
    {
      const msgLower = incomingMessage.toLowerCase().trim();
      const ajusteEscalarPatterns = [
        'folio',
        'número de folio',
        'numero de folio',
        'cita de ajuste',
        'cita de ajustes',
        'prueba de ajuste',
        'prueba de ajustes',
        'mi ajuste',
        'mis ajustes',
        'agendar ajuste',
        'agendar mis ajustes',
        'quiero ajuste',
        'quiero mis ajustes',
        'necesito ajuste',
        'para mis ajustes',
        'mi entrega',
        'fecha de entrega',
        'cuándo es mi entrega',
        'cuando es mi entrega',
        'recoger mi vestido',
        'recoger el vestido',
        'mi vestido ya está',
        'mi vestido ya esta',
        'ya está mi vestido',
        'ya esta mi vestido',
        'ya compré',
        'ya compre',
        'ya tengo mi vestido',
      ];
      const isAjusteOEntrega = ajusteEscalarPatterns.some(p => msgLower.includes(p));

      if (isAjusteOEntrega) {
        console.log(`👗 [AJUSTE/ENTREGA/FOLIO] Detectado para ${cleanPhone} — escalando a humano directamente`);
        const reply = 'Hola 😊 Para gestiones de ajustes, entregas o información de tu folio necesito conectarte con una de nuestras asesoras. ¡Ya quedó registrada tu solicitud y en breve se pondrán en contacto contigo! 🤍';
        await sendWhatsAppMessage(cleanPhone, reply);
        sessions.addToHistory(cleanPhone, 'user', incomingMessage);
        sessions.addToHistory(cleanPhone, 'assistant', reply);

        try {
          logPendingTask({
            phone: cleanPhone,
            name: session.nombre_cliente || session.nombre_novia || 'Clienta',
            message: `[AJUSTE/ENTREGA/FOLIO] "${incomingMessage}"`,
            historial: session.historial
          });
        } catch (e) {
          console.warn('⚠️  No se pudo loguear solicitud de ajuste/entrega:', e.message);
        }

        return;
      }
    }
    // ── FIN FAST PATH ─────────────────────────────────────────────────────────

    // STEP 1: Profile extraction (OPTIMIZED - only if missing info)
    // Only run LLM extraction if we don't have nombre_cliente/nombre_novia or fecha_boda
    // Skip extraction for button clicks to avoid confusion
    let profileJustUpdated = false;
    try {
      const currentNombre = getClientName(session);
      const needsExtraction = !currentNombre || !session.fecha_boda;
      // Don't run extraction for button clicks - it can confuse the extractor
      if (needsExtraction && !options.isButtonClick) {
        const profileData = await extractBrideProfile(session.historial);
        const profileUpdates = {};
        
        // Support both nombre_cliente (new) and nombre_novia (legacy)
        const extractedNombre = profileData.nombre_cliente || profileData.nombre_novia;
        if (extractedNombre && extractedNombre !== currentNombre) {
          profileUpdates.nombre_cliente = extractedNombre;
          // Also set nombre_novia for backward compatibility
          profileUpdates.nombre_novia = extractedNombre;
          console.log(`📝 Perfil: Nombre de cliente actualizado: ${extractedNombre}`);
        }
        
        if (profileData.fecha_boda && profileData.fecha_boda !== session.fecha_boda) {
          profileUpdates.fecha_boda = profileData.fecha_boda;
          console.log(`📝 Perfil: Fecha de boda actualizada: ${profileData.fecha_boda}`);
        }
        
        // Update etapa if we have both nombre and fecha_boda
        if (extractedNombre && profileData.fecha_boda && session.etapa === 'primer_contacto') {
          profileUpdates.etapa = 'interesada';
          console.log(`📝 Perfil: Etapa actualizada: primer_contacto → interesada`);
        }
        
        if (Object.keys(profileUpdates).length > 0) {
          sessions.updateSession(cleanPhone, profileUpdates);
          session = sessions.getSession(cleanPhone); // Refresh session
          
          // Check if we just got nombre (and optionally fecha_boda) for the first time
          // Also check if user has declined to provide fecha_boda
          const hasNombre = getClientName(session) && getClientName(session).trim().length > 0;
          const hasFechaBoda = session.fecha_boda && session.fecha_boda.trim().length > 0;
          const fechaBodaDeclinada = session.fecha_boda_declinada === true;
          
          if (extractedNombre && (profileUpdates.fecha_boda || (hasNombre && (hasFechaBoda || fechaBodaDeclinada)))) {
            profileJustUpdated = true;
            console.log(`📝 Perfil: Se acaban de recolectar nombre${profileUpdates.fecha_boda ? ' y fecha de boda' : ' (fecha declinada o no proporcionada)'}, se mostrará el menú principal`);
          }
        }
      }
    } catch (profileError) {
      console.error('⚠️  Error extrayendo perfil, continuando:', profileError.message);
    }

    // STEP 2: Re-read session after profile extraction
    session = sessions.getSession(cleanPhone);

    // ── TIPO DE CITA ─────────────────────────────────────────────────────────
    // Interceptar ANTES del agente: preguntar si es primera visita o ajustes.
    // Se usa session.tipo_cita para no preguntar más de una vez por conversación.
    {
      const hasAppointment = session.etapa === 'cita_agendada' || session.calendar_event_id;
      const msgLower = incomingMessage.toLowerCase();

      // Si ya preguntamos y estamos esperando respuesta
      if (session.pending_tipo_cita && !hasAppointment) {
        const esAjuste = [
          'ajuste', 'ajustes', 'ya compré', 'ya compre', 'ya tengo',
          'ya soy client', 'arreglo', 'arreglos', 'de ajuste'
        ].some(k => msgLower.includes(k));

        const esPrimeraVez = [
          'primera vez', 'primera visita', 'nueva', 'nunca he ido',
          'nunca he visitado', 'por primera', 'no he ido', 'primer'
        ].some(k => msgLower.includes(k));

        if (esAjuste) {
          const reply = 'Entendido 💕 Para agendar tu cita de ajustes te conectamos con una de nuestras asesoras. ¡Ya quedó registrada tu solicitud y en breve se pondrán en contacto contigo! 🤍';
          sessions.updateSession(cleanPhone, { pending_tipo_cita: false });
          sessions.addToHistory(cleanPhone, 'user', incomingMessage);
          sessions.addToHistory(cleanPhone, 'assistant', reply);
          await sendWhatsAppMessage(cleanPhone, reply);
          logPendingTask({ phone: cleanPhone, name: session.nombre_cliente || session.nombre_novia || '', message: `[AJUSTE] "${incomingMessage}"`, historial: session.historial });
          return;
        }

        if (esPrimeraVez) {
          const horarios = session.horarios || require('./config').getBusinessHours();
          const reply = `¡Perfecto, qué emoción! 👰‍♀️ ¿Qué día te gustaría visitarnos?\n\nEstamos abiertas de martes a sábado de 11am a 8pm y domingos de 11am a 6pm 🕒`;
          sessions.updateSession(cleanPhone, { pending_tipo_cita: false, tipo_cita: 'primera_vez' });
          sessions.addToHistory(cleanPhone, 'user', incomingMessage);
          sessions.addToHistory(cleanPhone, 'assistant', reply);
          await sendWhatsAppMessage(cleanPhone, reply);
          return;
        }

        // Respuesta ambigua — preguntar de nuevo
        const reply = '¿Podrías decirme si es tu primera visita con nosotros o si ya tienes tu vestido y buscas agendar tu cita de ajustes? 😊';
        sessions.addToHistory(cleanPhone, 'user', incomingMessage);
        sessions.addToHistory(cleanPhone, 'assistant', reply);
        await sendWhatsAppMessage(cleanPhone, reply);
        return;
      }

      // Si el usuario quiere agendar y aún no sabemos el tipo de cita, preguntar
      const agendarKeywords = [
        'agendar', 'quiero una cita', 'hacer una cita', 'reservar', 'apartar',
        'quiero ir', 'quisiera ir', 'me gustaría ir', 'visitar', 'cuando tienen',
        'tienen disponible', 'disponibilidad'
      ];
      const quiereAgendar = agendarKeywords.some(k => msgLower.includes(k));

      if (quiereAgendar && !session.tipo_cita && !hasAppointment && !options.isButtonClick) {
        const reply = '¡Con gusto agendamos tu cita! 💕\n\n¿Es tu primera visita con nosotros o ya tienes tu vestido y buscas agendar una cita de ajustes?';
        sessions.updateSession(cleanPhone, { pending_tipo_cita: true });
        sessions.addToHistory(cleanPhone, 'user', incomingMessage);
        sessions.addToHistory(cleanPhone, 'assistant', reply);
        await sendWhatsAppMessage(cleanPhone, reply);
        return;
      }
    }
    // ── FIN TIPO DE CITA ──────────────────────────────────────────────────────

    // STEP 3: Run conversational agent (handles all intents + calendar tools)
    const { runAgent } = require('./bot/agent');

    const calendarDeps = {
      calendarClient: calendar,
      authClient: authClient,
      calendarId: citasNuevasCalendarId || process.env.CALENDAR_ID || 'primary',
      innoviaCDMXCalendarId: innoviaCDMXCalendarId
    };

    const agentResult = await runAgent(
      cleanPhone,
      session,
      incomingMessage,
      calendarDeps,
      options.isButtonClick || false,
      options.buttonTitle || null
    );

    // Send the agent's natural-language reply
    if (agentResult.reply) {
      await sendWhatsAppMessage(cleanPhone, agentResult.reply);
      sessions.addToHistory(cleanPhone, 'assistant', agentResult.reply);
    }

    // Persist any session changes produced by tool calls
    if (agentResult.sessionUpdates && Object.keys(agentResult.sessionUpdates).length > 0) {
      sessions.updateSession(cleanPhone, agentResult.sessionUpdates);
    }

    // Done — agent handled everything above.
    return;

  } catch (error) {
    console.error('❌ Error procesando mensaje:', error.message || error);
    if (error.stack) {
      console.error('   Stack:', error.stack.split('\n').slice(0, 3).join('\n'));
    }
    // Liberar lock de creación de cita si quedó bloqueado por una excepción inesperada
    const cleanPhoneForCleanup = senderPhone ? senderPhone.replace(/\D/g, '') : null;
    if (cleanPhoneForCleanup && appointmentCreationLocks.has(cleanPhoneForCleanup)) {
      appointmentCreationLocks.delete(cleanPhoneForCleanup);
      console.warn(`⚠️  [LOCK CLEANUP] Lock de creación de cita liberado para ${cleanPhoneForCleanup} tras error.`);
    }
    // Enviar mensaje genérico al usuario para que no quede sin respuesta
    // Si sendWhatsAppMessage también falla, simplemente lo registramos
    if (cleanPhoneForCleanup) {
      try {
        await sendWhatsAppMessage(
          cleanPhoneForCleanup,
          'Disculpa, tuve un problema procesando tu mensaje. ¿Puedes intentarlo de nuevo? 💫'
        );
        sessions.addToHistory(cleanPhoneForCleanup, 'assistant', 'Error interno — mensaje de fallback enviado.');
      } catch (sendError) {
        console.error('❌ No se pudo enviar mensaje de fallback al usuario:', sendError.message);
      }
    }
  }
}

// Ruta para verificar que el servidor está funcionando
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Bot funcionando correctamente',
    provider: 'Chakra (BSP de WhatsApp)',
    chakraApiKey: CHAKRA_API_KEY ? 'Configurado' : 'No configurado',
    googleCalendarConnected: !!authClient
  });
});

// Ruta de prueba para ver eventos de Google Calendar
app.get('/test-calendar', async (req, res) => {
  try {
    const date = req.query.date || '2026-02-25';
    
    if (!authClient) {
      return res.json({
        error: 'Google Calendar no está conectado',
        message: 'Necesitas autenticarte primero. Reinicia el bot y completa la autenticación OAuth.'
      });
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    const [year, month, day] = date.split('-').map(Number);
    const startOfDay = new Date(year, month - 1, day, 9, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 18, 0, 0);

    // Usar el calendario "CITAS NUEVAS" si está disponible, sino usar el configurado
    const targetCalendarId = citasNuevasCalendarId || process.env.CALENDAR_ID || 'primary';

    const events = await calendar.events.list({
      auth: auth,
      calendarId: targetCalendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Mexico_City'
    });

    const eventItems = events.data.items || [];
    
    // Procesar eventos
    const eventos = eventItems.map(e => {
      const start = e.start.dateTime ? new Date(e.start.dateTime) : new Date(e.start.date);
      const end = e.end.dateTime ? new Date(e.end.dateTime) : new Date(e.end.date);
      return {
        titulo: e.summary || 'Sin título',
        inicio: start.toLocaleString('es-MX'),
        fin: end.toLocaleString('es-MX'),
        todoElDia: !e.start.dateTime
      };
    });

    // Calcular slots ocupados
    const bookedSlots = [];
    for (let hour = 9; hour < 18; hour++) {
      const slotStart = new Date(year, month - 1, day, hour, 0, 0);
      const slotEnd = new Date(year, month - 1, day, hour + 1, 0, 0);
      
      const isBooked = eventItems.some(e => {
        const eventStart = e.start.dateTime ? new Date(e.start.dateTime) : new Date(e.start.date);
        const eventEnd = e.end.dateTime ? new Date(e.end.dateTime) : new Date(e.end.date);
        return slotStart < eventEnd && slotEnd > eventStart;
      });

      if (isBooked) {
        bookedSlots.push(`${hour}:00 - ${hour + 1}:00`);
      }
    }

    res.json({
      fecha: date,
      totalEventos: eventItems.length,
      eventos: eventos,
      horariosOcupados: bookedSlots,
      horariosDisponibles: 9 - bookedSlots.length,
      mensaje: `El bot encontró ${eventItems.length} evento(s) para el ${date}`
    });

  } catch (error) {
    res.json({
      error: 'Error al consultar Google Calendar',
      mensaje: error.message,
      stack: error.stack
    });
  }
});

// ============================================
// DASHBOARD API ENDPOINTS
// ============================================

// fs y path ya están importados al inicio del archivo
// Usar fs.promises para operaciones asíncronas

// GET /api/stats - Métricas generales
app.get('/api/stats', async (req, res) => {
  try {
    const allSessions = sessions.getAllSessions();
    const now = new Date();
    // Medianoche en CDMX (UTC-6, sin DST desde 2023)
    const todayStrCDMX = now.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const todayStart = new Date(todayStrCDMX + 'T00:00:00-06:00');

    // Calcular métricas
    let totalMessages = 0;
    let messagesToday = 0;
    let incomingMessages = 0;
    let outgoingMessages = 0;
    const intentCounts = {};
    let appointmentsTotal = 0;
    let appointmentsToday = 0;
    let appointmentsCreated = 0;
    let appointmentsEdited = 0;
    let appointmentsCancelled = 0;
    
    allSessions.forEach(({ session }) => {
      // Contar mensajes
      const userMessages = session.historial?.filter(m => m.role === 'user') || [];
      const botMessages = session.historial?.filter(m => m.role === 'assistant') || [];
      
      totalMessages += session.historial?.length || 0;
      incomingMessages += userMessages.length;
      outgoingMessages += botMessages.length;
      
      // Mensajes de hoy
      const todayMsgs = session.historial?.filter(msg => {
        const msgDate = new Date(msg.timestamp);
        return msgDate >= todayStart;
      }) || [];
      messagesToday += todayMsgs.length;
      
      // Contar intents - usar historial de intents si existe, sino usar lastIntent
      if (session.intentHistory && Array.isArray(session.intentHistory)) {
        // Contar todos los intents del historial
        session.intentHistory.forEach(intent => {
          if (intent) {
            intentCounts[intent] = (intentCounts[intent] || 0) + 1;
          }
        });
      } else if (session.lastIntent) {
        // Fallback: usar último intent si no hay historial
        intentCounts[session.lastIntent] = (intentCounts[session.lastIntent] || 0) + 1;
      }
      
      // Contar citas agendadas
      if (session.etapa === 'cita_agendada') {
        appointmentsTotal++;
        if (session.fecha_cita) {
          const appointmentDate = new Date(session.fecha_cita);
          if (appointmentDate >= todayStart) {
            appointmentsToday++;
          }
        }
      }
      
      // Contar acciones de citas
      if (session.appointmentActions) {
        if (session.appointmentActions.created) appointmentsCreated++;
        if (session.appointmentActions.edited) appointmentsEdited++;
        if (session.appointmentActions.cancelled) appointmentsCancelled++;
      }
    });
    
    res.json({
      totalMessages,
      messagesToday,
      totalConversations: allSessions.length,
      incomingMessages,
      outgoingMessages,
      totalAppointments: appointmentsTotal,
      appointmentsToday,
      appointmentsCreated,
      appointmentsEdited,
      appointmentsCancelled,
      intentDistribution: intentCounts
    });
  } catch (error) {
    console.error('Error en /api/stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics - Métricas completas de analytics
app.get('/api/analytics', async (req, res) => {
  try {
    const allSessions = sessions.getAllSessions();
    const now = new Date();
    // Medianoche en CDMX (UTC-6, sin DST desde 2023)
    const todayStrCDMX = now.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const todayStart = new Date(todayStrCDMX + 'T00:00:00-06:00');

    // Determinar periodo según parámetro
    const period = req.query.period || '30d';
    let periodStart, previousPeriodStart, previousPeriodEnd;
    
    if (period === 'today') {
      periodStart = todayStart;
      previousPeriodStart = new Date(todayStart);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - 1);
      previousPeriodEnd = todayStart;
    } else if (period === '7d') {
      periodStart = new Date(todayStart);
      periodStart.setDate(periodStart.getDate() - 7);
      previousPeriodStart = new Date(periodStart);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - 7);
      previousPeriodEnd = periodStart;
    } else if (period === '30d') {
      periodStart = new Date(todayStart);
      periodStart.setMonth(periodStart.getMonth() - 1);
      previousPeriodStart = new Date(periodStart);
      previousPeriodStart.setMonth(previousPeriodStart.getMonth() - 1);
      previousPeriodEnd = periodStart;
    } else if (period === '90d') {
      periodStart = new Date(todayStart);
      periodStart.setMonth(periodStart.getMonth() - 3);
      previousPeriodStart = new Date(periodStart);
      previousPeriodStart.setMonth(previousPeriodStart.getMonth() - 3);
      previousPeriodEnd = periodStart;
    } else {
      periodStart = new Date(todayStart);
      periodStart.setMonth(periodStart.getMonth() - 1);
      previousPeriodStart = new Date(periodStart);
      previousPeriodStart.setMonth(previousPeriodStart.getMonth() - 1);
      previousPeriodEnd = periodStart;
    }
    
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setMonth(monthStart.getMonth() - 1);
    
    // 1. MÉTRICAS DE USO
    const conversationsByDay = {};
    const newConversationsByDay = {}; // Solo conversaciones de usuarios nuevos
    const conversationsByWeek = {};
    const conversationsByMonth = {};
    const userPhones = new Set();
    const newUsers = new Set();
    const returningUsers = new Set();
    const messagesByHour = {};
    const messagesByDay = {};
    const intentCounts = {};
    let totalMessages = 0;
    let totalConversations = 0;
    let totalUserMessages = 0;
    let totalBotMessages = 0;
    
    // 2. RENDIMIENTO DEL BOT (periodo actual)
    let resolvedAutomatically = 0; // Conversaciones que terminaron en cita sin escalamiento
    let escalatedToHuman = 0; // Conversaciones que fueron escaladas
    let successfulAppointments = 0;
    let successfulReschedules = 0;
    let successfulInfoDelivery = 0;
    const responseTimes = []; // Tiempo entre mensaje del usuario y respuesta del bot
    const conversationDurations = []; // Duración total de conversaciones
    
    // Métricas del periodo anterior para comparación
    let previousEscalatedToHuman = 0;
    const previousResponseTimes = [];
    
    // 3. MÉTRICAS DE CONVERSIÓN
    let conversationsWithAppointment = 0;
    let confirmedAppointments = 0;
    
    // 4. MÉTRICAS DE NEGOCIO
    let totalAppointmentsGenerated = 0;
    let appointmentsCancelled = 0;
    let appointmentsRescheduled = 0;
    const appointmentsByDay = {};
    const appointmentsByHour = {};
    
    allSessions.forEach(({ phone, session }) => {
      const lastActivity = new Date(session.ultima_actividad);
      const isInCurrentPeriod = lastActivity >= periodStart && lastActivity <= now;
      const isInPreviousPeriod = lastActivity >= previousPeriodStart && lastActivity < previousPeriodEnd;
      
      // Determinar si es usuario nuevo o recurrente
      const firstMessageDate = session.historial && session.historial.length > 0
        ? new Date(session.historial[0].timestamp)
        : lastActivity;
      
      if (firstMessageDate >= monthStart) {
        newUsers.add(phone);
      } else {
        returningUsers.add(phone);
      }
      
      // Solo procesar sesiones del periodo actual para métricas principales
      if (!isInCurrentPeriod && !isInPreviousPeriod) {
        return; // Saltar sesiones fuera de ambos periodos
      }
      
      if (isInCurrentPeriod) {
        totalConversations++;
      }
      
      // Contar mensajes
      const userMessages = session.historial?.filter(m => m.role === 'user') || [];
      const botMessages = session.historial?.filter(m => m.role === 'assistant') || [];
      totalUserMessages += userMessages.length;
      totalBotMessages += botMessages.length;
      totalMessages += session.historial?.length || 0;
      
      // Conversaciones por día/semana/mes
      const convDate = new Date(session.ultima_actividad);
      const dayKey = convDate.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }); // YYYY-MM-DD en CDMX
      const cdmxDate = new Date(convDate.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      const weekKey = `${cdmxDate.getFullYear()}-W${Math.ceil((cdmxDate.getDate() + new Date(cdmxDate.getFullYear(), cdmxDate.getMonth(), 1).getDay()) / 7)}`;
      const monthKey = `${cdmxDate.getFullYear()}-${String(cdmxDate.getMonth() + 1).padStart(2, '0')}`;

      conversationsByDay[dayKey] = (conversationsByDay[dayKey] || 0) + 1;
      conversationsByWeek[weekKey] = (conversationsByWeek[weekKey] || 0) + 1;
      conversationsByMonth[monthKey] = (conversationsByMonth[monthKey] || 0) + 1;

      // Solo contar conversaciones de usuarios nuevos por día
      // Un usuario nuevo es aquel cuyo primer mensaje fue en el último mes
      // Contamos la conversación nueva en el día de su primer mensaje
      if (isInCurrentPeriod && newUsers.has(phone)) {
        // Usar la fecha del primer mensaje para determinar el día de la conversación nueva
        // (firstMessageDate ya fue calculado arriba)
        const firstMessageDayKey = firstMessageDate.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
        
        // Solo contar si el primer mensaje está en el periodo actual
        if (firstMessageDate >= periodStart && firstMessageDate <= now) {
          newConversationsByDay[firstMessageDayKey] = (newConversationsByDay[firstMessageDayKey] || 0) + 1;
        }
      }
      
      // Mensajes por hora y día — solo mensajes dentro del periodo actual,
      // usando timezone de CDMX para que las horas sean locales (no UTC).
      session.historial?.forEach(msg => {
        const msgDate = new Date(msg.timestamp);
        if (msgDate < periodStart || msgDate > now) return; // filtrar por periodo

        // Obtener fecha y hora en CDMX para evitar el offset UTC del servidor
        const cdmxFormatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Mexico_City',
          year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const cdmxHourFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Mexico_City',
          hour: 'numeric', hour12: false
        });

        const msgDayKey  = cdmxFormatter.format(msgDate);   // YYYY-MM-DD en CDMX
        const msgHour    = cdmxHourFormatter.format(msgDate).padStart(2, '0'); // "04", "14", etc.
        const hourKey    = `${msgDayKey}::${msgHour}`; // Separador "::" para no confundir con "-" de fecha

        messagesByHour[hourKey] = (messagesByHour[hourKey] || 0) + 1;
        messagesByDay[msgDayKey] = (messagesByDay[msgDayKey] || 0) + 1;
      });
      
      // Intents
      if (session.intentHistory && Array.isArray(session.intentHistory)) {
        session.intentHistory.forEach(intent => {
          if (intent) {
            intentCounts[intent] = (intentCounts[intent] || 0) + 1;
          }
        });
      } else if (session.lastIntent) {
        intentCounts[session.lastIntent] = (intentCounts[session.lastIntent] || 0) + 1;
      }
      
      // Tiempo de respuesta (tiempo entre mensaje del usuario y respuesta del bot)
      if (session.historial && session.historial.length > 1) {
        for (let i = 0; i < session.historial.length - 1; i++) {
          if (session.historial[i].role === 'user' && session.historial[i + 1].role === 'assistant') {
            const userTime = new Date(session.historial[i].timestamp);
            const botTime = new Date(session.historial[i + 1].timestamp);
            const responseTime = (botTime - userTime) / 1000; // segundos
            if (responseTime > 0 && responseTime < 3600) { // Solo tiempos razonables (< 1 hora)
              const msgDate = new Date(session.historial[i].timestamp);
              if (msgDate >= periodStart && msgDate <= now) {
                responseTimes.push(responseTime);
              } else if (msgDate >= previousPeriodStart && msgDate < previousPeriodEnd) {
                previousResponseTimes.push(responseTime);
              }
            }
          }
        }
      }
      
      // Duración de conversación
      if (session.historial && session.historial.length > 1) {
        const firstMsg = new Date(session.historial[0].timestamp);
        const lastMsg = new Date(session.historial[session.historial.length - 1].timestamp);
        const duration = (lastMsg - firstMsg) / 1000 / 60; // minutos
        if (duration > 0 && duration < 1440) { // Solo duraciones razonables (< 24 horas)
          conversationDurations.push(duration);
        }
      }
      
      // Escalamiento humano
      const hasEscalation = session.intentHistory?.includes('OTRO') || 
                           session.intentHistory?.some(intent => intent && intent.includes('ASESOR'));
      if (hasEscalation) {
        if (isInCurrentPeriod) {
          escalatedToHuman++;
        } else if (isInPreviousPeriod) {
          previousEscalatedToHuman++;
        }
      }
      
      // Citas
      const hasAppointment = session.etapa === 'cita_agendada';
      if (hasAppointment) {
        conversationsWithAppointment++;
        totalAppointmentsGenerated++;
        
        if (session.appointmentActions?.created) {
          successfulAppointments++;
          confirmedAppointments++;
        }
        
        if (session.appointmentActions?.edited) {
          successfulReschedules++;
          appointmentsRescheduled++;
        }
        
        if (session.appointmentActions?.cancelled) {
          appointmentsCancelled++;
        }
        
        // Citas por día y hora
        if (session.fecha_cita) {
          const aptDate = new Date(session.fecha_cita);
          const aptDayKey = aptDate.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
          appointmentsByDay[aptDayKey] = (appointmentsByDay[aptDayKey] || 0) + 1;
          
          // Intentar extraer hora de la cita
          if (session.fecha_cita.includes('T') || session.hora_cita) {
            const hour = session.hora_cita ? parseInt(session.hora_cita.split(':')[0]) : aptDate.getHours();
            const hourKey = `${aptDayKey}-${String(hour).padStart(2, '0')}`;
            appointmentsByHour[hourKey] = (appointmentsByHour[hourKey] || 0) + 1;
          }
        }
      }
      
      // Resolución automática (cita sin escalamiento)
      if (hasAppointment && !hasEscalation) {
        resolvedAutomatically++;
      }
      
      // Entrega exitosa de información (intents de información)
      const hasInfoIntent = session.intentHistory?.some(intent => 
        intent && (intent.includes('INFO') || intent.includes('CATALOGO') || intent.includes('HORARIO'))
      );
      if (hasInfoIntent) {
        successfulInfoDelivery++;
      }
    });
    
    // Calcular promedios
    const avgMessagesPerConversation = totalConversations > 0 ? (totalMessages / totalConversations).toFixed(2) : 0;
    const avgResponseTime = responseTimes.length > 0 
      ? (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(1)
      : 0;
    const avgConversationDuration = conversationDurations.length > 0
      ? (conversationDurations.reduce((a, b) => a + b, 0) / conversationDurations.length).toFixed(1)
      : 0;
    
    // Calcular promedio de tiempo de respuesta del periodo anterior
    const previousAvgResponseTime = previousResponseTimes.length > 0
      ? (previousResponseTimes.reduce((a, b) => a + b, 0) / previousResponseTimes.length).toFixed(1)
      : null;
    
    // Calcular tasas
    const fcrRate = totalConversations > 0 
      ? ((resolvedAutomatically / totalConversations) * 100).toFixed(1)
      : 0;
    const escalationRate = totalConversations > 0
      ? ((escalatedToHuman / totalConversations) * 100).toFixed(1)
      : 0;
    
    // Calcular tasa de escalamiento del periodo anterior
    // Necesitamos contar conversaciones del periodo anterior
    let previousTotalConversations = 0;
    allSessions.forEach(({ session }) => {
      const lastActivity = new Date(session.ultima_actividad);
      if (lastActivity >= previousPeriodStart && lastActivity < previousPeriodEnd) {
        previousTotalConversations++;
      }
    });
    const previousEscalationRate = previousTotalConversations > 0
      ? ((previousEscalatedToHuman / previousTotalConversations) * 100).toFixed(1)
      : null;
    const conversionRate = totalConversations > 0
      ? ((conversationsWithAppointment / totalConversations) * 100).toFixed(1)
      : 0;
    const confirmationRate = conversationsWithAppointment > 0
      ? ((confirmedAppointments / conversationsWithAppointment) * 100).toFixed(1)
      : 0;
    
    // Calcular % de éxito en tareas
    const totalAppointmentAttempts = successfulAppointments + (appointmentsCancelled || 0);
    const appointmentSuccessRate = totalAppointmentAttempts > 0
      ? ((successfulAppointments / totalAppointmentAttempts) * 100).toFixed(1)
      : 0;
    
    const totalRescheduleAttempts = successfulReschedules + appointmentsCancelled;
    const rescheduleSuccessRate = totalRescheduleAttempts > 0
      ? ((successfulReschedules / totalRescheduleAttempts) * 100).toFixed(1)
      : 0;
    
    const infoSuccessRate = totalConversations > 0
      ? ((successfulInfoDelivery / totalConversations) * 100).toFixed(1)
      : 0;
    
    // Encontrar picos de uso
    const peakHour = Object.entries(messagesByHour).sort((a, b) => b[1] - a[1])[0];
    const peakDay = Object.entries(messagesByDay).sort((a, b) => b[1] - a[1])[0];
    
    // Encontrar días/horas con más citas
    const peakAppointmentDay = Object.entries(appointmentsByDay).sort((a, b) => b[1] - a[1])[0];
    const peakAppointmentHour = Object.entries(appointmentsByHour).sort((a, b) => b[1] - a[1])[0];

    // Distribución de etapas (todas las sesiones, sin filtro de periodo)
    const etapaDistribution = { primer_contacto: 0, interesada: 0, cita_agendada: 0 };
    sessions.getAllSessions().forEach(({ session: s }) => {
      const etapa = s.etapa || 'primer_contacto';
      if (etapaDistribution[etapa] !== undefined) {
        etapaDistribution[etapa]++;
      }
    });

    // Top intents
    const topIntents = Object.entries(intentCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([intent, count]) => ({ intent, count }));
    
    res.json({
      // 1. MÉTRICAS DE USO
      usage: {
        totalConversations,
        conversationsByDay: Object.entries(conversationsByDay).slice(-30).map(([date, count]) => ({ date, count })),
        newConversationsByDay: Object.entries(newConversationsByDay).slice(-30).map(([date, count]) => ({ date, count })),
        conversationsByWeek: Object.entries(conversationsByWeek).slice(-12).map(([week, count]) => ({ week, count })),
        conversationsByMonth: Object.entries(conversationsByMonth).slice(-12).map(([month, count]) => ({ month, count })),
        newUsers: newUsers.size,
        returningUsers: returningUsers.size,
        avgMessagesPerConversation: parseFloat(avgMessagesPerConversation),
        peakHour: peakHour ? { time: peakHour[0], count: peakHour[1] } : null,
        peakDay: peakDay ? { date: peakDay[0], count: peakDay[1] } : null,
        topIntents,
        etapaDistribution
      },
      
      // 2. RENDIMIENTO DEL BOT
      performance: {
        fcrRate: parseFloat(fcrRate),
        escalationRate: parseFloat(escalationRate),
        taskSuccess: {
          appointments: parseFloat(appointmentSuccessRate),
          reschedules: parseFloat(rescheduleSuccessRate),
          infoDelivery: parseFloat(infoSuccessRate)
        },
        avgResponseTime: parseFloat(avgResponseTime),
        avgConversationDuration: parseFloat(avgConversationDuration)
      },
      
      // 3. MÉTRICAS DE CONVERSIÓN
      conversion: {
        conversionRate: parseFloat(conversionRate),
        confirmationRate: parseFloat(confirmationRate),
        conversationsWithAppointment,
        confirmedAppointments
      },
      
      // 4. MÉTRICAS DE NEGOCIO
      business: {
        totalAppointmentsGenerated,
        appointmentsCancelled,
        appointmentsRescheduled,
        peakAppointmentDay: peakAppointmentDay ? { date: peakAppointmentDay[0], count: peakAppointmentDay[1] } : null,
        peakAppointmentHour: peakAppointmentHour ? { time: peakAppointmentHour[0], count: peakAppointmentHour[1] } : null,
        appointmentsByDay: Object.entries(appointmentsByDay).slice(-30).map(([date, count]) => ({ date, count })),
        appointmentsByHour: Object.entries(appointmentsByHour).map(([time, count]) => ({ time, count }))
      }
    });
  } catch (error) {
    console.error('Error en /api/analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/conversations - Lista de conversaciones
app.get('/api/conversations', (req, res) => {
  try {
    const allSessions = sessions.getAllSessions();
    
    const conversations = allSessions.map(({ phone, session }) => {
      const lastMessage = session.historial && session.historial.length > 0
        ? session.historial[session.historial.length - 1]
        : null;
      
      return {
        phone,
        nombre: session.nombre_cliente || session.nombre_novia || null,
        fechaBoda: session.fecha_boda || null,
        etapa: session.etapa || 'primer_contacto',
        lastMessage: lastMessage ? {
          message: lastMessage.content,
          timestamp: lastMessage.timestamp
        } : null,
        lastActivity: session.ultima_actividad,
        firstActivity: session.historial?.[0]?.timestamp || session.ultima_actividad,
        messageCount: session.historial?.length || 0,
        hasAppointment: session.etapa === 'cita_agendada' || !!session.calendar_event_id,
        botPaused: !!(session.bot_paused_until && new Date(session.bot_paused_until) > new Date()),
        pausedUntil: session.bot_paused_until || null
      };
    });

    // Ordenar por actividad más reciente primero
    conversations.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    
    res.json({ conversations });
  } catch (error) {
    console.error('Error en /api/conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/conversations/:phone - Mensajes de una conversación específica
// Usa peekSession para NO actualizar ultima_actividad y así evitar que la
// conversación salte al tope de la lista al abrirla desde el dashboard.
app.get('/api/conversations/:phone', (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    const session = sessions.peekSession(phone);

    if (!session) {
      return res.json({ phone, nombre: null, fechaBoda: null, etapa: 'primer_contacto', messages: [] });
    }

    const messages = (session.historial || []).map(msg => ({
      message: msg.content,
      direction: msg.role === 'user' ? 'incoming' : msg.role === 'system_event' ? 'system' : 'outgoing',
      timestamp: msg.timestamp
    }));

    res.json({
      phone,
      nombre: session.nombre_cliente || session.nombre_novia || null,
      fechaBoda: session.fecha_boda || null,
      etapa: session.etapa || 'primer_contacto',
      messages
    });
  } catch (error) {
    console.error('Error en /api/conversations/:phone:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/config - Obtener configuración del bot
app.get('/api/config', async (req, res) => {
  try {
    const businessConfig = getBizConfig() || {};

    res.json({
      business: businessConfig.negocio,
      horarios: businessConfig.horarios,
      catalogo: businessConfig.catalogo,
      precios: businessConfig.precios,
      staffPhones: businessConfig.staff_phones || [],
      existingClients: businessConfig.existing_clients || [],
      adminPhone: businessConfig._adminPhone || ADMIN_PHONE,
      botPhone: businessConfig._botPhone || process.env.PHONE_NUMBER_ID || process.env.DISPLAY_PHONE_NUMBER || ''
    });
  } catch (error) {
    console.error('Error en /api/config:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/config - Actualizar configuración del bot
app.put('/api/config', async (req, res) => {
  try {
    const { business, horarios, catalogo, precios, staffPhones, existingClients, adminPhone, botPhone } = req.body;

    // Work on a copy of the current in-memory config
    const currentConfig = { ...(getBizConfig() || {}) };

    if (business)  currentConfig.negocio  = { ...currentConfig.negocio,  ...business  };
    if (horarios)  currentConfig.horarios  = { ...currentConfig.horarios,  ...horarios  };
    if (catalogo)  currentConfig.catalogo  = { ...currentConfig.catalogo,  ...catalogo  };
    if (precios)   currentConfig.precios   = { ...currentConfig.precios,   ...precios   };

    if (Array.isArray(staffPhones)) {
      currentConfig.staff_phones = staffPhones.map(p => p.replace(/\D/g, '')).filter(Boolean);
      STAFF_PHONES = currentConfig.staff_phones;
      console.log(`✅ STAFF_PHONES actualizado: ${STAFF_PHONES.length} números`);
    }
    if (Array.isArray(existingClients)) {
      currentConfig.existing_clients = existingClients.map(p => p.replace(/\D/g, '')).filter(Boolean);
      EXISTING_CLIENTS = currentConfig.existing_clients;
      console.log(`✅ EXISTING_CLIENTS actualizado: ${EXISTING_CLIENTS.length} números`);
    }

    // Store adminPhone / botPhone inside the config document (underscore prefix = internal)
    if (adminPhone) {
      currentConfig._adminPhone = adminPhone;
      ADMIN_PHONE = adminPhone;
      console.log(`✅ ADMIN_PHONE actualizado a: ${adminPhone}`);
    }
    if (botPhone) {
      currentConfig._botPhone = botPhone;
      console.log(`✅ BOT_PHONE actualizado a: ${botPhone}`);
    }

    // Persist to DB (updates in-memory cache too via save())
    await saveBizConfig(currentConfig);

    res.json({ success: true, message: 'Configuración actualizada correctamente' });
  } catch (error) {
    console.error('Error en PUT /api/config:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/messages - Obtener todos los mensajes del bot
app.get('/api/messages', async (req, res) => {
  console.log('📥 GET /api/messages - Solicitud recibida');
  try {
    const messagesPath = path.join(__dirname, 'bot_messages.json');
    console.log('   Ruta del archivo:', messagesPath);
    
    // Verificar que el archivo existe
    try {
      await fs.promises.access(messagesPath);
      console.log('   ✅ Archivo encontrado');
    } catch (accessError) {
      console.error('❌ Archivo bot_messages.json no encontrado:', accessError);
      return res.status(404).json({ error: 'Archivo de mensajes no encontrado' });
    }
    
    const fileContent = await fs.promises.readFile(messagesPath, 'utf8');
    console.log('   ✅ Archivo leído, tamaño:', fileContent.length, 'caracteres');
    
    // Verificar que el contenido no esté vacío
    if (!fileContent || fileContent.trim().length === 0) {
      console.error('❌ Archivo bot_messages.json está vacío');
      return res.status(500).json({ error: 'Archivo de mensajes está vacío' });
    }
    
    const messagesData = JSON.parse(fileContent);
    console.log('   ✅ JSON parseado correctamente');
    console.log('   📤 Enviando respuesta JSON');
    res.json(messagesData);
  } catch (error) {
    console.error('❌ Error en /api/messages:', error);
    console.error('   Stack:', error.stack);
    
    // Si es un error de JSON, devolver un mensaje más claro
    if (error instanceof SyntaxError) {
      return res.status(500).json({ 
        error: 'Error parseando JSON del archivo de mensajes',
        details: error.message 
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/messages - Actualizar mensajes del bot
app.put('/api/messages', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages) {
      return res.status(400).json({ error: 'Se requiere el objeto messages' });
    }
    
    const messagesPath = path.join(__dirname, 'bot_messages.json');
    
    // Validar que el JSON sea válido antes de guardar
    const validatedMessages = JSON.parse(JSON.stringify(messages));
    
    // Guardar mensajes actualizados
    await fs.promises.writeFile(
      messagesPath,
      JSON.stringify(validatedMessages, null, 2),
      'utf8'
    );
    
    console.log('✅ Archivo bot_messages.json guardado correctamente');
    
    // Recargar mensajes en memoria para que los cambios se apliquen inmediatamente
    const { reloadBotMessages } = require('./config');
    const reloaded = reloadBotMessages();
    
    console.log('✅ Mensajes del bot actualizados y recargados en memoria');
    console.log(`   Verificando mensaje de prueba: ${reloaded?.saludo?.mensajes?.primer_contacto?.texto?.substring(0, 50) || 'N/A'}...`);
    
    res.json({ success: true, message: 'Mensajes actualizados correctamente' });
  } catch (error) {
    console.error('Error en PUT /api/messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/faqs - Obtener preguntas frecuentes del bot
app.get('/api/faqs', async (req, res) => {
  try {
    res.json((getBizConfig() || {}).faqs || []);
  } catch (error) {
    console.error('Error en /api/faqs:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/faqs - Actualizar preguntas frecuentes
app.put('/api/faqs', async (req, res) => {
  try {
    const { faqs } = req.body;
    if (!Array.isArray(faqs)) {
      return res.status(400).json({ error: 'Se requiere un array de FAQs' });
    }
    await saveBizConfig({ ...(getBizConfig() || {}), faqs });
    console.log('✅ FAQs actualizadas correctamente');
    res.json({ success: true, message: 'FAQs actualizadas correctamente' });
  } catch (error) {
    console.error('Error en PUT /api/faqs:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/bot-mode - Obtener estado del bot (unificado: inactive, test, active)
app.get('/api/bot-mode', (req, res) => {
  try {
    const mode = getBotMode();
    res.json({ mode });
  } catch (error) {
    console.error('Error en /api/bot-mode:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/bot-mode - Actualizar estado del bot (unificado)
app.put('/api/bot-mode', (req, res) => {
  try {
    const { mode } = req.body;
    
    if (!['inactive', 'test', 'active'].includes(mode)) {
      return res.status(400).json({ error: 'El campo "mode" debe ser "inactive", "test", o "active"' });
    }
    
    const success = setBotMode(mode);
    
    if (success) {
      const messages = {
        'inactive': 'Bot desactivado - No responderá a ningún mensaje',
        'test': 'Modo de pruebas activado - Solo responderá a +525521920710',
        'active': 'Bot activado - Responderá a todos los números'
      };
      res.json({ success: true, mode, message: messages[mode] });
    } else {
      res.status(500).json({ error: 'Error al guardar el estado del bot' });
    }
  } catch (error) {
    console.error('Error en PUT /api/bot-mode:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de diagnóstico para verificar el modo test
app.get('/api/test-mode-diagnostic', (req, res) => {
  try {
    const mode = getBotMode();
    const TEST_PHONE_FULL = '525521920710';
    const TEST_PHONE_SHORT = '5521920710';
    
    // Probar diferentes formatos del número de prueba
    const testNumbers = [
      '+525521920710',
      '525521920710',
      '5521920710',
      '5255219207100',
      '15521920710',
      '+15521920710'
    ];
    
    const results = testNumbers.map(testNum => {
      const cleanPhone = testNum.replace(/\D/g, '');
      const exactMatchFull = cleanPhone === TEST_PHONE_FULL;
      const exactMatchShort = cleanPhone === TEST_PHONE_SHORT;
      const endsWithMatch = cleanPhone.length >= 10 && cleanPhone.length <= 12 && cleanPhone.endsWith(TEST_PHONE_SHORT);
      const phoneMatches = exactMatchFull || exactMatchShort || endsWithMatch;
      
      return {
        original: testNum,
        cleaned: cleanPhone,
        matches: phoneMatches,
        details: {
          exactMatchFull,
          exactMatchShort,
          endsWithMatch
        }
      };
    });
    
    res.json({
      success: true,
      currentMode: mode,
      testPhoneFull: TEST_PHONE_FULL,
      testPhoneShort: TEST_PHONE_SHORT,
      testResults: results,
      message: mode === 'test' 
        ? 'Modo test activo - Solo +525521920710 puede enviar mensajes'
        : `Modo actual: ${mode} - Verifica los resultados arriba`
    });
  } catch (error) {
    console.error('Error en diagnóstico de modo test:', error);
    res.status(500).json({ error: 'Error al diagnosticar el modo test' });
  }
});

// Endpoints de compatibilidad (deprecados, usar /api/bot-mode)
app.get('/api/bot-status', (req, res) => {
  try {
    const mode = getBotMode();
    res.json({ active: mode !== 'inactive' });
  } catch (error) {
    console.error('Error en /api/bot-status:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/bot-status', (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'Se requiere el campo "active" (boolean)' });
    }
    const success = setBotMode(active ? 'active' : 'inactive');
    if (success) {
      res.json({ success: true, active, message: `AI Agent ${active ? 'activado' : 'desactivado'} correctamente` });
    } else {
      res.status(500).json({ error: 'Error al guardar el estado del AI Agent' });
    }
  } catch (error) {
    console.error('Error en PUT /api/bot-status:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test-mode-status', (req, res) => {
  try {
    const mode = getBotMode();
    res.json({ active: mode === 'test' });
  } catch (error) {
    console.error('Error en /api/test-mode-status:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/test-mode-status', (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'Se requiere el campo "active" (boolean)' });
    }
    const success = setBotMode(active ? 'test' : 'active');
    if (success) {
      const message = active 
        ? 'Modo de pruebas activado - El bot solo responderá a +525521920710'
        : 'Modo de pruebas desactivado - El bot responderá a todos';
      res.json({ success: true, active, message });
    } else {
      res.status(500).json({ error: 'Error al guardar el estado del modo de pruebas' });
    }
  } catch (error) {
    console.error('Error en PUT /api/test-mode-status:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/appointments - Citas agendadas
app.get('/api/appointments', async (req, res) => {
  try {
    const allSessions = sessions.getAllSessions();
    const appointments = [];
    
    for (const { phone, session } of allSessions) {
      if (session.etapa === 'cita_agendada') {
        appointments.push({
          phone,
          name: session.nombre_cliente || session.nombre_novia || 'Sin nombre',
          fechaBoda: session.fecha_boda || null,
          fechaCita: session.fecha_cita || null,
          calendarEventId: session.calendar_event_id || null,
          agendadaEn: session.cita_agendada_en || session.ultima_actividad // cuándo se agendó
        });
      }
    }

    // Ordenar por fecha en que fue agendada — más reciente primero
    appointments.sort((a, b) => new Date(b.agendadaEn) - new Date(a.agendadaEn));
    
    res.json({ appointments });
  } catch (error) {
    console.error('Error en /api/appointments:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/pending-tasks — Tareas pendientes (in-memory)
app.get('/api/pending-tasks', (req, res) => {
  try {
    const tasks = getPendingTasks();
    res.json({ tasks });
  } catch (error) {
    console.error('Error en /api/pending-tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/pending-tasks/:id — Marcar tarea como resuelta
app.delete('/api/pending-tasks/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'id inválido' });
    }
    resolvePendingTask(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error resolviendo tarea pendiente:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/pending-tasks — Marcar múltiples tareas como resueltas
// Body: { ids: [1, 2, 3] }  (si no se envían ids, resuelve todas)
app.delete('/api/pending-tasks', express.json(), (req, res) => {
  try {
    const tasks = getPendingTasks();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : tasks.map(t => t.id);
    resolveMultipleTasks(ids);
    res.json({ success: true, resolved: ids.length });
  } catch (error) {
    console.error('Error resolviendo tareas pendientes en bulk:', error);
    res.status(500).json({ error: error.message });
  }
});

// Exportar snapshot de toda la data en memoria (sesiones + tareas pendientes)
app.get('/api/export-snapshot', (req, res) => {
  const { getAllSessions } = require('./sessions');
  const allSessions = getAllSessions ? getAllSessions() : [];
  const tasks = getPendingTasks();

  const snapshot = {
    exportedAt: new Date().toISOString(),
    sessions: allSessions,
    pendingTasks: tasks
  };

  res.setHeader('Content-Disposition', `attachment; filename="snapshot-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(snapshot);
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;

// Inicializar Google Calendar antes de iniciar el servidor
initGoogleAuth()
  .then(() => Promise.all([sessions.init(), sheetsService.init(), initBizConfig()]))
  .then(() => loadRuntimePhones())
  .then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 =====================================`);
    console.log(`✅ Bot de WhatsApp escuchando en puerto ${PORT}`);
    console.log(`📱 Proveedor: Chakra (BSP de WhatsApp)`);
    if (CHAKRA_API_KEY) {
      console.log(`🔑 Chakra API Key: Configurado (length: ${CHAKRA_API_KEY.trim().length})`);
    } else {
      console.log(`⚠️  Chakra API Key: No configurado`);
    }
    if (CHAKRA_PLUGIN_ID) {
      console.log(`🔌 Chakra Plugin ID: Configurado (${CHAKRA_PLUGIN_ID.trim()})`);
    } else {
      console.log(`⚠️  Chakra Plugin ID: No configurado`);
      console.log(`⚠️  ⚠️  ⚠️  IMPORTANTE: Configura CHAKRA_PLUGIN_ID en Railway → Variables`);
      console.log(`⚠️  ⚠️  ⚠️  Valor esperado: 32b42eb8-d886-429d-a0c2-12964b08bf21`);
    }
    if (authClient) {
      console.log(`📅 Google Calendar: Conectado`);
    } else {
      console.log(`⚠️  Google Calendar: No configurado (usando horarios por defecto)`);
    }
    console.log(`🚀 =====================================\n`);
    console.log('💡 Configuración del webhook en Chakra:');
    console.log(`   URL: https://tu-url-ngrok.com/webhook`);
    console.log(`   Verify Token: ${VERIFY_TOKEN}`);
    console.log(`   Método: POST\n`);
  });
}).catch(error => {
  console.error('❌ Error al inicializar:', error);
  // Iniciar servidor de todas formas, pero sin Google Calendar
  app.listen(PORT, () => {
    console.log(`\n⚠️  Bot iniciado SIN Google Calendar`);
    console.log(`✅ Bot de WhatsApp escuchando en puerto ${PORT}`);
    console.log(`📱 Proveedor: Chakra (BSP de WhatsApp)`);
  });
});

// Manejo de errores
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Error no manejado:', reason);
});

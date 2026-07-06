/**
 * Session Management Module
 *
 * Manages conversation state per WhatsApp phone number.
 * Uses in-memory Map as runtime cache with write-through persistence to PostgreSQL.
 * Call init() once at server startup to pre-load sessions from DB.
 */

const pool = require('./db');

const sessions = new Map();

// ── DB helpers ─────────────────────────────────────────────────────────────

function saveSessionToDB(phone, data) {
  pool.query(
    `INSERT INTO sessions (phone, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone) DO UPDATE SET data = $2, updated_at = NOW()`,
    [phone, data]
  ).catch(err => console.error('⚠️  Error guardando sesión en DB:', err.message));
}

function deleteSessionFromDB(phone) {
  pool.query('DELETE FROM sessions WHERE phone = $1', [phone])
    .catch(err => console.error('⚠️  Error eliminando sesión de DB:', err.message));
}

/** Load all sessions from DB into memory. Call once before server starts. */
async function init() {
  try {
    const result = await pool.query('SELECT phone, data FROM sessions');
    for (const row of result.rows) {
      sessions.set(row.phone, row.data);
    }
    console.log(`📂 Sesiones restauradas desde DB: ${result.rows.length}`);
  } catch (err) {
    console.error('⚠️  Error inicializando sesiones desde DB:', err.message);
  }
}

// ── Session API (same interface as before) ─────────────────────────────────

/**
 * Session structure:
 * {
 *   nombre_novia: string | null,
 *   fecha_boda: string | null,
 *   fecha_cita: string | null,
 *   etapa: 'primer_contacto' | 'interesada' | 'cita_agendada',
 *   historial: Array<{role: string, content: string}>,
 *   ultima_actividad: Date (ISO string),
 *   slots_disponibles: Array | null,
 *   fecha_cita_solicitada: string | null,
 *   bot_paused_until: string | null
 * }
 */

function getSession(phone) {
  const cleanPhone = phone.replace(/\D/g, '');

  if (!sessions.has(cleanPhone)) {
    const newSession = {
      nombre_novia: null,
      fecha_boda: null,
      fecha_cita: null,
      etapa: 'primer_contacto',
      historial: [],
      ultima_actividad: new Date().toISOString(),
      slots_disponibles: null,
      fecha_cita_solicitada: null,
      bot_paused_until: null
    };
    sessions.set(cleanPhone, newSession);
    console.log(`📝 Nueva sesión creada para: ${cleanPhone}`);
    return newSession;
  }

  const session = sessions.get(cleanPhone);
  session.ultima_actividad = new Date().toISOString();
  return session;
}

function peekSession(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  return sessions.get(cleanPhone) || null;
}

function updateSession(phone, data, options = {}) {
  const cleanPhone = phone.replace(/\D/g, '');
  // Guardar la actividad previa ANTES de getSession, que la re-sella al leer
  const previousActivity = sessions.get(cleanPhone)?.ultima_actividad;
  const session = getSession(cleanPhone);

  if (data.etapa && !['primer_contacto', 'interesada', 'cita_agendada'].includes(data.etapa)) {
    console.warn(`⚠️  Etapa inválida: ${data.etapa}. Usando valor por defecto.`);
    delete data.etapa;
  }

  Object.assign(session, data);
  // touch: false → cambio administrativo (backfill de flags): no debe mover
  // la conversación al día de hoy en el dashboard
  session.ultima_actividad = (options.touch === false && previousActivity)
    ? previousActivity
    : new Date().toISOString();

  const importantChanges = ['etapa', 'nombre_novia', 'fecha_boda', 'fecha_cita', 'calendar_event_id', 'escalated_to_human', 'resolved_by_agent'];
  const hasImportantChange = importantChanges.some(key => Object.prototype.hasOwnProperty.call(data, key));

  if (hasImportantChange) {
    console.log(`📝 Sesión actualizada: ${cleanPhone} - ${Object.keys(data).join(', ')}`);
    saveSessionToDB(cleanPhone, session);
  }

  return session;
}

function addToHistory(phone, role, content) {
  const session = getSession(phone);
  const cleanPhone = phone.replace(/\D/g, '');

  if (!['user', 'assistant', 'system'].includes(role)) {
    console.warn(`⚠️  Rol inválido: ${role}. Usando 'user' por defecto.`);
    role = 'user';
  }

  // Deduplicar: ignorar si el último mensaje del mismo rol es idéntico
  // (evita duplicados cuando el usuario reenvía el mismo mensaje)
  const lastSameRole = [...session.historial].reverse().find(m => m.role === role);
  if (lastSameRole && lastSameRole.content === content && role === 'user') {
    const secondsAgo = (Date.now() - new Date(lastSameRole.timestamp).getTime()) / 1000;
    if (secondsAgo < 60) {
      console.log(`🔁 [DEDUP] Mensaje duplicado ignorado para ${phone}: "${content.slice(0, 40)}"`);
      return;
    }
  }

  session.historial.push({
    role,
    content,
    timestamp: new Date().toISOString()
  });

  if (session.historial.length > 50) {
    session.historial = session.historial.slice(-50);
  }

  session.ultima_actividad = new Date().toISOString();
  saveSessionToDB(cleanPhone, session);
}

function clearSession(phone) {
  const cleanPhone = phone.replace(/\D/g, '');

  if (sessions.has(cleanPhone)) {
    sessions.delete(cleanPhone);
    console.log(`🗑️  Sesión eliminada para: ${cleanPhone}`);
    deleteSessionFromDB(cleanPhone);
    return true;
  }

  return false;
}

function getAllSessions() {
  return Array.from(sessions.entries()).map(([phone, session]) => ({
    phone,
    session
  }));
}

function getSessionCount() {
  return sessions.size;
}

function clearAllSessions() {
  const count = sessions.size;
  sessions.clear();
  console.log(`🗑️  Todas las sesiones eliminadas (${count} sesiones)`);
  pool.query('DELETE FROM sessions')
    .catch(err => console.error('⚠️  Error eliminando sesiones de DB:', err.message));
}

function getOldSessions(hours = 24) {
  const threshold = new Date(Date.now() - hours * 60 * 60 * 1000);
  const oldSessions = [];

  sessions.forEach((session, phone) => {
    const lastActivity = new Date(session.ultima_actividad);
    if (lastActivity < threshold) {
      oldSessions.push(phone);
    }
  });

  return oldSessions;
}

function cleanupOldSessions(hours = 24) {
  const oldSessions = getOldSessions(hours);
  oldSessions.forEach(phone => clearSession(phone));
  return oldSessions.length;
}

module.exports = {
  init,
  getSession,
  peekSession,
  updateSession,
  clearSession,
  addToHistory,
  getAllSessions,
  getSessionCount,
  clearAllSessions,
  getOldSessions,
  cleanupOldSessions
};

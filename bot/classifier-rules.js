/**
 * Rule-based Intent Classifier
 * 
 * Fast, rule-based classification for common cases.
 * Falls back to LLM only when rules don't match.
 */

/**
 * Classify intent using simple rules (no LLM)
 * Only handles very obvious cases. Everything else goes to LLM for better understanding.
 * @param {string} message - User's message
 * @param {Object} session - Session object
 * @returns {string|null} Intent if matched by rules, null otherwise (null = use LLM)
 */
function classifyIntentWithRules(message, session) {
  const msg = message.toLowerCase().trim();
  
  // ONLY handle very obvious cases. For everything else, return null to use LLM.
  // This ensures the LLM can use full conversation context to make better decisions.
  
  // PRIORITY 1 (HIGHEST): If user explicitly wants to cancel/reschedule, handle it immediately
  // This must be checked FIRST, even before info collection, to ensure reschedule/cancel requests
  // are not incorrectly classified as AGENDAR_NUEVA
  // NOTE: 'no puedo', 'no podré', 'no voy' are intentionally excluded — they are too ambiguous
  // and can be false positives (e.g. "no puedo el martes, ¿tienen el miércoles?").
  // The LLM handles these cases correctly with full conversation context.
  const cancelKeywords = ['cancelar', 'cancel', 'no asistiré', 'no asistire', 'cancelar mi cita', 'cancelar cita'];
  const rescheduleKeywords = ['reagendar', 'cambiar', 'otra fecha', 'otro día', 'otro dia', 'mover', 'mover cita', 'cambiar fecha', 'cambiar mi cita', 'quiero cambiar'];
  
  if (cancelKeywords.some(kw => msg.includes(kw))) {
    return 'CANCELAR_CITA';
  }
  if (rescheduleKeywords.some(kw => msg.includes(kw))) {
    return 'CAMBIAR_CITA';
  }
  
  // PRIORITY 2: If user is providing info during scheduling flow, let LLM handle it
  // The LLM can better understand context, corrections, clarifications, etc.
  // We only force AGENDAR_NUEVA for pending_agendar_fecha (when user is providing appointment date)
  // For pending_nombre and pending_fecha_boda, let LLM analyze to understand the user's intent
  // This allows the LLM to handle corrections like "El día que te estoy diciendo no es lunes!!!!"
  
  // NOTE: We no longer force SALUDO for info collection
  // Users can access other features (info, catalog, etc.) without providing info first
  // Info will only be collected when they want to schedule an appointment
  
  // Check if there's an existing appointment
  const hasAppointment = session.etapa === 'cita_agendada' || session.calendar_event_id;
  
  // AGENDAR_NUEVA: If user is in the process of scheduling (pending flags)
  // This should be checked AFTER cancel/reschedule keywords to avoid conflicts
  // CRITICAL: Only force AGENDAR_NUEVA when pending flag is active AND message seems related
  // If user wants to change topic (info, catalog, prices), let LLM classify correctly
  // This allows users to switch topics even during info collection
  
  // Keywords that indicate user wants to change topic (not responding to pending question)
  const topicChangeKeywords = [
    'información', 'informacion', 'info', 'quiero información', 'quiero informacion',
    'catálogo', 'catalogo', 'vestidos', 'modelos', 'colección', 'coleccion',
    'precios', 'precio', 'cuánto', 'cuanto', 'cuesta', 'costo',
    'ubicación', 'ubicacion', 'dirección', 'direccion', 'dónde', 'donde',
    'asesor', 'hablar con', 'contactar'
  ];
  
  const isChangingTopic = topicChangeKeywords.some(kw => msg.includes(kw));
  
  if (session.pending_tipo_cita) {
    console.log(`📌 pending_tipo_cita activo - FORZANDO AGENDAR_NUEVA`);
    return 'AGENDAR_NUEVA';
  }

  if (session.pending_agendar_fecha) {
    // For pending_agendar_fecha, always force AGENDAR_NUEVA (user is providing appointment date)
    console.log(`📌 pending_agendar_fecha activo - FORZANDO AGENDAR_NUEVA para que el mensaje llegue a agendar.js`);
    return 'AGENDAR_NUEVA';
  }
  
  if (session.pending_nombre) {
    // If user is changing topic, let LLM classify
    if (isChangingTopic) {
      console.log(`📌 pending_nombre activo pero usuario quiere cambiar de tema - dejando que LLM clasifique`);
      return null;
    }
    console.log(`📌 pending_nombre activo - FORZANDO AGENDAR_NUEVA para que el mensaje llegue a agendar.js`);
    return 'AGENDAR_NUEVA';
  }
  
  if (session.pending_fecha_boda) {
    // If user is changing topic, let LLM classify
    if (isChangingTopic) {
      console.log(`📌 pending_fecha_boda activo pero usuario quiere cambiar de tema - dejando que LLM clasifique`);
      return null;
    }
    // Also check if message contains a date (likely responding to wedding date question)
    const datePattern = /\d{1,2}\s*(de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s*\d{0,4}/i;
    const hasDate = datePattern.test(msg) || /\d{4}-\d{2}-\d{2}/.test(msg);
    
    if (hasDate) {
      console.log(`📌 pending_fecha_boda activo y mensaje contiene fecha - FORZANDO AGENDAR_NUEVA`);
      return 'AGENDAR_NUEVA';
    }
    
    // If no date and not changing topic, still force AGENDAR_NUEVA (might be ambiguous response)
    console.log(`📌 pending_fecha_boda activo - FORZANDO AGENDAR_NUEVA para que el mensaje llegue a agendar.js`);
    return 'AGENDAR_NUEVA';
  }
  
  // AGENDAR_NUEVA: User wants to see afternoon slots or medio día slots (very specific context)
  if (!hasAppointment) {
    if (session.slots_tarde && session.slots_tarde.length > 0) {
      const afternoonKeywords = ['sí', 'si', 'tarde', 'afternoon', 'quiero ver', 'muéstrame', 'muestrame', 'opciones de tarde', 'por la tarde'];
      if (afternoonKeywords.some(kw => msg.includes(kw))) {
        return 'AGENDAR_NUEVA';
      }
    }
    if (session.slots_medio_dia && session.slots_medio_dia.length > 0) {
      const medioDiaKeywords = ['sí', 'si', 'medio día', 'medio dia', 'mañana', 'quiero ver', 'muéstrame', 'muestrame', 'opciones de medio día'];
      if (medioDiaKeywords.some(kw => msg.includes(kw))) {
        return 'AGENDAR_NUEVA';
      }
    }
  }
  
  // SALUDO: Only very obvious greetings (exact matches or with punctuation)
  const greetingKeywords = ['hola', 'hi', 'hello', 'buenos días', 'buenos dias', 'buenas tardes', 'buenas noches', 'buen día', 'buen dia'];
  // Check for exact match, starts with keyword + space, or keyword followed by punctuation
  if (greetingKeywords.some(kw => {
    return msg === kw || 
           msg.startsWith(kw + ' ') || 
           msg.startsWith(kw + '!') ||
           msg.startsWith(kw + '?') ||
           msg.startsWith(kw + '.');
  })) {
    return 'SALUDO';
  }
  
  // Everything else goes to LLM for better understanding with full context
  // The LLM can distinguish between:
  // - "Tiene el vestido Camila disponible?" → CATALOGO
  // - "Tienen disponible para el martes?" → AGENDAR_NUEVA
  // - "¿Cuánto cuesta?" → PRECIOS
  // - etc.
  
  // No match found - return null to use LLM
  return null;
}

module.exports = {
  classifyIntentWithRules
};

/**
 * Agendar Handler
 * 
 * Handles appointment scheduling requests.
 * This is the ONLY handler that calls Google Calendar.
 * 
 * Flow:
 * 1. Extract fecha_cita_deseada from message (using focused OpenAI call)
 * 2. If no date mentioned, ask user for preferred date/time
 * 3. If date found, query Google Calendar for available slots
 * 4. Return slots as interactive buttons
 */

const OpenAI = require('openai');
const { getAvailableSlots, isDayOpen, createCalendarEvent: createCalendarEventService } = require('../calendar-service');
const {
  getBusinessName,
  getBusinessHours
} = require('../../config');

// Lazy initialization of OpenAI client (only when needed)
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurado en las variables de entorno');
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;
}

/**
 * Extract appointment date from message using focused OpenAI call
 * @param {string} message - User's message
 * @param {string} fechaBoda - Wedding date (to avoid confusion)
 * @returns {Promise<string|null>} Date in YYYY-MM-DD format or null
 */
async function extractFechaCitaDeseada(message, fechaBoda) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ OPENAI_API_KEY no está configurado. Configúralo en Railway → Variables.');
      throw new Error('OPENAI_API_KEY no está configurado. Configúralo en Railway → Variables.');
    }

    const systemPrompt = `Eres un extractor de fechas para citas de showroom.

Tu tarea es extraer SOLO la fecha que el usuario quiere para VISITAR el showroom (la fecha de la cita, NO la fecha de la boda).

IMPORTANTE:
- La FECHA DE BODA es: ${fechaBoda || 'no mencionada'}
- El año actual es 2026
- NO extraigas la fecha de boda, solo la fecha para visitar el showroom
- Si el usuario dice "tienen libre el martes 24 de febrero", extrae "2026-02-24" (ignora el día de la semana, usa solo el número de día)
- Si el usuario dice "quiero ir el 4 de marzo", extrae "2026-03-04"
- Si el usuario dice "martes 17 de marzo", extrae "2026-03-17" (ignora "martes", usa solo el día 17)
- Si el usuario dice "el 4 de marzo 2026", extrae "2026-03-04"
- Si el usuario dice "el 4 de marzo" (sin año), asume año 2026 y extrae "2026-03-04"
- Si el usuario solo menciona la fecha de boda sin mencionar una fecha de visita, devuelve null
- Si no hay fecha de visita mencionada, devuelve null
- SIEMPRE usa el año 2026 cuando el usuario no especifica el año
- IGNORA los días de la semana (lunes, martes, miércoles, etc.) y usa SOLO el número de día y mes

Responde SOLO con una fecha en formato YYYY-MM-DD o la palabra "null" si no hay fecha de visita mencionada.
No agregues explicaciones, solo la fecha o "null".`;

    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 20,
      temperature: 0.1 // Low temperature for consistent extraction
    });

    const extractedText = response.choices[0].message.content.trim();
    console.log(`🔍 Texto extraído por LLM: "${extractedText}"`);
    
    if (extractedText.toLowerCase() === 'null' || extractedText.toLowerCase() === 'none' || !extractedText) {
      return null;
    }

    // Try to parse and normalize the date
    try {
      let year, month, day;
      
      // First, check if it's already in YYYY-MM-DD format
      const dateMatch = extractedText.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        // Already in YYYY-MM-DD format, extract components directly
        // IMPORTANT: Parse directly to avoid timezone issues
        year = parseInt(dateMatch[1]);
        month = parseInt(dateMatch[2]);
        day = parseInt(dateMatch[3]);
        console.log(`📅 Fecha en formato YYYY-MM-DD detectada: año=${year}, mes=${month}, día=${day}`);
      } else {
        // Try to parse as a date string (might be in Spanish format)
        const spanishMonths = {
          'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
          'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
        };
        
        // Check if it's in Spanish format like "4 de marzo 2026" or "4 marzo 2026" or "4 de marzo" (sin año)
        // Also handle "Martes 17 de marzo" - ignore day of week
        // Pattern: (optional day of week) (day number) (optional "de") (month name) (optional year)
        const spanishDateMatch = extractedText.match(/(?:(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\s+)?(\d{1,2})\s*(?:de\s*)?(\w+)(?:\s*(\d{4}))?/i);
        if (spanishDateMatch) {
          day = parseInt(spanishDateMatch[1]);
          const monthName = spanishDateMatch[2].toLowerCase();
          year = spanishDateMatch[3] ? parseInt(spanishDateMatch[3]) : 2026; // Default to 2026 if no year
          
          if (spanishMonths[monthName]) {
            month = spanishMonths[monthName];
            console.log(`📅 Fecha en español detectada: día=${day}, mes=${monthName} (${month}), año=${year}`);
          } else {
            throw new Error(`Mes en español no reconocido: ${monthName}`);
          }
        } else {
          // Try standard Date parsing, but extract components carefully
          // IMPORTANT: When parsing dates, use local timezone to avoid day shifts
          const parsedDate = new Date(extractedText);
          if (!isNaN(parsedDate.getTime())) {
            // Extract components using LOCAL methods to avoid timezone shifts
            // Using UTC methods can cause the date to shift by one day depending on timezone
            // For example, "2026-03-17" parsed as UTC might become "2026-03-16" in local time
            year = parsedDate.getFullYear();
            month = parsedDate.getMonth() + 1;
            day = parsedDate.getDate();
            console.log(`📅 Fecha parseada (local): año=${year}, mes=${month}, día=${day}`);
          } else {
            throw new Error(`No se pudo parsear la fecha: ${extractedText}`);
          }
        }
      }
      
      // Validate and format the date
      if (year && month && day) {
        // Smart year detection: if year is missing or in the past, determine the correct year
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1; // 1-12
        
        // If year is missing or in the past, determine the correct year
        if (!year || year < currentYear) {
          // If the month is in the future relative to current month, use current year
          // If the month is in the past relative to current month, use next year
          if (month > currentMonth) {
            year = currentYear;
            console.log(`📅 Mes ${month} está en el futuro, usando año ${year}`);
          } else if (month < currentMonth) {
            year = currentYear + 1;
            console.log(`📅 Mes ${month} está en el pasado este año, usando año ${year}`);
          } else {
            // Same month: check if day is in the future
            const currentDay = currentDate.getDate();
            if (day >= currentDay) {
              year = currentYear;
              console.log(`📅 Día ${day} está en el futuro este mes, usando año ${year}`);
            } else {
              year = currentYear + 1;
              console.log(`📅 Día ${day} está en el pasado este mes, usando año ${year}`);
            }
          }
        } else if (year < currentYear) {
          console.log(`⚠️  Año ${year} está en el pasado, corrigiendo a ${currentYear}`);
          year = currentYear;
        }
        
        // Use local date constructor to avoid timezone issues
        const localDate = new Date(year, month - 1, day);
        
        // Verify the date is valid
        if (localDate.getFullYear() === year && 
            localDate.getMonth() === month - 1 && 
            localDate.getDate() === day) {
          const normalizedYear = String(year).padStart(4, '0');
          const normalizedMonth = String(month).padStart(2, '0');
          const normalizedDay = String(day).padStart(2, '0');
          const normalizedDate = `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
          console.log(`📅 Fecha de cita extraída: ${normalizedDate}`);
          return normalizedDate;
        } else {
          console.warn(`⚠️  Fecha inválida después de normalización: año=${year}, mes=${month}, día=${day}`);
        }
      }
    } catch (e) {
      console.warn(`⚠️  Error parseando fecha extraída: ${extractedText}`, e.message);
    }

    console.warn(`⚠️  No se pudo parsear la fecha extraída: ${extractedText}`);
    return null;
  } catch (error) {
    console.error('❌ Error extrayendo fecha de cita:', error.message);
    return null;
  }
}

/**
 * Check if message is a vague/relative date question (not a specific date)
 * @param {string} message - User's message
 * @returns {boolean} True if message is a vague date question
 */
function isVagueDateQuestion(message) {
  const msgLower = message.toLowerCase().trim();
  
  // Patterns that indicate vague/relative date questions
  const vaguePatterns = [
    /siguiente fin de semana/i,
    /próximo fin de semana/i,
    /proximo fin de semana/i,
    /siguiente semana/i,
    /próxima semana/i,
    /proxima semana/i,
    /fin de semana/i,
    /este fin de semana/i,
    /próximo/i,
    /proximo/i,
    /siguiente/i,
    /hay.*disponible/i,
    /tienen.*disponible/i,
    /qué.*disponible/i,
    /cuándo.*disponible/i,
    /cuando.*disponible/i,
    /horarios.*disponible/i,
    /disponibilidad/i
  ];
  
  // Check if message contains vague patterns
  const hasVaguePattern = vaguePatterns.some(pattern => pattern.test(msgLower));
  
  // Also check if message is a question (contains question words but no specific date)
  const isQuestion = /^(hay|tienen|qué|que|cuándo|cuando|tienes|tiene)/i.test(msgLower.trim());
  
  // If it has vague patterns OR is a question without specific date indicators, it's vague
  // Check for specific date patterns (e.g., "11 de marzo", "4/3", "4-3")
  const hasSpecificDate = /\d{1,2}\s*(de|\/|-)/.test(msgLower);
  if (hasVaguePattern || (isQuestion && !hasSpecificDate)) {
    return true;
  }
  
  return false;
}

/**
 * Format date for display (DD/MM/YYYY)
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {string} Formatted date
 */
function formatDate(date) {
  if (!date) return date;
  
  try {
    if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const [year, month, day] = date.split('-');
      return `${day}/${month}/${year}`;
    }
    
    const dateObj = new Date(date);
    if (!isNaN(dateObj.getTime())) {
      const day = String(dateObj.getDate()).padStart(2, '0');
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const year = dateObj.getFullYear();
      return `${day}/${month}/${year}`;
    }
  } catch (e) {
    // Return original if parsing fails
  }
  
  return date;
}

/**
 * Execute agendar intent handler
 * @param {Object} session - Session object
 * @param {string} message - User's message
 * @param {Object} calendarDeps - Calendar dependencies { calendarClient, authClient, calendarId }
 * @returns {Promise<Object>} { reply: string, sessionUpdates: object, buttons: array }
 */
async function execute(session, message, calendarDeps = null) {
  const nombre = getBusinessName();
  const horarios = getBusinessHours();
  const { analyzeContextualResponse } = require('../utils/context-analyzer');

  // Helper to get client name (supports both nombre_cliente and nombre_novia)
  const getClientName = (sess) => sess.nombre_cliente || sess.nombre_novia || null;

  // ── TIPO DE CITA ──────────────────────────────────────────────────────────
  // Preguntar UNA VEZ si es primera visita o cita de ajustes, ANTES de
  // cualquier otro flujo. Se usa session.tipo_cita para no preguntar dos veces.
  const hasAppointment = session.etapa === 'cita_agendada' || session.calendar_event_id;

  if (!hasAppointment && !session.tipo_cita) {
    if (session.pending_tipo_cita) {
      const msgLower = message.toLowerCase();
      const esAjuste = [
        'ajuste', 'ajustes', 'ya compré', 'ya compre', 'ya tengo',
        'ya soy client', 'arreglo', 'arreglos', 'de ajuste'
      ].some(k => msgLower.includes(k));

      const esPrimeraVez = [
        'primera vez', 'primera visita', 'nueva', 'nunca he ido',
        'nunca he visitado', 'por primera', 'no he ido', 'primer'
      ].some(k => msgLower.includes(k));

      if (esAjuste) {
        return {
          reply: 'Entendido 💕 Para agendar tu cita de ajustes te conectamos con una de nuestras asesoras. ¡Ya quedó registrada tu solicitud y en breve se pondrán en contacto contigo! 🤍',
          sessionUpdates: { pending_tipo_cita: false },
          escalate: true
        };
      }

      if (esPrimeraVez) {
        return {
          reply: `¡Perfecto, qué emoción! 👰‍♀️ ¿Qué día te gustaría visitarnos?\n\nEstamos abiertas de ${horarios.martes_sabado} y domingos de ${horarios.domingos} 🕒`,
          sessionUpdates: { pending_tipo_cita: false, tipo_cita: 'primera_vez', pending_agendar_fecha: true }
        };
      }

      // Respuesta ambigua — preguntar de nuevo
      return {
        reply: '¿Podrías decirme si es tu primera visita con nosotros o si ya tienes tu vestido y buscas agendar tu cita de ajustes? 😊',
        sessionUpdates: { pending_tipo_cita: true }
      };
    }

    // No hemos preguntado aún — preguntar ahora, independientemente de otros flags pendientes
    return {
      reply: '¡Con gusto agendamos tu cita! 💕\n\n¿Es tu primera visita con nosotros o ya tienes tu vestido y buscas agendar una cita de ajustes?',
      sessionUpdates: { pending_tipo_cita: true }
    };
  }

  // CRITICAL: If pending_agendar_fecha is active OR fecha_cita_solicitada is already set (from moving appointment flow),
  // we MUST process the appointment date immediately
  // Skip ALL info collection and submenu logic - user is providing appointment date
  if (session.pending_agendar_fecha || session.fecha_cita_solicitada) {
    console.log(`📅 Usuario está proporcionando fecha de cita (pending_agendar_fecha activo o fecha_cita_solicitada ya establecida), procesando directamente...`);
    
    // CRITICAL: Check if message is a vague date question BEFORE trying to extract date
    // If it's a vague question, respond naturally asking for a specific date
    if (isVagueDateQuestion(message)) {
      console.log(`📅 Mensaje es una pregunta vaga sobre fechas: "${message}"`);
      return {
        reply: `¡Claro! Para darte los horarios exactos, ¿podrías decirme un día específico? 💫\n\nPor ejemplo:\n• "el sábado 29 de marzo"\n• "el domingo 30 de marzo"\n• "el 4 de abril"\n\nAsí te muestro los horarios disponibles para ese día ✨`,
        sessionUpdates: {
          pending_agendar_fecha: true // Keep flag since we're still waiting for a specific date
        }
      };
    }
    
    // CRITICAL: Siempre intentar extraer fecha del mensaje primero
    // Solo usar fecha de sesión si no se encuentra una nueva fecha en el mensaje
    let fechaCitaDeseada = await extractFechaCitaDeseada(message, session.fecha_boda);
    
    // Si no se encontró fecha en el mensaje, verificar si es una pregunta vaga
    // Si NO es una pregunta vaga Y hay fecha_cita_solicitada, usar la de la sesión (para casos de rescheduling)
    if (!fechaCitaDeseada && session.fecha_cita_solicitada && !isVagueDateQuestion(message)) {
      console.log(`📅 No se encontró fecha en el mensaje, usando fecha de sesión: ${session.fecha_cita_solicitada}`);
      fechaCitaDeseada = session.fecha_cita_solicitada;
    }
    
    // Log para debugging
    if (fechaCitaDeseada) {
      console.log(`📅 Fecha extraída/procesada: ${fechaCitaDeseada}`);
    }
    
    // Clear pending_agendar_fecha flag if we got a date
    const sessionUpdates = {};
    if (fechaCitaDeseada && session.pending_agendar_fecha) {
      sessionUpdates.pending_agendar_fecha = false;
    }

    // If no date mentioned, ask for it
    if (!fechaCitaDeseada) {
      return {
        reply: `¡Con gusto! Nos encantará recibirte 💕\n\n¿Qué día te gustaría visitarnos? Puedes decirme, por ejemplo: "el martes 24 de febrero" o "el 4 de marzo".\n\nEstamos abiertos:\n• Martes a sábado: ${horarios.martes_sabado || 'N/A'}\n• Domingos: ${horarios.domingos || 'N/A'}\n• Lunes: ${horarios.lunes || 'Cerrado'}`,
        sessionUpdates: {
          pending_agendar_fecha: true // Flag to indicate we're waiting for appointment date
        }
      };
    }

    // Verify the date is not the wedding date (only if fecha_boda exists)
    if (session.fecha_boda && fechaCitaDeseada === session.fecha_boda) {
      return {
        reply: `Entiendo que mencionaste ${formatDate(fechaCitaDeseada)}, pero esa es la fecha de tu boda. ¿Qué día te gustaría visitarnos en el showroom? 💐`,
        sessionUpdates: {
          pending_agendar_fecha: true // Keep flag since we're still waiting for a valid date
        }
      };
    }
    
    // Clear pending_agendar_fecha flag since we got a valid date
    if (session.pending_agendar_fecha) {
      sessionUpdates.pending_agendar_fecha = false;
    }

    // Process the date and show available slots (continue with normal flow below)
    // This will skip all info collection and submenu logic
    // Store fechaCitaDeseada in session so we can use it later, then continue to slot processing
    sessionUpdates.fecha_cita_solicitada = fechaCitaDeseada;
    sessionUpdates.skipInfoCollection = true; // Flag to skip info collection blocks
    Object.assign(session, sessionUpdates);
    
    // IMPORTANT: Skip all info collection and submenu logic, go directly to slot processing
    // We'll continue to the slot processing code below (after all the info collection blocks)
    // Note: sessionUpdates will be merged with the final sessionUpdates at the end
  }
  
  // Check if this is a button click for "Agendar Nueva Cita" from submenu
  // If so, skip info collection and go directly to asking for appointment date
  // "menu_agendar_click" means user clicked main menu button (needs info collection)
  // "quiero agendar" or "cita_nueva" means user clicked submenu button (info already collected)
  const isCitaNuevaButton = message === 'quiero agendar' || message === 'cita_nueva';
  const isMenuAgendarClick = message === 'menu_agendar_click';
  
  if (isCitaNuevaButton) {
    // User clicked "Agendar Nueva Cita" from submenu - assume info is already collected
    // Skip all info collection checks and go directly to appointment date flow
    // Extract fecha_cita_deseada from message (will be empty string for button click)
    const fechaCitaDeseada = await extractFechaCitaDeseada(message, session.fecha_boda);
    
    if (!fechaCitaDeseada) {
      // No date in message, ask for appointment date
      return {
        reply: `¡Con gusto! Nos encantará recibirte 💕\n\n¿Qué día te gustaría visitarnos? Puedes decirme, por ejemplo: "el martes 24 de febrero" o "el 4 de marzo".\n\nEstamos abiertos:\n• Martes a sábado: ${horarios.martes_sabado || 'N/A'}\n• Domingos: ${horarios.domingos || 'N/A'}\n• Lunes: ${horarios.lunes || 'Cerrado'}`,
        sessionUpdates: {
          pending_agendar_fecha: true
        }
      };
    }
    // If date was found in message, continue with normal appointment scheduling flow below
    // (skip all info collection checks)
  }
  
  // If NOT a button click for "Agendar Nueva Cita", proceed with info collection if needed
  // This includes: menu_agendar_click (from main menu) and regular text messages
  // BUT: Skip if we already processed the appointment date above (skipInfoCollection flag)
  if (!isCitaNuevaButton && !session.skipInfoCollection) {
    
    // If we're waiting for name (pending_nombre), check if user provided it
    if (session.pending_nombre === true) {
      // Use LLM to analyze if user provided their name
      const nameAnalysis = await analyzeContextualResponse(
      message,
      'name_collection',
      session,
      {}
    );
    
    if (nameAnalysis.action === 'provide_name' || nameAnalysis.action === 'provide_first_name') {
      // User provided name - extract and save it
      let extractedName = nameAnalysis.extractedValue;
      
      // If only first name provided, we'll still use it but note it's incomplete
      if (!extractedName) {
        // Try to extract from message directly
        const nameMatch = message.match(/(?:me\s+llamo|soy|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
        if (nameMatch) {
          extractedName = nameMatch[1];
        } else {
          // Try simple extraction: first capitalized words
          const words = message.split(/\s+/).filter(w => /^[A-ZÁÉÍÓÚÑ]/.test(w));
          if (words.length >= 1) {
            extractedName = words.slice(0, 2).join(' '); // Take first 2 capitalized words
          }
        }
      }
      
      if (extractedName) {
        const sessionUpdates = {
          nombre_cliente: extractedName,
          nombre_novia: extractedName, // Backward compatibility
          pending_nombre: false
        };
        
        // Now check if we need fecha_boda
        if (!session.fecha_boda && !session.fecha_boda_declinada) {
          const nombrePrimero = extractedName.split(' ')[0];
          return {
            reply: `¡Perfecto ${nombrePrimero}! ✨ Para ayudarte mejor, ¿me compartes la fecha completa de tu boda? Por favor incluye el día, mes y año (por ejemplo: "10 de julio 2026"). Si aún no la tienes definida, no hay problema, solo dímelo 💫`,
            sessionUpdates: {
              ...sessionUpdates,
              pending_fecha_boda: true
            }
          };
        }
        
        // We have name and fecha_boda (or declined), show cita submenu
        // Update session and show submenu so user can choose what to do
        const { getClientFirstName } = require('../utils/name-utils');
        const nombrePrimero = getClientFirstName(session) || extractedName.split(' ')[0];
        
        // Show cita submenu instead of continuing directly
        const citaMenuHandler = require('./cita-menu');
        const citaMenuResult = await citaMenuHandler.execute(session, message);
        
        return {
          reply: citaMenuResult.reply,
          sessionUpdates: {
            ...sessionUpdates,
            ...citaMenuResult.sessionUpdates
          },
          buttons: citaMenuResult.buttons
        };
      } else {
        // Couldn't extract name, ask again
        return {
          reply: `¡Me encantaría ayudarte a agendar! 👰‍♀️ Pero primero necesito tu nombre completo (nombre y apellido) para personalizar tu experiencia.\n\n¿Me lo compartes?`,
          sessionUpdates: {
            pending_nombre: true
          }
        };
      }
    } else {
      // User didn't provide name clearly, ask again
      return {
        reply: `¡Me encantaría ayudarte a agendar! 👰‍♀️ Pero primero necesito tu nombre completo (nombre y apellido) para personalizar tu experiencia.\n\n¿Me lo compartes?`,
        sessionUpdates: {
          pending_nombre: true
        }
      };
    }
    } // End of if (session.pending_nombre === true)
    
    // Check if we have nombre_cliente/nombre_novia - ask for it if missing
    if (!getClientName(session)) {
      return {
        reply: `¡Me encantaría ayudarte a agendar! 👰‍♀️ Pero primero necesito tu nombre completo (nombre y apellido) para personalizar tu experiencia.\n\n¿Me lo compartes?`,
        sessionUpdates: {
          pending_nombre: true // Flag to indicate we're waiting for name
        }
      };
    }
    
    // If we have both name and fecha_boda (or declined), and we're not in a pending state,
    // show cita submenu directly (user clicked "Agendar/Editar Cita" and already has info)
    // BUT: Skip this if pending_agendar_fecha is active (user is providing appointment date)
    if (getClientName(session) && (session.fecha_boda || session.fecha_boda_declinada) && 
        !session.pending_nombre && !session.pending_fecha_boda && !session.pending_agendar_fecha && !isCitaNuevaButton) {
      // User has all info, show submenu directly
      const citaMenuHandler = require('./cita-menu');
      const citaMenuResult = await citaMenuHandler.execute(session, message);
      
      return {
        reply: citaMenuResult.reply,
        sessionUpdates: citaMenuResult.sessionUpdates || {},
        buttons: citaMenuResult.buttons
      };
    }
    
    // If we're waiting for fecha_boda (pending_fecha_boda), check if user provided it
    if (session.pending_fecha_boda === true) {
      // Use LLM to analyze if user provided wedding date or declined
      const dateAnalysis = await analyzeContextualResponse(
      message,
      'wedding_date_collection',
      session,
      {}
    );
    
    if (dateAnalysis.action === 'decline_date') {
      // User declined to provide date - mark it and show cita submenu
      const sessionUpdates = {
        fecha_boda_declinada: true,
        pending_fecha_boda: false
      };
      
      Object.assign(session, sessionUpdates);
      
      // Show cita submenu since user has completed info collection
      const citaMenuHandler = require('./cita-menu');
      const citaMenuResult = await citaMenuHandler.execute(session, message);
      
      return {
        reply: citaMenuResult.reply,
        sessionUpdates: {
          ...sessionUpdates,
          ...citaMenuResult.sessionUpdates
        },
        buttons: citaMenuResult.buttons
      };
    } else if (dateAnalysis.action === 'provide_date') {
      // User provided date - extract and save it immediately
      let extractedFechaBoda = null;
      
      // Try to extract date from message using profile extractor
      try {
        const { extractBrideProfile } = require('../profile-extractor');
        // Use recent history to provide context for extraction
        const recentHistory = (session.historial || []).slice(-5).concat([{ role: 'user', content: message }]);
        const profileData = await extractBrideProfile(recentHistory);
        if (profileData.fecha_boda) {
          extractedFechaBoda = profileData.fecha_boda;
          console.log(`📝 Fecha de boda extraída del mensaje: ${extractedFechaBoda}`);
        }
      } catch (e) {
        console.warn('⚠️  No se pudo extraer fecha de boda del mensaje:', e.message);
      }
      
      const sessionUpdates = {
        pending_fecha_boda: false
      };
      
      // If we extracted the date, save it immediately
      if (extractedFechaBoda) {
        sessionUpdates.fecha_boda = extractedFechaBoda;
        console.log(`✅ Fecha de boda guardada inmediatamente en sesión: ${extractedFechaBoda}`);
      } else {
        // If extraction failed, mark that we need to wait for profile extractor
        // But still clear pending_fecha_boda so user can proceed
        console.log(`⚠️  Fecha de boda no extraída inmediatamente, el profile extractor la procesará en el siguiente mensaje`);
      }
      
      Object.assign(session, sessionUpdates);
      
      // Show cita submenu since user has completed info collection
      const citaMenuHandler = require('./cita-menu');
      const citaMenuResult = await citaMenuHandler.execute(session, message);
      
      return {
        reply: citaMenuResult.reply,
        sessionUpdates: {
          ...sessionUpdates,
          ...citaMenuResult.sessionUpdates
        },
        buttons: citaMenuResult.buttons
      };
    } else {
      // User didn't provide date clearly, ask again
      const nombrePrimero = getClientName(session).split(' ')[0];
      return {
        reply: `¡Perfecto ${nombrePrimero}! ✨ Para ayudarte mejor, ¿me compartes la fecha completa de tu boda? Por favor incluye el día, mes y año (por ejemplo: "10 de julio 2026"). Si aún no la tienes definida, no hay problema, solo dímelo 💫`,
        sessionUpdates: {
          pending_fecha_boda: true
        }
      };
    }
    
    // Check if we have fecha_boda - ask for it if missing (optional but preferred)
    // Only ask if user hasn't declined to provide it
    if (!session.fecha_boda && !session.fecha_boda_declinada) {
      // First time asking for fecha_boda
      const nombrePrimero = getClientName(session).split(' ')[0];
      return {
        reply: `¡Perfecto ${nombrePrimero}! ✨ Para ayudarte mejor, ¿me compartes la fecha completa de tu boda? Por favor incluye el día, mes y año (por ejemplo: "10 de julio 2026"). Si aún no la tienes definida, no hay problema, solo dímelo 💫`,
        sessionUpdates: {
          pending_fecha_boda: true // Flag to indicate we're waiting for wedding date
        }
      };
    }
    } // End of if (session.pending_fecha_boda === true)
  } // End of if (!isCitaNuevaButton)

  // IMPORTANT: If pending_agendar_fecha is active, we MUST process the appointment date
  // Skip any submenu logic and go directly to date extraction and slot display
  // This ensures that when user provides appointment date, we show slots, not submenu
  
  // CRITICAL: If fecha_cita_solicitada is already set (from the block above when pending_agendar_fecha was active),
  // use it directly instead of re-extracting. This prevents the bot from asking for the date again.
  let fechaCitaDeseada = null;
  if (session.fecha_cita_solicitada && session.skipInfoCollection) {
    // Date was already extracted and processed in the block above, use it directly
    console.log(`📅 Usando fecha ya procesada de sesión: ${session.fecha_cita_solicitada}`);
    fechaCitaDeseada = session.fecha_cita_solicitada;
  } else {
    // Extract fecha_cita_deseada from message (only if not already processed above)
    // CRITICAL: Siempre intentar extraer fecha del mensaje primero
    // Solo usar fecha de sesión si no se encuentra una nueva fecha en el mensaje
    fechaCitaDeseada = await extractFechaCitaDeseada(message, session.fecha_boda);
    
    // Si no se encontró fecha en el mensaje, usar la de la sesión (para casos de rescheduling o continuación)
    if (!fechaCitaDeseada && session.fecha_cita_solicitada) {
      console.log(`📅 No se encontró fecha en el mensaje, usando fecha de sesión: ${session.fecha_cita_solicitada}`);
      fechaCitaDeseada = session.fecha_cita_solicitada;
    }
  }
  
  // Log para debugging
  if (fechaCitaDeseada) {
    console.log(`📅 Fecha extraída/procesada: ${fechaCitaDeseada}`);
  }
  
  // Clear pending_agendar_fecha flag if we got a date
  // IMPORTANT: Initialize sessionUpdates as empty object, but preserve any updates from the block above
  const sessionUpdates = {};
  if (fechaCitaDeseada && session.pending_agendar_fecha) {
    sessionUpdates.pending_agendar_fecha = false;
  }
  
  // If fecha_cita_solicitada was already set in the block above, preserve it
  if (session.fecha_cita_solicitada && session.skipInfoCollection) {
    sessionUpdates.fecha_cita_solicitada = session.fecha_cita_solicitada;
  }
  
  // Clear skipInfoCollection flag if it was set (we already processed the date)
  if (session.skipInfoCollection) {
    sessionUpdates.skipInfoCollection = false;
  }

  // If no date mentioned, ask for it
  if (!fechaCitaDeseada) {
    return {
      reply: `¡Con gusto! Nos encantará recibirte 💕\n\n¿Qué día te gustaría visitarnos? Puedes decirme, por ejemplo: "el martes 24 de febrero" o "el 4 de marzo".\n\nEstamos abiertos:\n• Martes a sábado: ${horarios.martes_sabado || 'N/A'}\n• Domingos: ${horarios.domingos || 'N/A'}\n• Lunes: ${horarios.lunes || 'Cerrado'}`,
      sessionUpdates: {
        pending_agendar_fecha: true // Flag to indicate we're waiting for appointment date
      }
    };
  }

  // Verify the date is not the wedding date (only if fecha_boda exists)
  if (session.fecha_boda && fechaCitaDeseada === session.fecha_boda) {
    return {
      reply: `Entiendo que mencionaste ${formatDate(fechaCitaDeseada)}, pero esa es la fecha de tu boda. ¿Qué día te gustaría visitarnos en el showroom? 💐`,
      sessionUpdates: {
        pending_agendar_fecha: true // Keep flag since we're still waiting for a valid date
      }
    };
  }
  
  // Clear pending_agendar_fecha flag since we got a valid date
  if (session.pending_agendar_fecha) {
    sessionUpdates.pending_agendar_fecha = false;
  }

  // If we have calendar dependencies, query Google Calendar
  if (calendarDeps && calendarDeps.calendarClient && calendarDeps.authClient) {
    try {
      console.log(`📅 Consultando disponibilidad para: ${fechaCitaDeseada}`);
      
      // If we're moving an appointment, exclude the old event from availability count
      const excludeEventId = session.calendar_event_id || null;
      
      // Obtener slots disponibles del calendario "Innovia CDMX" (eventos azules sin nombre)
      const slots = await getAvailableSlots(
        fechaCitaDeseada,
        calendarDeps.calendarClient,
        calendarDeps.authClient,
        calendarDeps.innoviaCDMXCalendarId || 'primary', // Calendario "Innovia CDMX" para spots disponibles
        excludeEventId // Exclude the event being moved from count
      );

      if (slots.length === 0) {
        // Check if day is closed
        if (!isDayOpen(fechaCitaDeseada)) {
          const [year, month, day] = fechaCitaDeseada.split('-').map(Number);
          const dateObj = new Date(year, month - 1, day);
          const dayOfWeek = dateObj.getDay();
          const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
          const dayName = dayNames[dayOfWeek];
          
          return {
            reply: `❌ Los ${dayName === 'lunes' ? 'lunes' : dayName} estamos cerrados. Por favor, elige otro día.\n\nEstamos abiertos:\n• Martes a sábado: ${horarios.martes_sabado || 'N/A'}\n• Domingos: ${horarios.domingos || 'N/A'}`,
            sessionUpdates: {
              ...sessionUpdates,
              pending_agendar_fecha: true // Keep flag since date was invalid
            }
          };
        }
        
        return {
          reply: `❌ No hay bloques disponibles para ${formatDate(fechaCitaDeseada)}. Por favor, elige otra fecha.`,
          sessionUpdates: {
            ...sessionUpdates,
            pending_agendar_fecha: true // Keep flag since no slots available
          }
        };
      }

      // Filter to only show slots with at least 1 available spot
      let availableSlots = slots.filter(slot => slot.availableSpots && slot.availableSpots > 0);
      
      // Eliminar duplicados adicionales (por si acaso)
      const seenEventIds = new Set();
      const seenTimestamps = new Set();
      availableSlots = availableSlots.filter(slot => {
        // Calcular timestamp de forma consistente
        const timestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
        
        // Eliminar si ya vimos este eventId
        if (slot.eventId && seenEventIds.has(slot.eventId)) {
          console.log(`   ⏭️  [agendar] Eliminando slot duplicado por eventId: ${slot.time} [${slot.eventId}]`);
          return false;
        }
        // Eliminar si ya vimos este timestamp exacto (mismo horario exacto)
        if (timestamp > 0 && seenTimestamps.has(timestamp)) {
          console.log(`   ⏭️  [agendar] Eliminando slot duplicado por timestamp: ${slot.time} [${slot.eventId}]`);
          return false;
        }
        if (slot.eventId) seenEventIds.add(slot.eventId);
        if (timestamp > 0) seenTimestamps.add(timestamp);
        return true;
      });
      
      // Asegurar orden cronológico: ordenar por timestamp de inicio (más temprano primero)
      // IMPORTANTE: Ordenar DESPUÉS de eliminar duplicados
      console.log(`   🔄 [agendar] Ordenando ${availableSlots.length} slots cronológicamente...`);
      
      // Log ANTES de ordenar
      console.log(`   📋 [agendar] Slots ANTES de ordenar:`);
      availableSlots.forEach((slot, idx) => {
        const timestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
        const time24h = slot.start ? new Date(slot.start).toLocaleTimeString('en-US', {timeZone: 'America/Mexico_City', hour12: false}) : 'N/A';
        console.log(`      ${idx + 1}. ${slot.time} (${time24h}) - timestamp: ${timestamp} - eventId: ${slot.eventId || 'N/A'}`);
      });
      
      // Usar una función de comparación robusta que maneje todos los casos
      availableSlots.sort((a, b) => {
        // CRITICAL: Usar startTimestamp directamente si está disponible (más confiable)
        // Solo usar fallback si startTimestamp no existe
        const timeA = a.startTimestamp !== undefined && a.startTimestamp !== null 
          ? a.startTimestamp 
          : (a.start ? new Date(a.start).getTime() : 0);
        const timeB = b.startTimestamp !== undefined && b.startTimestamp !== null 
          ? b.startTimestamp 
          : (b.start ? new Date(b.start).getTime() : 0);
        
        // Verificar que los timestamps son válidos
        if (isNaN(timeA) || isNaN(timeB)) {
          console.error(`   ❌ [agendar] ERROR: Timestamp inválido en ordenamiento - a: ${timeA}, b: ${timeB}`);
          console.error(`      Slot A: ${a.time} (${a.start}) - startTimestamp: ${a.startTimestamp}`);
          console.error(`      Slot B: ${b.time} (${b.start}) - startTimestamp: ${b.startTimestamp}`);
        }
        
        // Orden ascendente: más temprano primero (timeA - timeB)
        return timeA - timeB;
      });
      
      // Log DESPUÉS de ordenar
      console.log(`   📋 [agendar] Slots DESPUÉS de ordenar:`);
      availableSlots.forEach((slot, idx) => {
        const timestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
        const time24h = slot.start ? new Date(slot.start).toLocaleTimeString('en-US', {timeZone: 'America/Mexico_City', hour12: false}) : 'N/A';
        console.log(`      ${idx + 1}. ${slot.time} (${time24h}) - timestamp: ${timestamp} - eventId: ${slot.eventId || 'N/A'}`);
      });
      
      // Verificar que el ordenamiento funcionó correctamente
      const isOrdered = availableSlots.every((slot, index) => {
        if (index === 0) return true;
        const prevTimestamp = availableSlots[index - 1].startTimestamp || 
                             (availableSlots[index - 1].start ? new Date(availableSlots[index - 1].start).getTime() : 0);
        const currTimestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
        return currTimestamp >= prevTimestamp;
      });
      
      if (!isOrdered) {
        console.error(`   ❌ ERROR: Los slots NO están ordenados cronológicamente después del sort!`);
        console.error(`   Slots: ${availableSlots.map(s => `${s.time} (ts:${s.startTimestamp || new Date(s.start).getTime()})`).join(', ')}`);
      }
      
      console.log(`   📅 Slots finales (después de filtrar, eliminar duplicados y ordenar): ${availableSlots.length}`);
      console.log(`   📅 Orden cronológico verificado: ${availableSlots.map(s => `${s.time} (ts:${s.startTimestamp || new Date(s.start).getTime()})`).join(' → ')}`);
      console.log(`   ✅ Ordenamiento correcto: ${isOrdered ? 'SÍ' : 'NO'}`);

      if (availableSlots.length === 0) {
        return {
          reply: `❌ No hay horarios disponibles para ${formatDate(fechaCitaDeseada)}. Por favor, elige otra fecha.`,
          sessionUpdates: {
            ...sessionUpdates,
            pending_agendar_fecha: true // Keep flag since no slots available
          }
        };
      }

      // VERIFICACIÓN FINAL: Asegurar orden cronológico justo antes de mostrar
      // Esto garantiza que los slots se muestren siempre en orden (más temprano primero)
      availableSlots.sort((a, b) => {
        const timeA = a.startTimestamp || (a.start ? new Date(a.start).getTime() : 0);
        const timeB = b.startTimestamp || (b.start ? new Date(b.start).getTime() : 0);
        return timeA - timeB; // Orden ascendente: más temprano primero
      });
      
      console.log(`   ✅ ORDENAMIENTO FINAL: ${availableSlots.map(s => s.time).join(' → ')}`);
      
      // Show all available slots as numbered list
      let replyText = `Horarios disponibles para ${formatDate(fechaCitaDeseada)}:\n\n`;
      
      // Create numbered list with all available slots (ya están ordenados cronológicamente)
      availableSlots.forEach((slot, index) => {
        replyText += `${index + 1}. ${slot.time}\n`;
      });
      
      replyText += `\nEscribe el número del horario que prefieras para agendar tu cita.`;

      // Save all available slots for selection
      sessionUpdates.slots_disponibles = availableSlots;
      sessionUpdates.fecha_cita_solicitada = fechaCitaDeseada;
      sessionUpdates.pending_agendar_fecha = false; // Clear flag since we processed the date
      sessionUpdates.periodo_seleccionado = null; // Clear any period selection
      sessionUpdates.slots_medio_dia = null; // Clear period flags
      sessionUpdates.slots_tarde = null;

      return {
        reply: replyText,
        sessionUpdates
      };
    } catch (error) {
      console.error('❌ Error consultando Google Calendar:', error);
      // Fallback: ask user to try again
      return {
        reply: `Disculpa, hubo un error consultando la disponibilidad. ¿Puedes intentar de nuevo o decirme otra fecha? 💫`,
        sessionUpdates: {}
      };
    }
  } else {
    // No calendar dependencies available - NO usar fallback a slots por defecto
    console.error('❌ ERROR: Calendar dependencies not provided');
    console.error('   ⚠️  El bot SOLO usa eventos azules del calendario "Innovia CDMX"');
    console.error('   ⚠️  NO se usarán slots por defecto');
    
    return {
      reply: `Disculpa, no puedo consultar la disponibilidad en este momento. Por favor, intenta más tarde o contacta directamente con nosotros. 💫`,
      sessionUpdates: {
        ...sessionUpdates,
        pending_agendar_fecha: true // Keep flag since we couldn't check availability
      }
    };
  }
}

module.exports = { execute, extractFechaCitaDeseada };

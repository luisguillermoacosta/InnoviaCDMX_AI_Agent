/**
 * Escalacion Handler
 * 
 * Fallback handler for intents that don't fit other categories.
 * Uses LLM to understand user intent and guide them to available options.
 */

const OpenAI = require('openai');
const {
  getBusinessName,
  getAdvisorName,
  getBusinessAddress,
  getCatalogLink
} = require('../../config');
const { getClientName, getClientFirstName } = require('../utils/name-utils');

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
 * Execute escalacion intent handler
 * Uses LLM to guide user
 * @param {Object} session - Session object
 * @param {string} message - User's message
 * @returns {Promise<Object>} { reply: string, sessionUpdates: object }
 */
async function execute(session, message) {
  const nombre = getBusinessName();
  const direccion = getBusinessAddress();
  const catalogoLink = getCatalogLink();
  const nombrePrimero = getClientFirstName(session);

  // Count consecutive OTRO intents
  // Check last messages to see if previous ones were also OTRO
  let consecutiveOtroCount = 1; // Current message is OTRO
  const lastMessages = session.historial.slice(-5); // Check last 5 messages
  
  for (let i = lastMessages.length - 2; i >= 0; i--) {
    // Check if previous assistant message indicates OTRO was handled
    if (lastMessages[i].role === 'assistant') {
      // If assistant's last message was a generic guidance message, likely OTRO
      const lastReply = lastMessages[i].content.toLowerCase();
      if (lastReply.includes('no estoy seguro') || 
          lastReply.includes('puedo ayudarte con') ||
          lastReply.includes('no entiendo exactamente')) {
        consecutiveOtroCount++;
      } else {
        // If assistant gave a specific response, reset count
        break;
      }
    }
  }

  // Use session counter if available (more reliable)
  const sessionOtroCount = session.consecutive_otro_count || 0;
  const newOtroCount = sessionOtroCount + 1;

  // Build context about available options
  const availableOptions = [];
  availableOptions.push('• Agendar o editar una cita');
  availableOptions.push('• Ver información sobre catálogo, precios o ubicación');
  availableOptions.push('• Hablar con un asesor');

  const hasAppointment = session.etapa === 'cita_agendada' || session.calendar_event_id;
  if (hasAppointment) {
    availableOptions.unshift('• Reagendar o cancelar tu cita existente');
  }

  const optionsText = availableOptions.join('\n');

  // Build context about the session
  const sessionContext = [];
  const nombreCliente = getClientName(session);
  if (nombreCliente) {
    sessionContext.push(`Nombre del cliente: ${nombreCliente}`);
  }
  if (session.fecha_boda) {
    sessionContext.push(`Fecha de boda: ${session.fecha_boda}`);
  }
  if (hasAppointment) {
    sessionContext.push('El usuario tiene una cita agendada');
  }
  if (session.slots_disponibles && session.slots_disponibles.length > 0) {
    sessionContext.push('El bot está esperando que el usuario seleccione un horario');
  }

  const contextString = sessionContext.length > 0 
    ? `\n\nCONTEXTO:\n${sessionContext.join('\n')}`
    : '';

  // Get recent conversation history for context (more messages for better understanding)
  const totalMessages = session.historial?.length || 0;
  const recentMessages = session.historial?.slice(-10) || []; // Last 10 messages for escalation handler
  
  let historyContext = '';
  
  if (recentMessages.length > 0) {
    const recentHistory = recentMessages.map(msg => 
      `${msg.role === 'user' ? 'Usuario' : 'Bot'}: ${msg.content}`
    ).join('\n');
    
    historyContext = `\n\nÚLTIMOS MENSAJES (${recentMessages.length} de ${totalMessages} total):\n${recentHistory}`;
    
    // If conversation is very long, add summary
    if (totalMessages > 15) {
      const earlierMessages = session.historial.slice(0, -10);
      const earlierSummary = earlierMessages
        .filter(msg => msg.role === 'user')
        .slice(0, 5)
        .map(msg => msg.content.substring(0, 40))
        .join('; ');
      
      if (earlierSummary) {
        historyContext += `\n\n(Nota: Hay ${totalMessages - 10} mensajes anteriores. Contexto previo: ${earlierSummary}...)`;
      }
    }
  }

  // Build prompt for LLM to understand intent
  const systemPrompt = `Eres un asistente amigable de una boutique de vestidos de novia llamada ${nombre}.

Tu tarea es entender la intención del usuario y responder de manera natural y útil.

OPCIONES DISPONIBLES EN EL BOT:
${optionsText}

INSTRUCCIONES:
- Analiza el mensaje del usuario y trata de entender qué quiere hacer
- Si puedes identificar la intención, responde de manera natural y guía al usuario hacia la opción correcta
- Si el mensaje es ambiguo o no está claro, haz una pregunta amigable para clarificar
- Mantén un tono amigable, cálido y profesional
- Usa emojis apropiados (👰‍♀️, 💫, ✨)
- Si el usuario pregunta algo específico sobre la boutique, responde brevemente si sabes la respuesta, o guía hacia las opciones
- SIEMPRE al final de tu respuesta, menciona que si prefiere, puede hablar con un asesor para mejor ayuda

IMPORTANTE:
- Responde en lenguaje natural, como si fueras una persona real
- NO inventes información que no tienes
- NO hagas promesas sobre disponibilidad de vestidos o precios específicos
- NO digas que hacemos vestidos en otros colores ni que se puede cambiar el color o diseño: solo manejamos los modelos y colores de nuestra colección (catálogo)
- Mantén la respuesta concisa (máximo 3-4 líneas)
- SIEMPRE termina sugiriendo hablar con un asesor si necesita más ayuda`;

  try {
    if (!process.env.OPENAI_API_KEY) {
      // Fallback if no API key
      return getFallbackResponse(nombrePrimero, hasAppointment, newOtroCount >= 2, sessionOtroCount);
    }

    const userPrompt = `Usuario dice: "${message}"${contextString}${historyContext}

IMPORTANTE: Responde de manera natural reconociendo la solicitud del usuario. NO preguntes si quiere hablar con un asesor. En cambio, indícale que hemos tomado nota de su solicitud y que en breve uno de nuestros agentes del staff se pondrá en contacto con él/ella para atenderlo personalmente.`;

    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 200,
      temperature: 0.7
    });

    let reply = response.choices[0].message.content.trim();
    
    // Ensure reply is personalized with name if available
    if (nombrePrimero && !reply.includes(nombrePrimero)) {
      reply = `${nombrePrimero}, ${reply.charAt(0).toLowerCase() + reply.slice(1)}`;
    }

    // Always offer to speak with advisor for OTRO intent
    const sessionUpdates = {
      consecutive_otro_count: newOtroCount
    };

    reply += `\n\n📋 Hemos tomado nota de tu solicitud. En breve uno de nuestros agentes del staff se pondrá en contacto contigo para atenderte personalmente. 💕`;

    console.log(`🤖 LLM escalando a humano (intento ${newOtroCount}): ${message.substring(0, 50)}...`);

    return {
      reply,
      sessionUpdates
    };
  } catch (error) {
    console.error('❌ Error usando LLM para guiar usuario:', error.message);
    // Fallback to default response
    return getFallbackResponse(nombrePrimero, hasAppointment, newOtroCount >= 2, sessionOtroCount);
  }
}

/**
 * Fallback response when LLM is not available
 */
function getFallbackResponse(nombrePrimero, hasAppointment, offerAdvisor = false, currentCount = 0) {
  const greeting = nombrePrimero ? `¡Hola ${nombrePrimero}! ✨` : `¡Hola! ✨`;
  let reply = `${greeting}\n\n`;

  reply += `Hemos tomado nota de tu solicitud. En breve uno de nuestros agentes del staff se pondrá en contacto contigo para atenderte personalmente. 💕\n\n`;
  reply += `Mientras tanto, si necesitas algo más puedo ayudarte con:\n`;

  if (hasAppointment) {
    reply += `• Reagendar o cancelar tu cita existente\n`;
  }
  reply += `• Agendar una cita\n`;
  reply += `• Ver catálogo, precios o ubicación`;

  return {
    reply,
    sessionUpdates: { consecutive_otro_count: currentCount + 1 }
  };
}

module.exports = { execute };

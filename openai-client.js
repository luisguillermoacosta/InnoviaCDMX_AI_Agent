/**
 * OpenAI Client Module
 * 
 * Handles OpenAI API calls for chat completions using GPT-4o.
 * Integrates with sessions module for conversation context.
 */

const OpenAI = require('openai');
const {
  getBusinessName,
  getBusinessType,
  getAdvisorName,
  getBusinessAddress,
  getBusinessHours,
  getCatalogLink,
  getCatalogName,
  getBasePrice,
  getPricingInfo,
  getConversationFlow
} = require('./config');

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
 * Build system prompt from business configuration
 * @returns {string} System prompt for the AI assistant
 */
function buildSystemPrompt() {
  const businessInfo = {
    nombre: getBusinessName(),
    tipo: getBusinessType(),
    asesora_nombre: getAdvisorName(),
    direccion: getBusinessAddress(),
    horarios: getBusinessHours(),
    catalogo_link: getCatalogLink(),
    catalogo_nombre: getCatalogName(),
    precio_base: getBasePrice(),
    moneda: getPricingInfo().moneda || 'MXN'
  };
  
  const flow = getConversationFlow();
  
  return `Eres ${businessInfo.asesora_nombre}, la asesora virtual de ${businessInfo.nombre}, ${businessInfo.tipo} ubicada en ${businessInfo.direccion}.

Tu personalidad:
- Cálida, emocionante y personal — como una amiga experta en bodas.
- Usas emojis con moderación: 👰‍♀️ ✨ 💫 💐 🤍 (no más de 2-3 por mensaje).
- Siempre tratas a la novia por su nombre una vez que lo conoces.
- Hablas en español mexicano natural, sin sonar robótico ni corporativo.

Tu objetivo principal:
Convertir cada conversación en una CITA AGENDADA en el showroom.
Cada respuesta debe terminar —directa o sutilmente— con una invitación a agendar.

---

INFORMACIÓN DEL NEGOCIO:
- Nombre: ${businessInfo.nombre}
- Dirección: ${businessInfo.direccion}
- Horarios: Martes a sábado ${businessInfo.horarios.martes_sabado || 'N/A'}, domingos ${businessInfo.horarios.domingos || 'N/A'}
- Catálogo: ${businessInfo.catalogo_link}
- Precio base: $${businessInfo.precio_base} ${businessInfo.moneda}

---

REGLAS DE RESPUESTA:

1. INFO GENERAL o primer contacto (IMPORTANTE):
   - SIEMPRE al iniciar una conversación, debes pedir DOS cosas en este orden:
     a) NOMBRE COMPLETO de la novia (nombre y apellido)
     b) FECHA DE BODA (la fecha del evento de boda, NO la fecha de la cita)
   - Saluda con emoción, menciona la dirección y el catálogo.
   - NO continúes con otra información hasta tener nombre completo y fecha de boda.
   - Ejemplo: "¡Hola! 👰‍♀️ Qué emoción tenerte por aquí. Para ayudarte mejor, necesito tu nombre completo y la fecha de tu boda. ¿Me los compartes?"

2. PRECIOS:
   - Menciona solo el precio base ($${businessInfo.precio_base} ${businessInfo.moneda}).
   - Explica que varía por modelo, fecha, forma de pago y promociones.
   - NUNCA prometas descuentos específicos — eso es decisión de la asesora en showroom.
   - Redirige siempre a agendar cita para "sorpresas especiales".

3. CATÁLOGO:
   - Comparte el link inmediatamente.
   - Añade que en persona la experiencia es completamente diferente.
   - Invita a agendar para probarse los favoritos.

4. UBICACIÓN:
   - Da la dirección y el horario.
   - Pregunta nombre, fecha de boda y día/hora preferida.

5. AGENDAR CITA (MUY IMPORTANTE - DISTINGUIR FECHAS):
   - FECHA DE BODA: Es la fecha del evento de boda (ej: "10 de julio de 2026"). Se pide al inicio de la conversación.
   - FECHA DE CITA: Es la fecha para visitar el showroom (ej: "24 de febrero de 2026"). Se pregunta cuando quieren agendar.
   - NUNCA confundas estas dos fechas. Son cosas completamente diferentes.
   - Cuando el usuario menciona una fecha específica para agendar (ej: "tienen libre el martes 24 de febrero"), el sistema automáticamente consultará Google Calendar y mostrará horarios disponibles.
   - NO digas que no puedes bloquear la agenda - el sistema SÍ puede crear citas en Google Calendar.
   - Si el usuario menciona una fecha para agendar, confirma que consultarás disponibilidad para ESA fecha (la fecha de cita, no la de boda).
   - Después de que el sistema muestre horarios, el usuario elegirá un número (1, 2, 3, etc.) o hará clic en un botón y el sistema creará la cita automáticamente.
   - Una vez agendada, confirma con entusiasmo y proporciona el enlace de Google Calendar.

6. CUANDO YA TIENES NOMBRE COMPLETO Y FECHA DE BODA:
   - Úsalos en cada mensaje siguiente.
   - Personaliza la experiencia: "¡Qué emoción {nombre}, ya casi es tu día!"
   - Recuerda: la fecha de boda es diferente de la fecha de cita en el showroom.

7. LEAD DE GOOGLE/EMAIL:
   - Saludo personalizado con su nombre.
   - Comparte catálogo.
   - Pregunta directamente qué día/hora le gustaría visitarnos.

8. CONFIRMACIONES:
   - Enviar 1 día antes de la cita.
   - Incluir hora y dirección.
   - Pedir que confirmen asistencia o avisen si necesitan reagendar.
   - Compartir catálogo y pedir sus 5 favoritos para preparar la cita.

9. NOVIA TARDE:
   - Tono tranquilizador, sin presión.
   - Preguntar si viene en camino o prefiere reagendar.

10. EXPO / EVENTOS ESPECIALES:
    - Mencionar descuentos específicos del evento si aplica.
    - Misma estructura que confirmación regular.

---

REGLAS ABSOLUTAS (nunca violar):
❌ No dar precios exactos por modelo
❌ No confirmar fechas específicas sin verificar con el equipo humano
❌ No prometer descuentos sin autorización
❌ No compartir datos bancarios hasta que la cita esté confirmada y sea necesario para apartar
❌ No inventar información sobre inventario o disponibilidad de modelos
❌ No ser genérico — siempre usar el nombre de la novia cuando lo tienes

---

CUANDO NO SABES LA RESPUESTA:
Di: "Déjame verificar eso con el equipo y te escribo enseguida 💫" 
No inventes. Escala al humano.

---

FORMATO DE RESPUESTAS:
- Mensajes cortos (máximo 4-5 líneas por bloque de texto).
- WhatsApp no soporta markdown complejo — usa *negritas* y saltos de línea.
- Nunca envíes listas largas o párrafos densos.
- Cada mensaje debe tener una pregunta o call-to-action claro al final.
- NUNCA formatees links como [texto](url) — WhatsApp no lo interpreta y se ve como texto roto con el link duplicado. Comparte siempre la URL sola, en texto plano (ej: ${businessInfo.catalogo_link}).`;
}

/**
 * Get AI response using OpenAI API
 * @param {Object} session - Session object from sessions module
 * @param {string} userMessage - User's message
 * @returns {Promise<string>} AI response
 */
async function getAIResponse(session, userMessage) {
  try {
    const client = getOpenAIClient();

    // Build messages array
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      // Include last 10 messages from history
      ...session.historial.slice(-10).map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      // Add current user message
      { role: 'user', content: userMessage }
    ];

    console.log(`🤖 Llamando a OpenAI con ${messages.length} mensajes en contexto`);

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 500,
      temperature: 0.7
    });

    // WhatsApp no renderiza links en formato markdown [texto](url) — se ven como
    // texto roto con el link duplicado. Por si el modelo lo genera pese a la
    // instrucción del prompt, lo convertimos a URL plana.
    const reply = response.choices[0].message.content.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2');

    console.log(`✅ Respuesta de OpenAI recibida (${reply.length} caracteres)`);

    return reply;
  } catch (error) {
    console.error('❌ Error llamando a OpenAI:', error.message);
    
    // Fallback response if OpenAI fails
    if (error.message.includes('API key')) {
      throw new Error('OPENAI_API_KEY no válido. Verifica tu configuración.');
    }
    
    throw error;
  }
}

/**
 * Extract structured data from conversation
 * @param {Object} session - Session object with historial
 * @returns {Promise<Object>} Extracted data {nombre_novia, fecha_boda, fecha_cita}
 */
async function extractConversationData(session) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️  OPENAI_API_KEY no configurado, no se puede extraer datos');
      return { nombre_novia: null, fecha_boda: null, fecha_cita: null };
    }

    // Build messages for extraction (include full conversation context)
    const messages = [
      {
        role: 'system',
        content: 'Given this conversation, extract in JSON: {nombre_novia, fecha_boda, fecha_cita}. fecha_boda is the wedding date. fecha_cita is the appointment/visit date they want to schedule. Return null for fields not yet mentioned. Return ONLY valid JSON, no explanation.'
      },
      // Include all messages from history
      ...session.historial.map(msg => ({
        role: msg.role,
        content: msg.content
      }))
    ];

    console.log(`🔍 Extrayendo datos de conversación (${session.historial.length} mensajes)`);

    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 100,
      temperature: 0.1 // Lower temperature for more consistent extraction
    });

    const extractedText = response.choices[0].message.content.trim();
    
    // Try to parse JSON (might be wrapped in code blocks)
    let extractedData;
    try {
      // Remove markdown code blocks if present
      const jsonText = extractedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(jsonText);
    } catch (parseError) {
      console.warn('⚠️  Error parseando JSON extraído, intentando extraer manualmente:', extractedText);
      // Fallback: try to extract JSON from the text
      const jsonMatch = extractedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No se pudo extraer JSON válido');
      }
    }

    // Validate and normalize extracted data
    const result = {
      nombre_novia: extractedData.nombre_novia || null,
      fecha_boda: extractedData.fecha_boda || null,
      fecha_cita: extractedData.fecha_cita || null
    };

    // Clean up nombre_novia (remove extra whitespace, capitalize properly)
    if (result.nombre_novia) {
      result.nombre_novia = result.nombre_novia.trim();
      // Capitalize first letter of each word
      result.nombre_novia = result.nombre_novia
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }

    // Validate fecha_boda format (should be YYYY-MM-DD or similar)
    if (result.fecha_boda) {
      result.fecha_boda = result.fecha_boda.trim();
    }
    
    // Validate fecha_cita format
    if (result.fecha_cita) {
      result.fecha_cita = result.fecha_cita.trim();
      // Normalize fecha_cita to YYYY-MM-DD format if possible
      try {
        const dateObj = new Date(result.fecha_cita);
        if (!isNaN(dateObj.getTime())) {
          const year = dateObj.getFullYear();
          const month = String(dateObj.getMonth() + 1).padStart(2, '0');
          const day = String(dateObj.getDate()).padStart(2, '0');
          result.fecha_cita = `${year}-${month}-${day}`;
        }
      } catch (e) {
        // Keep original format if parsing fails
      }
    }

    console.log(`✅ Datos extraídos:`, result);
    
    return result;
  } catch (error) {
    console.error('❌ Error extrayendo datos de conversación:', error.message);
    // Return null values on error
    return { nombre_novia: null, fecha_boda: null };
  }
}

module.exports = {
  buildSystemPrompt,
  getAIResponse,
  extractConversationData
};

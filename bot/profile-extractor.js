/**
 * Profile Extractor
 * 
 * Silently extracts nombre_cliente and fecha_boda from conversation history.
 * Runs on every message, independent of intent routing.
 * Updates session silently if new info is found.
 */

const OpenAI = require('openai');

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
 * Extract client profile (nombre_cliente and fecha_boda) from conversation
 * @param {Array} conversationHistory - Array of {role, content} messages
 * @returns {Promise<Object>} {nombre_cliente: string|null, fecha_boda: string|null}
 */
async function extractBrideProfile(conversationHistory) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️  OPENAI_API_KEY no configurado, no se puede extraer perfil');
      return { nombre_novia: null, fecha_boda: null };
    }

    if (!conversationHistory || conversationHistory.length === 0) {
      return { nombre_novia: null, fecha_boda: null };
    }

    const currentYear = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })).getFullYear();
    const currentDate = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

    const systemPrompt = `Eres un extractor de información específica de conversaciones.

FECHA ACTUAL: ${currentDate} (año actual: ${currentYear})

Tu tarea es extraer SOLO dos campos del perfil del cliente:
1. nombre_cliente: El nombre completo (nombre y apellido) del cliente
2. fecha_boda: La fecha del evento de boda (cuándo será la boda)

IMPORTANTE:
- NO extraigas fechas de citas, solo la fecha de la boda
- NO extraigas información sobre horarios de visita o disponibilidad
- NO extraigas información sobre precios o modelos
- Si el nombre o fecha no están mencionados, devuelve null para ese campo
- La fecha_boda debe ser la fecha del evento de boda, NO la fecha para visitar el showroom
- Si encuentras una fecha en español (ej: "10 julio ${currentYear}", "24 de febrero ${currentYear}"), conviértela a formato YYYY-MM-DD (ej: "${currentYear}-07-10", "${currentYear}-02-24")
- Si la fecha mencionada es para visitar el showroom o agendar una cita, NO la extraigas como fecha_boda
- "este año", "en este año" significa el año ${currentYear} (el año actual indicado arriba)
- Si no se especifica el año, asume ${currentYear}

Responde SOLO con un objeto JSON válido en este formato:
{
  "nombre_cliente": "Nombre Completo" o null,
  "fecha_boda": "YYYY-MM-DD" o null
}

No agregues explicaciones, solo el JSON.`;

    // Se manda la conversación como transcripción (Bot / Clienta) para que el
    // extractor vea la pregunta del bot. Sin eso, una respuesta suelta como
    // "el 20 de marzo" a "¿para cuándo es tu boda?" es ambigua y se descarta.
    const transcript = conversationHistory
      .slice(-30)
      .map(msg => `${msg.role === 'user' ? 'Clienta' : 'Bot'}: ${msg.content}`)
      .join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Conversación (extrae SOLO datos que la Clienta dio sobre sí misma; usa los mensajes del Bot solo como contexto para entender a qué responde):\n\n${transcript}`
      }
    ];

    console.log(`🔍 Extrayendo perfil de cliente (${conversationHistory.length} mensajes)`);

    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 100,
      temperature: 0.1 // Low temperature for consistent extraction
    });

    const extractedText = response.choices[0].message.content.trim();

    // Parse JSON (might be wrapped in code blocks)
    let extractedData;
    try {
      // Remove markdown code blocks if present
      const jsonText = extractedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(jsonText);
    } catch (parseError) {
      console.warn('⚠️  Error parseando JSON del perfil, intentando extraer manualmente:', extractedText);
      // Fallback: try to extract JSON from the text
      const jsonMatch = extractedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No se pudo extraer JSON válido');
      }
    }

    // Validate and normalize
    const result = {
      nombre_cliente: extractedData.nombre_cliente || extractedData.nombre_novia || null, // Support both for backward compatibility
      fecha_boda: extractedData.fecha_boda || null
    };

    // Clean up nombre_cliente (remove extra whitespace, capitalize properly)
    if (result.nombre_cliente) {
      result.nombre_cliente = result.nombre_cliente.trim();
      // Capitalize first letter of each word
      result.nombre_cliente = result.nombre_cliente
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }

    // Validate fecha_boda format (should be YYYY-MM-DD or normalize it)
    if (result.fecha_boda) {
      result.fecha_boda = result.fecha_boda.trim();
      
      try {
        let year, month, day;
        
        // If it contains month names in Spanish, parse it manually
        const spanishMonths = {
          'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
          'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
        };
        
        // Check if it's in Spanish format like "10 julio 2026" or "10 de julio 2026"
        const spanishDateMatch = result.fecha_boda.match(/(\d{1,2})\s*(?:de\s*)?(\w+)\s*(\d{4})/i);
        if (spanishDateMatch) {
          day = parseInt(spanishDateMatch[1]);
          const monthName = spanishDateMatch[2].toLowerCase();
          year = parseInt(spanishDateMatch[3]);
          
          if (spanishMonths[monthName]) {
            month = spanishMonths[monthName];
          } else {
            throw new Error(`Mes en español no reconocido: ${monthName}`);
          }
        } 
        // Check if already in YYYY-MM-DD format
        else if (result.fecha_boda.match(/^\d{4}-\d{2}-\d{2}$/)) {
          // Parse directly from YYYY-MM-DD format
          [year, month, day] = result.fecha_boda.split('-').map(Number);
        }
        // Try to parse other formats (DD/MM/YYYY, MM/DD/YYYY, etc.)
        else {
          // Try standard Date parsing first to extract components
          const parsedDate = new Date(result.fecha_boda);
          if (!isNaN(parsedDate.getTime())) {
            // Extract components using UTC methods to avoid timezone issues
            // But then reconstruct using local constructor
            year = parsedDate.getUTCFullYear();
            month = parsedDate.getUTCMonth() + 1;
            day = parsedDate.getUTCDate();
          } else {
            throw new Error(`No se pudo parsear la fecha: ${result.fecha_boda}`);
          }
        }
        
        // Validate the extracted components
        if (year && month && day) {
          // Use local date constructor to avoid timezone issues
          const localDate = new Date(year, month - 1, day);
          
          // Verify the date is valid and matches what we expect
          if (localDate.getFullYear() === year && 
              localDate.getMonth() === month - 1 && 
              localDate.getDate() === day) {
            // Format as YYYY-MM-DD
            const normalizedYear = String(year).padStart(4, '0');
            const normalizedMonth = String(month).padStart(2, '0');
            const normalizedDay = String(day).padStart(2, '0');
            result.fecha_boda = `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
          } else {
            console.warn(`⚠️  Fecha inválida después de normalización: año=${year}, mes=${month}, día=${day}`);
          }
        }
      } catch (e) {
        console.warn('⚠️  Error normalizando fecha_boda, manteniendo formato original:', e.message);
        // Keep original format if parsing fails
      }
    }

    // Only log if we found something new
    if (result.nombre_cliente || result.fecha_boda) {
      console.log(`✅ Perfil extraído:`, result);
    }

    return result;
  } catch (error) {
    console.error('❌ Error extrayendo perfil de cliente:', error.message);
    // Return null values on error (silent failure)
    return { nombre_cliente: null, fecha_boda: null };
  }
}

module.exports = {
  extractBrideProfile
};

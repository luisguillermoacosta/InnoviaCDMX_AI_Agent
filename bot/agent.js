/**
 * Conversational Agent
 *
 * Replaces the intent classification + handler pipeline with a single
 * LLM agent that:
 *  1. Receives the full conversation context.
 *  2. Decides whether to call a Google Calendar tool or answer directly.
 *  3. Generates every response in natural language.
 */

const OpenAI = require('openai');
const {
  getBusinessInfo,
  getBusinessHours,
  getCatalogInfo,
  getPricingInfo,
  getFAQs
} = require('../config');
const {
  getAvailableSlots,
  isSlotAvailable,
  createCalendarEvent: createCalendarEventService,
  deleteCalendarEvent: deleteCalendarEventService,
  updateCalendarEvent: updateCalendarEventService,
  restoreBlueEvent: restoreBlueEventService,
  getCalendarEvent: getCalendarEventService,
  findEventByPhone: findEventByPhoneService
} = require('./calendar-service');
const { getClientName } = require('./utils/name-utils');
const { logPendingTask } = require('./sheets-service');

// ---------------------------------------------------------------------------
// OpenAI client (lazy)
// ---------------------------------------------------------------------------
let openai = null;
function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurado en las variables de entorno');
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_slots_disponibles',
      description:
        'Consulta los horarios disponibles en Google Calendar para una fecha específica. ' +
        'Úsala cuando la clienta quiera saber qué horarios hay disponibles para su cita.',
      parameters: {
        type: 'object',
        properties: {
          fecha: {
            type: 'string',
            description: 'Fecha en formato YYYY-MM-DD'
          }
        },
        required: ['fecha']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_cita',
      description:
        'Crea una cita confirmada en Google Calendar. ' +
        'Úsala SOLO cuando la clienta haya elegido un horario específico y confirmado que quiere agendarse.',
      parameters: {
        type: 'object',
        properties: {
          hora_inicio: {
            type: 'string',
            description:
              'Fecha y hora de inicio de la cita en formato ISO 8601 con zona horaria de México, ' +
              'p. ej. 2026-03-15T11:00:00-06:00'
          },
          nombre_cliente: {
            type: 'string',
            description: 'Nombre completo de la clienta'
          },
          telefono: {
            type: 'string',
            description: 'Número de teléfono de la clienta'
          },
          fecha_boda: {
            type: 'string',
            description: 'Fecha de boda de la clienta en formato YYYY-MM-DD. OBLIGATORIO: debes preguntar y obtener este dato antes de llamar a esta función.'
          }
        },
        required: ['hora_inicio', 'nombre_cliente', 'telefono', 'fecha_boda']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_cita',
      description: 'Cancela una cita existente en Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'ID del evento de Google Calendar a cancelar'
          }
        },
        required: ['event_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'escalar_a_humano',
      description:
        'Registra una solicitud que no puedes resolver directamente para que un agente humano del staff dé seguimiento. ' +
        'Úsala cuando la clienta pida algo fuera de tu alcance: hablar con una persona, consultar precios específicos por modelo, ' +
        'temas de pago ya realizados, quejas, o cualquier solicitud especial que requiera atención personalizada.',
      parameters: {
        type: 'object',
        properties: {
          descripcion_solicitud: {
            type: 'string',
            description: 'Descripción breve de lo que la clienta necesita o preguntó'
          }
        },
        required: ['descripcion_solicitud']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buscar_cita_cliente',
      description:
        'Busca en Google Calendar si la clienta tiene una cita agendada, incluso si fue creada manualmente por el staff. ' +
        'Úsala cuando la clienta pregunte por su cita y no haya un ID de cita registrado en el contexto, ' +
        'o cuando quieras confirmar si existe una cita antes de reagendar o cancelar.',
      parameters: {
        type: 'object',
        properties: {
          nombre_buscado: {
            type: 'string',
            description: 'Nombre (y apellido si lo tienes) de la clienta a buscar en el calendario. Úsalo cuando la búsqueda por teléfono no encontró resultados y la clienta te proporcionó el nombre bajo el que está registrada su cita.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reagendar_cita',
      description:
        'Mueve una cita existente a una nueva fecha y hora en Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'ID del evento de Google Calendar a reagendar'
          },
          nueva_hora_inicio: {
            type: 'string',
            description: 'Nueva fecha y hora de inicio en formato ISO 8601 con zona horaria de México'
          }
        },
        required: ['event_id', 'nueva_hora_inicio']
      }
    }
  }
];

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------
function buildSystemPrompt(session, phone) {
  const biz = getBusinessInfo();
  const hours = getBusinessHours();
  const catalog = getCatalogInfo();
  const pricing = getPricingInfo();
  const faqs = getFAQs();
  const clientName = getClientName(session);

  const today = new Date().toLocaleDateString('es-MX', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Mexico_City'
  });

  const slotsInfo =
    session.slots_disponibles && session.slots_disponibles.length > 0
      ? `- **Horarios mostrados recientemente:** ${session.slots_disponibles
          .map((s, i) => `${i + 1}. ${s.time} (inicio ISO: ${s.start})`)
          .join(', ')}`
      : '';

  return `Eres ${biz.asesora_nombre || 'la asesora'} de ${biz.nombre}, una boutique de vestidos de novia ubicada en CDMX. Atiendes a clientas por WhatsApp de forma cálida, personal y completamente conversacional.

## Información del negocio
- **Nombre:** ${biz.nombre}
- **Dirección:** ${biz.direccion}
- **Horarios:** Martes a sábado ${hours.martes_sabado || '11am – 8pm'}, domingos ${hours.domingos || '11am – 6pm'}, lunes cerrado
- **Catálogo:** ${catalog.nombre || 'Colección 2026'} → ${catalog.link || ''}
- **Precio base:** $${(pricing.precio_base || 25000).toLocaleString()} MXN
- **Nota precios:** ${pricing.nota || 'Los precios varían según modelo y personalizaciones'}

## Contexto de la clienta
- **Teléfono:** ${phone}
- **Nombre:** ${clientName || 'No proporcionado aún'}
- **Fecha de boda:** ${session.fecha_boda || 'No proporcionada aún'}
- **Cita agendada (ID en calendario):** ${session.calendar_event_id || 'Ninguna'}
${slotsInfo}

## Fecha de hoy
Hoy es ${today}.

## Instrucciones de comportamiento
1. **Genera siempre la respuesta en lenguaje natural.** Nunca copies mensajes predefinidos o rígidos.
2. **Primera interacción:** Si el historial de conversación está vacío o este es el primer mensaje, preséntate siempre como el Agente de IA de ${biz.nombre}. Ejemplo: "¡Hola! 👋 Soy el Agente de IA de ${biz.nombre}..." — luego continúa con el flujo normal.
3. **Usa el nombre de la clienta** en cuanto lo tengas.
4. **Objetivo principal:** convertir cada conversación en una cita agendada en el showroom.
5. **Recopila datos gradualmente:** primero el nombre completo (nombre y apellido), luego la fecha de boda, después propón agendar. Al pedir el nombre, especifica siempre que necesitas nombre *y* apellido, por ejemplo: "¿Me compartes tu nombre completo (nombre y apellido)? 😊".
6. **Para agendar una cita:** Cuando la clienta expresa que quiere agendar o visitar el showroom, ve directo al flujo normal (pedir nombre, fecha de boda, buscar slots).
   - Pide la fecha que prefiere la clienta.
   - Llama a \`buscar_slots_disponibles\` para ver disponibilidad.
   - Muestra los horarios disponibles de forma clara y amigable.
   - **ANTES de llamar a \`confirmar_cita\`, DEBES tener la fecha de boda de la clienta.** Si aún no la tienes, pregúntala obligatoriamente en ese momento: "¿Y para cuándo es tu boda? 💍" (o variación natural). No puedes confirmar la cita sin este dato.
   - **Cuando la clienta ya eligió un horario Y tienes su fecha de boda, llama a \`confirmar_cita\` de inmediato** — sin pedir una confirmación adicional. El hecho de que la clienta seleccione un horario ya es su confirmación implícita. Después de agendar, envía un mensaje confirmando los detalles (fecha, hora, dirección).
7. **Para consultar cita existente:** Si la clienta pregunta por su cita ("¿tengo una cita?", "¿cuándo es mi cita?", "¿me puedes dar mis datos de cita?") y la "Cita agendada (ID en calendario)" es "Ninguna", sigue este flujo de búsqueda en orden:
   a. Llama a \`buscar_cita_cliente\` (sin parámetros) — busca en Google Calendar por número de teléfono.
   b. Si regresa \`encontrada: true\` → confirma los detalles a la clienta. El ID quedará registrado para reagendar o cancelar.
   c. Si regresa \`necesita_nombre: true\` → la búsqueda por teléfono no encontró nada. **NO digas que no hay cita.** En cambio, pregunta amablemente: "Para buscarte mejor, ¿a nombre de quién está registrada tu cita? 🤍" Espera su respuesta.
   d. Cuando la clienta proporcione el nombre, llama de nuevo a \`buscar_cita_cliente\` con el parámetro \`nombre_buscado\` con ese nombre.
   e. Si en este segundo intento \`encontrada: true\` → confirma los detalles normalmente.
   f. Solo si el segundo intento también falla (regresa \`encontrada: false\` con nombre ya buscado) → **NO digas aún que no hay cita.** Primero pregunta amablemente: "No encontré una cita de elección de vestido con esos datos 🤍 ¿Podría ser una cita de ajustes o de entrega de tu vestido?" Si la clienta confirma que es una cita de ajustes/entrega → llama a \`escalar_a_humano\` de inmediato (el equipo tiene acceso a ese calendario). Solo si la clienta confirma que NO es de ajustes y realmente no hay cita → informa amablemente y ofrece agendar una nueva.
7b. **Para cancelar:** ANTES de llamar a \`cancelar_cita\`, DEBES mostrarle a la clienta los detalles de la cita que encontraste (fecha, hora) y preguntarle si está segura de que quiere cancelar. Ejemplo: "Encontré tu cita: está programada para el [día] a las [hora]. ¿Estás segura de que deseas cancelarla? 🤍". Solo llama a \`cancelar_cita\` cuando la clienta confirme explícitamente que sí quiere cancelar. El event_id lo tienes disponible en el contexto de la clienta.
8. **Para reagendar:** primero busca disponibilidad con \`buscar_slots_disponibles\`, luego llama a \`reagendar_cita\` con el nuevo horario elegido. **NUNCA llames a \`confirmar_cita\` si la clienta ya tiene una cita agendada (es decir, si "Cita agendada (ID en calendario)" NO es "Ninguna") — en ese caso usa SIEMPRE \`reagendar_cita\`.**
9. **Catálogo — regla absoluta:** En cualquier respuesta que trate sobre la boutique, los vestidos, modelos, precios, información general del negocio, o cuando la clienta pida "información" sin especificar, SIEMPRE incluye el link del catálogo (${catalog.link || ''}) en ese mismo mensaje. No lo dejes para después. Ejemplos donde DEBES incluirlo: "quiero información", "¿qué ofrecen?", "¿cómo son sus vestidos?", "¿cuánto cuestan?", "¿dónde están?", "quiero ver opciones". Excepción: si la conversación ya avanzó y el catálogo ya fue compartido antes, no es necesario repetirlo.
10. **Tono:** cálido, emocionante, personal. Como una amiga experta en bodas. Usa emojis con moderación (👰‍♀️ ✨ 💐 🤍).
11. **Precios:** El precio base ($${(pricing.precio_base || 25000).toLocaleString()} MXN) es el precio **desde el que inician** los vestidos — NO el precio de ningún modelo específico. Siempre di "nuestros vestidos inician desde $${(pricing.precio_base || 25000).toLocaleString()} MXN", nunca "$X es el precio". No existen precios fijos por modelo ni las asesoras tienen una lista de precios por modelo — el precio final depende del modelo, forma de pago, fecha de compra, promociones y personalizaciones, y se define en el showroom. **Nunca digas que "la asesora puede darte el precio por modelo"** — no existe ese precio. Nunca confirmes disponibilidad sin verificar con herramientas.
12. **Responde siempre en español.**
13. **Mensajes concisos:** WhatsApp no es email; evita respuestas largas o con demasiados párrafos.
13b. **Nunca incluyas links de Google Calendar ni ningún otro link en los mensajes de confirmación de cita.** Confirma la cita con los datos relevantes (nombre, fecha, hora, dirección) pero sin URLs.
14. **Fines de semana:** Si la clienta dice que los días de semana no le funcionan o pide opciones de fin de semana, llama INMEDIATAMENTE a \`buscar_slots_disponibles\` para el próximo sábado Y el próximo domingo disponibles (dentro del horario de atención: martes–sábado 11am–8pm, domingos 11am–6pm, lunes cerrado). No preguntes cuándo quiere — ofrece las opciones directamente.
15. **Cierre de conversación:** Si la clienta envía una señal de despedida ("muchas gracias", "hasta luego", "bye", "gracias por todo", etc.) sin tener una cita agendada, haz UN ÚLTIMO intento amable para invitarla a agendar antes de despedirte. Si ya tiene cita, confirma los detalles de la cita (fecha, hora, dirección) y despídete con calidez. Nunca te despidas sin verificar si hay algo pendiente.
16. **Llama a \`escalar_a_humano\` en estos casos — sin excepción:**
   - La clienta pide hablar con un humano o con una asesora
   - La clienta pide información que no tienes: teléfonos de otras sucursales, direcciones de otras sucursales, precios específicos por modelo, disponibilidad de modelos concretos
   - La clienta tiene una queja, solicitud especial o necesita seguimiento personalizado
   - La clienta menciona recibos, comprobantes, pagos, abonos, depósitos, transferencias o cualquier trámite administrativo
   - La clienta envía o menciona un comprobante de pago, transferencia, recibo, voucher o cualquier evidencia de una transacción económica — estos SIEMPRE van a humano con la imagen adjunta
   - La clienta quiere enviar documentos administrativos o archivos relacionados con su pedido (contratos, facturas, etc.)
   - **No escales por fotos de vestidos, referencias de modelos, inspiración o imágenes de moda** — en ese caso responde normalmente: comenta que es una elección hermosa, comparte el catálogo y ofrece agendar una cita para verlos en persona
   - **La clienta menciona "ajustes", "cita de ajustes", "prueba de ajuste", "entrega", "fecha de entrega", "folio", "número de folio", "número de pedido", o cualquier término relacionado con un pedido ya realizado.** Estas son gestiones de clientes existentes que requieren acceso a registros de compra que tú no tienes. No intentes agendar esto como una cita nueva — escala inmediatamente. (Nota: la pregunta general "¿cuándo se hacen los ajustes?" sí la puedes responder con las FAQs, pero cualquier gestión concreta de ajuste/entrega/folio de una clienta específica → escala.)
   - **Si la clienta quiere agendar y no queda claro si es su primera visita o una cita de ajustes**, pregunta: "¿Es tu primera visita con nosotros o ya tienes tu vestido y buscas agendar una cita de ajustes?" — si es ajustes, escala inmediatamente.
   - Cualquier pregunta que no puedas responder con certeza desde las FAQs
   Después de llamar a la herramienta, confirma a la clienta que su solicitud quedó registrada y que en breve uno de nuestros agentes del staff se pondrá en contacto. **Nunca digas que "intentarás" — confirma que ya quedó registrado.**

## Preguntas frecuentes — responde estas directamente sin rodeos
${faqs.map(f => `- **${f.pregunta}** → ${f.respuesta}`).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------
async function executeTool(toolName, toolArgs, calendarDeps, session, phone) {
  const { calendarClient, authClient, calendarId, innoviaCDMXCalendarId } = calendarDeps;

  try {
    // ---- buscar_slots_disponibles ----------------------------------------
    if (toolName === 'buscar_slots_disponibles') {
      const { fecha } = toolArgs;
      console.log(`🔧 Agent tool: buscar_slots_disponibles(${fecha})`);

      const slots = await getAvailableSlots(
        fecha,
        calendarClient,
        authClient,
        innoviaCDMXCalendarId,
        null
      );

      const available = slots.filter(s => s.availableSpots && s.availableSpots > 0);

      return {
        fecha,
        slots_disponibles: available,
        resultado:
          available.length > 0
            ? `Hay ${available.length} horario(s) disponible(s) para ${fecha}:\n${available
                .map((s, i) => `${i + 1}. ${s.time}  (inicio: ${s.start})`)
                .join('\n')}`
            : `No hay horarios disponibles para ${fecha}.`
      };
    }

    // ---- buscar_cita_cliente --------------------------------------------
    if (toolName === 'buscar_cita_cliente') {
      // nombre_buscado: override name provided by the agent (from client's answer)
      const nombreOverride = (toolArgs.nombre_buscado || '').trim() || null;
      const sessionName = getClientName(session) || null;
      const clientName = nombreOverride || sessionName;

      console.log(`🔧 Agent tool: buscar_cita_cliente(phone=${phone}, clientName=${clientName || 'none'})`);

      // Guard: if the session already has a calendar_event_id, report it directly
      // without requiring Google Calendar to confirm (handles network errors or
      // cases where the event was created but the search can't find it).
      if (session.calendar_event_id && !nombreOverride) {
        const sessionsModule = require('../sessions');
        const sessionData = sessionsModule.getSession(phone) || session;
        const knownDate = sessionData.fecha_cita || session.fecha_cita || 'fecha registrada';
        console.log(`📋 buscar_cita_cliente: cita ya conocida en sesión (event_id=${session.calendar_event_id})`);
        return {
          encontrada: true,
          event_id: session.calendar_event_id,
          resumen: clientName || 'Cita agendada',
          fecha: knownDate,
          hora: '',
          mensaje: `La sesión indica que esta clienta ya tiene una cita agendada (ID: ${session.calendar_event_id}, fecha aproximada: ${knownDate}). Confírmale que su cita está registrada y ofrécele los detalles disponibles.`
        };
      }

      const event = await findEventByPhoneService(
        phone,
        clientName,
        calendarClient,
        authClient,
        calendarId
      );

      if (event) {
        // Persist to session so future tools (reagendar, cancelar) have the ID
        const sessions = require('../sessions');
        sessions.updateSession(phone, { calendar_event_id: event.id });

        return {
          encontrada: true,
          event_id: event.id,
          resumen: event.summary,
          fecha: event.formattedDate,
          hora: event.formattedTime,
          mensaje: `Cita encontrada: "${event.summary}" — ${event.formattedDate} a las ${event.formattedTime}. ID: ${event.id}`
        };
      }

      // If we already tried a name and still nothing → truly not found
      if (clientName) {
        return {
          encontrada: false,
          nombre_buscado: clientName,
          mensaje: `No se encontró ninguna cita próxima para esta clienta ni por teléfono (${phone}) ni por nombre ("${clientName}").`
        };
      }

      // No name available yet — signal the agent to ask for it
      return {
        encontrada: false,
        necesita_nombre: true,
        mensaje: 'No se encontró cita por número de teléfono. Es posible que esté registrada a nombre de otra persona. Pregunta a la clienta a nombre de quién está registrada la cita antes de confirmar que no existe.'
      };
    }

    // ---- confirmar_cita --------------------------------------------------
    if (toolName === 'confirmar_cita') {
      const { hora_inicio, nombre_cliente, telefono, fecha_boda } = toolArgs;
      console.log(`🔧 Agent tool: confirmar_cita(${nombre_cliente}, ${hora_inicio})`);

      // SAFETY GUARD: nombre_cliente must be a real non-empty name.
      // The LLM can pass "" or null even though the field is marked required.
      const nombreFinal = (nombre_cliente || '').trim();
      if (!nombreFinal) {
        console.warn(`⚠️  confirmar_cita bloqueada: nombre_cliente vacío o faltante`);
        return {
          exito: false,
          error: 'No puedes agendar la cita sin el nombre de la clienta. Pregúntale su nombre completo antes de continuar.'
        };
      }

      // SAFETY GUARD: If the session already has an appointment, delete it before creating
      // a new one. This handles cases where the agent mistakenly calls confirmar_cita
      // instead of reagendar_cita when the client already has a scheduled appointment.
      if (session.calendar_event_id) {
        console.warn(`⚠️  confirmar_cita llamado con calendar_event_id existente (${session.calendar_event_id}). Eliminando cita anterior para evitar duplicados.`);
        try {
          const oldEvent = await getCalendarEventService(session.calendar_event_id, calendarClient, authClient, calendarId);
          const oldStartIso = oldEvent?.start?.dateTime || oldEvent?.start?.date || null;
          await deleteCalendarEventService(session.calendar_event_id, calendarClient, authClient, calendarId);
          if (oldStartIso) {
            console.log(`🔵 Restaurando slot azul de cita anterior en Innovia CDMX: ${oldStartIso}`);
            await restoreBlueEventService(oldStartIso, calendarClient, authClient, innoviaCDMXCalendarId);
          }
        } catch (guardErr) {
          console.error(`❌ Error eliminando cita anterior en guard de confirmar_cita: ${guardErr.message}`);
          // Continue to create new event even if old deletion fails
        }
      }

      // ── Validación de cupo antes de confirmar ──────────────────────────
      // Verificar que: (a) hay eventos azules disponibles Y (b) no se superan 3 citas por slot
      const storedSlotsForCheck = session.slots_disponibles || [];
      const appointmentTimeForCheck = new Date(hora_inicio).getTime();
      const matchingSlotForCheck = storedSlotsForCheck.find(
        s => Math.abs(new Date(s.start).getTime() - appointmentTimeForCheck) < 60000
      );
      const hasBlueEvent = !!matchingSlotForCheck?.eventId;

      const slotCheck = await isSlotAvailable(hora_inicio, calendarClient, authClient, calendarId);

      if (!hasBlueEvent) {
        console.warn(`⚠️  confirmar_cita bloqueada: no hay evento azul disponible para ${hora_inicio}`);
        return {
          exito: false,
          error: 'Este horario ya no tiene cupos disponibles. Por favor elige otro horario.'
        };
      }
      if (!slotCheck.available) {
        console.warn(`⚠️  confirmar_cita bloqueada: cupo lleno ${slotCheck.currentCount}/${slotCheck.maxCount} para ${hora_inicio}`);
        return {
          exito: false,
          error: `Este horario ya tiene ${slotCheck.currentCount} citas agendadas (máximo ${slotCheck.maxCount}). Por favor elige otro horario.`
        };
      }
      // ───────────────────────────────────────────────────────────────────

      const event = await createCalendarEventService(
        nombreFinal,
        telefono,
        null,
        hora_inicio,
        fecha_boda || null,
        calendarClient,
        authClient,
        calendarId
      );

      if (event) {
        // Eliminar el evento azul (slot disponible) del calendario Innovia CDMX
        const storedSlots = session.slots_disponibles || [];
        const appointmentTime = new Date(hora_inicio).getTime();
        const matchingSlot = storedSlots.find(slot => {
          return Math.abs(new Date(slot.start).getTime() - appointmentTime) < 60000;
        });
        if (matchingSlot && matchingSlot.eventId) {
          console.log(`🗑️  Eliminando slot azul del calendario Innovia CDMX (ID: ${matchingSlot.eventId})`);
          await deleteCalendarEventService(matchingSlot.eventId, calendarClient, authClient, innoviaCDMXCalendarId);
        } else {
          console.warn(`⚠️  No se encontró slot azul coincidente para eliminar en hora: ${hora_inicio}`);
        }

        // Calcular el día de semana correcto en zona horaria de México
        // (el LLM no debe calcular esto por su cuenta — puede equivocarse)
        const appointmentDate = new Date(hora_inicio);
        const diaSemana = appointmentDate.toLocaleDateString('es-MX', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'America/Mexico_City'
        });

        return {
          exito: true,
          event_id: event.id,
          fecha_confirmada: diaSemana,
          mensaje: `Cita creada exitosamente para el ${diaSemana}. ID: ${event.id}. IMPORTANTE: usa exactamente esta fecha al confirmarle a la clienta — no calcules el día de la semana por tu cuenta.`
        };
      }
      return { exito: false, mensaje: 'No se pudo crear el evento en el calendario.' };
    }

    // ---- cancelar_cita ---------------------------------------------------
    if (toolName === 'cancelar_cita') {
      const { event_id } = toolArgs;
      console.log(`🔧 Agent tool: cancelar_cita(${event_id})`);

      // Obtener detalles del evento ANTES de eliminarlo para recuperar la hora
      const existingEvent = await getCalendarEventService(event_id, calendarClient, authClient, calendarId);
      const startIso = existingEvent?.start?.dateTime || existingEvent?.start?.date || null;

      await deleteCalendarEventService(event_id, calendarClient, authClient, calendarId);

      // Restaurar el slot azul en el calendario Innovia CDMX
      if (startIso) {
        console.log(`🔵 Restaurando slot azul en Innovia CDMX para: ${startIso}`);
        await restoreBlueEventService(startIso, calendarClient, authClient, innoviaCDMXCalendarId);
      } else {
        console.warn(`⚠️  No se pudo obtener la hora de inicio del evento para restaurar el slot azul`);
      }

      return { exito: true, mensaje: 'Cita cancelada exitosamente.' };
    }

    // ---- reagendar_cita --------------------------------------------------
    if (toolName === 'reagendar_cita') {
      const { event_id, nueva_hora_inicio } = toolArgs;
      console.log(`🔧 Agent tool: reagendar_cita(${event_id} → ${nueva_hora_inicio})`);

      // CRITICAL: Get the existing event BEFORE updating to know the old slot time
      const existingEvent = await getCalendarEventService(event_id, calendarClient, authClient, calendarId);
      const oldStartIso = existingEvent?.start?.dateTime || existingEvent?.start?.date || null;

      const clientName = getClientName(session) || 'Cliente';
      const event = await updateCalendarEventService(
        event_id,
        clientName,
        phone,
        null,
        nueva_hora_inicio,
        session.fecha_boda || null,
        calendarClient,
        authClient,
        calendarId
      );

      if (event) {
        // CRITICAL: Restore the blue event at the OLD slot (it's now available again)
        if (oldStartIso && innoviaCDMXCalendarId) {
          console.log(`🔵 Restaurando slot azul en Innovia CDMX para hora anterior: ${oldStartIso}`);
          await restoreBlueEventService(oldStartIso, calendarClient, authClient, innoviaCDMXCalendarId);
        } else {
          console.warn(`⚠️  No se pudo restaurar slot azul: oldStartIso=${oldStartIso}, innoviaCDMXCalendarId=${innoviaCDMXCalendarId}`);
        }

        // CRITICAL: Delete the blue event at the NEW slot (it's now occupied)
        const storedSlots = session.slots_disponibles || [];
        const appointmentTime = new Date(nueva_hora_inicio).getTime();
        let matchingSlot = storedSlots.find(slot => Math.abs(new Date(slot.start).getTime() - appointmentTime) < 60000);

        // Fallback: if not found in session (session may be stale), fetch fresh slots for that date
        if ((!matchingSlot || !matchingSlot.eventId) && innoviaCDMXCalendarId) {
          console.log(`🔍 Slot no encontrado en sesión, buscando en calendario Innovia CDMX para: ${nueva_hora_inicio}`);
          try {
            const newDate = nueva_hora_inicio.split('T')[0]; // YYYY-MM-DD
            const freshSlots = await getAvailableSlots(newDate, calendarClient, authClient, innoviaCDMXCalendarId, null);
            matchingSlot = freshSlots.find(slot => Math.abs(new Date(slot.start).getTime() - appointmentTime) < 60000);
            if (matchingSlot) {
              console.log(`✅ Slot encontrado en búsqueda fresca (ID: ${matchingSlot.eventId})`);
            }
          } catch (fetchErr) {
            console.warn(`⚠️  Error buscando slots frescos: ${fetchErr.message}`);
          }
        }

        if (matchingSlot && matchingSlot.eventId) {
          console.log(`🗑️  Eliminando slot azul del nuevo horario en Innovia CDMX (ID: ${matchingSlot.eventId})`);
          await deleteCalendarEventService(matchingSlot.eventId, calendarClient, authClient, innoviaCDMXCalendarId);
        } else {
          console.warn(`⚠️  No se encontró slot azul coincidente para eliminar en hora: ${nueva_hora_inicio}`);
        }

        return {
          exito: true,
          event_id: event.id,
          mensaje: 'Cita reagendada exitosamente.'
        };
      }
      return { exito: false, mensaje: 'No se pudo reagendar la cita.' };
    }

    // ---- escalar_a_humano ------------------------------------------------
    if (toolName === 'escalar_a_humano') {
      const { descripcion_solicitud } = toolArgs;
      console.log(`🔧 Agent tool: escalar_a_humano("${descripcion_solicitud}")`);

      const clientName = getClientName(session) || '';
      logPendingTask({
        phone,
        name: clientName,
        message: descripcion_solicitud,
        historial: session.historial || []
      });

      // Mark session so Embudo tracks this independently of pendingTasks
      const sessionsModule = require('../sessions');
      sessionsModule.updateSession(phone, {
        escalated_to_human: true,
        resolved_by_agent: false
      });

      return {
        exito: true,
        mensaje: 'Solicitud registrada. Un agente del staff se pondrá en contacto con la clienta.'
      };
    }

    return { error: `Herramienta desconocida: ${toolName}` };
  } catch (err) {
    console.error(`❌ Error en tool ${toolName}:`, err.message);
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main agent function
// ---------------------------------------------------------------------------
/**
 * Run the conversational agent for an incoming message.
 *
 * @param {string}  phone          - Cleaned phone number
 * @param {Object}  session        - Current session object
 * @param {string}  message        - Raw incoming message (may be a button ID like "slot_0")
 * @param {Object}  calendarDeps   - { calendarClient, authClient, calendarId, innoviaCDMXCalendarId }
 * @param {boolean} isButtonClick  - True when message comes from an interactive button
 * @param {string}  buttonTitle    - Human-readable button label (if isButtonClick)
 * @returns {Promise<{ reply: string, sessionUpdates: Object }>}
 */
async function runAgent(phone, session, message, calendarDeps, isButtonClick = false, buttonTitle = null) {
  const client = getOpenAIClient();

  // Resolve button clicks to human-readable text so the LLM understands them
  let resolvedMessage = message;
  if (isButtonClick) {
    if (message.startsWith('slot_')) {
      const idx = parseInt(message.replace('slot_', ''), 10);
      const slots = session.slots_disponibles || [];
      if (slots[idx]) {
        const slot = slots[idx];
        resolvedMessage = `Selecciono el horario ${slot.time} (inicio: ${slot.start})`;
      } else {
        resolvedMessage = buttonTitle || message;
      }
    } else {
      resolvedMessage = buttonTitle || message;
    }
  }

  // Build conversation messages (last 20 exchanges for context)
  const history = (session.historial || [])
    .slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  // Replace the last user message with the resolved version (button click → readable text)
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    history[history.length - 1].content = resolvedMessage;
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(session, phone) },
    ...history
  ];

  const sessionUpdates = {};
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`🤖 Agent loop iteration ${i + 1}`);

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 600
    });

    const choice = response.choices[0];

    // ---- Tool call round -------------------------------------------------
    if (choice.finish_reason === 'tool_calls') {
      messages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        console.log(`🔧 Tool call: ${toolName}`, toolArgs);
        const result = await executeTool(toolName, toolArgs, calendarDeps, session, phone);
        console.log(`✅ Tool result:`, result);

        // Propagate side-effects to sessionUpdates
        if (toolName === 'buscar_slots_disponibles' && result.slots_disponibles) {
          sessionUpdates.slots_disponibles = result.slots_disponibles;
          sessionUpdates.fecha_cita_solicitada = toolArgs.fecha;
          // Also update session in-place so subsequent tool calls in the same turn can use it
          session.slots_disponibles = result.slots_disponibles;
        }
        if (toolName === 'confirmar_cita' && result.exito) {
          sessionUpdates.calendar_event_id = result.event_id;
          sessionUpdates.etapa = 'cita_agendada';
          sessionUpdates.cita_agendada_en = new Date().toISOString();
          sessionUpdates.slots_disponibles = null;
          sessionUpdates.fecha_cita = toolArgs.hora_inicio.split('T')[0];
          // Also persist name if provided
          if (toolArgs.nombre_cliente) {
            sessionUpdates.nombre_cliente = toolArgs.nombre_cliente;
            sessionUpdates.nombre_novia = toolArgs.nombre_cliente;
          }
          if (toolArgs.fecha_boda) {
            sessionUpdates.fecha_boda = toolArgs.fecha_boda;
          }
        }
        if (toolName === 'cancelar_cita' && result.exito) {
          sessionUpdates.calendar_event_id = null;
          sessionUpdates.etapa = 'interesada';
          sessionUpdates.fecha_cita = null;
        }
        if (toolName === 'reagendar_cita' && result.exito) {
          sessionUpdates.calendar_event_id = result.event_id;
          sessionUpdates.fecha_cita = toolArgs.nueva_hora_inicio.split('T')[0];
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      continue; // Let LLM generate the final response
    }

    // ---- Final response --------------------------------------------------
    const reply = choice.message.content || '';
    console.log(`🤖 Agent reply (${reply.length} chars)`);

    // ---- Escalation safety net -------------------------------------------
    // If the reply mentions escalation to a human but escalar_a_humano was
    // never called during this loop, log it to Sheets automatically.
    const escalationPhrases = [
      'pondrá en contacto', 'se comunicará contigo', 'un agente te', 'una asesora te',
      'hemos tomado nota', 'tomamos nota', 'te contactaremos', 'nos pondremos en contacto'
    ];
    const escalationToolWasCalled = messages.some(
      m => m.role === 'tool' &&
      messages.some(
        a => a.role === 'assistant' &&
        a.tool_calls &&
        a.tool_calls.some(tc => tc.function.name === 'escalar_a_humano')
      )
    );
    const replyLower = reply.toLowerCase();
    const replyMentionsEscalation = escalationPhrases.some(p => replyLower.includes(p));

    if (replyMentionsEscalation && !escalationToolWasCalled) {
      console.log('⚠️  [ESCALATION NET] El reply menciona escalamiento pero el tool no fue llamado — guardando en Sheets y seteando flag');
      const clientName = getClientName(session) || '';
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      logPendingTask({
        phone,
        name: clientName,
        message: lastUserMsg,
        historial: session.historial || []
      });
      // Setear flag igual que en el tool handler para que el Embudo lo refleje de inmediato
      const sessionsModule = require('../sessions');
      sessionsModule.updateSession(phone, { escalated_to_human: true, resolved_by_agent: false });
    }

    return { reply, sessionUpdates };
  }

  // Safety fallback
  return {
    reply: 'Lo siento, ocurrió un problema procesando tu mensaje. ¿Puedes intentarlo de nuevo?',
    sessionUpdates
  };
}

module.exports = { runAgent };

/**
 * Calendar Service
 * 
 * Handles Google Calendar operations.
 * This is the ONLY module that interacts with Google Calendar.
 * 
 * NOTE: This module expects the Google Calendar auth to be initialized
 * in the main bot file. We'll need to pass the calendar client and auth
 * as parameters or access them via a shared module.
 * 
 * For now, we'll create functions that can be called with the necessary
 * dependencies from the main bot file.
 */

const { getBusinessHours, getHolidays } = require('../config');

/**
 * Check if a day is open according to business hours
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {boolean} True if day is open
 */
function isDayOpen(dateString) {
  try {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const dayOfWeek = date.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    
    const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const dayName = dayNames[dayOfWeek];
    
    const hours = getBusinessHours();
    
    // Verificar si el día está cerrado por horario
    if (dayName === 'lunes' && hours.lunes === 'Cerrado') {
      console.log(`   ❌ ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} está cerrado`);
      return false;
    }

    // Verificar si es asueto
    const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const holidays = getHolidays();
    const holiday = holidays.find(h => h.fecha === mmdd);
    if (holiday) {
      console.log(`   ❌ ${dateString} es asueto: ${holiday.nombre}`);
      return false;
    }

    // Los demás días están abiertos según la configuración
    return true;
  } catch (error) {
    console.error('Error verificando día:', error);
    return true; // Por defecto permitir si hay error
  }
}

/**
 * Get default slots if Google Calendar is not available
 * Los domingos solo hasta las 5:00pm (no se ofrece 6:30pm)
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Array} Array of slot objects
 */
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

/**
 * Get available slots from Google Calendar "Innovia CDMX"
 * Los spots disponibles son los eventos azules (sin nombre) en el calendario "Innovia CDMX"
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} innoviaCDMXCalendarId - Calendar ID del calendario "Innovia CDMX" (eventos azules = spots disponibles)
 * @param {string} excludeEventId - Optional: Event ID to exclude (when moving appointment)
 * @returns {Promise<Array>} Array of available slot objects
 */
async function getAvailableSlots(date, calendarClient, authClient, innoviaCDMXCalendarId, excludeEventId = null) {
  try {
    // Verificar si el día está abierto
    if (!isDayOpen(date)) {
      console.log(`📅 ${date} está cerrado según horarios del negocio`);
      return []; // Retornar array vacío si está cerrado
    }
    
    if (!authClient) {
      console.error('❌ ERROR: Google Auth no inicializado');
      console.error('   ⚠️  NO se pueden consultar eventos del calendario "Innovia CDMX"');
      console.error('   ⚠️  Retornando array vacío - el bot SOLO usa eventos azules del calendario');
      return [];
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
    
    // CRITICAL: Crear fechas interpretándolas como hora de CDMX, no como hora local del servidor
    // El problema: new Date(year, month - 1, day, 0, 0, 0) crea la fecha en la zona horaria LOCAL del servidor
    // Si el servidor está en UTC, esto puede causar que se consulte el día incorrecto
    // Solución: crear strings ISO con el offset de CDMX correcto
    const [year, month, day] = date.split('-').map(Number);
    
    // Calcular el offset de CDMX para esta fecha específica
    // CDMX está en UTC-6 (horario estándar) o UTC-5 (horario de verano)
    // Usar un método más directo: crear una fecha en UTC y ver qué hora es en CDMX
    const getCDMXOffset = (y, m, d) => {
      // Crear una fecha en UTC para el mediodía del día solicitado
      const utcDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
      
      // Obtener la hora en CDMX usando toLocaleString
      const cdmxHour = parseInt(utcDate.toLocaleString('en-US', { 
        timeZone: 'America/Mexico_City',
        hour: '2-digit',
        hour12: false
      }));
      
      // Si UTC es 12:00 y CDMX es 6:00, el offset es -6
      // Si UTC es 12:00 y CDMX es 7:00, el offset es -5 (horario de verano)
      const offsetHours = cdmxHour - 12;
      
      return offsetHours;
    };
    
    const offsetHours = getCDMXOffset(year, month, day);
    // El offset debe ser negativo para CDMX (UTC-6 o UTC-5)
    const offsetStr = offsetHours >= 0 
      ? `+${String(Math.abs(offsetHours)).padStart(2, '0')}:00` 
      : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
    
    console.log(`   📅 [getAvailableSlots] Offset calculado: ${offsetHours} horas (${offsetStr})`);
    
    // Verificar que el offset sea correcto (debe ser -6 o -5 para CDMX)
    if (offsetHours > 0 || offsetHours < -6) {
      console.warn(`   ⚠️  ADVERTENCIA: Offset inesperado (${offsetHours}), debería ser -6 o -5 para CDMX`);
    }
    
    // CRITICAL: Crear strings ISO con el offset de CDMX para que se interpreten correctamente
    // Inicio del día: 00:00:00 en CDMX
    const startOfDayISO = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00${offsetStr}`;
    // Fin del día: 23:59:59 en CDMX
    const endOfDayISO = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:59:59${offsetStr}`;
    
    const startOfDay = new Date(startOfDayISO);
    const endOfDay = new Date(endOfDayISO);
    
    console.log(`   📅 [getAvailableSlots] Fechas creadas para consulta:`);
    console.log(`      Fecha solicitada: ${date} (${year}-${month}-${day})`);
    console.log(`      Offset CDMX: ${offsetHours} horas`);
    console.log(`      startOfDay ISO: ${startOfDayISO} -> ${startOfDay.toISOString()}`);
    console.log(`      endOfDay ISO: ${endOfDayISO} -> ${endOfDay.toISOString()}`);
    console.log(`      startOfDay en CDMX: ${startOfDay.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`);
    console.log(`      endOfDay en CDMX: ${endOfDay.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`);

    if (!innoviaCDMXCalendarId) {
      console.error('❌ ERROR: No se encontró calendario "Innovia CDMX"');
      console.error('   ⚠️  El bot SOLO usa eventos azules del calendario "Innovia CDMX"');
      console.error('   ⚠️  Retornando array vacío - verifica que el calendario exista y esté compartido');
      return [];
    }

    console.log(`📅 Consultando calendario "Innovia CDMX" para spots disponibles en ${date}`);
    console.log(`   Rango: ${startOfDay.toLocaleString('es-MX')} - ${endOfDay.toLocaleString('es-MX')}`);
    console.log(`   📌 Calendar ID usado: ${innoviaCDMXCalendarId}`);
    
    // Try to get calendar name for better logging
    try {
      const calendarInfo = await calendarClient.calendars.get({
        auth: auth,
        calendarId: innoviaCDMXCalendarId
      });
      const calendarName = calendarInfo.data.summary || 'Sin nombre';
      const calendarEmail = calendarInfo.data.id || 'N/A';
      console.log(`   📌 Nombre del calendario: "${calendarName}"`);
      console.log(`   📌 Email/ID del calendario: ${calendarEmail}`);
      console.log(`   📌 Calendar ID usado: ${innoviaCDMXCalendarId}`);
      if (calendarName.toUpperCase().includes('INNOVIA CDMX')) {
        console.log(`   ✅ Confirmado: Se está usando el calendario "Innovia CDMX"`);
      } else {
        console.warn(`   ⚠️  ADVERTENCIA: El calendario usado NO es "Innovia CDMX" (es: "${calendarName}")`);
        console.warn(`   ⚠️  Verifica que estés usando el calendario correcto. Los eventos deben estar en "Innovia CDMX"`);
      }
    } catch (error) {
      console.warn(`   ⚠️  No se pudo obtener nombre del calendario: ${error.message}`);
    }

    const events = await calendarClient.events.list({
      auth: auth,
      calendarId: innoviaCDMXCalendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Mexico_City',
      maxResults: 250 // Asegurar que se devuelvan todos los eventos del día
    });

    const eventItems = events.data.items || [];
    console.log(`   📋 Total de eventos encontrados en calendario: ${eventItems.length}`);
    console.log(`   📋 Rango consultado:`);
    console.log(`      timeMin: ${startOfDay.toISOString()} (${startOfDay.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })})`);
    console.log(`      timeMax: ${endOfDay.toISOString()} (${endOfDay.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })})`);
    console.log(`   📋 Fecha solicitada: ${date} (${year}-${month}-${day})`);
    
    // Log detallado de TODOS los eventos encontrados (antes de filtrar)
    if (eventItems.length > 0) {
      console.log(`   📋 ============================================`);
      console.log(`   📋 DETALLE DE TODOS LOS EVENTOS ENCONTRADOS:`);
      console.log(`   📋 ============================================`);
      eventItems.forEach((e, idx) => {
        const startStr = e.start.dateTime || e.start.date || 'N/A';
        const endStr = e.end.dateTime || e.end.date || 'N/A';
        const summary = e.summary || '(Sin título)';
        const hasName = e.summary && e.summary.trim() !== '';
        
        // Calcular duración si tiene dateTime
        let durationInfo = '';
        if (e.start.dateTime && e.end.dateTime) {
          try {
            const start = new Date(e.start.dateTime);
            const end = new Date(e.end.dateTime);
            if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
              const durationMs = end.getTime() - start.getTime();
              const durationMinutes = durationMs / (60 * 1000);
              durationInfo = ` - Duración: ${durationMinutes.toFixed(1)} min`;
            }
          } catch (e) {
            durationInfo = ' - Duración: N/A';
          }
        }
        
        // Calcular fecha del evento en CDMX para verificar
        let eventDateCDMX = 'N/A';
        let eventTimeCDMX = 'N/A';
        if (e.start.dateTime) {
          try {
            const eventStart = new Date(e.start.dateTime);
            eventDateCDMX = eventStart.toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
            eventTimeCDMX = eventStart.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
          } catch (e) {
            // Ignore
          }
        }
        
        console.log(`      ${idx + 1}. Evento [${e.id}]`);
        console.log(`         Título: "${summary}"`);
        console.log(`         Tiene nombre: ${hasName ? 'SÍ ❌ (será excluido)' : 'NO ✅ (será incluido si dura 90 min)'}`);
        console.log(`         Fecha en CDMX: ${eventDateCDMX} ${eventTimeCDMX}`);
        console.log(`         Inicio (raw): ${startStr}`);
        console.log(`         Fin (raw): ${endStr}${durationInfo}`);
      });
      console.log(`   📋 ============================================`);
    }

    // Procesar eventos azules (spots disponibles)
    // Estos eventos NO tienen nombre (o tienen nombre vacío) y representan horarios disponibles
    const availableSpots = eventItems
      .filter(e => {
        // Exclude the event we're moving (if provided)
        if (excludeEventId && e.id === excludeEventId) {
          console.log(`   ⏭️  Excluyendo evento ${e.id} (se está moviendo)`);
          return false;
        }
        // Solo incluir eventos sin nombre (o con nombre vacío) - estos son los spots disponibles
        const hasNoName = !e.summary || e.summary.trim() === '';
        if (!hasNoName) {
          console.log(`   ⏭️  Excluyendo evento con nombre "${e.summary}" (solo eventos sin nombre son spots disponibles)`);
        }
        return hasNoName;
      })
      .map(e => {
        let start, end;
        
        // Manejar eventos con hora (dateTime) y eventos de todo el día (date)
        if (e.start.dateTime) {
          // CRITICAL: Parsear dateTime considerando el timezone
          // Google Calendar puede devolver dateTime con o sin offset explícito
          // Si viene sin offset pero tiene timeZone en la request, se interpreta como hora local de ese timezone
          const startStr = e.start.dateTime;
          const endStr = e.end.dateTime;
          
          // Google Calendar devuelve dateTime con timezone cuando se especifica timeZone en la request
          // El string dateTime puede venir con offset explícito o sin él
          // Si viene sin offset, JavaScript lo interpreta como hora local del servidor (puede ser UTC)
          // Necesitamos asegurarnos de que se interprete como hora de CDMX
          
          // Log del formato original para debugging
          console.log(`      📅 Parseando fecha de evento: ${e.summary || 'Sin título'}`);
          console.log(`         dateTime original: ${startStr}`);
          
          // Si el string ya tiene offset (Z o +/-HH:MM), usarlo directamente
          // Si no tiene offset, Google Calendar lo interpreta según el timeZone de la request
          // Pero JavaScript lo interpretará como hora local del servidor, que puede ser UTC
          // Necesitamos convertirlo a hora de CDMX
          
          let startParsed, endParsed;
          
          if (startStr.endsWith('Z') || startStr.match(/[+-]\d{2}:\d{2}$/)) {
            // Ya tiene offset, parsear directamente
            startParsed = new Date(startStr);
            endParsed = new Date(endStr);
            console.log(`         ✅ Tiene offset, parseado directo`);
          } else {
            // No tiene offset explícito
            // Google Calendar devuelve esto cuando timeZone está especificado en la request
            // El string representa la hora en CDMX (America/Mexico_City)
            // CRITICAL: Necesitamos interpretarlo correctamente como hora de CDMX
            // Extraer componentes de la fecha/hora
            const dateTimeMatch = startStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
            if (dateTimeMatch) {
              const [, year, month, day, hour, minute, second] = dateTimeMatch.map(Number);
              
              // Calcular el offset de CDMX para esta fecha específica
              const getCDMXOffset = (y, m, d) => {
                const testDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
                const cdmxHour = parseInt(testDate.toLocaleString('en-US', { 
                  timeZone: 'America/Mexico_City',
                  hour: '2-digit',
                  hour12: false
                }));
                const offsetHours = 12 - cdmxHour;
                return offsetHours;
              };
              
              const offsetHours = getCDMXOffset(year, month, day);
              const offsetStr = offsetHours >= 0 
                ? `+${String(Math.abs(offsetHours)).padStart(2, '0')}:00` 
                : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
              
              const startWithTZ = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second || 0).padStart(2, '0')}${offsetStr}`;
              
              // Hacer lo mismo para endStr
              const endDateTimeMatch = endStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
              if (endDateTimeMatch) {
                const [, endYear, endMonth, endDay, endHour, endMinute, endSecond] = endDateTimeMatch.map(Number);
                const endOffsetHours = getCDMXOffset(endYear, endMonth, endDay);
                const endOffsetStr = endOffsetHours >= 0 
                  ? `+${String(Math.abs(endOffsetHours)).padStart(2, '0')}:00` 
                  : `-${String(Math.abs(endOffsetHours)).padStart(2, '0')}:00`;
                const endWithTZ = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:${String(endSecond || 0).padStart(2, '0')}${endOffsetStr}`;
                
                startParsed = new Date(startWithTZ);
                endParsed = new Date(endWithTZ);
                
                // Verificar que la fecha se parseó correctamente
                const parsedDateCDMX = startParsed.toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
                const parsedTimeCDMX = startParsed.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
                const expectedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                
                console.log(`         ⚠️  Sin offset, calculado offset CDMX: ${offsetStr} para fecha ${year}-${month}-${day}`);
                console.log(`         dateTime con offset: ${startWithTZ}`);
                console.log(`         Fecha parseada en CDMX: ${parsedDateCDMX} (esperada: ${expectedDate}), Hora: ${parsedTimeCDMX}`);
                
                // Verificar que la fecha parseada corresponde al día esperado
                const parsedDateParts = parsedDateCDMX.split('/');
                const parsedDateFormatted = `${parsedDateParts[2]}-${parsedDateParts[0].padStart(2, '0')}-${parsedDateParts[1].padStart(2, '0')}`;
                if (parsedDateFormatted !== expectedDate) {
                  console.error(`         ❌ ERROR: Fecha parseada incorrecta! Esperada: ${expectedDate}, Obtenida: ${parsedDateFormatted}`);
                }
              } else {
                // Fallback si no podemos parsear endStr
                startParsed = new Date(startWithTZ);
                endParsed = new Date(endStr);
              }
            } else {
              // Fallback si no podemos parsear startStr
              const startWithTZ = `${startStr}-06:00`;
              const endWithTZ = `${endStr}-06:00`;
              startParsed = new Date(startWithTZ);
              endParsed = new Date(endWithTZ);
              console.log(`         ⚠️  No se pudo parsear fecha, usando fallback -06:00`);
            }
          }
          
          start = startParsed;
          end = endParsed;
          
          // Verificar que la fecha se parseó correctamente
          if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            console.error(`   ❌ Error parseando fecha de evento: ${e.summary || 'Sin título'}`);
            console.error(`      start.dateTime: ${e.start.dateTime}`);
            console.error(`      end.dateTime: ${e.end.dateTime}`);
            // Fallback: intentar parsear sin modificar
            start = new Date(e.start.dateTime);
            end = new Date(e.end.dateTime);
          } else {
            // Verificar que la hora parseada sea correcta en CDMX
            const startCDMX = start.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
            console.log(`         Hora parseada en CDMX: ${startCDMX}`);
          }
        } else if (e.start.date) {
          // Evento de todo el día - considerar que ocupa todo el día
          start = new Date(e.start.date + 'T00:00:00');
          end = new Date(e.end.date + 'T23:59:59');
        } else {
          console.warn(`   ⚠️  Evento sin fecha válida: ${e.summary || 'Sin título'}`);
          // Crear fechas inválidas que no se contarán
          start = new Date(NaN);
          end = new Date(NaN);
        }
        
        // Los eventos azules (sin nombre) son los spots disponibles
        return { start, end, id: e.id, originalStart: e.start.dateTime || e.start.date, originalEnd: e.end.dateTime || e.end.date };
      })
      .filter(event => {
        // Filtrar eventos con fechas inválidas
        if (isNaN(event.start.getTime()) || isNaN(event.end.getTime())) {
          console.log(`   ⏭️  ❌ EXCLUYENDO evento [${event.id}] - fecha inválida`);
          return false;
        }
        
        // CRITICAL: Filtrar eventos que NO son del día solicitado
        // Verificar que el evento esté en el día correcto (en CDMX)
        const eventDateCDMX = event.start.toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
        const requestedDateCDMX = new Date(year, month - 1, day).toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
        
        // Comparar fechas en formato YYYY-MM-DD para evitar problemas de formato
        const eventDateParts = eventDateCDMX.split('/');
        const eventDateFormatted = `${eventDateParts[2]}-${eventDateParts[0].padStart(2, '0')}-${eventDateParts[1].padStart(2, '0')}`;
        const requestedDateFormatted = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        if (eventDateFormatted !== requestedDateFormatted) {
          const startTimeCDMX = event.start.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
          console.log(`   ⏭️  ❌ EXCLUYENDO evento [${event.id}] - fecha incorrecta: ${eventDateFormatted} (solicitado: ${requestedDateFormatted}), Hora: ${startTimeCDMX}`);
          return false;
        }
        
        // CRITICAL: Solo considerar eventos que duran exactamente 90 minutos
        // 90 minutos = 90 * 60 * 1000 = 5,400,000 milisegundos
        const durationMs = event.end.getTime() - event.start.getTime();
        const durationMinutes = durationMs / (60 * 1000);
        const DURACION_ESPERADA_MINUTOS = 90;
        const TOLERANCIA_MINUTOS = 1; // Permitir pequeña tolerancia (89-91 minutos)
        
        const is90Minutes = Math.abs(durationMinutes - DURACION_ESPERADA_MINUTOS) <= TOLERANCIA_MINUTOS;
        
        // Log detallado de cada evento que pasa el filtro de nombre y fecha
        const startTimeCDMX = event.start.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
        console.log(`   🔍 Verificando evento [${event.id}] - Fecha: ${eventDateFormatted}, Hora: ${startTimeCDMX}, Duración: ${durationMinutes.toFixed(1)} min`);
        
        if (!is90Minutes) {
          console.log(`   ⏭️  ❌ EXCLUYENDO evento [${event.id}] - duración: ${durationMinutes.toFixed(1)} minutos (debe ser 90 minutos, tolerancia: ±${TOLERANCIA_MINUTOS} min)`);
          return false;
        }
        
        console.log(`   ✅ INCLUYENDO evento [${event.id}] - Fecha: ${eventDateFormatted}, Hora: ${startTimeCDMX}, Duración: ${durationMinutes.toFixed(1)} min (dentro de tolerancia)`);
        return true;
      });

    console.log(`   Spots disponibles encontrados (eventos azules sin nombre, duración 90 min): ${availableSpots.length}`);
    
    // Log detallado de todos los spots disponibles
    if (availableSpots.length > 0) {
      console.log(`   📋 Detalle de spots disponibles (eventos azules sin nombre, duración 90 min):`);
      availableSpots.forEach((spot, idx) => {
        const startCDMX = spot.start.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
        const endCDMX = spot.end.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
        const startTimeCDMX = spot.start.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
        const durationMs = spot.end.getTime() - spot.start.getTime();
        const durationMinutes = durationMs / (60 * 1000);
        console.log(`      ${idx + 1}. Spot disponible [${spot.id}]`);
        console.log(`         Hora CDMX: ${startTimeCDMX}`);
        console.log(`         Duración: ${durationMinutes.toFixed(1)} minutos`);
        console.log(`         Rango: ${startCDMX} - ${endCDMX}`);
        console.log(`         Timestamps: [${spot.start.getTime()} - ${spot.end.getTime()}]`);
        console.log(`         ⚠️  Este evento azul se convertirá en un slot disponible`);
      });
      console.log(`   ✅ Total de eventos azules encontrados: ${availableSpots.length}`);
      console.log(`   ⚠️  IMPORTANTE: Solo estos eventos azules se convertirán en slots disponibles`);
      console.log(`   ⚠️  Si ves un slot de 5:30 PM, debe haber un evento azul a esa hora en Google Calendar`);
    } else {
      console.log(`   ⚠️  NO se encontraron spots disponibles (eventos azules de 90 min) en el calendario "Innovia CDMX" para ${date}`);
      console.log(`   ⚠️  Si no hay eventos azules, NO se mostrarán slots (retornará array vacío)`);
    }

    // Convertir eventos azules directamente a slots disponibles
    // Cada evento azul es un spot disponible
    let slots = availableSpots.map(spot => {
      // CRITICAL: Calcular timestamp ANTES de formatear para asegurar consistencia
      const startTimestamp = spot.start.getTime();
      
      // Verificar que el timestamp es válido
      if (isNaN(startTimestamp)) {
        console.error(`   ❌ ERROR: Timestamp inválido para evento ${spot.id}`);
        console.error(`      start: ${spot.start}, timestamp: ${startTimestamp}`);
      }
      
      const startTimeCDMX = spot.start.toLocaleTimeString('es-MX', { 
        timeZone: 'America/Mexico_City', 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: true 
      });
      
      // CRITICAL: Crear string ISO con offset de CDMX en lugar de toISOString() que convierte a UTC
      // Esto evita que la fecha se desplace un día cuando el servidor está en UTC
      const formatISOWithCDMXOffset = (date) => {
        // Obtener componentes de la fecha en CDMX usando toLocaleString
        const year = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' });
        const month = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', month: '2-digit' });
        const day = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', day: '2-digit' });
        const hours = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', hour: '2-digit', hour12: false });
        const minutes = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', minute: '2-digit' });
        const seconds = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', second: '2-digit' });
        
        // Asegurar que todos los valores tengan padding de ceros (2 dígitos)
        const yearPadded = String(year).padStart(4, '0');
        const monthPadded = String(month).padStart(2, '0');
        const dayPadded = String(day).padStart(2, '0');
        const hoursPadded = String(hours).padStart(2, '0');
        const minutesPadded = String(minutes).padStart(2, '0');
        const secondsPadded = String(seconds).padStart(2, '0');
        
        // Calcular offset de CDMX para esta fecha
        const testDateUTC = new Date(Date.UTC(parseInt(yearPadded), parseInt(monthPadded) - 1, parseInt(dayPadded), 12, 0, 0));
        const cdmxHour = parseInt(testDateUTC.toLocaleString('en-US', { 
          timeZone: 'America/Mexico_City',
          hour: '2-digit',
          hour12: false
        }));
        const offsetHours = cdmxHour - 12; // Cambiar a cdmxHour - 12 para obtener offset negativo
        const offsetStr = offsetHours >= 0 
          ? `+${String(Math.abs(offsetHours)).padStart(2, '0')}:00` 
          : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
        
        return `${yearPadded}-${monthPadded}-${dayPadded}T${hoursPadded}:${minutesPadded}:${secondsPadded}${offsetStr}`;
      };
      
      const startISO = formatISOWithCDMXOffset(spot.start);
      const endISO = formatISOWithCDMXOffset(spot.end);
      
      const slot = {
        time: startTimeCDMX,
        start: startISO, // Usar ISO con offset de CDMX, no UTC
        end: endISO, // Usar ISO con offset de CDMX, no UTC
        availableSpots: 1, // Cada evento azul es 1 spot disponible
        totalSpots: 1,
        eventId: spot.id, // Guardar el ID del evento azul para poder eliminarlo después
        startTimestamp: startTimestamp // Guardar timestamp para ordenamiento (CRITICAL)
      };
      
      // Log para diagnóstico
      const time24h = spot.start.toLocaleTimeString('en-US', {timeZone: 'America/Mexico_City', hour12: false});
      console.log(`      📌 Slot creado: ${startTimeCDMX} (${time24h}) - timestamp: ${startTimestamp} - eventId: ${spot.id}`);
      console.log(`      📌 Slot ISO: ${startISO} (NO usando toISOString() que convierte a UTC)`);
      
      return slot;
    });
    
    // Eliminar duplicados: si hay múltiples slots con la misma hora o el mismo eventId
    const seenEventIds = new Set();
    const seenTimes = new Set();
    slots = slots.filter(slot => {
      // Eliminar si ya vimos este eventId
      if (seenEventIds.has(slot.eventId)) {
        console.log(`   ⏭️  Eliminando slot duplicado por eventId: ${slot.time} [${slot.eventId}]`);
        return false;
      }
      // Eliminar si ya vimos esta hora exacta (mismo horario)
      if (seenTimes.has(slot.time)) {
        console.log(`   ⏭️  Eliminando slot duplicado por hora: ${slot.time} [${slot.eventId}]`);
        return false;
      }
      seenEventIds.add(slot.eventId);
      seenTimes.add(slot.time);
      return true;
    });
    
    // Ordenar slots cronológicamente por hora de inicio (más temprano primero)
    // IMPORTANTE: Ordenar ANTES de cualquier otra operación para asegurar orden correcto
    console.log(`   🔄 Ordenando ${slots.length} slots cronológicamente...`);
    
    // Log ANTES de ordenar
    console.log(`   📋 Slots ANTES de ordenar:`);
    slots.forEach((slot, idx) => {
      const timestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
      const time24h = slot.start ? new Date(slot.start).toLocaleTimeString('en-US', {timeZone: 'America/Mexico_City', hour12: false}) : 'N/A';
      console.log(`      ${idx + 1}. ${slot.time} (${time24h}) - timestamp: ${timestamp} - eventId: ${slot.eventId}`);
    });
    
    slots.sort((a, b) => {
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
        console.error(`   ❌ ERROR: Timestamp inválido en ordenamiento - a: ${timeA}, b: ${timeB}`);
        console.error(`      Slot A: ${a.time} (${a.start}) - startTimestamp: ${a.startTimestamp}`);
        console.error(`      Slot B: ${b.time} (${b.start}) - startTimestamp: ${b.startTimestamp}`);
      }
      
      // Orden ascendente: más temprano primero (timeA - timeB)
      const result = timeA - timeB;
      return result;
    });
    
    // Log DESPUÉS de ordenar
    console.log(`   📋 Slots DESPUÉS de ordenar:`);
    slots.forEach((slot, idx) => {
      const timestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
      const time24h = slot.start ? new Date(slot.start).toLocaleTimeString('en-US', {timeZone: 'America/Mexico_City', hour12: false}) : 'N/A';
      console.log(`      ${idx + 1}. ${slot.time} (${time24h}) - timestamp: ${timestamp} - eventId: ${slot.eventId}`);
    });
    
    // Verificar que el ordenamiento funcionó
    const isOrdered = slots.every((slot, index) => {
      if (index === 0) return true;
      const prevTimestamp = slots[index - 1].startTimestamp || 
                           (slots[index - 1].start ? new Date(slots[index - 1].start).getTime() : 0);
      const currTimestamp = slot.startTimestamp || (slot.start ? new Date(slot.start).getTime() : 0);
      return currTimestamp >= prevTimestamp;
    });
    
    if (!isOrdered) {
      console.error(`   ❌ ERROR CRÍTICO: Los slots NO están ordenados cronológicamente después del sort!`);
    } else {
      console.log(`   ✅ Ordenamiento verificado: Los slots están en orden cronológico correcto`);
    }
    
    console.log(`   📊 Slots procesados: ${slots.length} (después de eliminar duplicados y ordenar)`);
    if (slots.length > 0) {
      const orderedTimes = slots.map(s => {
        const timestamp = s.startTimestamp || new Date(s.start).getTime();
        const time24h = new Date(s.start).toLocaleTimeString('en-US', {timeZone: 'America/Mexico_City', hour12: false});
        return `${s.time} (${time24h}, ts:${timestamp}, eventId:${s.eventId})`;
      });
      console.log(`   📅 Orden cronológico verificado: ${orderedTimes.join(' → ')}`);
      console.log(`   ⚠️  IMPORTANTE: Estos slots provienen SOLO de eventos azules en el calendario "Innovia CDMX"`);
      console.log(`   ⚠️  Si ves un slot que no debería estar, verifica que NO haya un evento azul a esa hora en Google Calendar`);
    } else {
      console.log(`   ⚠️  NO se encontraron slots disponibles - retornando array vacío (NO usando getDefaultSlots)`);
    }

    // Filtrar slots que están en domingo después de las 5:00 PM
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay();
    const isSunday = dayOfWeek === 0;

    if (isSunday) {
      console.log(`   📅 Es domingo - filtrando slots después de las 5:00 PM`);
      let filteredSlots = slots.filter(slot => {
        const slotDate = new Date(slot.start);
        const slotHour = slotDate.toLocaleTimeString('en-US', {
          timeZone: 'America/Mexico_City',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        const hour = parseInt(slotHour.split(':')[0]);
        // Excluir slots después de las 5:00 PM (17:00)
        const isAfter5PM = hour >= 17;
        if (isAfter5PM) {
          console.log(`      ⏭️  Excluyendo slot ${slot.time} (después de 5:00 PM en domingo)`);
        }
        return !isAfter5PM;
      });
      
      // Eliminar duplicados adicionales después del filtro de domingo
      const seenEventIds = new Set();
      const seenTimestamps = new Set();
      filteredSlots = filteredSlots.filter(slot => {
        const timestamp = slot.startTimestamp || new Date(slot.start).getTime();
        if (seenEventIds.has(slot.eventId) || seenTimestamps.has(timestamp)) {
          console.log(`      ⏭️  Eliminando slot duplicado en filtro de domingo: ${slot.time} [${slot.eventId}]`);
          return false;
        }
        seenEventIds.add(slot.eventId);
        seenTimestamps.add(timestamp);
        return true;
      });
      
      // Asegurar que los slots filtrados también estén ordenados cronológicamente
      filteredSlots.sort((a, b) => {
        const timeA = a.startTimestamp || new Date(a.start).getTime();
        const timeB = b.startTimestamp || new Date(b.start).getTime();
        return timeA - timeB;
      });
      
      console.log(`   📅 Slots disponibles en domingo: ${filteredSlots.length} (de ${slots.length} totales, después de eliminar duplicados y ordenar)`);
      if (filteredSlots.length > 0) {
        console.log(`   📅 Orden cronológico (domingo): ${filteredSlots.map(s => s.time).join(' → ')}`);
      }
      return filteredSlots;
    }

    console.log(`   📊 Total bloques disponibles: ${slots.length}`);
    
    // CRITICAL: Si no hay bloques disponibles, retornar array vacío
    // NO usar getDefaultSlots aquí porque eso mostraría slots que no respetan la regla de máximo 2 citas
    // getDefaultSlots solo debe usarse cuando NO se puede consultar Google Calendar (fallback por error de conexión)
    if (slots.length === 0) {
      console.warn('   ⚠️  No hay bloques disponibles (todos los bloques tienen 2 citas o más)');
      console.warn('   ⚠️  Retornando array vacío - el usuario debe elegir otra fecha');
      return [];
    }
    
    return slots;
  } catch (error) {
    console.error('❌ Error al consultar Google Calendar:', error.message);
    console.error('   Stack:', error.stack);
    console.error('   ⚠️  ERROR CRÍTICO: No se puede consultar Google Calendar');
    console.error('   ⚠️  El bot SOLO usa eventos azules del calendario "Innovia CDMX"');
    console.error('   ⚠️  NO se usará fallback a slots por defecto');
    console.error('   ⚠️  Retornando array vacío - el usuario debe elegir otra fecha o verificar la conexión');
    return [];
  }
}

/**
 * Verifica si un slot específico aún está disponible antes de crear la cita
 * Esto previene que se agenden más de MAX_CITAS_POR_BLOQUE citas en el mismo bloque
 * @param {string} slotStart - Start time of the slot in ISO format (e.g., "2026-03-18T11:00:00.000Z")
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID to check
 * @param {string} excludeEventId - Event ID to exclude from count (optional, for rescheduling)
 * @returns {Promise<{available: boolean, currentCount: number, maxCount: number}>}
 */
async function isSlotAvailable(slotStart, calendarClient, authClient, calendarId, excludeEventId = null) {
  try {
    const MAX_CITAS_POR_BLOQUE = 2;
    
    if (!authClient) {
      console.warn('⚠️  Google Auth no inicializado, asumiendo slot disponible');
      return { available: true, currentCount: 0, maxCount: MAX_CITAS_POR_BLOQUE };
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    // Parsear la fecha/hora del slot
    const slotDate = new Date(slotStart);
    const year = slotDate.getFullYear();
    const month = slotDate.getMonth() + 1;
    const day = slotDate.getDate();
    const hour = slotDate.getHours();
    const minute = slotDate.getMinutes();

    // Calcular el bloque de 90 minutos
    const blockStart = new Date(year, month - 1, day, hour, minute, 0);
    const blockEnd = new Date(blockStart.getTime() + 90 * 60 * 1000); // 90 minutos después

    // Obtener eventos del día
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59);

    const events = await calendarClient.events.list({
      auth: auth,
      calendarId: calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Mexico_City'
    });

    const eventItems = events.data.items || [];

    // Contar citas en este bloque específico
    let citasEnBloque = 0;
    
    eventItems.forEach(e => {
      // Excluir el evento que se está moviendo (si es rescheduling)
      if (excludeEventId && e.id === excludeEventId) {
        return;
      }

      let bookedStart, bookedEnd;
      
      if (e.start.dateTime) {
        bookedStart = new Date(e.start.dateTime);
        bookedEnd = new Date(e.end.dateTime);
      } else if (e.start.date) {
        bookedStart = new Date(e.start.date + 'T00:00:00');
        bookedEnd = new Date(e.end.date + 'T23:59:59');
      } else {
        return;
      }

      // Verificar si se solapa con el bloque
      const overlaps = bookedStart < blockEnd && bookedEnd > blockStart;
      
      if (overlaps) {
        citasEnBloque++;
        console.log(`   📌 Verificación de disponibilidad: Cita encontrada en bloque (${hour}:${String(minute).padStart(2, '0')}): ${e.summary || 'Sin título'}`);
      }
    });

    const available = citasEnBloque < MAX_CITAS_POR_BLOQUE;
    
    console.log(`   🔍 Verificación de slot ${hour}:${String(minute).padStart(2, '0')}: ${citasEnBloque}/${MAX_CITAS_POR_BLOQUE} citas - ${available ? '✅ DISPONIBLE' : '❌ LLENO'}`);

    return {
      available,
      currentCount: citasEnBloque,
      maxCount: MAX_CITAS_POR_BLOQUE
    };
  } catch (error) {
    console.error('❌ Error verificando disponibilidad del slot:', error.message);
    // En caso de error, asumir disponible para no bloquear el proceso
    return { available: true, currentCount: 0, maxCount: 2 };
  }
}

/**
 * Create calendar event in Google Calendar
 * @param {string} name - Client's full name
 * @param {string} phone - Client's phone number
 * @param {string} email - Client's email (optional)
 * @param {string} dateStart - Start date/time in ISO format
 * @param {string} fechaBoda - Wedding date (optional, for description)
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID to create event in
 * @returns {Promise<Object|null>} Created event object or null
 */
async function createCalendarEvent(name, phone, email, dateStart, fechaBoda, calendarClient, authClient, calendarId) {
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
    // CRITICAL: dateStart viene como ISO string que representa una hora en CDMX
    // El problema: si el servidor está en UTC, new Date() interpretará la hora como UTC
    // Solución: extraer componentes y crear un string ISO con el offset de CDMX correcto
    let startDate;
    
    console.log(`   📅 [createCalendarEvent] dateStart recibido: ${dateStart}`);
    
    if (typeof dateStart === 'string' && dateStart.includes('T')) {
      // Verificar si ya tiene un offset (Z o +/-HH:MM)
      const hasOffset = dateStart.endsWith('Z') || dateStart.match(/[+-]\d{2}:\d{2}$/);
      
      if (hasOffset) {
        // Si ya tiene offset, parsearlo directamente
        // Pero verificar que el offset sea correcto para CDMX
        console.log(`   📅 [createCalendarEvent] dateStart ya tiene offset, parseando directamente`);
        startDate = new Date(dateStart);
        
        // Verificar que la fecha se parseó correctamente
        if (isNaN(startDate.getTime())) {
          throw new Error(`No se pudo parsear dateStart con offset: ${dateStart}`);
        }
        
        // Verificar que la hora en CDMX sea la esperada
        const cdmxTime = startDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true });
        console.log(`   📅 [createCalendarEvent] Fecha parseada (ya tenía offset):`);
        console.log(`      Input: ${dateStart}`);
        console.log(`      Fecha final: ${startDate.toISOString()}`);
        console.log(`      Hora en CDMX: ${cdmxTime}`);
      } else {
        // No tiene offset, extraer componentes y agregar offset de CDMX
        const dateMatch = dateStart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (dateMatch) {
          const [, year, month, day, hour, minute, second] = dateMatch.map(Number);
          
          // CRITICAL: Crear un string ISO con el offset de CDMX correcto
          const getCDMXOffset = (y, m, d) => {
            const testDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
            const cdmxHour = parseInt(testDate.toLocaleString('en-US', { 
              timeZone: 'America/Mexico_City',
              hour: '2-digit',
              hour12: false
            }));
            const offsetHours = 12 - cdmxHour;
            return offsetHours;
          };
          
          const offsetHours = getCDMXOffset(year, month, day);
          const offsetStr = offsetHours >= 0 
            ? `+${String(Math.abs(offsetHours)).padStart(2, '0')}:00` 
            : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
          
          const isoString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offsetStr}`;
          
          startDate = new Date(isoString);
          
          console.log(`   📅 [createCalendarEvent] Fecha parseada (sin offset, agregado):`);
          console.log(`      Input: ${dateStart}`);
          console.log(`      Componentes extraídos: ${year}-${month}-${day} ${hour}:${minute}`);
          console.log(`      Offset calculado: ${offsetHours} horas`);
          console.log(`      ISO string creado: ${isoString}`);
          console.log(`      Fecha final: ${startDate.toISOString()}`);
          console.log(`      Hora en CDMX: ${startDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true })}`);
        } else {
          // Si no podemos parsear, intentar parsear directamente
          console.warn(`   ⚠️  No se pudo parsear dateStart con regex, usando new Date() directamente`);
          startDate = new Date(dateStart);
        }
      }
    } else {
      startDate = new Date(dateStart);
    }
    
    // Verificar que la fecha se parseó correctamente
    if (isNaN(startDate.getTime())) {
      console.error(`   ❌ ERROR: No se pudo parsear dateStart: ${dateStart}`);
      throw new Error(`Fecha inválida: ${dateStart}`);
    }
    
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
    } else {
      description += `FECHA DE BODA: No definido por el cliente\n`;
    }
    description += `TELEFONO: ${formatPhone(phone)}\n`;
    if (email) {
      description += `EMAIL: ${email}\n`;
    }
    description += '\n*Cita creada por Calendar bot*';
    
    // Formatear fecha/hora en formato RFC3339 para CDMX
    // CRITICAL: Usar toLocaleString para obtener componentes en CDMX, no métodos locales del servidor
    const formatDateTimeForCDMX = (date) => {
      try {
        // Verificar que la fecha es válida
        if (isNaN(date.getTime())) {
          throw new Error(`Fecha inválida en formatDateTimeForCDMX: ${date}`);
        }
        
        // Obtener componentes de la fecha en CDMX usando toLocaleString
        // Esto asegura que la fecha/hora sea correcta independientemente de la zona horaria del servidor
        const year = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' });
        const month = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', month: '2-digit' });
        const day = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', day: '2-digit' });
        const hours = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', hour: '2-digit', hour12: false });
        const minutes = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', minute: '2-digit' });
        const seconds = date.toLocaleString('en-US', { timeZone: 'America/Mexico_City', second: '2-digit' });
        
        // Asegurar que todos los componentes tengan 2 dígitos
        const monthPadded = String(month).padStart(2, '0');
        const dayPadded = String(day).padStart(2, '0');
        const hoursPadded = String(hours).padStart(2, '0');
        const minutesPadded = String(minutes).padStart(2, '0');
        const secondsPadded = String(seconds).padStart(2, '0');
        
        // Formato: YYYY-MM-DDTHH:MM:SS (sin Z, para que Google Calendar lo interprete con timeZone)
        const result = `${year}-${monthPadded}-${dayPadded}T${hoursPadded}:${minutesPadded}:${secondsPadded}`;
        
        console.log(`   📅 [formatDateTimeForCDMX] Formateando fecha: ${date.toISOString()} -> ${result}`);
        
        return result;
      } catch (error) {
        console.error(`   ❌ ERROR en formatDateTimeForCDMX:`, error.message);
        throw error;
      }
    };
    
    const startDateTime = formatDateTimeForCDMX(startDate);
    const endDateTime = formatDateTimeForCDMX(endDate);
    
    console.log(`   🕐 Hora de inicio (CDMX): ${startDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true })}`);
    console.log(`   🕐 Hora de fin (CDMX): ${endDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: true })}`);
    console.log(`   🕐 DateTime string enviado: ${startDateTime} (timeZone: America/Mexico_City)`);
    
    const event = {
      summary: eventSummary,
      description: description,
      start: {
        dateTime: startDateTime,
        timeZone: 'America/Mexico_City'
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'America/Mexico_City'
      },
      attendees: email ? [{ email: email }] : []
    };

    console.log(`   📅 ============================================`);
    console.log(`   📅 CREANDO EVENTO EN GOOGLE CALENDAR`);
    console.log(`   📅 ============================================`);
    console.log(`   📅 Calendario ID: ${calendarId}`);
    
    // Obtener información del calendario para verificar
    try {
      const calendarInfo = await calendarClient.calendars.get({
        auth: auth,
        calendarId: calendarId
      });
      const calendarName = calendarInfo.data.summary || 'Sin nombre';
      console.log(`   📅 Nombre del calendario: "${calendarName}"`);
      console.log(`   📅 Email del calendario: ${calendarInfo.data.id || 'N/A'}`);
    } catch (calError) {
      console.warn(`   ⚠️  No se pudo obtener información del calendario: ${calError.message}`);
    }
    
    console.log(`   📝 Título del evento: ${eventSummary}`);
    console.log(`   🕐 Inicio: ${startDate.toLocaleString('es-MX')}`);
    console.log(`   🕐 Fin: ${endDate.toLocaleString('es-MX')}`);
    console.log(`   📅 ============================================`);
    
    const createdEvent = await calendarClient.events.insert({
      auth: auth,
      calendarId: calendarId,
      resource: event
    });

    if (createdEvent && createdEvent.data) {
      console.log(`   ✅ ============================================`);
      console.log(`   ✅ EVENTO CREADO EXITOSAMENTE`);
      console.log(`   ✅ ============================================`);
      console.log(`   ✅ ID del evento: ${createdEvent.data.id}`);
      console.log(`   ✅ Link: ${createdEvent.data.htmlLink || 'N/A'}`);
      console.log(`   ✅ Calendario: ${calendarId}`);
      console.log(`   ✅ Título: ${createdEvent.data.summary}`);
      console.log(`   ✅ Inicio: ${createdEvent.data.start?.dateTime || createdEvent.data.start?.date}`);
      console.log(`   ✅ ============================================`);
      return createdEvent.data;
    }

    console.error(`   ❌ ERROR: createdEvent.data es null o undefined`);
    console.error(`   📅 createdEvent completo:`, JSON.stringify(createdEvent, null, 2));
    return null;
  } catch (error) {
    console.error('❌ Error creando evento en Google Calendar:', error.message);
    console.error('   Stack:', error.stack);
    console.error('   Error completo:', error);
    
    // Si es un error de la API de Google, mostrar más detalles
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
    }
    
    return null;
  }
}

/**
 * Update an existing calendar event
 * @param {string} eventId - ID of the event to update
 * @param {string} name - Client's full name
 * @param {string} phone - Client's phone number
 * @param {string} email - Client's email (optional)
 * @param {string} dateStart - New start date/time in ISO format
 * @param {string} fechaBoda - Wedding date (optional, for description)
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID where the event exists
 * @returns {Promise<Object|null>} Updated event object or null
 */
async function updateCalendarEvent(eventId, name, phone, email, dateStart, fechaBoda, calendarClient, authClient, calendarId) {
  try {
    if (!authClient || !eventId) {
      console.warn('⚠️  Google Auth no inicializado o eventId faltante, no se puede actualizar evento');
      return null;
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }
    
    // Calcular fecha de fin: siempre 90 minutos después del inicio
    // IMPORTANTE: dateStart viene como ISO string (puede estar en UTC)
    // Necesitamos interpretarlo como hora local de CDMX
    let startDate;
    if (typeof dateStart === 'string' && dateStart.includes('T')) {
      // Si viene como ISO string, parsearlo y tratarlo como hora local de CDMX
      const dateMatch = dateStart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      if (dateMatch) {
        const [, year, month, day, hour, minute, second] = dateMatch.map(Number);
        // Crear fecha en zona horaria local de CDMX (no UTC)
        startDate = new Date(year, month - 1, day, hour, minute, second || 0);
      } else {
        startDate = new Date(dateStart);
      }
    } else {
      startDate = new Date(dateStart);
    }
    
    const endDate = new Date(startDate.getTime() + 90 * 60 * 1000); // 90 minutos
    
    // Formatear teléfono
    const formatPhone = (phoneNum) => {
      const cleaned = phoneNum.replace(/\D/g, '');
      if (cleaned.length >= 10) {
        const last10 = cleaned.slice(-10);
        return `${last10.slice(0, 2)} ${last10.slice(2, 5)} ${last10.slice(5)}`;
      }
      return cleaned;
    };
    
    // Formatear fecha de boda
    const formatFechaBoda = (fecha) => {
      if (!fecha) return 'No especificada';
      try {
        if (fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [year, month, day] = fecha.split('-');
          return `${day}/${month}/${year}`;
        }
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
    
    // Descripción
    let description = '';
    if (fechaBoda) {
      description += `FECHA DE BODA: ${formatFechaBoda(fechaBoda)}\n`;
    } else {
      description += `FECHA DE BODA: No definido por el cliente\n`;
    }
    description += `TELEFONO: ${formatPhone(phone)}\n`;
    if (email) {
      description += `EMAIL: ${email}\n`;
    }
    description += '\n*Cita reagendada por Calendar bot*';
    
    // Formatear fecha/hora en formato RFC3339 para CDMX
    const formatDateTimeForCDMX = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
    };
    
    const startDateTime = formatDateTimeForCDMX(startDate);
    const endDateTime = formatDateTimeForCDMX(endDate);
    
    const event = {
      summary: eventSummary,
      description: description,
      start: {
        dateTime: startDateTime,
        timeZone: 'America/Mexico_City'
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'America/Mexico_City'
      },
      attendees: email ? [{ email: email }] : []
    };

    console.log(`   📅 Actualizando evento ${eventId} en calendario ID: ${calendarId}`);
    console.log(`   📝 Nuevo título: ${eventSummary}`);
    console.log(`   🕐 Nuevo inicio: ${startDate.toLocaleString('es-MX')}`);
    
    const updatedEvent = await calendarClient.events.update({
      auth: auth,
      calendarId: calendarId,
      eventId: eventId,
      resource: event
    });

    if (updatedEvent && updatedEvent.data) {
      console.log(`✅ Evento actualizado exitosamente en Google Calendar`);
      console.log(`   ID: ${updatedEvent.data.id}`);
      console.log(`   Link: ${updatedEvent.data.htmlLink || 'N/A'}`);
      return updatedEvent.data;
    }

    return null;
  } catch (error) {
    console.error('❌ Error actualizando evento en Google Calendar:', error.message);
    console.error('   Stack:', error.stack);
    return null;
  }
}

/**
 * Delete a calendar event
 * @param {string} eventId - ID of the event to delete
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID where the event exists
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteCalendarEvent(eventId, calendarClient, authClient, calendarId) {
  try {
    if (!authClient || !eventId) {
      console.warn('⚠️  Google Auth no inicializado o eventId faltante, no se puede eliminar evento');
      return false;
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    console.log(`   🗑️  Eliminando evento ${eventId} del calendario ${calendarId}`);
    
    await calendarClient.events.delete({
      auth: auth,
      calendarId: calendarId,
      eventId: eventId
    });

    console.log(`✅ Evento eliminado exitosamente del Google Calendar`);
    return true;
  } catch (error) {
    console.error('❌ Error eliminando evento del Google Calendar:', error.message);
    console.error('   Stack:', error.stack);
    return false;
  }
}

/**
 * Find calendar events by client name
 * @param {string} clientName - Client's name to search for
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID to search in
 * @param {number} maxResults - Maximum number of results to return (default: 10)
 * @returns {Promise<Array>} Array of event objects matching the name
 */
async function findEventsByName(clientName, calendarClient, authClient, calendarId, maxResults = 10) {
  try {
    if (!authClient || !clientName) {
      console.warn('⚠️  Google Auth no inicializado o nombre faltante, no se puede buscar eventos');
      return [];
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    // Helper: normalize a string for accent-insensitive comparison
    // "Rosalía Solís" → "rosalia solis", "ROSALÍA" → "rosalia"
    const normalize = str =>
      str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    const normalizedQuery = normalize(clientName);
    console.log(`🔍 Buscando eventos con nombre: "${clientName}" (normalizado: "${normalizedQuery}") en calendario ${calendarId}`);

    // Search for events in the next 6 months
    const now = new Date();
    const sixMonthsLater = new Date(now.getTime() + 6 * 30 * 24 * 60 * 60 * 1000);

    // Use the accent-stripped version as the Google query so it hits more results
    const events = await calendarClient.events.list({
      auth: auth,
      calendarId: calendarId,
      timeMin: now.toISOString(),
      timeMax: sixMonthsLater.toISOString(),
      maxResults: maxResults,
      singleEvents: true,
      orderBy: 'startTime',
      q: normalizedQuery, // accent-normalized query improves Google full-text matching
      timeZone: 'America/Mexico_City'
    });

    const eventItems = events.data.items || [];

    // Filter events that match the name in summary (title) — accent-insensitive
    const matchingEvents = eventItems.filter(event => {
      const summaryNorm = normalize(event.summary || '');
      // Check if the normalized name appears in the normalized event title
      return summaryNorm.includes(normalizedQuery) || normalizedQuery.includes(summaryNorm);
    });

    console.log(`   Eventos encontrados: ${matchingEvents.length}`);
    
    return matchingEvents.map(event => {
      // Parse start and end dates - IMPORTANTE: interpretar como hora de CDMX
      let startDate, endDate;
      
      if (event.start.dateTime) {
        // Parsear directamente con new Date() - JavaScript manejará el timezone offset correctamente
        // Luego usaremos toLocaleTimeString con timeZone para formatear en CDMX
        startDate = new Date(event.start.dateTime);
      } else {
        startDate = new Date(event.start.date + 'T00:00:00');
      }
      
      if (event.end.dateTime) {
        // Parsear directamente con new Date() - JavaScript manejará el timezone offset correctamente
        endDate = new Date(event.end.dateTime);
      } else {
        endDate = new Date(event.end.date + 'T23:59:59');
      }
      
      // Use centralized date formatter
      const { formatDateCDMX } = require('./utils/date-formatter');
      const formatDate = formatDateCDMX;
      
      // Use centralized date formatter
      const { formatTimeCDMX } = require('./utils/date-formatter');
      const formatTime = formatTimeCDMX;
      
      return {
        id: event.id,
        summary: event.summary,
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        startDate: startDate,
        endDate: endDate,
        formattedDate: formatDate(startDate),
        formattedTime: formatTime(startDate),
        description: event.description || '',
        htmlLink: event.htmlLink || ''
      };
    });
  } catch (error) {
    console.error('❌ Error buscando eventos por nombre:', error.message);
    console.error('   Stack:', error.stack);
    return [];
  }
}

/**
 * Restore a blue event (90-minute untitled event) in the Innovia CDMX calendar
 * This is used when an appointment is cancelled or moved to restore the available slot
 * @param {string} dateStart - Start date/time in ISO format
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID (Innovia CDMX calendar)
 * @returns {Promise<Object|null>} Created event object or null
 */
async function restoreBlueEvent(dateStart, calendarClient, authClient, calendarId) {
  try {
    console.log(`🔄 [restoreBlueEvent] Iniciando restauración de evento azul...`);
    console.log(`   dateStart recibido: ${dateStart}`);
    console.log(`   calendarId: ${calendarId}`);
    
    if (!authClient || !calendarId) {
      console.warn('⚠️  Google Auth no inicializado o calendarId faltante, no se puede restaurar evento azul');
      return null;
    }

    // Obtener cliente de autenticación
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }
    
    // Parse dateStart to get start and end times
    let startDate;
    if (typeof dateStart === 'string' && dateStart.includes('T')) {
      const hasOffset = dateStart.endsWith('Z') || dateStart.match(/[+-]\d{2}:\d{2}$/);
      if (hasOffset) {
        startDate = new Date(dateStart);
      } else {
        // No tiene offset, extraer componentes y agregar offset de CDMX
        const dateMatch = dateStart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (dateMatch) {
          const [, year, month, day, hour, minute, second] = dateMatch.map(Number);
          
          // Calcular el offset de CDMX para esta fecha específica
          const getCDMXOffset = (y, m, d) => {
            const testDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
            const cdmxHour = parseInt(testDate.toLocaleString('en-US', { 
              timeZone: 'America/Mexico_City',
              hour: '2-digit',
              hour12: false
            }));
            const offsetHours = cdmxHour - 12;
            return offsetHours;
          };
          
          const offsetHours = getCDMXOffset(year, month, day);
          const offsetStr = offsetHours >= 0 
            ? `+${String(Math.abs(offsetHours)).padStart(2, '0')}:00` 
            : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
          
          const isoString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second || 0).padStart(2, '0')}${offsetStr}`;
          startDate = new Date(isoString);
        } else {
          startDate = new Date(dateStart);
        }
      }
    } else {
      startDate = new Date(dateStart);
    }
    
    // Verificar que la fecha se parseó correctamente
    if (isNaN(startDate.getTime())) {
      console.error(`   ❌ ERROR: No se pudo parsear dateStart: ${dateStart}`);
      console.error(`   ❌ startDate resultante: ${startDate}`);
      return null;
    }
    
    console.log(`   ✅ Fecha parseada correctamente: ${startDate.toISOString()}`);
    console.log(`   ✅ Fecha en CDMX: ${startDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`);
    
    // End date is 90 minutes after start
    const endDate = new Date(startDate.getTime() + 90 * 60 * 1000);
    console.log(`   ✅ Fecha fin calculada: ${endDate.toISOString()}`);
    console.log(`   ✅ Fecha fin en CDMX: ${endDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`);
    
    // Create event without title (blue event) - 90 minutes duration
    const event = {
      summary: '', // Sin título = evento azul
      description: '', // Sin descripción
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'America/Mexico_City'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'America/Mexico_City'
      }
    };
    
    console.log(`🔄 Restaurando evento azul en calendario "Innovia CDMX"...`);
    console.log(`   Inicio: ${startDate.toISOString()} (${startDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })})`);
    console.log(`   Fin: ${endDate.toISOString()} (${endDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })})`);
    console.log(`   Duración: 90 minutos`);
    console.log(`   Calendario ID: ${calendarId}`);
    console.log(`   Evento a crear:`, JSON.stringify(event, null, 2));
    
    try {
      const createdEvent = await calendarClient.events.insert({
        auth: auth,
        calendarId: calendarId,
        resource: event
      });
      
      console.log(`✅ Evento azul restaurado exitosamente (ID: ${createdEvent.data.id})`);
      console.log(`   Link: ${createdEvent.data.htmlLink || 'N/A'}`);
      console.log(`   Summary: "${createdEvent.data.summary || '(Sin título)'}"`);
      console.log(`   Start: ${createdEvent.data.start.dateTime || createdEvent.data.start.date}`);
      console.log(`   End: ${createdEvent.data.end.dateTime || createdEvent.data.end.date}`);
      return createdEvent.data;
    } catch (insertError) {
      console.error(`❌ Error al insertar evento azul en Google Calendar:`, insertError.message);
      console.error(`   Stack:`, insertError.stack);
      console.error(`   Calendar ID usado: ${calendarId}`);
      console.error(`   Evento que se intentó crear:`, JSON.stringify(event, null, 2));
      throw insertError; // Re-lanzar para que el caller pueda manejarlo
    }
  } catch (error) {
    console.error('❌ Error restaurando evento azul:', error.message);
    return null;
  }
}

/**
 * Get a single calendar event by ID
 * @param {string} eventId - Event ID to fetch
 * @param {Object} calendarClient - Google Calendar API client
 * @param {Object} authClient - Google Auth client
 * @param {string} calendarId - Calendar ID where the event exists
 * @returns {Promise<Object|null>} Event data or null
 */
async function getCalendarEvent(eventId, calendarClient, authClient, calendarId) {
  try {
    if (!authClient || !eventId) return null;
    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }
    const response = await calendarClient.events.get({
      auth,
      calendarId,
      eventId
    });
    return response.data;
  } catch (error) {
    console.error('❌ Error obteniendo evento del calendario:', error.message);
    return null;
  }
}

/**
 * Search for a client's upcoming appointment by phone number.
 * Looks in the event description for "TELEFONO: <phone>" written by the bot or staff.
 * Falls back to name search if no phone match is found.
 *
 * @param {string} phone - Client phone (digits only or with country code)
 * @param {string|null} clientName - Optional: client name to fall back to
 * @param {Object} calendarClient
 * @param {Object} authClient
 * @param {string} calendarId - CITAS NUEVAS calendar ID
 * @returns {Promise<Object|null>} Event object or null
 */
async function findEventByPhone(phone, clientName, calendarClient, authClient, calendarId) {
  try {
    if (!authClient || !phone) return null;

    let auth;
    if (authClient && typeof authClient.getClient === 'function') {
      auth = await authClient.getClient();
    } else {
      auth = authClient;
    }

    const now = new Date();
    // Look 7 days in the past (appointment may have been set for today/yesterday)
    // and 6 months into the future
    const pastWindow = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const futureWindow = new Date(now.getTime() + 6 * 30 * 24 * 60 * 60 * 1000);

    // Normalize phone: strip non-digits
    // We use the last 4 digits for matching — avoids country-code and formatting
    // mismatches (e.g. WhatsApp "525521920710" vs Calendar "55 219 20710")
    const digitsOnly = phone.replace(/\D/g, '');
    const last4  = digitsOnly.slice(-4);
    const last10 = digitsOnly.slice(-10);

    // Attempt 1: fetch upcoming events and filter locally by last 4 phone digits.
    // We do NOT use the `q` (text search) parameter because the phone is stored
    // formatted with spaces ("55 219 20710") so a digit-only query ("5521920710")
    // won't match inside Google's full-text index.
    console.log(`🔍 findEventByPhone: buscando eventos y filtrando por últimos 4 dígitos "${last4}"`);
    const res = await calendarClient.events.list({
      auth,
      calendarId,
      timeMin: pastWindow.toISOString(),
      timeMax: futureWindow.toISOString(),
      maxResults: 50,          // wider net — we filter locally
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Mexico_City'
    });

    const items = res.data.items || [];
    // Strip all non-digits from each event description and check if it contains
    // the last 4 digits of the incoming phone (country-code agnostic).
    const match = items.find(ev => {
      const descDigits = (ev.description || '').replace(/\D/g, '');
      return descDigits.includes(last4);
    });

    if (match) {
      console.log(`✅ findEventByPhone: cita encontrada por últimos 4 dígitos del teléfono (ID: ${match.id})`);
      return formatEventResult(match);
    }

    // Attempt 2: fall back to name search if provided
    if (clientName) {
      console.log(`🔍 findEventByPhone: sin resultados por teléfono (last4="${last4}"), intentando por nombre "${clientName}"`);
      const byName = await findEventsByName(clientName, calendarClient, authClient, calendarId, 5);
      if (byName && byName.length > 0) {
        console.log(`✅ findEventByPhone: cita encontrada por nombre`);
        return byName[0]; // Most recent upcoming
      }
    }

    console.log(`⚠️  findEventByPhone: no se encontró ninguna cita para ${phone} (last8=${last8})`);
    return null;
  } catch (err) {
    console.error('❌ Error en findEventByPhone:', err.message);
    return null;
  }
}

/**
 * Format a Google Calendar event into a clean summary object.
 */
function formatEventResult(event) {
  const { formatDateCDMX, formatTimeCDMX } = require('./utils/date-formatter');
  const startRaw = event.start.dateTime || event.start.date;
  const startDate = event.start.dateTime
    ? new Date(event.start.dateTime)
    : new Date(event.start.date + 'T00:00:00');
  return {
    id: event.id,
    summary: event.summary,
    start: startRaw,
    startDate,
    formattedDate: formatDateCDMX(startDate),
    formattedTime: formatTimeCDMX(startDate),
    description: event.description || '',
  };
}

module.exports = {
  getAvailableSlots,
  isDayOpen,
  getDefaultSlots,
  isSlotAvailable,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventsByName,
  findEventByPhone,
  restoreBlueEvent,
  getCalendarEvent
};

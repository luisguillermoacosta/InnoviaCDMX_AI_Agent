# CLAUDE.md — Contexto del proyecto para Claude Code

Este archivo lo lee Claude Code automáticamente al iniciar. Da el contexto necesario
para mantener el bot. **Responde siempre en español.**

## Qué es este proyecto

Bot de WhatsApp para **Innovia CDMX** (estudio de novias) que agenda, reagenda y
cancela citas automáticamente. El canal de WhatsApp es **Meta (WhatsApp Cloud API)**.
Flujo general:

```
Cliente manda WhatsApp
  → el bot entiende el mensaje (OpenAI)
  → consulta/escribe en Google Calendar
  → responde por WhatsApp y agenda la cita
```

## Arquitectura (archivos que importan)

| Archivo | Qué hace |
|---------|----------|
| `whatsapp-calendar-bot.js` | Punto de entrada. Servidor web que recibe los mensajes de WhatsApp (webhook) y arranca todo. |
| `bot/agent.js` | El "cerebro". Decide qué herramienta usar (buscar horarios, confirmar, cancelar) según el mensaje. |
| `bot/calendar-service.js` | Toda la lógica de Google Calendar: disponibilidad, crear/borrar eventos. |
| `bot/classifier.js` | Clasifica la intención del mensaje del cliente. |
| `bot/handlers/` | Un archivo por tipo de conversación: `agendar.js`, `cancelar-cita.js`, `cambiar-cita.js`, `precios.js`, etc. |
| `business_config.json` | Configuración del negocio: horarios, precios, catálogo, FAQs, plantillas de respuesta, días festivos. **Aquí se cambian textos y reglas de negocio, no en el código.** |
| `bot/profile-extractor.js` | Extrae datos de la novia de la conversación. |
| `sessions.js` | Mantiene el estado de cada conversación. |

## Modelo de disponibilidad (IMPORTANTE — no romper)

La disponibilidad de horarios funciona con **"eventos azules"** en el calendario
"Innovia CDMX": un evento **sin nombre** = un cupo libre. Cuando se agenda una cita,
ese evento azul se borra.

- **Regla única:** un horario está libre si y solo si existe su evento azul.
- El mismo criterio se usa al **ofrecer** (`getAvailableSlots`) y al **confirmar**
  (`confirmar_cita` en `bot/agent.js`). **No introducir una segunda forma de medir
  disponibilidad** — eso ya causó un bug donde el bot ofrecía un horario y luego lo
  rechazaba. Si tocas esta lógica, mantén un solo criterio.

## Comandos

```bash
npm start        # corre el bot localmente
npm run dev      # corre con recarga automática (nodemon)
npm test         # simula conversaciones sin WhatsApp (test-bot.js)
node -c <archivo># verifica que un archivo no tenga errores de sintaxis
```

## Producción

- **Hosting:** Railway. El deploy es **automático**: al hacer `git push` a la rama
  `main`, Railway reconstruye y publica el bot solo.
- **Arranque:** definido en `Procfile` → `web: node whatsapp-calendar-bot.js`.
- **Variables de entorno / secretos:** NO están en el repo. Viven en `.env` (local) y
  en el panel de Railway (producción). Nunca subir `.env` ni claves al repo.

## Reglas para Claude al trabajar aquí

- Antes de dar un cambio por terminado, **verifica la sintaxis** (`node -c`) de los
  archivos tocados.
- Para cambios de **textos, precios, horarios o FAQs**, edita `business_config.json`,
  no el código JavaScript.
- No subas (`commit`/`push`) a menos que el usuario lo pida explícitamente.
- Mensajes de commit en español, claros y breves.
- Nunca expongas ni subas secretos (tokens, API keys, `.env`, `token.json`,
  `client_secret*.json`).
- Si un cambio toca el flujo de citas, recuerda al usuario probar antes de subir.

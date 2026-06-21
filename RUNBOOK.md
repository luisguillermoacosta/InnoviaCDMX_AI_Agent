# 📒 RUNBOOK — Mantenimiento del Bot de Citas (Innovia CDMX)

Guía para administrar el bot **sin saber programar**, usando **Claude Code**.
No necesitas escribir código: necesitas saber *describir bien los problemas*,
*verificar lo que Claude hace* y *seguir el flujo de git/deploy con confianza*.

---

## 0. Conceptos básicos (léelos una vez)

- **El bot vive en dos lugares:**
  1. **Tu computadora** (el código que editas con Claude Code).
  2. **Railway** (producción — donde el bot corre 24/7 y atiende a las clientas).
- **El puente entre ambos es GitHub.** Tú subes los cambios a GitHub (`git push`) y
  Railway los publica automáticamente.
- **Claude Code es tu copiloto.** Le hablas en español, él lee y edita el código.
- **Regla de oro:** si no entiendes lo que Claude propone, escríbele
  *"explícamelo como si no supiera programar"* antes de aceptar nada.

---

## 1. 🐞 Arreglar un bug (lo más común)

Ejemplo real: una clienta dice que el bot le ofreció un horario y luego le dijo que
ya estaba ocupado.

**Pasos:**
1. Abre Claude Code en la carpeta del proyecto.
2. Describe el problema **con el máximo detalle**. Mientras más contexto, mejor:
   - Qué pasó exactamente.
   - Pega capturas de la conversación de WhatsApp.
   - Si tienes captura del Google Calendar, pégala también.

   > ❌ Mal: *"el bot está fallando"*
   > ✅ Bien: *"una clienta eligió las 2pm, el bot dijo que ya estaba ocupado pero sí
   > había lugar. Aquí está la conversación [captura] y el calendario [captura].
   > ¿Cuál es el problema?"*
3. Deja que Claude diagnostique y proponga el arreglo.
4. **Pídele que lo pruebe** o que te explique cómo verificar que funciona.
5. Si te convence, dile: **"haz commit y push"** (ver sección 3).
6. Verifica en producción (ver sección 4).

**Si no estás seguro:** pídele a Claude *"explícame qué cambiaste y por qué"*.

---

## 2. ✏️ Cambiar textos, precios u horarios (sin tocar código)

Casi todo el contenido del negocio está en el archivo **`business_config.json`**:
horarios, precios, catálogo, FAQs, mensajes que envía el bot y días festivos.

Solo dile a Claude qué quieres, por ejemplo:
- *"Cambia el precio del paquete X a $Y en la configuración del negocio."*
- *"Agrega el 16 de septiembre como día festivo (cerrado)."*
- *"Cambia el mensaje de bienvenida por este texto: ..."*

Claude edita el archivo correcto. Luego: **commit y push** (sección 3).

---

## 3. 💾 Guardar y subir cambios (commit y push)

Cada vez que terminas un cambio que ya probaste:

1. Dile a Claude: **"haz commit y push"**.
2. Claude guarda el cambio (commit) y lo sube a GitHub (push).
3. **Railway detecta el push y publica el cambio automáticamente** en 1-3 minutos.

> 💡 *Commit* = guardar una "foto" del cambio. *Push* = enviarla a GitHub.
> Sin push, el cambio se queda solo en tu computadora y NO llega a las clientas.

---

## 4. 🚀 Verificar que el cambio llegó a producción (Railway)

1. Entra a [railway.app](https://railway.app) → tu proyecto.
2. En la pestaña **Deployments**, confirma que el último deploy diga **"Success"**
   (verde) y que la fecha coincida con tu push reciente.
3. Si quieres confirmar de verdad: manda tú mismo un WhatsApp al número del bot y
   verifica que responde bien.

Si el deploy aparece en **rojo / Failed**: ve a la sección 6.

---

## 5. 💳 Pagar las cuentas (servicios que mantienen vivo al bot)

El bot depende de varios servicios de paga. Si uno vence, el bot deja de funcionar
total o parcialmente. Revisa estos **mensualmente**:

| Servicio | Para qué sirve | Si no se paga... | Dónde |
|----------|----------------|------------------|-------|
| **Railway** | Hosting (el bot corre aquí 24/7) | El bot se apaga por completo | railway.app → Billing |
| **OpenAI** | El "cerebro" que entiende los mensajes | El bot deja de responder o da errores | platform.openai.com → Billing |
| **Meta (WhatsApp Cloud API)** | El canal de mensajes | No entran ni salen mensajes | business.facebook.com / developers.facebook.com |
| **Google Cloud** (si aplica) | Acceso al calendario | No puede agendar citas | console.cloud.google.com → Billing |

**Recomendación:** activa **pago automático con tarjeta** en cada uno y configura
**alertas de saldo/gasto** para no quedarte sin servicio por sorpresa.

> 💡 Tip: pon un recordatorio mensual fijo (ej. día 1 de cada mes) para revisar que
> todos los servicios estén al corriente.

---

## 6. 🆘 Emergencias: el bot no responde o algo se rompió

**Mantén la calma. Todo cambio se puede deshacer.**

### A) El bot no responde a las clientas
1. Revisa Railway → ¿el último deploy está en verde? Si está rojo, sigue al punto B.
2. Revisa que las cuentas estén pagadas (sección 5) — la causa #1 es saldo de OpenAI
   o Railway agotado.
3. Pídele ayuda a Claude: *"el bot no está respondiendo en producción, ¿cómo
   diagnostico el problema?"* — él te puede guiar a revisar los logs de Railway.

### B) Un cambio que subí rompió el bot (deshacer)
La forma más rápida y segura de volver a como estaba:
1. Dile a Claude: **"el último cambio rompió el bot, regrésame a la versión anterior
   que funcionaba (haz git revert del último commit) y súbelo"**.
2. Claude deshace el cambio y hace push → Railway vuelve a publicar la versión buena.
3. Verifica (sección 4).

> 🔒 Por qué no hay que tener miedo: GitHub guarda **todas** las versiones anteriores.
> Siempre puedes volver atrás. Nada es permanente.

### C) Revisar los logs (mensajes de error del bot)
En Railway → tu proyecto → pestaña **Logs/Observability**. Ahí se ven los errores en
vivo. Puedes copiar el error y pegárselo a Claude: *"el bot muestra este error, ¿qué
significa y cómo lo arreglo?"*

---

## 7. ✅ Buenas costumbres

- **Prueba antes de subir.** Sobre todo si el cambio toca el agendado de citas.
- **Un cambio a la vez.** Es más fácil saber qué falló si algo sale mal.
- **No subas secretos.** Nunca compartas ni subas el archivo `.env`, tokens o
  contraseñas. Si Claude te avisa de esto, hazle caso.
- **Cuando dudes, pregunta a Claude.** Está bien no saber; él explica.
- **Avisa antes de tocar producción en horario de atención** (por si algo se cae,
  que no sea cuando hay clientas activas).

---

*Última actualización: 21/06/2026. Mantén este documento al día si cambian los
servicios o el flujo de deploy.*

/**
 * Pending Tasks Store
 *
 * Manages escalation tasks with PostgreSQL persistence.
 * Uses in-memory array as runtime cache loaded from DB on startup.
 * Call init() once at server startup.
 */

const pool = require('../db');

const pendingTasks = [];
let nextId = 1;

const TZ = 'America/Mexico_City';

/** Load pending tasks from DB into memory. Call once before server starts. */
async function init() {
  try {
    const result = await pool.query(
      `SELECT id, phone, nombre, ultimo_mensaje, contexto, estado, created_at, resolved_at
       FROM pending_tasks ORDER BY id ASC`
    );
    for (const row of result.rows) {
      const createdAt = new Date(row.created_at);
      pendingTasks.push({
        id: row.id,
        fecha: createdAt.toLocaleDateString('es-MX', { timeZone: TZ }),
        hora: createdAt.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
        nombre: row.nombre || '',
        telefono: row.phone,
        ultimoMensaje: row.ultimo_mensaje,
        contexto: row.contexto,
        estado: row.estado,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at
      });
      if (row.id >= nextId) nextId = row.id + 1;
    }
    console.log(`📋 Tareas cargadas desde DB: ${result.rows.length}`);
  } catch (err) {
    console.error('⚠️  Error inicializando tareas desde DB:', err.message);
  }
}

/**
 * Log a pending task when a conversation is escalated to a human agent.
 */
async function logPendingTask({ phone, name, message, historial = [] }) {
  const now = new Date();

  const contexto = historial
    .slice(-4)
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content.substring(0, 80)}`)
    .join(' | ');

  const existing = pendingTasks.find(t => t.telefono === phone && t.estado === 'Pendiente');
  if (existing) {
    existing.ultimoMensaje = message;
    existing.contexto = contexto;
    existing.hora = now.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    existing.fecha = now.toLocaleDateString('es-MX', { timeZone: TZ });
    if (name) existing.nombre = name;
    pool.query(
      'UPDATE pending_tasks SET ultimo_mensaje=$1, contexto=$2, nombre=$3 WHERE id=$4',
      [message, contexto, name || existing.nombre, existing.id]
    ).catch(err => console.error('⚠️  Error actualizando tarea en DB:', err.message));
    console.log(`📋 Tarea pendiente #${existing.id} actualizada: ${name || phone} — "${message.substring(0, 50)}"`);
    return;
  }

  try {
    const result = await pool.query(
      `INSERT INTO pending_tasks (phone, nombre, ultimo_mensaje, contexto)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [phone, name || '', message, contexto]
    );
    const row = result.rows[0];
    const createdAt = new Date(row.created_at);
    const task = {
      id: row.id,
      fecha: createdAt.toLocaleDateString('es-MX', { timeZone: TZ }),
      hora: createdAt.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
      nombre: name || '',
      telefono: phone,
      ultimoMensaje: message,
      contexto,
      estado: 'Pendiente',
      createdAt: row.created_at
    };
    pendingTasks.push(task);
    if (row.id >= nextId) nextId = row.id + 1;
    console.log(`📋 Tarea pendiente #${task.id}: ${name || phone} — "${message.substring(0, 50)}"`);
  } catch (err) {
    console.error('⚠️  Error guardando tarea en DB, usando memoria:', err.message);
    const task = {
      id: nextId++,
      fecha: now.toLocaleDateString('es-MX', { timeZone: TZ }),
      hora: now.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
      nombre: name || '',
      telefono: phone,
      ultimoMensaje: message,
      contexto,
      estado: 'Pendiente',
      createdAt: now.toISOString()
    };
    pendingTasks.push(task);
    if (pendingTasks.length > 500) pendingTasks.shift();
  }
}

/** Get all pending (non-resolved) tasks, newest first. */
function getPendingTasks() {
  return pendingTasks
    .filter(t => t.estado !== 'Resuelto')
    .slice()
    .reverse();
}

/** Mark a task as resolved by its id. */
function resolvePendingTask(id) {
  const task = pendingTasks.find(t => t.id === id);
  if (!task) throw new Error(`Tarea #${id} no encontrada`);
  task.estado = 'Resuelto';
  task.resolvedAt = new Date().toISOString();
  pool.query(
    `UPDATE pending_tasks SET estado='Resuelto', resolved_at=NOW() WHERE id=$1`,
    [id]
  ).catch(err => console.error('⚠️  Error resolviendo tarea en DB:', err.message));
  console.log(`✅ Tarea pendiente #${id} marcada como resuelta`);
}

/** Mark multiple tasks as resolved by their ids. */
function resolveMultipleTasks(ids) {
  ids.forEach(id => {
    const task = pendingTasks.find(t => t.id === id);
    if (task) {
      task.estado = 'Resuelto';
      task.resolvedAt = new Date().toISOString();
    }
  });
  pool.query(
    `UPDATE pending_tasks SET estado='Resuelto', resolved_at=NOW() WHERE id = ANY($1::int[])`,
    [ids]
  ).catch(err => console.error('⚠️  Error resolviendo tareas en DB:', err.message));
  console.log(`✅ Tareas pendientes resueltas: ${ids.join(', ')}`);
}

module.exports = { init, logPendingTask, getPendingTasks, resolvePendingTask, resolveMultipleTasks };

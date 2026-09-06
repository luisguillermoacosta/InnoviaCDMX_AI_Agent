/**
 * Weekend Waitlist Store
 *
 * Cuando un sábado/domingo no tiene cupo (o la clienta solo puede a una hora
 * ya ocupada), se le ofrece anotarse aquí para que el staff la contacte si se
 * libera un lugar. Misma arquitectura que sheets-service.js (pending tasks):
 * PostgreSQL con caché en memoria, cargada al arrancar.
 */

const pool = require('../db');

const waitlist = [];
let nextId = 1;

const TZ = 'America/Mexico_City';

/** Crea la tabla si no existe y carga la lista de espera en memoria. */
async function init() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id             SERIAL PRIMARY KEY,
        phone          TEXT NOT NULL,
        nombre         TEXT,
        fecha_deseada  TEXT NOT NULL,
        hora_deseada   TEXT,
        fecha_boda     TEXT,
        notas          TEXT,
        estado         TEXT NOT NULL DEFAULT 'Pendiente',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at    TIMESTAMPTZ
      )
    `);

    const result = await pool.query(
      `SELECT id, phone, nombre, fecha_deseada, hora_deseada, fecha_boda, notas, estado, created_at, resolved_at
       FROM waitlist ORDER BY id ASC`
    );
    for (const row of result.rows) {
      const createdAt = new Date(row.created_at);
      waitlist.push({
        id: row.id,
        fecha: createdAt.toLocaleDateString('es-MX', { timeZone: TZ }),
        hora: createdAt.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
        telefono: row.phone,
        nombre: row.nombre || '',
        fechaDeseada: row.fecha_deseada,
        horaDeseada: row.hora_deseada || '',
        fechaBoda: row.fecha_boda || '',
        notas: row.notas || '',
        estado: row.estado,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at
      });
      if (row.id >= nextId) nextId = row.id + 1;
    }
    console.log(`📝 Lista de espera cargada desde DB: ${result.rows.length}`);
  } catch (err) {
    console.error('⚠️  Error inicializando lista de espera desde DB:', err.message);
  }
}

/** Agrega a una clienta a la lista de espera de un sábado/domingo. */
async function addToWaitlist({ phone, nombre, fechaDeseada, horaDeseada, fechaBoda, notas }) {
  try {
    const result = await pool.query(
      `INSERT INTO waitlist (phone, nombre, fecha_deseada, hora_deseada, fecha_boda, notas)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [phone, nombre || '', fechaDeseada, horaDeseada || '', fechaBoda || '', notas || '']
    );
    const row = result.rows[0];
    const createdAt = new Date(row.created_at);
    const entry = {
      id: row.id,
      fecha: createdAt.toLocaleDateString('es-MX', { timeZone: TZ }),
      hora: createdAt.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
      telefono: phone,
      nombre: nombre || '',
      fechaDeseada,
      horaDeseada: horaDeseada || '',
      fechaBoda: fechaBoda || '',
      notas: notas || '',
      estado: 'Pendiente',
      createdAt: row.created_at
    };
    waitlist.push(entry);
    if (row.id >= nextId) nextId = row.id + 1;
    console.log(`📝 Lista de espera #${entry.id}: ${nombre || phone} — ${fechaDeseada} ${horaDeseada || ''}`);
    return entry;
  } catch (err) {
    console.error('⚠️  Error guardando en lista de espera:', err.message);
    const now = new Date();
    const entry = {
      id: nextId++,
      fecha: now.toLocaleDateString('es-MX', { timeZone: TZ }),
      hora: now.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
      telefono: phone,
      nombre: nombre || '',
      fechaDeseada,
      horaDeseada: horaDeseada || '',
      fechaBoda: fechaBoda || '',
      notas: notas || '',
      estado: 'Pendiente',
      createdAt: now.toISOString()
    };
    waitlist.push(entry);
    if (waitlist.length > 500) waitlist.shift();
    return entry;
  }
}

/** Regresa las entradas no resueltas, más recientes primero. */
function getWaitlist() {
  return waitlist
    .filter(e => e.estado !== 'Resuelto')
    .slice()
    .reverse();
}

/** Marca una entrada como resuelta. */
function resolveWaitlistEntry(id) {
  const entry = waitlist.find(e => e.id === id);
  if (!entry) throw new Error(`Entrada de lista de espera #${id} no encontrada`);
  entry.estado = 'Resuelto';
  entry.resolvedAt = new Date().toISOString();
  pool.query(
    `UPDATE waitlist SET estado='Resuelto', resolved_at=NOW() WHERE id=$1`,
    [id]
  ).catch(err => console.error('⚠️  Error resolviendo entrada de lista de espera en DB:', err.message));
  console.log(`✅ Lista de espera #${id} marcada como resuelta`);
}

/** Marca varias entradas como resueltas. */
function resolveMultipleWaitlistEntries(ids) {
  ids.forEach(id => {
    const entry = waitlist.find(e => e.id === id);
    if (entry) {
      entry.estado = 'Resuelto';
      entry.resolvedAt = new Date().toISOString();
    }
  });
  pool.query(
    `UPDATE waitlist SET estado='Resuelto', resolved_at=NOW() WHERE id = ANY($1::int[])`,
    [ids]
  ).catch(err => console.error('⚠️  Error resolviendo entradas de lista de espera en DB:', err.message));
  console.log(`✅ Entradas de lista de espera resueltas: ${ids.join(', ')}`);
}

module.exports = { init, addToWaitlist, getWaitlist, resolveWaitlistEntry, resolveMultipleWaitlistEntries };

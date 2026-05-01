/**
 * Corre este script UNA SOLA VEZ para crear las tablas en Supabase:
 *   node db-init.js
 */
require('dotenv').config();
const pool = require('./db');

async function createTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        phone      TEXT PRIMARY KEY,
        data       JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✅ Tabla sessions creada');

    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_tasks (
        id             SERIAL PRIMARY KEY,
        phone          TEXT NOT NULL,
        nombre         TEXT,
        ultimo_mensaje TEXT,
        contexto       TEXT,
        estado         TEXT NOT NULL DEFAULT 'Pendiente',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at    TIMESTAMPTZ
      )
    `);
    console.log('✅ Tabla pending_tasks creada');

    console.log('\n🎉 Base de datos lista.');
  } finally {
    client.release();
    await pool.end();
  }
}

createTables().catch(err => {
  console.error('❌ Error creando tablas:', err.message);
  process.exit(1);
});

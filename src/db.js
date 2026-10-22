'use strict';
// Database access with two modes:
//   - DATABASE_URL set  -> real Postgres / Supabase, via a pooled pg client
//   - DATABASE_URL unset -> embedded Postgres (PGlite), data kept in ./data
// SQL must return exactly one value (use json_agg / to_jsonb). Reference the parameter as :'p'.
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_DIR = process.env.SHR_DATA_DIR || path.join(__dirname, '..', 'data');
const EMBEDDED = !DATABASE_URL;

// psql-style  :'p'  ->  $1::text   (so the same SQL runs on PGlite)
const toPg = (sql) => sql.replace(/:'p'/g, '$1::text');

// ---- embedded (PGlite) ------------------------------------------------------
let pgPromise;
function embedded() {
  if (!pgPromise) pgPromise = import('@electric-sql/pglite').then(({ PGlite }) => PGlite.create(DATA_DIR));
  return pgPromise;
}

// ---- pooled Postgres ------------------------------------------------------
let pool;
function postgresPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL });
    pool.on('error', (error) => console.error('Unexpected idle PostgreSQL client error:', error));
  }
  return pool;
}

const parse = (text) => { if (!text) return null; try { return JSON.parse(text); } catch { return text; } };

function firstValue(result) {
  if (!result.rows.length) return null;
  const value = Object.values(result.rows[0])[0] ?? null;
  return typeof value === 'string' ? parse(value) : value;
}

async function query(sql, params) {
  if (EMBEDDED) {
    const db = await embedded();
    const r = await db.query(toPg(sql), params === undefined ? [] : [JSON.stringify(params)]);
    return firstValue(r);
  }
  const result = params === undefined
    ? await postgresPool().query(sql)
    : await postgresPool().query(toPg(sql), [JSON.stringify(params)]);
  return firstValue(result);
}

// Run a multi-statement script (migrations, seed)
async function exec(sqlText) {
  if (EMBEDDED) { const db = await embedded(); await db.exec(sqlText); return; }
  await postgresPool().query(sqlText);
}

async function close() {
  if (pool) {
    const currentPool = pool;
    pool = undefined;
    await currentPool.end();
  }
}

// ---- helpers ----------------------------------------------------------------
const rows = (select) => `select coalesce(json_agg(t), '[]'::json) from (${select}) t;`;

async function audit(emr, action, outcome, detail) {
  await query(
    `with x as (
       insert into audit_log (emr_id, action, outcome, detail)
       values (nullif((:'p'::jsonb)->>'emr',''), (:'p'::jsonb)->>'action', (:'p'::jsonb)->>'outcome', (:'p'::jsonb)->'detail')
       returning 1)
     select count(*) from x;`,
    { emr: emr || '', action, outcome, detail: detail || {} }
  );
}

// Apply migrations + seed (idempotent). Called on every start in embedded mode.
async function init() {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..', 'supabase');
  for (const f of fs.readdirSync(path.join(root, 'migrations')).sort()) {
    await exec(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
  }
  await exec(fs.readFileSync(path.join(root, 'seed.sql'), 'utf8'));
}

module.exports = { query, exec, rows, audit, init, close, EMBEDDED, DATABASE_URL, DATA_DIR };

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT DEFAULT '',
      role TEXT DEFAULT '',
      goals JSONB DEFAULT '[]'::jsonb,
      goals_done JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Unidentified vendor',
      confidence TEXT NOT NULL DEFAULT 'unknown',
      orbs JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Emblemic Score — added after the table already existed in production, so these are
  // migration-safe additive columns rather than part of the CREATE TABLE above.
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS score INTEGER;`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS score_label TEXT;`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS score_reasons TEXT;`);

  await query(`CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans (created_at DESC);`);

  await query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      who TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      meeting_time TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings (created_at DESC);`);
}

module.exports = { query, initDb, pool };

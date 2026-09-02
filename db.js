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
  // Workspaces: every attendee who opens a /w/<slug> link gets their own isolated
  // profile/scans/meetings, keyed by that slug. Terrence's own link uses the fixed
  // slug in OWNER_WORKSPACE (see server.js) rather than a random one.
  await query(`
    CREATE TABLE IF NOT EXISTS profile (
      workspace_id TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      role TEXT DEFAULT '',
      goals JSONB DEFAULT '[]'::jsonb,
      goals_done JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // LinkedIn / company context for the Emblemic Score — added after profile already
  // existed in production, so additive columns rather than part of the CREATE TABLE.
  await query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS linkedin_url TEXT DEFAULT '';`);
  await query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS company_name TEXT DEFAULT '';`);

  // Migration for a profile table from before workspaces existed (single row,
  // "id INTEGER PRIMARY KEY DEFAULT 1" instead of workspace_id) — the CREATE TABLE
  // above no-ops against a table that already exists, so the old shape needs to be
  // walked forward by hand. Every step here is safe to run on every boot: each one
  // no-ops once already applied, and it does nothing at all on a brand-new database
  // where the CREATE TABLE above already made the right shape from scratch.
  await query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS workspace_id TEXT;`);
  await query(`UPDATE profile SET workspace_id = 'main' WHERE workspace_id IS NULL;`);
  await query(`ALTER TABLE profile ALTER COLUMN workspace_id SET NOT NULL;`);
  await query(`
    DO $$
    DECLARE pk_name text;
    BEGIN
      SELECT conname INTO pk_name FROM pg_constraint
        WHERE conrelid = 'profile'::regclass AND contype = 'p';
      IF pk_name IS NOT NULL AND pk_name != 'profile_workspace_pkey' THEN
        EXECUTE format('ALTER TABLE profile DROP CONSTRAINT %I', pk_name);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'profile'::regclass AND contype = 'p'
      ) THEN
        ALTER TABLE profile ADD CONSTRAINT profile_workspace_pkey PRIMARY KEY (workspace_id);
      END IF;
    END $$;
  `);
  // The old "id" column (and its single-row check) is dead weight once workspace_id
  // is the key — harmless to leave, but cleaner gone.
  await query(`ALTER TABLE profile DROP CONSTRAINT IF EXISTS single_row;`);
  await query(`ALTER TABLE profile DROP COLUMN IF EXISTS id;`);

  await query(`
    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
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
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'main';`);

  await query(`CREATE INDEX IF NOT EXISTS idx_scans_workspace_created ON scans (workspace_id, created_at DESC);`);

  await query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      who TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      meeting_time TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'main';`);
  await query(`CREATE INDEX IF NOT EXISTS idx_meetings_workspace_created ON meetings (workspace_id, created_at DESC);`);

  // Community posts are deliberately NOT workspace-isolated like everything else above —
  // this is a single shared feed visible to anyone with any Circuit link (Terrence, his
  // partner's workspace, his friend's workspace, etc.), standing in for a real tradeshow
  // community feature Circuit has no access to. workspace_id is kept only for attribution
  // (who can delete their own post), never used to filter what a reader sees.
  await query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_community_posts_created ON community_posts (created_at DESC);`);
}

module.exports = { query, initDb, pool };

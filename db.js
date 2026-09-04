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

  // Representing more than one company at the show (e.g. two different employers/
  // ventures) — each entry is its own {id, name, role, goals, goals_done}, and
  // active_company_id says which one is "currently representing" on the home screen,
  // driving which goals show, which goals feed the Emblemic Score, and which company
  // context gets searched for buyer-side scoring. The old top-level role/goals/
  // goals_done/company_name columns above are kept (never dropped) for rollback safety,
  // but the frontend no longer reads or writes them once `companies` is populated — a
  // one-time client-side migration seeds `companies` from them on first load.
  await query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS companies JSONB DEFAULT '[]'::jsonb;`);
  await query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS active_company_id TEXT DEFAULT '';`);

  // Exhibitor Mode (preview) — lets a Circuit user demo the OTHER side of a scan: set up as
  // a booth ({name, category, lookingFor: [...]} — "lookingFor" plays the same role goals
  // plays for a buyer, just describing the leads/partners this exhibitor wants to meet), then
  // scan an attendee or another exhibitor and get a match read against that targeting instead
  // of against buyer goals. One persona per workspace, same JSONB-blob pattern as `companies`.
  await query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS exhibitor_persona JSONB DEFAULT '{}'::jsonb;`);

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

  // Which company (see profile.companies above) was "currently representing" when this
  // scan happened — denormalized onto the scan itself so the log still shows the right
  // label even if that company entry is later renamed or removed from the profile.
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS company_context TEXT DEFAULT '';`);

  await query(`CREATE INDEX IF NOT EXISTS idx_scans_workspace_created ON scans (workspace_id, created_at DESC);`);
  // Lets an exhibitor persona's "who's scanned you" feed look up real scans of them by name,
  // across every workspace — see exhibitor_scans below for why this stays real rather than
  // simulated.
  await query(`CREATE INDEX IF NOT EXISTS idx_scans_name ON scans (name);`);

  // Exhibitor Mode's own scan log — the mirror of `scans` above, but for a scan an exhibitor
  // persona makes of an attendee's badge/card or of another exhibitor's booth. Kept as its own
  // table rather than reusing `scans` because it's a different scanner (an exhibitor persona,
  // not the workspace's buyer identity) being matched against different criteria
  // (exhibitor_persona.lookingFor, not company goals).
  //
  // "Who's scanned you" is deliberately NOT stored here or fabricated — it's answered by
  // querying the real `scans` table (above) for rows whose `name` matches this exhibitor's
  // name, across every workspace, the same shared-visibility pattern community_posts uses.
  // That keeps it honest: with only a couple of real Circuit users right now, it'll mostly be
  // sparse or empty rather than padded out with invented scan history.
  await query(`
    CREATE TABLE IF NOT EXISTS exhibitor_scans (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      exhibitor_name TEXT NOT NULL DEFAULT '',
      scanned_type TEXT NOT NULL DEFAULT 'attendee',
      scanned_name TEXT NOT NULL DEFAULT 'Unidentified',
      confidence TEXT NOT NULL DEFAULT 'unknown',
      orbs JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT NOT NULL DEFAULT '',
      score INTEGER,
      score_label TEXT,
      score_reasons TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_exhibitor_scans_workspace_created ON exhibitor_scans (workspace_id, created_at DESC);`);

  // Attendee <-> attendee scanning/matchmaking — the buyer identity's own peer network,
  // distinct from both `scans` (buyer scans a vendor) and `exhibitor_scans` (exhibitor
  // persona scans a lead/partner). Here the scanner is just the workspace's normal buyer
  // identity, meeting someone else on the floor and scoring the connection against their
  // own goals for the show (same two-sided LinkedIn/company read identifyVendor already
  // does for vendors).
  //
  // Unlike exhibitor_scans, this is genuinely symmetric — anyone with a Circuit link can
  // scan anyone else — so ONE table serves both directions: a row is written by the
  // scanner's own workspace, and "who's scanned me" is answered by querying this same
  // table for rows whose scanned_name matches the reader's own profile name, across every
  // workspace. Same honest, real-not-simulated pattern as exhibitor_scans' received feed.
  await query(`
    CREATE TABLE IF NOT EXISTS peer_scans (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scanned_name TEXT NOT NULL DEFAULT 'Unidentified',
      confidence TEXT NOT NULL DEFAULT 'unknown',
      orbs JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT NOT NULL DEFAULT '',
      score INTEGER,
      score_label TEXT,
      score_reasons TEXT,
      company_context TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_peer_scans_workspace_created ON peer_scans (workspace_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_peer_scans_scanned_name ON peer_scans (scanned_name);`);

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

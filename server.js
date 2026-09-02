require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { query, initDb } = require("./db");
const { identifyVendor, askQuestion } = require("./lib/claude");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json());

// index.html is served through renderIndex() below (so the shared secret can be
// injected server-side) rather than express.static — there are no other static
// assets in public/, it's a single-file app.
const indexTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

// Terrence's own link (the root URL, no /w/<slug>) always resolves to this workspace,
// so his existing goals/scans/meetings keep living at one stable address. Anyone else
// gets a random slug in a /w/<slug> link that lazily creates its own isolated workspace
// the moment they save a profile — no signup, no workspace-creation endpoint needed.
const OWNER_WORKSPACE = process.env.OWNER_WORKSPACE || "main";

function renderIndex(req, res) {
  const secret = process.env.APP_SHARED_SECRET || "";
  const html = indexTemplate
    .replace(
      "<head>",
      `<head>\n<meta name="app-secret" content="${secret.replace(/"/g, "&quot;")}">`
    )
    .replace(
      "<head>",
      `<head>\n<meta name="owner-workspace" content="${OWNER_WORKSPACE.replace(/"/g, "&quot;")}">`
    );
  res.type("html").send(html);
}

// --- shared-secret gate for the API routes only (static frontend stays open) ---
function requireAppSecret(req, res, next) {
  const expected = process.env.APP_SHARED_SECRET;
  if (!expected) return next(); // not configured — allow (local dev)
  const got = req.get("x-app-secret");
  if (got !== expected) return res.status(401).json({ error: "unauthorized" });
  next();
}

// --- workspace scoping: every profile/scan/meeting row belongs to a workspace_id ---
// (an unguessable slug from the /w/<slug> link, or OWNER_WORKSPACE for the root link).
// The slug is a capability, not a login — same trust model as the shared secret above,
// appropriate for a personal tool being handed to a few trusted people to try out.
const WORKSPACE_ID_PATTERN = /^[a-z0-9-]{3,40}$/i;
function resolveWorkspace(req, res, next) {
  const raw = req.get("x-workspace-id");
  const id = raw && WORKSPACE_ID_PATTERN.test(raw) ? raw : OWNER_WORKSPACE;
  req.workspaceId = id;
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/profile", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM profile WHERE workspace_id = $1", [req.workspaceId]);
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

app.put("/api/profile", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const body = req.body || {};
    // The frontend's in-memory profile object mirrors what GET returns (snake_case,
    // straight from Postgres column names) rather than camelCase — accept both here
    // so a save never silently drops a field it received under the "other" spelling.
    const { name, role, goals } = body;
    const goalsDone = body.goals_done !== undefined ? body.goals_done : body.goalsDone;
    const linkedinUrl = body.linkedin_url !== undefined ? body.linkedin_url : body.linkedinUrl;
    const companyName = body.company_name !== undefined ? body.company_name : body.companyName;
    const { rows } = await query(
      `INSERT INTO profile (workspace_id, name, role, goals, goals_done, linkedin_url, company_name, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         name = EXCLUDED.name, role = EXCLUDED.role,
         goals = EXCLUDED.goals, goals_done = EXCLUDED.goals_done,
         linkedin_url = EXCLUDED.linkedin_url, company_name = EXCLUDED.company_name, updated_at = now()
       RETURNING *`,
      [
        req.workspaceId, name || "", role || "", JSON.stringify(goals || []), JSON.stringify(goalsDone || {}),
        linkedinUrl || "", companyName || "",
      ]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.get("/api/scans", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM scans WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200",
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/scans", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { name, confidence, orbs, note, score, scoreLabel, scoreReasons } = req.body || {};
    const { rows } = await query(
      `INSERT INTO scans (workspace_id, name, confidence, orbs, note, score, score_label, score_reasons)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING *`,
      [
        req.workspaceId,
        name || "Unidentified vendor",
        confidence || "unknown",
        JSON.stringify(orbs || {}),
        note || "",
        Number.isFinite(score) ? score : null,
        scoreLabel || "",
        scoreReasons || "",
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

app.patch("/api/scans/:id", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { note } = req.body || {};
    const { rows } = await query(
      `UPDATE scans SET note = $1 WHERE id = $2 AND workspace_id = $3 RETURNING *`,
      [note || "", req.params.id, req.workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete("/api/scans/:id", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    await query("DELETE FROM scans WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

app.post("/api/scan", requireAppSecret, resolveWorkspace, upload.single("photo"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "invalid_request", message: "no photo attached" });
    // Emblemic Score weighs the scan against the buyer's own stated goals (and, if
    // provided, their LinkedIn/company for a two-sided read) — pull whatever's saved
    // on the profile right now. Missing goals or LinkedIn/company just means a lighter,
    // vendor-only score, same as before this field existed.
    const { rows } = await query(
      "SELECT goals, linkedin_url, company_name FROM profile WHERE workspace_id = $1",
      [req.workspaceId]
    );
    const goals = (rows[0] && rows[0].goals) || [];
    const linkedinUrl = (rows[0] && rows[0].linkedin_url) || "";
    const companyName = (rows[0] && rows[0].company_name) || "";
    const result = await identifyVendor(req.file.buffer, req.file.mimetype || "image/jpeg", goals, {
      linkedinUrl,
      companyName,
    });
    res.json(result);
  } catch (err) { next(err); }
});

app.get("/api/meetings", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM meetings WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200",
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/meetings", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { who, company, meetingTime, status, note } = req.body || {};
    const { rows } = await query(
      `INSERT INTO meetings (workspace_id, who, company, meeting_time, status, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.workspaceId, who || "", company || "", meetingTime || "", status || "requested", note || ""]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

app.patch("/api/meetings/:id", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { who, company, meetingTime, status, note } = req.body || {};
    const { rows } = await query(
      `UPDATE meetings SET
         who = COALESCE($1, who), company = COALESCE($2, company),
         meeting_time = COALESCE($3, meeting_time), status = COALESCE($4, status),
         note = COALESCE($5, note)
       WHERE id = $6 AND workspace_id = $7 RETURNING *`,
      [who, company, meetingTime, status, note, req.params.id, req.workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete("/api/meetings/:id", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    await query("DELETE FROM meetings WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

app.post("/api/ask", requireAppSecret, async (req, res, next) => {
  try {
    const { question } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: "invalid_request", message: "question is required" });
    }
    const text = await askQuestion(String(question).trim());
    res.json({ text });
  } catch (err) { next(err); }
});

// index + SPA fallback — serve the (secret-injected) shell for any non-API route
app.get(/^(?!\/api|\/health).*/, renderIndex);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server_error", message: err.message });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Circuit backend listening on :${PORT}`)))
  .catch((err) => {
    console.error("Failed to init DB", err);
    process.exit(1);
  });

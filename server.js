require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { query, initDb } = require("./db");
const { identifyVendor, identifyLead, askQuestion, draftMeetingMessage, draftSocialCaption } = require("./lib/claude");

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

// Picks the "currently representing" company entry from a profile row — the one whose
// goals/name drive scoring, the goals checklist, and Top Matches right now. Falls back to
// the first company if active_company_id doesn't match anything (e.g. it was removed).
function activeCompanyOf(profileRow) {
  const companies = Array.isArray(profileRow && profileRow.companies) ? profileRow.companies : [];
  const activeId = profileRow && profileRow.active_company_id;
  return companies.find((c) => c && c.id === activeId) || companies[0] || null;
}

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
    const { name } = body;
    const linkedinUrl = body.linkedin_url !== undefined ? body.linkedin_url : body.linkedinUrl;
    const activeCompanyId = String(
      (body.active_company_id !== undefined ? body.active_company_id : body.activeCompanyId) || ""
    ).slice(0, 60);

    // Representing more than one company at the show — each entry is sanitized here
    // rather than trusted as-is from the client, same spirit as every other write route.
    const companiesIn = Array.isArray(body.companies) ? body.companies : [];
    const companies = companiesIn.map((c, i) => ({
      id: String((c && c.id) || "").slice(0, 60) || `company-${i}-${Date.now().toString(36)}`,
      name: String((c && c.name) || "").trim().slice(0, 120),
      role: String((c && c.role) || "").trim().slice(0, 120),
      goals: Array.isArray(c && c.goals) ? c.goals.filter(Boolean).map(String) : [],
      goals_done: (c && typeof c.goals_done === "object" && c.goals_done) || {},
    }));

    // Exhibitor Mode (preview) persona — same sanitize-on-write spirit as companies above.
    // "lookingFor" plays the role goals plays for a buyer: what this exhibitor wants a scan
    // of an attendee or another exhibitor's booth to be scored against.
    const personaIn = (body.exhibitor_persona !== undefined ? body.exhibitor_persona : body.exhibitorPersona) || {};
    const exhibitorPersona = {
      name: String((personaIn && personaIn.name) || "").trim().slice(0, 120),
      category: String((personaIn && personaIn.category) || "").trim().slice(0, 120),
      lookingFor: Array.isArray(personaIn && personaIn.lookingFor)
        ? personaIn.lookingFor.filter(Boolean).map(String).slice(0, 20)
        : [],
    };

    const { rows } = await query(
      `INSERT INTO profile (workspace_id, name, linkedin_url, companies, active_company_id, exhibitor_persona, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         name = EXCLUDED.name, linkedin_url = EXCLUDED.linkedin_url,
         companies = EXCLUDED.companies, active_company_id = EXCLUDED.active_company_id,
         exhibitor_persona = EXCLUDED.exhibitor_persona, updated_at = now()
       RETURNING *`,
      [req.workspaceId, name || "", linkedinUrl || "", JSON.stringify(companies), activeCompanyId, JSON.stringify(exhibitorPersona)]
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
    const { name, confidence, orbs, note, score, scoreLabel, scoreReasons, companyContext } = req.body || {};
    const { rows } = await query(
      `INSERT INTO scans (workspace_id, name, confidence, orbs, note, score, score_label, score_reasons, company_context)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.workspaceId,
        name || "Unidentified vendor",
        confidence || "unknown",
        JSON.stringify(orbs || {}),
        note || "",
        Number.isFinite(score) ? score : null,
        scoreLabel || "",
        scoreReasons || "",
        String(companyContext || "").trim().slice(0, 120),
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
    // Emblemic Score weighs the scan against whichever company is "currently
    // representing" (see profile.companies/active_company_id) — its own goals and name,
    // not a blend of every company the buyer might represent across the show. LinkedIn
    // stays a single shared field since it's the buyer's own personal profile, not
    // tied to any one company. Missing goals or context just means a lighter,
    // vendor-only score, same as before per-company profiles existed.
    const { rows } = await query(
      "SELECT companies, active_company_id, linkedin_url FROM profile WHERE workspace_id = $1",
      [req.workspaceId]
    );
    const active = activeCompanyOf(rows[0]);
    const goals = (active && active.goals) || [];
    const linkedinUrl = (rows[0] && rows[0].linkedin_url) || "";
    const companyName = (active && active.name) || "";
    const result = await identifyVendor(req.file.buffer, req.file.mimetype || "image/jpeg", goals, {
      linkedinUrl,
      companyName,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ---------------- Exhibitor Mode (preview) ----------------
// Mirrors the buyer-side /api/scan(s) routes above, but for an exhibitor persona scanning
// an attendee's badge/card or another exhibitor's booth, scored against exhibitor_persona.
// lookingFor instead of buyer goals. Kept as its own table/route set (see db.js) rather
// than overloading the buyer-side ones, since it's a different scanner and different
// scoring criteria, not just a different label on the same data.
app.post("/api/exhibitor-scan", requireAppSecret, resolveWorkspace, upload.single("photo"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "invalid_request", message: "no photo attached" });
    const scanType = req.body && req.body.scanType === "exhibitor" ? "exhibitor" : "attendee";
    const { rows } = await query("SELECT exhibitor_persona FROM profile WHERE workspace_id = $1", [req.workspaceId]);
    const persona = (rows[0] && rows[0].exhibitor_persona) || {};
    const lookingFor = Array.isArray(persona.lookingFor) ? persona.lookingFor : [];
    const result = await identifyLead(req.file.buffer, req.file.mimetype || "image/jpeg", lookingFor, scanType);
    res.json(result);
  } catch (err) { next(err); }
});

app.get("/api/exhibitor-scans", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM exhibitor_scans WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200",
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/exhibitor-scans", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const { name, confidence, orbs, note, score, scoreLabel, scoreReasons, scannedType, exhibitorName } = req.body || {};
    const { rows } = await query(
      `INSERT INTO exhibitor_scans (workspace_id, exhibitor_name, scanned_type, scanned_name, confidence, orbs, note, score, score_label, score_reasons)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING *`,
      [
        req.workspaceId,
        String(exhibitorName || "").trim().slice(0, 120),
        scannedType === "exhibitor" ? "exhibitor" : "attendee",
        name || "Unidentified",
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

app.delete("/api/exhibitor-scans/:id", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    await query("DELETE FROM exhibitor_scans WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// "Who's scanned you" — real scans of this exhibitor by name, across every Circuit
// workspace (same shared-visibility model as community_posts), never simulated. Falls
// back to this workspace's own saved persona name when none is passed explicitly.
app.get("/api/exhibitor-received-scans", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    let name = String((req.query && req.query.name) || "").trim();
    if (!name) {
      const { rows: profileRows } = await query("SELECT exhibitor_persona FROM profile WHERE workspace_id = $1", [req.workspaceId]);
      name = ((profileRows[0] && profileRows[0].exhibitor_persona && profileRows[0].exhibitor_persona.name) || "").trim();
    }
    if (!name) return res.json([]);
    const { rows } = await query(
      "SELECT id, name, score, score_label, score_reasons, orbs, created_at, company_context FROM scans WHERE name = $1 ORDER BY created_at DESC LIMIT 100",
      [name]
    );
    res.json(rows);
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

// Community posts are a single shared feed across every Circuit workspace (Terrence,
// his partner's link, his friend's link, etc.) — deliberately the opposite of the
// isolation model used everywhere else above. GET has no workspace filtering at all;
// resolveWorkspace on POST/DELETE is only for attribution and delete-your-own-post,
// same trust model as the rest of the app (the slug is a capability, not a login).
app.get("/api/community-posts", requireAppSecret, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM community_posts ORDER BY created_at DESC LIMIT 100");
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/community-posts", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "invalid_request", message: "text is required" });
    const author = String((req.body && req.body.author) || "").trim().slice(0, 60);
    const { rows } = await query(
      `INSERT INTO community_posts (workspace_id, author, text) VALUES ($1, $2, $3) RETURNING *`,
      [req.workspaceId, author, text.slice(0, 500)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

app.delete("/api/community-posts/:id", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    await query(
      "DELETE FROM community_posts WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// AI-drafted meeting-request message for the home screen's "+ Meeting" flow — grounded in
// whatever's already known about this company (a real scan's score/context, or just
// category/tagline for a pre-scan suggestion) plus the buyer's own saved goals.
app.post("/api/meeting-message", requireAppSecret, resolveWorkspace, async (req, res, next) => {
  try {
    const company = String((req.body && req.body.company) || "").trim();
    if (!company) return res.status(400).json({ error: "invalid_request", message: "company is required" });
    const { rows } = await query(
      "SELECT name, companies, active_company_id FROM profile WHERE workspace_id = $1",
      [req.workspaceId]
    );
    // The drafted message should speak as whichever company is "currently
    // representing" (role + company name), not blend every company the buyer reps.
    const active = activeCompanyOf(rows[0]);
    const role = active ? [active.role, active.name].filter(Boolean).join(" at ") : "";
    const profileRow = { name: rows[0] && rows[0].name, role, goals: (active && active.goals) || [] };
    const text = await draftMeetingMessage(company, (req.body && req.body.context) || {}, profileRow);
    res.json({ text });
  } catch (err) { next(err); }
});

// AI-drafted caption for the Instagram/Facebook share-sheet composer in Event > Community.
app.post("/api/social-caption", requireAppSecret, async (req, res, next) => {
  try {
    const platform = (req.body && req.body.platform) || "instagram";
    const note = String((req.body && req.body.note) || "").trim();
    const text = await draftSocialCaption(platform, note);
    res.json({ text });
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

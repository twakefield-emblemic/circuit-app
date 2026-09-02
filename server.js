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
function renderIndex(req, res) {
  const secret = process.env.APP_SHARED_SECRET || "";
  const html = indexTemplate.replace(
    "<head>",
    `<head>\n<meta name="app-secret" content="${secret.replace(/"/g, "&quot;")}">`
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/profile", requireAppSecret, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM profile WHERE id = 1");
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

app.put("/api/profile", requireAppSecret, async (req, res, next) => {
  try {
    const { name, role, goals, goalsDone } = req.body || {};
    const { rows } = await query(
      `INSERT INTO profile (id, name, role, goals, goals_done, updated_at)
       VALUES (1, $1, $2, $3::jsonb, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, role = EXCLUDED.role,
         goals = EXCLUDED.goals, goals_done = EXCLUDED.goals_done, updated_at = now()
       RETURNING *`,
      [name || "", role || "", JSON.stringify(goals || []), JSON.stringify(goalsDone || {})]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.get("/api/scans", requireAppSecret, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM scans ORDER BY created_at DESC LIMIT 200");
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/scans", requireAppSecret, async (req, res, next) => {
  try {
    const { name, confidence, orbs, note, score, scoreLabel, scoreReasons } = req.body || {};
    const { rows } = await query(
      `INSERT INTO scans (name, confidence, orbs, note, score, score_label, score_reasons)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING *`,
      [
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

app.patch("/api/scans/:id", requireAppSecret, async (req, res, next) => {
  try {
    const { note } = req.body || {};
    const { rows } = await query(
      `UPDATE scans SET note = $1 WHERE id = $2 RETURNING *`,
      [note || "", req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete("/api/scans/:id", requireAppSecret, async (req, res, next) => {
  try {
    await query("DELETE FROM scans WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

app.post("/api/scan", requireAppSecret, upload.single("photo"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "invalid_request", message: "no photo attached" });
    // Emblemic Score weighs the scan against the buyer's own stated goals, so pull
    // whatever's saved on the profile right now — no goals yet just means a lighter score.
    const { rows } = await query("SELECT goals FROM profile WHERE id = 1");
    const goals = (rows[0] && rows[0].goals) || [];
    const result = await identifyVendor(req.file.buffer, req.file.mimetype || "image/jpeg", goals);
    res.json(result);
  } catch (err) { next(err); }
});

app.get("/api/meetings", requireAppSecret, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM meetings ORDER BY created_at DESC LIMIT 200");
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/meetings", requireAppSecret, async (req, res, next) => {
  try {
    const { who, company, meetingTime, status, note } = req.body || {};
    const { rows } = await query(
      `INSERT INTO meetings (who, company, meeting_time, status, note) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [who || "", company || "", meetingTime || "", status || "requested", note || ""]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

app.patch("/api/meetings/:id", requireAppSecret, async (req, res, next) => {
  try {
    const { who, company, meetingTime, status, note } = req.body || {};
    const { rows } = await query(
      `UPDATE meetings SET
         who = COALESCE($1, who), company = COALESCE($2, company),
         meeting_time = COALESCE($3, meeting_time), status = COALESCE($4, status),
         note = COALESCE($5, note)
       WHERE id = $6 RETURNING *`,
      [who, company, meetingTime, status, note, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete("/api/meetings/:id", requireAppSecret, async (req, res, next) => {
  try {
    await query("DELETE FROM meetings WHERE id = $1", [req.params.id]);
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

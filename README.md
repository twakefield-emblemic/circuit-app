# Circuit — backend

Personal CoCreate LA 2026 companion for Terrence. Standalone Node/Express backend:
serves the Circuit web app (`public/index.html`) and calls the Anthropic API directly
(vision + live web search) for booth scans and "Ask about CoCreate" questions.

Live at https://circuit-app-sq1o.onrender.com (Render web service + managed Postgres).

## Workspaces

Every profile/scan/meeting row belongs to a `workspace_id`. The plain root URL always
resolves to `OWNER_WORKSPACE` (defaults to `"main"` — Terrence's own data). Any other
link in the shape `/w/<slug>` is a fully isolated sandbox: visiting one and saving a
profile there lazily creates that workspace, with its own goals/scans/meetings, walled
off from everyone else's. No accounts — the slug in the link *is* the access key, same
trust model as the shared secret below. That's how a partner or a friend gets their own
copy to try without touching real CoCreate data.

## Local development

```
cp .env.example .env   # fill in DATABASE_URL, ANTHROPIC_API_KEY, APP_SHARED_SECRET
npm install
npm start
```

Requires a Postgres database — `db.js` creates its own tables on boot
(`CREATE TABLE IF NOT EXISTS`, plus a couple of `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` for columns added after tables already existed in production — no separate
migration step to run by hand).

## Deploying (Render)

The live service above was set up by hand (New → Web Service, connect this repo, add a
Postgres instance, set env vars). `render.yaml` in this repo is a Blueprint for spinning
up a *new* instance the same way in one pass — handy for standing up an independent copy
for the next tradeshow rather than reusing this one:

1. Render dashboard → New → Blueprint → connect this repo.
2. Render provisions the web service + Postgres from `render.yaml` automatically.
3. Fill in `ANTHROPIC_API_KEY` when prompted (kept out of the repo since it's a secret).
4. Deploy. `GET /health` should return `{"ok":true}` once it's up.

Pushing to `master` auto-deploys to whichever Render service is connected to this repo.

The iOS wrapper (see `../Circuit-iOS`) points a WKWebView at this service's URL —
`circuitBackendURL` in `WebViewContainer.swift` is already set to the live URL above.

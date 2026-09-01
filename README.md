# Circuit — backend

Personal CoCreate LA 2026 companion for Terrence. Standalone Node/Express backend:
serves the Circuit web app (`public/index.html`) and calls the Anthropic API directly
(vision + live web search) for booth scans and "Ask about CoCreate" questions.

## Local development

```
cp .env.example .env   # fill in DATABASE_URL, ANTHROPIC_API_KEY, APP_SHARED_SECRET
npm install
npm start
```

Requires a Postgres database — `db.js` creates its own tables on boot
(`CREATE TABLE IF NOT EXISTS`, no migrations to run).

## Deploying (Render)

1. New → Web Service → connect this repo.
2. Build command: `npm install`. Start command: `npm start`.
3. Add a Postgres database (Render → New → PostgreSQL), copy its internal connection
   string into this service's `DATABASE_URL`.
4. Set `ANTHROPIC_API_KEY` and `APP_SHARED_SECRET` env vars.
5. Deploy. `GET /health` should return `{"ok":true}` once it's up.

The iOS wrapper (see `../Circuit-iOS`) points a WKWebView at this service's URL —
update `circuitBackendURL` in `WebViewContainer.swift` once this is deployed.

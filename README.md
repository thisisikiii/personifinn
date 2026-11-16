# Personifinn

Every wallet in one dashboard, with an AI auditor. A personal finance web app: wallets, transactions, budgets, savings goals, invoices with a QR code, and Finny, a chat that answers questions about your money.

- Product requirements: [PRD.md](PRD.md)
- Architecture, data model, API, security and visual design: [DESIGN.md](DESIGN.md)

## What it does

| Area | Features |
|:---|:---|
| Dashboard | Net worth, income and spending this month, six-month chart, spending by category, alerts |
| Wallets | Bank, e-wallet, cash, PayPal, RDN, card; balances computed from transactions |
| Transactions | Income, expense, transfer; automatic categories; CSV statement import without duplicates; search |
| Planning | Monthly budgets per category; savings goals |
| Invoices | Line items, public payment page, QR code, share by WhatsApp or email, mark as paid |
| Finny AI | Answers from your data with Claude, or with a built-in rule engine when no API key is set |
| Offline | Installable PWA; shows the last synced data and syncs transactions added offline |

It records money. It does not connect to banks or move money; see the scope table in the PRD.

## Run it

Needs Node.js 22.13 or later.

```bash
npm ci
npm start
```

Open http://localhost:8080. The landing page is at `/`, the app at `/app`.

With Docker:

```bash
docker compose up -d --build
```

Data lives in the `data` volume as one SQLite file.

## Configuration

All optional. Copy `.env.example` to `.env` for Docker Compose, or set environment variables.

| Variable | Default | Meaning |
|:---|:---|:---|
| `PORT` | `8080` | Port to listen on (with Compose: the host port) |
| `DB_PATH` | `personifinn.db` (`/data/personifinn.db` in Docker) | SQLite file |
| `ANTHROPIC_API_KEY` | none | Lets Finny use Claude. Without it Finny uses the built-in engine. |

Run it behind a reverse proxy that terminates HTTPS and sets `X-Forwarded-Proto` and `X-Forwarded-For`.

## Test

```bash
npm test
```

The API test covers the whole flow against an in-memory database, including that one user cannot touch another user's data.

Browser smoke test against a running instance (needs Chromium and `playwright-core`, which is not a project dependency):

```bash
npm install --no-save playwright-core
node scripts/ui-smoke.mjs http://localhost:8080 ./shots
```

It registers a throwaway account, walks every screen on desktop and phone sizes, saves screenshots, and deletes the account.

## Layout

```
server/    server.js (routes), finance.js (balances, insights, CSV), ai.js (Finny), db.js (schema)
public/    index.html (landing), app.html + app.js (the app), invoice.html, sw.js, manifest, icon
test/      api.test.js
scripts/   ui-smoke.mjs
```

`personifinn_landing_page.html` and `personifinn_site_landing_page.html` in the repository root are earlier drafts of the landing page and are not served.

## Backup

Copy the SQLite file while the app is stopped, or use `sqlite3 personifinn.db ".backup backup.db"` while it runs.

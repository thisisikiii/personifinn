# Personifinn: design

How version 1 is built and how it looks. Requirements are in [PRD.md](PRD.md).

## 1. Architecture

```
Browser (PWA)                     Node 22 process (one container)
┌───────────────────────┐  HTTPS  ┌──────────────────────────────────┐
│ /        landing page │────────▶│ server/server.js  router, auth,  │
│ /app     single-page  │  JSON   │                   validation     │
│          app (app.js) │◀────────│ server/finance.js balances,      │
│ /i/:token invoice     │         │                   insights, CSV  │
│ sw.js    offline shell│         │ server/ai.js      Finny          │──▶ Claude API (optional)
│ localStorage: last    │         │ server/db.js      schema         │
│   state, unsent queue │         │        │                         │
└───────────────────────┘         │        ▼  SQLite file (/data)    │
                                  └──────────────────────────────────┘
```

Decisions and their reasons:

| Decision | Reason |
|:---|:---|
| One Node process, built-in `node:http` and `node:sqlite` | A personal finance app for a private beta fits one small container. One runtime dependency (the Anthropic SDK), nothing to build. |
| SQLite in WAL mode on a Docker volume | No database server to run or back up separately; the whole data set is one file. |
| Vanilla JavaScript front end, no build step | Eight screens. Same Tailwind and Phosphor CDN setup as the existing landing page, so both share one look. |
| Client sends one `GET /api/state` and re-fetches after each change | Keeps the front end free of cache-invalidation logic, and the same payload is what gets saved for offline use. |
| Transactions are created with `PUT /api/transactions/:id` and a client-made id | Create and edit are one call, and a retry after a lost connection cannot create a duplicate. |
| Finny gets a JSON snapshot in the prompt, not tools | One request per question; the snapshot is small. Tools become worthwhile when Finny has to act. |

Known shortcuts, each marked `shortcut:` in the code:
- Tailwind Play CDN at run time. Replace with a built stylesheet when load time or a strict Content-Security-Policy matters.
- Rate limiter is in memory, so it resets on restart and works for one process only.
- The client IP is read from `X-Forwarded-For`, which is correct only behind a reverse proxy.

## 2. Data model

All money is an integer in hundredths of the user's currency unit.

| Table | Columns | Notes |
|:---|:---|:---|
| `users` | id, email (unique), name, pass, currency, created_at | `pass` is `salt:scrypt` |
| `sessions` | token_hash, user_id, expires_at | Only the SHA-256 of the cookie value is stored |
| `wallets` | id, user_id, name, type, opening | Balance is computed, never stored |
| `transactions` | id (client UUID), user_id, wallet_id, to_wallet_id, type, amount, category, note, date, import_hash | `type` is income, expense or transfer; `to_wallet_id` only for transfers; `(user_id, import_hash)` is unique for CSV de-duplication |
| `budgets` | user_id, category, monthly_limit | One per category |
| `goals` | id, user_id, name, target, saved, due | |
| `invoices` | id, user_id, token (unique), number, client_name, client_contact, items (JSON), total, due, instructions, wallet_id, status, paid_at | `token` is 128 random bits and is the only key to the public page |
| `waitlist` | email, created_at | |

Wallet balance = opening + income − expenses − transfers out + transfers in.

## 3. API

JSON in and out. Errors are `{ "error": "message" }` with a 4xx status. All routes except the public ones need the session cookie. The client adds `?today=YYYY-MM-DD` so "this month" follows the user's timezone.

| Method and path | Purpose |
|:---|:---|
| `GET /healthz` | Liveness (public) |
| `POST /api/waitlist` | Store a waitlist email (public) |
| `POST /api/auth/register`, `/login`, `/logout` | Account and session (public) |
| `GET /api/public/invoices/:token` | Invoice for the public page (public) |
| `GET /api/state` | Everything the app shows: user, wallets with balances, transactions (latest 1000), goals, invoices, six-month totals, spending by category, budgets, recurring charges, alerts |
| `PATCH /api/me`, `DELETE /api/me` | Profile; account deletion (needs password) |
| `GET /api/export` | Same as state, as a download |
| `POST /api/wallets`, `PATCH`/`DELETE /api/wallets/:id` | Wallets |
| `PUT`/`DELETE /api/transactions/:id` | Create or edit; delete |
| `POST /api/transactions/import` | `{ wallet_id, csv }` → `{ imported, duplicates, skipped }` |
| `PUT /api/budgets/:category` | `{ limit }`; 0 removes the budget |
| `POST /api/goals`, `PATCH`/`DELETE /api/goals/:id` | Goals; `PATCH` takes `{ add }` |
| `POST /api/invoices`, `POST /api/invoices/:id/paid`, `DELETE /api/invoices/:id` | Invoices |
| `POST /api/chat` | `{ messages }` → `{ reply, engine }` where engine is `claude` or `built-in` |

## 4. Finny

- With `ANTHROPIC_API_KEY` set, `server/ai.js` calls Claude Opus 5.5 through the official SDK at low effort, with the system prompt and a JSON snapshot of the user's finances. Server-side refusal fallback is enabled. If the API fails, the built-in answer is returned with a note.
- Without a key, a rule engine answers the common questions (spending by category and period, affordability, recurring charges, budgets, goals, overview) from SQL.
- The reply shows which engine answered.
- Finny advises only. The prompt tells it that Personifinn cannot move money and that it must not recommend specific investment products.

## 5. Security

| Area | Measure |
|:---|:---|
| Passwords | scrypt with a 16-byte random salt, compared in constant time |
| Sessions | 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` when the request came over HTTPS; only its hash is stored; 30-day expiry |
| Cross-site requests | `SameSite=Lax` plus a required `application/json` body on every changing request |
| Data isolation | Every query filters by the session's user id; wallet ids in requests are checked for ownership |
| Input | Type, length and range checks on every field; 1 MB body limit; prepared statements only |
| Output | The front end escapes every value it puts into HTML |
| Headers | Content-Security-Policy, `nosniff`, `frame-ancestors 'none'`, same-origin referrer |
| Abuse | Rate limits on register, login, waitlist and chat |
| Invoices | Public page shows only what the client needs; the link is unguessable and not indexed |

Not done in version 1: database encryption at rest, email verification, password reset, two-factor sign-in, audit log.

## 6. Offline behaviour

1. `sw.js` caches the app shell and the CDN assets after the first visit and serves them when the network fails.
2. `app.js` saves the last `/api/state` response in `localStorage` and shows it, with an "Offline" banner, when the server cannot be reached.
3. A transaction saved while offline goes into a queue in `localStorage`, appears in the list as "waiting to sync", and is sent on the next load or when the browser reports it is online again.
4. Signing out clears the saved state and the queue from the device.

Only transactions can be created offline. Other changes need a connection.

## 7. Visual design

Taken from the landing page so the product and the site read as one thing.

| Token | Value | Use |
|:---|:---|:---|
| Background | `#0B1120` | Page |
| Surface | `rgba(30, 41, 59, 0.5)` with a 6% white border, 16 px radius | Cards, modals |
| Primary gradient | `#2563EB` → `#14B8A6` | Primary buttons, logo |
| Accent | teal `#14B8A6` / `#2DD4BF` | Active navigation, income, links, focus ring |
| Secondary | blue `#3B82F6` | Spending bars, transfers, user chat bubbles |
| Warning / danger | amber `#F59E0B` / rose `#F43F5E` | Budgets near limit, overdue, destructive actions |
| Text | `#F8FAFC`, muted `#94A3B8`, faint `#64748B` | |
| Font | Inter 400–800; tabular figures for money | |
| Icons | Phosphor (regular and fill) | |

Layout: fixed 240 px sidebar on desktop; on phones a scrollable bottom navigation bar and modals that rise from the bottom edge. Screens: Dashboard, Transactions, Wallets, Budgets, Goals, Invoices, Finny AI, Settings, plus sign-in and the public invoice page.

Colour is never the only signal: amounts carry a sign, invoice states carry a label, and budget bars sit next to their numbers.

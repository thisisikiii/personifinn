import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { CATEGORIES, categorize, csvToRows, state, wallets } from './finance.js';
import { chat } from './ai.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };
const PAGES = { '/': 'index.html', '/app': 'app.html', '/favicon.ico': 'icon.svg' };
const SESSION_DAYS = 30;
const WALLET_TYPES = ['bank', 'ewallet', 'cash', 'paypal', 'rdn', 'card', 'other'];
const CURRENCIES = ['IDR', 'USD', 'EUR', 'SGD', 'MYR', 'JPY', 'GBP', 'AUD'];
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com; "
  + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com https://unpkg.com https://cdn.jsdelivr.net; "
  + "img-src 'self' data:; connect-src 'self' https://formsubmit.co https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com; form-action 'self' https://formsubmit.co; frame-ancestors 'none'; base-uri 'self'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new HttpError(400, message);

// ---- input validation ----
function text(v, name, max = 120, required = true) {
  if (v == null || v === '') { if (required) throw bad(`${name} is required.`); return ''; }
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be text of at most ${max} characters.`);
  return v.trim();
}
/** Amount typed by the user in currency units -> integer hundredths. */
function cents(v, name, allowZero = false) {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 1e15) throw bad(`${name} must be a positive number.`);
  return n;
}
function day(v, name, required = true) {
  if ((v == null || v === '') && !required) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${name} must be a date (YYYY-MM-DD).`);
  return v;
}
const oneOf = (v, list, name) => { if (!list.includes(v)) throw bad(`${name} is not valid.`); return v; };

// ---- passwords and sessions ----
function hashPassword(password) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex');
}
function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createApp({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);
  const routes = [];
  const route = (method, pattern, handler, isPublic = false) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, isPublic });
  };

  // shortcut: in-memory limiter, one process only; move to the database if the app is ever scaled out.
  const hits = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    if (hits.size > 20000) hits.clear();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return; }
    if (++h.n > max) throw new HttpError(429, 'Too many attempts. Try again later.');
  }

  function startSession(res, req, userId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pf_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }
  const sessionToken = (req) => /(?:^|;\s*)pf_sid=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1];
  function currentUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(token), Date.now()) ?? null;
  }
  function ownWallet(userId, id, name = 'Wallet') {
    const w = db.prepare('SELECT id FROM wallets WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId);
    if (!w) throw bad(`${name} not found.`);
    return w.id;
  }
  const todayOf = (url) => /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('today') ?? '') ? url.searchParams.get('today') : new Date().toISOString().slice(0, 10);

  // ---- public ----
  route('GET', '/healthz', () => ({ ok: true }), true);

  route('POST', '/api/waitlist', ({ body, ip }) => {
    limit('wl:' + ip, 5, 3600e3);
    const email = text(body.email, 'Email', 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    db.prepare('INSERT OR IGNORE INTO waitlist (email) VALUES (?)').run(email);
    return { ok: true };
  }, true);

  route('POST', '/api/auth/register', ({ body, ip, req, res }) => {
    limit('reg:' + ip, 10, 3600e3);
    const email = text(body.email, 'Email', 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    const name = text(body.name, 'Name', 80);
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200) throw bad('Password must be 8 to 200 characters.');
    const currency = oneOf(body.currency ?? 'IDR', CURRENCIES, 'Currency');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered.');
    const { lastInsertRowid: id } = db.prepare('INSERT INTO users (email, name, pass, currency) VALUES (?, ?, ?, ?)').run(email, name, hashPassword(body.password), currency);
    db.prepare(`INSERT INTO wallets (user_id, name, type) VALUES (?, 'Cash', 'cash')`).run(id);
    startSession(res, req, id);
    return { ok: true };
  }, true);

  route('POST', '/api/auth/login', ({ body, ip, req, res }) => {
    const email = String(body.email ?? '').toLowerCase();
    limit(`login:${ip}:${email}`, 10, 900e3);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || typeof body.password !== 'string' || !checkPassword(body.password, user.pass)) throw new HttpError(401, 'Wrong email or password.');
    startSession(res, req, user.id);
    return { ok: true };
  }, true);

  route('POST', '/api/auth/logout', ({ req, res }) => {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    res.setHeader('Set-Cookie', 'pf_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }, true);

  route('GET', '/api/public/invoices/:token', ({ params }) => {
    const i = db.prepare(`SELECT i.number, i.client_name, i.items, i.total, i.due, i.instructions, i.status, i.created_at, u.name AS issuer, u.currency
      FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.token = ?`).get(params.token);
    if (!i) throw new HttpError(404, 'Invoice not found.');
    return { ...i, items: JSON.parse(i.items) };
  }, true);

  // ---- signed-in ----
  route('GET', '/api/state', ({ user, url }) => state(db, user, todayOf(url)));

  route('PATCH', '/api/me', ({ user, body }) => {
    db.prepare('UPDATE users SET name = ?, currency = ? WHERE id = ?')
      .run(text(body.name, 'Name', 80), oneOf(body.currency, CURRENCIES, 'Currency'), user.id);
    return { ok: true };
  });

  route('DELETE', '/api/me', ({ user, body, res }) => {
    if (typeof body.password !== 'string' || !checkPassword(body.password, user.pass)) throw new HttpError(403, 'Wrong password.');
    // transactions and invoices reference wallets without cascade, so they go first
    for (const t of ['transactions', 'invoices']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.setHeader('Set-Cookie', 'pf_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/export', ({ user, url, res }) => {
    res.setHeader('Content-Disposition', 'attachment; filename="personifinn-export.json"');
    return state(db, user, todayOf(url));
  });

  route('POST', '/api/wallets', ({ user, body }) => {
    const r = db.prepare('INSERT INTO wallets (user_id, name, type, opening) VALUES (?, ?, ?, ?)')
      .run(user.id, text(body.name, 'Name', 60), oneOf(body.type, WALLET_TYPES, 'Type'), cents(body.opening ?? 0, 'Opening balance', true));
    return { id: Number(r.lastInsertRowid) };
  });
  route('PATCH', '/api/wallets/:id', ({ user, body, params }) => {
    db.prepare('UPDATE wallets SET name = ?, type = ?, opening = ? WHERE id = ?')
      .run(text(body.name, 'Name', 60), oneOf(body.type, WALLET_TYPES, 'Type'), cents(body.opening ?? 0, 'Opening balance', true), ownWallet(user.id, params.id));
    return { ok: true };
  });
  route('DELETE', '/api/wallets/:id', ({ user, params }) => {
    const id = ownWallet(user.id, params.id);
    const used = db.prepare('SELECT (SELECT COUNT(*) FROM transactions WHERE wallet_id = ? OR to_wallet_id = ?) + (SELECT COUNT(*) FROM invoices WHERE wallet_id = ?) AS n').get(id, id, id).n;
    if (used) throw new HttpError(409, 'This wallet has transactions or invoices. Delete those first.');
    db.prepare('DELETE FROM wallets WHERE id = ?').run(id);
    return { ok: true };
  });

  // PUT with a client-made id: creating and editing are the same call, and an offline retry cannot duplicate.
  route('PUT', '/api/transactions/:id', ({ user, body, params }) => {
    if (!/^[\w-]{8,64}$/.test(params.id)) throw bad('Bad transaction id.');
    const type = oneOf(body.type, ['income', 'expense', 'transfer'], 'Type');
    const walletId = ownWallet(user.id, body.wallet_id);
    const toId = type === 'transfer' ? ownWallet(user.id, body.to_wallet_id, 'Destination wallet') : null;
    if (toId === walletId) throw bad('Choose two different wallets.');
    const note = text(body.note, 'Note', 200, false);
    const category = type === 'transfer' ? 'Transfer'
      : body.category ? oneOf(body.category, CATEGORIES, 'Category') : categorize(db, user.id, note, type);
    const r = db.prepare(`INSERT INTO transactions (id, user_id, wallet_id, to_wallet_id, type, amount, category, note, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET wallet_id = excluded.wallet_id, to_wallet_id = excluded.to_wallet_id, type = excluded.type,
        amount = excluded.amount, category = excluded.category, note = excluded.note, date = excluded.date
      WHERE transactions.user_id = excluded.user_id`)
      .run(params.id, user.id, walletId, toId, type, cents(body.amount, 'Amount'), category, note, day(body.date, 'Date'));
    if (!r.changes) throw new HttpError(404, 'Transaction not found.');
    return { id: params.id, category };
  });
  route('DELETE', '/api/transactions/:id', ({ user, params }) => {
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(params.id, user.id);
    return { ok: true };
  });
  route('POST', '/api/transactions/import', ({ user, body }) => {
    const walletId = ownWallet(user.id, body.wallet_id);
    let parsed;
    try { parsed = csvToRows(text(body.csv, 'CSV', 900_000)); } catch (e) { throw e.status ? e : bad(e.message); }
    const insert = db.prepare(`INSERT OR IGNORE INTO transactions (id, user_id, wallet_id, type, amount, category, note, date, import_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let imported = 0;
    db.exec('BEGIN');
    try {
      for (const r of parsed.rows) {
        imported += insert.run(randomUUID(), user.id, walletId, r.type, r.amount, categorize(db, user.id, r.note, r.type), r.note, r.date, `${walletId}:${r.hash}`).changes;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { imported, duplicates: parsed.rows.length - imported, skipped: parsed.skipped };
  });

  route('PUT', '/api/budgets/:category', ({ user, body, params }) => {
    const category = oneOf(decodeURIComponent(params.category), CATEGORIES, 'Category');
    const limitCents = cents(body.limit, 'Limit', true);
    if (!limitCents) db.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ?').run(user.id, category);
    else db.prepare(`INSERT INTO budgets (user_id, category, monthly_limit) VALUES (?, ?, ?)
      ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit`).run(user.id, category, limitCents);
    return { ok: true };
  });

  route('POST', '/api/goals', ({ user, body }) => {
    const r = db.prepare('INSERT INTO goals (user_id, name, target, saved, due) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, text(body.name, 'Name', 80), cents(body.target, 'Target'), cents(body.saved ?? 0, 'Saved', true), day(body.due, 'Target date', false));
    return { id: Number(r.lastInsertRowid) };
  });
  route('PATCH', '/api/goals/:id', ({ user, body, params }) => {
    const r = db.prepare('UPDATE goals SET saved = saved + ? WHERE id = ? AND user_id = ?').run(cents(body.add, 'Amount'), Number(params.id) || 0, user.id);
    if (!r.changes) throw new HttpError(404, 'Goal not found.');
    return { ok: true };
  });
  route('DELETE', '/api/goals/:id', ({ user, params }) => {
    db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(Number(params.id) || 0, user.id);
    return { ok: true };
  });

  route('POST', '/api/invoices', ({ user, body }) => {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw bad('Add 1 to 50 items.');
    const items = body.items.map(i => ({ description: text(i?.description, 'Item description', 200), amount: cents(i?.amount, 'Item amount') }));
    const n = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE user_id = ?').get(user.id).n + 1;
    const token = randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO invoices (user_id, token, number, client_name, client_contact, items, total, due, instructions, wallet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, token, 'INV-' + String(n).padStart(4, '0'), text(body.client_name, 'Client name', 120),
      text(body.client_contact, 'Client contact', 200, false), JSON.stringify(items), items.reduce((a, i) => a + i.amount, 0),
      day(body.due, 'Due date', false), text(body.instructions, 'Payment instructions', 500, false), ownWallet(user.id, body.wallet_id));
    return { token };
  });
  route('POST', '/api/invoices/:id/paid', ({ user, params, url }) => {
    const inv = db.prepare(`SELECT * FROM invoices WHERE id = ? AND user_id = ? AND status = 'unpaid'`).get(Number(params.id) || 0, user.id);
    if (!inv) throw new HttpError(404, 'Unpaid invoice not found.');
    const today = todayOf(url);
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).run(today, inv.id);
      db.prepare(`INSERT INTO transactions (id, user_id, wallet_id, type, amount, category, note, date) VALUES (?, ?, ?, 'income', ?, 'Freelance', ?, ?)`)
        .run(randomUUID(), user.id, inv.wallet_id, inv.total, `Invoice ${inv.number} - ${inv.client_name}`, today);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  });
  route('DELETE', '/api/invoices/:id', ({ user, params }) => {
    db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').run(Number(params.id) || 0, user.id);
    return { ok: true };
  });

  route('POST', '/api/chat', async ({ user, body, url }) => {
    limit('chat:' + user.id, 30, 60e3);
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    while (messages.length && messages[0]?.role !== 'user') messages.shift();
    if (!messages.length || messages.at(-1).role !== 'user') throw bad('Send a question.');
    const clean = messages.map(m => ({ role: oneOf(m?.role, ['user', 'assistant'], 'Role'), content: text(m?.content, 'Message', 4000) }));
    return chat(db, user.id, state(db, user, todayOf(url)), clean);
  });

  // ---- plumbing ----
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    if (!size) return {};
    if (!/^application\/json/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString());
      if (v && typeof v === 'object') return v;
    } catch { /* falls through */ }
    throw bad('Invalid JSON.');
  }

  async function serveStatic(pathname, res) {
    const rel = PAGES[pathname] ?? (pathname.startsWith('/i/') ? 'invoice.html' : pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found.');
    let data;
    try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found.'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    try {
      const url = new URL(req.url, 'http://x');
      const match = routes.map(r => r.method === req.method && { r, m: r.re.exec(url.pathname) }).find(x => x && x.m);
      if (!match) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);
        throw new HttpError(404, 'Not found.');
      }
      const { r, m } = match;
      const user = r.isPublic ? null : currentUser(req);
      if (!r.isPublic && !user) throw new HttpError(401, 'Sign in first.');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      // shortcut: trusts X-Forwarded-For, correct only behind a reverse proxy; drop it if the port is ever exposed directly.
      const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;
      const out = await r.handler({ req, res, url, user, body, params, ip });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    } catch (e) {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      res.writeHead(e.status ?? 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Something went wrong.' }));
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createApp({ dbPath: process.env.DB_PATH || 'personifinn.db' }).listen(port, () => console.log(`Personifinn listening on :${port}`));
}

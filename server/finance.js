import { createHash } from 'node:crypto';

export const CATEGORIES = [
  'Food & Dining', 'Groceries', 'Transport', 'Shopping', 'Bills & Utilities', 'Subscriptions',
  'Entertainment', 'Health', 'Education', 'Travel', 'Housing', 'Salary', 'Freelance', 'Investment', 'Other',
];

// First match wins. Covers common Indonesian and international merchants.
const RULES = [
  [/netflix|spotify|youtube|disney|icloud|google one|chatgpt|claude|subscription|langganan|gym|membership/i, 'Subscriptions'],
  [/gofood|grabfood|shopeefood|restaurant|resto|cafe|coffee|kopi|starbucks|mcd|kfc|lunch|dinner|breakfast|makan|warung|bakso|pizza/i, 'Food & Dining'],
  [/indomaret|alfamart|alfamidi|supermarket|grocer|hypermart|superindo|pasar|walmart|costco/i, 'Groceries'],
  [/gojek|goride|gocar|grab|uber|taxi|bluebird|fuel|bensin|pertamina|shell|parking|parkir|toll|tol|mrt|transjakarta|kereta|train|bus/i, 'Transport'],
  [/pln|listrik|electric|water|pdam|internet|wifi|indihome|telkomsel|xl |pulsa|phone bill|gas bill|bpjs/i, 'Bills & Utilities'],
  [/tokopedia|shopee|lazada|amazon|blibli|zalora|uniqlo|mall|clothes|shoes/i, 'Shopping'],
  [/cinema|bioskop|xxi|cgv|game|steam|playstation|concert|konser/i, 'Entertainment'],
  [/pharmacy|apotek|doctor|dokter|hospital|rumah sakit|clinic|klinik|halodoc|dentist/i, 'Health'],
  [/course|kursus|tuition|school|sekolah|udemy|coursera|book|buku/i, 'Education'],
  [/hotel|flight|airline|traveloka|tiket|airbnb|agoda|garuda|airasia/i, 'Travel'],
  [/rent|sewa|kost|mortgage|kpr|ipl/i, 'Housing'],
  [/salary|gaji|payroll|thr|bonus/i, 'Salary'],
  [/invoice|freelance|client|project fee/i, 'Freelance'],
  [/dividend|dividen|interest|bunga|stock|saham|reksa ?dana|crypto|rdn/i, 'Investment'],
];

/** Category for a note: what this user chose last time for the same note, then keyword rules. */
export function categorize(db, userId, note, type) {
  const learned = db.prepare(
    `SELECT category FROM transactions WHERE user_id = ? AND type = ? AND note != '' AND lower(note) = lower(?)
     ORDER BY created_at DESC LIMIT 1`).get(userId, type, note);
  if (learned) return learned.category;
  const hit = RULES.find(([re]) => re.test(note));
  return hit ? hit[1] : 'Other';
}

export const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

const BALANCE = `w.opening
  + COALESCE((SELECT SUM(CASE type WHEN 'income' THEN amount ELSE -amount END) FROM transactions t WHERE t.wallet_id = w.id), 0)
  + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.to_wallet_id = w.id), 0)`;

export function wallets(db, userId) {
  return db.prepare(`SELECT w.id, w.name, w.type, w.opening, ${BALANCE} AS balance FROM wallets w WHERE w.user_id = ? ORDER BY w.id`).all(userId);
}

export function spend(db, userId, from, to, category) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
     WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ? AND (? IS NULL OR category = ?)`
  ).get(userId, from, to, category ?? null, category ?? null);
  return row.s;
}

export function insights(db, userId, today) {
  const month = today.slice(0, 7);
  const since = addMonths(month, -5) + '-01';
  const months = Array.from({ length: 6 }, (_, i) => ({ month: addMonths(month, i - 5), income: 0, expense: 0 }));
  for (const r of db.prepare(
    `SELECT substr(date, 1, 7) AS m, type, SUM(amount) AS s FROM transactions
     WHERE user_id = ? AND type != 'transfer' AND date >= ? GROUP BY m, type`).all(userId, since)) {
    const slot = months.find(x => x.month === r.m);
    if (slot) slot[r.type] = r.s;
  }

  const catRows = db.prepare(
    `SELECT substr(date, 1, 7) AS m, category, SUM(amount) AS s FROM transactions
     WHERE user_id = ? AND type = 'expense' AND date >= ? GROUP BY m, category`).all(userId, addMonths(month, -3) + '-01');
  const byCategory = catRows.filter(r => r.m === month).map(r => ({ category: r.category, spent: r.s })).sort((a, b) => b.spent - a.spent);

  const budgets = db.prepare('SELECT category, monthly_limit FROM budgets WHERE user_id = ? ORDER BY category').all(userId)
    .map(b => ({ category: b.category, limit: b.monthly_limit, spent: byCategory.find(c => c.category === b.category)?.spent ?? 0 }));

  // Recurring: same note in 2+ of the last 4 months with amounts within 10% of each other.
  const subscriptions = db.prepare(
    `SELECT MIN(note) AS note, category, COUNT(DISTINCT substr(date, 1, 7)) AS months, CAST(AVG(amount) AS INTEGER) AS amount, MAX(date) AS last
     FROM transactions WHERE user_id = ? AND type = 'expense' AND note != '' AND date >= ?
     GROUP BY lower(note) HAVING months >= 2 AND MAX(amount) <= MIN(amount) * 1.1 ORDER BY amount DESC`
  ).all(userId, addMonths(month, -3) + '-01');

  const alerts = [];
  for (const c of byCategory) {
    const prior = catRows.filter(r => r.category === c.category && r.m !== month);
    const avg = prior.reduce((a, r) => a + r.s, 0) / prior.length;
    if (prior.length && c.spent > avg * 1.5) {
      alerts.push({ kind: 'unusual', text: `${c.category} spending this month is ${Math.round(c.spent / avg * 100 - 100)}% above your recent monthly average.` });
    }
  }
  for (const b of budgets) {
    if (b.spent > b.limit) alerts.push({ kind: 'budget', text: `${b.category} budget exceeded.` });
    else if (b.spent >= b.limit * 0.9) alerts.push({ kind: 'budget', text: `${b.category} budget is at ${Math.round(b.spent / b.limit * 100)}%.` });
  }
  const overdue = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE user_id = ? AND status = 'unpaid' AND due IS NOT NULL AND due < ?`).get(userId, today).n;
  if (overdue) alerts.push({ kind: 'invoice', text: `${overdue} invoice${overdue > 1 ? 's are' : ' is'} overdue.` });

  return { months, byCategory, budgets, subscriptions, alerts };
}

export function state(db, user, today) {
  const invoices = db.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY id DESC').all(user.id)
    .map(i => ({ ...i, items: JSON.parse(i.items) }));
  return {
    user: { email: user.email, name: user.name, currency: user.currency },
    today,
    categories: CATEGORIES,
    wallets: wallets(db, user.id),
    transactions: db.prepare('SELECT id, wallet_id, to_wallet_id, type, amount, category, note, date FROM transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 1000').all(user.id),
    goals: db.prepare('SELECT id, name, target, saved, due FROM goals WHERE user_id = ? ORDER BY id').all(user.id),
    invoices,
    ...insights(db, user.id, today),
  };
}

// ---- CSV import ----

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

/** "1.000", "1,000.50", "1.000,5", "(12.5)", "-Rp 20.000" -> signed number. */
export function parseAmount(raw) {
  const negative = /^\s*[-(]/.test(raw);
  let s = raw.replace(/[^\d.,]/g, '');
  const dec = s.match(/[.,](\d{1,2})$/);
  if (dec) s = s.slice(0, -dec[0].length);
  const n = Number(s.replace(/[.,]/g, '') + (dec ? '.' + dec[1] : ''));
  return negative ? -n : n;
}

function parseDate(raw) {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // day first
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Turns CSV text into transaction rows. Needs a header with a date column, a description column
 * and either an amount column (negative = expense) or debit and credit columns.
 */
export function csvToRows(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file needs a header row and at least one data row.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const iDate = col('date', 'tanggal'), iNote = col('desc', 'note', 'detail', 'keterangan', 'memo', 'narration');
  const iAmount = col('amount', 'jumlah', 'nominal'), iDebit = col('debit', 'withdraw'), iCredit = col('credit', 'kredit', 'deposit');
  if (iDate < 0 || iNote < 0 || (iAmount < 0 && (iDebit < 0 || iCredit < 0))) {
    throw new Error('Header must have date, description, and amount (or debit and credit) columns.');
  }
  const out = [], seen = new Map();
  let skipped = 0;
  for (const r of rows.slice(1, 5001)) {
    const date = parseDate(r[iDate] ?? '');
    const signed = iAmount >= 0 ? parseAmount(r[iAmount] ?? '')
      : Math.abs(parseAmount(r[iCredit] ?? '') || 0) - Math.abs(parseAmount(r[iDebit] ?? '') || 0);
    const amount = Math.round(Math.abs(signed) * 100);
    if (!date || !Number.isFinite(amount) || amount <= 0) { skipped++; continue; }
    const note = (r[iNote] ?? '').trim().slice(0, 200);
    const key = `${date}|${signed}|${note}`;
    const n = (seen.get(key) ?? 0) + 1; // identical rows in one file stay distinct
    seen.set(key, n);
    out.push({ date, note, amount, type: signed < 0 ? 'expense' : 'income', hash: createHash('sha256').update(`${key}#${n}`).digest('hex') });
  }
  return { rows: out, skipped };
}

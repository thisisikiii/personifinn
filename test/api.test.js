import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { parseAmount } from '../server/finance.js';

let server, base;
before(async () => {
  server = createApp();
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A signed-in client: keeps the session cookie between calls. */
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const TODAY = '2026-11-17';
const S = (c) => c('GET', `/api/state?today=${TODAY}`).then(r => r.body);

test('amount parsing handles both thousands styles', () => {
  assert.equal(parseAmount('1.000'), 1000);
  assert.equal(parseAmount('1,000.50'), 1000.5);
  assert.equal(parseAmount('1.000,5'), 1000.5);
  assert.equal(parseAmount('-Rp 20.000'), -20000);
  assert.equal(parseAmount('(12.5)'), -12.5);
});

test('full flow: wallets, transactions, budgets, goals, invoices, import, chat', async () => {
  const a = client();
  assert.equal((await a('GET', '/api/state')).status, 401);
  assert.equal((await a('POST', '/api/auth/register', { email: 'a@test.dev', name: 'A', password: 'short' })).status, 400);
  assert.equal((await a('POST', '/api/auth/register', { email: 'a@test.dev', name: 'A', password: 'correct horse', currency: 'USD' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/register', { email: 'a@test.dev', name: 'A', password: 'correct horse' })).status, 409);

  let s = await S(a);
  assert.equal(s.wallets.length, 1); // starter Cash wallet
  const cash = s.wallets[0].id;
  const bank = (await a('POST', '/api/wallets', { name: 'Bank', type: 'bank', opening: 1000 })).body.id;

  // income, auto-categorised expense, transfer
  assert.equal((await a('PUT', '/api/transactions/tx-salary-1', { type: 'income', wallet_id: bank, amount: 3000, date: TODAY, note: 'Salary November' })).body.category, 'Salary');
  assert.equal((await a('PUT', '/api/transactions/tx-food-0001', { type: 'expense', wallet_id: bank, amount: 25.5, date: TODAY, note: 'GoFood lunch' })).body.category, 'Food & Dining');
  assert.equal((await a('PUT', '/api/transactions/tx-xfer-0001', { type: 'transfer', wallet_id: bank, to_wallet_id: cash, amount: 200, date: TODAY })).status, 200);
  assert.equal((await a('PUT', '/api/transactions/tx-bad-00001', { type: 'transfer', wallet_id: bank, to_wallet_id: bank, amount: 1, date: TODAY })).status, 400);
  assert.equal((await a('PUT', '/api/transactions/tx-bad-00002', { type: 'expense', wallet_id: bank, amount: -5, date: TODAY })).status, 400);

  // the same PUT again edits instead of duplicating (offline retry safety)
  await a('PUT', '/api/transactions/tx-food-0001', { type: 'expense', wallet_id: bank, amount: 30, date: TODAY, note: 'GoFood lunch' });
  s = await S(a);
  assert.equal(s.transactions.length, 3);
  const bal = Object.fromEntries(s.wallets.map(w => [w.name, w.balance]));
  assert.equal(bal.Bank, (1000 + 3000 - 30 - 200) * 100);
  assert.equal(bal.Cash, 200 * 100);
  assert.deepEqual(s.months.at(-1), { month: '2026-11', income: 300000, expense: 3000 });

  // budget alert
  await a('PUT', '/api/budgets/' + encodeURIComponent('Food & Dining'), { limit: 20 });
  s = await S(a);
  assert.deepEqual(s.budgets, [{ category: 'Food & Dining', limit: 2000, spent: 3000 }]);
  assert.ok(s.alerts.some(x => x.text.includes('budget exceeded')));

  // goal
  const goal = (await a('POST', '/api/goals', { name: 'Laptop', target: 1200 })).body.id;
  await a('PATCH', `/api/goals/${goal}`, { add: 300 });
  assert.equal((await S(a)).goals[0].saved, 30000);

  // invoice: public page, then paid -> income lands in the wallet
  const { token } = (await a('POST', '/api/invoices', { client_name: 'Acme', wallet_id: bank, due: '2026-11-01', items: [{ description: 'Design', amount: 500 }, { description: 'Hosting', amount: 50 }] })).body;
  const pub = await client()('GET', `/api/public/invoices/${token}`);
  assert.equal(pub.body.total, 55000);
  assert.equal(pub.body.issuer, 'A');
  assert.equal(pub.body.wallet_id, undefined);
  s = await S(a);
  assert.ok(s.alerts.some(x => x.kind === 'invoice'));
  await a('POST', `/api/invoices/${s.invoices[0].id}/paid?today=${TODAY}`);
  assert.equal((await a('POST', `/api/invoices/${s.invoices[0].id}/paid`)).status, 404); // cannot be paid twice
  s = await S(a);
  assert.equal(s.wallets.find(w => w.id === bank).balance, (1000 + 3000 - 30 - 200 + 550) * 100);

  // CSV import, then the same file again -> all duplicates
  const csv = 'Date,Description,Amount\n2026-10-05,Netflix,-15.99\n2026-11-05,Netflix,-15.99\n05/11/2026,"Tokopedia, order",-1.200\nbad,row,x\n';
  assert.deepEqual((await a('POST', '/api/transactions/import', { wallet_id: bank, csv })).body, { imported: 3, duplicates: 0, skipped: 1 });
  assert.deepEqual((await a('POST', '/api/transactions/import', { wallet_id: bank, csv })).body, { imported: 0, duplicates: 3, skipped: 1 });
  s = await S(a);
  assert.equal(s.subscriptions[0].note, 'Netflix');
  assert.equal(s.transactions.find(t => t.note === 'Tokopedia, order').category, 'Shopping');

  // chat without an API key uses the built-in engine
  const reply = (await a('POST', `/api/chat?today=${TODAY}`, { messages: [{ role: 'user', content: 'How much did I spend on food this month?' }] })).body;
  assert.equal(reply.engine, 'built-in');
  assert.match(reply.reply, /\$30\.00/);
  const afford = (await a('POST', `/api/chat?today=${TODAY}`, { messages: [{ role: 'user', content: 'Can I afford a 1,200 monitor?' }] })).body;
  assert.match(afford.reply, /\$1,200\.00/);

  // a second user sees and touches nothing of the first
  const b = client();
  await b('POST', '/api/auth/register', { email: 'b@test.dev', name: 'B', password: 'another pass' });
  assert.equal((await S(b)).transactions.length, 0);
  assert.equal((await b('PUT', '/api/transactions/tx-salary-1', { type: 'income', wallet_id: (await S(b)).wallets[0].id, amount: 1, date: TODAY })).status, 404);
  assert.equal((await b('PUT', '/api/transactions/tx-b-000001', { type: 'income', wallet_id: bank, amount: 1, date: TODAY })).status, 400);
  await b('DELETE', '/api/transactions/tx-salary-1');
  await b('DELETE', `/api/goals/${goal}`);
  assert.equal((await b('DELETE', `/api/wallets/${bank}`)).status, 400);
  s = await S(a);
  assert.ok(s.transactions.some(t => t.id === 'tx-salary-1'));
  assert.equal(s.goals.length, 1);

  // wallet in use cannot be deleted; logout ends the session; login works; account deletion needs the password
  assert.equal((await a('DELETE', `/api/wallets/${bank}`)).status, 409);
  await a('POST', '/api/auth/logout');
  assert.equal((await a('GET', '/api/state')).status, 401);
  assert.equal((await a('POST', '/api/auth/login', { email: 'a@test.dev', password: 'wrong' })).status, 401);
  assert.equal((await a('POST', '/api/auth/login', { email: 'a@test.dev', password: 'correct horse' })).status, 200);
  assert.equal((await a('DELETE', '/api/me', { password: 'nope' })).status, 403);
  assert.equal((await a('DELETE', '/api/me', { password: 'correct horse' })).status, 200);
  assert.equal((await a('POST', '/api/auth/login', { email: 'a@test.dev', password: 'correct horse' })).status, 401);
});

test('waitlist, static pages and path traversal', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/waitlist', { email: 'nope' })).status, 400);
  assert.equal((await c('POST', '/api/waitlist', { email: 'x@test.dev' })).status, 200);
  assert.equal((await c('POST', '/api/waitlist', { email: 'x@test.dev' })).status, 200);
  for (const p of ['/', '/app', '/i/abc', '/app.js', '/sw.js']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await fetch(base + '/..%2fserver/server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
});

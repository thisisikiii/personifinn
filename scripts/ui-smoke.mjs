// Browser smoke test: node scripts/ui-smoke.mjs [base-url] [screenshot-dir]
// Registers a throwaway account, walks every screen, then deletes the account.
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const [base = 'http://localhost:8080', out = './shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${out}/FAIL-${pass + fail}.png` }).catch(() => {}); }
}
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const go = async (view) => { await page.goto(`${base}/app#/${view}`); await page.waitForSelector('h1'); };
const save = (label = 'Save') => page.locator('#modal').getByRole('button', { name: label, exact: true }).click();
const toast = (text) => page.locator('#toast', { hasText: text }).waitFor();
const email = `smoke-${Date.now()}@example.test`, password = randomBytes(12).toString('base64url');

await step('landing page', async () => {
  await page.goto(base + '/');
  await page.getByRole('link', { name: 'Sign in' }).waitFor();
  await shot('00-landing');
});
await step('register', async () => {
  await page.goto(base + '/app');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.fill('#f-name', 'Smoke Tester');
  await page.fill('#f-email', email);
  await page.fill('#f-password', password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Hi, Smoke Tester' }).waitFor();
});
await step('add wallet', async () => {
  await go('wallets');
  await page.getByRole('button', { name: 'Add wallet' }).click();
  await page.fill('#f-name', 'BCA');
  await page.fill('#f-opening', '5000000');
  await save();
  await toast('Wallet saved');
  await page.locator('main', { hasText: /5[.,]000[.,]000/ }).waitFor();
});
async function addTx(type, amount, note, wallet = 'BCA') {
  await page.getByRole('button', { name: /^Add( transaction)?$/ }).first().click();
  await page.selectOption('#f-type', type);
  await page.fill('#f-amount', amount);
  await page.selectOption('#f-wallet', { label: wallet });
  if (type === 'transfer') await page.selectOption('#f-to', { label: 'Cash' });
  await page.fill('#f-note', note);
  await save();
}
await step('add transactions with auto category', async () => {
  await go('transactions');
  await addTx('income', '10000000', 'Gaji November'); await toast('Saved');
  await page.locator('#tx-list', { hasText: 'Salary' }).waitFor();
  await addTx('expense', '50000', 'GoFood lunch');
  await page.locator('#tx-list', { hasText: 'Food & Dining' }).waitFor();
  await addTx('transfer', '200000', 'ATM');
  await page.locator('#tx-list', { hasText: 'BCA → Cash' }).waitFor();
});
await step('edit transaction', async () => {
  await page.locator('#tx-list button', { hasText: 'GoFood lunch' }).click();
  await page.fill('#f-amount', '60000');
  await save();
  await page.locator('#tx-list', { hasText: /60[.,]000/ }).waitFor();
});
await step('search filter', async () => {
  await page.fill('#tx-q', 'gofood');
  if (await page.locator('#tx-list button').count() !== 1) throw new Error('filter did not narrow to one row');
  await page.fill('#tx-q', '');
});
await step('csv import and re-import', async () => {
  const file = { name: 's.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Description,Amount\n2026-10-03,Netflix,-54.990\n2026-11-03,Netflix,-54.990\n') };
  for (const expected of ['Imported 2', 'Imported 0. Duplicates 2']) {
    await page.getByRole('button', { name: 'Import CSV' }).click();
    await page.selectOption('#f-wallet', { label: 'BCA' });
    await page.setInputFiles('#f-file', file);
    await save('Import');
    await toast(expected);
  }
});
await step('budget and alert', async () => {
  await go('budgets');
  await page.selectOption('#f-category', 'Food & Dining');
  await page.fill('#f-limit', '50000');
  await page.getByRole('button', { name: 'Save budget' }).click();
  await toast('Budget saved');
  await go('dashboard');
  await page.getByText('Food & Dining budget exceeded').waitFor();
});
await step('goal and contribution', async () => {
  await go('goals');
  await page.getByRole('button', { name: 'Add goal' }).click();
  await page.fill('#f-name', 'Laptop');
  await page.fill('#f-target', '15000000');
  await save();
  await toast('Goal saved');
  await page.fill('[name=add]', '1500000');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await toast('Added');
});
let invoiceUrl;
await step('invoice with QR and public page', async () => {
  await go('invoices');
  await page.getByRole('button', { name: 'New invoice' }).click();
  await page.fill('#f-client_name', 'Acme <b>Corp</b>');
  await page.fill('#f-client_contact', '+62 812-0000-0000');
  await page.selectOption('#f-wallet', { label: 'BCA' });
  await page.fill('[name=d]', 'Website design');
  await page.fill('[name=a]', '2500000');
  await page.fill('#f-ins', 'BCA 1234567890');
  await save('Create invoice');
  await toast('Invoice created');
  await page.locator('button', { hasText: 'INV-0001' }).click();
  await page.locator('#modal svg').first().waitFor();
  invoiceUrl = await page.inputValue('#inv-link');
  const wa = await page.locator('#modal a', { hasText: 'WhatsApp' }).getAttribute('href');
  if (!wa.startsWith('https://wa.me/6281200000000?text=')) throw new Error('bad WhatsApp link ' + wa);
  await shot('07-invoice-modal');
  const pub = await ctx.newPage();
  await pub.goto(invoiceUrl);
  await pub.getByText('How to pay').waitFor();
  if (await pub.locator('b').count()) throw new Error('client name was rendered as HTML');
  await pub.screenshot({ path: `${out}/08-invoice-public.png` });
  await pub.close();
});
await step('mark invoice paid', async () => {
  await page.getByRole('button', { name: 'Mark as paid' }).click();
  await toast('Marked as paid');
  await page.locator('button', { hasText: 'INV-0001' }).getByText('Paid').waitFor();
});
await step('finny answers', async () => {
  await go('finny');
  await page.getByRole('button', { name: 'Show my subscriptions' }).click();
  await page.locator('#chat', { hasText: 'Netflix' }).waitFor({ timeout: 60000 });
  await page.fill('[name=q]', 'How much did I spend on food this month?');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('#chat', { hasText: /60[.,]000/ }).waitFor({ timeout: 60000 });
});
await step('screenshots desktop and phone', async () => {
  for (const [w, h, tag] of [[1280, 800, 'desktop'], [390, 844, 'phone']]) {
    await page.setViewportSize({ width: w, height: h });
    for (const v of ['dashboard', 'transactions', 'wallets', 'budgets', 'goals', 'invoices', 'finny', 'settings']) {
      await go(v);
      await shot(`${tag}-${v}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`${v} scrolls sideways by ${overflow}px at ${w}px`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
});
await step('offline: cached shell, queued transaction, sync', async () => {
  await go('transactions');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector('h1'); // second load so the worker has cached the CDN assets
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('Offline. Showing saved data').waitFor();
  await addTx('expense', '25000', 'Parkir offline');
  await page.locator('#tx-list', { hasText: 'waiting to sync' }).waitFor();
  await shot('09-offline');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator('#tx-list button', { hasText: 'Parkir offline' }).filter({ hasText: 'Transport' }).waitFor();
  if (await page.getByText('waiting to sync').count()) throw new Error('still pending after reconnect');
});
await step('sign out and back in', async () => {
  await go('settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.fill('#f-email', email);
  await page.fill('#f-password', 'wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong email or password').waitFor();
  await page.fill('#f-email', email);
  await page.fill('#f-password', password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Hi, Smoke Tester' }).waitFor();
});
await step('delete account', async () => {
  await go('settings');
  page.once('dialog', d => d.accept());
  await page.fill('[name=password]', password);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  const res = await page.request.get(invoiceUrl.replace('/i/', '/api/public/invoices/'));
  if (res.status() !== 404) throw new Error('invoice still public after account deletion');
});
await step('no console or page errors', async () => {
  // expected: 401 before sign-in and on the wrong password, and requests made while offline
  const real = problems.filter(p => !/status of 401|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(p));
  if (real.length) throw new Error(real.join(' | '));
});

await browser.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${out}`);
process.exit(fail ? 1 : 0);

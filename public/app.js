'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localDay = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the user's timezone
const CACHE = 'pf_state', QUEUE = 'pf_queue';
const NAV = [
  ['dashboard', 'Dashboard', 'squares-four'], ['transactions', 'Transactions', 'arrows-left-right'], ['wallets', 'Wallets', 'wallet'],
  ['budgets', 'Budgets', 'chart-pie-slice'], ['goals', 'Goals', 'target'], ['invoices', 'Invoices', 'receipt'],
  ['finny', 'Finny AI', 'robot'], ['settings', 'Settings', 'gear'],
];
const WALLET_TYPES = { bank: ['Bank account', 'bank'], ewallet: ['E-wallet', 'device-mobile'], cash: ['Cash', 'money'], paypal: ['PayPal', 'paypal-logo'],
  rdn: ['RDN / investment', 'chart-line-up'], card: ['Card', 'credit-card'], other: ['Other', 'wallet'] };
const CURRENCIES = ['IDR', 'USD', 'EUR', 'SGD', 'MYR', 'JPY', 'GBP', 'AUD'];

let S = null;            // server state
let offline = false;
let authMode = 'login';
let txFilter = { q: '', wallet: '' };
const chatLog = [];

const fmt = (c) => new Intl.NumberFormat(undefined, {
  style: 'currency', currency: S.user.currency, maximumFractionDigits: ['IDR', 'JPY'].includes(S.user.currency) ? 0 : 2,
}).format(c / 100);
const walletName = (id) => S.wallets.find(w => w.id === id)?.name ?? '?';
const view = () => (NAV.find(n => n[0] === location.hash.slice(2)) ?? NAV[0])[0];
const queue = () => JSON.parse(localStorage.getItem(QUEUE) || '[]');

// ---------- server ----------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(`${url}${url.includes('?') ? '&' : '?'}today=${localDay()}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw Object.assign(new Error('You are offline.'), { offline: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: res.status });
  return data;
}

/** Sends transactions saved while offline. Stops at the first network failure and keeps the rest. */
async function flushQueue() {
  let q = queue();
  while (q.length) {
    try { await api('PUT', '/api/transactions/' + q[0].id, q[0].body); }
    catch (e) { if (e.offline || e.status === 401) throw e; toast('A saved transaction was rejected: ' + e.message); }
    q = q.slice(1);
    localStorage.setItem(QUEUE, JSON.stringify(q));
  }
}

async function load() {
  try {
    await flushQueue();
    S = await api('GET', '/api/state');
    offline = false;
    localStorage.setItem(CACHE, JSON.stringify(S));
  } catch (e) {
    const cached = localStorage.getItem(CACHE);
    if (e.offline && cached) {
      S = JSON.parse(cached);
      offline = true;
      for (const { id, body } of queue()) { // show what is waiting to sync
        const amount = Math.round(body.amount * 100);
        S.transactions = [{ ...body, id, amount, category: body.category || 'Pending', pending: true }, ...S.transactions.filter(t => t.id !== id)];
        const w = S.wallets.find(x => x.id === body.wallet_id), to = S.wallets.find(x => x.id === body.to_wallet_id);
        if (w) w.balance += body.type === 'income' ? amount : -amount;
        if (to) to.balance += amount;
      }
    } else {
      S = null;
      if (e.status === 401) localStorage.removeItem(CACHE);
      return renderAuth(e.status === 401 ? '' : e.message);
    }
  }
  render();
}

// ---------- small UI helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
function modal(title, body) {
  $('#modal').innerHTML = `<div class="card bg-slate-900 w-full sm:max-w-lg max-h-[92vh] overflow-y-auto p-5 rounded-b-none sm:rounded-2xl">
    <div class="flex justify-between items-center mb-4"><h2 class="text-lg font-bold">${esc(title)}</h2>
    <button data-act="close" aria-label="Close" class="text-slate-400 hover:text-white text-xl"><i aria-hidden="true" class="ph ph-x"></i></button></div>${body}</div>`;
  $('#modal').classList.remove('hidden');
  $('#modal input:not([type=hidden]), #modal select')?.focus();
}
const closeModal = () => $('#modal').classList.add('hidden');
const options = (list, selected) => list.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');
const walletOptions = (selected) => options(S.wallets.map(w => [w.id, w.name]), selected);
const input = (name, label, attrs = '', value = '') => `<div><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" class="field" value="${esc(value)}" ${attrs}></div>`;
const empty = (icon, text) => `<div class="text-center text-slate-500 py-10"><i aria-hidden="true" class="ph ph-${icon} text-4xl"></i><p class="mt-2 text-sm">${text}</p></div>`;
const bar = (pct, color = 'bg-teal-500') => `<div class="h-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full ${color}" style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`;
const heading = (title, right = '') => `<div class="flex flex-wrap justify-between items-center gap-3 mb-6"><h1 class="text-2xl font-bold">${title}</h1><div class="flex gap-2">${right}</div></div>`;

// ---------- auth ----------
function renderAuth(error = '') {
  const reg = authMode === 'register';
  $('#root').innerHTML = `<div class="min-h-screen flex items-center justify-center p-4"><div class="card p-8 w-full max-w-sm">
    <a href="/" class="flex items-center gap-2 mb-6"><img src="/icon.svg" alt="" class="w-8 h-8"><span class="font-bold text-xl">personifinn</span></a>
    <h1 class="text-xl font-bold mb-1">${reg ? 'Create your account' : 'Welcome back'}</h1>
    <p class="text-sm text-slate-400 mb-5">${reg ? 'All your wallets in one dashboard.' : 'Sign in to your dashboard.'}</p>
    ${error ? `<p class="text-sm text-rose-400 mb-3">${esc(error)}</p>` : ''}
    <form data-form="auth" class="space-y-3">
      ${reg ? input('name', 'Name', 'required maxlength="80" autocomplete="name"') : ''}
      ${input('email', 'Email', 'type="email" required autocomplete="email"')}
      ${input('password', 'Password', `type="password" required minlength="8" autocomplete="${reg ? 'new-password' : 'current-password'}"`)}
      ${reg ? `<div><label for="f-currency">Currency</label><select id="f-currency" name="currency" class="field">${options(CURRENCIES.map(c => [c, c]), 'IDR')}</select></div>` : ''}
      <button class="btn btn-primary w-full">${reg ? 'Create account' : 'Sign in'}</button>
    </form>
    <button data-act="authMode" class="mt-4 text-sm text-teal-400 hover:underline">${reg ? 'I already have an account' : 'Create an account'}</button>
  </div></div>`;
}

// ---------- views ----------
function txRow(t) {
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '-' : '';
  const color = t.type === 'income' ? 'text-teal-400' : t.type === 'expense' ? 'text-slate-100' : 'text-blue-400';
  const icon = t.type === 'income' ? 'arrow-down-left' : t.type === 'expense' ? 'arrow-up-right' : 'arrows-left-right';
  const where = t.type === 'transfer' ? `${walletName(t.wallet_id)} → ${walletName(t.to_wallet_id)}` : walletName(t.wallet_id);
  return `<button data-act="editTx" data-id="${esc(t.id)}" class="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-slate-800/60 text-left">
    <span class="w-9 h-9 shrink-0 rounded-full bg-slate-800 flex items-center justify-center ${color}"><i aria-hidden="true" class="ph ph-${icon}"></i></span>
    <span class="flex-1 min-w-0"><span class="block text-sm font-medium truncate">${esc(t.note || t.category)}</span>
      <span class="block text-xs text-slate-500 truncate">${esc(t.date)} · ${esc(where)} · ${esc(t.category)}${t.pending ? ' · <span class="text-amber-400">waiting to sync</span>' : ''}</span></span>
    <span class="num text-sm font-semibold ${color}">${sign}${fmt(t.amount)}</span></button>`;
}

const views = {
  dashboard() {
    const now = S.months.at(-1), net = S.wallets.reduce((a, w) => a + w.balance, 0);
    const max = Math.max(1, ...S.months.flatMap(m => [m.income, m.expense]));
    const top = Math.max(1, ...S.byCategory.map(c => c.spent));
    const stat = (label, value, cls = '') => `<div class="card p-4"><p class="text-xs text-slate-400">${label}</p><p class="num text-xl font-bold mt-1 ${cls}">${value}</p></div>`;
    return `${heading(`Hi, ${esc(S.user.name)}`, `<button data-act="addTx" class="btn btn-primary"><i aria-hidden="true" class="ph ph-plus"></i> Add transaction</button>`)}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        ${stat('Total net worth', fmt(net))}${stat('Income this month', fmt(now.income), 'text-teal-400')}
        ${stat('Spending this month', fmt(now.expense))}${stat('Net this month', fmt(now.income - now.expense), now.income < now.expense ? 'text-rose-400' : '')}
      </div>
      ${S.alerts.length ? `<div class="card p-4 mb-4 border-teal-500/30"><p class="text-sm font-semibold text-teal-400 mb-2"><i aria-hidden="true" class="ph-fill ph-sparkle"></i> Finny noticed</p>
        <ul class="text-sm text-slate-300 space-y-1">${S.alerts.map(a => `<li>• ${esc(a.text)}</li>`).join('')}</ul>
        <a href="#/finny" class="inline-block mt-2 text-sm text-teal-400 hover:underline">Ask Finny about it →</a></div>` : ''}
      <div class="grid lg:grid-cols-2 gap-4">
        <div class="card p-4"><h2 class="font-semibold mb-3">Wallets</h2>${S.wallets.map(w => `<div class="flex justify-between py-1.5 text-sm">
          <span><i aria-hidden="true" class="ph ph-${WALLET_TYPES[w.type][1]} text-teal-400 mr-2"></i>${esc(w.name)}</span><span class="num font-semibold">${fmt(w.balance)}</span></div>`).join('')}</div>
        <div class="card p-4"><h2 class="font-semibold mb-3">Last 6 months</h2><div class="flex items-end gap-3 h-36">${S.months.map(m => `
          <div class="flex-1 flex flex-col items-center gap-1 h-full justify-end" title="${esc(m.month)}: in ${esc(fmt(m.income))}, out ${esc(fmt(m.expense))}">
            <div class="flex items-end gap-1 w-full flex-1"><div class="flex-1 bg-teal-500 rounded-t" style="height:${m.income / max * 100}%"></div>
            <div class="flex-1 bg-blue-500 rounded-t" style="height:${m.expense / max * 100}%"></div></div>
            <span class="text-[10px] text-slate-500">${esc(m.month.slice(5))}</span></div>`).join('')}</div>
          <p class="text-xs text-slate-500 mt-2"><span class="inline-block w-2 h-2 bg-teal-500 rounded-sm"></span> income <span class="inline-block w-2 h-2 bg-blue-500 rounded-sm ml-2"></span> spending</p></div>
        <div class="card p-4"><h2 class="font-semibold mb-3">Spending by category</h2>${S.byCategory.length ? S.byCategory.slice(0, 7).map(c => `<div class="mb-2.5">
          <div class="flex justify-between text-sm mb-1"><span>${esc(c.category)}</span><span class="num">${fmt(c.spent)}</span></div>${bar(c.spent / top * 100, 'bg-blue-500')}</div>`).join('') : empty('chart-bar', 'No spending recorded this month.')}</div>
        <div class="card p-4"><h2 class="font-semibold mb-2">Recent transactions</h2>${S.transactions.length ? S.transactions.slice(0, 7).map(txRow).join('') : empty('receipt', 'Nothing yet. Add your first transaction.')}</div>
      </div>`;
  },

  transactions() {
    return `${heading('Transactions', `<button data-act="importCsv" class="btn btn-ghost"><i aria-hidden="true" class="ph ph-upload-simple"></i> Import CSV</button>
        <button data-act="addTx" class="btn btn-primary"><i aria-hidden="true" class="ph ph-plus"></i> Add</button>`)}
      <div class="flex gap-2 mb-3"><input id="tx-q" class="field" placeholder="Search note or category" aria-label="Search" value="${esc(txFilter.q)}">
        <select id="tx-wallet" class="field max-w-[11rem]" aria-label="Wallet"><option value="">All wallets</option>${walletOptions(txFilter.wallet)}</select></div>
      <div class="card p-2" id="tx-list">${txList()}</div>`;
  },

  wallets() {
    return `${heading('Wallets', `<button data-act="editWallet" class="btn btn-primary"><i aria-hidden="true" class="ph ph-plus"></i> Add wallet</button>`)}
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">${S.wallets.map(w => `<button data-act="editWallet" data-id="${w.id}" class="card p-4 text-left hover:border-teal-500/40">
        <span class="flex items-center gap-3"><span class="w-10 h-10 rounded-full bg-teal-500/15 text-teal-400 flex items-center justify-center text-lg"><i aria-hidden="true" class="ph ph-${WALLET_TYPES[w.type][1]}"></i></span>
        <span><span class="block font-semibold">${esc(w.name)}</span><span class="block text-xs text-slate-500">${WALLET_TYPES[w.type][0]}</span></span></span>
        <span class="num block text-xl font-bold mt-3">${fmt(w.balance)}</span></button>`).join('')}</div>
      <p class="text-xs text-slate-500 mt-4">Balances are the opening balance plus the transactions you record or import. Personifinn does not connect to your bank.</p>`;
  },

  budgets() {
    const cats = S.categories.filter(c => !['Salary', 'Freelance', 'Investment'].includes(c));
    return `${heading('Budgets')}
      <form data-form="budget" class="card p-4 mb-4 grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <div><label for="f-category">Category</label><select id="f-category" name="category" class="field">${options(cats.map(c => [c, c]))}</select></div>
        ${input('limit', 'Monthly limit', 'type="number" min="0" step="any" required')}
        <button class="btn btn-primary">Save budget</button></form>
      ${S.budgets.length ? S.budgets.map(b => { const pct = b.spent / b.limit * 100; return `<div class="card p-4 mb-3">
        <div class="flex justify-between items-center mb-2"><span class="font-semibold">${esc(b.category)}</span>
          <span class="text-sm num">${fmt(b.spent)} <span class="text-slate-500">of ${fmt(b.limit)}</span>
          <button data-act="delBudget" data-category="${esc(b.category)}" aria-label="Remove budget" class="ml-2 text-slate-500 hover:text-rose-400"><i aria-hidden="true" class="ph ph-trash"></i></button></span></div>
        ${bar(pct, pct > 100 ? 'bg-rose-500' : pct >= 90 ? 'bg-amber-500' : 'bg-teal-500')}</div>`; }).join('') : empty('chart-pie-slice', 'No budgets yet. Set a monthly limit for a category above.')}`;
  },

  goals() {
    return `${heading('Goals', `<button data-act="addGoal" class="btn btn-primary"><i aria-hidden="true" class="ph ph-plus"></i> Add goal</button>`)}
      <div class="grid sm:grid-cols-2 gap-3">${S.goals.map(g => `<div class="card p-4">
        <div class="flex justify-between"><span class="font-semibold">${esc(g.name)}</span>
          <button data-act="delGoal" data-id="${g.id}" aria-label="Delete goal" class="text-slate-500 hover:text-rose-400"><i aria-hidden="true" class="ph ph-trash"></i></button></div>
        <p class="num text-sm my-2">${fmt(g.saved)} <span class="text-slate-500">of ${fmt(g.target)}${g.due ? ' · by ' + esc(g.due) : ''}</span></p>
        ${bar(g.saved / g.target * 100)}
        <form data-form="contribute" class="flex gap-2 mt-3"><input type="hidden" name="id" value="${g.id}">
          <input name="add" type="number" min="0" step="any" required class="field" placeholder="Add savings" aria-label="Amount to add"><button class="btn btn-ghost">Add</button></form></div>`).join('')}</div>
      ${S.goals.length ? '' : empty('target', 'No goals yet. What are you saving for?')}`;
  },

  invoices() {
    return `${heading('Invoices', `<button data-act="addInvoice" class="btn btn-primary"><i aria-hidden="true" class="ph ph-plus"></i> New invoice</button>`)}
      <div class="card p-2">${S.invoices.length ? S.invoices.map(i => `<button data-act="showInvoice" data-id="${i.id}" class="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-slate-800/60 text-left">
        <span class="flex-1 min-w-0"><span class="block text-sm font-medium truncate">${esc(i.number)} · ${esc(i.client_name)}</span>
          <span class="block text-xs text-slate-500">${i.due ? 'Due ' + esc(i.due) : 'No due date'}</span></span>
        <span class="text-xs px-2 py-0.5 rounded-full ${i.status === 'paid' ? 'bg-teal-500/15 text-teal-400' : i.due && i.due < S.today ? 'bg-rose-500/15 text-rose-400' : 'bg-amber-500/15 text-amber-400'}">${i.status === 'paid' ? 'Paid' : i.due && i.due < S.today ? 'Overdue' : 'Unpaid'}</span>
        <span class="num text-sm font-semibold">${fmt(i.total)}</span></button>`).join('') : empty('receipt', 'No invoices yet. Create one and share its link or QR code.')}</div>`;
  },

  finny() {
    const tips = ['How am I doing this month?', 'How much did I spend on food this week?', 'Show my subscriptions', 'Can I afford 1,200?'];
    return `${heading('Finny AI')}
      <div class="card flex flex-col h-[70vh]">
        <div id="chat" class="flex-1 overflow-y-auto p-4 space-y-3" aria-live="polite">
          ${chatLog.length ? chatLog.map(bubble).join('') : `<p class="text-sm text-slate-400">Ask about your spending, budgets, goals or whether you can afford something. Finny answers from the data in this account.</p>`}</div>
        <div class="px-4 pb-2 flex gap-2 flex-wrap">${tips.map(t => `<button data-act="ask" data-q="${esc(t)}" class="text-xs px-3 py-1.5 rounded-full bg-slate-800 text-slate-300 hover:text-white">${esc(t)}</button>`).join('')}</div>
        <form data-form="chat" class="p-3 border-t border-slate-800 flex gap-2">
          <input name="q" class="field" placeholder="Type a message..." aria-label="Message" required maxlength="4000" autocomplete="off">
          <button class="btn btn-primary" aria-label="Send"><i aria-hidden="true" class="ph-fill ph-paper-plane-right"></i></button></form></div>`;
  },

  settings() {
    return `${heading('Settings')}
      <form data-form="profile" class="card p-4 mb-4 grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        ${input('name', 'Name', 'required maxlength="80"', S.user.name)}
        <div><label for="f-currency">Currency</label><select id="f-currency" name="currency" class="field">${options(CURRENCIES.map(c => [c, c]), S.user.currency)}</select></div>
        <button class="btn btn-primary">Save</button></form>
      <div class="card p-4 mb-4"><p class="text-sm text-slate-400 mb-3">Signed in as ${esc(S.user.email)}. Changing the currency relabels amounts; it does not convert them.</p>
        <div class="flex flex-wrap gap-2"><a href="/api/export" download class="btn btn-ghost"><i aria-hidden="true" class="ph ph-download-simple"></i> Export my data</a>
        <button data-act="logout" class="btn btn-ghost"><i aria-hidden="true" class="ph ph-sign-out"></i> Sign out</button></div></div>
      <form data-form="deleteAccount" class="card p-4 border-rose-500/20"><p class="font-semibold text-rose-300 mb-1">Delete account</p>
        <p class="text-sm text-slate-400 mb-3">Removes your account and every wallet, transaction, budget, goal and invoice. This cannot be undone.</p>
        <div class="flex gap-2"><input name="password" type="password" required class="field max-w-xs" placeholder="Your password" aria-label="Password" autocomplete="current-password">
        <button class="btn btn-danger">Delete</button></div></form>`;
  },
};

function txList() {
  const q = txFilter.q.toLowerCase();
  const list = S.transactions.filter(t => (!txFilter.wallet || t.wallet_id == txFilter.wallet || t.to_wallet_id == txFilter.wallet)
    && (!q || (t.note + ' ' + t.category).toLowerCase().includes(q)));
  return list.length ? list.map(txRow).join('') : empty('receipt', 'No transactions match.');
}
function bubble(m) {
  const html = esc(m.content).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  return m.role === 'user'
    ? `<div class="flex justify-end"><div class="bg-blue-600 text-sm rounded-2xl rounded-tr-sm py-2 px-4 max-w-[85%]">${html}</div></div>`
    : `<div class="flex justify-start"><div class="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-2xl rounded-tl-sm py-2.5 px-4 max-w-[90%]">${html}
        ${m.engine ? `<div class="text-[10px] text-slate-500 mt-1">${m.engine === 'claude' ? 'Claude' : 'Built-in engine'}</div>` : ''}</div></div>`;
}

function render() {
  const v = view();
  const link = ([id, label, icon], mobile) => mobile
    ? `<a href="#/${id}" class="flex flex-col items-center gap-0.5 min-w-[4.6rem] py-2 text-[11px] ${id === v ? 'text-teal-400' : 'text-slate-400'}"><i aria-hidden="true" class="ph ph-${icon} text-xl"></i>${label}</a>`
    : `<a href="#/${id}" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium ${id === v ? 'nav-on' : 'text-slate-300 hover:text-white'}"><i aria-hidden="true" class="ph ph-${icon} text-lg"></i>${label}</a>`;
  $('#root').innerHTML = `
    <aside class="hidden md:flex flex-col w-60 fixed inset-y-0 border-r border-slate-800 p-4 gap-1">
      <a href="#/dashboard" class="flex items-center gap-2 mb-6 px-2"><img src="/icon.svg" alt="" class="w-8 h-8"><span class="font-bold text-xl">personifinn</span></a>
      <nav class="flex flex-col gap-1" aria-label="Main">${NAV.map(n => link(n, false)).join('')}</nav></aside>
    <main class="md:ml-60 p-4 md:p-8 pb-28 md:pb-8 max-w-6xl">
      ${offline ? `<div class="mb-4 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm"><i aria-hidden="true" class="ph ph-wifi-slash"></i> Offline. Showing saved data; new transactions sync when you reconnect.</div>` : ''}
      ${views[v]()}</main>
    <nav class="md:hidden fixed bottom-0 inset-x-0 bg-slate-950 border-t border-slate-800 flex overflow-x-auto" aria-label="Main">${NAV.map(n => link(n, true)).join('')}</nav>`;
  const chat = $('#chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

// ---------- modals ----------
function txModal(t) {
  const isNew = !t;
  t ??= { type: 'expense', wallet_id: S.wallets[0]?.id, date: localDay(), note: '', amount: '' };
  modal(isNew ? 'Add transaction' : 'Edit transaction', `<form data-form="tx" class="space-y-3">
    <input type="hidden" name="id" value="${esc(t.id ?? '')}">
    <div class="grid grid-cols-2 gap-3">
      <div><label for="f-type">Type</label><select id="f-type" name="type" class="field">${options([['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']], t.type)}</select></div>
      ${input('amount', 'Amount', 'type="number" min="0" step="any" required inputmode="decimal"', t.amount ? t.amount / 100 : '')}
      <div><label for="f-wallet">Wallet</label><select id="f-wallet" name="wallet_id" class="field">${walletOptions(t.wallet_id)}</select></div>
      <div data-only="transfer"><label for="f-to">To wallet</label><select id="f-to" name="to_wallet_id" class="field">${walletOptions(t.to_wallet_id ?? S.wallets[1]?.id)}</select></div>
      <div data-not="transfer"><label for="f-cat">Category</label><select id="f-cat" name="category" class="field"><option value="">Auto-detect</option>${options(S.categories.map(c => [c, c]), isNew ? '' : t.category)}</select></div>
      ${input('date', 'Date', 'type="date" required', t.date)}
    </div>
    ${input('note', 'Note', 'maxlength="200" placeholder="e.g. GoFood lunch"', t.note)}
    <div class="flex justify-between pt-2">${isNew ? '<span></span>' : `<button type="button" data-act="delTx" data-id="${esc(t.id)}" class="btn btn-danger">Delete</button>`}
      <button class="btn btn-primary">Save</button></div></form>`);
  syncTxType();
}
function syncTxType() {
  const type = $('#f-type')?.value;
  if (!type) return;
  $('#modal [data-only="transfer"]').classList.toggle('hidden', type !== 'transfer');
  $('#modal [data-not="transfer"]').classList.toggle('hidden', type === 'transfer');
}
const itemRow = () => `<div data-item class="grid grid-cols-[1fr_8rem] gap-2"><input class="field" name="d" placeholder="Description" aria-label="Item description" maxlength="200" required>
  <input class="field" name="a" type="number" min="0" step="any" placeholder="Amount" aria-label="Item amount" required></div>`;

function invoiceModal(i) {
  const url = `${location.origin}/i/${i.token}`;
  const msg = `Invoice ${i.number} from ${S.user.name}: ${fmt(i.total)}${i.due ? ', due ' + i.due : ''}. View and pay: ${url}`;
  const phone = i.client_contact.includes('@') ? '' : i.client_contact.replace(/\D/g, '');
  const mail = i.client_contact.includes('@') ? i.client_contact : '';
  let qr = '';
  if (window.qrcode) { const q = qrcode(0, 'M'); q.addData(url); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2 }); }
  modal(`${i.number} · ${i.client_name}`, `
    <div class="flex gap-4 items-start mb-4">${qr ? `<div class="bg-white rounded-lg p-1 shrink-0 [&>svg]:w-32 [&>svg]:h-32">${qr}</div>` : ''}
      <div class="text-sm min-w-0"><p class="num text-2xl font-bold">${fmt(i.total)}</p>
        <p class="text-slate-400">${i.status === 'paid' ? 'Paid ' + esc(i.paid_at) : i.due ? 'Due ' + esc(i.due) : 'No due date'} · into ${esc(walletName(i.wallet_id))}</p>
        <ul class="mt-2 text-slate-300">${i.items.map(x => `<li class="flex justify-between gap-4"><span class="truncate">${esc(x.description)}</span><span class="num">${fmt(x.amount)}</span></li>`).join('')}</ul></div></div>
    <label for="inv-link">Payment link (the QR code opens it)</label>
    <div class="flex gap-2 mb-4"><input id="inv-link" class="field" readonly value="${esc(url)}"><button data-act="copy" data-text="${esc(url)}" class="btn btn-ghost">Copy</button></div>
    <div class="flex flex-wrap gap-2">
      <a class="btn btn-ghost" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${encodeURIComponent(msg)}"><i aria-hidden="true" class="ph ph-whatsapp-logo"></i> WhatsApp</a>
      <a class="btn btn-ghost" href="mailto:${encodeURIComponent(mail)}?subject=${encodeURIComponent('Invoice ' + i.number)}&body=${encodeURIComponent(msg)}"><i aria-hidden="true" class="ph ph-envelope"></i> Email</a>
      ${i.status === 'unpaid' ? `<button data-act="payInvoice" data-id="${i.id}" class="btn btn-primary"><i aria-hidden="true" class="ph ph-check"></i> Mark as paid</button>` : ''}
      <button data-act="delInvoice" data-id="${i.id}" class="btn btn-danger">Delete</button></div>`);
}

// ---------- actions (clicks) and forms (submits) ----------
/** Runs a change on the server, then closes the modal and reloads state. */
async function done(promise, msg) {
  await promise;
  closeModal();
  if (msg) toast(msg);
  await load();
}

const actions = {
  close: closeModal,
  authMode() { authMode = authMode === 'login' ? 'register' : 'login'; renderAuth(); },
  async logout() { await api('POST', '/api/auth/logout'); localStorage.removeItem(CACHE); localStorage.removeItem(QUEUE); chatLog.length = 0; await load(); },
  addTx() { S.wallets.length ? txModal() : toast('Add a wallet first.'); },
  editTx({ id }) { txModal(S.transactions.find(t => t.id === id)); },
  delTx: ({ id }) => done(api('DELETE', '/api/transactions/' + id), 'Transaction deleted.'),
  importCsv() {
    modal('Import CSV', `<form data-form="import" class="space-y-3">
      <p class="text-sm text-slate-400">Export a statement from your bank or e-wallet as CSV. It needs a header row with <b>date</b>, <b>description</b> and <b>amount</b> (negative for spending), or <b>debit</b> and <b>credit</b> columns. Rows already imported are skipped.</p>
      <div><label for="f-wallet">Into wallet</label><select id="f-wallet" name="wallet_id" class="field">${walletOptions()}</select></div>
      <div><label for="f-file">CSV file</label><input id="f-file" name="file" type="file" accept=".csv,text/csv" required class="field"></div>
      <div class="text-right"><button class="btn btn-primary">Import</button></div></form>`);
  },
  editWallet({ id }) {
    const w = S.wallets.find(x => x.id == id) ?? { name: '', type: 'bank', opening: 0 };
    modal(id ? 'Edit wallet' : 'Add wallet', `<form data-form="wallet" class="space-y-3"><input type="hidden" name="id" value="${id ?? ''}">
      ${input('name', 'Name', 'required maxlength="60" placeholder="e.g. BCA, GoPay, PayPal"', w.name)}
      <div><label for="f-wtype">Type</label><select id="f-wtype" name="type" class="field">${options(Object.entries(WALLET_TYPES).map(([k, v]) => [k, v[0]]), w.type)}</select></div>
      ${input('opening', 'Opening balance', 'type="number" min="0" step="any"', w.opening / 100)}
      <div class="flex justify-between pt-2">${id ? `<button type="button" data-act="delWallet" data-id="${id}" class="btn btn-danger">Delete</button>` : '<span></span>'}
        <button class="btn btn-primary">Save</button></div></form>`);
  },
  delWallet: ({ id }) => done(api('DELETE', '/api/wallets/' + id), 'Wallet deleted.'),
  delBudget: ({ category }) => done(api('PUT', '/api/budgets/' + encodeURIComponent(category), { limit: 0 })),
  addGoal() {
    modal('Add goal', `<form data-form="goal" class="space-y-3">${input('name', 'Name', 'required maxlength="80" placeholder="e.g. Emergency fund"')}
      <div class="grid grid-cols-2 gap-3">${input('target', 'Target amount', 'type="number" min="0" step="any" required')}${input('saved', 'Already saved', 'type="number" min="0" step="any"')}</div>
      ${input('due', 'Target date (optional)', 'type="date"')}<div class="text-right"><button class="btn btn-primary">Save</button></div></form>`);
  },
  delGoal: ({ id }) => done(api('DELETE', '/api/goals/' + id)),
  addInvoice() {
    if (!S.wallets.length) return toast('Add a wallet first.');
    modal('New invoice', `<form data-form="invoice" class="space-y-3">
      <div class="grid grid-cols-2 gap-3">${input('client_name', 'Client name', 'required maxlength="120"')}${input('client_contact', 'Email or WhatsApp number', 'maxlength="200"')}
        ${input('due', 'Due date', 'type="date"')}<div><label for="f-wallet">Receive into</label><select id="f-wallet" name="wallet_id" class="field">${walletOptions()}</select></div></div>
      <div><label>Items</label><div id="items" class="space-y-2">${itemRow()}</div>
        <button type="button" data-act="addItem" class="mt-2 text-sm text-teal-400 hover:underline">+ Add item</button></div>
      <div><label for="f-ins">Payment instructions shown to the client</label><textarea id="f-ins" name="instructions" class="field" rows="2" maxlength="500" placeholder="e.g. BCA 1234567890 a.n. Your Name"></textarea></div>
      <div class="text-right"><button class="btn btn-primary">Create invoice</button></div></form>`);
  },
  addItem() { $('#items').insertAdjacentHTML('beforeend', itemRow()); },
  showInvoice({ id }) { invoiceModal(S.invoices.find(i => i.id == id)); },
  payInvoice: ({ id }) => done(api('POST', `/api/invoices/${id}/paid`), 'Marked as paid. Income recorded.'),
  delInvoice: ({ id }) => done(api('DELETE', '/api/invoices/' + id), 'Invoice deleted.'),
  async copy({ text }) { await navigator.clipboard.writeText(text); toast('Link copied.'); },
  ask({ q }) { forms.chat({ q }); },
};

const forms = {
  async auth(d) {
    await api('POST', '/api/auth/' + authMode, d);
    await load();
  },
  async tx(d) {
    const body = { type: d.type, wallet_id: Number(d.wallet_id), to_wallet_id: Number(d.to_wallet_id), amount: Number(d.amount), date: d.date, note: d.note, category: d.type === 'transfer' ? '' : d.category };
    const id = d.id || crypto.randomUUID();
    try {
      await done(api('PUT', '/api/transactions/' + id, body), 'Saved.');
    } catch (e) {
      if (!e.offline) throw e;
      localStorage.setItem(QUEUE, JSON.stringify([...queue().filter(x => x.id !== id), { id, body }]));
      closeModal();
      toast('Saved on this device. It syncs when you are back online.');
      await load();
    }
  },
  async import(d, form) {
    const csv = await form.file.files[0].text();
    const r = await api('POST', '/api/transactions/import', { wallet_id: Number(d.wallet_id), csv });
    await done(null, `Imported ${r.imported}. Duplicates ${r.duplicates}, unreadable rows ${r.skipped}.`);
  },
  wallet: (d) => done(api(d.id ? 'PATCH' : 'POST', '/api/wallets' + (d.id ? '/' + d.id : ''), { name: d.name, type: d.type, opening: Number(d.opening || 0) }), 'Wallet saved.'),
  budget: (d) => done(api('PUT', '/api/budgets/' + encodeURIComponent(d.category), { limit: Number(d.limit) }), 'Budget saved.'),
  goal: (d) => done(api('POST', '/api/goals', { name: d.name, target: Number(d.target), saved: Number(d.saved || 0), due: d.due }), 'Goal saved.'),
  contribute: (d) => done(api('PATCH', '/api/goals/' + d.id, { add: Number(d.add) }), 'Added.'),
  invoice(d, form) {
    const items = [...form.querySelectorAll('[data-item]')].map(r => ({ description: $('[name=d]', r).value, amount: Number($('[name=a]', r).value) }));
    return done(api('POST', '/api/invoices', { client_name: d.client_name, client_contact: d.client_contact, due: d.due, wallet_id: Number(d.wallet_id), instructions: d.instructions, items }), 'Invoice created.');
  },
  async chat(d) {
    chatLog.push({ role: 'user', content: d.q });
    render();
    try {
      const r = await api('POST', '/api/chat', { messages: chatLog.map(({ role, content }) => ({ role, content })) });
      chatLog.push({ role: 'assistant', content: r.reply, engine: r.engine });
    } catch (e) {
      chatLog.pop();
      toast(e.message);
    }
    render();
  },
  profile: (d) => done(api('PATCH', '/api/me', d), 'Saved.'),
  async deleteAccount(d) {
    if (!confirm('Delete your account and all its data? This cannot be undone.')) return;
    await api('DELETE', '/api/me', d);
    localStorage.removeItem(CACHE); localStorage.removeItem(QUEUE);
    await load();
  },
};

// ---------- wiring ----------
document.addEventListener('click', async (e) => {
  if (e.target.id === 'modal') return closeModal();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  try { await actions[el.dataset.act](el.dataset); } catch (err) { toast(err.message); }
});
document.addEventListener('submit', async (e) => {
  const form = e.target, name = form.dataset.form;
  if (!name) return;
  e.preventDefault();
  const button = $('button:not([type=button])', form);
  if (button) button.disabled = true;
  try { await forms[name](Object.fromEntries(new FormData(form)), form); }
  catch (err) { S ? toast(err.message) : renderAuth(err.message); }
  finally { if (button) button.disabled = false; }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'f-type') syncTxType();
  if (e.target.id === 'tx-wallet') { txFilter.wallet = e.target.value; $('#tx-list').innerHTML = txList(); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'tx-q') { txFilter.q = e.target.value; $('#tx-list').innerHTML = txList(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', () => { if (S) { closeModal(); render(); window.scrollTo(0, 0); } });
window.addEventListener('online', load);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
load();

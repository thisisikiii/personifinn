import Anthropic from '@anthropic-ai/sdk';
import { spend, addMonths, CATEGORIES } from './finance.js';

const SYSTEM = `You are Finny, the financial auditor inside Personifinn, a personal finance app. The person you are talking to is the account owner, and the JSON snapshot that follows this message is their own data: wallets, the last six months of income and spending, this month's spending by category, budgets, savings goals, recurring charges, alerts, unpaid invoices and recent transactions. All amounts are in the currency named in the snapshot.

Answer from the snapshot and show the numbers you used, so the person can check your reasoning. If the snapshot does not hold what the question needs, say what is missing instead of estimating. Keep answers short: lead with the answer, then at most a few lines of supporting figures and one concrete next step.

Personifinn only records money; it cannot move it. When a transfer or payment would help, describe it as a step the person takes in their bank or wallet app and can then record here. You can discuss budgeting, cash flow and saving freely, but do not recommend specific investment products or securities; you are not a licensed adviser.

The chat window renders plain text with line breaks and **bold** only, so avoid other Markdown.`;

const money = (currency) => (cents) => new Intl.NumberFormat('en', {
  style: 'currency', currency, maximumFractionDigits: currency === 'IDR' ? 0 : 2,
}).format(cents / 100);

export function snapshot(state) {
  const u = (c) => c / 100;
  const name = Object.fromEntries(state.wallets.map(w => [w.id, w.name]));
  return {
    currency: state.user.currency,
    today: state.today,
    netWorth: u(state.wallets.reduce((a, w) => a + w.balance, 0)),
    wallets: state.wallets.map(w => ({ name: w.name, type: w.type, balance: u(w.balance) })),
    months: state.months.map(m => ({ month: m.month, income: u(m.income), expense: u(m.expense) })),
    spendingThisMonth: state.byCategory.map(c => ({ category: c.category, spent: u(c.spent) })),
    budgets: state.budgets.map(b => ({ category: b.category, limit: u(b.limit), spent: u(b.spent) })),
    goals: state.goals.map(g => ({ name: g.name, target: u(g.target), saved: u(g.saved), due: g.due })),
    recurring: state.subscriptions.map(s => ({ note: s.note, monthlyAmount: u(s.amount), category: s.category })),
    alerts: state.alerts.map(a => a.text),
    unpaidInvoices: state.invoices.filter(i => i.status === 'unpaid').map(i => ({ number: i.number, client: i.client_name, total: u(i.total), due: i.due })),
    recentTransactions: state.transactions.slice(0, 80).map(t => ({
      date: t.date, type: t.type, amount: u(t.amount), category: t.category, note: t.note, wallet: name[t.wallet_id],
    })),
  };
}

/** Rule-based answers, used when no Claude credentials are configured or the API call fails. */
export function localAnswer(db, userId, state, question) {
  const q = question.toLowerCase();
  const fmt = money(state.user.currency);
  const { today } = state;
  const month = today.slice(0, 7);
  const net = state.wallets.reduce((a, w) => a + w.balance, 0);
  const past = state.months.slice(0, -1).filter(m => m.income || m.expense);
  const avgFree = past.length ? past.reduce((a, m) => a + m.income - m.expense, 0) / past.length : null;

  if (/subscri|recurring|langganan/.test(q)) {
    if (!state.subscriptions.length) return 'I found no recurring charges in the last four months.';
    const total = state.subscriptions.reduce((a, s) => a + s.amount, 0);
    return `You have ${state.subscriptions.length} recurring charge(s), about **${fmt(total)}** a month:\n`
      + state.subscriptions.map(s => `• ${s.note}: ${fmt(s.amount)}`).join('\n')
      + '\nCancel the ones you no longer use to free up that amount every month.';
  }
  if (/afford|can i buy|bisa beli/.test(q)) {
    const m = q.match(/(\d[\d.,]*)\s*(k|rb|ribu|jt|juta|m)?\b/);
    if (!m) return 'Tell me the price, for example "Can I afford 1,200?"';
    const mult = { k: 1e3, rb: 1e3, ribu: 1e3, jt: 1e6, juta: 1e6, m: 1e6 }[m[2]] ?? 1;
    const price = Math.round(Number(m[1].replace(/[.,](?=\d{3})/g, '').replace(',', '.')) * mult * 100);
    const lines = [`Price: **${fmt(price)}**. Total balance: ${fmt(net)}.`];
    if (avgFree !== null) lines.push(`Average left over per month: ${fmt(avgFree)}.`);
    if (avgFree !== null && price <= avgFree) lines.push('Yes. One month of your usual surplus covers it.');
    else if (price <= net * 0.25) lines.push('Yes, from savings: it is under a quarter of your total balance.');
    else if (avgFree > 0) lines.push(`It is a stretch. Saving your usual surplus, it takes about ${Math.ceil(price / avgFree)} month(s).`);
    else lines.push('Not comfortably: it is a large share of your balance and you have no monthly surplus yet.');
    return lines.join('\n');
  }
  if (/spen[dt]|pengeluaran|habis/.test(q)) {
    const cat = CATEGORIES.find(c => q.includes(c.split(' ')[0].toLowerCase())) ?? null;
    let from = month + '-01', to = today, label = 'this month';
    if (/today|hari ini/.test(q)) { from = today; label = 'today'; }
    else if (/week|minggu/.test(q)) { from = new Date(Date.parse(today) - 6 * 864e5).toISOString().slice(0, 10); label = 'in the last 7 days'; }
    else if (/last month|bulan lalu/.test(q)) { from = addMonths(month, -1) + '-01'; to = addMonths(month, -1) + '-31'; label = 'last month'; }
    return `You spent **${fmt(spend(db, userId, from, to, cat))}** ${cat ? 'on ' + cat + ' ' : ''}${label}.`;
  }
  if (/budget|anggaran/.test(q)) {
    if (!state.budgets.length) return 'You have no budgets yet. Set one on the Budgets page and I will track it.';
    return state.budgets.map(b => `• ${b.category}: ${fmt(b.spent)} of ${fmt(b.limit)} (${Math.round(b.spent / b.limit * 100)}%)`).join('\n');
  }
  if (/goal|target|tabungan|saving/.test(q)) {
    if (!state.goals.length) return 'You have no savings goals yet. Add one on the Goals page.';
    return state.goals.map(g => {
      const left = Math.max(0, g.target - g.saved);
      const pace = avgFree > 0 && left ? ` About ${Math.ceil(left / avgFree)} month(s) at your usual surplus.` : '';
      return `• ${g.name}: ${fmt(g.saved)} of ${fmt(g.target)} (${Math.round(g.saved / g.target * 100)}%).${pace}`;
    }).join('\n');
  }
  const now = state.months.at(-1);
  const top = state.byCategory.slice(0, 3).map(c => `${c.category} ${fmt(c.spent)}`).join(', ');
  return [
    `Net worth: **${fmt(net)}** across ${state.wallets.length} wallet(s).`,
    `This month: income ${fmt(now.income)}, spending ${fmt(now.expense)}, net ${fmt(now.income - now.expense)}.`,
    top && `Top spending: ${top}.`,
    ...state.alerts.map(a => '⚠ ' + a.text),
    'Ask me things like "How much did I spend on food this week?", "Can I afford 1,200?" or "Show my subscriptions".',
  ].filter(Boolean).join('\n');
}

export async function chat(db, userId, state, messages) {
  const question = messages.at(-1).content;
  if (!process.env.ANTHROPIC_API_KEY) return { reply: localAnswer(db, userId, state, question), engine: 'built-in' };
  try {
    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: SYSTEM },
        { type: 'text', text: 'Snapshot:\n' + JSON.stringify(snapshot(state)) },
      ],
      messages,
    });
    if (res.stop_reason === 'refusal') return { reply: 'I cannot help with that request.', engine: 'claude' };
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (text) return { reply: text, engine: 'claude' };
  } catch (err) {
    if (!(err instanceof Anthropic.APIError)) throw err;
    console.error('claude api error', err.status, err.message);
  }
  return { reply: 'The AI service is unavailable right now, so this is the built-in answer.\n\n' + localAnswer(db, userId, state, question), engine: 'built-in' };
}

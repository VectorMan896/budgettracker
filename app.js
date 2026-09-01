/* ============================================================
   BudgetTracker — personal budget & expense tracker
   Offline, dependency-free. All data in localStorage.
   Balance counts down as you spend; income tops it up.
   ============================================================ */

const STORE_KEY = 'budgettracker.v1';
const DAY = 86400000;
const PALETTE = ['#34d399', '#3fb950', '#38bdf8', '#a78bfa', '#f472b6', '#fb7185',
                 '#f0a020', '#ffb703', '#22d3ee', '#94a3b8', '#f85149', '#64748b'];

/* ---------- helpers ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const t = (iso) => new Date(iso).getTime();
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(iso) { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
function fmtDateTime(iso) { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function fmtDay(d) { return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); }
function relTime(iso) {
  const d = (Date.now() - t(iso)) / DAY;
  if (d < 0) return 'scheduled';
  if (d < 0.021) return 'just now';
  if (d < 1) return Math.round(d * 24) + 'h ago';
  if (d < 1.5) return 'yesterday';
  return Math.round(d) + ' days ago';
}
function money(n, dec) {
  if (n === Infinity) return '∞';
  if (n == null || isNaN(n)) return '–';
  const d = dec != null ? dec : (Math.abs(n % 1) < 1e-9 ? 0 : 2);
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
const cur = () => state.settings.currency;
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- state ---------- */
function defaultSettings() {
  return { currency: 'MT', monthStartDay: 1, startingBalance: 0, lowBalance: 0, runwayDays: 5, overBudgetWarn: true, window: 7, notify: false };
}
function seedCategories() {
  const C = (name, type, budget, color, icon) => ({ id: uid(), name, type, budget, color, icon });
  return [
    C('Electricity', 'expense', 6000, '#ffb703', '⚡'),
    C('Groceries', 'expense', 0, '#3fb950', '🛒'),
    C('Rent', 'expense', 0, '#a78bfa', '🏠'),
    C('Water', 'expense', 0, '#38bdf8', '💧'),
    C('Transport / Fuel', 'expense', 0, '#f0a020', '🚗'),
    C('Airtime / Internet', 'expense', 0, '#f472b6', '📱'),
    C('Dining out', 'expense', 0, '#fb7185', '🍽'),
    C('Health', 'expense', 0, '#22d3ee', '💊'),
    C('Household', 'expense', 0, '#94a3b8', '🧴'),
    C('Other', 'expense', 0, '#64748b', '🔖'),
    C('Salary', 'income', 0, '#34d399', '💼'),
    C('M-Pesa in', 'income', 0, '#22d3ee', '📲'),
    C('Other income', 'income', 0, '#a78bfa', '➕')
  ];
}
function firstRunData() {
  return { version: 1, settings: defaultSettings(), categories: seedCategories(), transactions: [] };
}

let state = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return firstRunData();
    const s = JSON.parse(raw);
    s.settings = Object.assign(defaultSettings(), s.settings || {});
    s.categories = s.categories || [];
    s.transactions = s.transactions || [];
    return s;
  } catch (e) { console.error(e); return firstRunData(); }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage full?'); }
}
const catById = (id) => state.categories.find(c => c.id === id);

/* ============================================================
   CALCULATION ENGINE
   ============================================================ */
function cycleBounds(ref) {
  const now = ref || new Date();
  const sd = Math.min(28, Math.max(1, state.settings.monthStartDay || 1));
  let start = new Date(now.getFullYear(), now.getMonth(), sd);
  if (now < start) start = new Date(now.getFullYear(), now.getMonth() - 1, sd);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, sd);
  return { start, end };
}
function txInCycle() {
  const { start, end } = cycleBounds();
  return state.transactions.filter(x => t(x.t) >= start.getTime() && t(x.t) < end.getTime());
}
const sumExpense = (list) => list.filter(x => x.type === 'expense').reduce((s, x) => s + x.amount, 0);
const sumIncome = (list) => list.filter(x => x.type === 'income').reduce((s, x) => s + x.amount, 0);

function balance() {
  return state.settings.startingBalance + sumIncome(state.transactions) - sumExpense(state.transactions);
}
function totalBudget() {
  return state.categories.filter(c => c.type === 'expense').reduce((s, c) => s + (c.budget || 0), 0);
}
function spentThisCycle() { return sumExpense(txInCycle()); }
function incomeThisCycle() { return sumIncome(txInCycle()); }
// Spending only in categories that actually have a budget (envelope view).
function budgetedSpentThisCycle() {
  const budgeted = new Set(state.categories.filter(c => c.type === 'expense' && (c.budget || 0) > 0).map(c => c.id));
  return txInCycle().filter(x => x.type === 'expense' && budgeted.has(x.categoryId)).reduce((s, x) => s + x.amount, 0);
}

// Guards against nonsense from a partial first day / lumpy one-off transactions.
const SMOOTH_DAYS = 5;      // min days used to derive a daily burn rate
const PROJECT_MIN_DAYS = 2; // don't extrapolate a cycle projection before this
const RUNWAY_MIN_DAYS = 3;  // don't fire a low-runway alert before this

function spentByCategory() {
  const map = {};
  txInCycle().filter(x => x.type === 'expense').forEach(x => { map[x.categoryId] = (map[x.categoryId] || 0) + x.amount; });
  return map;
}
function incomeByCategory() {
  const map = {};
  txInCycle().filter(x => x.type === 'income').forEach(x => { map[x.categoryId] = (map[x.categoryId] || 0) + x.amount; });
  return map;
}

function avgDailySpend() {
  const win = state.settings.window;
  const now = Date.now();
  let fromT, days;
  if (win > 0) { fromT = now - win * DAY; days = win; }
  else { const { start } = cycleBounds(); fromT = start.getTime(); days = Math.max(SMOOTH_DAYS, (now - fromT) / DAY); }
  const spent = state.transactions
    .filter(x => x.type === 'expense' && t(x.t) >= fromT && t(x.t) <= now)
    .reduce((s, x) => s + x.amount, 0);
  return { rate: spent / days, days, basis: win > 0 ? `last ${win} days` : 'this cycle' };
}

function runway() {
  const bal = balance();
  const { rate } = avgDailySpend();
  if (rate <= 0) return { days: Infinity, emptyAt: null, rate, bal };
  const days = bal > 0 ? bal / rate : 0;
  const emptyAt = bal > 0 ? new Date(Date.now() + days * DAY) : new Date();
  return { days, emptyAt, rate, bal };
}

function cycleProjection() {
  const { start, end } = cycleBounds();
  const now = Date.now();
  const totalDays = (end.getTime() - start.getTime()) / DAY;
  const elapsed = (now - start.getTime()) / DAY;
  const daysLeft = Math.max(0, (end.getTime() - now) / DAY);
  const spent = spentThisCycle();
  const budgetedSpent = budgetedSpentThisCycle();
  const budget = totalBudget();
  const canProject = elapsed >= PROJECT_MIN_DAYS;
  const projected = canProject ? budgetedSpent / Math.min(elapsed, totalDays) * totalDays : null;
  return { start, end, totalDays, elapsed, daysLeft, spent, budgetedSpent, budget, canProject, projected };
}

function alertLevel() {
  const s = state.settings;
  const { days, bal } = runway();
  const p = cycleProjection();
  const hasData = state.transactions.length > 0 || s.startingBalance > 0;
  if (!hasData) return 'none';
  if (s.startingBalance > 0 && s.lowBalance > 0 && bal < s.lowBalance) return 'bad';
  if (s.startingBalance > 0 && p.elapsed >= RUNWAY_MIN_DAYS && bal > 0 && s.runwayDays > 0 && days < s.runwayDays) return 'bad';
  if (s.overBudgetWarn && p.budget > 0 && (p.budgetedSpent > p.budget || (p.canProject && p.projected > p.budget))) return 'warn';
  return 'good';
}
const barColor = (pct) => pct >= 1 ? 'var(--bad)' : pct >= 0.8 ? 'var(--warn)' : 'var(--accent)';

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  $$('.cur-label').forEach(el => el.textContent = cur());
  $('#cycleSub').textContent = cycleLabel();
  renderHero();
  renderStats();
  renderCharts();
  renderHistory();
  renderBudgets();
  renderAlert();
}
function cycleLabel() {
  const { start, end } = cycleBounds();
  const endD = new Date(end.getTime() - DAY);
  return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${endD.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

function renderHero() {
  const el = $('#hero');
  const hasData = state.transactions.length > 0 || state.settings.startingBalance > 0;
  const p = cycleProjection();
  if (!hasData && p.budget === 0) {
    el.innerHTML = `<div class="hero-label">Get started</div>
      <div class="hero-sub" style="margin-top:8px">Set your current balance in <strong>Settings</strong>, then log spending in the <strong>Log</strong> tab. Set category budgets under <strong>Budgets</strong>.</div>`;
    return;
  }
  if (p.budget > 0) {
    const spentB = p.budgetedSpent;
    const pct = spentB / p.budget;
    const over = spentB > p.budget || (p.canProject && p.projected > p.budget);
    const near = !over && (pct >= 0.9 || (p.canProject && p.projected > p.budget * 0.9));
    const lvl = over ? 'bad' : near ? 'warn' : 'good';
    const ringTxt = over ? 'Over budget' : near ? 'Near limit' : 'On track';
    const paceLine = p.canProject
      ? `On pace for ~<strong style="color:${lvl === 'good' ? 'var(--good)' : lvl === 'warn' ? 'var(--warn)' : 'var(--bad)'}">${money(p.projected)} ${cur()}</strong> by ${new Date(p.end.getTime() - DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      : `${Math.max(1, Math.ceil(p.elapsed))} day${Math.ceil(p.elapsed) > 1 ? 's' : ''} into the cycle — too early to project`;
    const overallLine = Math.abs(p.spent - spentB) > 0.001
      ? `<div class="hero-empty" style="margin-top:2px">${money(p.spent)} ${cur()} spent overall (incl. unbudgeted)</div>` : '';
    el.innerHTML = `
      <div class="hero-label">Spent in budgets this cycle</div>
      <div class="hero-big">${money(spentB)} <small>${cur()}</small></div>
      <div class="hero-progress"><i style="width:${Math.min(100, pct * 100)}%;background:${barColor(pct)}"></i></div>
      <div class="hero-sub">of <strong>${money(p.budget)} ${cur()}</strong> budget · ${Math.ceil(p.daysLeft)} days left</div>
      <div class="hero-empty">${paceLine}</div>${overallLine}
      <span class="ring ${lvl}">${ringTxt}</span>`;
  } else {
    const r = runway();
    const days = r.days === Infinity ? '—' : money(r.days, 1);
    const sub = r.rate > 0 && r.bal > 0
      ? `Lasts ≈ <strong>${days} days</strong> · empty ${r.emptyAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      : 'Log spending to estimate your runway';
    el.innerHTML = `
      <div class="hero-label">Balance</div>
      <div class="hero-big">${money(r.bal)} <small>${cur()}</small></div>
      <div class="hero-sub">${sub}</div>
      <div class="hero-empty">Tip: set category budgets under <strong>Budgets</strong> to track a monthly target.</div>`;
  }
}

function renderStats() {
  const grid = $('#statGrid');
  const hasData = state.transactions.length > 0 || state.settings.startingBalance > 0;
  if (!hasData) { grid.innerHTML = ''; return; }
  const bal = balance();
  const r = runway();
  const income = incomeThisCycle();
  const spent = spentThisCycle();
  const net = income - spent;
  const { rate } = avgDailySpend();
  const cards = [
    ['Balance', `${money(bal)} <small>${cur()}</small>`, bal < 0 ? 'neg' : 'pos'],
    ['Runway', `${r.days === Infinity ? '∞' : money(r.days, 1)} <small>days</small>`, ''],
    ['Income (cycle)', `${money(income)} <small>${cur()}</small>`, 'pos'],
    ['Spent (cycle)', `${money(spent)} <small>${cur()}</small>`, ''],
    ['Net (cycle)', `${net >= 0 ? '+' : ''}${money(net)} <small>${cur()}</small>`, net >= 0 ? 'pos' : 'neg'],
    ['Avg / day', `${money(rate)} <small>${cur()}</small>`, '']
  ];
  grid.innerHTML = cards.map(([l, v, cls]) =>
    `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value ${cls}">${v}</div></div>`).join('');
}

function renderAlert() {
  const banner = $('#alertBanner');
  const lvl = alertLevel();
  if (lvl === 'good' || lvl === 'none') { banner.className = 'alert-banner hidden'; return; }
  banner.className = `alert-banner ${lvl}`;
  const r = runway();
  const p = cycleProjection();
  let msg;
  if (state.settings.startingBalance > 0 && state.settings.lowBalance > 0 && r.bal < state.settings.lowBalance)
    msg = `⚠ Low balance — ${money(r.bal)} ${cur()} left.`;
  else if (state.settings.startingBalance > 0 && p.elapsed >= RUNWAY_MIN_DAYS && r.bal > 0 && state.settings.runwayDays > 0 && r.days < state.settings.runwayDays)
    msg = `⚠ At this rate your money lasts ~${money(r.days, 1)} more days.`;
  else
    msg = `🔔 ${p.canProject ? `On pace to spend ${money(p.projected)} ${cur()} in budgeted categories` : `Already spent ${money(p.budgetedSpent)} ${cur()}`} this cycle — over your ${money(p.budget)} ${cur()} budget.`;
  banner.textContent = msg;
  maybeNotify(msg, lvl);
}

/* ---------- charts ---------- */
function renderCharts() { renderDailyChart(); renderCatChart(); }

function dailyBuckets() {
  const { start } = cycleBounds();
  const now = new Date();
  const days = [];
  let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let guard = 0;
  while (d <= today && guard++ < 40) {
    const ds = d.getTime(), de = ds + DAY;
    const spent = state.transactions
      .filter(x => x.type === 'expense' && t(x.t) >= ds && t(x.t) < de)
      .reduce((s, x) => s + x.amount, 0);
    days.push({ d: new Date(d), spent });
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return days;
}

function renderDailyChart() {
  const el = $('#dailyChart');
  const all = dailyBuckets();
  const data = all.slice(-21);
  const anySpend = data.some(x => x.spent > 0);
  $('#dailyChartHint').textContent = anySpend ? `${cycleLabel()}` : '';
  if (!anySpend) { el.innerHTML = `<div class="empty">Log expenses to see your daily spending.</div>`; return; }
  const W = 340, H = 160, pl = 34, pr = 10, pt = 12, pb = 26;
  const yMax = Math.max(...data.map(d => d.spent)) * 1.15 || 1;
  const Y = (v) => pt + (1 - v / yMax) * (H - pt - pb);
  const bw = (W - pl - pr) / data.length;
  let grid = '', ylab = '';
  for (let i = 0; i <= 2; i++) {
    const yv = yMax * i / 2, y = Y(yv);
    grid += `<line class="grid-line" x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}"/>`;
    ylab += `<text class="axis-label" x="${pl - 5}" y="${y + 3}" text-anchor="end">${money(yv, 0)}</text>`;
  }
  let bars = '', xl = '';
  data.forEach((d, i) => {
    const x = pl + i * bw + bw * 0.16, w = bw * 0.68, y = Y(d.spent);
    bars += `<rect class="bar" x="${x}" y="${y}" width="${w}" height="${Math.max(0, H - pb - y)}" rx="2"><title>${fmtDay(d.d)}: ${money(d.spent)} ${cur()}</title></rect>`;
    if (i === 0 || i === data.length - 1 || (data.length <= 8)) {
      xl += `<text class="axis-label" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${d.d.getDate()}</text>`;
    }
  });
  const avg = data.reduce((s, d) => s + d.spent, 0) / data.length;
  const ay = Y(avg);
  const avgLine = `<line class="bar-avg" x1="${pl}" y1="${ay}" x2="${W - pr}" y2="${ay}"/>
    <text class="axis-label" x="${W - pr}" y="${ay - 4}" text-anchor="end">avg ${money(avg, 0)}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${ylab}${bars}${avgLine}${xl}</svg>`;
}

function renderCatChart() {
  const el = $('#catChart');
  const map = spentByCategory();
  const rows = Object.keys(map).map(id => ({ cat: catById(id), amt: map[id] })).filter(r => r.cat && r.amt > 0)
    .sort((a, b) => b.amt - a.amt);
  const total = rows.reduce((s, r) => s + r.amt, 0);
  $('#catChartHint').textContent = total > 0 ? `${money(total)} ${cur()} total` : '';
  if (!rows.length) { el.innerHTML = `<div class="empty">Your spending by category will appear here.</div>`; return; }
  el.innerHTML = rows.slice(0, 7).map(r => {
    const pct = r.amt / total * 100;
    return `<div class="hbar-row">
      <div class="hbar-ic">${r.cat.icon || '•'}</div>
      <div class="hbar-body">
        <div class="hbar-top"><b>${escapeHtml(r.cat.name)}</b><span>${money(r.amt)} ${cur()} · ${Math.round(pct)}%</span></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${pct}%;background:${r.cat.color}"></div></div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- history ---------- */
function renderHistory() {
  const el = $('#historyList');
  const items = [...state.transactions].sort((a, b) => t(b.t) - t(a.t));
  $('#historyCount').textContent = `${state.transactions.length} entries`;
  if (!items.length) { el.innerHTML = `<div class="empty" style="color:var(--text-faint);padding:16px 0">No transactions yet.</div>`; return; }
  el.innerHTML = items.map(x => {
    const c = catById(x.categoryId);
    const sign = x.type === 'income' ? '+' : '−';
    return `<div class="hist-item">
      <div class="hist-icon" style="background:${c ? 'color-mix(in srgb,' + c.color + ' 20%, transparent)' : 'var(--bg-elev-2)'}">${c ? c.icon : '•'}</div>
      <div class="hist-main">
        <div class="hist-title">${c ? escapeHtml(c.name) : 'Uncategorised'}${x.note ? ' · ' + escapeHtml(x.note) : ''}</div>
        <div class="hist-sub">${fmtDateTime(x.t)} · ${relTime(x.t)}</div>
      </div>
      <div class="hist-amt ${x.type === 'income' ? 'pos' : 'neg'}">${sign}${money(x.amount)}</div>
      <button class="hist-del" data-del="${x.id}" aria-label="Delete">✕</button>
    </div>`;
  }).join('');
}

/* ---------- budgets ---------- */
function renderBudgets() {
  const spentMap = spentByCategory();
  const incMap = incomeByCategory();
  const spent = budgetedSpentThisCycle();
  const budget = totalBudget();
  $('#spentTotal').innerHTML = `${money(spent)} <small style="font-size:14px;color:var(--text-dim)">${cur()}</small>`;
  $('#budgetTotal').innerHTML = budget > 0
    ? `${money(budget)} <small style="font-size:14px;color:var(--text-dim)">${cur()}</small>`
    : `<small style="font-size:14px;color:var(--text-faint)">not set</small>`;
  const pct = budget > 0 ? spent / budget : 0;
  const prog = $('#budgetProgress');
  prog.style.width = Math.min(100, pct * 100) + '%';
  prog.style.background = barColor(pct);
  $('#budgetHint').textContent = budget > 0
    ? (pct >= 1 ? `You've used all of this cycle's budget.` : `${money(budget - spent)} ${cur()} left in the budget with ${Math.ceil(cycleProjection().daysLeft)} days to go.`)
    : `Set a monthly budget on your expense categories to track a target.`;

  const cats = [...state.categories].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'expense' ? -1 : 1;
    return (b.budget || 0) - (a.budget || 0) || (spentMap[b.id] || 0) - (spentMap[a.id] || 0);
  });
  $('#catList').innerHTML = cats.map(c => {
    if (c.type === 'income') {
      const got = incMap[c.id] || 0;
      return `<div class="cat-item" data-edit="${c.id}">
        <div class="cat-ic" style="background:color-mix(in srgb,${c.color} 20%, transparent)">${c.icon || '➕'}</div>
        <div class="cat-main"><div class="cat-name">${escapeHtml(c.name)}</div><div class="cat-sub">income this cycle</div></div>
        <div class="cat-right"><div class="cat-amt" style="color:var(--good)">+${money(got)}</div><span class="cat-badge">income</span></div>
      </div>`;
    }
    const sp = spentMap[c.id] || 0;
    const b = c.budget || 0;
    const p = b > 0 ? sp / b : 0;
    const bar = b > 0
      ? `<div class="cat-track"><div class="cat-fill" style="width:${Math.min(100, p * 100)}%;background:${barColor(p)}"></div></div>`
      : '';
    const right = b > 0
      ? `<div class="cat-amt">${money(sp)} / ${money(b)}</div><div class="cat-sub">${p >= 1 ? 'over by ' + money(sp - b) : money(b - sp) + ' left'}</div>`
      : `<div class="cat-amt">${money(sp)}</div><div class="cat-sub">no budget</div>`;
    return `<div class="cat-item" data-edit="${c.id}">
      <div class="cat-ic" style="background:color-mix(in srgb,${c.color} 20%, transparent)">${c.icon || '•'}</div>
      <div class="cat-main"><div class="cat-name">${escapeHtml(c.name)}</div>${bar}</div>
      <div class="cat-right">${right}</div>
    </div>`;
  }).join('');
}

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
function maybeNotify(msg, lvl) {
  if (!state.settings.notify || lvl === 'good' || lvl === 'none') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const key = 'budgettracker.lastNotify';
  const today = new Date().toDateString();
  if (localStorage.getItem(key) === today) return;
  localStorage.setItem(key, today);
  try {
    new Notification('BudgetTracker', { body: msg, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%92%B0%3C/text%3E%3C/svg%3E" });
  } catch (e) { }
}

/* ============================================================
   UI WIRING
   ============================================================ */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}
function navTo(view) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setNow(id) { $(id).value = toLocalInput(new Date()); }

/* ----- transaction form ----- */
let txType = 'expense';
function populateTxCategories() {
  const sel = $('#txCategory');
  const cats = state.categories.filter(c => c.type === txType);
  sel.innerHTML = cats.map(c => `<option value="${c.id}">${c.icon || ''} ${escapeHtml(c.name)}</option>`).join('');
}
function setTxType(type) {
  txType = type;
  $$('#typeToggle .seg').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  $('#txSubmit').textContent = type === 'income' ? 'Save income' : 'Save expense';
  populateTxCategories();
}

/* ----- category modal ----- */
let catType = 'expense';
let catColor = PALETTE[0];
function renderSwatches() {
  $('#swatches').innerHTML = PALETTE.map(c =>
    `<div class="swatch ${c === catColor ? 'sel' : ''}" data-color="${c}" style="background:${c}"></div>`).join('');
}
function setCatType(type) {
  catType = type;
  $$('#catTypeToggle .seg').forEach(b => b.classList.toggle('active', b.dataset.ctype === type));
  $('#budgetField').style.display = type === 'income' ? 'none' : '';
}
function openCategory(id) {
  const c = id ? catById(id) : null;
  $('#modalTitle').textContent = c ? 'Edit category' : 'Add category';
  $('#catId').value = c ? c.id : '';
  $('#catName').value = c ? c.name : '';
  $('#catIcon').value = c ? c.icon : '';
  $('#catBudget').value = c && c.budget ? c.budget : '';
  catColor = c ? c.color : PALETTE[0];
  setCatType(c ? c.type : 'expense');
  renderSwatches();
  $('#catDelete').style.display = c ? '' : 'none';
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

/* ----- settings form ----- */
function loadSettingsForm() {
  const s = state.settings;
  $('#setStartBal').value = s.startingBalance || '';
  const msSel = $('#setMonthStart');
  msSel.innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  msSel.value = s.monthStartDay;
  $('#setWindow').value = s.window;
  $('#setCurrency').value = s.currency;
  $('#setLowBal').value = s.lowBalance || '';
  $('#setRunwayDays').value = s.runwayDays || '';
  $('#setOverBudget').checked = s.overBudgetWarn;
  $('#setNotify').checked = s.notify;
  $('#balNote').textContent = 'Set this once to your real cash/M-Pesa total; transactions adjust it from here.';
}

function initUI() {
  setNow('#txTime');
  setTxType('expense');

  $$('#typeToggle .seg').forEach(b => b.addEventListener('click', () => setTxType(b.dataset.type)));
  $$('#catTypeToggle .seg').forEach(b => b.addEventListener('click', () => setCatType(b.dataset.ctype)));

  // transaction submit
  $('#txForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseFloat($('#txAmount').value);
    const categoryId = $('#txCategory').value;
    const time = $('#txTime').value;
    if (isNaN(amount) || amount <= 0 || !categoryId || !time) return;
    state.transactions.push({ id: uid(), t: time, amount, categoryId, type: txType, note: $('#txNote').value.trim() });
    save(); render();
    $('#txAmount').value = ''; $('#txNote').value = ''; setNow('#txTime');
    toast(txType === 'income' ? 'Income saved' : 'Expense saved');
    navTo('dashboard');
  });

  // history delete
  $('#historyList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    if (b && confirm('Delete this transaction?')) {
      state.transactions = state.transactions.filter(x => x.id !== b.dataset.del);
      save(); render();
    }
  });

  // category list / add
  $('#addCatBtn').addEventListener('click', () => openCategory(null));
  $('#catList').addEventListener('click', (e) => {
    const it = e.target.closest('[data-edit]');
    if (it) openCategory(it.dataset.edit);
  });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#swatches').addEventListener('click', (e) => {
    const s = e.target.closest('[data-color]');
    if (s) { catColor = s.dataset.color; renderSwatches(); }
  });
  $('#catForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#catId').value;
    const data = {
      name: $('#catName').value.trim(),
      type: catType,
      icon: $('#catIcon').value.trim(),
      color: catColor,
      budget: catType === 'expense' ? (parseFloat($('#catBudget').value) || 0) : 0
    };
    if (!data.name) return;
    if (id) Object.assign(catById(id), data);
    else state.categories.push({ id: uid(), ...data });
    save(); render(); populateTxCategories(); closeModal(); toast('Category saved');
  });
  $('#catDelete').addEventListener('click', () => {
    const id = $('#catId').value;
    if (!id) return;
    const used = state.transactions.some(x => x.categoryId === id);
    const msg = used ? 'This category has transactions. Delete the category anyway? (Transactions are kept but shown as uncategorised.)' : 'Delete this category?';
    if (confirm(msg)) {
      state.categories = state.categories.filter(x => x.id !== id);
      save(); render(); populateTxCategories(); closeModal(); toast('Deleted');
    }
  });

  // settings
  loadSettingsForm();
  const saveSettings = () => {
    state.settings.startingBalance = parseFloat($('#setStartBal').value) || 0;
    state.settings.monthStartDay = parseInt($('#setMonthStart').value, 10) || 1;
    state.settings.window = parseInt($('#setWindow').value, 10);
    state.settings.currency = $('#setCurrency').value.trim() || 'MT';
    state.settings.lowBalance = parseFloat($('#setLowBal').value) || 0;
    state.settings.runwayDays = parseFloat($('#setRunwayDays').value) || 0;
    state.settings.overBudgetWarn = $('#setOverBudget').checked;
  };
  $('#settingsForm').addEventListener('change', () => { saveSettings(); save(); render(); });
  $('#alertForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
    const wantNotify = $('#setNotify').checked;
    if (wantNotify && 'Notification' in window && Notification.permission !== 'granted') {
      Notification.requestPermission().then(p => {
        state.settings.notify = (p === 'granted');
        $('#setNotify').checked = state.settings.notify;
        save(); render();
      });
    } else { state.settings.notify = wantNotify; }
    save(); render(); toast('Settings saved');
  });

  // backup
  $('#exportBtn').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', importData);
  $('#resetBtn').addEventListener('click', () => {
    if (confirm('Delete ALL transactions, categories and settings on this device? This cannot be undone.')) {
      localStorage.removeItem(STORE_KEY);
      state = firstRunData();
      save(); loadSettingsForm(); setTxType('expense'); render(); navTo('dashboard');
      toast('All data reset');
    }
  });

  // nav
  $$('.tab').forEach(b => b.addEventListener('click', () => navTo(b.dataset.nav)));
  $('#quickAddBtn').addEventListener('click', () => { navTo('log'); setTimeout(() => $('#txAmount').focus(), 200); });
}

/* ---------- backup ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `budgettracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Backup downloaded');
}
function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object') throw new Error('bad');
      state = {
        version: 1,
        settings: Object.assign(defaultSettings(), data.settings || {}),
        categories: data.categories || [],
        transactions: data.transactions || []
      };
      save(); loadSettingsForm(); setTxType('expense'); render(); navTo('dashboard');
      toast('Data imported');
    } catch (err) { toast('Import failed — invalid file'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/* ---------- boot ---------- */
initUI();
render();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

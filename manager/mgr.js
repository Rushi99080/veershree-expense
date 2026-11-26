/* =========================================================
   Veershree Manager — a manager's own expense book
   The manager fills what he spent (site-wise) and the money he received.
   It writes the same entries as the Site Manager app (Expense log of the
   site, and the manager's cash book), so they show up there by themselves,
   marked Pending until the admin approves them.
   ========================================================= */
import { createCloud, safeId } from '../cloud.js?v=3.2.0';
import { pickPhoto, toJpeg, readBillPhoto, matchName } from '../ai.js?v=1.0.0';

const VERSION = '1.0';
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', accountant: 'Accountant', viewer: 'Viewer', supervisor: 'Supervisor', bot: 'Reminder robot' };
const CAN_ENTER = ['manager', 'admin'];
const MODES = ['Cash', 'Online / UPI', 'RTGS / NEFT', 'Cheque'];
const KIND = { expenseLog: 'Expense', dieselLog: 'Diesel', vendorPayments: 'Vendor payment', murumLog: 'Murum', ownerPayments: 'Machine owner payment', mfund: 'Money received' };

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
const has = v => v !== '' && v != null;
const num = v => { if (typeof v === 'string') v = v.replace(/[,\s₹]/g, ''); const n = parseFloat(v); return isFinite(n) ? n : 0; };
const numOrBlank = v => (String(v).trim() === '' ? '' : num(v));
const money = v => (num(v) < 0 ? '-' : '') + '₹' + Math.round(Math.abs(num(v))).toLocaleString('en-IN');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}`; };
const dayLabel = s => {
  if (!s) return 'No date';
  const t = today(); if (s === t) return 'Today';
  const [y, m, d] = s.split('-').map(Number), dt = new Date(y, m - 1, d);
  if (ymd(new Date(Date.now() - 864e5)) === s) return 'Yesterday';
  return DOW[dt.getDay()] + ', ' + d + ' ' + MON[m - 1] + (String(y) !== t.slice(0, 4) ? ' ' + y : '');
};
const splitMeta = d => { const b = {}, m = {}; for (const k in d) (k[0] === '_' ? m : b)[k] = d[k]; return [b, m]; };
const isPaid = d => String(d.status || '').trim().toLowerCase() === 'paid';
const initial = s => (String(s || '?').trim().charAt(0) || '?').toUpperCase();
/* every way the same name may have been typed: Suhas sir / Suhas Sir / SUHAS SIR */
const variants = n => { const t = String(n || '').trim().replace(/\s+/g, ' '), l = t.toLowerCase(); return [...new Set([t, l, l.replace(/\b\w/g, c => c.toUpperCase()), t.toUpperCase(), l.charAt(0).toUpperCase() + l.slice(1)])].filter(Boolean); };
let toastT = 0;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }

/* ---------- state ---------- */
const ME = { uid: '', email: '', name: '', role: '', sites: [], person: '', active: false };
let CLOUD = null, profUnsub = null, siteUnsub = [], dataUnsub = [], STARTED = false;
let PERSON = '', MGRS = [];
let SITES = new Map();               // site key -> site document (name, categories, vendors)
let ENT = new Map();                 // site key -> [{ path, data, pending }]   entries "Paid by" this person
let FUNDS = [], FUNDS_IN = false;    // money received (the cash book)
let SNAP = new Map();                // listener -> { fromCache, pending }
let PER = 'month', TYPE = 'all', SITEF = 'all', SHOW = 80;
let PEND = 0, ONLINE = navigator.onLine, SEQ = 0, RULES4 = null;
let EDIT = null;

const isAdmin = () => ME.role === 'admin';
const siteName = sk => (SITES.get(sk) || {}).name || 'Site';
const canEdit = e => e && (isAdmin() || (e.data._by === ME.uid && e.data._appr !== 'approved'));
const canDelete = e => e && (isAdmin() || (e.data._by === ME.uid && e.data._appr !== 'approved'));

/* ---------- gate (login and messages) ---------- */
function gate(inner) {
  const g = $('#gate');
  g.innerHTML = `<div class="g-card"><div class="g-brand"><img src="icons/icon-192.png" alt=""><b>Manager</b><small>Veershree</small></div>${inner}</div>`;
  g.hidden = false; document.body.classList.add('gated');
  const f = g.querySelector('form');
  if (f) f.addEventListener('submit', e => { e.preventDefault(); const fn = FORMS[f.dataset.form]; if (fn) fn(Object.fromEntries(new FormData(f).entries())); });
}
function hideGate() { const g = $('#gate'); g.hidden = true; g.innerHTML = ''; document.body.classList.remove('gated'); }
const gErr = m => { const e = $('#gErr'); if (e) e.textContent = m || ''; const b = $('#gate button[type=submit]'); if (b) b.disabled = false; };
const fld = (label, name, type, attrs) => `<label class="field"><span>${label}</span><input name="${name}" type="${type || 'text'}" ${attrs || ''}></label>`;
function authMsg(e) {
  const c = (e && e.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return 'Wrong email or password.';
  if (/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes and try again.';
  if (/network-request-failed/.test(c)) return 'No internet. The first sign-in on a phone needs the internet.';
  if (/permission-denied/.test(c)) return 'Not allowed for your login.';
  return (e && e.message) || 'Something went wrong.';
}
function gateLogin(msg) {
  gate(`<form data-form="login" novalidate><h2>Sign in</h2>${fld('Email', 'email', 'email', 'autocomplete="username" required')}${fld('Password', 'pass', 'password', 'autocomplete="current-password" required')}
    <p class="g-err" id="gErr">${esc(msg || '')}</p><button class="btn" type="submit">Sign in</button><button class="btn sec" type="button" data-a="forgot">Forgot password?</button>
    <p class="tiny" style="margin-top:14px">Your login is made by the admin in the Site Manager app (Users → Site Manager).</p></form>`);
}
const gateText = (t, html, withSignOut) => gate(`<h2>${esc(t)}</h2><p class="g-msg">${html}</p><button class="btn sec" data-a="reload">Check again</button>${withSignOut ? '<button class="btn sec" data-a="signOut">Sign out</button>' : ''}`);
const FORMS = {
  async login(v) {
    if (!v.email || !v.pass) return gErr('Enter your email and password.');
    const b = $('#gate button[type=submit]'); if (b) b.disabled = true;
    try { await CLOUD.signIn(v.email, v.pass); } catch (e) { gErr(authMsg(e)); }
  },
  async pass(v) {
    if ((v.n1 || '').length < 6) return toast('New password: at least 6 characters');
    if (v.n1 !== v.n2) return toast('The two new passwords are not the same');
    try { await CLOUD.changePassword(v.old, v.n1); closeSheet(); toast('Password changed'); } catch (e) { toast(authMsg(e)); }
  }
};

/* ---------- login and profile ---------- */
async function onUser(u) {
  if (profUnsub) { profUnsub(); profUnsub = null; }
  stopAll();
  if (!u) { STARTED = false; gateLogin(''); return; }
  ME.uid = u.uid; ME.email = u.email;
  gate('<p class="g-msg">Opening…</p>');
  profUnsub = CLOUD.watchProfile(u.uid, p => onProfile(p, u), e => gate(`<p class="g-msg">Could not read your login: ${esc(authMsg(e))}</p><button class="btn" data-a="reload">Try again</button><button class="btn sec" data-a="signOut">Sign out</button>`));
}
const sig = p => [p.role, (p.sites || []).slice().sort().join(','), p.person || '', p.active].join('|');
async function onProfile(p, u) {
  if (!p) return gateText('Almost there', `You are signed in as <b>${esc(u.email)}</b>, but the admin has not given this login access yet. Ask the admin to add you as <b>Site Manager</b> in Users.`, true);
  if (STARTED && sig(p) !== sig(ME)) { location.reload(); return; }
  Object.assign(ME, { name: p.name || u.email, email: p.email || u.email, role: p.role, sites: Array.isArray(p.sites) ? p.sites : [], person: String(p.person || '').trim(), active: p.active === true });
  if (!ME.active) return gateText('Login switched off', `The admin has switched off <b>${esc(ME.email)}</b>.`, true);
  if (!CAN_ENTER.includes(ME.role)) {
    const sup = ME.role === 'supervisor';
    return gate(`<h2>Not for this login</h2><p class="g-msg">${esc(ROLE_LABEL[ME.role] || ME.role)} logins do not have an expense book.${sup ? ' Use the Supervisor app for machine readings.' : ' Use the Site Manager app.'}</p><a class="btn" href="../${sup ? 'supervisor/' : ''}">${sup ? 'Open the Supervisor app' : 'Open Site Manager'}</a><button class="btn sec" data-a="signOut">Sign out</button>`);
  }
  if (!isAdmin() && !ME.person) return gateText('No cash book yet', 'Your login has no cash book name yet. Ask the admin: Site Manager → Menu → <b>Users</b> → your name → <b>Cash book</b>.', true);
  if (!isAdmin() && !ME.sites.length) return gateText('No site yet', 'The admin has not given you a site yet. Ask the admin to tick your sites in <b>Users</b>.', true);
  if (STARTED) return;
  STARTED = true;
  if (isAdmin()) {
    try { const app = await CLOUD.getDocServer('sm_meta/app'); MGRS = ((app && app.managers) || []).map(m => String(m.name || '').trim()).filter(Boolean); } catch (e) { MGRS = []; }
    let want = ''; try { want = localStorage.getItem('vmgr:person:' + ME.uid) || ''; } catch (e) { }
    PERSON = MGRS.find(n => norm(n) === norm(want)) || MGRS.find(n => norm(n) === norm(ME.name)) || MGRS[0] || ME.name;
  } else PERSON = ME.person;
  CLOUD.rulesOk('v4').then(v => { RULES4 = v; }).catch(() => { });
  watchSites();
}
function stopData() { dataUnsub.forEach(f => { try { f(); } catch (e) { } }); dataUnsub = []; ENT = new Map(); FUNDS = []; FUNDS_IN = false; SNAP = new Map(); LISTENING = new Set(); }
function stopAll() { siteUnsub.forEach(f => { try { f(); } catch (e) { } }); siteUnsub = []; stopData(); SITES = new Map(); }

/* ---------- sites, then this person's entries ---------- */
let firstSites = true, LISTENING = new Set();
function gotSites() {
  if (!SITES.size) return;
  if (firstSites) { firstSites = false; hideGate(); startData(); }
  else { for (const sk of SITES.keys()) listenSite(sk); render(); }
}
function watchSites() {
  gate('<p class="g-msg">Loading your sites…</p><p class="tiny">The first time on a phone this needs the internet.</p>');
  const onErr = e => { if (!SITES.size) gate(`<h2>Could not open your sites</h2><p class="g-msg">${esc(e && e.code === 'permission-denied' ? 'Your login is not allowed to read these sites. Ask the admin to check your sites in Users.' : 'Check the internet and try again.')}</p><button class="btn" data-a="reload">Try again</button><button class="btn sec" data-a="signOut">Sign out</button>`); };
  if (isAdmin()) {
    siteUnsub.push(CLOUD.watchSites(list => { SITES = new Map(list.filter(x => !x.data._del && !x.data._test).map(x => [x.path.split('/')[1], x.data])); gotSites(); }, onErr));
  } else {
    for (const id of ME.sites) {
      const sk = safeId(id);
      siteUnsub.push(CLOUD.watchDoc('sm_sites/' + sk, d => { if (d && !d._del) SITES.set(sk, d); else SITES.delete(sk); gotSites(); }, onErr));
    }
  }
}
function listenSite(sk) {
  if (LISTENING.has(sk)) return; LISTENING.add(sk);
  dataUnsub.push(CLOUD.watchPaidBy(sk, variants(PERSON), (list, meta) => {
    ENT.set(sk, list); SNAP.set('e:' + sk, meta); render();
  }, e => { ENT.set(sk, ENT.get(sk) || []); SNAP.set('e:' + sk, { fromCache: true }); toast(e && e.code === 'permission-denied' ? 'Your login cannot read ' + siteName(sk) + '.' : 'Sync problem: ' + ((e && e.code) || 'unknown')); render(); }));
}
function startData() {
  stopData();
  for (const sk of SITES.keys()) listenSite(sk);
  dataUnsub.push(CLOUD.watchMfunds(PERSON, (list, meta) => { FUNDS = list; FUNDS_IN = true; SNAP.set('f', meta); render(); },
    e => { FUNDS_IN = true; toast(e && e.code === 'permission-denied' ? 'Your login cannot read the cash book. Ask the admin to check your cash book name.' : 'Sync problem: ' + ((e && e.code) || 'unknown')); render(); }));
  render();
}

/* ---------- this person's money, as one list ---------- */
function items() {
  const out = [];
  for (const [sk, list] of ENT) {
    if (!SITES.has(sk)) continue;
    for (const e of list) {
      const d = e.data, c = d._c;
      if (d._del || d._test || norm(d.paidBy) !== norm(PERSON)) continue;
      let amt = 0, title = '', cat = '';
      if (c === 'expenseLog') { if (!isPaid(d)) continue; amt = num(d.amount); title = d.desc || d.category || 'Expense'; cat = d.category || 'Expense'; }
      else if (c === 'dieselLog') { if (!isPaid(d)) continue; amt = num(d.amount); title = 'Diesel' + (d.vendor ? ' · ' + d.vendor : ''); cat = 'Diesel'; }
      else if (c === 'vendorPayments') { amt = num(d.amount); title = d.vendor || 'Vendor payment'; cat = 'Vendor payments'; }
      else if (c === 'murumLog') { if (!isPaid(d)) continue; amt = has(d.amount) && num(d.amount) ? num(d.amount) : num(d.qty) * num(d.rate); title = 'Murum' + (d.vendor ? ' · ' + d.vendor : ''); cat = 'Murum'; }
      else if (c === 'ownerPayments') { amt = num(d.amount); title = d.owner || 'Owner payment'; cat = 'Machine owner payments'; }
      else continue;
      out.push({ t: 'out', c, e, sk, date: d.date || '', amt, title, cat });
    }
  }
  for (const e of FUNDS) { const d = e.data; if (d._del || d._test) continue; out.push({ t: 'in', c: 'mfund', e, sk: '', date: d.date || '', amt: num(d.amount), title: 'Money received', cat: '' }); }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.e.data._i || 0) - (a.e.data._i || 0));
  return out;
}
function periods() {
  const t = today(), mk = t.slice(0, 7), y = +mk.slice(0, 4), m = +mk.slice(5, 7);
  const lk = m === 1 ? (y - 1) + '-12' : y + '-' + pad(m - 1);
  return { month: ['This month', MONTH[m - 1] + ' ' + y, d => String(d).slice(0, 7) === mk], last: ['Last month', MONTH[(m + 10) % 12] + ' ' + lk.slice(0, 4), d => String(d).slice(0, 7) === lk], all: ['All', 'All entries', () => true] };
}
const findItem = path => items().find(x => x.e.path === path);
const loading = () => !FUNDS_IN || [...SITES.keys()].some(sk => !ENT.has(sk));

/* ---------- writing ---------- */
function track(job, okMsg) {
  PEND++; pill();
  if (okMsg) toast(okMsg);
  job.then(() => { PEND--; pill(); }, e => { PEND--; pill(); render(); toast(e && e.code === 'permission-denied' ? 'The online database refused this change for your login. It was undone.' : 'Could not save online: ' + ((e && (e.code || e.message)) || 'error')); });
}
const savedMsg = () => ONLINE ? 'Saved' : 'Saved on this phone — uploads when the network is back';
function newMeta(coll, s) {
  const now = Date.now();
  const m = { _c: coll, _i: now * 1000 + (SEQ++ % 1000), _by: ME.uid, _byName: ME.name, _at: now, _appr: isAdmin() ? 'approved' : 'pending', _ubName: ME.name };
  if (s) m._s = String(s.id);
  return m;
}
function addExpense(sk, biz) {
  const s = SITES.get(sk); if (!s) return;
  const id = uid();
  track(CLOUD.commit([{ type: 'set', path: `sm_sites/${sk}/entries/expenseLog_${safeId(id)}`, data: { id, ...biz, ...newMeta('expenseLog', s) } }]), savedMsg());
}
function addFund(biz) {
  const id = uid();
  track(CLOUD.commit([{ type: 'set', path: 'sm_mfunds/' + safeId(id), data: { id, ...biz, ...newMeta('mfund', null) } }]), savedMsg());
}
function editDoc(e, biz) {
  const [old] = splitMeta(e.data), patch = { _ubName: ME.name };
  for (const k of Object.keys(biz)) if (JSON.stringify(old[k]) !== JSON.stringify(biz[k])) patch[k] = biz[k];
  if (Object.keys(patch).length === 1) { toast('Nothing changed'); return false; }
  if (!isAdmin()) patch._appr = 'pending';
  track(CLOUD.commit([{ type: 'patch', path: e.path, data: patch }]), 'Saved');
  return true;
}
async function removeDoc(e) {
  if (!isAdmin()) {
    if (RULES4 !== true) RULES4 = await CLOUD.rulesOk('v4').catch(() => null);
    if (RULES4 === false) return toast('Removing needs the new Firebase rules. Ask the admin to update them (Site Manager shows the steps on its Home screen).');
  }
  if (!confirm('Remove this entry?')) return;
  track(CLOUD.commit([{ type: 'patch', path: e.path, data: { _del: true, _delBy: ME.uid, _delByName: ME.name, _delAt: Date.now(), _appr: isAdmin() ? (e.data._appr || 'approved') : 'pending', _ubName: ME.name } }]), 'Entry removed');
  EDIT = null; closeSheet();
}

/* ---------- sync status ---------- */
function pillState() {
  const anyPending = PEND > 0 || [...SNAP.values()].some(m => m && m.pending);
  if (!ONLINE) return ['off', 'Offline', anyPending ? 'Saved on this phone. Uploads when the network is back.' : 'No network. You can keep adding entries.'];
  if (anyPending) return ['sync', 'Syncing…', 'Uploading…'];
  return ['ok', 'Saved', 'Everything is saved online.'];
}
function pill() { const [s, t, title] = pillState(); const el = $('#pill'); if (el) { el.dataset.s = s; el.textContent = t; el.title = title; } }
window.addEventListener('online', () => { ONLINE = true; pill(); });
window.addEventListener('offline', () => { ONLINE = false; pill(); });

/* ---------- screens ---------- */
function badge(e) {
  if (e.pending) return '<span class="bdg wait">Not uploaded</span>';
  if (e.data._appr === 'pending') return '<span class="bdg pend">Pending</span>';
  return '<span class="bdg ok">Approved</span>';
}
function render() {
  if (!STARTED || firstSites) return;
  const all = items(), wait = loading();
  const got = all.filter(x => x.t === 'in').reduce((a, x) => a + x.amt, 0), spent = all.filter(x => x.t === 'out').reduce((a, x) => a + x.amt, 0), bal = got - spent;
  $('#top').innerHTML = `<div class="bar">
      <button class="who" data-a="${isAdmin() ? 'person' : 'menu'}"><img src="icons/icon-192.png" alt=""><span><small>${esc(isAdmin() ? 'Admin · expense book of' : 'Veershree · ' + (ROLE_LABEL[ME.role] || ''))}</small><b>${esc(PERSON)}${isAdmin() ? ' <i class="chev">▾</i>' : ''}</b></span></button>
      <button class="pill" id="pill" data-a="pillInfo"></button>
      <button class="ava" data-a="menu" aria-label="Menu">${esc(initial(ME.name))}</button></div>
    <div class="bal${bal < 0 ? ' neg' : ''}"><small>${bal < 0 ? 'Spent more than received' : 'In hand'}</small><b>${wait && !all.length ? '…' : money(bal)}</b>
      <div class="bal2"><span>Received <b>${money(got)}</b></span><span>Spent <b>${money(spent)}</b></span></div></div>
    <div class="acts"><button class="btn gold" data-a="addExp">+ Expense</button><button class="btn dk" data-a="addGot">+ Money received</button></div>`;
  pill();
  const P = periods(), per = P[PER] || P.month;
  const siteKeys = [...SITES.keys()];
  let list = all.filter(x => per[2](x.date));
  if (SITEF !== 'all') list = list.filter(x => x.sk === SITEF);
  const pSpent = list.filter(x => x.t === 'out').reduce((a, x) => a + x.amt, 0), pGot = list.filter(x => x.t === 'in').reduce((a, x) => a + x.amt, 0);
  const nPend = list.filter(x => x.e.pending || x.e.data._appr === 'pending').length;
  if (TYPE === 'exp') list = list.filter(x => x.t === 'out');
  else if (TYPE === 'got') list = list.filter(x => x.t === 'in');
  else if (TYPE === 'pend') list = list.filter(x => x.e.pending || x.e.data._appr === 'pending');
  const shown = list.slice(0, SHOW);
  let rows = '', cur = null;
  const dayTot = {}; list.forEach(x => { if (x.t === 'out') dayTot[x.date] = (dayTot[x.date] || 0) + x.amt; });
  for (const x of shown) {
    if (x.date !== cur) { cur = x.date; rows += `${rows ? '</div>' : ''}<h3 class="gh"><span>${esc(dayLabel(x.date))}</span>${dayTot[x.date] ? `<small>spent ${money(dayTot[x.date])}</small>` : ''}</h3><div class="card">`; }
    const d = x.e.data;
    const sub = x.t === 'in' ? [d.from ? 'from ' + d.from : '', d.mode, d.remark].filter(Boolean).join(' · ') || 'Cash book'
      : [x.c === 'expenseLog' ? x.cat : KIND[x.c], siteKeys.length > 1 ? siteName(x.sk) : '', d.mode, x.c !== 'expenseLog' ? 'entered by office' : ''].filter(Boolean).join(' · ');
    rows += `<button class="mrow" data-a="open" data-v="${esc(x.e.path)}"><span class="mic ${x.t === 'in' ? 'in' : x.c === 'expenseLog' ? '' : 'o'}">${x.t === 'in' ? '+' : esc(initial(x.cat))}</span><span class="m"><b>${esc(x.title)}</b><small>${esc(sub)}</small></span><div class="r"><b class="${x.t === 'in' ? 'plus' : ''}">${x.t === 'in' ? '+' : ''}${money(x.amt)}</b>${badge(x.e)}</div></button>`;
  }
  if (rows) rows += '</div>';
  const chip = (a, v, cur, l) => `<button class="${cur === v ? 'on' : ''}" data-a="${a}" data-v="${v}">${l}</button>`;
  $('#main').innerHTML = `
    <div class="chips">${Object.entries(P).map(([k, p]) => chip('per', k, PER, p[0])).join('')}</div>
    ${siteKeys.length > 1 ? `<div class="chips">${chip('sitef', 'all', SITEF, 'All sites')}${siteKeys.map(sk => chip('sitef', sk, SITEF, esc(siteName(sk)))).join('')}</div>` : ''}
    <section class="sum"><div><b>${money(pSpent)}</b><span>Spent · ${esc(per[1])}</span></div><div><b class="plus">${money(pGot)}</b><span>Received${SITEF !== 'all' ? ' <i>(no site)</i>' : ''}</span></div></section>
    <div class="chips">${chip('type', 'all', TYPE, 'All')}${chip('type', 'exp', TYPE, 'Expenses')}${chip('type', 'got', TYPE, 'Received')}${chip('type', 'pend', TYPE, 'Pending' + (nPend ? ' (' + nPend + ')' : ''))}</div>
    ${rows || `<div class="card empty">${wait ? 'Loading your entries…' : (PER === 'all' && TYPE === 'all' && SITEF === 'all' ? 'No entries yet. Tap <b>+ Expense</b> when you spend money, and <b>+ Money received</b> when the office gives you money.' : 'Nothing here for this filter.')}</div>`}
    ${list.length > SHOW ? `<button class="btn sec" data-a="more">Show ${Math.min(100, list.length - SHOW)} more</button>` : ''}
    ${all.length ? '<button class="btn wa" data-a="report">Share statement on WhatsApp</button>' : ''}
    <p class="tiny center">${isAdmin() ? 'Your entries are saved as approved.' : 'New entries go to the admin for approval. You can change them until then.'}</p>`;
}

/* ---------- sheets ---------- */
function openSheet(title, body) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="sh-bg" data-a="close"></div><div class="sh"><div class="sh-h"><h2>${title}</h2><button class="x" data-a="close" aria-label="Close">✕</button></div><div class="sh-b">${body}</div></div>`;
  sh.hidden = false; document.body.classList.add('sheet-open');
  const f = sh.querySelector('form'); if (f) f.addEventListener('submit', e => { e.preventDefault(); const fn = FORMS[f.dataset.form]; if (fn) fn(Object.fromEntries(new FormData(f).entries())); });
}
function closeSheet() { const sh = $('#sheet'); sh.hidden = true; sh.innerHTML = ''; document.body.classList.remove('sheet-open'); }
const inp = (label, id, val, attrs) => `<label class="field"><span>${label}</span><input id="${id}" value="${esc(has(val) ? val : '')}" ${attrs || ''}></label>`;
const vOf = id => { const e = document.getElementById(id); return e ? e.value : ''; };
const opts = (list, sel, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : '') + list.map(v => `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
const whoLine = e => `<p class="who">${badge(e)} ${e.data._by === ME.uid ? 'Entered by you' : 'Entered by ' + esc(e.data._byName || 'the office')}${e.data._appr === 'approved' && !isAdmin() ? ' · approved, only the admin can change it now' : ''}</p>`;
function lastSite() {
  let want = ''; try { want = localStorage.getItem('vmgr:site:' + ME.uid) || ''; } catch (e) { }
  return SITES.has(want) ? want : [...SITES.keys()][0];
}
function catsOf(s, keep) { return [...new Set([...((s && s.categories) || []), keep].filter(Boolean))]; }
function vendorsOf(s, keep) { return [...new Set([...((s && s.vendors) || []), keep].filter(Boolean))]; }

function expenseSheet(it, keep) {
  const e = it ? it.e : null, d = e ? e.data : {};
  const ro = e && !canEdit(e);
  const sk = it ? it.sk : (keep && keep.sk) || (SITEF !== 'all' && SITES.has(SITEF) ? SITEF : lastSite());
  const s = SITES.get(sk);
  const keys = [...SITES.keys()];
  EDIT = { kind: 'exp', e, sk };
  openSheet(e ? 'Expense' : 'New expense', `
    ${e ? whoLine(e) : ''}
    ${ro ? '' : '<button class="btn sec scan" data-a="scanBill">📷 Read bill photo</button><div id="smRead"></div>'}
    <fieldset ${ro ? 'disabled' : ''}>
    ${keys.length > 1 ? `<label class="field"><span>Site</span><select id="f_site" ${e ? 'disabled' : ''}>${keys.map(k => `<option value="${esc(k)}"${k === sk ? ' selected' : ''}>${esc(siteName(k))}</option>`).join('')}</select></label>` : ''}
    <div class="f2">${inp('Date', 'f_date', d.date || (keep && keep.date) || today(), `type="date" max="${today()}"`)}${inp('Amount (₹)', 'f_amt', d.amount, 'type="number" inputmode="decimal" step="any" placeholder="0"')}</div>
    <label class="field"><span>Category</span><select id="f_cat">${opts(catsOf(s, d.category), d.category, '— choose —')}</select></label>
    ${inp('What for', 'f_desc', d.desc, 'placeholder="e.g. tea for labour, cement bags" autocomplete="off"')}
    <div class="f2"><label class="field"><span>Payment mode</span><select id="f_mode">${opts(MODES, d.mode || (keep && keep.mode) || 'Cash')}</select></label>
      <label class="field"><span>Paid to <i>optional</i></span><select id="f_v">${opts(vendorsOf(s, d.vendor), d.vendor || '', '— none —')}</select></label></div>
    ${inp('Remark <i>optional</i>', 'f_rem', d.remark, 'autocomplete="off"')}
    </fieldset>
    ${ro ? '' : `<button class="btn" data-a="saveExp">${e ? 'Save changes' : 'Save'}</button>${e ? '' : '<button class="btn sec" data-a="saveExpMore">Save and add another</button>'}`}
    ${e && canDelete(e) ? '<button class="btn dgr" data-a="del">Remove this entry</button>' : ''}
    ${!e ? `<p class="tiny">${isAdmin() ? 'Saved as approved' : 'Goes to the admin for approval'} · shows in Site Manager under the site’s Expenses, Paid by ${esc(PERSON)}.</p>` : ''}`);
  const sel = document.getElementById('f_site');
  if (sel) sel.addEventListener('change', () => {
    const ns = SITES.get(sel.value), c = vOf('f_cat'), v = vOf('f_v');
    $('#f_cat').innerHTML = opts(catsOf(ns, ''), (ns && (ns.categories || []).includes(c)) ? c : '', '— choose —');
    $('#f_v').innerHTML = opts(vendorsOf(ns, ''), (ns && (ns.vendors || []).includes(v)) ? v : '', '— none —');
  });
  if (!e) setTimeout(() => { const a = document.getElementById('f_amt'); if (a) a.focus(); }, 250);
}
function saveExpense(again) {
  const { e } = EDIT;
  const sk = e ? EDIT.sk : (vOf('f_site') || EDIT.sk);
  if (!SITES.has(sk)) return toast('Choose the site');
  const date = vOf('f_date'); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Choose the date');
  if (date > today()) return toast('The date is in the future');
  const amount = numOrBlank(vOf('f_amt')); if (!has(amount) || amount <= 0) return toast('Enter the amount');
  const category = vOf('f_cat'); if (!category) return toast('Choose the category');
  const base = e ? splitMeta(e.data)[0] : {};
  const o = { date, category, desc: vOf('f_desc').trim(), vendor: vOf('f_v'), amount, status: 'Paid', paidBy: e ? (base.paidBy || PERSON) : PERSON, mode: vOf('f_mode'), remark: vOf('f_rem').trim(), xl: !!base.xl };
  if (!e) {
    const twin = items().find(x => x.c === 'expenseLog' && x.sk === sk && x.date === date && Math.abs(x.amt - amount) < 0.5 && x.cat === category);
    if (twin && !confirm(`${money(amount)} for ${category} on ${fmtDate(date)} is already entered${twin.e.data.desc ? ' (' + twin.e.data.desc + ')' : ''}. Save it again?`)) return;
    addExpense(sk, o);
  } else if (!editDoc(e, o)) return;
  try { localStorage.setItem('vmgr:site:' + ME.uid, sk); } catch (x) { }
  if (again) expenseSheet(null, { sk, date, mode: o.mode });
  else { EDIT = null; closeSheet(); }
}
function gotSheet(it) {
  const e = it ? it.e : null, d = e ? e.data : {};
  const ro = e && !canEdit(e);
  const froms = [...new Set(FUNDS.map(x => String(x.data.from || '').trim()).filter(Boolean))].slice(0, 12);
  EDIT = { kind: 'got', e };
  openSheet(e ? 'Money received' : 'New money received', `
    ${e ? whoLine(e) : ''}
    <fieldset ${ro ? 'disabled' : ''}>
    <div class="f2">${inp('Date', 'f_date', d.date || today(), `type="date" max="${today()}"`)}${inp('Amount (₹)', 'f_amt', d.amount, 'type="number" inputmode="decimal" step="any" placeholder="0"')}</div>
    ${inp('From (who gave it)', 'f_from', d.from, 'list="fromList" placeholder="e.g. Office, Aryan sir" autocomplete="off"')}<datalist id="fromList">${froms.map(f => `<option value="${esc(f)}">`).join('')}</datalist>
    <label class="field"><span>Payment mode</span><select id="f_mode">${opts(MODES, d.mode || 'Cash')}</select></label>
    ${inp('Remark <i>optional</i>', 'f_rem', d.remark, 'autocomplete="off"')}
    </fieldset>
    ${ro ? '' : `<button class="btn" data-a="saveGot">${e ? 'Save changes' : 'Save'}</button>`}
    ${e && canDelete(e) ? '<button class="btn dgr" data-a="del">Remove this entry</button>' : ''}
    ${!e ? `<p class="tiny">Money the office or anyone gave you for site expenses. No site needed — it counts for all your sites. Shows in Site Manager under Managers → ${esc(PERSON)}.</p>` : ''}`);
  if (!e) setTimeout(() => { const a = document.getElementById('f_amt'); if (a) a.focus(); }, 250);
}
function saveGot() {
  const { e } = EDIT;
  const date = vOf('f_date'); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Choose the date');
  if (date > today()) return toast('The date is in the future');
  const amount = numOrBlank(vOf('f_amt')); if (!has(amount) || amount <= 0) return toast('Enter the amount');
  const o = { manager: e ? e.data.manager : PERSON, date, amount, from: vOf('f_from').trim(), mode: vOf('f_mode'), remark: vOf('f_rem').trim() };
  if (e) { if (!editDoc(e, o)) return; } else addFund(o);
  EDIT = null; closeSheet();
}
/* diesel, vendor or owner payments the office entered with this person as "Paid by": look only */
function viewSheet(it) {
  const d = it.e.data;
  const line = (k, v) => has(v) && v !== '' ? `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>` : '';
  openSheet(esc(KIND[it.c] || 'Entry'), `${whoLine(it.e)}<div class="card pad">
    ${line('Site', siteName(it.sk))}${line('Date', fmtDate(d.date))}${line('Amount', money(it.amt))}${line('Vendor', d.vendor)}${line('Owner', d.owner)}${line('Litres', d.litres)}${line('Bill no', d.bill)}${line('Payment mode', d.mode)}${line('Remark', d.remark)}</div>
    <p class="tiny">Entered in Site Manager with you as “Paid by”, so it counts in your spending. To change it, ask the office.</p>`);
}
function openItem(path) {
  const it = findItem(path); if (!it) return;
  if (it.t === 'in') gotSheet(it); else if (it.c === 'expenseLog') expenseSheet(it); else viewSheet(it);
}

function menuSheet() {
  const names = isAdmin() ? 'All sites' : [...SITES.keys()].map(siteName).join(', ');
  openSheet('Menu', `<div class="card pad"><b class="big">${esc(ME.name)}</b><div class="tiny">${esc(ROLE_LABEL[ME.role] || '')} · ${esc(ME.email)}<br>Sites: ${esc(names)}<br>Cash book: ${esc(PERSON)}</div></div>
    ${isAdmin() ? '<button class="btn sec" data-a="person">Show another manager’s book</button>' : ''}
    <button class="btn sec" data-a="report">Share statement on WhatsApp</button>
    <button class="btn sec" data-a="passForm">Change password</button>
    <a class="btn sec" href="../">Open the full Site Manager app</a>
    <button class="btn dgr" data-a="signOut">Sign out</button>
    <p class="tiny center">Manager ${VERSION} · entries go to Site Manager by themselves</p>`);
}
function personSheet() {
  const list = [...new Set([...MGRS, PERSON])].filter(Boolean);
  openSheet('Whose expense book?', `<div class="card">${list.map(n => `<button class="mrow" data-a="pickPerson" data-v="${esc(n)}"><span class="mic">${esc(initial(n))}</span><span class="m"><b>${esc(n)}</b><small>${norm(n) === norm(PERSON) ? 'Open now' : 'Manager'}</small></span><div class="r">${norm(n) === norm(PERSON) ? '✓' : ''}</div></button>`).join('')}</div>
    <p class="tiny">As admin you can fill any manager’s book. Managers are added in Site Manager → Managers.</p>`);
}
function reportText() {
  const P = periods(), per = P[PER] || P.month;
  const all = items(), list = all.filter(x => per[2](x.date) && (SITEF === 'all' || x.sk === SITEF));
  const got = all.filter(x => x.t === 'in').reduce((a, x) => a + x.amt, 0), spent = all.filter(x => x.t === 'out').reduce((a, x) => a + x.amt, 0);
  const out = list.filter(x => x.t === 'out'), inn = list.filter(x => x.t === 'in');
  const L = [`*${PERSON} — expense statement*`, per[1] + (SITEF !== 'all' ? ' · ' + siteName(SITEF) : ''), '',
    `Spent: ${money(out.reduce((a, x) => a + x.amt, 0))}`, `Received: ${money(inn.reduce((a, x) => a + x.amt, 0))}`,
    `${got - spent < 0 ? 'Spent more than received (all time)' : 'In hand (all time)'}: ${money(Math.abs(got - spent))}`];
  const multi = SITES.size > 1;
  if (out.length) {
    L.push('', '*Spent*');
    out.slice(0, 70).reverse().forEach(x => L.push(`${fmtDate(x.date).replace(/ \d{4}$/, '')}${multi ? ' · ' + siteName(x.sk) : ''} · ${x.c === 'expenseLog' ? x.cat : KIND[x.c]}${x.title && x.title !== x.cat ? ' — ' + x.title : ''}: ${money(x.amt)}`));
    if (out.length > 70) L.push(`…and ${out.length - 70} more`);
  }
  if (inn.length) { L.push('', '*Received*'); inn.slice(0, 30).reverse().forEach(x => L.push(`${fmtDate(x.date).replace(/ \d{4}$/, '')}${x.e.data.from ? ' · from ' + x.e.data.from : ''}${x.e.data.mode ? ' (' + x.e.data.mode + ')' : ''}: ${money(x.amt)}`)); }
  const pend = list.filter(x => x.e.data._appr === 'pending').length;
  if (pend) L.push('', `${pend} ${pend === 1 ? 'entry is' : 'entries are'} waiting for approval.`);
  L.push('', '— ' + PERSON + ' (Manager app)');
  return L.join('\n');
}

/* ---------- bill photo ---------- */
function busy(on, msg) {
  let el = document.getElementById('busy');
  if (!on) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'busy'; document.body.appendChild(el); }
  el.innerHTML = `<div><i></i>${esc(msg || 'Reading the bill…')}</div>`;
}
const setV = (id, v) => { const el = document.getElementById(id); if (!el || v === '' || v == null) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
const readNote = html => { const n = document.getElementById('smRead'); if (n) n.innerHTML = `<div class="read">${html}</div>`; };
async function scanBill() {
  if (!EDIT || EDIT.kind !== 'exp') return;
  const file = await pickPhoto(); if (!file) return;
  const sk = vOf('f_site') || EDIT.sk, s = SITES.get(sk) || {};
  busy(true);
  try {
    const img = await toJpeg(file);
    const r = await readBillPhoto(CLOUD, img.b64, { kind: 'expense', vendors: s.vendors || [], categories: s.categories || [], today: today() });
    const v = matchName(s.vendors || [], r.vendor), c = matchName(s.categories || [], r.category);
    if (r.amount !== '') setV('f_amt', r.amount);
    if (r.date && r.date <= today()) setV('f_date', r.date);
    if (c) setV('f_cat', c);
    if (v) setV('f_v', v);
    if (r.items && !vOf('f_desc')) setV('f_desc', r.items);
    if (!v && r.vendor && !vOf('f_rem')) setV('f_rem', 'Bill from ' + r.vendor + (r.billNo ? ', bill ' + r.billNo : ''));
    else if (r.billNo && !vOf('f_rem')) setV('f_rem', 'Bill ' + r.billNo);
    readNote(`Read: ${r.amount !== '' ? '<b>' + money(r.amount) + '</b>' : 'no amount'}${r.date ? ' · ' + esc(fmtDate(r.date)) : ''}${r.vendor ? ' · ' + esc(v || r.vendor) : ''}${c ? ' · ' + esc(c) : ''}${r.items ? '<br>' + esc(r.items) : ''}${r.note ? '<br>' + esc(r.note) : ''}<br><span class="tiny">Check the figures, then Save.</span>`);
  } catch (e) {
    if (e && e.message === 'NO_KEY') toast('Photo reading is not switched on yet. Ask the admin to switch it on in Site Manager (Menu → Photo reading).');
    else toast((e && e.message) || 'Could not read the bill.');
  } finally { busy(false); }
}

/* ---------- clicks ---------- */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, v = el.dataset.v;
  switch (a) {
    case 'reload': location.reload(); break;
    case 'signOut': if (PEND && !confirm(PEND + ' change(s) are not uploaded yet. Sign out anyway?')) break; closeSheet(); await CLOUD.signOut(); location.reload(); break;
    case 'forgot': { const em = ($('#gate [name=email]') || {}).value; if (!em) return gErr('Type your email first, then tap "Forgot password?".'); try { await CLOUD.resetPassword(em); gErr(''); toast('Password reset email sent to ' + em); } catch (e) { gErr(authMsg(e)); } break; }
    case 'close': EDIT = null; closeSheet(); break;
    case 'menu': menuSheet(); break;
    case 'person': personSheet(); break;
    case 'pickPerson': if (norm(v) !== norm(PERSON)) { PERSON = v; try { localStorage.setItem('vmgr:person:' + ME.uid, v); } catch (e) { } SHOW = 80; startData(); } closeSheet(); render(); break;
    case 'pillInfo': toast(pillState()[2]); break;
    case 'per': PER = v; SHOW = 80; render(); break;
    case 'type': TYPE = v; SHOW = 80; render(); break;
    case 'sitef': SITEF = v; SHOW = 80; render(); break;
    case 'more': SHOW += 100; render(); break;
    case 'addExp': expenseSheet(null); break;
    case 'addGot': gotSheet(null); break;
    case 'open': openItem(v); break;
    case 'saveExp': saveExpense(false); break;
    case 'saveExpMore': saveExpense(true); break;
    case 'saveGot': saveGot(); break;
    case 'del': if (EDIT && EDIT.e) removeDoc(EDIT.e); break;
    case 'scanBill': scanBill(); break;
    case 'report': { const t = reportText(); closeSheet(); window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); break; }
    case 'passForm': openSheet('Change password', `<form data-form="pass" novalidate>${fld('Current password', 'old', 'password', 'autocomplete="current-password"')}${fld('New password', 'n1', 'password', 'autocomplete="new-password"')}${fld('New password again', 'n2', 'password', 'autocomplete="new-password"')}<button class="btn" type="submit">Change password</button></form>`); break;
  }
});

/* ---------- start ---------- */
(async function boot() {
  try { const t = localStorage.getItem('vsms:theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch (e) { }
  gate('<p class="g-msg">Opening…</p>');
  try { CLOUD = await (window.SM_CLOUD_FACTORY || createCloud)(window.FIREBASE_CONFIG); }
  catch (e) { gate(`<p class="g-msg">The app could not start. The first time you open it on a phone, it needs the internet.</p><p class="tiny">${esc(e && e.message || e)}</p><button class="btn" data-a="reload">Try again</button>`); return; }
  if (window.SM_CLOUD_FACTORY) window.__mgr = { items, ME, get PERSON() { return PERSON; }, reportText, get RULES4() { return RULES4; } }; // automated tests only
  CLOUD.onAuth(onUser);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();

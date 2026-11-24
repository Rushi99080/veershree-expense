/* =========================================================
   Veershree Supervisor — machine readings and diesel, on site
   Writes the same entries as the Site Manager app (machine log, diesel bills)
   into the same Firebase database, so they show up there by themselves,
   marked Pending until the admin approves them.
   ========================================================= */
import { createCloud, safeId } from '../cloud.js?v=3.1.0';
import { pickPhoto, toJpeg, readMachinePhoto, readBillPhoto, matchMachine, matchName } from '../ai.js?v=1.0.0';
import { pushSupport, pushState, enablePush, localTest } from '../push.js?v=1.0.0';

const VERSION = '1.2';
const RULES_V = 'v2';
const ROLE_LABEL = { admin: 'Admin', manager: 'Site Manager', accountant: 'Accountant', viewer: 'Viewer', supervisor: 'Supervisor' };
const CAN_ENTER = ['supervisor', 'manager', 'admin'];

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).trim().toLowerCase();
const has = v => v !== '' && v != null;
const num = v => { if (typeof v === 'string') v = v.replace(/[,\s₹]/g, ''); const n = parseFloat(v); return isFinite(n) ? n : 0; };
const numOrBlank = v => (String(v).trim() === '' ? '' : num(v));
const dec = (v, d = 1) => { const n = num(v); return (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-IN', { maximumFractionDigits: d }); };
const money = v => '₹' + Math.round(num(v)).toLocaleString('en-IN');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const sameNo = (a, b) => norm(a) === norm(b);
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}`; };
const fmtDay = s => { const [y, m, d] = s.split('-').map(Number); return DOW[new Date(y, m - 1, d).getDay()] + ', ' + fmtDate(s); };
const splitMeta = d => { const b = {}, m = {}; for (const k in d) (k[0] === '_' ? m : b)[k] = d[k]; return [b, m]; };
let toastT = 0;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

/* ---------- state ---------- */
const ME = { uid: '', email: '', name: '', role: '', sites: [], active: false };
let CLOUD = null, profUnsub = null, sitesUnsub = [], dayUnsub = [];
let SITES = new Map();          // site key -> site document (machines, diesel vendors, rate master)
let SK = '', DATE = today(), TAB = 'machines', FILTER = 'all', SEARCH = '';
let DAY = { machineLog: [], dieselLog: [] }, DAYMETA = { machineLog: null, dieselLog: null };
let LAST = new Map(), SEEN = new Set(), LASTKEY = '', LASTBUSY = false;
let PEND = 0, ONLINE = navigator.onLine, STARTED = false, SEQ = 0;
let REM = null, PUSHST = 'off', DAYDONE = null;   // reminder settings, this phone's notifications, today's "done" mark

const site = () => SITES.get(SK) || null;
const activeMachines = s => (s && s.machines || []).filter(m => m && m.no && !m.removed);
const basisOf = (s, no) => { const m = (s.machines || []).find(x => sameNo(x.no, no)); const r = m && (s.rateMaster || []).find(x => x.type === m.type); return r ? r.basis : ''; };
const hoursOf = r => (has(r.inR) && has(r.outR)) ? num(r.outR) - num(r.inR) : 0;
const live = list => list.filter(e => !e.data._del && !e.data._test);
const mineEditable = e => e && (ME.role === 'admin' || (e.data._by === ME.uid && e.data._appr !== 'approved'));
const canDelete = e => e && (ME.role === 'admin' || (ME.role === 'supervisor' && e.data._by === ME.uid && e.data._appr !== 'approved'));

/* ---------- gate (login and messages) ---------- */
function gate(inner) {
  const g = $('#gate');
  g.innerHTML = `<div class="g-card"><div class="g-brand"><img src="icons/icon-192.png" alt=""><b>Supervisor</b><small>Veershree</small></div>${inner}</div>`;
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
    <p class="tiny" style="margin-top:14px">Your login is made by the admin in the Site Manager app.</p></form>`);
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
async function gateRules(isAdmin) {
  if (!isAdmin) return gateText('Almost ready', 'The admin still has to publish the new security rules in Firebase for the Supervisor app. Try again a little later.', true);
  let rules = '';
  try { const r = await fetch('../firestore.rules', { cache: 'no-cache' }); if (r.ok) rules = await r.text(); } catch (e) { }
  gate(`<h2>One step in Firebase first</h2><p class="g-msg">The Supervisor app needs the new security rules.</p>
    <ol class="g-steps"><li>Tap <b>Copy the new rules</b>.</li><li>Open <b>console.firebase.google.com</b> → <b>veershree-expense</b> → <b>Firestore Database</b> → <b>Rules</b>.</li><li>Delete everything in the box, paste, tap <b>Publish</b>.</li><li>Wait one minute and tap <b>Check again</b>.</li></ol>
    ${rules ? `<button class="btn" data-a="copy" data-v="${esc(rules)}">Copy the new rules</button>` : ''}<button class="btn sec" data-a="reload">Check again</button>`);
}

/* ---------- login and profile ---------- */
async function onUser(u) {
  if (profUnsub) { profUnsub(); profUnsub = null; }
  stopAll();
  if (!u) { STARTED = false; gateLogin(''); return; }
  ME.uid = u.uid; ME.email = u.email;
  gate('<p class="g-msg">Opening…</p>');
  profUnsub = CLOUD.watchProfile(u.uid, p => onProfile(p, u), e => gate(`<p class="g-msg">Could not read your login: ${esc(authMsg(e))}</p><button class="btn" data-a="reload">Try again</button><button class="btn sec" data-a="signOut">Sign out</button>`));
}
const sig = p => [p.role, (p.sites || []).slice().sort().join(','), p.active].join('|');
async function onProfile(p, u) {
  if (!p) return gateText('Almost there', `You are signed in as <b>${esc(u.email)}</b>, but the admin has not given this login access yet. Ask the admin to add you as <b>Supervisor</b> in Users.`, true);
  if (STARTED && sig(p) !== sig(ME)) { location.reload(); return; }
  Object.assign(ME, { name: p.name || u.email, email: p.email || u.email, role: p.role, sites: Array.isArray(p.sites) ? p.sites : [], active: p.active === true });
  if (!ME.active) return gateText('Login switched off', `The admin has switched off <b>${esc(ME.email)}</b>.`, true);
  if (!CAN_ENTER.includes(ME.role)) return gate(`<h2>Not for this login</h2><p class="g-msg">${esc(ROLE_LABEL[ME.role] || ME.role)} logins cannot add machine entries. Use the Site Manager app.</p><a class="btn" href="../">Open Site Manager</a><button class="btn sec" data-a="signOut">Sign out</button>`);
  if (ME.role !== 'admin' && !ME.sites.length) return gateText('No site yet', 'The admin has not given you a site yet. Ask the admin to tick your site in <b>Users</b>.', true);
  if (STARTED) return;
  const ok = await CLOUD.rulesOk(RULES_V);
  if (ok === false) return gateRules(ME.role === 'admin');
  STARTED = true;
  watchSites();
  loadRemind();
}
async function loadRemind() {
  try { REM = await CLOUD.getDocServer('sm_meta/remind'); } catch (e) { REM = null; }
  try { PUSHST = await pushState(); } catch (e) { PUSHST = 'off'; }
  render();
}
function stopAll() { sitesUnsub.forEach(f => { try { f(); } catch (e) { } }); sitesUnsub = []; stopDay(); SITES = new Map(); }
function stopDay() { dayUnsub.forEach(f => { try { f(); } catch (e) { } }); dayUnsub = []; }

/* ---------- sites ---------- */
let firstSites = true;
function gotSites() {
  if (!SITES.size) return;
  if (!SK || !SITES.has(SK)) {
    let want = ''; try { want = localStorage.getItem('vsup:site:' + ME.uid) || ''; } catch (e) { }
    SK = SITES.has(want) ? want : [...SITES.keys()][0];
  }
  if (firstSites) { firstSites = false; hideGate(); openDay(); }
  else { render(); }
}
function watchSites() {
  gate('<p class="g-msg">Loading your site…</p><p class="tiny">The first time on a phone this needs the internet.</p>');
  const onErr = e => { if (!SITES.size) gate(`<h2>Could not open the site</h2><p class="g-msg">${esc(e && e.code === 'permission-denied' ? 'Your login is not allowed to read this site. Ask the admin to check your sites.' : 'Check the internet and try again.')}</p><button class="btn" data-a="reload">Try again</button><button class="btn sec" data-a="signOut">Sign out</button>`); };
  if (ME.role === 'admin') {
    sitesUnsub.push(CLOUD.watchSites(list => { SITES = new Map(list.filter(x => !x.data._del && !x.data._test).map(x => [x.path.split('/')[1], x.data])); gotSites(); }, onErr));
  } else {
    for (const id of ME.sites) {
      const sk = safeId(id);
      sitesUnsub.push(CLOUD.watchDoc('sm_sites/' + sk, (d) => { if (d && !d._del) SITES.set(sk, d); else SITES.delete(sk); gotSites(); }, onErr));
    }
  }
}

/* ---------- one day of one site ---------- */
function openDay() {
  stopDay();
  DAY = { machineLog: [], dieselLog: [] }; DAYMETA = { machineLog: null, dieselLog: null };
  const sk = SK, date = DATE;
  DAYDONE = null;
  dayUnsub.push(CLOUD.watchDoc('sm_days/' + sk + '_' + date, d => { if (sk === SK && date === DATE) { DAYDONE = d; render(); } }, () => { }));
  for (const coll of ['machineLog', 'dieselLog']) {
    dayUnsub.push(CLOUD.watchDay(sk, coll, date, (list, meta) => {
      if (sk !== SK || date !== DATE) return;
      DAY[coll] = list.sort((a, b) => (a.data._i || 0) - (b.data._i || 0)); DAYMETA[coll] = meta;
      render();
    }, e => { toast(e && e.code === 'permission-denied' ? 'Your login cannot read this site.' : 'Sync problem: ' + ((e && e.code) || 'unknown')); }));
  }
  render();
  loadLast();
}
/* the last reading of every machine before this day (prefills "In reading") */
async function loadLast() {
  const s = site(); if (!s) return;
  const key = SK + '|' + DATE; LASTKEY = key; LASTBUSY = true;
  const want = activeMachines(s).map(m => norm(m.no)), found = new Map(), seen = new Set();
  /* newest first; a day with no readings (idle, diesel only) does not hide the reading before it */
  for (let back = 1; back <= 21 && want.some(k => !found.has(k)) && LASTKEY === key; back += 3) {
    const days = [back, back + 1, back + 2].map(n => addDays(DATE, -n));
    let res; try { res = await Promise.all(days.map(d => CLOUD.getDay(SK, 'machineLog', d))); } catch (e) { break; }
    res.forEach((list, i) => {
      list.filter(x => !x.data._del && !x.data._test).sort((a, b) => (b.data._i || 0) - (a.data._i || 0)).forEach(x => {
        const k = norm(x.data.machineNo); seen.add(k);
        if (!found.has(k) && has(x.data.outR)) found.set(k, { date: days[i], outR: x.data.outR });
      });
    });
  }
  if (LASTKEY !== key) return;
  LAST = found; SEEN = seen; LASTBUSY = false; render();
  /* a new-entry form that opened while this was loading: fill it in now */
  if (EDIT && EDIT.coll === 'machineLog' && !EDIT.entry && document.getElementById('f_in') && vOf('f_in') === '' && vOf('f_out') === '') machineSheet(EDIT.no, null, true);
}
/* what the machine showed last: same day first (a second shift), then the days before */
function lastFor(no, exceptPath) {
  const same = live(DAY.machineLog).filter(e => sameNo(e.data.machineNo, no) && e.path !== exceptPath && has(e.data.outR));
  if (same.length) { const e = same[same.length - 1]; return { date: DATE, outR: e.data.outR, same: true }; }
  return LAST.get(norm(no)) || null;
}

/* ---------- writing ---------- */
function track(job, okMsg) {
  PEND++; pill();
  if (okMsg) toast(okMsg);
  job.then(() => { PEND--; pill(); }, e => { PEND--; pill(); toast(e && e.code === 'permission-denied' ? 'The online database refused this change for your login. It was undone.' : 'Could not save online: ' + ((e && (e.code || e.message)) || 'error')); });
}
function addEntry(coll, biz) {
  const s = site(); if (!s) return;
  const id = uid(), now = Date.now();
  const meta = { _c: coll, _s: String(s.id), _i: now * 1000 + (SEQ++ % 1000), _by: ME.uid, _byName: ME.name, _at: now, _appr: ME.role === 'admin' ? 'approved' : 'pending', _ubName: ME.name };
  const path = `sm_sites/${SK}/entries/${coll}_${safeId(id)}`;
  track(CLOUD.commit([{ type: 'set', path, data: { id, ...biz, ...meta } }]), ONLINE ? 'Saved' : 'Saved on this phone — uploads when the network is back');
}
function editEntry(e, biz) {
  const [old] = splitMeta(e.data), patch = { _ubName: ME.name };
  for (const k of Object.keys(biz)) if (JSON.stringify(old[k]) !== JSON.stringify(biz[k])) patch[k] = biz[k];
  if (Object.keys(patch).length === 1) return toast('Nothing changed');
  if (ME.role !== 'admin') patch._appr = 'pending';
  track(CLOUD.commit([{ type: 'patch', path: e.path, data: patch }]), 'Saved');
}
function deleteEntry(e) {
  track(CLOUD.commit([{ type: 'patch', path: e.path, data: { _del: true, _delBy: ME.uid, _delByName: ME.name, _delAt: Date.now(), _appr: ME.role === 'admin' ? (e.data._appr || 'approved') : 'pending', _ubName: ME.name } }]), 'Entry removed');
}

/* ---------- sync status ---------- */
function pillState() {
  const anyPending = PEND > 0 || Object.values(DAYMETA).some(m => m && m.pending);
  if (!ONLINE) return ['off', 'Offline', anyPending ? 'Saved on this phone. Uploads when the network is back.' : 'No network. You can keep working.'];
  if (anyPending) return ['sync', 'Syncing…', 'Uploading…'];
  return ['ok', 'Saved', 'Everything is saved online.'];
}
function pill() { const [s, t, title] = pillState(); const el = $('#pill'); if (el) { el.dataset.s = s; el.textContent = t; el.title = title; } }
window.addEventListener('online', () => { ONLINE = true; pill(); });
window.addEventListener('offline', () => { ONLINE = false; pill(); });

/* ---------- screens ---------- */
function statusBadge(list) {
  if (list.some(e => e.pending)) return '<span class="bdg wait">Not uploaded</span>';
  if (list.some(e => e.data._appr === 'pending')) return '<span class="bdg pend">Pending</span>';
  return '<span class="bdg ok">Approved</span>';
}
function render() {
  if (!STARTED || !site()) return;
  const s = site();
  const multi = SITES.size > 1;
  $('#top').innerHTML = `<div class="bar">
      <button class="sitebtn" data-a="${multi ? 'sites' : 'menu'}"><img src="icons/icon-192.png" alt=""><span><small>${esc(ME.name)} · ${esc(ROLE_LABEL[ME.role] || '')}</small><b>${esc(s.name || 'Site')}</b></span>${multi ? '<i class="chev">▾</i>' : ''}</button>
      <button class="pill" id="pill" data-a="pillInfo"></button>
      <button class="ava" data-a="menu" aria-label="Menu">${esc((ME.name || '?').trim().charAt(0).toUpperCase())}</button></div>
    <div class="datebar"><button class="nav" data-a="prev" aria-label="Previous day">‹</button>
      <label class="date"><b>${esc(fmtDay(DATE))}</b>${DATE === today() ? '<small>Today</small>' : '<small class="past">Not today</small>'}<input type="date" id="dpick" value="${DATE}" max="${today()}"></label>
      <button class="nav" data-a="next" aria-label="Next day" ${DATE >= today() ? 'disabled' : ''}>›</button></div>
    <div class="tabs"><button class="${TAB === 'machines' ? 'on' : ''}" data-a="tab" data-v="machines">Machines</button><button class="${TAB === 'diesel' ? 'on' : ''}" data-a="tab" data-v="diesel">Diesel received</button></div>`;
  pill();
  $('#main').innerHTML = TAB === 'machines' ? machinesHtml(s) : dieselHtml(s);
  const sb = $('#search'); if (sb) { sb.value = SEARCH; }
}
function machinesHtml(s) {
  const ms = activeMachines(s), ents = live(DAY.machineLog);
  const byNo = no => ents.filter(e => sameNo(e.data.machineNo, no));
  const filled = ms.filter(m => byNo(m.no).length).length;
  const hrs = ents.reduce((a, e) => a + hoursOf(e.data), 0), dsl = ents.reduce((a, e) => a + num(e.data.diesel), 0);
  const q = norm(SEARCH);
  const show = ms.filter(m => (FILTER === 'all' || (FILTER === 'todo' ? !byNo(m.no).length : byNo(m.no).length)) && (!q || norm(m.no + ' ' + m.type + ' ' + m.operator + ' ' + m.owner).includes(q)));
  const groups = []; for (const m of show) { let g = groups.find(x => x.t === (m.type || 'Other')); if (!g) groups.push(g = { t: m.type || 'Other', l: [] }); g.l.push(m); }
  const row = m => {
    const l = byNo(m.no), h = l.reduce((a, e) => a + hoursOf(e.data), 0), d = l.reduce((a, e) => a + num(e.data.diesel), 0);
    const daily = basisOf(s, m.no) === 'Daily';
    const right = l.length ? `<div class="r"><b>${daily && !h ? 'Worked' : dec(h, 1) + ' hrs'}</b><small>${d ? dec(d, 1) + ' L' : 'no diesel'}${l.length > 1 ? ' · ' + l.length + ' entries' : ''}</small>${statusBadge(l)}</div>` : '<div class="r todo">Fill ›</div>';
    return `<button class="mrow${l.length ? ' done' : ''}" data-a="machine" data-v="${esc(m.no)}"><span class="mic">${esc((m.type || '?').charAt(0))}</span><span class="m"><b>${esc(m.no)}</b><small>${esc([m.type, m.operator ? 'Operator ' + m.operator : ''].filter(Boolean).join(' · '))}</small></span>${right}</button>`;
  };
  const others = ents.filter(e => !ms.some(m => sameNo(m.no, e.data.machineNo)));
  return `<section class="sum"><div><b>${filled}<small>/${ms.length}</small></b><span>Machines filled</span></div><div><b>${dec(hrs, 1)}</b><span>Hours</span></div><div><b>${dec(dsl, 0)}<small> L</small></b><span>Diesel filled</span></div></section>
    ${todayHtml(filled, ms.length)}
    <div class="tools"><input id="search" type="search" placeholder="Search machine, type or operator" autocomplete="off">
      <div class="chips">${[['all', 'All'], ['todo', 'Not filled'], ['done', 'Filled']].map(([v, l]) => `<button class="${FILTER === v ? 'on' : ''}" data-a="filter" data-v="${v}">${l}${v === 'todo' ? ' (' + (ms.length - filled) + ')' : ''}</button>`).join('')}</div></div>
    ${groups.map(g => `<h3 class="gh">${esc(g.t)} <small>${g.l.length}</small></h3><div class="card">${g.l.map(row).join('')}</div>`).join('') || `<div class="card empty">${ms.length ? 'No machine matches.' : 'No machines in this site yet. The admin adds them in Site Manager → Masters.'}</div>`}
    ${others.length ? `<h3 class="gh">Other entries</h3><div class="card">${others.map(e => `<button class="mrow done" data-a="entry" data-v="${esc(e.path)}"><span class="mic">?</span><span class="m"><b>${esc(e.data.machineNo || '—')}</b><small>Not in the machine list</small></span><div class="r"><b>${dec(hoursOf(e.data), 1)} hrs</b>${statusBadge([e])}</div></button>`).join('')}</div>` : ''}
    <button class="btn wa" data-a="report">Share day report on WhatsApp</button>
    ${LASTBUSY ? '<p class="tiny center">Looking up the last readings…</p>' : ''}`;
}
/* today: "Done for today", and the reminder switch on this phone */
function todayHtml(filled, total) {
  if (DATE !== today() || ME.role === 'admin') return '';
  const remOn = REM && REM.on !== false && REM.vapidPublic;
  const sup = pushSupport();
  let rem = '';
  if (remOn && PUSHST !== 'on') {
    rem = sup === 'ios-home' ? `<div class="remcard"><b>Turn on reminders</b><span>On iPhone: tap Share → <b>Add to Home Screen</b>, open the app from the Home Screen, then turn reminders on.</span></div>`
      : sup === 'no' ? '' : `<div class="remcard"><b>Turn on reminders</b><span>Get a notification at ${esc(REM.time || '19:00')} if today's readings are not filled.</span><button class="btn" data-a="remOn">Turn on reminders</button></div>`;
  }
  const done = DAYDONE && DAYDONE.done;
  return `${rem}<div class="daycard${done ? ' on' : ''}">${done
    ? `<div><b>✓ Done for today</b><span>${esc(DAYDONE.byName || '')}${remOn ? ' · no more reminders today' : ''}</span></div><button class="btn sec" data-a="undoDay">Undo</button>`
    : `<div><b>${filled} of ${total} machines filled</b><span>${remOn ? 'Reminders every 10 min from ' + esc(REM.time || '19:00') + ' until done.' : 'Tap when every working machine is filled.'}</span></div><button class="btn" data-a="doneDay">Done for today</button>`}</div>`;
}
function markDay(done) {
  const s = site(); if (!s) return;
  const ms = activeMachines(s), ents = live(DAY.machineLog);
  const filled = ms.filter(m => ents.some(e => sameNo(e.data.machineNo, m.no))).length;
  if (done && filled < ms.length && !confirm(`${ms.length - filled} machine${ms.length - filled === 1 ? ' has' : 's have'} no reading today. Mark the day done (they did not work)?`)) return;
  track(CLOUD.commit([{ type: 'set', path: `sm_days/${SK}_${DATE}`, data: { site: String(s.id), date: DATE, done: !!done, by: ME.uid, byName: ME.name, at: Date.now(), filled, total: ms.length } }]), done ? 'Done for today — no more reminders today' : 'Undone');
}
async function remOn() {
  try {
    if (!REM || !REM.vapidPublic) REM = await CLOUD.getDocServer('sm_meta/remind');
    await enablePush(CLOUD, ME, REM && REM.vapidPublic, 'supervisor');
    PUSHST = 'on'; render();
    toast('Reminders are on for this phone');
    try { await localTest('Reminders are on', 'You will get a reminder at ' + ((REM && REM.time) || '19:00') + ' if readings are not filled.'); } catch (e) { }
  } catch (e) { toast((e && (e.code === 'permission-denied' ? 'The admin has to update the Firebase rules first.' : e.message)) || 'Could not turn on reminders'); }
}

function dieselHtml(s) {
  const ents = live(DAY.dieselLog);
  const got = ents.reduce((a, e) => a + num(e.data.litres), 0);
  const filled = live(DAY.machineLog).reduce((a, e) => a + num(e.data.diesel), 0);
  return `<section class="sum"><div><b>${dec(got, 0)}<small> L</small></b><span>Received</span></div><div><b>${dec(filled, 0)}<small> L</small></b><span>Filled in machines</span></div><div><b>${ents.length}</b><span>Bills</span></div></section>
    <button class="btn" data-a="dieselAdd">+ Diesel received</button>
    <div class="card">${ents.map(e => `<button class="mrow done" data-a="entry" data-v="${esc(e.path)}"><span class="mic d">D</span><span class="m"><b>${esc(e.data.vendor || 'Diesel')}</b><small>${e.data.bill ? 'Bill ' + esc(e.data.bill) + ' · ' : ''}${esc(e.data._byName || '')}</small></span><div class="r"><b>${dec(e.data.litres, 1)} L</b><small>${has(e.data.amount) && num(e.data.amount) ? money(e.data.amount) : ''}</small>${statusBadge([e])}</div></button>`).join('') || '<div class="empty">No diesel received on this day.</div>'}</div>
    <p class="tiny">Diesel from the pump or tanker that came to the site. Diesel put into each machine is entered on the machine itself.</p>`;
}

/* ---------- sheets ---------- */
function openSheet(title, body) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="sh-bg" data-a="close"></div><div class="sh"><div class="sh-h"><h2>${title}</h2><button class="x" data-a="close" aria-label="Close">✕</button></div><div class="sh-b">${body}</div></div>`;
  sh.hidden = false; document.body.classList.add('sheet-open');
  const f = sh.querySelector('form'); if (f) f.addEventListener('submit', e => { e.preventDefault(); const fn = FORMS[f.dataset.form]; if (fn) fn(Object.fromEntries(new FormData(f).entries())); });
}
function closeSheet() { const sh = $('#sheet'); sh.hidden = true; sh.innerHTML = ''; document.body.classList.remove('sheet-open'); }
const inp = (label, id, val, attrs, hint) => `<label class="field"><span>${label}</span><input id="${id}" value="${esc(has(val) ? val : '')}" ${attrs || ''}>${hint ? `<em class="hint" id="${id}_h">${hint}</em>` : `<em class="hint" id="${id}_h"></em>`}</label>`;
const numIn = (label, id, val, hint) => inp(label, id, val, 'type="number" inputmode="decimal" step="any"', hint);
const vOf = id => { const e = document.getElementById(id); return e ? e.value : ''; };

let EDIT = null;   // { coll, entry (or null for new), no }
function machineSheet(no, entry, keepNew) {
  const s = site(); const m = (s.machines || []).find(x => sameNo(x.no, no)) || { no, type: '' };
  const daily = basisOf(s, no) === 'Daily';
  const list = live(DAY.machineLog).filter(e => sameNo(e.data.machineNo, no));
  if (!entry && list.length && EDIT !== 'new' && !keepNew) return list.length === 1 ? machineSheet(no, list[0]) : machineDaySheet(m, list);
  const ro = entry && !mineEditable(entry);
  const r = entry ? entry.data : {};
  const last = lastFor(no, entry && entry.path);
  const firstDay = !entry && !LASTBUSY && !SEEN.has(norm(no)) && !live(DAY.machineLog).some(e => sameNo(e.data.machineNo, no));
  EDIT = { coll: 'machineLog', entry, no: m.no };
  const lastTxt = last ? `Last out reading: <b>${dec(last.outR, 2)}</b>${last.same ? ' (earlier today)' : ' on ' + fmtDate(last.date)}` : (LASTBUSY ? 'Looking up the last reading…' : 'No reading in the last 3 weeks');
  openSheet(`${esc(m.no)}${m.type ? ' · ' + esc(m.type) : ''}`, `
    <p class="sub">${esc(fmtDay(DATE))}${m.operator ? ' · Operator ' + esc(m.operator) : ''}</p>
    ${entry ? `<p class="who">${entry.data._appr === 'approved' ? '<span class="bdg ok">Approved</span>' : '<span class="bdg pend">Pending</span>'} Entered by ${esc(entry.data._byName || '—')}${ro ? (entry.data._appr === 'approved' ? ' · only the admin can change it now' : ' · only they or the admin can change it') : ''}</p>` : ''}
    ${ro ? '' : '<button class="btn sec scan" data-a="scanMeter">📷 Read meter or log photo</button><div id="smRead"></div>'}
    <fieldset ${ro ? 'disabled' : ''}>
    <div class="f2">${numIn('In reading' + (daily ? ' <i>optional</i>' : ''), 'f_in', entry ? r.inR : (last && !daily ? last.outR : ''), lastTxt)}${numIn('Out reading' + (daily ? ' <i>optional</i>' : ''), 'f_out', r.outR)}</div>
    <div class="hours"><span>Hours</span><b id="f_hr">—</b></div>
    <div class="f2">${numIn('Diesel filled (L)', 'f_dsl', r.diesel)}${inp('Remark', 'f_rem', r.remark, 'placeholder="e.g. breakdown, half day"')}</div>
    ${(firstDay || (entry && has(r.openDiesel))) ? `<details ${entry && has(r.openDiesel) ? 'open' : ''}><summary>First day of this machine at the site?</summary>${numIn('Opening diesel in the tank (L)', 'f_open', r.openDiesel, 'Only on the machine’s first day. Not counted as a purchase.')}</details>` : ''}
    </fieldset>
    ${ro ? '' : `<button class="btn" data-a="saveMachine">${entry ? 'Save changes' : 'Save entry'}</button>`}
    ${entry && canDelete(entry) ? '<button class="btn dgr" data-a="delEntry">Delete this entry</button>' : ''}
    ${entry ? `<button class="btn sec" data-a="machineNew" data-v="${esc(m.no)}">+ Add another entry (second shift)</button>` : ''}
    ${!ro && !entry ? `<p class="tiny">${ME.role === 'admin' ? 'Saved as approved.' : 'Goes to the admin for approval. You can change it until then.'}</p>` : ''}`);
  const upd = () => {
    const a = vOf('f_in'), b = vOf('f_out'), h = (a !== '' && b !== '') ? num(b) - num(a) : null;
    const el = $('#f_hr'); el.textContent = h == null ? '—' : dec(h, 2); el.className = h != null && (h < 0 || h > 24) ? 'bad' : '';
    const hint = $('#f_in_h');
    if (hint && last && a !== '' && Math.abs(num(a) - num(last.outR)) > 0.001) hint.innerHTML = `${lastTxt}<br><span class="warn">Not the same as the last out reading — check the meter.</span>`;
    else if (hint) hint.innerHTML = lastTxt;
  };
  ['f_in', 'f_out'].forEach(id => { const e = document.getElementById(id); if (e) e.addEventListener('input', upd); });
  upd();
  if (!ro && !entry) setTimeout(() => { const e = document.getElementById(has(vOf('f_in')) ? 'f_out' : 'f_in'); if (e) e.focus(); }, 250);
}
function machineDaySheet(m, list) {
  openSheet(`${esc(m.no)}${m.type ? ' · ' + esc(m.type) : ''}`, `<p class="sub">${esc(fmtDay(DATE))}</p>
    <div class="card">${list.map(e => `<button class="mrow done" data-a="entry" data-v="${esc(e.path)}"><span class="m"><b>${has(e.data.inR) || has(e.data.outR) ? dec(e.data.inR, 2) + ' → ' + dec(e.data.outR, 2) : 'No readings'}</b><small>${dec(hoursOf(e.data), 2)} hrs · ${dec(e.data.diesel, 1)} L${e.data.remark ? ' · ' + esc(e.data.remark) : ''} · by ${esc(e.data._byName || '—')}</small></span><div class="r">${statusBadge([e])}</div></button>`).join('')}</div>
    <button class="btn sec" data-a="machineNew" data-v="${esc(m.no)}">+ Add another entry (second shift)</button>`);
}
function saveMachine() {
  const { entry, no } = EDIT; const s = site();
  const daily = basisOf(s, no) === 'Daily';
  const o = { date: DATE, machineNo: no, inR: numOrBlank(vOf('f_in')), outR: numOrBlank(vOf('f_out')), diesel: numOrBlank(vOf('f_dsl')), openDiesel: document.getElementById('f_open') ? numOrBlank(vOf('f_open')) : (entry ? (entry.data.openDiesel ?? '') : ''), remark: vOf('f_rem').trim(), xl: entry ? !!entry.data.xl : false };
  if (has(o.inR) !== has(o.outR)) return toast(has(o.inR) ? 'Enter the out reading too' : 'Enter the in reading too');
  if (has(o.inR) && o.outR < o.inR) return toast('Out reading is lower than the in reading');
  const h = hoursOf(o);
  if (h > 24 && !confirm(dec(h, 2) + ' hours in one day — is that right?')) return;
  if (!daily && !has(o.inR) && !has(o.diesel) && !o.remark && !confirm('No readings and no diesel. Save anyway? Add a remark like "breakdown" or "idle".')) return;
  if (entry) editEntry(entry, o); else addEntry('machineLog', o);
  EDIT = null; closeSheet();
}
function dieselSheet(entry) {
  const s = site(), r = entry ? entry.data : { vendor: (s.dieselVendors || [])[0] || '' };
  const ro = entry && !mineEditable(entry);
  EDIT = { coll: 'dieselLog', entry };
  const vendors = [...new Set([...(s.dieselVendors || []), r.vendor].filter(Boolean))];
  openSheet(entry ? 'Diesel received' : 'New diesel received', `<p class="sub">${esc(fmtDay(DATE))}</p>
    ${entry ? `<p class="who">${entry.data._appr === 'approved' ? '<span class="bdg ok">Approved</span>' : '<span class="bdg pend">Pending</span>'} Entered by ${esc(entry.data._byName || '—')}</p>` : ''}
    ${ro ? '' : '<button class="btn sec scan" data-a="scanBill">📷 Read bill photo</button><div id="smRead"></div>'}
    <fieldset ${ro ? 'disabled' : ''}>
    <label class="field"><span>Diesel vendor</span><select id="f_v">${vendors.length ? '' : '<option value="">— none in the list —</option>'}${vendors.map(v => `<option${v === r.vendor ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <div class="f2">${numIn('Diesel (L)', 'f_l', r.litres)}${inp('Bill no', 'f_bill', r.bill)}</div>
    <div class="f2">${numIn('Amount (₹) <i>if known</i>', 'f_amt', r.amount)}${inp('Remark', 'f_rem', r.remark)}</div>
    </fieldset>
    ${ro ? '' : `<button class="btn" data-a="saveDiesel">${entry ? 'Save changes' : 'Save'}</button>`}
    ${entry && canDelete(entry) ? '<button class="btn dgr" data-a="delEntry">Delete this entry</button>' : ''}
    <p class="tiny">Payment is marked by the office in Site Manager.</p>`);
}
function saveDiesel() {
  const { entry } = EDIT;
  const v = vOf('f_v'); if (!v) return toast('Select the diesel vendor (the admin adds vendors in Masters)');
  const l = numOrBlank(vOf('f_l')); if (!has(l) || l <= 0) return toast('Enter the litres');
  const base = entry ? splitMeta(entry.data)[0] : { status: 'Unpaid', paidBy: '', mode: '', xl: false };
  const o = { date: DATE, vendor: v, litres: l, bill: vOf('f_bill').trim(), amount: numOrBlank(vOf('f_amt')), status: base.status || 'Unpaid', paidBy: base.paidBy || '', mode: base.mode || '', remark: vOf('f_rem').trim(), xl: !!base.xl };
  if (entry) editEntry(entry, o); else addEntry('dieselLog', o);
  EDIT = null; closeSheet();
}
function findEntry(path) { return [...DAY.machineLog, ...DAY.dieselLog].find(e => e.path === path); }

function menuSheet() {
  const names = ME.role === 'admin' ? 'All sites' : ME.sites.map(id => (SITES.get(safeId(id)) || {}).name || id).join(', ');
  openSheet('Menu', `<div class="card pad"><b class="big">${esc(ME.name)}</b><div class="tiny">${esc(ROLE_LABEL[ME.role] || '')} · ${esc(ME.email)}<br>Sites: ${esc(names)}</div></div>
    ${SITES.size > 1 ? '<button class="btn sec" data-a="sites">Change site</button>' : ''}
    <button class="btn sec" data-a="report">Share day report on WhatsApp</button>
    <button class="btn sec" data-a="passForm">Change password</button>
    ${ME.role !== 'supervisor' ? '<a class="btn sec" href="../">Open the full Site Manager app</a>' : ''}
    <button class="btn dgr" data-a="signOut">Sign out</button>
    <p class="tiny center">Supervisor ${VERSION} · entries go to Site Manager by themselves</p>`);
}
function sitesSheet() {
  openSheet('Choose site', `<div class="card">${[...SITES.entries()].map(([k, s]) => `<button class="mrow${k === SK ? ' done' : ''}" data-a="pickSite" data-v="${esc(k)}"><span class="m"><b>${esc(s.name)}</b><small>${activeMachines(s).length} machines</small></span><div class="r">${k === SK ? '✓' : ''}</div></button>`).join('')}</div>`);
}
function reportText() {
  const s = site(), ms = activeMachines(s), ents = live(DAY.machineLog), dsl = live(DAY.dieselLog);
  const lines = [`*${s.name} — ${fmtDay(DATE)}*`];
  const hrs = ents.reduce((a, e) => a + hoursOf(e.data), 0), fill = ents.reduce((a, e) => a + num(e.data.diesel), 0);
  const filledNos = ms.filter(m => ents.some(e => sameNo(e.data.machineNo, m.no)));
  lines.push(`Machines: ${filledNos.length} of ${ms.length} · ${dec(hrs, 1)} hrs · diesel filled ${dec(fill, 1)} L`, '');
  for (const e of ents) {
    const r = e.data, t = (ms.find(m => sameNo(m.no, r.machineNo)) || {}).type;
    const rd = has(r.inR) ? `${dec(r.inR, 2)} → ${dec(r.outR, 2)} = ${dec(hoursOf(r), 2)} hrs` : 'worked';
    lines.push(`${r.machineNo}${t ? ' (' + t + ')' : ''}: ${rd}${has(r.diesel) && num(r.diesel) ? ' · ' + dec(r.diesel, 1) + ' L' : ''}${r.remark ? ' · ' + r.remark : ''}`);
  }
  const todo = ms.filter(m => !filledNos.includes(m)).map(m => m.no);
  if (todo.length) lines.push('', 'Not filled: ' + todo.join(', '));
  if (dsl.length) { lines.push('', 'Diesel received:'); dsl.forEach(e => lines.push(`${e.data.vendor}: ${dec(e.data.litres, 1)} L${e.data.bill ? ' (bill ' + e.data.bill + ')' : ''}`)); }
  lines.push('', `— ${ME.name}${ME.role === 'supervisor' ? ' (Supervisor)' : ''}`);
  return lines.join('\n');
}

/* ---------- photo reading ---------- */
function busy(on, msg) {
  let el = document.getElementById('busy');
  if (!on) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'busy'; document.body.appendChild(el); }
  el.innerHTML = `<div><i></i>${esc(msg || 'Reading the photo…')}</div>`;
}
function scanErr(e) {
  if (e && e.message === 'NO_KEY') return toast('Photo reading is not switched on yet. Ask the admin to switch it on in Site Manager (Menu → Photo reading).');
  toast((e && e.message) || 'Photo reading failed.');
}
const setV = (id, v) => { const el = document.getElementById(id); if (!el || v === '' || v == null) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
const readNote = html => { const n = document.getElementById('smRead'); if (n) n.innerHTML = `<div class="read">${html}</div>`; };
const fmtN = v => (v === '' || v == null) ? '—' : dec(v, 2);
async function scanMeter() {
  if (!EDIT || EDIT.coll !== 'machineLog') return;
  const file = await pickPhoto(); if (!file) return;
  const s = site(), no = EDIT.no, m = (s.machines || []).find(x => sameNo(x.no, no)) || {};
  const last = lastFor(no, EDIT.entry && EDIT.entry.path);
  busy(true);
  try {
    const img = await toJpeg(file);
    const r = await readMachinePhoto(CLOUD, img.b64, { site: s.name, today: today(), machineNo: no, machineType: m.type || '', lastOut: last ? last.outR : '', lastDate: last ? last.date : '', machines: activeMachines(s) });
    if (r.kind === 'meter' && r.meterReading !== '') {
      const rd = r.meterReading, inV = vOf('f_in');
      if (inV !== '' && rd >= num(inV)) { setV('f_out', rd); readNote(`Meter <b>${fmtN(rd)}</b> → Out reading.`); }
      else if (inV === '' && last && rd >= num(last.outR)) { setV('f_in', last.outR); setV('f_out', rd); readNote(`Meter <b>${fmtN(rd)}</b> → Out. In = last out reading.`); }
      else if (inV === '') { setV('f_in', rd); readNote(`Meter <b>${fmtN(rd)}</b> → In reading.`); }
      else { setV('f_out', rd); readNote(`Meter <b>${fmtN(rd)}</b> → Out. <span class="warn">It is lower than the In reading — check.</span>`); }
    } else {
      const mine = r.rows.filter(x => !x.machineNo || sameNo(matchMachine(s.machines || [], x.machineNo), no));
      const row = mine.find(x => x.date === DATE) || (r.rows.length === 1 ? r.rows[0] : null);
      if (!row) { readNote(r.rows.length ? `This photo has ${r.rows.length} rows, none for ${esc(no)} on ${esc(fmtDate(DATE))}.` : 'No reading found in this photo.'); }
      else { setV('f_in', row.inR); setV('f_out', row.outR); setV('f_dsl', row.diesel); if (row.remark && !vOf('f_rem')) setV('f_rem', row.remark); readNote(`Read: In ${fmtN(row.inR)} · Out ${fmtN(row.outR)}${row.diesel !== '' ? ' · ' + fmtN(row.diesel) + ' L' : ''}`); }
    }
    if (r.note) readNote(($('#smRead .read') ? $('#smRead .read').innerHTML + '<br>' : '') + esc(r.note));
  } catch (e) { scanErr(e); } finally { busy(false); }
}
async function scanBill() {
  if (!EDIT || EDIT.coll !== 'dieselLog') return;
  const file = await pickPhoto(); if (!file) return;
  const s = site(); busy(true);
  try {
    const img = await toJpeg(file);
    const r = await readBillPhoto(CLOUD, img.b64, { kind: 'diesel', vendors: s.dieselVendors || [] });
    const v = matchName(s.dieselVendors || [], r.vendor);
    if (v) setV('f_v', v); else if (r.vendor && !vOf('f_rem')) setV('f_rem', 'Vendor on bill: ' + r.vendor);
    setV('f_l', r.litres); setV('f_amt', r.amount); if (r.billNo) setV('f_bill', r.billNo);
    readNote(`Read: ${esc(v || r.vendor || 'vendor not read')}${r.vendor && !v ? ' <span class="warn">(not in the vendor list — pick it)</span>' : ''} · ${fmtN(r.litres)} L · ${r.amount !== '' ? money(r.amount) : 'no amount'}${r.billNo ? ' · bill ' + esc(r.billNo) : ''}${r.date && r.date !== DATE ? `<br><span class="warn">The bill date is ${esc(fmtDate(r.date))} — you are filling ${esc(fmtDate(DATE))}.</span>` : ''}${r.note ? '<br>' + esc(r.note) : ''}`);
  } catch (e) { scanErr(e); } finally { busy(false); }
}

/* ---------- clicks ---------- */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, v = el.dataset.v;
  switch (a) {
    case 'copy': try { await navigator.clipboard.writeText(v); toast('Copied'); } catch (e) { prompt('Copy this:', v); } break;
    case 'reload': location.reload(); break;
    case 'signOut': if (PEND && !confirm(PEND + ' change(s) are not uploaded yet. Sign out anyway?')) break; closeSheet(); await CLOUD.signOut(); location.reload(); break;
    case 'forgot': { const em = ($('#gate [name=email]') || {}).value; if (!em) return gErr('Type your email first, then tap "Forgot password?".'); try { await CLOUD.resetPassword(em); gErr(''); toast('Password reset email sent to ' + em); } catch (e) { gErr(authMsg(e)); } break; }
    case 'close': EDIT = null; closeSheet(); break;
    case 'menu': menuSheet(); break;
    case 'sites': sitesSheet(); break;
    case 'pickSite': SK = v; try { localStorage.setItem('vsup:site:' + ME.uid, v); } catch (e) { } closeSheet(); LAST = new Map(); openDay(); break;
    case 'prev': DATE = addDays(DATE, -1); LAST = new Map(); openDay(); break;
    case 'next': if (DATE < today()) { DATE = addDays(DATE, 1); LAST = new Map(); openDay(); } break;
    case 'tab': TAB = v; render(); break;
    case 'filter': FILTER = v; render(); break;
    case 'pillInfo': toast(pillState()[2]); break;
    case 'machine': EDIT = null; machineSheet(v, null); break;
    case 'machineNew': EDIT = 'new'; machineSheet(v, null); break;
    case 'entry': { const e = findEntry(v); if (!e) break; if (e.data._c === 'dieselLog') dieselSheet(e); else machineSheet(e.data.machineNo, e); break; }
    case 'saveMachine': saveMachine(); break;
    case 'dieselAdd': dieselSheet(null); break;
    case 'saveDiesel': saveDiesel(); break;
    case 'scanMeter': scanMeter(); break;
    case 'doneDay': markDay(true); break;
    case 'undoDay': markDay(false); break;
    case 'remOn': remOn(); break;
    case 'scanBill': scanBill(); break;
    case 'delEntry': if (EDIT && EDIT.entry && confirm('Delete this entry?')) { deleteEntry(EDIT.entry); EDIT = null; closeSheet(); } break;
    case 'report': { const t = reportText(); closeSheet(); window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); break; }
    case 'passForm': openSheet('Change password', `<form data-form="pass" novalidate>${fld('Current password', 'old', 'password', 'autocomplete="current-password"')}${fld('New password', 'n1', 'password', 'autocomplete="new-password"')}${fld('New password again', 'n2', 'password', 'autocomplete="new-password"')}<button class="btn" type="submit">Change password</button></form>`); break;
  }
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'search') { SEARCH = ev.target.value; const pos = ev.target.selectionStart; render(); const sb = $('#search'); if (sb) { sb.focus(); try { sb.setSelectionRange(pos, pos); } catch (e) { } } }
});
document.addEventListener('change', ev => {
  if (ev.target.id === 'dpick' && ev.target.value) { DATE = ev.target.value > today() ? today() : ev.target.value; LAST = new Map(); openDay(); }
});

/* ---------- start ---------- */
(async function boot() {
  try { const t = localStorage.getItem('vsms:theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch (e) { }
  const cfg = window.FIREBASE_CONFIG;
  gate('<p class="g-msg">Opening…</p>');
  try { CLOUD = await (window.SM_CLOUD_FACTORY || createCloud)(cfg); }
  catch (e) { gate(`<p class="g-msg">The app could not start. The first time you open it on a phone, it needs the internet.</p><p class="tiny">${esc(e && e.message || e)}</p><button class="btn" data-a="reload">Try again</button>`); return; }
  if (window.SM_CLOUD_FACTORY) window.__sup = { get DAY() { return DAY; }, get LAST() { return LAST; }, ME, get SK() { return SK; }, get DATE() { return DATE; }, reportText }; // automated tests only
  CLOUD.onAuth(onUser);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();

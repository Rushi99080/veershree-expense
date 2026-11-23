/* =========================================================
   Site Manager — sync layer (Phase 1)
   Sits between the Site Manager app (index.html) and Firebase:
   - login, roles (admin / site manager / accountant / viewer)
   - every save(): finds what changed in DB and sends only that, entry by entry
   - changes made on other phones come in and are put into DB
   - works offline; a phone copy of everything is kept in IndexedDB
   - approvals, users, my account, import of the old backup with a check screen
   The app's own screens and calculations are not changed.
   ========================================================= */
import { createCloud, safeId } from './cloud.js?v=3.0.1';

const ENTRY_KEYS = ['machineLog', 'dieselLog', 'expenseLog', 'vendorPayments', 'murumLog', 'funds', 'ownerPayments', 'bills', 'reminders'];
const LOCAL_KEYS = ['sites', 'mfunds', 'activeId', 'lastSnap', 'lastBackup', 'theme', 'lastNotif', 'lastNotify', 'userName', 'logo', 'billLogo', 'watermark', 'wmOpacity'];
const KIND_LABEL = { machineLog: 'Machine entry', dieselLog: 'Diesel bill', expenseLog: 'Expense', vendorPayments: 'Vendor payment', murumLog: 'Murum', funds: 'Money received', ownerPayments: 'Owner payment', bills: 'Rent bill', reminders: 'Payment due date', mfund: 'Money to manager' };
const ROLE_LABEL = { admin: 'Admin', manager: 'Site Manager', accountant: 'Accountant', viewer: 'Viewer' };

const ME = { uid: '', email: '', name: '', role: '', sites: [], person: '', active: false };
let CLOUD = null, STOP = null, USERS = [], usersUnsub = null, profUnsub = null;
let REMOTE = new Map();   // path -> business data as last known online
let META = new Map();     // path -> { _c, _s, _i, _by, _byName, _at, _appr, ... }
let CURSORS = {};
let READY = false, STARTED = false, ONLINE = navigator.onLine, ERR = '', FIRST = new Set(), PEND = 0;
const ORPHANS = new Map(); // site key -> entries that arrived before their site

/* ---------- helpers ---------- */
const $q = s => document.querySelector(s);
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).trim().toLowerCase();
const isAdmin = () => ME.role === 'admin', isMgr = () => ME.role === 'manager', isAcc = () => ME.role === 'accountant', isViewer = () => ME.role === 'viewer';
const seesAll = () => ME.role && !isMgr();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = m => { try { toast(m); } catch (e) { console.log(m); } };
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const clone = v => JSON.parse(JSON.stringify(v));
function splitMeta(d) { const b = {}, m = {}; for (const k in d) (k[0] === '_' ? m : b)[k] = d[k]; return [b, m]; }
const siteKey = s => safeId(s.id);
const entryPath = (sk, coll, id) => `sm_sites/${sk}/entries/${coll}_${safeId(id)}`;

/* ---------- DB <-> documents ---------- */
function fixIds() {
  for (const s of DB.sites || []) for (const k of ENTRY_KEYS) {
    const seen = new Set();
    for (const r of s[k] || []) { if (!r.id || seen.has(String(r.id))) r.id = uid(); seen.add(String(r.id)); }
  }
  const seen = new Set(); for (const f of DB.mfunds || []) { if (!f.id || seen.has(String(f.id))) f.id = uid(); seen.add(String(f.id)); }
}
function buildDocs(db) {
  const out = new Map();
  (db.sites || []).forEach((s, i) => {
    const sk = siteKey(s), master = {};
    for (const k in s) if (!ENTRY_KEYS.includes(k)) master[k] = s[k];
    out.set('sm_sites/' + sk, { biz: master, kind: 'site', sid: s.id, ord: i });
    for (const k of ENTRY_KEYS) (s[k] || []).forEach((r, j) => out.set(entryPath(sk, k, r.id), { biz: r, kind: 'entry', coll: k, sid: s.id, ord: j }));
  });
  (db.mfunds || []).forEach((f, j) => out.set('sm_mfunds/' + safeId(f.id), { biz: f, kind: 'mfund', ord: j }));
  const app = {}; for (const k in db) if (!LOCAL_KEYS.includes(k)) app[k] = db[k];
  out.set('sm_meta/app', { biz: app, kind: 'app' });
  out.set('sm_meta/logos', { biz: { logo: db.logo || '', billLogo: db.billLogo || '' }, kind: 'logos' });
  return out;
}
const kindOf = p => p === 'sm_meta/app' ? 'app' : p === 'sm_meta/logos' ? 'logos' : p.startsWith('sm_mfunds/') ? 'mfund' : p.includes('/entries/') ? 'entry' : 'site';
const collOf = p => p.split('/').pop().split('_')[0];
const skOf = p => p.split('/')[1];
const findSite = sk => (DB.sites || []).find(s => siteKey(s) === sk);

/* who may change what (the online rules say the same) */
function allowed(p, kind, prevBiz, biz, prevMeta) {
  if (isAdmin()) return true;
  if (isViewer() || !ME.role) return false;
  const isNew = !prevBiz;
  if (isMgr()) {
    if (kind === 'site') return !isNew && ME.sites.map(safeId).includes(skOf(p));
    if (kind === 'entry') return ME.sites.map(safeId).includes(skOf(p)) && (isNew || (prevMeta && prevMeta._appr) !== 'approved');
    if (kind === 'mfund') return !!ME.person && norm(biz.manager) === norm(ME.person) && (isNew || (prevMeta && prevMeta._appr) !== 'approved');
    return false;
  }
  if (isAcc()) {
    if (kind === 'mfund') return isNew;
    if (kind !== 'entry') return false;
    const c = collOf(p);
    if (isNew) return ['vendorPayments', 'ownerPayments', 'funds'].includes(c);
    const ch = changedKeys(prevBiz, biz);
    if (['expenseLog', 'dieselLog', 'murumLog'].includes(c)) return ch.every(k => ['status', 'paidBy', 'mode'].includes(k));
    if (c === 'bills') return ch.every(k => k === 'payments');
    return false;
  }
  return false;
}
function changedKeys(a, b) { const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); return [...ks].filter(k => canon((a || {})[k]) !== canon((b || {})[k])); }

/* ---------- push: send what changed in DB ---------- */
let pushing = null;
let HOLD = false;   /* true while an import is being prepared: the app's own save must not upload half a file */
function push() {
  if (HOLD || !READY || !CLOUD || !ME.uid) return Promise.resolve(true);
  fixIds();
  const cur = buildDocs(DB);
  const ops = [], paths = [], bad = [];
  const now = Date.now(), base = now * 1000;
  for (const [p, d] of cur) {
    const prev = REMOTE.get(p);
    if (prev && canon(prev) === canon(d.biz)) continue;
    if (!prev && d.kind === 'logos' && !d.biz.logo && !d.biz.billLogo) continue;
    if (!prev && d.kind === 'app' && !Object.keys(d.biz).length) continue;
    const pm = META.get(p);
    if (!allowed(p, d.kind, prev, d.biz, pm)) { bad.push({ p, d, why: prev ? (pm && pm._appr === 'approved' ? 'approved' : 'change') : 'add' }); continue; }
    let meta;
    if (!prev) {
      meta = { _c: d.kind === 'entry' ? d.coll : d.kind, _i: base + (d.ord || 0), _by: ME.uid, _byName: ME.name, _at: now };
      if (d.sid) meta._s = d.sid;
      if (d.kind === 'entry' || d.kind === 'mfund') meta._appr = isMgr() ? 'pending' : 'approved';
    } else {
      meta = { ...(pm || {}) }; delete meta._u; delete meta._ub;
      if (!meta._c) meta._c = d.kind === 'entry' ? d.coll : d.kind;
      if (meta._i == null) meta._i = base + (d.ord || 0);
      if (d.sid && !meta._s) meta._s = d.sid;
      if (isMgr() && (d.kind === 'entry' || d.kind === 'mfund')) meta._appr = 'pending';
    }
    meta._ubName = ME.name;
    const biz = clone(d.biz);
    if (isAcc() && prev) {
      const patch = { _ubName: ME.name }; for (const k of changedKeys(prev, biz)) patch[k] = biz[k] === undefined ? null : biz[k];
      ops.push({ type: 'patch', path: p, data: patch });
    } else ops.push({ type: 'set', path: p, data: { ...biz, ...meta } });
    REMOTE.set(p, biz); META.set(p, { ...meta }); paths.push(p);
  }
  for (const p of [...REMOTE.keys()]) {
    if (cur.has(p)) continue;
    const k = kindOf(p);
    if (k === 'app' || k === 'logos') continue;
    if (!isAdmin()) { bad.push({ p, why: 'delete' }); continue; }
    ops.push({ type: 'patch', path: p, data: { _del: true, _delBy: ME.uid, _delByName: ME.name, _delAt: now, _ubName: ME.name } });
    REMOTE.delete(p); META.set(p, { ...(META.get(p) || {}), _del: true }); paths.push(p);
    if (k === 'site') for (const q of [...REMOTE.keys()]) if (q.startsWith(p + '/entries/')) REMOTE.delete(q);
  }
  if (bad.length) revert(bad);
  persist();
  if (!ops.length) { setPill(); return pushing || Promise.resolve(true); }
  PEND += ops.length; setPill();
  const job = CLOUD.commit(ops).then(() => { PEND = Math.max(0, PEND - ops.length); ERR = ''; setPill(); return true; })
    .catch(async e => { PEND = Math.max(0, PEND - ops.length); await writeFailed(e, paths); return false; });
  pushing = job;
  return job;
}
/* put back what this login is not allowed to change, and say why */
function revert(list) {
  const why = isViewer() ? 'Your login is view only.' : list.some(x => x.why === 'delete') ? 'Only the admin can delete.' : list.some(x => x.why === 'approved') ? 'Approved entries can be changed only by the admin.'
    : isViewer() ? 'Your login is view only.' : 'Your login cannot change this. It was put back.';
  for (const { p } of list) {
    const k = kindOf(p), prev = REMOTE.get(p);
    if (k === 'entry') {
      const s = findSite(skOf(p)), c = collOf(p); if (!s) continue;
      const arr = s[c] || (s[c] = []);
      const id = prev ? prev.id : null;
      const i = arr.findIndex(r => prev ? String(r.id) === String(id) : entryPath(skOf(p), c, r.id) === p);
      if (prev) { if (i >= 0) arr[i] = clone(prev); else { arr.push(clone(prev)); sortArr(arr, skOf(p), c); } }
      else if (i >= 0) arr.splice(i, 1);
    } else if (k === 'site') {
      const s = findSite(skOf(p));
      if (prev && s) { for (const key of Object.keys(s)) if (!ENTRY_KEYS.includes(key)) delete s[key]; Object.assign(s, clone(prev)); }
      else if (!prev && s) DB.sites.splice(DB.sites.indexOf(s), 1);
    } else if (k === 'mfund') {
      const i = DB.mfunds.findIndex(f => 'sm_mfunds/' + safeId(f.id) === p);
      if (prev) { if (i >= 0) DB.mfunds[i] = clone(prev); else DB.mfunds.push(clone(prev)); } else if (i >= 0) DB.mfunds.splice(i, 1);
    } else if (k === 'app' && prev) { for (const key of Object.keys(DB)) if (!LOCAL_KEYS.includes(key)) delete DB[key]; Object.assign(DB, clone(prev)); }
    else if (k === 'logos' && prev) { DB.logo = prev.logo; DB.billLogo = prev.billLogo; }
  }
  say(why);
  rerender();
}
async function writeFailed(e, paths) {
  const code = (e && e.code) || '';
  ERR = code === 'permission-denied' ? 'The online database refused a change for your login. It was undone.'
    : code === 'resource-exhausted' ? 'The free daily limit of the online database is used up. Changes upload tomorrow.'
    : 'Could not save online (' + (code || (e && e.message) || 'error') + ').';
  say(ERR); setPill();
  if (code === 'resource-exhausted' || code === 'unavailable') return;
  /* show what the online database really holds for these documents (many at once: one download instead of one per entry) */
  let server = null;
  if (paths.length > 30) { try { server = new Map((await CLOUD.getAllServer()).map(x => [x.path, x.data])); } catch (x) { server = null; } }
  for (const p of paths) {
    try { const d = server ? (server.get(p) || null) : await CLOUD.getDocServer(p); applyDocs([{ type: d ? 'modified' : 'removed', path: p, docId: p.split('/').pop(), data: d || {} }]); }
    catch (x) { REMOTE.delete(p); META.delete(p); }   /* could not see it online: forget it, so the next save sends it again */
  }
  persist(); rerender();
}

/* ---------- pull: put changes from other phones into DB ---------- */
const sortKey = (sk, c, r) => { const m = META.get(entryPath(sk, c, r.id)); return m && m._i != null ? m._i : Number.MAX_SAFE_INTEGER; };
function sortArr(arr, sk, c) { arr.sort((a, b) => sortKey(sk, c, a) - sortKey(sk, c, b)); }
function blankFor(biz) { const s = { ...biz }; for (const k of ENTRY_KEYS) s[k] = []; return s; }
function applyDocs(changes) {
  const touched = new Set();
  let sitesTouched = false, mfTouched = false;
  for (const ch of changes) {
    if (ch.pending) continue;
    const p = ch.path, k = kindOf(p);
    const [biz, meta] = splitMeta(ch.data || {});
    const gone = ch.type === 'removed' || meta._del || meta._test;
    if (k === 'app') {
      if (gone) { REMOTE.delete(p); META.delete(p); continue; }   /* not online (any more): keep the phone's values, so they are sent again */
      const old = REMOTE.get(p) || {};
      for (const key of Object.keys(old)) if (!(key in biz)) delete DB[key];
      Object.assign(DB, clone(biz));
    } else if (k === 'logos') {
      if (gone) { REMOTE.delete(p); META.delete(p); continue; }
      DB.logo = biz.logo || ''; DB.billLogo = biz.billLogo || '';
      if (!DB.logo) delete DB.logo; if (!DB.billLogo) delete DB.billLogo;
    } else if (k === 'site') {
      const sk = skOf(p); let s = findSite(sk);
      if (gone) { if (s) DB.sites.splice(DB.sites.indexOf(s), 1); for (const q of [...REMOTE.keys()]) if (q.startsWith(p + '/')) { REMOTE.delete(q); } REMOTE.delete(p); META.set(p, meta); continue; }
      if (!s) { s = blankFor(clone(biz)); DB.sites.push(s); const orph = ORPHANS.get(sk); ORPHANS.delete(sk); META.set(p, meta); REMOTE.set(p, clone(biz)); if (orph) applyDocs(orph); sitesTouched = true; continue; }
      for (const key of Object.keys(s)) if (!ENTRY_KEYS.includes(key) && !(key in biz)) delete s[key];
      Object.assign(s, clone(biz));
      sitesTouched = true;
    } else if (k === 'entry') {
      const sk = skOf(p), c = collOf(p), s = findSite(sk);
      if (!s) { if (!gone) { const l = ORPHANS.get(sk) || []; l.push(ch); ORPHANS.set(sk, l); } continue; }
      const arr = s[c] || (s[c] = []);
      const prev = REMOTE.get(p);
      const id = prev ? prev.id : biz.id;
      const i = arr.findIndex(r => String(r.id) === String(id));
      if (gone) { if (i >= 0) arr.splice(i, 1); REMOTE.delete(p); META.set(p, meta); continue; }
      META.set(p, meta);
      if (i >= 0) arr[i] = clone(biz); else { arr.push(clone(biz)); touched.add(sk + '|' + c); }
    } else if (k === 'mfund') {
      DB.mfunds = DB.mfunds || [];
      const prev = REMOTE.get(p); const id = prev ? prev.id : biz.id;
      const i = DB.mfunds.findIndex(f => String(f.id) === String(id));
      if (gone) { if (i >= 0) DB.mfunds.splice(i, 1); REMOTE.delete(p); META.set(p, meta); continue; }
      if (i >= 0) DB.mfunds[i] = clone(biz); else DB.mfunds.push(clone(biz));
      mfTouched = true;
    }
    if (!gone) { REMOTE.set(p, clone(biz)); META.set(p, meta); }
  }
  for (const t of touched) { const [sk, c] = t.split('|'); const s = findSite(sk); if (s) sortArr(s[c], sk, c); }
  if (sitesTouched) DB.sites.sort((a, b) => { const ma = META.get('sm_sites/' + siteKey(a)) || {}, mb = META.get('sm_sites/' + siteKey(b)) || {}; return (ma._i ?? 9e15) - (mb._i ?? 9e15); });
  if (mfTouched) DB.mfunds.sort((a, b) => ((META.get('sm_mfunds/' + safeId(a.id)) || {})._i ?? 9e15) - ((META.get('sm_mfunds/' + safeId(b.id)) || {})._i ?? 9e15));
  if (!DB.activeId || !(DB.sites || []).some(s => s.id === DB.activeId)) DB.activeId = DB.sites && DB.sites[0] ? DB.sites[0].id : null;
}
function onDocs(key, changes, cursor, fromCache) {
  if (changes.length) applyDocs(changes);
  if (cursor) CURSORS[key] = cursor;
  if (!fromCache) FIRST.add(key);
  if (changes.length) { persist(); rerender(); }
  setPill();
}

/* ---------- phone copy (one record: DB + what is online + where each list was read up to) ---------- */
const IDBX = {
  p: null,
  open() { if (!this.p) this.p = new Promise((res, rej) => { const q = indexedDB.open('vsms2-sync', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); return this.p; },
  async get(k) { try { const d = await this.open(); return await new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const d = await this.open(); await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} },
  async del(k) { try { const d = await this.open(); await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }
};
let pT = 0;
function persist() {
  clearTimeout(pT);
  pT = setTimeout(() => {
    if (!ME.uid || !READY) return;
    IDBX.set('rec:' + ME.uid, { v: 1, at: Date.now(), me: { ...ME }, db: JSON.stringify(DB), remote: [...REMOTE], meta: [...META], cursors: CURSORS });
  }, 400);
}
async function loadRecord(uid) {
  const r = await IDBX.get('rec:' + uid);
  if (!r || !r.db) return null;
  try { DB = JSON.parse(r.db); } catch (e) { return null; }
  REMOTE = new Map(r.remote || []); META = new Map(r.meta || []); CURSORS = r.cursors || {};
  return r;
}

/* ---------- sync status pill ---------- */
function pillState() {
  if (!ONLINE) return ['off', 'Offline', PEND ? 'Changes are saved on this phone and upload by themselves when the network is back.' : 'No network. You can keep working; changes upload later.'];
  if (ERR) return ['err', 'Not saved', ERR];
  if (PEND) return ['sync', 'Syncing…', 'Uploading ' + PEND + ' change' + (PEND > 1 ? 's' : '') + '…'];
  if (!READY) return ['sync', 'Syncing…', 'Downloading the latest entries…'];
  return ['ok', 'Saved', 'Everything is saved online.'];
}
function setPill() {
  const [s, t, title] = pillState();
  document.querySelectorAll('.smpill').forEach(el => { el.dataset.s = s; el.textContent = t; el.title = title; });
}

/* ---------- start ---------- */
let rq = 0;
function rerender() { if (!STARTED) return; cancelAnimationFrame(rq); rq = requestAnimationFrame(() => { try { render(); } catch (e) { console.error(e); } }); }
function syncPlan() { return seesAll() ? { all: true, cursors: CURSORS } : { all: false, sites: ME.sites.map(safeId), person: ME.person, cursors: CURSORS }; }
function startListeners() {
  if (STOP) { STOP(); STOP = null; }
  FIRST = new Set();
  STOP = CLOUD.startSync(syncPlan(), {
    onDocs, onState: ({ online }) => { if (ONLINE !== online) { ONLINE = online; setPill(); } },
    onError: (e, key) => {
      ERR = e && e.code === 'permission-denied' ? 'Your login cannot read part of the data (' + key + '). Ask the admin to check your role.' : 'Sync problem: ' + ((e && (e.code || e.message)) || 'unknown'); setPill();
      /* refused before anything was downloaded: almost always the Firebase rules are not this app's rules yet */
      if (e && e.code === 'permission-denied' && !READY && !STARTED && !BLOCKED) {
        BLOCKED = true;
        if (isAdmin()) gateRules('Firebase still has the security rules of the earlier test app, so this app is not allowed to read its data yet. Your data is safe: nothing has been changed.');
        else gateText('Setup not finished', 'The admin still has to finish one step in Firebase. Try again in a few minutes.', true);
      }
    }
  });
}
/* wait until every list has been read from the server once */
let BLOCKED = false;
async function initialSync(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (BLOCKED) return false;
    const need = seesAll() ? ['m:app', 'sites', 'mf'] : ['m:app', ...ME.sites.map(s => 's:' + safeId(s))];
    const sitesNow = seesAll() ? [...REMOTE.keys()].filter(p => kindOf(p) === 'site').map(skOf) : ME.sites.map(safeId);
    const all = need.concat(sitesNow.map(sk => 'e:' + sk));
    if (all.every(k => FIRST.has(k))) { await sleep(300); if (all.every(k => FIRST.has(k))) return true; }
    await sleep(150);
  }
  return false;
}
const profSig = p => [p.role, (p.sites || []).slice().sort().join(','), p.person || ''].join('|');
async function onUser(u) {
  if (profUnsub) { profUnsub(); profUnsub = null; }
  if (!u) { if (STOP) { STOP(); STOP = null; } resetAll(); gateLogin('', await CLOUD.ownerClaimed()); return; }
  ME.uid = u.uid; ME.email = u.email;
  KEY = 'vsms2:db:' + u.uid;
  const rec = await loadRecord(u.uid);
  /* open straight from the phone copy only when it holds sites; an empty copy goes through the normal start (welcome / rules screens) */
  if (rec && rec.me && rec.me.active && rec.me.uid === u.uid && (DB.sites || []).length) {
    Object.assign(ME, rec.me); READY = true;
    await startApp();
  } else gate('<p class="g-msg">Opening…</p>');
  profUnsub = CLOUD.watchProfile(u.uid, p => onProfile(p, u), e => { if (!STARTED) gate(`<p class="g-msg">Could not read your login: ${escH(authMsg(e))}</p><button class="btn" data-x="reload">Try again</button><button class="btn sec" data-x="signOut">Sign out</button>`); });
}
async function onProfile(p, u) {
  if (!p) { if (CLAIMING) return; const c = await CLOUD.ownerClaimed(); if (c === false) gateClaim(); else gateNoAccess(); return; }
  if (!p.active) { if (STOP) { STOP(); STOP = null; } STARTED = false; gateText('Login switched off', `The admin has switched off <b>${escH(ME.email)}</b>. Ask the admin if this is a mistake.`); return; }
  const changed = ME.role && profSig(ME) !== profSig(p);
  Object.assign(ME, { name: p.name || u.email, email: p.email || u.email, role: p.role, sites: Array.isArray(p.sites) ? p.sites : [], person: p.person || '', active: true });
  if (isAdmin()) watchUsers();
  if (changed) { await IDBX.del('rec:' + ME.uid); location.reload(); return; }
  if (isMgr() && !ME.sites.length) { gateText('No site yet', 'The admin has not given you a site yet. Ask the admin to tick your site in <b>Users</b>.', true); return; }
  if (STOP) return; // already running
  startListeners();
  if (!READY) {
    gate('<p class="g-msg">Downloading your sites and entries…</p><p class="g-msg tiny">The first time on a phone this needs the internet.</p>');
    const ok = await initialSync(90000);
    if (BLOCKED) return;   /* the rules screen is showing */
    if (!ok && !REMOTE.size) { gate(`<p class="g-msg">Could not download the data. Check the internet and try again.</p><p class="tiny">${escH(ERR)}</p><button class="btn" data-x="reload">Try again</button><button class="btn sec" data-x="signOut">Sign out</button>`); return; }
    DB = assemble(); READY = true; persist();
    if (!(DB.sites || []).length) { if (isAdmin()) { welcome(); return; } gateText('Not set up yet', 'The admin has not added any site yet. Try again later.', true); return; }
    await startApp();
  }
}
/* build DB from what is online */
function assemble() {
  const db = { sites: [], mfunds: [], activeId: null };
  const app = REMOTE.get('sm_meta/app'); if (app) Object.assign(db, clone(app));
  const logos = REMOTE.get('sm_meta/logos'); if (logos) { if (logos.logo) db.logo = logos.logo; if (logos.billLogo) db.billLogo = logos.billLogo; }
  const ord = p => { const m = META.get(p); return m && m._i != null ? m._i : 9e15; };
  const sitePaths = [...REMOTE.keys()].filter(p => kindOf(p) === 'site').sort((a, b) => ord(a) - ord(b));
  for (const sp of sitePaths) {
    const s = blankFor(clone(REMOTE.get(sp))); const sk = skOf(sp);
    for (const c of ENTRY_KEYS) s[c] = [...REMOTE.keys()].filter(p => p.startsWith(sp + '/entries/' + c + '_')).sort((a, b) => ord(a) - ord(b)).map(p => clone(REMOTE.get(p)));
    db.sites.push(s);
  }
  db.mfunds = [...REMOTE.keys()].filter(p => kindOf(p) === 'mfund').sort((a, b) => ord(a) - ord(b)).map(p => clone(REMOTE.get(p)));
  db.activeId = (DB && DB.activeId && db.sites.some(s => s.id === DB.activeId)) ? DB.activeId : (db.sites[0] ? db.sites[0].id : null);
  if (DB && DB.theme) db.theme = DB.theme;
  return db;
}
async function startApp() {
  if (STARTED) return;
  if (!(DB.sites || []).length && !isAdmin()) return;
  hideGate(); STARTED = true;
  document.body.classList.toggle('sm-viewer', isViewer());
  document.body.classList.toggle('sm-acc', isAcc());
  await window.SM_START();
  setPill();
  if (!STOP) startListeners();
}
function resetAll() {
  STARTED = false; READY = false; REMOTE = new Map(); META = new Map(); CURSORS = {}; FIRST = new Set(); PEND = 0; ERR = '';
  Object.assign(ME, { uid: '', email: '', name: '', role: '', sites: [], person: '', active: false });
  DB = { sites: [], activeId: null }; USERS = []; if (usersUnsub) { usersUnsub(); usersUnsub = null; }
  try { $q('#app').innerHTML = ''; $q('#modal').innerHTML = ''; } catch (e) {}
}
function watchUsers() { if (usersUnsub) return; usersUnsub = CLOUD.watchUsers(l => { USERS = l; if ($q('#smUsers')) openUsers(); }, () => {}); }

/* ---------- login screens ---------- */
let CLAIMING = false;
function gate(inner) {
  let g = $q('#smgate'); if (!g) { g = document.createElement('div'); g.id = 'smgate'; document.body.appendChild(g); }
  g.innerHTML = `<div class="g-card"><div class="g-brand"><span class="g-ic"><img src="${typeof APP_ICON !== 'undefined' ? APP_ICON : ''}" alt=""></span><b>Site Manager</b><small>Veershree</small></div>${inner}</div>`;
  g.hidden = false; document.body.classList.add('sm-gated');
  const f = g.querySelector('form');
  if (f) f.addEventListener('submit', e => { e.preventDefault(); const fn = GATE[f.dataset.form]; if (fn) fn(Object.fromEntries(new FormData(f).entries())); });
}
function hideGate() { const g = $q('#smgate'); if (g) { g.hidden = true; g.innerHTML = ''; } document.body.classList.remove('sm-gated'); }
const gErr = m => { const e = $q('#gErr'); if (e) e.textContent = m || ''; const b = $q('#smgate button[type=submit]'); if (b) b.disabled = false; };
const gBusy = () => { const b = $q('#smgate button[type=submit]'); if (b) b.disabled = true; gErr(''); };
const fld = (label, name, type, attrs) => `<div class="field"><label>${label}</label><input name="${name}" type="${type || 'text'}" ${attrs || ''}></div>`;
function authMsg(e) {
  const c = (e && e.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return 'Wrong email or password.';
  if (/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes and try again.';
  if (/network-request-failed/.test(c)) return 'No internet. The first sign-in on a phone needs the internet.';
  if (/email-already-in-use/.test(c)) return 'This email already has a login.';
  if (/weak-password/.test(c)) return 'Password must be at least 6 characters.';
  if (/permission-denied/.test(c)) return 'Not allowed. The security rules may not be published yet.';
  return (e && e.message) || 'Something went wrong.';
}
function gateLogin(msg, claimed) {
  gate(`<form data-form="login" novalidate><h2>Sign in</h2>${fld('Email', 'email', 'email', 'autocomplete="username" required')}${fld('Password', 'pass', 'password', 'autocomplete="current-password" required')}
    <p class="g-err" id="gErr">${escH(msg || '')}</p><button class="btn" type="submit">Sign in</button><button class="btn sec" type="button" data-x="forgot">Forgot password?</button>
    ${claimed === false ? '<p class="tiny" style="margin-top:12px">First time? Nobody has set up this app yet.</p><button class="btn sec" type="button" data-x="owner">Set up the owner account</button>' : ''}</form>`);
}
function gateClaim() {
  gate(`<form data-form="claim" novalidate><h2>Set up as owner</h2><p class="g-msg">You are signed in as <b>${escH(ME.email)}</b>. Nobody owns this app yet. Make this login the admin?</p>${fld('Your name', 'name', 'text', 'value="Rushi" required')}
    <p class="g-err" id="gErr"></p><button class="btn" type="submit">Make me the admin</button><button class="btn sec" type="button" data-x="signOut">Sign out</button></form>`);
}
function gateNoAccess() { gateText('Almost there', `You are signed in as <b>${escH(ME.email)}</b>, but the admin has not given this login access yet. Ask the admin to add you in <b>Users</b>.`, true); }
function gateText(t, html, withSignOut) { gate(`<h2>${escH(t)}</h2><p class="g-msg">${html}</p><button class="btn sec" data-x="reload">Check again</button>${withSignOut ? '<button class="btn sec" data-x="signOut">Sign out</button>' : ''}`); }
const GATE = {
  async login(v) { if (!v.email || !v.pass) return gErr('Enter your email and password.'); gBusy(); try { await CLOUD.signIn(v.email, v.pass); } catch (e) { gErr(authMsg(e)); } },
  async owner(v) {
    if (!(v.name || '').trim() || !(v.email || '').trim()) return gErr('Enter your name and email.');
    if ((v.pass || '').length < 6) return gErr('Password must be at least 6 characters.');
    if (v.pass !== v.pass2) return gErr('The two passwords are not the same.');
    gBusy(); CLAIMING = true;
    try { if (await CLOUD.ownerClaimed()) { gErr('An owner already exists. Sign in instead.'); return; } await CLOUD.createOwnerAccount(v.email, v.pass); await CLOUD.claimOwner({ name: v.name.trim(), email: v.email.trim().toLowerCase(), person: 'Rushi' }); }
    catch (e) { gErr(authMsg(e)); } finally { CLAIMING = false; }
  },
  async claim(v) { if (!(v.name || '').trim()) return gErr('Enter your name.'); gBusy(); try { await CLOUD.claimOwner({ name: v.name.trim(), email: ME.email.toLowerCase(), person: 'Rushi' }); } catch (e) { gErr(authMsg(e)); } }
};
function gateOwner() {
  gate(`<form data-form="owner" novalidate><h2>Owner account</h2><p class="g-msg tiny">You will be the admin. Use an email you can open, so you can reset the password if you forget it.</p>
    ${fld('Your name', 'name', 'text', 'value="Rushi" required')}${fld('Email', 'email', 'email', 'required autocomplete="username"')}${fld('Password', 'pass', 'password', 'required autocomplete="new-password"')}${fld('Password again', 'pass2', 'password', 'required autocomplete="new-password"')}
    <p class="g-err" id="gErr"></p><button class="btn" type="submit">Create owner account</button><button class="btn sec" type="button" data-x="back">Back to sign in</button></form>`);
}

/* ---------- first start for the admin: bring the old Site Manager data ---------- */
function welcome() {
  gate(`<h2>Welcome, ${escH(ME.name)}</h2><p class="g-msg">The online database is empty. Bring in your Site Manager data first, so nothing is lost.</p>
    <ol class="g-steps"><li>In the <b>old</b> Site Manager: <b>More → Excel and backup → Download backup</b>.</li><li>Choose that file here. The app uploads it and then shows a check screen comparing every total.</li></ol>
    <button class="btn" data-x="pickBackup">Choose backup file</button>
    <p class="tiny" style="margin-top:14px">No old data? <a href="#" data-x="startBlank">Start with an empty site</a>.</p>`);
}
function pickFile(cb) {
  const inp = document.createElement('input'); inp.type = 'file';
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; let txt = ''; try { txt = String(await f.text()).replace(/^﻿/, '').trim(); } catch (e) { say('Could not open the file.'); return; } cb(f, txt); };
  inp.click();
}
function parseBackup(f, txt) {
  let d; try { d = JSON.parse(txt); } catch (e) { fileProblem(f, 'This is not a backup file: it does not contain backup data.', txt); return null; }
  if (d && d.app === 'veershree-plot-expense') { fileProblem(f, 'This is a backup of the Plot Expense Manager, not of the Site Manager. Take the backup in the Site Manager: More → Excel and backup → Download backup.', txt); return null; }
  const sites = readSites(d);
  if (!sites || !sites.length) { fileProblem(f, 'No site was found in this file. Choose the Site Manager backup (site-manager-backup-….json).', txt); return null; }
  return d;
}
function fileProblem(f, msg, txt) {
  const html = `<p class="g-msg">${escH(msg)}</p><div class="card"><div class="pad tiny">File: <b>${escH(f.name)}</b><br>Size: ${(f.size / 1024).toFixed(1)} KB<br>Starts with: <code>${escH(String(txt || '').slice(0, 70))}</code></div></div><p class="tiny">Send Claude a screenshot of this screen.</p>`;
  if (STARTED) openSheet('Could not import this file', html, null, null); else gate('<h2>Could not import this file</h2>' + html + '<button class="btn" data-x="pickBackup">Choose another file</button>');
}
let LAST_IMPORT = null;
const RULES_URL = 'https://github.com/Rushi99080/veershree-expense/blob/main/firestore.rules';
async function gateRules(msg) {
  let rules = '';
  try { const r = await fetch('firestore.rules', { cache: 'no-cache' }); if (r.ok) rules = await r.text(); } catch (e) { }
  gate(`<h2>One step in Firebase first</h2><p class="g-msg">${escH(msg)}</p>
    <ol class="g-steps"><li>Tap <b>Copy the new rules</b> below.</li>
    <li>Open <b>console.firebase.google.com</b> → project <b>veershree-expense</b> → <b>Firestore Database</b> → <b>Rules</b>.</li>
    <li>Delete everything in the box, paste, and tap <b>Publish</b>.</li>
    <li>Wait one minute, come back here and tap <b>Try again</b>.</li></ol>
    ${rules ? `<button class="btn" data-x="copy" data-v="${escH(rules)}">Copy the new rules</button>` : `<p class="tiny">The rules are here: <a href="${RULES_URL}" target="_blank" rel="noopener">firestore.rules</a> (open, tap Raw, copy all).</p>`}
    <button class="btn sec" data-x="importRetry">Try again</button>`);
}
async function importBackup(d, fileName) {
  if (!isAdmin()) return say('Only the admin can import.');
  if (!navigator.onLine) return say('Connect to the internet to import.');
  LAST_IMPORT = { d, fileName };
  /* make sure the online database already has this app's security rules — otherwise every upload would be refused */
  try { await CLOUD.probeRead('site', 'rules-check'); }
  catch (e) {
    if (e && e.code === 'permission-denied') return gateRules('The security rules in Firebase are still the ones for the earlier test app, so the online database would refuse the upload. Nothing has been uploaded yet.');
    return gate(`<h2>No connection</h2><p class="g-msg">Could not reach the online database (${escH((e && e.code) || 'offline')}). Check the internet and try again. Nothing has been uploaded yet.</p><button class="btn" data-x="importRetry">Try again</button>`);
  }
  const raw = clone(d);
  const sites = readSites(raw);
  const n = sites.reduce((a, s) => a + ENTRY_KEYS.reduce((b, k) => b + ((s[k] || []).length), 0), 0);
  gate(`<p class="g-msg">Uploading ${sites.length} site${sites.length > 1 ? 's' : ''} and ${n.toLocaleString('en-IN')} entries…</p><p class="tiny">Keep this screen open.</p>`);
  const keep = { theme: DB.theme };
  DB = Array.isArray(raw) ? { sites: raw } : (raw.sites ? raw : { sites });
  delete DB.lastSnap;
  Object.assign(DB, keep);
  DB.sites = sites;
  HOLD = true;
  try { migrate(); await sleep(400); }   /* the app's own clean-up, exactly as when it opens a file */
  finally { HOLD = false; }
  const ok = await push();
  if (!ok) { gate(`<h2>Upload stopped</h2><p class="g-msg">${escH(ERR)}</p><p class="tiny">Your backup file is not changed. Try again: entries already online are skipped, the rest are sent.</p><button class="btn" data-x="importRetry">Try again</button>`); return; }
  try { await CLOUD.waitPending(); } catch (e) {}
  STARTED ? null : await startApp();
  await runCheck(d, fileName);
}

/* ---------- the import check: every total, backup vs online, using the app's own formulas ---------- */
function metrics(db) {
  const saved = DB; DB = db;
  try {
    const out = { sites: [], cats: [], people: [], mgr: [], counts: {} };
    for (const s of db.sites) {
      const t = totals(s);
      const hrs = s.machineLog.reduce((a, r) => a + hoursOf(r), 0);
      out.sites.push({ id: s.id, name: s.name, n: ENTRY_KEYS.reduce((a, k) => a + s[k].length, 0), exp: t.expTotal, dsl: t.dsTotal, litres: t.dsLitres, murum: t.muTotal, vpay: t.vendorPaid, rent: t.rentBilled, rentPaid: t.rentPaid, comm: t.rentComm, grand: t.grand, pending: t.netPending, hrs });
      for (const c of s.categories) { const x = categoryStats(s, c, t.fin); if (x.entries) out.cats.push({ k: s.id + '|' + c, site: s.name, c, total: x.total }); }
      for (const p of s.people) { const x = personStats(s, p); if (x.total || x.received) out.people.push({ k: s.id + '|' + p, site: s.name, p, spent: x.total, rec: x.received }); }
      for (const k of ENTRY_KEYS) out.counts[k] = (out.counts[k] || 0) + s[k].length;
    }
    for (const m of (db.managers || [])) { const x = mgrStats(m.name); out.mgr.push({ k: m.name, rec: x.received, spent: x.spent, bal: x.balance }); }
    out.counts.mfunds = (db.mfunds || []).length;
    return out;
  } finally { DB = saved; }
}
const eqv = (a, b) => Math.round(num(a) * 100) === Math.round(num(b) * 100);
async function runCheck(d, fileName) {
  openSheet('Import check', '<p class="tiny">Reading everything back from the online database…</p>', null, null);
  let docs;
  try { docs = await CLOUD.getAllServer(); } catch (e) { openSheet('Import check', `<div class="warn">Could not read back: ${escH(e.code || e.message)}</div>`, null, null); return; }
  /* backup side: the file, cleaned up the way the app does when it opens it */
  const A_db = clone(Array.isArray(d) ? { sites: d } : d); A_db.sites = readSites(A_db).map(s => normSite(clone(s))); A_db.managers = A_db.managers || []; A_db.mfunds = A_db.mfunds || [];
  /* online side: straight from the server */
  const R = new Map(), M = new Map();
  for (const x of docs) { const [b, m] = splitMeta(x.data); if (m._del || m._test) continue; R.set(x.path, b); M.set(x.path, m); }
  const saveR = REMOTE, saveM = META; REMOTE = R; META = M;
  let B_db; try { B_db = assemble(); } finally { REMOTE = saveR; META = saveM; }
  B_db.sites = B_db.sites.map(s => normSite(clone(s))); B_db.managers = B_db.managers || []; B_db.mfunds = B_db.mfunds || [];
  const A = metrics(A_db), B = metrics(B_db);
  let n = 0, bad = 0;
  const cell = (a, b, f) => { n++; if (eqv(a, b)) return (f || money)(a); bad++; return `<span class="smdiff">${(f || money)(a)} → ${(f || money)(b)}</span>`; };
  const siteRows = A.sites.map(a => { const b = B.sites.find(x => x.id === a.id) || {}; return `<div class="card"><h3>${escH(a.name)}<small>${a.n.toLocaleString('en-IN')} entries</small></h3><div class="pad tiny smck">
      Entries: ${cell(a.n, b.n, v => num(v).toLocaleString('en-IN'))}<br>Expenses: ${cell(a.exp, b.exp)}<br>Diesel: ${cell(a.dsl, b.dsl)} · ${cell(a.litres, b.litres, v => dec(v) + ' L')}<br>Murum: ${cell(a.murum, b.murum)}<br>Vendor payments: ${cell(a.vpay, b.vpay)}<br>
      Rent bills: ${cell(a.rent, b.rent)} · paid ${cell(a.rentPaid, b.rentPaid)} · commission ${cell(a.comm, b.comm)}<br>Machine hours: ${cell(a.hrs, b.hrs, v => dec(v) + ' hrs')}<br><b>Total cost: ${cell(a.grand, b.grand)}</b> · Pending: ${cell(a.pending, b.pending)}</div></div>`; }).join('');
  const extraSites = B.sites.filter(b => !A.sites.some(a => a.id === b.id)).length;
  const listRows = (arrA, arrB, label, fields) => arrA.map(a => { const b = arrB.find(x => x.k === a.k) || {}; return `<div class="row"><div class="main"><div class="ttl">${escH(label(a))}</div><div class="sub">${fields.map(([f, l, fmt]) => l + ' ' + cell(a[f], b[f], fmt)).join(' · ')}</div></div></div>`; }).join('');
  const cats = listRows(A.cats, B.cats, a => a.site + ' · ' + a.c, [['total', 'Total']]);
  const ppl = listRows(A.people, B.people, a => a.site + ' · ' + a.p, [['rec', 'Received'], ['spent', 'Spent']]);
  const mgr = listRows(A.mgr, B.mgr, a => a.k, [['rec', 'Received'], ['spent', 'Spent'], ['bal', 'Balance']]);
  const cnt = Object.keys(A.counts).map(k => `${KIND_LABEL[k] || 'Money to managers'}: ${cell(A.counts[k], B.counts[k] || 0, v => num(v).toLocaleString('en-IN'))}`).join('<br>');
  const ok = bad === 0;
  const text = `Site Manager import check (${today()})\nFile: ${fileName || ''}\nResult: ${ok ? 'ALL ' + n + ' CHECKS MATCH' : bad + ' of ' + n + ' checks differ'}\nEntries: ${A.sites.reduce((a, s) => a + s.n, 0)} in backup`;
  openSheet('Import check', `<div class="${ok ? 'smok' : 'warn'}">${ok ? `<b>Everything matches.</b> All ${n} checks — totals per site, per expense head, per person, per manager and entry counts — are the same in the backup and online.` : `<b>${bad} of ${n} checks differ.</b> Do not start using the app yet. Send Claude a screenshot of the red lines.`}</div>
    ${extraSites ? `<p class="tiny">${extraSites} other site(s) online are not in this backup and are not part of this check.</p>` : ''}
    <div class="shead">Entries</div><div class="card"><div class="pad tiny smck">${cnt}</div></div>
    <div class="shead">By site</div>${siteRows}
    ${mgr ? `<div class="shead">Managers (cash book)</div><div class="card">${mgr}</div>` : ''}
    ${ppl ? `<div class="shead">Person-wise</div><div class="card">${ppl}</div>` : ''}
    <div class="shead">Expense heads</div><div class="card">${cats}</div>
    <div class="btnrow" style="margin-top:12px"><button class="btn sec sm" style="flex:1" data-x="copy" data-v="${escH(text)}">Copy result</button></div>`, null, null);
}

/* ---------- approvals ---------- */
function pendingList() {
  const out = [];
  for (const [p, m] of META) {
    if (m._appr !== 'pending' || m._del || !REMOTE.has(p)) continue;
    const k = kindOf(p), biz = REMOTE.get(p);
    if (k !== 'entry' && k !== 'mfund') continue;
    const s = k === 'entry' ? findSite(skOf(p)) : null;
    out.push({ p, m, biz, coll: k === 'entry' ? collOf(p) : 'mfund', site: s ? s.name : '' });
  }
  return out.sort((a, b) => (b.m._at || 0) - (a.m._at || 0));
}
function entryLine(x) {
  const r = x.biz, c = x.coll;
  const amt = c === 'bills' ? money((r.items || []).reduce((a, i) => a + num(i.amount), 0)) : c === 'machineLog' ? dec(hoursOf(r)) + ' hrs' : c === 'murumLog' ? money(mAmt(r)) : has(r.amount) ? money(r.amount) : '';
  const what = c === 'machineLog' ? 'Machine ' + (r.machineNo || '') : c === 'expenseLog' ? (r.category || 'Expense') + (r.vendor ? ' · ' + r.vendor : '') : c === 'dieselLog' ? 'Diesel · ' + (r.vendor || '') : c === 'bills' ? 'Rent bill ' + (r.no || '') + ' · ' + (r.owner || '') : c === 'mfund' ? 'Money to ' + (r.manager || '') : (KIND_LABEL[c] || c) + (r.vendor ? ' · ' + r.vendor : r.owner ? ' · ' + r.owner : r.person ? ' · ' + r.person : '');
  return { what, amt, sub: [fmtDate(r.date), x.site, x.m._byName ? 'by ' + x.m._byName : ''].filter(Boolean).join(' · ') };
}
function openApprovals() {
  const list = pendingList();
  const rows = list.map(x => { const l = entryLine(x); return `<div class="row"><div class="main"><div class="ttl">${escH(l.what)}</div><div class="sub">${escH(KIND_LABEL[x.coll] || '')} · ${escH(l.sub)}</div></div><div class="amt">${escH(l.amt)}</div>${isAdmin() ? `<button class="rowbtn" data-x="approve" data-v="${escH(x.p)}">Approve</button>` : ''}</div>`; }).join('');
  openSheet('Waiting for approval', `<div id="smApprovals">${list.length ? `<div class="card">${rows}</div>${isAdmin() && list.length > 1 ? `<div class="btnrow"><button class="btn" style="flex:1" data-x="approveAll">Approve all ${list.length}</button></div>` : ''}`
    : '<div class="card"><div class="pad tiny">Nothing is waiting for approval.</div></div>'}
    <p class="tiny" style="margin-top:10px">${isAdmin() ? 'Entries made by site managers wait here until you approve them. To change one first, open it in its own screen, edit, then approve here.' : 'Your entries wait here until the admin approves them. You can still change them until then.'}</p></div>`, null, null);
}
async function approve(paths) {
  if (!isAdmin()) return;
  const ops = paths.map(p => ({ type: 'patch', path: p, data: { _appr: 'approved', _apBy: ME.uid, _apByName: ME.name, _apAt: Date.now(), _ubName: ME.name } }));
  for (const p of paths) META.set(p, { ...(META.get(p) || {}), _appr: 'approved', _apByName: ME.name });
  persist(); PEND += ops.length; setPill();
  try { await CLOUD.commit(ops); PEND -= ops.length; say(paths.length > 1 ? paths.length + ' entries approved' : 'Approved'); } catch (e) { PEND -= ops.length; await writeFailed(e, paths); }
  setPill(); rerender(); if ($q('#smApprovals')) openApprovals();
}

/* ---------- users (admin) ---------- */
function openUsers() {
  if (!isAdmin()) return;
  const list = USERS.slice().sort((a, b) => (b.active !== false) - (a.active !== false) || String(a.name).localeCompare(String(b.name)));
  const sitesTxt = u => u.role === 'manager' ? ((u.sites || []).map(id => { const s = DB.sites.find(x => x.id === id); return s ? s.name : '?'; }).join(', ') || 'No site') : 'All sites';
  openSheet('Users', `<div id="smUsers"><div class="btnrow" style="margin-bottom:10px"><button class="btn" style="flex:1" data-x="userAdd">Add user</button></div>
    <div class="card">${list.map(u => `<div class="row" data-x="userEdit" data-v="${escH(u.uid)}"><div class="main"><div class="ttl">${escH(u.name || '')} ${u.active === false ? '<span class="pill u">switched off</span>' : ''}</div><div class="sub">${escH(ROLE_LABEL[u.role] || u.role)} · ${escH(sitesTxt(u))}${u.person ? ' · cash book: ' + escH(u.person) : ''}<br>${escH(u.email || '')}</div></div></div>`).join('') || '<div class="pad tiny">Loading…</div>'}</div>
    <div class="shead">What each role can do</div><div class="card"><div class="pad tiny" style="line-height:1.7">
    <b>Admin</b> — everything: users, sites, settings, approve, delete, import, backup.<br><b>Site Manager</b> — sees and adds entries only for the sites you tick, and only their own cash book. Their entries wait for your approval; after approval they cannot change them.<br>
    <b>Accountant</b> — sees everything; marks expenses, diesel and murum as paid, records payments on rent bills, vendor and owner payments, and money received.<br><b>Viewer</b> — partners and owners: can look at everything, cannot change anything.</div></div></div>`, null, null);
}
function userForm(u) {
  const r = u || { role: 'manager', sites: [], person: '', active: true };
  const self = u && u.uid === ME.uid;
  const persons = [...new Set([...(DB.managers || []).map(m => m.name), ...DB.sites.flatMap(s => s.people || [])])].filter(Boolean);
  openSheet(u ? 'Edit user' : 'Add user', `<div id="smUserForm" data-uid="${escH(u ? u.uid : '')}"><div class="card"><div class="pad">
    ${fld('Name', 'u_name', 'text', `value="${escH(r.name || '')}" placeholder="e.g. Sahil"`)}
    ${fld('Email (login ID)', 'u_email', 'email', `value="${escH(r.email || '')}" ${u ? 'readonly' : ''} autocomplete="off"`)}
    ${u ? '' : fld('Password', 'u_pass', 'text', `value="${genPass()}" autocomplete="off"`)}
    <div class="field"><label>Role</label><select name="u_role" ${self ? 'disabled' : ''}>${[['manager', 'Site Manager'], ['accountant', 'Accountant'], ['viewer', 'Viewer (partner / owner)'], ['admin', 'Admin']].map(([v, l]) => `<option value="${v}"${r.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Cash book (manager name)</label><select name="u_person"><option value="">— none —</option>${persons.map(n => `<option${norm(n) === norm(r.person) ? ' selected' : ''}>${escH(n)}</option>`).join('')}</select></div>
    <div class="field" id="smUSites"><label>Sites this manager works on</label>${DB.sites.map(s => `<label class="smchk"><input type="checkbox" name="site" value="${escH(s.id)}"${(r.sites || []).includes(s.id) ? ' checked' : ''}> ${escH(s.name)}</label>`).join('')}</div>
    ${u && !self ? `<div class="field"><label>Status</label><select name="u_active"><option value="1"${r.active !== false ? ' selected' : ''}>Active</option><option value="0"${r.active === false ? ' selected' : ''}>Switched off</option></select></div>` : ''}
    <button class="btn" data-x="userSave">${u ? 'Save' : 'Create login'}</button>
    ${u ? `<button class="btn sec sm" style="margin-top:8px;width:100%" data-x="resetPass" data-v="${escH(r.email)}">Send password reset email</button>` : '<p class="tiny" style="margin-top:8px">After saving, send the email and password to the person on WhatsApp.</p>'}
    ${self ? '<p class="tiny">You cannot change your own role or switch yourself off.</p>' : ''}</div></div></div>`, null, null);
  const roleSel = document.querySelector('[name=u_role]'), sitesBox = $q('#smUSites');
  const upd = () => { sitesBox.hidden = roleSel.value !== 'manager'; };
  roleSel.addEventListener('change', upd); upd();
}
const genPass = () => ['plot', 'site', 'gold', 'road', 'murum', 'jcb', 'waki', 'vista'][Math.floor(Math.random() * 8)] + '-' + Math.floor(1000 + Math.random() * 9000);
async function userSave() {
  const box = $q('#smUserForm'); if (!box) return;
  const q = n => box.querySelector(`[name=${n}]`);
  const id = box.dataset.uid, self = id === ME.uid;
  const name = q('u_name').value.trim(), email = q('u_email').value.trim().toLowerCase();
  const role = self ? 'admin' : q('u_role').value, person = q('u_person').value;
  const sites = role === 'manager' ? [...box.querySelectorAll('[name=site]:checked')].map(x => x.value) : [];
  if (!name) return say('Enter the name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('Enter a valid email');
  if (role === 'manager' && !sites.length) return say('Tick at least one site');
  if (role === 'manager' && !person) return say('Choose whose cash book this manager sees');
  const data = { name, email, role, sites, person, active: self ? true : (q('u_active') ? q('u_active').value === '1' : true) };
  try {
    let uid = id;
    if (!uid) { const pass = q('u_pass').value; if (pass.length < 6) return say('Password must be at least 6 characters'); say('Creating login…'); uid = await CLOUD.createUser(email, pass); data.createdAt = Date.now(); data.createdBy = ME.uid; await CLOUD.saveUser(uid, data); shareLogin(name, email, pass); return; }
    await CLOUD.saveUser(uid, data); say('User saved'); openUsers();
  } catch (e) { say(authMsg(e)); }
}
function shareLogin(name, email, pass) {
  const url = location.origin + location.pathname;
  const text = `*Site Manager — Veershree*\nHi ${name}, here is your login.\nOpen: ${url}\nEmail: ${email}\nPassword: ${pass}\nOn iPhone: open the link in Safari → Share → Add to Home Screen.`;
  openSheet('Login created', `<div class="card"><div class="pad"><p class="tiny">Send these details to <b>${escH(name)}</b>:</p><pre class="smpre">${escH(text)}</pre>
    <a class="btn" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">Send on WhatsApp</a>
    <button class="btn sec sm" style="width:100%;margin-top:8px" data-x="copy" data-v="${escH(text)}">Copy</button></div></div>`, null, null);
}

/* ---------- my account ---------- */
function openAccount() {
  const [, st, title] = pillState();
  const sitesTxt = isMgr() ? ME.sites.map(id => { const s = DB.sites.find(x => x.id === id); return s ? s.name : '?'; }).join(', ') : 'All sites';
  openSheet('My account', `<div class="card"><div class="pad tiny" style="line-height:1.8"><b style="font-size:16px">${escH(ME.name)}</b> · ${escH(ROLE_LABEL[ME.role] || '')}<br>${escH(ME.email)}<br>Sites: ${escH(sitesTxt)}${ME.person ? '<br>Cash book: ' + escH(ME.person) : ''}</div></div>
    <div class="card"><h3>Data on this phone<small>${escH(st)}</small></h3><div class="pad tiny" style="line-height:1.7">${escH(title)}<br>Entries on this phone: ${(DB.sites || []).reduce((a, s) => a + ENTRY_KEYS.reduce((b, k) => b + (s[k] || []).length, 0), 0).toLocaleString('en-IN')}
      <div class="btnrow" style="margin-top:8px"><button class="btn sec sm" style="flex:1" data-x="resync">Download everything again</button></div></div></div>
    ${isAdmin() ? `<div class="card"><h3>Backup check</h3><div class="pad tiny">Compare a Site Manager backup file with what is online, using the app's own totals.<div class="btnrow" style="margin-top:8px"><button class="btn sec sm" style="flex:1" data-x="checkFile">Check against a backup</button></div></div></div>` : ''}
    <div class="card"><h3>Security check</h3><div class="pad tiny">${isAdmin() ? 'As admin you are allowed everything. To test the rules, sign in on another phone as a site manager, accountant or viewer and run this check there.' : 'Tries a few things your login is <b>not</b> allowed to do, and confirms the online database refuses each one. Needs the internet.<div class="btnrow" style="margin-top:8px"><button class="btn sm" style="flex:1" data-x="secCheck">Run security check</button></div><div id="smSec"></div>'}</div></div>
    <div class="btnrow"><button class="btn sec" style="flex:1" data-x="changePass">Change password</button><button class="btn dgr" style="flex:1" data-x="signOut">Sign out</button></div>`, null, null);
}
function changePassForm() {
  openSheet('Change password', `<div class="card"><div class="pad" id="smPw">${fld('Current password', 'old', 'password', 'autocomplete="current-password"')}${fld('New password', 'n1', 'password', 'autocomplete="new-password"')}${fld('New password again', 'n2', 'password', 'autocomplete="new-password"')}<button class="btn" data-x="pwSave">Change</button></div></div>`, null, null);
}
async function securityCheck() {
  const out = $q('#smSec'); if (!out) return;
  if (!navigator.onLine) { out.innerHTML = '<div class="warn">Connect to the internet first.</div>'; return; }
  const tid = 'selftest-' + Date.now().toString(36);
  const tests = [], T = (name, fn) => tests.push({ name, fn });
  const mk = (coll, sid, extra) => ({ id: tid + '-' + tests.length, date: today(), amount: 1, remark: 'Security check (ignore)', _c: coll, _s: sid, _i: 0, _by: ME.uid, _byName: ME.name, _at: Date.now(), _appr: 'pending', _test: true, ...(extra || {}) });
  const setOp = (sid, coll, r) => [{ type: 'set', path: entryPath(safeId(sid), coll, r.id), data: r }];
  const mine = DB.sites[0];
  const otherSite = USERS.length ? null : null;
  const anyEntryPath = [...REMOTE.keys()].find(p => kindOf(p) === 'entry' && collOf(p) === 'expenseLog');
  const approvedPath = [...META].find(([p, m]) => kindOf(p) === 'entry' && m._appr === 'approved' && REMOTE.has(p));
  const remarkProbe = p => { const r = REMOTE.get(p) || {}; return { ops: [{ type: 'patch', path: p, data: { remark: (r.remark || '') + ' ·' } }], undo: [{ type: 'patch', path: p, data: { remark: r.remark || '' } }] }; };
  T('Change your own role to admin', () => ({ run: () => CLOUD.saveUser(ME.uid, { role: 'admin' }) }));
  T('Change the managers list (app settings)', () => ({ run: () => CLOUD.commit([{ type: 'set', path: 'sm_meta/app', data: clone(REMOTE.get('sm_meta/app') || {}) }]) }));
  T('See the list of all users', () => ({ run: () => CLOUD.probeRead('users') }));
  T('Add a new site', () => ({ run: () => CLOUD.commit([{ type: 'set', path: 'sm_sites/' + tid, data: { id: tid, name: 'Security check', _test: true } }]) }));
  if (isMgr()) {
    const notMine = 'not-my-site-' + tid;
    T('Add an entry to a site that is not yours', () => ({ ops: setOp(notMine, 'expenseLog', mk('expenseLog', notMine)) }));
    T('Read entries of a site that is not yours', () => ({ run: () => CLOUD.probeRead('site', notMine) }));
    if (mine) T('Add an entry that is already approved', () => ({ ops: setOp(mine.id, 'expenseLog', mk('expenseLog', mine.id, { _appr: 'approved' })) }));
    if (mine) T('Add an entry marked as deleted', () => ({ ops: setOp(mine.id, 'expenseLog', mk('expenseLog', mine.id, { _del: true })) }));
    if (approvedPath) T('Change an approved entry', () => remarkProbe(approvedPath[0]));
    const other = (DB.managers || []).map(m => m.name).find(n => norm(n) !== norm(ME.person)) || 'Someone else';
    T(`Read ${other}'s cash book`, () => ({ run: () => CLOUD.probeRead('mfunds', other) }));
  } else {
    if (mine) T('Add an expense', () => ({ ops: setOp(mine.id, 'expenseLog', mk('expenseLog', mine.id, { _appr: 'approved' })) }));
    if (anyEntryPath) T('Change the details of an expense', () => remarkProbe(anyEntryPath));
    if (isViewer() && mine) T('Record a vendor payment', () => ({ ops: setOp(mine.id, 'vendorPayments', mk('vendorPayments', mine.id, { vendor: 'Security check', _appr: 'approved' })) }));
  }
  out.innerHTML = '<p class="tiny">Checking…</p>';
  const res = [];
  for (const t of tests) {
    const p = t.fn(); const job = p.run ? p.run() : CLOUD.commit(p.ops);
    const r = await Promise.race([job.then(() => 'allowed', e => (e && e.code === 'permission-denied') ? 'blocked' : 'error: ' + ((e && e.code) || 'unknown')), sleep(12000).then(() => 'no answer')]);
    if (r === 'allowed' && p.undo) { try { await CLOUD.commit(p.undo); } catch (e) {} }
    res.push({ name: t.name, r });
  }
  const nbad = res.filter(x => x.r === 'allowed').length;
  out.innerHTML = `<div class="${nbad ? 'warn' : 'smok'}" style="margin-top:10px">${nbad ? `<b>${nbad} problem${nbad > 1 ? 's' : ''} found.</b> Tell Claude which line says "Allowed".` : `<b>All ${res.length} checks passed.</b> The online database refused everything your login should not do.`}</div>
    ${res.map(x => `<div class="row"><div class="main"><div class="ttl" style="font-size:13px">${escH(x.name)}</div></div><span class="pill ${x.r === 'blocked' ? 'p' : 'u'}">${x.r === 'blocked' ? 'Blocked' : x.r === 'allowed' ? 'Allowed' : escH(x.r)}</span></div>`).join('')}`;
}

/* ---------- hooks used by index.html ---------- */
function menuHtml() {
  const n = pendingList().length;
  const line = (x, label, icn, extra) => `<div class="row" data-x="${x}">${ava('', icn, 'c6')}<div class="main"><div class="ttl">${label}</div></div>${extra || ''}${ic('chevR', 'chev')}</div>`;
  return `<div class="shead">Team and account</div><div class="card mlist">
    ${(isAdmin() || isMgr()) ? line('approvals', 'Waiting for approval', 'check', n ? `<span class="pill u">${n}</span>` : '') : ''}
    ${isAdmin() ? line('users', 'Users and roles', 'manager') : ''}
    ${line('account', 'My account · ' + escH(ROLE_LABEL[ME.role] || ''), 'person')}</div>`;
}
function sideHtml() {
  const n = pendingList().length;
  return `<div class="slabel">Team</div><div class="snav">
    ${(isAdmin() || isMgr()) ? `<button data-x="approvals">${ICON.check || ''}<span>Approvals${n ? ' (' + n + ')' : ''}</span></button>` : ''}
    ${isAdmin() ? `<button data-x="users">${ICON.manager || ''}<span>Users</span></button>` : ''}
    <button data-x="account">${ICON.person || ''}<span>${escH(ME.name)} · ${escH(ROLE_LABEL[ME.role] || '')}</span></button></div>`;
}
function afterRender() {
  const top = $q('.topbar');
  if (top && !top.querySelector('.smpill')) { const b = document.createElement('button'); b.className = 'smpill'; b.dataset.x = 'pill'; const sp = top.querySelector('.sitepick'); if (sp) sp.after(b); else top.prepend(b); }
  setPill();
  const pend = pendingList();
  if (pend.length) {
    const ids = new Set(pend.map(x => String(x.biz.id)));
    document.querySelectorAll('#app [data-v]').forEach(el => { if (ids.has(el.dataset.v) && !el.querySelector('.smpend')) { const t = el.querySelector('.ttl') || el; t.insertAdjacentHTML('beforeend', ' <span class="smpend">Pending</span>'); } });
    if (TAB === 'dash' && (isAdmin() || isMgr()) && !$q('#smApprCard')) {
      const main = $q('#app main');
      if (main) main.insertAdjacentHTML('afterbegin', `<div class="card mlist smappr" id="smApprCard"><div class="row" data-x="approvals">${ava('', 'check', 'c1')}<div class="main"><div class="ttl">${isAdmin() ? 'Waiting for your approval' : 'Your entries waiting for approval'}</div><div class="sub">${pend.length} entr${pend.length === 1 ? 'y' : 'ies'} · tap to see</div></div><span class="pill u">${pend.length}</span>${ic('chevR', 'chev')}</div></div>`);
    }
  }
}
function scopeManagers(l) { return isMgr() ? l.filter(m => norm(m.name) === norm(ME.person)) : l; }
function can(what) { if (what === 'import') return isAdmin(); return true; }
try { if (!ICON.check) ICON.check = SVG('<path d="M4.5 12.5l5 5L19.5 7"/>'); } catch (e) { }
window.SM_SYNC = { push, afterRender, menuHtml, sideHtml, scopeManagers, can, me: () => ME };

/* ---------- clicks: this layer's buttons, and role guards on the app's own buttons ---------- */
let LAST_OPEN = '';
document.addEventListener('click', async e => {
  const x = e.target.closest('[data-x]');
  if (x) {
    e.preventDefault(); e.stopPropagation();
    const a = x.dataset.x, v = x.dataset.v;
    if (x.closest('.sheet') && ['approvals', 'users', 'account'].includes(a)) closeSheet();
    switch (a) {
      case 'pill': { const [, , t] = pillState(); if (ERR) { ERR = ''; startListeners(); } say(t); break; }
      case 'approvals': openApprovals(); break;
      case 'approve': approve([v]); break;
      case 'approveAll': approve(pendingList().map(y => y.p)); break;
      case 'users': openUsers(); break;
      case 'userAdd': userForm(null); break;
      case 'userEdit': userForm(USERS.find(u => u.uid === v)); break;
      case 'userSave': userSave(); break;
      case 'resetPass': try { await CLOUD.resetPassword(v); say('Reset email sent to ' + v); } catch (er) { say(authMsg(er)); } break;
      case 'account': openAccount(); break;
      case 'changePass': changePassForm(); break;
      case 'pwSave': { const b = $q('#smPw'), g = n => b.querySelector(`[name=${n}]`).value; if (g('n1').length < 6) return say('At least 6 characters'); if (g('n1') !== g('n2')) return say('The two new passwords are not the same'); try { await CLOUD.changePassword(g('old'), g('n1')); closeSheet(); say('Password changed'); } catch (er) { say(authMsg(er)); } break; }
      case 'signOut': { if (PEND && !confirm(PEND + ' change(s) are not uploaded yet. Sign out anyway?')) break; closeSheet(); await IDBX.del('rec:' + ME.uid); await CLOUD.signOut(); location.reload(); break; }
      case 'resync': { if (!confirm('Download everything again from the online database?')) break; await IDBX.del('rec:' + ME.uid); location.reload(); break; }
      case 'secCheck': securityCheck(); break;
      case 'checkFile': pickFile((f, txt) => { const d = parseBackup(f, txt); if (d) runCheck(d, f.name); }); break;
      case 'copy': try { await navigator.clipboard.writeText(v); say('Copied'); } catch (er) { prompt('Copy this:', v); } break;
      case 'reload': location.reload(); break;
      case 'forgot': { const em = ($q('#smgate [name=email]') || {}).value; if (!em) return gErr('Type your email first, then tap "Forgot password?".'); try { await CLOUD.resetPassword(em); gErr(''); say('Password reset email sent to ' + em); } catch (er) { gErr(authMsg(er)); } break; }
      case 'owner': gateOwner(); break;
      case 'back': gateLogin('', await CLOUD.ownerClaimed()); break;
      case 'pickBackup': pickFile((f, txt) => { const d = parseBackup(f, txt); if (d) importBackup(d, f.name); }); break;
      case 'startBlank': await startApp(); break;
      case 'importRetry': if (LAST_IMPORT) importBackup(LAST_IMPORT.d, LAST_IMPORT.fileName); else location.reload(); break;
    }
    return;
  }
  const el = e.target.closest('[data-act]'); if (!el || !ME.role) return;
  const a = el.dataset.act;
  if (/Edit$|Open$|^vBill$|^obOpen$/.test(a) && el.dataset.v) LAST_OPEN = el.dataset.v;
  if (/Add$|^quickAdd$/.test(a)) LAST_OPEN = '';
  const block = msg => { e.preventDefault(); e.stopImmediatePropagation(); say(msg); };
  if (isViewer() && (a === 'sheetSave' || a === 'sheetDelete' || a === 'quickAdd' || /Add$/.test(a) || a === 'impSup' || a === 'xlAllDone')) return block('Your login is view only.');
  if (!isAdmin() && (a === 'sheetDelete' || a === 'siteDel' || /^delPass/.test(a) || a === 'impJson' || a === 'impAdd' || a === 'impReplace' || a === 'snapBack')) return block(a === 'sheetDelete' || a === 'siteDel' ? 'Only the admin can delete.' : 'Only the admin can do this.');
  if (isMgr() && a === 'sheetSave' && LAST_OPEN) {
    const hit = [...META].find(([p, m]) => m._appr === 'approved' && REMOTE.has(p) && String(REMOTE.get(p).id) === LAST_OPEN);
    if (hit) return block('Approved entries can be changed only by the admin.');
  }
}, true);

/* ---------- boot ---------- */
(async function boot() {
  const cfg = window.FIREBASE_CONFIG;
  if (!window.SM_CLOUD_FACTORY && (!cfg || !cfg.apiKey || /PASTE/i.test(String(cfg.apiKey)))) { gate('<h2>One step left</h2><p class="g-msg">This copy of the app is not connected to Firebase yet: paste the config in <b>firebase-config.js</b>.</p>'); return; }
  gate('<p class="g-msg">Opening…</p>');
  try { CLOUD = await (window.SM_CLOUD_FACTORY || createCloud)(cfg); }
  catch (e) { gate(`<p class="g-msg">The app could not start. The first time you open it on a phone, it needs the internet.</p><p class="tiny">${escH(e && e.message || e)}</p><button class="btn" data-x="reload">Try again</button>`); return; }
  if (window.SM_CLOUD_FACTORY) window.__sm = { get DB() { return DB; }, ME, get REMOTE() { return REMOTE; }, get META() { return META; }, pendingList }; // automated tests only
  CLOUD.onAuth(onUser);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

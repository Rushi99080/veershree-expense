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
import { createCloud, safeId } from './cloud.js?v=3.2.0';
import { pickPhoto, toJpeg, readMachinePhoto, readBillPhoto, matchMachine, matchName, testKey, aiConfig, aiForget } from './ai.js?v=1.0.0';
import { pushSupport, pushState, enablePush, localTest, genVapid, randomPass, toB64u } from './push.js?v=1.0.0';

const ENTRY_KEYS = ['machineLog', 'dieselLog', 'expenseLog', 'vendorPayments', 'murumLog', 'funds', 'ownerPayments', 'bills', 'reminders'];
const LOCAL_KEYS = ['sites', 'mfunds', 'activeId', 'lastSnap', 'lastBackup', 'theme', 'lastNotif', 'lastNotify', 'userName', 'logo', 'billLogo', 'watermark', 'wmOpacity'];
const KIND_LABEL = { machineLog: 'Machine entry', dieselLog: 'Diesel bill', expenseLog: 'Expense', vendorPayments: 'Vendor payment', murumLog: 'Murum', funds: 'Money received', ownerPayments: 'Owner payment', bills: 'Rent bill', reminders: 'Payment due date', mfund: 'Money to manager' };
const ROLE_LABEL = { admin: 'Admin', manager: 'Site Manager', accountant: 'Accountant', viewer: 'Viewer', supervisor: 'Supervisor', bot: 'Reminder robot' };
const RULES_V = 'v4';   /* the rules version this build needs (firestore.rules → sm_rules/v2) */

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
const seesAll = () => ['admin', 'accountant', 'viewer'].includes(ME.role);
const usesSites = role => role === 'manager' || role === 'supervisor';
const appBase = () => location.origin + location.pathname.replace(/[^/]*$/, '');
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
  if (ME.role === 'supervisor') { gate(`<h2>Supervisor login</h2><p class="g-msg">This login is for the <b>Supervisor app</b> — machine readings and diesel. Open it here:</p><a class="btn" style="display:block;text-align:center;text-decoration:none" href="${appBase()}supervisor/">Open the Supervisor app</a><button class="btn sec" data-x="signOut">Sign out</button>`); return; }
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
  if (isAdmin()) checkRules();
}
/* the admin is told when Firebase still has older rules than this build needs */
let RULES_OLD = false;
async function checkRules() {
  const ok = await CLOUD.rulesOk(RULES_V);
  if (ok === false && !RULES_OLD) { RULES_OLD = true; rerender(); }
  if (ok === true && RULES_OLD) { RULES_OLD = false; rerender(); }
}
async function openRulesSheet() {
  let rules = '';
  try { const r = await fetch('firestore.rules', { cache: 'no-cache' }); if (r.ok) rules = await r.text(); } catch (e) { }
  openSheet('Update the Firebase rules', `<div class="card"><div class="pad"><p class="tiny" style="line-height:1.7">This version of the app (with the <b>Manager app</b>) needs the new security rules in Firebase. Until then managers cannot remove a wrong entry from their app. Everything else keeps working.</p>
    <ol class="g-steps"><li>Tap <b>Copy the new rules</b>.</li><li>Open <b>console.firebase.google.com</b> → <b>veershree-expense</b> → <b>Firestore Database</b> → <b>Rules</b>.</li><li>Delete everything in the box, paste, tap <b>Publish</b>.</li><li>Wait one minute and tap <b>Check again</b>.</li></ol>
    ${rules ? `<button class="btn" style="width:100%" data-x="copy" data-v="${escH(rules)}">Copy the new rules</button>` : `<p class="tiny">Rules file: <a href="${RULES_URL}" target="_blank" rel="noopener">firestore.rules</a> (open, tap Raw, copy all).</p>`}
    <button class="btn sec" style="width:100%;margin-top:8px" data-x="rulesCheck">Check again</button></div></div>`, null, null);
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
  const sitesTxt = u => usesSites(u.role) ? ((u.sites || []).map(id => { const s = DB.sites.find(x => x.id === id); return s ? s.name : '?'; }).join(', ') || 'No site') : 'All sites';
  openSheet('Users', `<div id="smUsers"><div class="btnrow" style="margin-bottom:10px"><button class="btn" style="flex:1" data-x="userAdd">Add user</button></div>
    <div class="card">${list.map(u => `<div class="row"${u.role === 'bot' ? '' : ` data-x="userEdit" data-v="${escH(u.uid)}"`}><div class="main"><div class="ttl">${escH(u.name || '')} ${u.active === false ? '<span class="pill u">switched off</span>' : ''}</div><div class="sub">${escH(ROLE_LABEL[u.role] || u.role)} · ${escH(sitesTxt(u))}${u.person ? ' · cash book: ' + escH(u.person) : ''}<br>${escH(u.email || '')}</div></div></div>`).join('') || '<div class="pad tiny">Loading…</div>'}</div>
    <div class="shead">What each role can do</div><div class="card"><div class="pad tiny" style="line-height:1.7">
    <b>Admin</b> — everything: users, sites, settings, approve, delete, import, backup.<br><b>Site Manager</b> — sees and adds entries only for the sites you tick, and only their own cash book. Their entries wait for your approval; after approval they cannot change them. They can also use the separate <b>Manager app</b> to fill their expenses and money received.<br>
    <b>Accountant</b> — sees everything; marks expenses, diesel and murum as paid, records payments on rent bills, vendor and owner payments, and money received.<br><b>Viewer</b> — partners and owners: can look at everything, cannot change anything.<br><b>Supervisor</b> — uses the separate Supervisor app on site: fills machine readings, diesel filled and diesel received for the sites you tick. Sees nothing else. Entries wait for your approval.</div></div></div>`, null, null);
}
function userForm(u) {
  const r = u || { role: 'manager', sites: [], person: '', active: true };
  const self = u && u.uid === ME.uid;
  const persons = [...new Set([...(DB.managers || []).map(m => m.name), ...DB.sites.flatMap(s => s.people || [])])].filter(Boolean);
  openSheet(u ? 'Edit user' : 'Add user', `<div id="smUserForm" data-uid="${escH(u ? u.uid : '')}"><div class="card"><div class="pad">
    ${fld('Name', 'u_name', 'text', `value="${escH(r.name || '')}" placeholder="e.g. Sahil"`)}
    ${fld('Email (login ID)', 'u_email', 'email', `value="${escH(r.email || '')}" ${u ? 'readonly' : ''} autocomplete="off"`)}
    ${u ? '' : fld('Password', 'u_pass', 'text', `value="${genPass()}" autocomplete="off"`)}
    <div class="field"><label>Role</label><select name="u_role" ${self ? 'disabled' : ''}>${[['manager', 'Site Manager'], ['supervisor', 'Supervisor (machine readings app)'], ['accountant', 'Accountant'], ['viewer', 'Viewer (partner / owner)'], ['admin', 'Admin']].map(([v, l]) => `<option value="${v}"${r.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field" id="smUPerson"><label>Cash book (manager name)</label><select name="u_person"><option value="">— none —</option>${persons.map(n => `<option${norm(n) === norm(r.person) ? ' selected' : ''}>${escH(n)}</option>`).join('')}</select></div>
    <div class="field" id="smUSites"><label>Sites this person works on</label>${DB.sites.map(s => `<label class="smchk"><input type="checkbox" name="site" value="${escH(s.id)}"${(r.sites || []).includes(s.id) ? ' checked' : ''}> ${escH(s.name)}</label>`).join('')}</div>
    ${u && !self ? `<div class="field"><label>Status</label><select name="u_active"><option value="1"${r.active !== false ? ' selected' : ''}>Active</option><option value="0"${r.active === false ? ' selected' : ''}>Switched off</option></select></div>` : ''}
    <button class="btn" data-x="userSave">${u ? 'Save' : 'Create login'}</button>
    ${u ? `<button class="btn sec sm" style="margin-top:8px;width:100%" data-x="resetPass" data-v="${escH(r.email)}">Send password reset email</button>` : '<p class="tiny" style="margin-top:8px">After saving, send the email and password to the person on WhatsApp.</p>'}
    ${self ? '<p class="tiny">You cannot change your own role or switch yourself off.</p>' : ''}</div></div></div>`, null, null);
  const roleSel = document.querySelector('[name=u_role]'), sitesBox = $q('#smUSites'), personBox = $q('#smUPerson');
  const upd = () => { sitesBox.hidden = !usesSites(roleSel.value); personBox.hidden = roleSel.value === 'supervisor'; };
  roleSel.addEventListener('change', upd); upd();
}
const genPass = () => ['plot', 'site', 'gold', 'road', 'murum', 'jcb', 'waki', 'vista'][Math.floor(Math.random() * 8)] + '-' + Math.floor(1000 + Math.random() * 9000);
async function userSave() {
  const box = $q('#smUserForm'); if (!box) return;
  const q = n => box.querySelector(`[name=${n}]`);
  const id = box.dataset.uid, self = id === ME.uid;
  const name = q('u_name').value.trim(), email = q('u_email').value.trim().toLowerCase();
  const role = self ? 'admin' : q('u_role').value, person = role === 'supervisor' ? '' : q('u_person').value;
  const sites = usesSites(role) ? [...box.querySelectorAll('[name=site]:checked')].map(x => x.value) : [];
  if (!name) return say('Enter the name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('Enter a valid email');
  if (usesSites(role) && !sites.length) return say('Tick at least one site');
  if (role === 'manager' && !person) return say('Choose whose cash book this manager sees');
  const data = { name, email, role, sites, person, active: self ? true : (q('u_active') ? q('u_active').value === '1' : true) };
  try {
    let uid = id;
    if (!uid) { const pass = q('u_pass').value; if (pass.length < 6) return say('Password must be at least 6 characters'); say('Creating login…'); uid = await CLOUD.createUser(email, pass); data.createdAt = Date.now(); data.createdBy = ME.uid; await CLOUD.saveUser(uid, data); shareLogin(name, email, pass, role); return; }
    await CLOUD.saveUser(uid, data); say('User saved'); openUsers();
  } catch (e) { say(authMsg(e)); }
}
function shareLogin(name, email, pass, role) {
  const sup = role === 'supervisor', mgr = role === 'manager';
  const url = appBase() + (sup ? 'supervisor/' : mgr ? 'manager/' : '');
  const text = `*${sup ? 'Supervisor' : mgr ? 'Manager app' : 'Site Manager'} — Veershree*\nHi ${name}, here is your login.\nOpen: ${url}${mgr ? '\n(fill your expenses and money received here)' : ''}\nEmail: ${email}\nPassword: ${pass}${mgr ? '\nFull Site Manager app, same login: ' + appBase() : ''}\nOn iPhone: open the link in Safari → Share → Add to Home Screen. On Android: open in Chrome → ⋮ → Add to Home screen.`;
  openSheet('Login created', `<div class="card"><div class="pad"><p class="tiny">Send these details to <b>${escH(name)}</b>:</p><pre class="smpre">${escH(text)}</pre>
    <a class="btn" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">Send on WhatsApp</a>
    <button class="btn sec sm" style="width:100%;margin-top:8px" data-x="copy" data-v="${escH(text)}">Copy</button></div></div>`, null, null);
}

/* ---------- my account ---------- */
function openAccount() {
  const [, st, title] = pillState();
  const sitesTxt = usesSites(ME.role) ? ME.sites.map(id => { const s = DB.sites.find(x => x.id === id); return s ? s.name : '?'; }).join(', ') : 'All sites';
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
    ${isAdmin() ? line('photoAi', 'Photo reading (AI)', 'camera') : ''}
    ${isAdmin() ? line('remind', 'Supervisor reminders', 'clock') : ''}
    ${(isAdmin() || isMgr()) ? line('mgrApp', 'Manager app (expenses from phone)', 'wallet') : ''}
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
  try {
    if (TAB === 'machine' && sub('machine') === 'log' && canScan() && !$q('#smScanLog')) {
      const st = site(), f = UI.mlFilter || '';
      const m = f && f !== '__none' ? (st.machines || []).find(x => sameNo(x.no, f)) : null;
      const add = $q('#app main [data-act=mlAdd]');
      if (add) add.insertAdjacentHTML('afterend', `<div class="card mlist" id="smScanLog" style="margin-top:12px"><div class="row" data-x="scanLog" data-v="${escH(m ? m.no : '')}">${ava('', 'camera', 'c3')}<div class="main"><div class="ttl">${m ? 'Scan ' + escH(m.no) + ' log' : 'Scan log page or meter'}</div><div class="sub">${m ? escH(m.type || 'Machine') + ' · ' : ''}photo of the log book or hour meter → entries</div></div>${ic('chevR', 'chev')}</div></div>`);
    }
  } catch (e) { }
  if (RULES_OLD && isAdmin() && TAB === 'dash' && !$q('#smRulesCard')) {
    const main = $q('#app main');
    if (main) main.insertAdjacentHTML('afterbegin', `<div class="card mlist" id="smRulesCard"><div class="row" data-x="rules">${ava('', 'gear', 'c2')}<div class="main"><div class="ttl">Update the Firebase rules</div><div class="sub">Needed for the Supervisor app · tap to see how</div></div>${ic('chevR', 'chev')}</div></div>`);
  }
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
try { if (!ICON.camera) ICON.camera = SVG('<path d="M4 8.5h3.2L9 6h6l1.8 2.5H20V19H4z"/><circle cx="12" cy="13.2" r="3.4"/>'); } catch (e) { }

/* ================= photo reading (meter, log page, bills) ================= */
const canScan = () => isAdmin() || isMgr();
const SCAN_FORMS = { 'New machine entry': 'machine', 'Edit machine entry': 'machine', 'New diesel entry': 'diesel', 'Edit diesel entry': 'diesel', 'New expense': 'expense', 'Edit expense': 'expense' };
let SCAN = null;   // the last photo read for the review sheet
try {
  const orig = window.openSheet;
  if (typeof orig === 'function') window.openSheet = function (title) {
    const r = orig.apply(this, arguments);
    try { const k = SCAN_FORMS[String(title)]; if (k && canScan()) injectScan(k); } catch (e) { }
    return r;
  };
} catch (e) { }
function injectScan(kind) {
  const b = $q('#modal .sbd'); if (!b || b.querySelector('.smscan')) return;
  b.insertAdjacentHTML('afterbegin', `<div class="smscan"><button class="btn sec" data-x="scanForm" data-v="${kind}">${ICON.camera}${kind === 'machine' ? 'Read meter or log photo' : 'Read bill photo'}</button><div class="tiny">Fills the boxes below from a photo. Check them, then Save.</div><div id="smRead"></div></div>`);
}
function busy(on, msg) {
  let el = document.getElementById('smBusy');
  if (!on) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'smBusy'; document.body.appendChild(el); }
  el.innerHTML = `<div><i></i>${escH(msg || 'Reading the photo…')}</div>`;
}
function scanError(e) {
  if (e && e.message === 'NO_KEY') {
    if (isAdmin()) { closeSheet(); openPhotoAi('Photo reading is not switched on yet. It takes two minutes:'); }
    else say('Photo reading is not switched on yet. Ask the admin (Menu → Photo reading).');
    return;
  }
  say((e && e.message) || 'Photo reading failed.');
}
const setV = (id, v) => { const el = document.getElementById(id); if (!el || v === '' || v == null) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
const fmtN = v => (v === '' || v == null) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
function lastOutOf(s, no, beforeDate) {
  const l = (s.machineLog || []).filter(r => sameNo(r.machineNo, no) && has(r.outR) && (!beforeDate || r.date <= beforeDate));
  let best = null; for (const r of l) if (!best || r.date > best.date || (r.date === best.date && num(r.outR) > num(best.outR))) best = r;
  return best ? { outR: best.outR, date: best.date } : null;
}
function machineCtx(s, no, date) {
  const m = no ? (s.machines || []).find(x => sameNo(x.no, no)) : null, l = no ? lastOutOf(s, no, date) : null;
  return { site: s.name, today: today(), machineNo: m ? m.no : '', machineType: m ? m.type : '', lastOut: l ? l.outR : '', lastDate: l ? l.date : '', machines: activeMachines(s) };
}
function readNote(html) { const n = document.getElementById('smRead'); if (n) n.innerHTML = `<div class="smread">${html}</div>`; }
function fillMachineForm(s, r) {
  const no = val('f_no'), ctx = machineCtx(s, no, val('f_date'));
  if (r.kind === 'meter' && r.meterReading !== '') {
    const rd = r.meterReading, inV = val('f_in');
    let msg = '';
    if (inV === '' && ctx.lastOut !== '' && rd >= num(ctx.lastOut)) { setV('f_in', ctx.lastOut); setV('f_out', rd); msg = `Meter <b>${fmtN(rd)}</b> → Out. In = last out reading ${fmtN(ctx.lastOut)} (${fmtDate(ctx.lastDate)}).`; }
    else if (inV === '') { setV('f_in', rd); msg = `Meter <b>${fmtN(rd)}</b> → In reading.`; }
    else { setV('f_out', rd); msg = `Meter <b>${fmtN(rd)}</b> → Out.` + (rd < num(inV) ? ' <b>It is lower than the In reading — check.</b>' : ''); }
    readNote(msg + (r.note ? '<br>' + escH(r.note) : ''));
    return;
  }
  const row = r.rows.find(x => x.date === val('f_date')) || r.rows[0];
  if (!row) { readNote('No reading found in this photo.' + (r.note ? ' ' + escH(r.note) : '')); return; }
  const m = row.machineNo ? matchMachine(s.machines || [], row.machineNo) : '';
  if (row.date && row.date <= today()) setV('f_date', row.date);
  if (m && activeMachines(s).some(x => x.no === m)) setV('f_no', m);
  setV('f_in', row.inR); setV('f_out', row.outR); setV('f_dsl', row.diesel); if (row.remark && !val('f_rem')) setV('f_rem', row.remark);
  readNote(`Read: ${row.date ? fmtDate(row.date) + ' · ' : ''}${row.machineNo ? escH(row.machineNo) + (m ? '' : ' (not in the machine list)') + ' · ' : ''}In ${fmtN(row.inR)} · Out ${fmtN(row.outR)}${row.diesel !== '' ? ' · ' + fmtN(row.diesel) + ' L' : ''}${r.note ? '<br>' + escH(r.note) : ''}`);
}
function fillBillForm(s, kind, r) {
  const parts = [];
  if (r.date && r.date <= today()) { setV('f_date', r.date); parts.push(fmtDate(r.date)); }
  if (kind === 'diesel') {
    const v = matchName(s.dieselVendors, r.vendor);
    if (v) setV('f_v', v); else if (r.vendor && !val('f_rem')) setV('f_rem', 'Vendor on bill: ' + r.vendor);
    setV('f_l', r.litres); setV('f_amt', r.amount); if (r.billNo) setV('f_bill', r.billNo);
    parts.push((v || r.vendor || 'vendor not read') + (r.vendor && !v ? ' (not in your diesel vendor list — pick it)' : ''), fmtN(r.litres) + ' L', '₹' + fmtN(r.amount), r.billNo ? 'bill ' + r.billNo : '');
  } else {
    const c = matchName(s.categories, r.category), v = matchName(s.vendors, r.vendor);
    if (c) setV('f_cat', c);
    if (!val('f_desc')) setV('f_desc', [r.items, r.vendor && !v ? r.vendor : ''].filter(Boolean).join(' — '));
    setV('f_amt', r.amount); if (v) setV('f_v', v);
    if (r.billNo && !val('f_rem')) setV('f_rem', 'Bill ' + r.billNo);
    parts.push(r.vendor || 'vendor not read', '₹' + fmtN(r.amount), c ? 'category ' + c : 'pick the category');
  }
  readNote('Read: ' + parts.filter(Boolean).map(escH).join(' · ') + (r.note ? '<br>' + escH(r.note) : ''));
}
async function scanForm(kind) {
  const file = await pickPhoto(); if (!file) return;
  const s = site(); busy(true);
  try {
    const img = await toJpeg(file);
    if (kind === 'machine') {
      const no = val('f_no'), ctx = machineCtx(s, no, val('f_date'));
      const r = await readMachinePhoto(CLOUD, img.b64, ctx);
      if (r.kind === 'log' && r.rows.length > 1) { closeSheet(); SCAN = { s, r, img, no }; openScanReview(); return; }
      fillMachineForm(s, r);
    } else {
      const r = await readBillPhoto(CLOUD, img.b64, { kind, vendors: kind === 'diesel' ? s.dieselVendors : s.vendors, categories: kind === 'expense' ? s.categories : [] });
      fillBillForm(s, kind, r);
    }
  } catch (e) { scanError(e); } finally { busy(false); }
}
async function scanLog(no, strong) {
  LAST_OPEN = '';
  const s = site();
  let img = SCAN && strong ? SCAN.img : null;
  if (!img) { const file = await pickPhoto(); if (!file) return; busy(true); try { img = await toJpeg(file); } catch (e) { busy(false); return say(e.message); } }
  busy(true, strong ? 'Reading again, more carefully…' : 'Reading the photo…');
  try {
    const r = await readMachinePhoto(CLOUD, img.b64, machineCtx(s, no, today()), strong);
    if (r.kind === 'meter' && r.meterReading !== '' && !r.rows.length) {
      closeSheet(); machineForm(s, null); if (no) setV('f_no', no); fillMachineForm(s, r); return;
    }
    if (!r.rows.length) { say('No readings found in this photo.' + (r.note ? ' ' + r.note : '')); return; }
    SCAN = { s, r, img, no }; openScanReview();
  } catch (e) { scanError(e); } finally { busy(false); }
}
function openScanReview() {
  const { s, r, img, no } = SCAN;
  const all = s.machines || [];
  const rows = r.rows.map(x => ({ ...x, m: (x.machineNo ? matchMachine(all, x.machineNo) : '') || (x.machineNo ? '' : no || '') }))
    .sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  const opts = cur => `<option value="">— pick —</option>` + all.map(m => `<option${m.no === cur ? ' selected' : ''}>${escH(m.no)}</option>`).join('');
  const start = x => scanMatch(s, { date: x.date, no: x.m, inR: x.inR, outR: x.outR, diesel: x.diesel, remark: x.remark }).mode;
  SCAN.rows = rows;
  openSheet('Check the rows from the photo', `
    <div class="card"><div class="pad">
      <img class="smscanimg" src="${img.preview}" alt="The photo" data-x="scanZoom">
      <div class="tiny" style="margin-top:8px;line-height:1.6">Read <b>${rows.length}</b> row${rows.length === 1 ? '' : 's'}${no ? ' for <b>' + escH(no) + '</b>' : ''}. Check each row against the photo, fix anything wrong, then add. Rows already in the log are left unticked.</div>
      ${r.note ? `<div class="smread">${escH(r.note)}</div>` : ''}
    </div></div>
    <div id="smRows">${rows.map((x, i) => { const on = ['add', 'fill'].includes(start(x)); return `
      <div class="card smrow${on ? '' : ' off'}" data-i="${i}"><div class="pad">
        <label class="smchk"><input type="checkbox" name="use" ${on ? 'checked' : ''}><b class="smact">Add this row</b></label>
        <div class="f2"><div class="field"><label>Date</label><input type="date" name="date" value="${escH(x.date)}" max="${today()}"></div>
          <div class="field"><label>Machine</label><select name="no">${opts(x.m)}</select></div></div>
        <div class="f3"><div class="field"><label>In</label><input name="in" type="number" inputmode="decimal" step="any" value="${x.inR}"></div>
          <div class="field"><label>Out</label><input name="out" type="number" inputmode="decimal" step="any" value="${x.outR}"></div>
          <div class="field"><label>Diesel (L)</label><input name="dsl" type="number" inputmode="decimal" step="any" value="${x.diesel}"></div></div>
        <div class="field" style="margin-bottom:0"><label>Remark</label><input name="rem" value="${escH(x.remark)}"></div>
        <div class="smflags"></div>
      </div></div>`; }).join('')}</div>
    <button class="btn" style="width:100%" data-x="scanAdd">Add ticked rows</button>
    <button class="btn sec" style="width:100%;margin-top:8px" data-x="scanAgain">Read again more carefully</button>
    <div class="tiny" style="margin-top:8px">Read by ${escH(r.model || 'AI')}. Always compare with the photo — handwriting can be misread.</div>`, null, null);
  const box = document.getElementById('smRows');
  box.addEventListener('input', () => scanFlags());
  box.addEventListener('change', () => scanFlags());
  scanFlags();
}
function scanRowVals(el) {
  const q = n => el.querySelector(`[name=${n}]`);
  const nv = n => { const v = q(n).value.trim(); return v === '' ? '' : num(v); };
  return { use: q('use').checked, date: q('date').value, no: q('no').value, inR: nv('in'), outR: nv('out'), diesel: nv('dsl'), remark: q('rem').value.trim() };
}
/* is this row already in the log? add it, fill the blanks of the saved entry, replace its numbers, or nothing new */
const SCAN_F = ['inR', 'outR', 'diesel'];
function scanMatch(s, v) {
  if (!v.no || !v.date) return { mode: 'add' };
  const ex = (s.machineLog || []).filter(e => sameNo(e.machineNo, v.no) && e.date === v.date);
  if (!ex.length) return { mode: 'add' };
  const look = e => { let conflict = false, adds = false; for (const k of SCAN_F) { if (has(e[k]) && v[k] !== '' && num(e[k]) !== num(v[k])) conflict = true; if (!has(e[k]) && v[k] !== '') adds = true; } if (!has(e.remark) && v.remark) adds = true; return conflict ? 'replace' : adds ? 'fill' : 'same'; };
  if (ex.length > 1) { const same = ex.find(e => look(e) === 'same'); return same ? { mode: 'same', e: same } : { mode: 'add', many: ex.length }; }
  return { mode: look(ex[0]), e: ex[0] };
}
const SCAN_LABEL = { add: 'Add this row', fill: 'Fill the blanks in the saved entry', replace: "Replace the saved entry's numbers", same: 'Already in the log — nothing new' };
function scanFlags() {
  const s = SCAN && SCAN.s; if (!s) return 0;
  const els = [...document.querySelectorAll('#smRows .smrow')];
  const prevOut = {};   // within this photo, row by row
  let bad = 0, n = 0;
  els.map(el => [el, scanRowVals(el)]).sort((a, b) => (a[1].date || '').localeCompare(b[1].date || '')).forEach(([el, v]) => {
    el.classList.toggle('off', !v.use);
    const f = [];
    const daily = v.no && rateInfo(s, v.no).basis === 'Daily';
    if (!v.no) f.push(['bad', 'Pick the machine']);
    if (!v.date) f.push(['bad', 'Date needed']); else if (v.date > today()) f.push(['bad', 'Date is in the future']);
    if ((v.inR === '') !== (v.outR === '') && !daily) f.push(['bad', v.inR === '' ? 'In reading missing' : 'Out reading missing']);
    if (v.inR !== '' && v.outR !== '') {
      const h = v.outR - v.inR;
      if (h < 0) f.push(['bad', 'Out is lower than In']); else f.push([h > 24 ? 'amb' : 'ok', `${dec(h, 2)} hrs${h > 24 ? ' — more than 24, check' : ''}`]);
    }
    if (v.no && v.inR !== '') {
      const k = machineKeyLocal(v.no), lo = prevOut[k] != null ? { outR: prevOut[k] } : lastOutOf(s, v.no, v.date ? prevDay(v.date) : '');
      if (lo && Math.abs(num(lo.outR) - v.inR) > 0.05) f.push(['amb', `In is not the last out reading (${fmtN(lo.outR)})`]);
    }
    if (v.no && v.outR !== '') prevOut[machineKeyLocal(v.no)] = v.outR;
    const mt = scanMatch(s, v);
    el.querySelector('.smact').textContent = SCAN_LABEL[mt.mode];
    if (mt.e) f.push([mt.mode === 'replace' ? 'amb' : 'ok', `Saved: In ${fmtN(has(mt.e.inR) ? mt.e.inR : '')} · Out ${fmtN(has(mt.e.outR) ? mt.e.outR : '')}${has(mt.e.diesel) ? ' · ' + fmtN(mt.e.diesel) + ' L' : ''}`]);
    if (mt.many) f.push(['amb', `${mt.many} entries already on this day`]);
    el.querySelector('.smflags').innerHTML = f.map(([c, t]) => `<span class="${c}">${escH(t)}</span>`).join(' · ');
    if (v.use) { n++; if (f.some(x => x[0] === 'bad')) bad++; }
  });
  const b = document.querySelector('[data-x=scanAdd]'); if (b) b.textContent = n ? `Add ${n} ticked row${n === 1 ? '' : 's'}` : 'Tick the rows to add';
  return bad;
}
const machineKeyLocal = no => String(no).toLowerCase().replace(/[^a-z0-9]/g, '');
const prevDay = d => { const [y, m, x] = d.split('-').map(Number); const t = new Date(y, m - 1, x - 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
function scanAdd() {
  const s = SCAN && SCAN.s; if (!s) return;
  const bad = scanFlags();
  const rows = [...document.querySelectorAll('#smRows .smrow')].map(scanRowVals).filter(v => v.use);
  if (!rows.length) return say('Tick at least one row');
  if (bad) { const el = [...document.querySelectorAll('#smRows .smrow')].find(e => e.querySelector('.smflags .bad') && e.querySelector('[name=use]').checked); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return say('Fix the rows marked in red, or untick them'); }
  const target = DB.sites.find(x => x.id === s.id) || s;
  let added = 0, filled = 0, replaced = 0, same = 0;
  for (const v of rows) {
    const mt = scanMatch(target, v);
    if (mt.mode === 'add') { target.machineLog.push({ id: uid(), date: v.date, machineNo: v.no, inR: v.inR, outR: v.outR, diesel: v.diesel, openDiesel: '', remark: v.remark, xl: false }); added++; }
    else if (mt.mode === 'fill') { for (const k of SCAN_F) if (!has(mt.e[k]) && v[k] !== '') mt.e[k] = v[k]; if (!has(mt.e.remark) && v.remark) mt.e.remark = v.remark; filled++; }
    else if (mt.mode === 'replace') { for (const k of SCAN_F) if (v[k] !== '') mt.e[k] = v[k]; if (v.remark) mt.e.remark = v.remark; replaced++; }
    else same++;
  }
  closeSheet(); SCAN = null; save(); render();
  const parts = [added && `${added} added`, filled && `${filled} filled in`, replaced && `${replaced} replaced`, same && `${same} already there`].filter(Boolean);
  say((parts.join(', ') || 'Nothing to change') + ((added || filled || replaced) && isMgr() ? ' — waiting for approval' : ''));
}

/* ================= supervisor reminders ================= */
let REM = null;
const ghSecretUrl = () => { const owner = location.hostname.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0] || ''; return `https://github.com/${owner}/${repo}/settings/secrets/actions`; };
const whenTxt = ms => { if (!ms) return ''; const d = new Date(ms), mins = Math.round((Date.now() - ms) / 60000); return mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
async function openRemind() {
  let last = null;
  try { REM = await CLOUD.getDocServer('sm_meta/remind') || {}; } catch (e) { REM = REM || {}; }
  try { last = await CLOUD.getDocServer('sm_botlog/last'); } catch (e) { }
  const R = REM, robot = !!R.vapidPublic;
  const sup = pushSupport(), ps = await pushState();
  const fresh = last && Date.now() - last.at < 40 * 60000 && last.ok !== false;
  const phone = sup === 'ios-home' ? '<p class="tiny">On iPhone, notifications work only in the app opened from the <b>Home Screen</b>: Safari → Share → <b>Add to Home Screen</b>, then open it from there and come back here.</p>'
    : sup === 'no' ? '<p class="tiny">This browser cannot show notifications.</p>'
    : ps === 'on' ? '<div class="smok">Notifications are on for this phone.</div><button class="btn sec" style="width:100%;margin-top:8px" data-x="remTest">Send a test</button>'
    : ps === 'blocked' ? '<p class="tiny">Notifications are <b>blocked</b> for this app. Allow them in the phone settings, then tap the button.</p><button class="btn" style="width:100%" data-x="remPush">Turn on notifications on this phone</button>'
    : `<button class="btn" style="width:100%" data-x="remPush"${robot ? '' : ' disabled'}>Turn on notifications on this phone</button>${robot ? '' : '<p class="tiny">Set up the robot first.</p>'}`;
  openSheet('Supervisor reminders', `<div class="card"><div class="pad">
      <p class="tiny" style="margin:0 0 12px;line-height:1.6">If a supervisor has not filled today's machine readings by the reminder time, his phone gets a notification <b>every 10 minutes</b> until he fills every working machine or taps <b>Done for today</b>. You get one notification for that day.</p>
      ${segField('Reminders', 'rm_on', ['On', 'Off'], R.on === false ? 'Off' : 'On')}
      <div class="f2"><div class="field"><label>Remind from</label><input type="time" id="rm_t" value="${escH(R.time || '19:00')}"></div>
        <div class="field"><label>Stop at</label><input type="time" id="rm_u" value="${escH(R.until || '22:00')}"></div></div>
      <label class="smchk"><input type="checkbox" id="rm_a"${R.notifyAdmin === false ? '' : ' checked'}> Tell me when a supervisor has not filled</label>
      <button class="btn" style="width:100%;margin-top:6px" data-x="remSave">Save</button>
    </div></div>
    <div class="card"><h3>Reminder robot<small>${robot ? 'set up' : 'one-time setup'}</small></h3><div class="pad">
      ${robot ? `<div class="${fresh ? 'smok' : 'smread'}">${last ? `Last check ${escH(whenTxt(last.at))}: ${escH(last.note || '')}${last.sent ? ' &middot; ' + last.sent + ' sent' : ''}` : 'No check yet. Put the key on GitHub, then wait up to 10 minutes.'}</div>`
        : '<p class="tiny" style="line-height:1.6">A free GitHub schedule checks every 10 minutes and sends the notifications. It is set up once: the app makes a key, you paste it on GitHub.</p>'}
      <button class="btn${robot ? ' sec' : ''}" style="width:100%;margin-top:8px" data-x="remBot">${robot ? 'Make a new robot key' : 'Set up the reminder robot'}</button>
      <p class="tiny" style="margin-top:8px">GitHub may run a few minutes late now and then.</p>
    </div></div>
    <div class="card"><h3>Notifications on this phone</h3><div class="pad">${phone}</div></div>`, null, null);
}
async function remSave() {
  const t = val('rm_t') || '19:00', u = val('rm_u') || '22:00';
  if (u <= t) return say('"Stop at" must be after "Remind from"');
  REM = { ...(REM || {}), on: segVal('rm_on') !== 'Off', time: t, until: u, notifyAdmin: document.getElementById('rm_a').checked, every: 10 };
  try { await CLOUD.commit([{ type: 'set', path: 'sm_meta/remind', data: REM }]); say(REM.on ? `Reminders on: from ${t} to ${u}, every 10 minutes` : 'Reminders are off'); closeSheet(); }
  catch (e) { say('Could not save: ' + ((e && e.code) || e.message)); }
}
async function remBot() {
  if (REM && REM.vapidPublic && !confirm('Make a new robot key? You will need to replace REMINDER_SECRET on GitHub with the new key.')) return;
  busy(true, 'Setting up the robot…');
  try {
    const keys = await genVapid(), pass = randomPass(28);
    const email = 'reminder.robot.' + Math.random().toString(36).slice(2, 8) + '@veershree-expense.firebaseapp.com';
    const uid = await CLOUD.createUser(email, pass);
    await CLOUD.saveUser(uid, { name: 'Reminder robot', email, role: 'bot', active: true, sites: [], createdAt: Date.now(), createdBy: ME.uid });
    if (REM && REM.botUid && REM.botUid !== uid) { try { await CLOUD.saveUser(REM.botUid, { active: false }); } catch (e) { } }
    REM = { ...(REM || {}), on: !(REM && REM.on === false), time: (REM && REM.time) || '19:00', until: (REM && REM.until) || '22:00',
      notifyAdmin: !(REM && REM.notifyAdmin === false), every: 10, vapidPublic: keys.pub, botUid: uid, botEmail: email, keyAt: Date.now() };
    await CLOUD.commit([{ type: 'set', path: 'sm_meta/remind', data: REM }]);
    const cfg = window.FIREBASE_CONFIG || {};
    const secret = toB64u(JSON.stringify({ v: 1, project: cfg.projectId, apiKey: cfg.apiKey, email, password: pass, vapidPublic: keys.pub, vapidPrivate: keys.priv, subject: appBase() }));
    busy(false); closeSheet();
    openSheet('Last step: the key on GitHub', `<div class="card"><div class="pad" style="line-height:1.6">
      <ol class="g-steps" style="color:var(--ink-2);font-size:14.5px;padding-left:20px;margin:0 0 12px">
        <li>Tap <b>Copy the key</b>.</li>
        <li>Tap <b>Open GitHub</b> (sign in if asked), then <b>New repository secret</b>.<br><span class="tiny">Already there from before? Tap <b>REMINDER_SECRET</b> → pencil → paste → <b>Update secret</b>.</span></li>
        <li>Name: <b>REMINDER_SECRET</b>. Paste the key in <b>Secret</b>. Tap <b>Add secret</b>.</li>
        <li>Come back here and turn on notifications on this phone. Within about 10 minutes <b>Last check</b> shows in Supervisor reminders.</li></ol>
      <button class="btn" style="width:100%" data-x="copy" data-v="${escH(secret)}">Copy the key</button>
      <a class="btn sec" style="width:100%;margin-top:8px;display:block;text-align:center;text-decoration:none" href="${ghSecretUrl()}" target="_blank" rel="noopener">Open GitHub</a>
      <button class="btn sec" style="width:100%;margin-top:8px" data-x="copy" data-v="REMINDER_SECRET">Copy the name REMINDER_SECRET</button>
      <p class="tiny" style="margin-top:10px">The key is shown only now and is not kept in the app. If it is lost, make a new key.</p>
      <button class="btn sec" style="width:100%;margin-top:4px" data-x="remind">Back to reminders</button></div></div>`, null, null);
  } catch (e) { busy(false); say('Could not set up the robot: ' + ((e && (e.code || e.message)) || 'error')); }
}
async function remPush() {
  try {
    if (!REM || !REM.vapidPublic) REM = await CLOUD.getDocServer('sm_meta/remind') || {};
    await enablePush(CLOUD, ME, REM.vapidPublic, 'site-manager');
    say('Notifications are on for this phone'); closeSheet(); openRemind();
  } catch (e) { say((e && (e.code === 'permission-denied' ? 'Update the Firebase rules first (see the card on Home).' : e.message)) || 'Could not turn on'); }
}
async function remTest() {
  try { await localTest('Site Manager', 'Notifications show on this phone.'); } catch (e) { }
  try { await CLOUD.commit([{ type: 'set', path: 'sm_botlog/test', data: { uid: ME.uid, at: Date.now() } }]); say('Shown here now. The robot sends one more within about 10 minutes.'); }
  catch (e) { say('Could not ask the robot: ' + ((e && e.code) || e.message)); }
}

/* the admin switches photo reading on with a free Google key */
async function openPhotoAi(lead) {
  let cfg = null; try { cfg = await aiConfig(CLOUD, true); } catch (e) { }
  openSheet('Photo reading (AI)', `<div class="card"><div class="pad" style="line-height:1.6">
    ${lead ? `<p style="margin:0 0 10px"><b>${escH(lead)}</b></p>` : ''}
    <div class="${cfg ? 'smok' : 'smread'}" style="background:${cfg ? '' : 'rgba(201,138,27,.14)'}">${cfg ? 'Photo reading is <b>on</b> for everyone with a login.' : 'Photo reading is <b>off</b>.'}</div>
    <p class="tiny">A photo of an hour meter, a log-book page or a bill is read by Google's Gemini model and the numbers are filled in for you to check. It uses a free Google key (no card):</p>
    <ol class="g-steps" style="color:var(--steel);font-size:14px"><li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with your Google account.</li><li>Tap <b>Create API key</b>, then copy the key.</li><li>Paste it here and tap <b>Save and test</b>.</li></ol>
    <div class="field"><label>Gemini API key</label><input id="smAiKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${cfg ? 'saved — paste a new one to replace it' : 'AIza…'}"></div>
    <button class="btn" style="width:100%" data-x="aiSave">Save and test</button>
    ${cfg ? '<button class="btn dgr sm" style="width:100%;margin-top:8px" data-x="aiOff">Switch photo reading off</button>' : ''}
    <p class="tiny" style="margin-top:12px">Free tier: a few hundred photos a day. On Google's free tier, Google may keep and review the photos to improve its products, so don't photograph anything private. Photos are not stored in this app.</p>
  </div></div>`, null, null);
}
async function aiSave() {
  const key = val('smAiKey'); if (!key) return say('Paste the key first');
  busy(true, 'Testing the key…');
  try {
    const model = await testKey(key);
    await CLOUD.commit([{ type: 'set', path: 'sm_meta/ai', data: { key, models: [model], at: Date.now(), byName: ME.name } }]);
    aiForget(); closeSheet(); say('Photo reading is on');
  } catch (e) { say(e.message || 'The key did not work'); } finally { busy(false); }
}
async function aiOff() {
  if (!confirm('Switch photo reading off for everyone?')) return;
  try { await CLOUD.commit([{ type: 'set', path: 'sm_meta/ai', data: { key: '', models: [], at: Date.now(), byName: ME.name } }]); aiForget(); closeSheet(); say('Photo reading is off'); } catch (e) { say('Could not save: ' + (e.code || e.message)); }
}
window.SM_SYNC = { push, afterRender, menuHtml, sideHtml, scopeManagers, can, me: () => ME };

/* ---------- clicks: this layer's buttons, and role guards on the app's own buttons ---------- */
let LAST_OPEN = '';
document.addEventListener('click', async e => {
  const x = e.target.closest('[data-x]');
  if (x) {
    e.preventDefault(); e.stopPropagation();
    const a = x.dataset.x, v = x.dataset.v;
    if (x.closest('.sheet') && ['approvals', 'users', 'account', 'photoAi', 'remind'].includes(a)) closeSheet();
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
      case 'rules': openRulesSheet(); break;
      case 'rulesCheck': { const ok = await CLOUD.rulesOk(RULES_V); if (ok) { RULES_OLD = false; closeSheet(); say('The new rules are published'); rerender(); } else say(ok === false ? 'Still the old rules. Publish, wait a minute, then check again.' : 'No internet — try again.'); break; }
      case 'photoAi': openPhotoAi(''); break;
      case 'remind': openRemind(); break;
      case 'mgrApp': closeSheet(); window.open(appBase() + 'manager/', '_blank'); break;
      case 'remSave': remSave(); break;
      case 'remBot': remBot(); break;
      case 'remPush': remPush(); break;
      case 'remTest': remTest(); break;
      case 'aiSave': aiSave(); break;
      case 'aiOff': aiOff(); break;
      case 'scanForm': scanForm(v); break;
      case 'scanLog': scanLog(v); break;
      case 'scanAgain': if (SCAN) scanLog(SCAN.no, true); break;
      case 'scanAdd': scanAdd(); break;
      case 'scanZoom': x.classList.toggle('big'); break;
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

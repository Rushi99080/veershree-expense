/* =========================================================
   Veershree Plot Expense Manager — advanced version (Phase 1)
   Multi-user with Firebase: login, roles, offline-first sync.
   All calculations from the first version are kept unchanged.
   ========================================================= */
import { createCloud, safeId, docIdFor } from './cloud.js';
import { OldCalc } from './oldcalc.js';

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/rs\.?|₹|,|\s/gi, ''));
  return isFinite(n) ? n : 0;
};
const has = v => v !== '' && v != null;
const nv = v => (v === '' || v == null) ? '' : num(v);
const rnd = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inr = v => { const n = Math.round(num(v)); return (n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN'); };
const inrC = v => {
  const n = num(v), a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return s + '₹' + Math.round(a);
};
const qty = (v, d = 1) => rnd(v, d).toLocaleString('en-IN', { maximumFractionDigits: d });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const fmtD = d => { if (!isDate(d)) return '—'; const [y, m, dd] = d.split('-'); return `${+dd} ${MON[+m - 1]} ${y}`; };
const fmtDs = d => { if (!isDate(d)) return '—'; const [y, m, dd] = d.split('-'); return `${+dd} ${MON[+m - 1]} ${y.slice(2)}`; };
const monthLabel = k => { const [y, m] = k.split('-'); return MON[+m - 1] + ' ' + y.slice(2); };
const isoLocal = t => t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
const today = () => isoLocal(new Date());
const addDays = (d, n) => { const t = new Date((isDate(d) ? d : today()) + 'T12:00:00'); t.setDate(t.getDate() + n); return isoLocal(t); };
/* "PC - 01", "pc-1", "PC-01" all point to one machine */
const mkey = no => String(no || '').toUpperCase().replace(/\s+/g, '').replace(/-0*(\d)/, '-$1');
const natCmp = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id));
const sum = (arr, f) => arr.reduce((a, x) => a + num(f(x)), 0);
const KEEP_CAPS = { jcb: 'JCB', xcmg: 'XCMG', cat: 'CAT', hp: 'HP', bd: 'BD' };
const title = s => String(s || '').toLowerCase().replace(/\b[a-z][a-z0-9]*/g, w => KEEP_CAPS[w] ? KEEP_CAPS[w] : w[0].toUpperCase() + w.slice(1)).replace(/\bSuny\b/, 'Sany').trim();
const canPrint = () => true;

/* ---------- constants & starter masters ---------- */
const UI_KEY = 'vpem-ui-v1';
const COLLS = ['exp', 'mlog', 'dsl', 'vpay', 'opay', 'bill', 'fund'];
const MODES = ['Cash', 'UPI', 'Online', 'RTGS', 'NEFT', 'Cheque'];
const ATTACH = ['Bucket', 'Breaker', 'None'];
const DEFAULT_TYPES = [
  { type: 'Poclain', basis: 'Hourly', units: 240 }, { type: 'JCB', basis: 'Hourly', units: 240 },
  { type: 'Hiwa', basis: 'Daily', units: 30 }, { type: 'Tractor', basis: 'Hourly', units: 240 },
  { type: 'Bulldozer', basis: 'Hourly', units: 240 }, { type: 'Roller', basis: 'Hourly', units: 240 },
  { type: 'Generator', basis: 'Daily', units: 30 }, { type: 'Dumper', basis: 'Daily', units: 30 }
];
const TYPE_ORDER = t => { const i = DB.settings.types.findIndex(x => x.type === t); return i < 0 ? 99 : i; };

function blankDB() {
  return {
    v: 1, _t: 0,
    settings: { company: 'Veershree Realty', commParty: 'Mangalmurti Developers', commPct: 20, billPrefix: 'RB-', billNext: 1,
      types: DEFAULT_TYPES.map(x => ({ ...x })), modes: MODES.slice() },
    sites: [], people: [], cats: [], machines: [],
    exp: [], mlog: [], dsl: [], vpay: [], opay: [], bill: [], fund: []
  };
}
function starterDB() {
  const d = blankDB();
  const S = (id, name, place, kind) => ({ id, name, place: place || '', kind: kind || 'Plot development', status: 'Active', dieselOpening: '', note: '' });
  d.sites = [
    S('s-waki', 'Veershree Industrial Park', 'Waki'), S('s-vista', 'Veershree Vista Residency'), S('s-elite', 'Veershree Elite Residency'),
    S('s-arista', 'Veershree Arista', 'Dehu Phata'), S('s-crest', 'Veershree Crest', 'New Site Moi'), S('s-enclave', 'Veershree Enclave', 'Rase'),
    S('s-container', 'New Container Office', '', 'Construction'), S('s-jadhav', 'Jadhav Sir Site', '', 'Construction'),
    S('s-aaru', 'Tushar Aaru Sir Site', '', 'Interior'), S('s-yewale', 'Yewale Sir Site', '', 'Construction'),
    S('s-gopale', 'Rahul Gopale Sir Site', '', 'Construction')
  ];
  d.people = [['p-rushi', 'Rushi', true], ['p-sahil', 'Sahil', true], ['p-suhas', 'Suhas Sir', false], ['p-raju', 'Raju Kaka', false],
    ['p-aryan', 'Aryan Sir', false], ['p-aniket', 'Aniket Sir', false]].map(([id, name, cash]) => ({ id, name, cash }));
  d.cats = [['c-jcb', 'JCB / Excavation', 'Hours'], ['c-murum', 'Murum / Filling', 'Brass'], ['c-road', 'Internal Road', ''],
    ['c-wall', 'Wall Compound', ''], ['c-water', 'Water / Borewell / Drainage', ''], ['c-elec', 'Electrical', ''],
    ['c-labour', 'Labour / Watchman / Security', ''], ['c-bhatta', 'Driver Bhatta', 'Days'], ['c-material', 'Material Purchase', ''],
    ['c-entrance', 'Entrance Work', ''], ['c-office', 'Office', ''], ['c-shift', 'Office Shifting', ''],
    ['c-mkt', 'Marketing / Broker', ''], ['c-rent', 'Machine Rent (direct)', ''], ['c-other', 'Other / Miscellaneous', '']]
    .map(([id, name, unit]) => ({ id, name, unit }));
  const W = [
    ['PC-01', 'Poclain', 'Tata Hitachi', 'Ganesh Daundkar'], ['PC-02', 'Poclain', 'XCMG', 'Subhash Hole'], ['PC-03', 'Poclain', 'Tata Hitachi', 'Rahul Dawre'],
    ['PC-04', 'Poclain', 'JCB', 'Rohidas Pawale'], ['PC-05', 'Poclain', 'Sany', 'Rahul Dawre'], ['PC-06', 'Poclain', 'XCMG', 'Praveen Sandbhor'],
    ['PC-07', 'Poclain', 'Hyundai', 'Vinod Poul'], ['PC-08', 'Poclain', 'Tata Hitachi', 'Ganesh Pawale'], ['PC-09', 'Poclain', 'JCB', 'Niteen Khalate'],
    ['PC-10', 'Poclain', 'Sany', 'Ram Dhobale'], ['PC-11', 'Poclain', 'Hyundai', 'Pranav Shinde'], ['PC-12', 'Poclain', 'JCB', 'Omkar'],
    ['PC-13', 'Poclain', 'Sany', 'Vishal Bhambore'], ['PC-14', 'Poclain', 'JCB', 'Aniket Satpute'], ['PC-15', 'Poclain', 'JCB', 'Rohidas Pawale'],
    ['PC-16', 'Poclain', 'Hyundai', 'Mahesh Aavti'], ['PC-17', 'Poclain', 'JCB', 'Omkar'], ['PC-18', 'Poclain', 'Sany', 'Khaire'],
    ['PC-19', 'Poclain', 'Sany', 'Praveen Shinde'], ['PC-20', 'Poclain', 'JCB', 'Bhosale'], ['PC-21', 'Poclain', 'Tata Hitachi', 'Machindra Borhade'],
    ['PC-22', 'Poclain', 'Sany', 'Gorakh Aavle'], ['PC-23', 'Poclain', 'Hyundai', 'Baban Bhosale'], ['PC-24', 'Poclain', 'Hyundai', 'Vaibhav Khaire']
  ];
  for (let i = 1; i <= 10; i++) W.push(['HW-' + String(i).padStart(2, '0'), 'Hiwa', '', '']);
  W.push(['JCB-01', 'JCB', '', ''], ['JCB-02', 'JCB', '', ''], ['TR-01', 'Tractor', '', ''], ['TR-02', 'Tractor', '', ''], ['TR-03', 'Tractor', '', ''],
    ['BD-01', 'Bulldozer', '', ''], ['BD-02', 'Bulldozer', '', '']);
  d.machines = W.map(([no, type, make, owner]) => {
    const t = DEFAULT_TYPES.find(x => x.type === type) || DEFAULT_TYPES[0];
    return { id: 'm-' + no.toLowerCase(), site: 's-waki', no, type, make, owner, operator: '', basis: t.basis, pkgRate: '', pkgUnits: t.units };
  });
  return d;
}

function normalizeDB(raw) {
  const d = blankDB();
  if (!raw || typeof raw !== 'object') return d;
  d.settings = Object.assign(d.settings, raw.settings || {});
  if (!Array.isArray(d.settings.types) || !d.settings.types.length) d.settings.types = DEFAULT_TYPES.map(x => ({ ...x }));
  if (!Array.isArray(d.settings.modes) || !d.settings.modes.length) d.settings.modes = MODES.slice();
  for (const k of ['sites', 'people', 'cats', 'machines']) d[k] = Array.isArray(raw[k]) ? raw[k].filter(x => x && typeof x === 'object').map(x => ({ ...x, id: x.id || uid() })) : [];
  for (const c of COLLS) d[c] = Array.isArray(raw[c]) ? raw[c].filter(x => x && typeof x === 'object').map(x => ({ ...x, id: x.id || uid() })) : [];
  d._t = raw._t || 0;
  return d;
}
const compact = r => { const o = {}; for (const k in r) { const v = r[k]; if (v === '' || v == null || (Array.isArray(v) && !v.length && k !== 'lines')) continue; o[k] = v; } return o; };

/* ---------- storage & sync ----------
   Every device keeps a full copy (IndexedDB) of what its user may see, works offline,
   and the cloud layer sends changes up and pulls down only what changed since last time. */
let DB = blankDB();
let ALLSITES = [];   // every site (for names); DB.sites holds only the sites this user may see
let BIN = [];        // deleted entries (kept, never removed)
let CLOUD = null;
const ME = { uid: '', email: '', name: '', role: '', sites: [], person: '', active: false };
const ROLE_LABEL = { admin: 'Admin', manager: 'Site Manager', accountant: 'Accountant', viewer: 'Viewer' };
const isAdmin = () => ME.role === 'admin';
const isMgr = () => ME.role === 'manager';
const isAcc = () => ME.role === 'accountant';
const isViewer = () => ME.role === 'viewer';
const seesAllSites = () => !isMgr();
const siteVisible = id => seesAllSites() || ME.sites.includes(id);
const pathSiteKey = site => (site && (ALLSITES.some(s => s.id === site) || DB.sites.some(s => s.id === site))) ? safeId(site) : '_nosite';
const keyOf = (coll, r) => coll + ':' + docIdFor(coll, r.id);
const entryPath = (coll, r) => coll === 'fund' ? 'funds/' + docIdFor('fund', r.id) : 'sites/' + pathSiteKey(r.site) + '/entries/' + docIdFor(coll, r.id);
const stripLocal = r => { const o = {}; for (const k in r) if (k[0] !== '$' && r[k] !== undefined) o[k] = r[k]; return o; };

/* tiny IndexedDB key-value store for the local copy */
const IDB = {
  p: null,
  open() {
    if (!this.p) this.p = new Promise((res, rej) => { const q = indexedDB.open('vpem', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    return this.p;
  },
  async get(k) { try { const d = await this.open(); return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const d = await this.open(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) {} },
  async del(k) { try { const d = await this.open(); await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }
};

const Store = {
  all: new Map(), cursors: {}, meta: null, metaLoaded: false, metaPend: 0, wseq: 0,
  online: navigator.onLine, err: '', firstSynced: false, lastSyncAt: 0, stop: null, siteSig: '', profSig: '',
  pendingCount() { let n = this.metaPend ? 1 : 0; for (const r of this.all.values()) if (r.$pend) n++; return n; }
};

function rebuild() {
  const m = normalizeDB(Store.meta || {});
  ALLSITES = m.sites;
  const d = blankDB();
  d.settings = m.settings; d.people = m.people; d.cats = m.cats;
  d.sites = m.sites.filter(s => siteVisible(s.id));
  d.machines = m.machines.filter(x => siteVisible(x.site));
  const bin = [];
  for (const r of Store.all.values()) {
    if (r._test || r._movedTo) continue;
    if (r._del) { bin.push(r); continue; }
    if (!d[r._c] || !COLLS.includes(r._c)) continue;
    if (r._c !== 'fund' && !siteVisible(r.site)) r.$xs = 1; else delete r.$xs; // a manager's payment on someone else's site (cash book only)
    d[r._c].push(r);
  }
  d._t = Date.now();
  DB = d; BIN = bin;
}
let rbq = 0;
function scheduleRebuild() { cancelAnimationFrame(rbq); rbq = requestAnimationFrame(() => { rebuild(); render(); }); }

let pT = 0;
function persistSoon() {
  clearTimeout(pT);
  pT = setTimeout(() => {
    if (!ME.uid) return;
    IDB.set('snap:' + ME.uid, { v: 2, at: Date.now(), me: { ...ME }, meta: Store.meta, cursors: Store.cursors, rows: [...Store.all.values()], lastSyncAt: Store.lastSyncAt });
  }, 700);
}
async function loadSnapshot(uid) {
  const s = await IDB.get('snap:' + uid);
  if (!s || !Array.isArray(s.rows)) return null;
  Store.all = new Map(s.rows.filter(r => r && r._c).map(r => [r._c + ':' + docIdFor(r._c, r.id), r]));
  Store.cursors = s.cursors || {}; Store.meta = s.meta || null; Store.metaLoaded = !!s.meta; Store.lastSyncAt = s.lastSyncAt || 0;
  return s;
}

/* ---- writes ---- */
const defaultAppr = () => isMgr() ? 'pending' : 'approved';
function prepRow(coll, rec, prev) {
  const r = stripLocal(rec);
  r._c = coll;
  if (!prev) {
    r._by = r._by || ME.uid; r._byName = r._byName || ME.name; r._at = r._at || Date.now(); r._appr = r._appr || defaultAppr();
    if (isMgr()) { r._appr = 'pending'; r._by = ME.uid; r._byName = ME.name; }
  } else {
    for (const k of ['_by', '_byName', '_at', '_appr', '_apBy', '_apByName', '_apAt']) { if (prev[k] !== undefined) r[k] = prev[k]; else delete r[k]; }
    if (isMgr()) r._appr = 'pending';
  }
  delete r._u; delete r._ub; delete r._del; delete r._movedTo;
  r._ubName = ME.name;
  return r;
}
function writeRows(coll, recs) {
  if (!recs.length) return Promise.resolve();
  const ops = [], toks = [];
  for (const rec of recs) {
    const key = keyOf(coll, rec);
    const prev = Store.all.get(key);
    const row = prepRow(coll, rec, prev);
    const path = prev && prev.$p && (coll === 'fund' || pathSiteKey(prev.site) === pathSiteKey(row.site)) ? prev.$p : entryPath(coll, row);
    ops.push({ type: 'set', path, data: row });
    const local = { ...row, _ub: ME.uid, _u: Date.now(), $p: path, $pend: ++Store.wseq };
    if (prev && prev.$p && prev.$p !== path) { ops.push({ type: 'patch', path: prev.$p, data: { _movedTo: path, _ubName: ME.name } }); local.$prevP = prev.$p; }
    Store.all.set(key, local);
    toks.push([key, local.$pend]);
  }
  return commitOps(ops, toks);
}
function patchRow(coll, row, fields) {
  const key = keyOf(coll, row), cur = Store.all.get(key);
  if (!cur || !cur.$p) { toast('This entry is not saved online yet. Try again in a moment.'); return Promise.resolve(); }
  const data = { ...fields, _ubName: ME.name };
  const local = { ...cur, ...data, _ub: ME.uid, _u: Date.now(), $pend: ++Store.wseq };
  Store.all.set(key, local);
  return commitOps([{ type: 'patch', path: cur.$p, data }], [[key, local.$pend]]);
}
function commitOps(ops, toks) {
  scheduleRebuild(); persistSoon(); setSync();
  if (!CLOUD) return Promise.resolve();
  return CLOUD.commit(ops).then(() => {
    for (const [k, t] of toks) { const r = Store.all.get(k); if (r && r.$pend === t) { delete r.$pend; delete r.$prevP; } }
    Store.err = ''; Store.lastSyncAt = Date.now(); persistSoon(); setSync();
    return true;
  }).catch(async e => { await onWriteFail(e, toks.map(t => t[0])); return false; });
}
async function onWriteFail(e, keys) {
  const code = (e && e.code) || '';
  Store.err = code === 'permission-denied' ? 'Not allowed for your login. The change was undone.'
    : code === 'resource-exhausted' ? 'The free daily limit of the online database is used up. Changes will sync tomorrow.'
    : 'Could not save online (' + (code || (e && e.message) || 'error') + ').';
  toast(Store.err);
  if (code !== 'resource-exhausted' && code !== 'unavailable') for (const k of keys) await refetch(k);
  setSync(); scheduleRebuild(); persistSoon();
}
async function refetch(key) {
  const r = Store.all.get(key); if (!r || !CLOUD) return;
  try {
    let d = r.$p ? await CLOUD.getDocServer(r.$p) : null, p = r.$p;
    if (!d && r.$prevP) { d = await CLOUD.getDocServer(r.$prevP); p = r.$prevP; }
    if (d && !d._movedTo) Store.all.set(key, { ...d, $p: p }); else Store.all.delete(key);
  } catch (e) {}
}
/* sites, people, heads, machines, settings: one document, only the admin changes it */
function saveMeta() {
  if (!isAdmin()) { toast('Only the admin can change this.'); scheduleRebuild(); return Promise.resolve(); }
  const body = { v: 1, settings: DB.settings, sites: DB.sites.map(compact), people: DB.people.map(compact), cats: DB.cats.map(compact), machines: DB.machines.map(compact) };
  Store.meta = JSON.parse(JSON.stringify(body)); Store.metaLoaded = true;
  const tok = ++Store.metaPend;
  rebuild(); checkSites(); persistSoon(); setSync();
  if (!CLOUD) return Promise.resolve();
  return CLOUD.saveMeta(Store.meta).then(() => { if (Store.metaPend === tok) Store.metaPend = 0; Store.err = ''; setSync(); persistSoon(); })
    .catch(async e => { Store.metaPend = 0; await onWriteFail(e, []); try { const m = await CLOUD.getMetaServer(); if (m) { Store.meta = m; scheduleRebuild(); } } catch (x) {} });
}
/* old-style helpers kept so the rest of the app reads the same */
function upsert(coll, rec) { return writeRows(coll, [rec]); }
function removeRow(coll, id) {
  if (!isAdmin()) { toast('Only the admin can delete.'); return Promise.resolve(); }
  const r = DB[coll].find(x => x.id === id); if (!r) return Promise.resolve();
  return patchRow(coll, r, { _del: true, _delBy: ME.uid, _delByName: ME.name, _delAt: Date.now() });
}
function addRows(coll, rows) { return writeRows(coll, rows); }

/* ---- reads from the cloud ---- */
function onRemoteDocs(lkey, changes, cursor, fromCache) {
  for (const ch of changes) {
    const d = ch.data || {};
    const coll = d._c || String(ch.docId).split('_')[0];
    if (!COLLS.includes(coll)) continue;
    const key = coll + ':' + ch.docId, cur = Store.all.get(key);
    if (ch.type === 'removed' || d._movedTo) { if (cur && cur.$p === ch.path && !cur.$pend) Store.all.delete(key); continue; }
    if (ch.pending || d._test) continue;
    Store.all.set(key, { ...d, $p: ch.path });
  }
  if (cursor) Store.cursors[lkey] = cursor;
  if (!fromCache) { Store.lastSyncAt = Date.now(); if (!Store.firstSynced) { Store.firstSynced = true; verifyStale(); } }
  scheduleRebuild(); persistSoon(); setSync();
}
function onRemoteMeta(meta) {
  if (Store.metaPend) return;
  Store.meta = meta; Store.metaLoaded = true;
  rebuild(); checkSites(); persistSoon(); scheduleRender();
}
/* entries still marked "waiting to upload" from an earlier session: confirm them with the server */
async function verifyStale() {
  try { await CLOUD.waitPending(); } catch (e) {}
  const stale = [...Store.all.entries()].filter(([, r]) => r.$pend && r.$pend <= Store.bootSeq);
  const resend = [], toks = [];
  for (const [k, r] of stale) {
    let d = null; try { d = r.$p ? await CLOUD.getDocServer(r.$p) : null; } catch (e) { return; } // offline again: try next time
    if (d && !d._movedTo) Store.all.set(k, { ...d, $p: r.$p });
    else if (r.$p && r._c && r.id != null && !r._del) { const t = ++Store.wseq; Store.all.set(k, { ...r, $pend: t }); resend.push({ type: 'set', path: r.$p, data: stripLocal({ ...r, _u: undefined, _ub: undefined }) }); toks.push([k, t]); }
    else Store.all.delete(k);
  }
  if (resend.length) commitOps(resend, toks); // saved on this phone but never reached the server: send again
  if (stale.length) { scheduleRebuild(); persistSoon(); setSync(); }
}
function syncPlan() {
  const keys = [...new Set(ALLSITES.map(s => safeId(s.id)))].concat('_nosite');
  if (seesAllSites()) return { sites: keys.map(key => ({ key, mode: 'all' })), funds: 'all', person: '', cursors: Store.cursors };
  const mine = new Set(ME.sites.map(safeId));
  return { sites: keys.map(key => ({ key, mode: mine.has(key) ? 'all' : 'paidBy' })), funds: 'person', person: ME.person, cursors: Store.cursors };
}
function startSync() {
  if (Store.stop) { Store.stop(); Store.stop = null; }
  if (!CLOUD || !ME.uid) return;
  Store.siteSig = ALLSITES.map(s => s.id).sort().join('|');
  Store.syncStartedAt = Date.now();
  Store.stop = CLOUD.startSync(syncPlan(), {
    onMeta: onRemoteMeta, onDocs: onRemoteDocs,
    onState: ({ online }) => { if (Store.online !== online) { Store.online = online; setSync(); } },
    onError: (e, key) => { Store.err = e && e.code === 'permission-denied' ? 'Your login cannot read part of the data (' + key + '). Ask the admin to check your role.' : 'Sync problem: ' + ((e && (e.code || e.message)) || 'unknown'); setSync(); }
  });
}
function checkSites() { const sig = ALLSITES.map(s => s.id).sort().join('|'); if (CLOUD && ME.uid && sig !== Store.siteSig) startSync(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Store.stop && Date.now() - (Store.syncStartedAt || 0) > 25 * 60e3) startSync(); });

function syncState() {
  const n = Store.pendingCount();
  if (!Store.online) return ['offline', 'Offline', n ? `${n} change${n > 1 ? 's' : ''} saved on this device. They upload by themselves when the network is back.` : 'No network. You can keep working; changes upload later.'];
  if (Store.err) return ['error', 'Not saved', Store.err + ' Tap to retry.'];
  if (n) return ['syncing', 'Syncing…', `Uploading ${n} change${n > 1 ? 's' : ''}…`];
  if (!Store.firstSynced) return ['syncing', 'Syncing…', 'Downloading the latest entries…'];
  return ['saved', 'Saved', 'Everything is saved online' + (Store.lastSyncAt ? ' · last sync ' + new Date(Store.lastSyncAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '') + '.'];
}
function setSync() {
  const el = $('#sync'); if (!el) return;
  const [s, txt, title] = syncState();
  el.dataset.s = s; el.textContent = txt; el.title = title;
}


/* ---------- UI state ---------- */
const UI = Object.assign({ site: 'all', period: 'all', from: '', to: '', q: {}, tab: {}, cat: '', status: '', mtype: '', limit: {},
  lastSite: '', lastCat: '', lastPayer: 'Rushi', lastMode: 'UPI', regPerson: 'Rushi', regDate: '' }, (() => { try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch (e) { return {}; } })());
UI.q = {}; UI.limit = {};
const saveUI = () => { try { const { q, limit, ...rest } = UI; localStorage.setItem(UI_KEY, JSON.stringify(rest)); } catch (e) {} };

let RANGE = ['', ''];
function periodRange() {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth();
  const f = (yy, mm) => isoLocal(new Date(yy, mm, 1)), l = (yy, mm) => isoLocal(new Date(yy, mm + 1, 0));
  switch (UI.period) {
    case 'month': return [f(y, m), l(y, m)];
    case 'last': return [f(y, m - 1), l(y, m - 1)];
    case '3m': return [f(y, m - 2), l(y, m)];
    case 'fy': { const fy = m >= 3 ? y : y - 1; return [isoLocal(new Date(fy, 3, 1)), isoLocal(new Date(fy + 1, 2, 31))]; }
    case 'custom': return [UI.from || '', UI.to || ''];
    default: return ['', ''];
  }
}
const inPeriod = d => { const [a, b] = RANGE; if (!a && !b) return true; if (!isDate(d)) return false; return (!a || d >= a) && (!b || d <= b); };
const inSite = r => UI.site === 'all' ? !r.$xs : r.site === UI.site;
const scoped = coll => DB[coll].filter(r => inSite(r) && inPeriod(r.date));
const periodLabel = () => {
  const o = { all: 'All time', month: 'This month', last: 'Last month', '3m': 'Last 3 months', fy: 'This financial year' }[UI.period];
  if (o) return o + (UI.period !== 'all' && RANGE[0] ? ` (${fmtDs(RANGE[0])} – ${fmtDs(RANGE[1])})` : '');
  return (RANGE[0] ? fmtD(RANGE[0]) : 'Start') + ' – ' + (RANGE[1] ? fmtD(RANGE[1]) : 'today');
};
const siteObj = id => DB.sites.find(s => s.id === id);
const siteName = id => (ALLSITES.find(s => s.id === id) || {}).name || 'No site';
const scopeName = () => UI.site === 'all' ? (isMgr() ? 'All my sites' : 'All sites') : siteName(UI.site);
const defSite = () => UI.site !== 'all' && siteObj(UI.site) ? UI.site : (siteObj(UI.lastSite) ? UI.lastSite : (DB.sites[0] || {}).id || '');

/* ---------- derived data (rebuilt each render) ---------- */
let MIDX = new Map(), BILLPAID = new Map(), OUTS = [];
function reindex() {
  MIDX = new Map(DB.machines.map(m => [m.site + '|' + mkey(m.no), m]));
  BILLPAID = new Map();
  for (const p of DB.opay) if (p.billId) BILLPAID.set(p.billId, (BILLPAID.get(p.billId) || 0) + num(p.amount));
  OUTS = [];
  for (const r of DB.exp) if (r.status === 'Paid' && r.paidBy) OUTS.push({ date: r.date, site: r.site, person: r.paidBy, amount: num(r.amount), mode: r.mode, coll: 'exp', id: r.id,
    label: (r.cat || 'Expense') + (r.vendor ? ' – ' + r.vendor : '') + (r.desc ? ' (' + r.desc + ')' : '') });
  for (const r of DB.dsl) if (r.status === 'Paid' && r.paidBy) OUTS.push({ date: r.date, site: r.site, person: r.paidBy, amount: num(r.amount), mode: r.mode, coll: 'dsl', id: r.id,
    label: 'Diesel – ' + (r.vendor || 'pump') + (has(r.litres) ? ', ' + qty(r.litres) + ' L' : '') });
  for (const r of DB.vpay) if (r.paidBy) OUTS.push({ date: r.date, site: r.site, person: r.paidBy, amount: num(r.amount), mode: r.mode, coll: 'vpay', id: r.id, label: 'Payment – ' + (r.vendor || '') });
  for (const r of DB.opay) if (r.paidBy) OUTS.push({ date: r.date, site: r.site, person: r.paidBy, amount: num(r.amount), mode: r.mode, coll: 'opay', id: r.id, label: 'Machine rent – ' + (r.owner || '') });
}
const machineOf = r => MIDX.get(r.site + '|' + mkey(r.mno));
const hrsOf = r => (has(r.inR) && has(r.outR)) ? Math.max(0, num(r.outR) - num(r.inR)) : num(r.hrs);
const unitRate = m => m && num(m.pkgUnits) ? num(m.pkgRate) / num(m.pkgUnits) : 0;
const billTotal = b => sum(b.lines || [], l => l.amount);
const billShare = b => billTotal(b) - num(b.comm) - num(b.deduct);
const billPaid = b => BILLPAID.get(b.id) || 0;
const billDue = b => billShare(b) - billPaid(b);
const billNet = b => billTotal(b) - num(b.comm); // rent counted in cost: full rent minus Mangalmurti commission

function ledgers() {
  const ok = r => inSite(r);
  const V = new Map(), P = new Map(), O = new Map();
  const ent = (M, name, kind) => { const k = norm(name); let v = M.get(k); if (!v) { v = { key: k, name: String(name).trim(), kind, billed: 0, paid: 0, n: 0, last: '' }; M.set(k, v); } return v; };
  const seen = (v, d) => { v.n++; if ((d || '') > v.last) v.last = d || ''; };
  for (const r of DB.exp) { if (!r.vendor || !ok(r)) continue; const v = ent(V, r.vendor, 'vendor'); v.billed += num(r.amount); if (r.status === 'Paid') v.paid += num(r.amount); seen(v, r.date); }
  for (const r of DB.dsl) { if (!r.vendor || !ok(r)) continue; const v = ent(P, r.vendor, 'pump'); v.billed += num(r.amount); if (r.status === 'Paid') v.paid += num(r.amount); seen(v, r.date); }
  const pumpSet = new Set(DB.dsl.map(r => norm(r.vendor)).filter(Boolean));
  for (const r of DB.vpay) { if (!r.vendor || !ok(r)) continue; const k = norm(r.vendor); const toP = P.has(k) || (!V.has(k) && pumpSet.has(k)); const v = ent(toP ? P : V, r.vendor, toP ? 'pump' : 'vendor'); v.paid += num(r.amount); seen(v, r.date); }
  for (const b of DB.bill) { if (!ok(b)) continue; const v = ent(O, b.owner || 'Owner not set', 'owner'); v.billed += billShare(b); seen(v, b.date); }
  for (const p of DB.opay) { if (!ok(p)) continue; const v = ent(O, p.owner || 'Owner not set', 'owner'); v.paid += num(p.amount); seen(v, p.date); }
  const fin = M => [...M.values()].map(v => ({ ...v, due: rnd(v.billed - v.paid, 0) })).sort((a, b) => b.due - a.due || natCmp(a.name, b.name));
  return { V: fin(V), P: fin(P), O: fin(O) };
}
function cashStats() {
  const M = new Map();
  const g = name => { const k = norm(name); let v = M.get(k); if (!v) { const p = DB.people.find(x => norm(x.name) === k); v = { key: k, name: p ? p.name : String(name).trim(), cash: !!(p && p.cash), known: !!p, rec: 0, spent: 0, recP: 0, spentP: 0, n: 0 }; M.set(k, v); } return v; };
  DB.people.forEach(p => g(p.name));
  for (const f of DB.fund) { if (!f.person) continue; const v = g(f.person); v.rec += num(f.amount); if (inPeriod(f.date)) v.recP += num(f.amount); }
  for (const o of OUTS) { const v = g(o.person); v.spent += o.amount; v.n++; if (inPeriod(o.date)) v.spentP += o.amount; }
  return [...M.values()].map(v => ({ ...v, bal: v.rec - v.spent })).filter(v => !isMgr() || v.key === norm(ME.person)).sort((a, b) => (b.cash - a.cash) || (b.spent - a.spent));
}
function totals() {
  const ex = scoped('exp'), ds = scoped('dsl'), ml = scoped('mlog'), bl = scoped('bill'), vp = scoped('vpay'), op = scoped('opay');
  const t = {
    exp: sum(ex, r => r.amount), expPaid: sum(ex.filter(r => r.status === 'Paid'), r => r.amount),
    dsl: sum(ds, r => r.amount), dslL: sum(ds, r => r.litres), dslLp: sum(ds.filter(r => num(r.amount)), r => r.litres), dslPaid: sum(ds.filter(r => r.status === 'Paid'), r => r.amount),
    rent: sum(bl, billTotal), comm: sum(bl, r => r.comm), vpay: sum(vp, r => r.amount), opay: sum(op, r => r.amount),
    hrs: sum(ml, hrsOf), issued: sum(ml, r => r.diesel), mlogN: ml.length, machinesUsed: new Set(ml.map(r => r.site + '|' + mkey(r.mno))).size,
    nExp: ex.length, nDsl: ds.length
  };
  t.rentNet = t.rent - t.comm;
  t.cost = t.exp + t.dsl + t.rentNet;
  t.pend = [...ex, ...ds, ...ml, ...bl, ...vp, ...op].filter(r => r._appr === 'pending').length;
  t.paidOut = t.expPaid + t.dslPaid + t.vpay + t.opay;
  return t;
}
function heads() {
  const m = new Map();
  for (const r of scoped('exp')) m.set(r.cat || 'Uncategorised', (m.get(r.cat || 'Uncategorised') || 0) + num(r.amount));
  const d = sum(scoped('dsl'), r => r.amount); if (d) m.set('Diesel', d);
  const b = sum(scoped('bill'), billNet); if (b) m.set('Machine rent (net of commission)', b);
  return [...m.entries()].map(([label, value]) => ({ label, value })).filter(x => x.value).sort((a, b) => b.value - a.value);
}
function monthly(n = 12) {
  const end = RANGE[1] && RANGE[1] < today() ? RANGE[1] : today();
  const [y, m] = end.split('-').map(Number);
  const keys = []; for (let i = n - 1; i >= 0; i--) { const t = new Date(y, m - 1 - i, 1); keys.push(isoLocal(t).slice(0, 7)); }
  const v = Object.fromEntries(keys.map(k => [k, 0]));
  const add = (d, a) => { const k = String(d || '').slice(0, 7); if (k in v) v[k] += num(a); };
  DB.exp.filter(inSite).forEach(r => add(r.date, r.amount));
  DB.dsl.filter(inSite).forEach(r => add(r.date, r.amount));
  DB.bill.filter(inSite).forEach(b => add(b.date, billNet(b)));
  return keys.map(k => ({ label: monthLabel(k), value: v[k], key: k }));
}

/* ---------- names for dropdowns ---------- */
const uniq = arr => { const m = new Map(); arr.forEach(x => { const s = String(x || '').trim(); if (s && !m.has(norm(s))) m.set(norm(s), s); }); return [...m.values()].sort(natCmp); };
const vendorNames = () => uniq([...DB.exp.map(r => r.vendor), ...DB.vpay.map(r => r.vendor)]);
const pumpNames = () => uniq(DB.dsl.map(r => r.vendor).concat(['B.D. Petroleum', 'Rajlaxmi Petrolium', 'Hp Petroleum']));
const ownerNames = () => uniq([...DB.machines.map(m => m.owner), ...DB.bill.map(b => b.owner), ...DB.opay.map(p => p.owner)]);
const payerNames = () => uniq([...DB.people.map(p => p.name), ...OUTS.map(o => o.person)]);
const driverNames = () => uniq([...DB.mlog.map(r => r.driver), ...DB.machines.map(m => m.operator)]);
const unitNames = () => uniq(['Brass', 'Trip', 'Hours', 'Days', 'Kg', 'Ton', 'Bag', 'Nos', 'Ft', 'Sq ft', 'Litre', ...DB.cats.map(c => c.unit), ...DB.exp.map(r => r.unit)]);
const dl = (id, list) => `<datalist id="${id}">${list.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;

/* ---------- small UI pieces ---------- */
const IC = {
  dash: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
  exp: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"/>',
  mach: '<path d="M3 17h13l2-5h3M5 17V9h6l3 4M7 20a2 2 0 1 0 0-.01M15 20a2 2 0 1 0 0-.01M14 9l4-5 3 2"/>',
  dsl: '<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h14M8 7h4M15 9l3 2v7a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  bill: '<path d="M7 3h10v18H7zM10 7h4M10 11h4M10 15h2"/>',
  party: '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M16 11a3 3 0 1 0 0-6M18 15c2 .6 4 2.2 4 5"/>',
  cash: '<path d="M3 7h18v10H3zM7 7V5h10v2M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>',
  rep: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  set: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', up: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>', copy: '<path d="M8 8h11v13H8zM5 16V3h11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>', left: '<path d="M15 6l-6 6 6 6"/>', right: '<path d="M9 6l6 6-6 6"/>', grid: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18"/>'
};
const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${IC[k] || ''}</svg>`;
const statusChip = s => s === 'Paid' ? '<span class="chip good">Paid</span>' : '<span class="chip warn">Unpaid</span>';
const dueChip = d => d > 0.5 ? `<span class="chip warn">Due ${inr(d)}</span>` : d < -0.5 ? `<span class="chip gold">Advance ${inr(-d)}</span>` : '<span class="chip good">Settled</span>';
const tabs = (key, list) => { const cur = UI.tab[key] || list[0][0]; return `<div class="tabs" role="tablist">${list.map(([v, l]) => `<button role="tab" aria-selected="${v === cur}" data-act="tab" data-id="${key}" data-v="${v}">${l}</button>`).join('')}</div>`; };
const curTab = (key, def) => UI.tab[key] || def;
const searchBox = (ph) => `<div class="search-wrap">${svg('search')}<input class="search" id="q_${PAGE}" data-f="q" type="search" placeholder="${esc(ph)}" value="${esc(UI.q[PAGE] || '')}" autocomplete="off"></div>`;
const qMatch = (r, fields) => { const q = norm(UI.q[PAGE]); if (!q) return true; return fields.some(f => norm(typeof f === 'function' ? f(r) : r[f]).includes(q)); };
const limitRows = (rows, key) => { const n = UI.limit[key] || 150; return { shown: rows.slice(0, n), more: rows.length > n ? rows.length - n : 0 }; };
const moreBtn = (more, key) => more ? `<div class="more"><button class="btn" data-act="more" data-id="${key}">Show ${Math.min(more, 300)} more of ${more}</button></div>` : '';
const showSiteCol = () => UI.site === 'all';
const td = (label, val, cls = '') => `<td data-l="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${val}</td>`;

function hbars(items, { fmt = inr, act } = {}) {
  if (!items.length) return '<div class="empty sm">Nothing recorded for this period.</div>';
  const m = Math.max(1, ...items.map(i => i.value));
  return `<div class="hbars">${items.map(i => `<div class="hb" data-tip="${esc(i.label + ': ' + (i.tipv || fmt(i.value)))}"${act && i.id ? ` data-act="${act}" data-id="${esc(i.id)}"` : ''}><div class="hb-l" title="${esc(i.label)}">${esc(i.label)}</div><div class="hb-t"><i style="width:${Math.max(0.6, i.value / m * 100).toFixed(2)}%"></i></div><div class="hb-v">${fmt(i.value)}</div></div>`).join('')}</div>`;
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); for (const s of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * p >= v) return s * p; return 10 * p; }
function vbars(items, { fmt = inrC, tip = inr } = {}) {
  const max = niceMax(Math.max(0, ...items.map(i => i.value)));
  const any = items.some(i => i.value > 0);
  if (!any) return '<div class="empty sm">No costs in the last 12 months for this selection.</div>';
  return `<div class="vb"><div class="vb-y"><span>${fmt(max)}</span><span>${fmt(max / 2)}</span><span>0</span></div>
    <div class="vb-plot">${items.map(i => `<div class="vb-col" data-tip="${esc(i.label + ': ' + tip(i.value))}"><i style="height:${(i.value / max * 100).toFixed(2)}%"></i></div>`).join('')}</div>
    <div class="vb-x">${items.map((i, n) => `<span>${n % 2 === items.length % 2 ? '' : esc(i.label)}</span>`).join('')}</div></div>`;
}

/* ---------- nav & top ---------- */
const PAGES = {
  dashboard: ['Dashboard', 'dash'], expenses: ['Expenses', 'exp'], machines: ['Machines', 'mach'], diesel: ['Diesel', 'dsl'],
  bills: ['Rent Bills', 'bill'], parties: ['Vendors & Parties', 'party'], cash: ['Cash Book', 'cash'], reports: ['Reports', 'rep'], setup: ['Setup', 'set'],
  users: ['Users', 'party'], account: ['My account', 'user'], welcome: ['Welcome', 'dash']
};
const pageAllowed = k => k === 'welcome' ? isAdmin() && !Store.meta : (k === 'setup' || k === 'users') ? isAdmin() : true;
let PAGE = 'dashboard';
function renderNav() {
  const cnt = { expenses: DB.exp.filter(inSite).length, machines: DB.mlog.filter(inSite).length, diesel: DB.dsl.filter(inSite).length, bills: DB.bill.filter(inSite).length };
  $('#nav').innerHTML = Object.entries(PAGES).filter(([k]) => k !== 'welcome' && pageAllowed(k)).map(([k, [l, ic]]) => `<button data-act="nav" data-id="${k}"${k === PAGE ? ' aria-current="page"' : ''}>${svg(ic)}<span>${l}</span>${cnt[k] ? `<span class="cnt">${cnt[k].toLocaleString('en-IN')}</span>` : ''}</button>`).join('');
  const active = DB.sites.filter(s => s.status !== 'Completed').length;
  $('#railFoot').innerHTML = `<button class="me" data-act="nav" data-id="account"><b>${esc(ME.name || ME.email)}</b><span>${esc(ROLE_LABEL[ME.role] || '')}</span></button><span><b>${active}</b> ${isMgr() ? 'of your' : 'active'} sites · <b>${DB.machines.filter(m => !m.removed).length}</b> machines</span>`;
}
function renderTop() {
  $('#pgTitle').textContent = PAGES[PAGE][0];
  const fs = $('#fSite');
  const sitesSorted = DB.sites.slice().sort((a, b) => (a.status === 'Completed') - (b.status === 'Completed'));
  fs.innerHTML = `<option value="all">${isMgr() ? 'All my sites' : 'All sites'}</option>` + sitesSorted.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.place ? ' · ' + esc(s.place) : ''}</option>`).join('');
  if (UI.site !== 'all' && !siteObj(UI.site)) UI.site = 'all';
  fs.value = UI.site;
  $('#fPeriod').value = UI.period;
  $('#fFrom').hidden = $('#fTo').hidden = UI.period !== 'custom';
  $('#fFrom').value = UI.from || ''; $('#fTo').value = UI.to || '';
}

/* ---------- render core ---------- */
function render() {
  if (!ME.role) return;
  if (!pageAllowed(PAGE)) PAGE = 'dashboard';
  if (isAdmin() && !Store.meta && Store.metaLoaded && !['account', 'users'].includes(PAGE)) PAGE = 'welcome';
  if (PAGE === 'welcome' && Store.meta) PAGE = 'dashboard';
  const bc = document.body.classList;
  for (const c of ['admin', 'manager', 'accountant', 'viewer']) bc.toggle('r-' + c, ME.role === c);
  for (const c of [...COLLS, 'add']) bc.toggle('can-' + c, c === 'add' ? COLLS.some(canAdd) : canAdd(c));
  RANGE = periodRange(); reindex();
  const a = document.activeElement, aid = a && $('#main').contains(a) ? a.id : '';
  let ss = null, se = null; try { ss = a.selectionStart; se = a.selectionEnd; } catch (e) {}
  renderTop(); renderNav();
  const fn = { dashboard: pgDash, expenses: pgExp, machines: pgMach, diesel: pgDiesel, bills: pgBills, parties: pgParties, cash: pgCash, reports: pgReports, setup: pgSetup, users: pgUsers, account: pgAccount, welcome: pgWelcome }[PAGE];
  $('#main').innerHTML = (!Store.meta && !['account', 'users', 'welcome'].includes(PAGE)) ? notReady() : fn();
  setSync();
  if (aid) { const el = document.getElementById(aid); if (el) { el.focus(); try { if (ss != null) el.setSelectionRange(ss, se); } catch (e) {} } }
}
let rq = 0;
function scheduleRender() { cancelAnimationFrame(rq); rq = requestAnimationFrame(render); }
function notReady() {
  if (!Store.metaLoaded) return '<div class="empty"><h3>Loading…</h3><p>Getting your sites and entries. The first time on a new phone this needs the internet.</p></div>';
  return '<div class="empty"><h3>Not set up yet</h3><p>The admin has not finished setting up the app. Try again later.</p></div>';
}
/* who may do what (the online database checks the same rules) */
const canAdd = coll => isAdmin() || (isMgr() && (coll !== 'fund' || !!ME.person) && ME.sites.length > 0) || (isAcc() && ['vpay', 'opay', 'fund'].includes(coll));
function access(coll, rec) {
  if (isAdmin()) return { mode: 'edit' };
  if (!rec) return canAdd(coll) ? { mode: 'edit' } : { mode: 'none', why: 'Your role cannot add this.' };
  if (isViewer()) return { mode: 'view', why: 'View only.' };
  if (isAcc()) return (coll === 'exp' || coll === 'dsl') && !rec._del ? { mode: 'pay', why: 'You can change only the payment details.' } : { mode: 'view', why: 'Only the admin can change this entry.' };
  if (isMgr()) {
    if (rec.$xs || (coll === 'fund' ? norm(rec.person) !== norm(ME.person) : !ME.sites.includes(rec.site))) return { mode: 'view', why: 'This entry is not on your site.' };
    if (rec._appr === 'approved') return { mode: 'view', why: 'Approved. Only the admin can change it now.' };
    return { mode: 'edit' };
  }
  return { mode: 'view', why: 'View only.' };
}
const apprChip = r => r && r._appr === 'pending' ? ' <span class="chip warn">Pending</span>' : '';
function apprLine(coll, r) {
  if (!r || !r._c) return '';
  const who = r._byName ? `Added by ${esc(r._byName)}${r._at ? ' on ' + fmtD(isoLocal(new Date(r._at))) : ''}` : '';
  const st = r._appr === 'pending' ? '<span class="chip warn">Waiting for approval</span>' : r._appr === 'approved' ? `<span class="chip good">Approved</span>${r._apByName ? ' <span class="muted sm">by ' + esc(r._apByName) + '</span>' : ''}` : '';
  return `<div class="apr">${st}<span class="muted sm">${who}${r.$pend ? ' · waiting to upload' : ''}</span></div>`;
}
function approve(coll, id) {
  const r = DB[coll] && DB[coll].find(x => x.id === id); if (!r || !isAdmin()) return;
  patchRow(coll, r, { _appr: 'approved', _apBy: ME.uid, _apByName: ME.name, _apAt: Date.now() });
  closeModal(); toast('Approved');
}

/* ================= PAGES ================= */
function scopeLine(extra = '') { return `<div class="scope"><b>${esc(scopeName())}</b><span>${esc(periodLabel())}</span>${extra}</div>`; }

function pgDash() {
  const t = totals(), L = ledgers(), C = cashStats();
  const dueV = sum(L.V.filter(x => x.due > 0), x => x.due), dueP = sum(L.P.filter(x => x.due > 0), x => x.due), dueO = sum(L.O.filter(x => x.due > 0), x => x.due);
  const pending = dueV + dueP + dueO;
  const holders = C.filter(c => c.cash);
  const anyData = COLLS.some(c => DB[c].length);
  const welcome = anyData ? '' : `<div class="card"><div class="empty"><h3>Start your plot expense register</h3><p>Your sites, people, expense heads and the Waki machine list are ready. Add today's first entry, or bring in your existing Excel workbook or Site Manager backup.</p>
    <div class="toolbar" style="justify-content:center"><button class="btn primary need-exp" data-act="add" data-id="exp">${svg('plus')}Add expense</button><button class="btn need-mlog" data-act="add" data-id="mlogBulk">${svg('grid')}Machine daily sheet</button><button class="btn need-admin" data-act="nav" data-id="setup" data-v="import">${svg('up')}Import data</button></div></div></div>`;
  const hd = heads(); const top = hd.slice(0, 9); const rest = hd.slice(9);
  if (rest.length) top.push({ label: `${rest.length} other heads`, value: sum(rest, x => x.value) });
  const dues = [...L.V, ...L.P, ...L.O].filter(x => x.due > 0.5).sort((a, b) => b.due - a.due).slice(0, 8);
  const siteRows = UI.site === 'all' ? DB.sites.map(s => {
    const f = r => r.site === s.id && inPeriod(r.date);
    return { id: s.id, label: s.name, value: sum(DB.exp.filter(f), r => r.amount) + sum(DB.dsl.filter(f), r => r.amount) + sum(DB.bill.filter(f), billNet) };
  }).filter(x => x.value > 0).sort((a, b) => b.value - a.value) : null;
  const recent = [
    ...scoped('exp').map(r => ({ d: r.date, id: r.id, act: 'editExp', site: r.site, t: (r.cat || 'Expense') + (r.vendor ? ' · ' + r.vendor : ''), a: r.amount, s: r.status, p: r._appr === 'pending' })),
    ...scoped('dsl').map(r => ({ d: r.date, id: r.id, act: 'editDsl', site: r.site, t: 'Diesel · ' + (r.vendor || '') + (has(r.litres) ? ' · ' + qty(r.litres) + ' L' : ''), a: r.amount, s: r.status, p: r._appr === 'pending' })),
    ...scoped('vpay').map(r => ({ d: r.date, id: r.id, act: 'editVpay', site: r.site, t: 'Payment to ' + (r.vendor || ''), a: r.amount, s: 'Paid' })),
    ...scoped('opay').map(r => ({ d: r.date, id: r.id, act: 'editOpay', site: r.site, t: 'Owner payment · ' + (r.owner || ''), a: r.amount, s: 'Paid' }))
  ].sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')) || String(b.id).localeCompare(String(a.id))).slice(0, 8);

  return `${scopeLine()}
  ${welcome}${approvalsCard()}
  <div class="kpis k3">
    <div class="kpi hero"><span class="k">Total cost</span><span class="v">${inr(t.cost)}</span><span class="s">Expenses ${inrC(t.exp)} · Diesel ${inrC(t.dsl)} · Rent ${inrC(t.rentNet)} (after ${inrC(t.comm)} commission)</span></div>
    <div class="kpi"><span class="k">Paid out</span><span class="v">${inr(t.paidOut)}</span><span class="s">Cash, UPI and bank payments in this period</span></div>
    <div class="kpi${pending > 0.5 ? ' alert' : ''}"><span class="k">Pending to pay</span><span class="v">${inr(pending)}</span><span class="s">Vendors ${inrC(dueV)} · Pumps ${inrC(dueP)} · Owners ${inrC(dueO)} <span class="muted">(all dates)</span></span></div>
    <div class="kpi"><span class="k">Diesel bought</span><span class="v">${qty(t.dslL, 0)} L</span><span class="s">${inr(t.dsl)}${t.dslLp ? ' · avg ₹' + qty(t.dsl / t.dslLp, 2) + '/L' : ''} · ${qty(t.issued, 0)} L filled in machines</span></div>
    <div class="kpi"><span class="k">Machine hours</span><span class="v">${qty(t.hrs, 1)}</span><span class="s">${t.mlogN.toLocaleString('en-IN')} log entries · ${t.machinesUsed} machines worked</span></div>
    <div class="kpi"><span class="k">Cash with people</span><span class="v">${inr(sum(holders, c => c.bal))}</span><span class="s">${holders.map(c => esc(c.name) + ' ' + inrC(c.bal)).join(' · ') || 'Mark cash holders in Setup'}</span></div>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h2>Cost by head</h2><span class="sub">${esc(periodLabel())}</span></div><div class="card-b">${hbars(top)}</div></section>
    <section class="card"><div class="card-h"><h2>Monthly cost</h2><span class="sub">Expenses + diesel + rent (net of commission), last 12 months</span></div><div class="card-b">${vbars(monthly(12))}</div></section>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h2>Pending payments</h2><button class="btn sm ghost" data-act="nav" data-id="parties">All parties</button></div><div class="card-b">
      ${dues.length ? `<div class="plist">${dues.map(x => `<div class="prow" data-act="party" data-id="${esc(x.kind)}" data-v="${esc(x.name)}"><span class="t">${esc(x.name)}</span><span class="d">${x.kind === 'vendor' ? 'Vendor' : x.kind === 'pump' ? 'Diesel pump' : 'Machine owner'} · ${x.n} ${x.n === 1 ? 'entry' : 'entries'}${x.last ? ' · last ' + fmtDs(x.last) : ''}</span><span class="a">${inr(x.due)}</span></div>`).join('')}</div>` : '<div class="empty sm">Nothing pending. Every vendor, pump and owner is settled.</div>'}
    </div></section>
    ${siteRows ? `<section class="card"><div class="card-h"><h2>Cost by site</h2><span class="sub">${esc(periodLabel())}</span></div><div class="card-b">${hbars(siteRows, { act: 'pickSite' })}</div></section>`
      : `<section class="card"><div class="card-h"><h2>Recent entries</h2><span class="sub">${esc(siteName(UI.site))}</span></div><div class="card-b">${recentList(recent)}</div></section>`}
  </div>
  ${siteRows ? `<section class="card"><div class="card-h"><h2>Recent entries</h2></div><div class="card-b">${recentList(recent)}</div></section>` : ''}`;
}
function approvalsCard() {
  if (!isAdmin() && !isMgr()) return '';
  const rows = [];
  for (const c of COLLS) for (const r of DB[c]) if (r._appr === 'pending' && (c === 'fund' || inSite(r))) rows.push({ c, r });
  if (!rows.length) return '';
  rows.sort((a, b) => (b.r._at || 0) - (a.r._at || 0));
  const act = { exp: 'editExp', mlog: 'editMlog', dsl: 'editDsl', vpay: 'editVpay', opay: 'editOpay', bill: 'viewBill', fund: 'editFund' };
  const label = ({ c, r }) => c === 'exp' ? (r.cat || 'Expense') + (r.vendor ? ' · ' + r.vendor : '') : c === 'mlog' ? 'Machine ' + r.mno + ' · ' + qty(hrsOf(r), 1) + ' hrs' : c === 'dsl' ? 'Diesel · ' + (r.vendor || '') : c === 'vpay' ? 'Payment to ' + (r.vendor || '') : c === 'opay' ? 'Owner payment · ' + (r.owner || '') : c === 'bill' ? 'Rent bill ' + (r.no || '') + ' · ' + (r.owner || '') : 'Money received · ' + (r.person || '');
  const amt = ({ c, r }) => c === 'mlog' ? '' : c === 'bill' ? inr(billTotal(r)) : inr(r.amount);
  return `<section class="card appr-card"><div class="card-h"><h2>${isAdmin() ? 'Waiting for your approval' : 'Your entries waiting for approval'}</h2><span class="chip warn">${rows.length}</span></div><div class="card-b"><div class="plist">
    ${rows.slice(0, 8).map(x => `<div class="prow" data-act="${act[x.c]}" data-id="${esc(x.r.id)}"><span class="t">${esc(label(x))}</span><span class="d">${fmtDs(x.r.date)} · ${esc(x.c === 'fund' ? '' : siteName(x.r.site))}${x.r._byName ? ' · by ' + esc(x.r._byName) : ''}</span><span class="a">${amt(x)}</span></div>`).join('')}
  </div>${rows.length > 8 ? `<p class="muted sm" style="margin:8px 0 0">${rows.length - 8} more. ${isAdmin() ? 'Open each one to approve it.' : ''}</p>` : (isAdmin() ? '<p class="muted sm" style="margin:8px 0 0">Open an entry to check it and approve it.</p>' : '')}</div></section>`;
}
function recentList(rows) {
  if (!rows.length) return '<div class="empty sm">No entries in this period yet.</div>';
  return `<div class="plist">${rows.map(r => `<div class="prow" data-act="${r.act}" data-id="${esc(r.id)}"><span class="t">${esc(r.t)}</span><span class="d">${fmtDs(r.d)}${showSiteCol() ? ' · ' + esc(siteName(r.site)) : ''} · ${r.s === 'Paid' ? 'Paid' : 'Unpaid'}${r.p ? ' · Pending approval' : ''}</span><span class="a">${inr(r.a)}</span></div>`).join('')}</div>`;
}

/* ----- Expenses ----- */
function pgExp() {
  let rows = scoped('exp');
  const catsUsed = uniq([...DB.cats.map(c => c.name), ...rows.map(r => r.cat)]);
  if (UI.cat) rows = rows.filter(r => (r.cat || '') === UI.cat);
  if (UI.status) rows = rows.filter(r => (r.status || 'Unpaid') === UI.status);
  rows = rows.filter(r => qMatch(r, ['vendor', 'desc', 'cat', 'remark', 'paidBy', 'bill', 'plot', r => siteName(r.site)])).sort(byDateDesc);
  const tot = sum(rows, r => r.amount), paid = sum(rows.filter(r => r.status === 'Paid'), r => r.amount);
  const { shown, more } = limitRows(rows, 'exp');
  return `${scopeLine()}
  <div class="toolbar">${searchBox('Search party, work, bill no…')}
    <select data-f="cat" aria-label="Category"><option value="">All heads</option>${catsUsed.map(c => `<option${c === UI.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select data-f="status" aria-label="Payment status"><option value="">Paid + unpaid</option><option${UI.status === 'Paid' ? ' selected' : ''}>Paid</option><option${UI.status === 'Unpaid' ? ' selected' : ''}>Unpaid</option></select>
    <button class="btn primary need-exp" data-act="add" data-id="exp">${svg('plus')}Add expense</button>
    <button class="btn" data-act="csv" data-id="exp">${svg('dl')}CSV</button>
  </div>
  <div class="strip"><span><b>${rows.length.toLocaleString('en-IN')}</b> entries</span><span>Total <b>${inr(tot)}</b></span><span>Paid <b>${inr(paid)}</b></span><span>Unpaid <b>${inr(tot - paid)}</b></span></div>
  <div class="card"><div class="tbl">${rows.length ? `<table class="rt"><thead><tr><th>Date</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Head</th><th>Party</th><th>Work / description</th><th class="n">Qty</th><th class="n">Amount</th><th>Status</th><th>Paid by</th></tr></thead><tbody>
    ${shown.map(r => `<tr data-act="editExp" data-id="${esc(r.id)}">${td('Date', fmtDs(r.date), 'c1')}${showSiteCol() ? td('Site', esc(siteName(r.site))) : ''}${td('Head', esc(r.cat || '—'))}${td('Party', esc(r.vendor || '—'), 'main')}${td('Work', `<span class="clip">${esc(r.desc || '')}</span>${r.bill ? `<span class="sub">Bill ${esc(r.bill)}</span>` : ''}`, r.desc || r.bill ? '' : 'mh')}${td('Qty', has(r.qty) ? qty(r.qty, 2) + ' ' + esc(r.unit || '') : '', 'n')}${td('Amount', num(r.amount) ? inr(r.amount) : '<span class="chip bad">No amount</span>', 'n main')}${td('Status', statusChip(r.status) + apprChip(r))}${td('Paid by', esc(r.status === 'Paid' ? [r.paidBy, r.mode].filter(Boolean).join(' · ') : ''))}</tr>`).join('')}
  </tbody></table>${moreBtn(more, 'exp')}` : emptyState('No expenses here yet', 'Add JCB, murum, road, wall compound and every other site cost. Unpaid entries show up as vendor dues.', 'exp', 'Add expense')}</div></div>`;
}
const emptyState = (h, p, add, label) => `<div class="empty"><h3>${esc(h)}</h3><p>${esc(p)}</p>${add ? `<button class="btn primary need-${add === 'mlogBulk' ? 'mlog' : add === 'machine' ? 'admin' : add}" data-act="add" data-id="${add}">${svg('plus')}${esc(label)}</button>` : ''}</div>`;

/* ----- Machines ----- */
function pgMach() {
  const tab = curTab('mach', 'log');
  const head = `${scopeLine()}<div class="toolbar">${tabs('mach', [['log', 'Daily log'], ['sum', 'Machine summary'], ['list', 'Machine list']])}<span class="grow"></span>
    <button class="btn primary need-mlog" data-act="add" data-id="mlogBulk">${svg('grid')}Daily sheet</button><button class="btn need-mlog" data-act="add" data-id="mlog">${svg('plus')}Single entry</button></div>`;
  const types = uniq(DB.machines.map(m => m.type)).sort((a, b) => TYPE_ORDER(a) - TYPE_ORDER(b));
  const typeSel = `<select data-f="mtype" aria-label="Machine type"><option value="">All types</option>${types.map(t => `<option${t === UI.mtype ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  if (tab === 'log') {
    let rows = scoped('mlog').filter(r => !UI.mtype || ((machineOf(r) || {}).type === UI.mtype));
    rows = rows.filter(r => qMatch(r, ['mno', 'driver', 'remark', r => (machineOf(r) || {}).owner, r => siteName(r.site)])).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || natCmp(mkey(a.mno), mkey(b.mno)));
    const { shown, more } = limitRows(rows, 'mlog');
    return head + `<div class="toolbar">${searchBox('Search machine, driver, owner…')}${typeSel}<button class="btn" data-act="csv" data-id="mlog">${svg('dl')}CSV</button></div>
    <div class="strip"><span><b>${rows.length.toLocaleString('en-IN')}</b> entries</span><span>Hours <b>${qty(sum(rows, hrsOf), 1)}</b></span><span>Diesel filled <b>${qty(sum(rows, r => r.diesel), 0)} L</b></span></div>
    <div class="card"><div class="tbl">${rows.length ? `<table class="rt"><thead><tr><th>Date</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Machine</th><th>Driver</th><th>Work</th><th class="n">In</th><th class="n">Out</th><th class="n">Hours</th><th class="n">Diesel</th><th>Remark</th></tr></thead><tbody>
      ${shown.map(r => { const m = machineOf(r); return `<tr data-act="editMlog" data-id="${esc(r.id)}">${td('Date', fmtDs(r.date), 'c1')}${showSiteCol() ? td('Site', esc(siteName(r.site))) : ''}${td('Machine', `<span class="main">${esc(r.mno)}</span><span class="sub">${esc(m ? [m.type, m.owner].filter(Boolean).join(' · ') : 'Not in machine list')}</span>`)}${td('Driver', esc(r.driver || ''))}${td('Work', r.attach && r.attach !== 'None' ? esc(r.attach) : '')}${td('In', has(r.inR) ? qty(r.inR, 1) : '', 'n')}${td('Out', has(r.outR) ? qty(r.outR, 1) : '', 'n')}${td('Hours', qty(hrsOf(r), 1), 'n main')}${td('Diesel', has(r.diesel) ? qty(r.diesel, 1) + ' L' : '', 'n')}${td('Remark', `<span class="clip">${esc(r.remark || '')}</span>${apprChip(r)}`, r.remark || r._appr === 'pending' ? '' : 'mh')}</tr>`; }).join('')}
    </tbody></table>${moreBtn(more, 'mlog')}` : emptyState('No machine entries yet', 'Use the daily sheet to fill hour-meter readings and diesel for every machine of a site in one go.', 'mlogBulk', 'Open daily sheet')}</div></div>`;
  }
  if (tab === 'sum') {
    const logs = scoped('mlog');
    const per = new Map();
    for (const r of logs) {
      const k = r.site + '|' + mkey(r.mno); let v = per.get(k);
      if (!v) { const m = machineOf(r); v = { site: r.site, no: m ? m.no : r.mno, m, days: new Set(), hrs: 0, diesel: 0, n: 0 }; per.set(k, v); }
      v.days.add(r.date); v.hrs += hrsOf(r); v.diesel += num(r.diesel); v.n++;
    }
    let list = [...per.values()].filter(v => !UI.mtype || (v.m && v.m.type === UI.mtype)).filter(v => qMatch(v, ['no', x => x.m && x.m.owner, x => x.m && x.m.type]));
    list.forEach(v => { const m = v.m; const daily = m && m.basis === 'Daily'; v.units = daily ? v.days.size : v.hrs; v.rate = unitRate(m); v.rent = v.units * v.rate; });
    list.sort((a, b) => (TYPE_ORDER((a.m || {}).type) - TYPE_ORDER((b.m || {}).type)) || natCmp(a.no, b.no));
    const byType = new Map(); list.forEach(v => { const t = (v.m || {}).type || 'Unknown'; const o = byType.get(t) || { t, n: 0, hrs: 0, diesel: 0, rent: 0 }; o.n++; o.hrs += v.hrs; o.diesel += v.diesel; o.rent += v.rent; byType.set(t, o); });
    const maxH = Math.max(1, ...list.map(v => v.hrs));
    return head + `<div class="toolbar">${searchBox('Search machine or owner…')}${typeSel}<button class="btn" data-act="csv" data-id="msum">${svg('dl')}CSV</button></div>
    <div class="kpis">${[...byType.values()].map(o => `<div class="kpi"><span class="k">${esc(o.t)} · ${o.n}</span><span class="v">${qty(o.hrs, 0)} hrs</span><span class="s">${qty(o.diesel, 0)} L diesel${o.rent ? ' · est. rent ' + inrC(o.rent) : ''}</span></div>`).join('') || ''}</div>
    <div class="card"><div class="tbl">${list.length ? `<table class="rt"><thead><tr><th>Machine</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Owner</th><th class="n">Days</th><th class="n">Hours</th><th class="n">Diesel</th><th class="n">L / hr</th><th class="n">Rate</th><th class="n">Est. rent</th></tr></thead><tbody>
      ${list.map(v => `<tr data-act="machLog" data-id="${esc(v.no)}" data-v="${esc(v.site)}">${td('Machine', `<span class="main">${esc(v.no)}</span><span class="sub">${esc((v.m || {}).type || 'Not in machine list')}${v.m && v.m.make ? ' · ' + esc(v.m.make) : ''}</span>`, 'c1')}${showSiteCol() ? td('Site', esc(siteName(v.site))) : ''}${td('Owner', esc((v.m || {}).owner || ''))}${td('Days', v.days.size, 'n')}${td('Hours', qty(v.hrs, 1) + `<span class="ibar hide-m" style="width:${(v.hrs / maxH * 60).toFixed(1)}px"></span>`, 'n main')}${td('Diesel', qty(v.diesel, 0) + ' L', 'n')}${td('L / hr', v.hrs ? qty(v.diesel / v.hrs, 1) : '—', 'n')}${td('Rate', v.rate ? inr(v.rate) + (v.m.basis === 'Daily' ? '/day' : '/hr') : '<span class="muted">Not set</span>', 'n')}${td('Est. rent', v.rent ? inr(v.rent) : '—', 'n')}</tr>`).join('')}
    </tbody></table>` : emptyState('No machine work in this period', 'Totals per machine appear here once daily log entries are added.', 'mlogBulk', 'Open daily sheet')}</div></div>`;
  }
  // list
  let ms = DB.machines.filter(m => UI.site === 'all' || m.site === UI.site).filter(m => !UI.mtype || m.type === UI.mtype).filter(m => qMatch(m, ['no', 'owner', 'make', 'operator', 'type']));
  ms.sort((a, b) => natCmp(siteName(a.site), siteName(b.site)) || (!!a.removed - !!b.removed) || (TYPE_ORDER(a.type) - TYPE_ORDER(b.type)) || natCmp(a.no, b.no));
  return head + `<div class="toolbar">${searchBox('Search machine, owner, make…')}${typeSel}<button class="btn primary need-admin" data-act="add" data-id="machine">${svg('plus')}Add machine</button><button class="btn need-admin" data-act="bulkRate">Set rent rates</button></div>
  <div class="card"><div class="tbl">${ms.length ? `<table class="rt"><thead><tr><th>Machine</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Type</th><th>Make</th><th>Owner</th><th>Operator</th><th>Rent basis</th><th class="n">Package</th><th class="n">Rate</th><th>Status</th></tr></thead><tbody>
    ${ms.map(m => `<tr data-act="editMachine" data-id="${esc(m.id)}">${td('Machine', `<span class="main">${esc(m.no)}</span>`, 'c1')}${showSiteCol() ? td('Site', esc(siteName(m.site))) : ''}${td('Type', esc(m.type))}${td('Make', esc(m.make || ''))}${td('Owner', esc(m.owner || ''))}${td('Operator', esc(m.operator || ''))}${td('Basis', m.basis === 'Daily' ? 'Per day (' + (num(m.pkgUnits) || 30) + '-day package)' : 'Per hour (' + (num(m.pkgUnits) || 240) + '-hr package)')}${td('Package', num(m.pkgRate) ? inr(m.pkgRate) : '<span class="muted">Not set</span>', 'n')}${td('Rate', unitRate(m) ? inr(unitRate(m)) + (m.basis === 'Daily' ? '/day' : '/hr') : '—', 'n')}${td('Status', m.removed ? '<span class="chip">Removed</span>' : '<span class="chip good">On site</span>')}</tr>`).join('')}
  </tbody></table>` : emptyState('No machines for this site', 'Add the rented Poclain, JCB, Hiwa, tractors and other machines working here.', 'machine', 'Add machine')}</div></div>`;
}

/* ----- Diesel ----- */
function pgDiesel() {
  const tab = curTab('dsl', 'buy');
  const head = `${scopeLine()}<div class="toolbar">${tabs('dsl', [['buy', 'Purchases'], ['stock', 'Stock at site']])}<span class="grow"></span><button class="btn primary need-dsl" data-act="add" data-id="dsl">${svg('plus')}Add diesel bill</button></div>`;
  if (tab === 'buy') {
    let rows = scoped('dsl');
    if (UI.status) rows = rows.filter(r => (r.status || 'Unpaid') === UI.status);
    rows = rows.filter(r => qMatch(r, ['vendor', 'bill', 'paidBy', 'remark', r => siteName(r.site)])).sort(byDateDesc);
    const L = sum(rows, r => r.litres), Lp = sum(rows.filter(r => num(r.amount)), r => r.litres), A = sum(rows, r => r.amount), up = sum(rows.filter(r => r.status !== 'Paid'), r => r.amount);
    const byPump = new Map(); rows.forEach(r => { const k = r.vendor || 'Pump not set'; const o = byPump.get(k) || { label: k, value: 0, l: 0 }; o.value += num(r.amount); o.l += num(r.litres); byPump.set(k, o); });
    const { shown, more } = limitRows(rows, 'dsl');
    return head + `<div class="toolbar">${searchBox('Search pump, bill no, paid by…')}<select data-f="status" aria-label="Payment status"><option value="">Paid + unpaid</option><option${UI.status === 'Paid' ? ' selected' : ''}>Paid</option><option${UI.status === 'Unpaid' ? ' selected' : ''}>Unpaid</option></select><button class="btn" data-act="csv" data-id="dsl">${svg('dl')}CSV</button></div>
    <div class="kpis k3"><div class="kpi"><span class="k">Litres bought</span><span class="v">${qty(L, 1)} L</span><span class="s">${rows.length} bills</span></div><div class="kpi"><span class="k">Amount</span><span class="v">${inr(A)}</span><span class="s">${Lp ? 'Average ₹' + qty(A / Lp, 2) + ' per litre' : '—'}</span></div><div class="kpi${up > 0.5 ? ' alert' : ''}"><span class="k">Unpaid</span><span class="v">${inr(up)}</span><span class="s">${rows.filter(r => r.status !== 'Paid').length} bills not paid</span></div></div>
    ${byPump.size > 1 ? `<section class="card"><div class="card-h"><h2>By pump</h2></div><div class="card-b">${hbars([...byPump.values()].sort((a, b) => b.value - a.value).map(o => ({ ...o, tipv: inr(o.value) + ' · ' + qty(o.l, 0) + ' L' })))}</div></section>` : ''}
    <div class="card"><div class="tbl">${rows.length ? `<table class="rt"><thead><tr><th>Date</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Pump</th><th class="n">Litres</th><th class="n">Rate</th><th class="n">Amount</th><th>Bill no.</th><th>Status</th><th>Paid by</th></tr></thead><tbody>
      ${shown.map(r => `<tr data-act="editDsl" data-id="${esc(r.id)}">${td('Date', fmtDs(r.date), 'c1')}${showSiteCol() ? td('Site', esc(siteName(r.site))) : ''}${td('Pump', esc(r.vendor || ''), 'main')}${td('Litres', has(r.litres) ? qty(r.litres, 1) : '', 'n')}${td('Rate', num(r.litres) && num(r.amount) ? '₹' + qty(r.amount / r.litres, 2) : '', 'n')}${td('Amount', num(r.amount) ? inr(r.amount) : '<span class="chip bad">No amount</span>', 'n main')}${td('Bill no.', esc(r.bill || ''))}${td('Status', statusChip(r.status) + apprChip(r))}${td('Paid by', esc(r.status === 'Paid' ? [r.paidBy, r.mode].filter(Boolean).join(' · ') : ''))}</tr>`).join('')}
    </tbody></table>${moreBtn(more, 'dsl')}` : emptyState('No diesel bills yet', 'Record each pump bill with litres and amount. Unpaid bills show up under pending payments.', 'dsl', 'Add diesel bill')}</div></div>`;
  }
  const sites = DB.sites.filter(s => UI.site === 'all' ? (DB.dsl.some(r => r.site === s.id) || DB.mlog.some(r => r.site === s.id)) : s.id === UI.site);
  const rowsS = sites.map(s => {
    const bought = sum(DB.dsl.filter(r => r.site === s.id && inPeriod(r.date)), r => r.litres), filled = sum(DB.mlog.filter(r => r.site === s.id && inPeriod(r.date)), r => r.diesel);
    const allB = sum(DB.dsl.filter(r => r.site === s.id), r => r.litres), allF = sum(DB.mlog.filter(r => r.site === s.id), r => r.diesel);
    return { s, bought, filled, bal: num(s.dieselOpening) + allB - allF };
  });
  const mk = new Map();
  const addM = (d, k, v) => { const m = String(d || '').slice(0, 7); if (!m) return; const o = mk.get(m) || { m, b: 0, f: 0 }; o[k] += num(v); mk.set(m, o); };
  scoped('dsl').forEach(r => addM(r.date, 'b', r.litres)); scoped('mlog').forEach(r => addM(r.date, 'f', r.diesel));
  const months = [...mk.values()].sort((a, b) => b.m.localeCompare(a.m));
  return head + `<p class="muted sm" style="margin:0">Stock in hand = opening stock (set per site in Setup) + all litres bought − all litres filled in machines.</p>
  <div class="card"><div class="tbl">${rowsS.length ? `<table class="rt"><thead><tr><th>Site</th><th class="n">Opening</th><th class="n">Bought (period)</th><th class="n">Filled in machines (period)</th><th class="n">Stock in hand now</th></tr></thead><tbody>
    ${rowsS.map(o => `<tr>${td('Site', `<span class="main">${esc(o.s.name)}</span>`, 'c1')}${td('Opening', qty(o.s.dieselOpening, 0) + ' L', 'n')}${td('Bought', qty(o.bought, 1) + ' L', 'n')}${td('Filled', qty(o.filled, 1) + ' L', 'n')}${td('Stock now', `<b>${qty(o.bal, 1)} L</b> ${o.bal < -0.5 ? '<span class="chip bad">Check entries</span>' : ''}`, 'n')}</tr>`).join('')}
  </tbody></table>` : '<div class="empty">No diesel bought or filled yet.</div>'}</div></div>
  ${months.length ? `<section class="card"><div class="card-h"><h2>Month by month</h2></div><div class="tbl"><table class="rt"><thead><tr><th>Month</th><th class="n">Bought</th><th class="n">Filled in machines</th><th class="n">Difference</th></tr></thead><tbody>${months.map(o => `<tr>${td('Month', monthLabel(o.m), 'c1')}${td('Bought', qty(o.b, 1) + ' L', 'n')}${td('Filled', qty(o.f, 1) + ' L', 'n')}${td('Difference', qty(o.b - o.f, 1) + ' L', 'n')}</tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

/* ----- Rent bills ----- */
function pgBills() {
  let bills = scoped('bill').filter(b => qMatch(b, ['no', 'owner', 'note', b => siteName(b.site)])).sort(byDateDesc);
  const tb = sum(bills, billTotal), tc = sum(bills, b => b.comm), ts = sum(bills, billShare), tp = sum(bills, billPaid);
  const L = ledgers().O;
  return `${scopeLine()}
  <div class="toolbar">${searchBox('Search bill no, owner…')}<button class="btn primary need-bill" data-act="newBill">${svg('plus')}New rent bill</button><button class="btn need-opay" data-act="add" data-id="opay">Record owner payment</button></div>
  <div class="kpis k4"><div class="kpi"><span class="k">Rent billed</span><span class="v">${inr(tb)}</span><span class="s">${bills.length} bills</span></div>
    <div class="kpi"><span class="k">Commission</span><span class="v">${inr(tc)}</span><span class="s">${esc(DB.settings.commParty)}</span></div>
    <div class="kpi"><span class="k">Owners' share</span><span class="v">${inr(ts)}</span><span class="s">Paid ${inr(tp)}</span></div>
    <div class="kpi${ts - tp > 0.5 ? ' alert' : ''}"><span class="k">Still to pay owners</span><span class="v">${inr(ts - tp)}</span><span class="s">On these bills</span></div></div>
  <div class="card"><div class="card-h"><h2>Bills</h2></div><div class="tbl">${bills.length ? `<table class="rt"><thead><tr><th>Bill</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Owner</th><th>Period</th><th class="n">Total</th><th class="n">Commission</th><th class="n">Owner share</th><th class="n">Paid</th><th>Status</th></tr></thead><tbody>
    ${bills.map(b => `<tr data-act="viewBill" data-id="${esc(b.id)}">${td('Bill', `<span class="main">${esc(b.no || 'Bill')}</span><span class="sub">${fmtDs(b.date)}</span>`, 'c1')}${showSiteCol() ? td('Site', esc(siteName(b.site))) : ''}${td('Owner', esc(b.owner || ''), 'main')}${td('Period', b.from || b.to ? fmtDs(b.from) + ' – ' + fmtDs(b.to) : '')}${td('Total', inr(billTotal(b)), 'n')}${td('Commission', inr(b.comm), 'n')}${td('Owner share', inr(billShare(b)), 'n main')}${td('Paid', inr(billPaid(b)), 'n')}${td('Status', dueChip(billDue(b)) + apprChip(b))}</tr>`).join('')}
  </tbody></table>` : `<div class="empty"><h3>No rent bills yet</h3><p>A bill is worked out from the machine log: Poclain and JCB by hours on the 240-hour package, Hiwa by days worked on the 30-day rate. The ${esc(DB.settings.commParty)} share is taken out and the rest is the owner's.</p><button class="btn primary need-bill" data-act="newBill">${svg('plus')}New rent bill</button></div>`}</div></div>
  ${L.length ? `<section class="card"><div class="card-h"><h2>Owner balances</h2><span class="sub">All dates · ${esc(scopeName())}</span></div><div class="tbl"><table class="rt"><thead><tr><th>Owner</th><th class="n">Billed (owner share)</th><th class="n">Paid</th><th>Balance</th></tr></thead><tbody>
    ${L.map(o => `<tr data-act="party" data-id="owner" data-v="${esc(o.name)}">${td('Owner', `<span class="main">${esc(o.name)}</span>`, 'c1')}${td('Billed', inr(o.billed), 'n')}${td('Paid', inr(o.paid), 'n')}${td('Balance', dueChip(o.due))}</tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

/* ----- Parties ----- */
function pgParties() {
  const tab = curTab('party', 'vendor');
  const L = ledgers();
  const list = (tab === 'vendor' ? L.V : tab === 'pump' ? L.P : L.O).filter(x => qMatch(x, ['name']));
  const due = sum(list.filter(x => x.due > 0), x => x.due);
  return `${scopeLine('<span>Balances use every date, not only the period above</span>')}
  <div class="toolbar">${tabs('party', [['vendor', `Vendors (${L.V.length})`], ['pump', `Diesel pumps (${L.P.length})`], ['owner', `Machine owners (${L.O.length})`]])}<span class="grow"></span><button class="btn primary need-${tab === 'owner' ? 'opay' : 'vpay'}" data-act="add" data-id="${tab === 'owner' ? 'opay' : 'vpay'}">${svg('plus')}Record payment</button></div>
  <div class="toolbar">${searchBox('Search name…')}<button class="btn" data-act="csv" data-id="party">${svg('dl')}CSV</button></div>
  <div class="strip"><span><b>${list.length}</b> parties</span><span>Total due <b>${inr(due)}</b></span><span><b>${list.filter(x => x.due > 0.5).length}</b> with dues</span></div>
  <div class="card"><div class="tbl">${list.length ? `<table class="rt"><thead><tr><th>Name</th><th class="n">Entries</th><th>Last entry</th><th class="n">${tab === 'owner' ? 'Owner share billed' : 'Billed'}</th><th class="n">Paid</th><th>Balance</th></tr></thead><tbody>
    ${list.map(x => `<tr data-act="party" data-id="${x.kind}" data-v="${esc(x.name)}">${td('Name', `<span class="main">${esc(x.name)}</span>`, 'c1')}${td('Entries', x.n, 'n')}${td('Last entry', fmtDs(x.last))}${td('Billed', inr(x.billed), 'n')}${td('Paid', inr(x.paid), 'n')}${td('Balance', dueChip(x.due))}</tr>`).join('')}
  </tbody></table>` : `<div class="empty"><h3>No ${tab === 'vendor' ? 'vendors' : tab === 'pump' ? 'diesel pumps' : 'machine owners'} yet</h3><p>Parties are picked up automatically from your ${tab === 'vendor' ? 'expenses' : tab === 'pump' ? 'diesel bills' : 'rent bills'}. No separate entry needed.</p></div>`}</div></div>`;
}

/* ----- Cash book ----- */
function pgCash() {
  const tab = curTab('cash', 'reg');
  const C = cashStats();
  const cards = C.filter(c => c.known || c.spent || c.rec).map(c => `<div class="pc" data-act="regFor" data-id="${esc(c.name)}"><div class="pc-h"><b>${esc(c.name)}</b>${c.cash ? '<span class="chip gold">Holds cash</span>' : '<span class="chip">Pays directly</span>'}</div>
    ${c.cash ? `<span class="bal">${inr(c.bal)}</span><span class="muted sm">Balance in hand</span>` : `<span class="bal">${inr(c.spent)}</span><span class="muted sm">Paid in total</span>`}
    <dl><dt>Received (period)</dt><dd>${inr(c.recP)}</dd><dt>Spent (period)</dt><dd>${inr(c.spentP)}</dd>${c.cash ? `<dt>All-time received</dt><dd>${inr(c.rec)}</dd>` : ''}</dl></div>`).join('');
  const head = `<div class="scope"><b>Money with people</b><span>Money received is not tied to a site. Spending is recorded against the site where it was used.</span></div>
  <div class="people">${cards}</div>
  <div class="toolbar">${tabs('cash', [['reg', 'Daily register'], ['rec', 'Money received'], ['out', 'Spending']])}<span class="grow"></span><button class="btn primary need-fund" data-act="add" data-id="fund">${svg('plus')}Add money received</button></div>`;
  if (tab === 'reg') {
    const person = isMgr() ? (ME.person || '—') : (UI.regPerson || 'Rushi'), date = UI.regDate || today();
    const R = register(person, date);
    const ppl = isMgr() ? [person] : payerNames();
    return head + `<div class="card"><div class="card-b">
      <div class="toolbar" style="margin-bottom:14px"><select data-f="regPerson" aria-label="Person">${ppl.map(p => `<option${norm(p) === norm(person) ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <button class="icon-btn" data-act="regDay" data-v="-1" aria-label="Previous day">${svg('left')}</button><input type="date" class="inp" style="width:auto" data-f="regDate" id="regDate" value="${esc(date)}" aria-label="Register date"><button class="icon-btn" data-act="regDay" data-v="1" aria-label="Next day">${svg('right')}</button>
        <span class="grow"></span><button class="btn" data-act="copyReg">${svg('copy')}Copy for WhatsApp</button><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(R.text)}">Open WhatsApp</a></div>
      ${R.html}</div></div>`;
  }
  if (tab === 'rec') {
    let rows = DB.fund.filter(f => inPeriod(f.date)).filter(r => qMatch(r, ['person', 'from', 'remark', 'mode'])).sort(byDateDesc);
    return head + `<div class="toolbar">${searchBox('Search person, from…')}<button class="btn" data-act="csv" data-id="fund">${svg('dl')}CSV</button></div>
    <div class="strip"><span><b>${rows.length}</b> entries</span><span>Total <b>${inr(sum(rows, r => r.amount))}</b></span><span class="muted">${esc(periodLabel())}</span></div>
    <div class="card"><div class="tbl">${rows.length ? `<table class="rt"><thead><tr><th>Date</th><th>Received by</th><th>From</th><th>Mode</th><th class="n">Amount</th><th>Remark</th></tr></thead><tbody>
      ${rows.map(r => `<tr data-act="editFund" data-id="${esc(r.id)}">${td('Date', fmtDs(r.date), 'c1')}${td('Received by', esc(r.person), 'main')}${td('From', esc(r.from || ''))}${td('Mode', esc(r.mode || ''))}${td('Amount', inr(r.amount), 'n main')}${td('Remark', esc(r.remark || '') + apprChip(r), r.remark || r._appr === 'pending' ? '' : 'mh')}</tr>`).join('')}</tbody></table>` : emptyState('No money received in this period', 'Record each advance Rushi or Sahil gets. Their balance is received money minus everything they paid.', 'fund', 'Add money received')}</div></div>`;
  }
  let outs = OUTS.filter(o => inPeriod(o.date) && (isMgr() ? norm(o.person) === norm(ME.person) && (UI.site === 'all' || o.site === UI.site) : inSite(o))).filter(o => qMatch(o, ['person', 'label', r => siteName(r.site)])).sort(byDateDesc);
  const { shown, more } = limitRows(outs, 'outs');
  return head + `<div class="toolbar">${searchBox('Search person, detail…')}</div>
  <div class="strip"><span><b>${outs.length}</b> payments</span><span>Total <b>${inr(sum(outs, o => o.amount))}</b></span><span class="muted">${esc(scopeName())} · ${esc(periodLabel())}</span></div>
  <div class="card"><div class="tbl">${outs.length ? `<table class="rt"><thead><tr><th>Date</th><th>Paid by</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Detail</th><th>Mode</th><th class="n">Amount</th></tr></thead><tbody>
    ${shown.map(o => `<tr data-act="${{ exp: 'editExp', dsl: 'editDsl', vpay: 'editVpay', opay: 'editOpay' }[o.coll]}" data-id="${esc(o.id)}">${td('Date', fmtDs(o.date), 'c1')}${td('Paid by', esc(o.person), 'main')}${showSiteCol() ? td('Site', esc(siteName(o.site))) : ''}${td('Detail', `<span class="clip">${esc(o.label)}</span>`)}${td('Mode', esc(o.mode || ''))}${td('Amount', inr(o.amount), 'n main')}</tr>`).join('')}</tbody></table>${moreBtn(more, 'outs')}` : '<div class="empty">No payments in this period.</div>'}</div></div>`;
}
function register(person, date) {
  const k = norm(person);
  const outs = OUTS.filter(o => norm(o.person) === k && isDate(o.date));
  const funds = DB.fund.filter(f => norm(f.person) === k && isDate(f.date));
  const prev = sum(funds.filter(f => f.date < date), f => f.amount) - sum(outs.filter(o => o.date < date), o => o.amount);
  const recT = funds.filter(f => f.date === date), outT = outs.filter(o => o.date === date);
  const rec = sum(recT, f => f.amount), spent = sum(outT, o => o.amount), remain = prev + rec - spent;
  const bySite = new Map(); outT.forEach(o => { const n = siteName(o.site); (bySite.get(n) || bySite.set(n, []).get(n)).push(o); });
  let html = `<div class="reg"><div class="rh"><span><b>${esc(person)}</b> · ${fmtD(date)}</span><span></span></div>
    <div class="rh"><span>Previous balance</span><span>${inr(prev)}</span></div>
    <div class="rh"><span>Received${recT.length ? ' <span class="muted sm">(' + recT.map(f => esc(f.from || 'not noted')).join(', ') + ')</span>' : ''}</span><span>${inr(rec)}</span></div>`;
  let text = `*Daily Expense – ${person}*\nDate: ${fmtD(date)}\nPrevious balance: ${inr(prev)}\nReceived: ${inr(rec)}${recT.length ? ' (' + recT.map(f => f.from || 'not noted').join(', ') + ')' : ''}\n`;
  if (!outT.length) { html += `<div class="it muted" style="padding:12px 0">No payments by ${esc(person)} on this day.</div>`; }
  for (const [s, list] of bySite) {
    html += `<div class="site">${esc(s)}</div>` + list.map(o => `<div class="it"><span>${esc(o.label)}${o.mode ? ' <span class="muted sm">· ' + esc(o.mode) + '</span>' : ''}</span><span>${inr(o.amount)}</span></div>`).join('');
    text += `\n*${s}*\n` + list.map(o => `${o.label}: ${inr(o.amount)}`).join('\n') + '\n';
  }
  html += `<div class="rh tot"><span>Total expense</span><span>${inr(spent)}</span></div><div class="rh big"><span><b>Remaining amount</b></span><span>${inr(remain)}</span></div></div>`;
  text += `\nTotal expense: ${inr(spent)}\n*Remaining amount: ${inr(remain)}*`;
  return { html, text, prev, rec, spent, remain };
}

/* ----- Reports ----- */
function siteSummary() {
  return DB.sites.map(s => {
    const f = r => r.site === s.id && inPeriod(r.date);
    const ex = DB.exp.filter(f), ds = DB.dsl.filter(f), bl = DB.bill.filter(f);
    const e = sum(ex, r => r.amount), d = sum(ds, r => r.amount), b = sum(bl, billNet), c = sum(bl, r => r.comm);
    const paid = sum(ex.filter(r => r.status === 'Paid'), r => r.amount) + sum(ds.filter(r => r.status === 'Paid'), r => r.amount) + sum(DB.vpay.filter(f), r => r.amount) + sum(DB.opay.filter(f), r => r.amount);
    return { s, e, d, b, c, total: e + d + b, paid, hrs: sum(DB.mlog.filter(f), hrsOf) };
  });
}
function pgReports() {
  const ss = siteSummary().filter(x => x.total || x.hrs || UI.site === x.s.id).filter(x => UI.site === 'all' || x.s.id === UI.site);
  const hd = heads();
  const mon = new Map();
  const add = (d, k, v) => { const m = String(d || '').slice(0, 7); if (!m) return; const o = mon.get(m) || { m, e: 0, d: 0, b: 0 }; o[k] += num(v); mon.set(m, o); };
  scoped('exp').forEach(r => add(r.date, 'e', r.amount)); scoped('dsl').forEach(r => add(r.date, 'd', r.amount)); scoped('bill').forEach(b => add(b.date, 'b', billNet(b)));
  const months = [...mon.values()].sort((a, b) => b.m.localeCompare(a.m));
  const tot = sum(hd, h => h.value);
  return `${scopeLine()}
  <div class="toolbar"><button class="btn primary" data-act="xlsx">${svg('dl')}Export Excel workbook</button><button class="btn need-admin" data-act="backup">${svg('dl')}Backup (.json)</button><button class="btn need-admin" data-act="nav" data-id="setup" data-v="import">${svg('up')}Import or restore</button>${canPrint() ? '<button class="btn" data-act="print">Print</button>' : ''}</div>
  <section class="card"><div class="card-h"><h2>Site summary</h2><span class="sub">${esc(periodLabel())} · rent shown after ${esc(DB.settings.commParty)} commission; commission is not a cost</span></div><div class="tbl">${ss.length ? `<table class="rt"><thead><tr><th>Site</th><th class="n">Expenses</th><th class="n">Diesel</th><th class="n">Rent (net)</th><th class="n">Commission</th><th class="n">Total cost</th><th class="n">Paid out</th><th class="n">Machine hrs</th></tr></thead><tbody>
    ${ss.map(x => `<tr data-act="pickSite" data-id="${esc(x.s.id)}">${td('Site', `<span class="main">${esc(x.s.name)}</span><span class="sub">${esc([x.s.place, x.s.kind].filter(Boolean).join(' · '))}</span>`, 'c1')}${td('Expenses', inr(x.e), 'n')}${td('Diesel', inr(x.d), 'n')}${td('Rent (net)', inr(x.b), 'n')}${td('Commission', inr(x.c), 'n')}${td('Total cost', inr(x.total), 'n main')}${td('Paid out', inr(x.paid), 'n')}${td('Machine hrs', qty(x.hrs, 0), 'n')}</tr>`).join('')}
    </tbody><tfoot><tr>${td('', 'Total', 'c1')}${td('Expenses', inr(sum(ss, x => x.e)), 'n')}${td('Diesel', inr(sum(ss, x => x.d)), 'n')}${td('Rent (net)', inr(sum(ss, x => x.b)), 'n')}${td('Commission', inr(sum(ss, x => x.c)), 'n')}${td('Total cost', inr(sum(ss, x => x.total)), 'n')}${td('Paid out', inr(sum(ss, x => x.paid)), 'n')}${td('Machine hrs', qty(sum(ss, x => x.hrs), 0), 'n')}</tr></tfoot></table>` : '<div class="empty">No costs in this period.</div>'}</div></section>
  <div class="grid2">
    <section class="card"><div class="card-h"><h2>Head-wise cost</h2></div><div class="tbl">${hd.length ? `<table class="rt"><thead><tr><th>Head</th><th class="n">Amount</th><th class="n">Share</th></tr></thead><tbody>${hd.map(h => `<tr>${td('Head', esc(h.label), 'c1')}${td('Amount', inr(h.value), 'n main')}${td('Share', qty(h.value / tot * 100, 1) + '%', 'n')}</tr>`).join('')}</tbody><tfoot><tr>${td('', 'Total', 'c1')}${td('Amount', inr(tot), 'n')}${td('Share', '100%', 'n')}</tr></tfoot></table>` : '<div class="empty">No costs in this period.</div>'}</div></section>
    <section class="card"><div class="card-h"><h2>Month-wise cost</h2></div><div class="tbl">${months.length ? `<table class="rt"><thead><tr><th>Month</th><th class="n">Expenses</th><th class="n">Diesel</th><th class="n">Rent (net)</th><th class="n">Total</th></tr></thead><tbody>${months.map(o => `<tr>${td('Month', monthLabel(o.m), 'c1')}${td('Expenses', inr(o.e), 'n')}${td('Diesel', inr(o.d), 'n')}${td('Rent', inr(o.b), 'n')}${td('Total', inr(o.e + o.d + o.b), 'n main')}</tr>`).join('')}</tbody></table>` : '<div class="empty">No costs in this period.</div>'}</div></section>
  </div>`;
}

/* ----- Setup ----- */
function pgSetup() {
  if (!isAdmin()) return '<div class="empty">Only the admin can change Setup.</div>';
  const s = DB.settings;
  const sites = DB.sites.slice().sort((a, b) => (a.status === 'Completed') - (b.status === 'Completed'));
  return `<div class="grid2">
  <section class="card"><div class="card-h"><h2>Sites</h2><button class="btn sm primary" data-act="add" data-id="site">${svg('plus')}Add site</button></div><div class="card-b"><div class="setup-list">
    ${sites.map(x => `<div class="row"><div class="t"><b>${esc(x.name)}</b><span>${esc([x.place, x.kind, x.status === 'Completed' ? 'Completed' : ''].filter(Boolean).join(' · '))}</span></div><button class="btn sm" data-act="editSite" data-id="${esc(x.id)}">Edit</button></div>`).join('') || '<div class="muted">No sites yet.</div>'}
  </div></div></section>
  <section class="card"><div class="card-h"><h2>People who pay</h2><button class="btn sm primary" data-act="add" data-id="person">${svg('plus')}Add person</button></div><div class="card-b"><p class="muted sm" style="margin-top:0">Cash holders get money in advance and keep a running balance. Others only record what they paid.</p><div class="setup-list">
    ${DB.people.map(p => `<div class="row"><div class="t"><b>${esc(p.name)}</b><span>${p.cash ? 'Holds cash · balance tracked' : 'Pays directly'}</span></div><button class="btn sm" data-act="editPerson" data-id="${esc(p.id)}">Edit</button></div>`).join('')}
  </div></div></section>
  <section class="card"><div class="card-h"><h2>Expense heads</h2><button class="btn sm primary" data-act="add" data-id="cat">${svg('plus')}Add head</button></div><div class="card-b"><div class="setup-list">
    ${DB.cats.map(c => { const n = DB.exp.filter(r => r.cat === c.name).length; return `<div class="row"><div class="t"><b>${esc(c.name)}</b><span>${n} entries${c.unit ? ' · unit ' + esc(c.unit) : ''}</span></div><button class="btn sm" data-act="editCat" data-id="${esc(c.id)}">Edit</button></div>`; }).join('')}
  </div></div></section>
  <section class="card"><div class="card-h"><h2>Machine types & rent basis</h2><button class="btn sm primary" data-act="add" data-id="type">${svg('plus')}Add type</button></div><div class="card-b"><div class="setup-list">
    ${s.types.map((t, i) => `<div class="row"><div class="t"><b>${esc(t.type)}</b><span>${t.basis === 'Daily' ? 'Billed per day worked · ' + t.units + '-day package' : 'Billed per hour · ' + t.units + '-hour package'}</span></div><button class="btn sm" data-act="editType" data-id="${i}">Edit</button></div>`).join('')}
  </div></div></section>
  <section class="card"><div class="card-h"><h2>Bills & payments</h2><button class="btn sm" data-act="editSettings">Edit</button></div><div class="card-b"><dl class="kv">
    <dt>Company</dt><dd>${esc(s.company)}</dd><dt>Commission party</dt><dd>${esc(s.commParty)}</dd><dt>Default commission</dt><dd>${num(s.commPct)}% of each rent bill</dd>
    <dt>Next bill no.</dt><dd>${esc(s.billPrefix)}${String(s.billNext).padStart(3, '0')}</dd><dt>Payment modes</dt><dd>${esc(s.modes.join(', '))}</dd></dl></div></section>
  <section class="card" id="import"><div class="card-h"><h2>Import & backup</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:14px">
    <div><b>Excel workbook</b><p class="muted sm" style="margin:4px 0 8px">Reads your “Machine and Diesel management”, “Plot Site Expense Tracker” and similar sheets: diesel purchase, machine log, machine master and every “… Expense” sheet. Entries already here are skipped.</p>
      <label class="btn file-btn">${svg('up')}Choose .xlsx file<input type="file" accept=".xlsx,.xls,.xlsm,.csv" data-file="xlsx"></label></div>
    <div><b>Site Manager app backup</b><p class="muted sm" style="margin:4px 0 8px">The .json backup from your Veershree Site Manager app: machines, machine log, diesel, expenses, murum, vendor and owner payments, rent bills and manager money.</p>
      <label class="btn file-btn">${svg('up')}Choose .json file<input type="file" accept=".json,application/json" data-file="json"></label></div>
    <div><b>Backup (.json)</b><p class="muted sm" style="margin:4px 0 8px">Save everything to one file. "Import backup" reads a backup of this app <b>or of the old app</b>, uploads it with the same IDs and fields, and then shows a check screen comparing every total.</p>
      <div class="toolbar"><button class="btn" data-act="backup">${svg('dl')}Save backup</button><label class="btn file-btn">${svg('up')}Import backup<input type="file" accept=".json,application/json" data-file="restore"></label><label class="btn file-btn">Check against a backup<input type="file" accept=".json,application/json" data-file="check"></label></div></div>
  </div></section>
  </div>
  <section class="card"><div class="card-h"><h2>Where your data is kept</h2></div><div class="card-b"><p style="margin:0">Entries are saved online in your own Firebase database, and each phone keeps a full copy so the app works without network on site. Deleted entries are kept (Recycle Bin), never removed.</p>
    <div class="toolbar" style="margin-top:12px"><button class="btn" data-act="nav" data-id="users">${svg('party')}Users & roles</button><button class="btn danger" data-act="clearAll">Delete all entries…</button></div></div></section>`;
}

/* ================= MODAL & FORMS ================= */
let MODAL = null;
function openModal(o) {
  const A = o.access || { mode: 'edit' };
  if (A.mode === 'view') { o.onSubmit = null; o.again = false; o.del = null; }
  if (A.mode !== 'edit') { o.again = false; o.del = null; }
  if (!isAdmin()) o.del = null;
  MODAL = o;
  const m = $('#modal');
  const note = A.mode !== 'edit' && A.why ? `<div class="banner">${esc(A.why)}</div>` : '';
  const appr = o.rec && isAdmin() && o.rec._appr === 'pending' && o.coll ? `<button type="button" class="btn primary" data-act="approve" data-id="${esc(o.rec.id)}" data-v="${o.coll}">Approve</button>` : '';
  m.innerHTML = `<form class="dlg ${o.size || ''}" id="mform" novalidate role="dialog" aria-modal="true" aria-labelledby="mtitle">
    <div class="dlg-h"><h2 id="mtitle">${esc(o.title)}</h2><button type="button" class="icon-btn" data-act="closeModal" aria-label="Close">${svg('x')}</button></div>
    <div class="dlg-b">${o.rec && o.coll ? apprLine(o.coll, o.rec) : ''}${note}${o.body}</div>
    ${o.foot === false ? '' : `<div class="dlg-f">${o.del ? `<button type="button" class="btn danger left" data-act="mdel">Delete</button>` : ''}${o.extra || ''}<button type="button" class="btn ghost" data-act="closeModal">${o.onSubmit ? 'Cancel' : 'Close'}</button>${o.again ? '<button type="button" class="btn" data-act="saveAgain">Save & add another</button>' : ''}${appr}${o.onSubmit ? `<button type="submit" class="btn ${appr ? '' : 'primary'}" value="save">${esc(o.saveLabel || 'Save')}</button>` : ''}</div>`}
  </form>`;
  if (A.mode === 'view' || A.mode === 'pay') $$('.dlg-b input, .dlg-b select, .dlg-b textarea, .dlg-b .ln button, .dlg-b .toolbar button', m).forEach(el => { if (A.mode === 'pay' && ['status', 'paidBy', 'mode'].includes(el.name)) return; el.disabled = true; });
  m.hidden = false;
  document.body.style.overflow = 'hidden';
  const f = $('#mform');
  f.addEventListener('submit', e => {
    e.preventDefault();
    if (!o.onSubmit) return;
    const again = !!f._again; f._again = false;
    const v = Object.fromEntries(new FormData(f).entries());
    $$('input[type=checkbox]', f).forEach(c => { if (c.name) v[c.name] = c.checked; });
    const res = o.onSubmit(v, again, f);
    if (res === false) return;
    if (!again && MODAL === o) closeModal();
    render();
  });
  f.addEventListener('input', e => o.onInput && o.onInput(e, f));
  f.addEventListener('change', e => o.onChange && o.onChange(e, f));
  if (o.onOpen) o.onOpen(f);
  setTimeout(() => { const first = f.querySelector('[autofocus]') || f.querySelector('.dlg-b input:not([type=hidden]):not([readonly]),.dlg-b select'); if (first && window.innerWidth > 640) first.focus(); }, 30);
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; MODAL = null; document.body.style.overflow = ''; }
function confirmBox(msg, { ok = 'Delete', danger = true, title = 'Please confirm' } = {}) {
  return new Promise(res => {
    const prev = MODAL;
    openModal({ title, size: 'narrow', body: `<p style="margin:0">${msg}</p>`, foot: false });
    $('#mform').insertAdjacentHTML('beforeend', `<div class="dlg-f"><button type="button" class="btn ghost" id="cfNo">Cancel</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" id="cfOk">${esc(ok)}</button></div>`);
    $('#cfNo').onclick = () => { closeModal(); res(false); };
    $('#cfOk').onclick = () => { closeModal(); res(true); };
    MODAL.onCloseX = () => res(false);
    void prev;
  });
}
function toast(msg) {
  const t = $('#toast'); const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; t.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied. Paste it in WhatsApp.'); }
  catch (e) {
    openModal({ title: 'Copy this text', body: `<textarea class="inp" id="cpTxt" style="height:260px;padding:10px" readonly>${esc(t)}</textarea><p class="muted sm">Select all and copy.</p>` });
    setTimeout(() => { const a = $('#cpTxt'); if (a) { a.focus(); a.select(); } }, 50);
  }
}

/* --- field builders --- */
const fld = (label, input, cls = '') => `<label class="fld ${cls}"><span>${label}</span>${input}</label>`;
const inp = (name, val, attrs = '') => `<input name="${name}" id="f_${name}" value="${esc(val == null ? '' : val)}" ${attrs}>`;
const numInp = (name, val, attrs = '') => inp(name, val, `inputmode="decimal" autocomplete="off" ${attrs}`);
const sel = (name, opts, val, attrs = '') => `<select name="${name}" id="f_${name}" ${attrs}>${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(val ?? '') ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
const seg = (name, opts, val) => `<div class="seg" role="radiogroup">${opts.map(o => `<label><input type="radio" name="${name}" value="${esc(o)}"${o === val ? ' checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
const siteOpts = (cur) => DB.sites.filter(s => s.status !== 'Completed' || s.id === cur).map(s => [s.id, s.name + (s.place ? ' · ' + s.place : '')]);
const selSite = (name, cur) => sel(name, siteOpts(cur), cur, 'required');
const peopleOpts = cur => { const l = payerNames(); if (cur && !l.some(x => norm(x) === norm(cur))) l.push(cur); return [['', '—'], ...l]; };
const modeOpts = cur => { const l = DB.settings.modes.slice(); if (cur && !l.includes(cur)) l.push(cur); return [['', '—'], ...l]; };
const dateInp = (name, v) => `<input type="date" name="${name}" id="f_${name}" value="${esc(v || '')}" required>`;
const payFields = r => `${fld('Paid by', sel('paidBy', peopleOpts(r.paidBy), r.paidBy), 'payonly')}${fld('Mode', sel('mode', modeOpts(r.mode), r.mode), 'payonly')}`;
function togglePay(f) { const unpaid = (f.querySelector('input[name=status]:checked') || {}).value === 'Unpaid'; $$('.payonly', f).forEach(el => el.hidden = unpaid); }
function needSite() { if (!DB.sites.length) { if (isAdmin()) { toast('Add a site first in Setup'); go('setup'); } else toast(isMgr() ? 'No site is assigned to you yet. Ask the admin.' : 'No sites yet.'); return true; } return false; }
const req = (cond, msg) => { if (!cond) { toast(msg); return false; } return true; };

/* --- expense --- */
function formExp(rec, preset) {
  if (needSite()) return;
  const r = rec ? { ...rec } : Object.assign({ id: uid(), site: defSite(), date: today(), cat: UI.lastCat || (DB.cats[0] || {}).name || '', status: 'Paid', paidBy: UI.lastPayer, mode: UI.lastMode }, preset || {});
  const cats = uniq([...DB.cats.map(c => c.name), r.cat]);
  const A = access('exp', rec); if (A.mode === 'none') { toast(A.why); return; }
  openModal({
    title: rec ? (A.mode === 'view' ? 'Expense' : 'Edit expense') : 'New expense', again: !rec, access: A, rec, coll: 'exp',
    body: `<div class="fgrid">
      ${fld('Site', selSite('site', r.site))}${fld('Date', dateInp('date', r.date))}
      ${fld('Head', sel('cat', cats, r.cat))}${fld('Vendor / party', inp('vendor', r.vendor, 'list="dl_v" autocomplete="off" placeholder="e.g. Daware"'))}
      ${fld('Work / description', inp('desc', r.desc, 'placeholder="e.g. Murum – 19 trips"'), 'span2')}
      ${fld('Quantity', numInp('qty', r.qty))}${fld('Unit', inp('unit', r.unit, 'list="dl_u" autocomplete="off"'))}
      ${fld('Rate (₹)', numInp('rate', r.rate))}${fld('Amount (₹)', numInp('amount', r.amount, 'required'))}
      ${fld('Payment', seg('status', ['Paid', 'Unpaid'], r.status || 'Paid'))}${payFields(r)}
      ${fld('Bill / voucher no.', inp('bill', r.bill))}${fld('Plot / phase', inp('plot', r.plot, 'placeholder="e.g. Phase 2 – plot 1"'))}
      ${fld('Remark', inp('remark', r.remark), 'span2')}
    </div>${dl('dl_v', vendorNames())}${dl('dl_u', unitNames())}`,
    del: rec ? async () => { if (await confirmBox('Delete this expense of ' + inr(r.amount) + '?')) { removeRow('exp', r.id); render(); toast('Expense deleted'); } else formExp(rec); } : null,
    onOpen: f => { togglePay(f); f.dataset.amtManual = rec && has(rec.amount) && !(has(rec.qty) && has(rec.rate)) ? '1' : ''; },
    onInput: (e, f) => {
      const n = e.target.name;
      if (n === 'status') togglePay(f);
      if (n === 'amount') f.dataset.amtManual = e.target.value ? '1' : '';
      if ((n === 'qty' || n === 'rate') && !f.dataset.amtManual) { const q = num(f.qty.value), rt = num(f.rate.value); if (q && rt) f.amount.value = rnd(q * rt, 2); }
      if (n === 'cat') { const c = DB.cats.find(c => c.name === e.target.value); if (c && c.unit && !f.unit.value) f.unit.value = c.unit; }
    },
    onSubmit: (v, again) => {
      if (A.mode === 'pay') { patchRow('exp', rec, payPatch(v)); toast('Payment updated'); return; }
      if (!req(v.site, 'Choose a site') || !req(isDate(v.date), 'Enter the date') || !req(num(v.amount) || v.desc, 'Enter the amount')) return false;
      const o = { ...r, site: v.site, date: v.date, cat: v.cat, vendor: v.vendor.trim(), desc: v.desc.trim(), qty: nv(v.qty), unit: v.unit.trim(), rate: nv(v.rate), amount: nv(v.amount),
        status: v.status || 'Paid', paidBy: v.status === 'Unpaid' ? '' : v.paidBy, mode: v.status === 'Unpaid' ? '' : v.mode, bill: v.bill.trim(), plot: v.plot.trim(), remark: v.remark.trim() };
      upsert('exp', o);
      Object.assign(UI, { lastSite: o.site, lastCat: o.cat, lastPayer: o.paidBy || UI.lastPayer, lastMode: o.mode || UI.lastMode }); saveUI();
      toast(rec ? 'Expense updated' : 'Expense saved');
      if (again) { formExp(null, { site: o.site, date: o.date, cat: o.cat, status: o.status, paidBy: o.paidBy, mode: o.mode }); render(); return false; }
    }
  });
}

/* --- machine log (single) --- */
function siteMachines(site, includeId) { return DB.machines.filter(m => m.site === site && (!m.removed || m.id === includeId)).sort((a, b) => (TYPE_ORDER(a.type) - TYPE_ORDER(b.type)) || natCmp(a.no, b.no)); }
function lastReading(site, mno, before) {
  const k = mkey(mno); let best = null;
  for (const r of DB.mlog) if (r.site === site && mkey(r.mno) === k && has(r.outR) && (!before || String(r.date) < before)) { if (!best || String(r.date) > String(best.date) || (r.date === best.date && num(r.outR) > num(best.outR))) best = r; }
  return best;
}
function formMlog(rec, preset) {
  if (needSite()) return;
  const r = rec ? { ...rec } : Object.assign({ id: uid(), site: defSite(), date: today(), attach: 'Bucket' }, preset || {});
  const A = access('mlog', rec); if (A.mode === 'none') { toast(A.why); return; }
  const mOpts = site => { const l = siteMachines(site).map(m => [m.no, m.no + ' · ' + m.type + (m.owner ? ' · ' + m.owner : '')]); if (r.mno && !l.some(x => mkey(x[0]) === mkey(r.mno))) l.unshift([r.mno, r.mno + ' (not in list)']); return l.length ? l : [['', 'No machines – add in Machine list']]; };
  openModal({
    title: rec ? (A.mode === 'view' ? 'Machine entry' : 'Edit machine entry') : 'New machine entry', again: !rec, access: A, rec, coll: 'mlog',
    body: `<div class="fgrid">
      ${fld('Site', selSite('site', r.site))}${fld('Date', dateInp('date', r.date))}
      ${fld('Machine', sel('mno', mOpts(r.site), r.mno))}${fld('Driver', inp('driver', r.driver, 'list="dl_d" autocomplete="off"'))}
      ${fld('Worked with', seg('attach', ATTACH, r.attach || 'None'), 'span2')}
      ${fld('In reading (hour meter)', numInp('inR', r.inR))}${fld('Out reading', numInp('outR', r.outR))}
      ${fld('Hours <span class="hint">· auto from readings</span>', numInp('hrs', has(r.inR) && has(r.outR) ? rnd(hrsOf(r), 2) : r.hrs))}${fld('Diesel filled (L)', numInp('diesel', r.diesel))}
      ${fld('Remark', inp('remark', r.remark), 'span2')}
    </div><p class="muted sm" id="lastRd" style="margin:10px 0 0"></p>${dl('dl_d', driverNames())}`,
    del: rec ? async () => { if (await confirmBox('Delete this entry for ' + esc(r.mno) + ' on ' + fmtD(r.date) + '?')) { removeRow('mlog', r.id); render(); toast('Entry deleted'); } else formMlog(rec); } : null,
    onOpen: f => { fillLast(f); },
    onSubmit: (v, again) => {
      if (!req(v.site, 'Choose a site') || !req(isDate(v.date), 'Enter the date') || !req(v.mno, 'Choose the machine')) return false;
      if (has(v.inR) && has(v.outR) && num(v.outR) < num(v.inR)) { toast('Out reading is lower than in reading'); return false; }
      const o = { ...r, site: v.site, date: v.date, mno: v.mno, driver: v.driver.trim(), attach: v.attach === 'None' ? '' : v.attach, inR: nv(v.inR), outR: nv(v.outR),
        hrs: has(v.inR) && has(v.outR) ? '' : nv(v.hrs), diesel: nv(v.diesel), remark: v.remark.trim() };
      upsert('mlog', o); UI.lastSite = o.site; saveUI();
      toast(rec ? 'Entry updated' : 'Entry saved');
      if (again) { formMlog(null, { site: o.site, date: o.date, attach: v.attach }); render(); return false; }
    },
    onInput: (e, f) => {
      const n = e.target.name;
      if (n === 'inR' || n === 'outR') { if (has(f.inR.value) && has(f.outR.value)) { f.hrs.value = rnd(Math.max(0, num(f.outR.value) - num(f.inR.value)), 2); f.hrs.readOnly = true; } else f.hrs.readOnly = false; }
    },
    onChange: (e, f) => {
      const n = e.target.name;
      if (n === 'site') { f.mno.innerHTML = mOpts(f.site.value).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); }
      if (n === 'site' || n === 'mno' || n === 'date') fillLast(f);
    }
  });
  function fillLast(f) {
    const lr = f.mno.value ? lastReading(f.site.value, f.mno.value, f.date.value) : null;
    const m = MIDX.get(f.site.value + '|' + mkey(f.mno.value));
    $('#lastRd').textContent = lr ? `Last out reading: ${qty(lr.outR, 1)} on ${fmtD(lr.date)}${lr.driver ? ' · driver ' + lr.driver : ''}` : (f.mno.value ? 'No earlier reading for this machine.' : '');
    if (!rec) { if (lr && !f.inR.value) f.inR.value = lr.outR; if (!f.driver.value) f.driver.value = (lr && lr.driver) || (m && m.operator) || ''; }
    f.hrs.readOnly = has(f.inR.value) && has(f.outR.value);
  }
}

/* --- machine daily sheet (bulk) --- */
function formBulk(site, date) {
  if (needSite()) return;
  site = site || defSite(); date = date || today();
  const ms = siteMachines(site);
  const existing = new Map(DB.mlog.filter(r => r.site === site && r.date === date).map(r => [mkey(r.mno), r]));
  const rowsHtml = ms.map((m, i) => {
    const e = existing.get(mkey(m.no)); const lr = lastReading(site, m.no, date);
    const inV = e ? e.inR : (lr ? lr.outR : '');
    return `<div class="ds-row${e ? ' filled' : ''}" data-i="${i}">
      <div class="m"><b>${esc(m.no)}</b><span>${esc([m.type, m.owner].filter(Boolean).join(' · '))}</span></div>
      <label class="dsf"><span>Driver</span><input class="inp" name="dr_${i}" value="${esc(e ? e.driver : ((lr && lr.driver) || m.operator || ''))}" list="dl_d" aria-label="Driver for ${esc(m.no)}"></label>
      <label class="dsf"><span>Worked with</span><select class="inp" name="at_${i}" aria-label="Worked with">${ATTACH.map(a => `<option${(e ? (e.attach || 'None') : 'Bucket') === a ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
      <label class="dsf"><span>In reading</span><input class="inp" name="in_${i}" value="${esc(inV)}" inputmode="decimal" aria-label="In reading"></label>
      <label class="dsf"><span>Out reading</span><input class="inp" name="out_${i}" value="${esc(e ? e.outR : '')}" inputmode="decimal" aria-label="Out reading"></label>
      <span class="h" id="h_${i}">${e ? qty(hrsOf(e), 1) : '–'}</span>
      <label class="dsf"><span>Diesel L</span><input class="inp" name="ds_${i}" value="${esc(e ? e.diesel : '')}" inputmode="decimal" aria-label="Diesel litres"></label>
      <label class="dsf"><span>Remark</span><input class="inp" name="rm_${i}" value="${esc(e ? e.remark : '')}" aria-label="Remark"></label>
    </div>`;
  }).join('');
  openModal({
    title: 'Machine daily sheet', size: 'wide', saveLabel: 'Save sheet',
    body: `<div class="toolbar" style="margin-bottom:12px"><label class="fld" style="flex:1 1 220px"><span>Site</span>${selSite('bsite', site)}</label><label class="fld" style="flex:0 1 180px"><span>Date</span>${dateInp('bdate', date)}</label>
      <p class="muted sm" style="flex:1 1 260px;margin:18px 0 0">In reading is filled from yesterday's out reading. Rows with an out reading, hours or diesel are saved. Highlighted rows are already saved for this day.</p></div>
      ${ms.length ? `<div class="ds"><div class="ds-row head"><span>Machine</span><span>Driver</span><span>Worked with</span><span>In</span><span>Out</span><span style="text-align:right">Hrs</span><span>Diesel L</span><span>Remark</span></div>${rowsHtml}</div>` : '<div class="empty">No machines on this site. Add them under Machines → Machine list.</div>'}
      ${dl('dl_d', driverNames())}`,
    onInput: (e, f) => {
      const m = e.target.name && e.target.name.match(/^(in|out)_(\d+)$/);
      if (m) { const i = m[2], a = f['in_' + i].value, b = f['out_' + i].value; $('#h_' + i).textContent = has(a) && has(b) ? qty(Math.max(0, num(b) - num(a)), 1) : '–'; }
    },
    onChange: (e, f) => { if (e.target.name === 'bsite' || e.target.name === 'bdate') formBulk(f.bsite.value, f.bdate.value); },
    onSubmit: v => {
      let made = 0, upd = 0, bad = 0; const add = [], changed = [];
      ms.forEach((m, i) => {
        const inR = v['in_' + i], outR = v['out_' + i], ds = v['ds_' + i], rm = (v['rm_' + i] || '').trim(), dr = (v['dr_' + i] || '').trim(), at = v['at_' + i];
        const e = existing.get(mkey(m.no));
        if (has(inR) && has(outR) && num(outR) < num(inR)) { bad++; return; }
        const hasWork = has(outR) || has(ds) || rm;
        if (!e && !hasWork) return;
        const o = { ...(e || { id: uid() }), site, date, mno: m.no, driver: dr, attach: at === 'None' ? '' : at, inR: nv(inR), outR: nv(outR), hrs: e && !(has(inR) && has(outR)) ? e.hrs : '', diesel: nv(ds), remark: rm };
        if (e) { if (access('mlog', e).mode !== 'edit') return; changed.push(o); upd++; } else { add.push(o); made++; }
      });
      if (bad) { toast(bad + ' machine(s) have out reading lower than in reading. Fix them and save again.'); return false; }
      if (made || upd) writeRows('mlog', [...changed, ...add]);
      UI.lastSite = site; saveUI();
      toast(made || upd ? `Saved ${made} new and ${upd} updated entries` : 'Nothing to save');
    }
  });
}

/* --- diesel --- */
function formDsl(rec, preset) {
  if (needSite()) return;
  const r = rec ? { ...rec } : Object.assign({ id: uid(), site: defSite(), date: today(), status: 'Paid', paidBy: UI.lastPayer, mode: 'Online' }, preset || {});
  const A = access('dsl', rec); if (A.mode === 'none') { toast(A.why); return; }
  openModal({
    title: rec ? (A.mode === 'view' ? 'Diesel bill' : 'Edit diesel bill') : 'New diesel bill', again: !rec, access: A, rec, coll: 'dsl',
    body: `<div class="fgrid">
      ${fld('Site', selSite('site', r.site))}${fld('Date', dateInp('date', r.date))}
      ${fld('Pump / vendor', inp('vendor', r.vendor, 'list="dl_p" autocomplete="off" required'))}${fld('Bill no.', inp('bill', r.bill))}
      ${fld('Litres', numInp('litres', r.litres, 'required'))}${fld('Rate per litre (₹)', numInp('rate', num(r.litres) && num(r.amount) ? rnd(r.amount / r.litres, 2) : r.rate))}
      ${fld('Amount (₹)', numInp('amount', r.amount))}${fld('Payment', seg('status', ['Paid', 'Unpaid'], r.status || 'Paid'))}
      ${payFields(r)}${fld('Remark', inp('remark', r.remark), 'span2')}
    </div>${dl('dl_p', pumpNames())}`,
    del: rec ? async () => { if (await confirmBox('Delete this diesel bill of ' + inr(r.amount) + '?')) { removeRow('dsl', r.id); render(); toast('Diesel bill deleted'); } else formDsl(rec); } : null,
    onOpen: f => togglePay(f),
    onInput: (e, f) => {
      const n = e.target.name;
      if (n === 'status') togglePay(f);
      if (n === 'amount') f.dataset.amt = e.target.value ? '1' : '';
      if ((n === 'litres' || n === 'rate') && !f.dataset.amt) { const l = num(f.litres.value), rt = num(f.rate.value); if (l && rt) f.amount.value = Math.round(l * rt); }
      if (n === 'amount' && num(f.litres.value) && num(f.amount.value)) f.rate.value = rnd(num(f.amount.value) / num(f.litres.value), 2);
    },
    onSubmit: (v, again) => {
      if (A.mode === 'pay') { patchRow('dsl', rec, payPatch(v)); toast('Payment updated'); return; }
      if (!req(v.site, 'Choose a site') || !req(isDate(v.date), 'Enter the date') || !req(v.vendor.trim(), 'Enter the pump name') || !req(num(v.litres), 'Enter litres')) return false;
      const amt = has(v.amount) ? num(v.amount) : (num(v.rate) ? Math.round(num(v.rate) * num(v.litres)) : '');
      const o = { ...r, site: v.site, date: v.date, vendor: v.vendor.trim(), bill: v.bill.trim(), litres: nv(v.litres), amount: amt, rate: '',
        status: v.status || 'Paid', paidBy: v.status === 'Unpaid' ? '' : v.paidBy, mode: v.status === 'Unpaid' ? '' : v.mode, remark: v.remark.trim() };
      upsert('dsl', o); UI.lastSite = o.site; if (o.paidBy) UI.lastPayer = o.paidBy; saveUI();
      toast(rec ? 'Diesel bill updated' : 'Diesel bill saved');
      if (again) { formDsl(null, { site: o.site, date: o.date, vendor: o.vendor, status: o.status, paidBy: o.paidBy, mode: o.mode }); render(); return false; }
    }
  });
}

/* --- money received --- */
function formFund(rec, preset) {
  const holders = DB.people.filter(p => p.cash).map(p => p.name);
  const r = rec ? { ...rec } : Object.assign({ id: uid(), date: today(), person: isMgr() ? ME.person : (holders.includes(UI.regPerson) ? UI.regPerson : (holders[0] || '')), mode: 'Online' }, preset || {});
  const ppl = isMgr() ? [ME.person] : uniq([...holders, ...DB.people.map(p => p.name), r.person]);
  const A = access('fund', rec); if (A.mode === 'none') { toast(A.why); return; }
  openModal({
    title: rec ? (A.mode === 'view' ? 'Money received' : 'Edit money received') : 'Money received', again: !rec, access: A, rec, coll: 'fund',
    body: `<div class="fgrid">${fld('Date', dateInp('date', r.date))}${fld('Received by', sel('person', ppl, r.person))}
      ${fld('Received from', inp('from', r.from, 'list="dl_f" autocomplete="off" placeholder="e.g. Suhas Sir"'))}${fld('Amount (₹)', numInp('amount', r.amount, 'required'))}
      ${fld('Mode', sel('mode', modeOpts(r.mode), r.mode))}${fld('Remark', inp('remark', r.remark))}</div>${dl('dl_f', uniq([...DB.people.map(p => p.name), ...DB.fund.map(f => f.from), DB.settings.company]))}`,
    del: rec ? async () => { if (await confirmBox('Delete this entry of ' + inr(r.amount) + '?')) { removeRow('fund', r.id); render(); } else formFund(rec); } : null,
    onSubmit: (v, again) => {
      if (!req(isDate(v.date), 'Enter the date') || !req(v.person, 'Choose who received it') || !req(num(v.amount), 'Enter the amount')) return false;
      const o = { ...r, date: v.date, person: v.person, from: v.from.trim(), amount: num(v.amount), mode: v.mode, remark: v.remark.trim() };
      upsert('fund', o); toast(rec ? 'Updated' : 'Money received saved');
      if (again) { formFund(null, { date: o.date, person: o.person }); render(); return false; }
    }
  });
}

/* --- vendor payment --- */
function formVpay(rec, preset) {
  if (needSite()) return;
  const r = rec ? { ...rec } : Object.assign({ id: uid(), site: defSite(), date: today(), paidBy: UI.lastPayer, mode: UI.lastMode }, preset || {});
  const A = access('vpay', rec); if (A.mode === 'none') { toast(A.why); return; }
  openModal({
    title: rec ? (A.mode === 'view' ? 'Vendor payment' : 'Edit vendor payment') : 'Pay a vendor or pump', access: A, rec, coll: 'vpay',
    body: `<div class="fgrid">${fld('Site', selSite('site', r.site))}${fld('Date', dateInp('date', r.date))}
      ${fld('Vendor / pump', inp('vendor', r.vendor, 'list="dl_vp" autocomplete="off" required'))}${fld('Amount (₹)', numInp('amount', r.amount, 'required'))}
      ${fld('Paid by', sel('paidBy', peopleOpts(r.paidBy), r.paidBy))}${fld('Mode', sel('mode', modeOpts(r.mode), r.mode))}
      ${fld('Remark', inp('remark', r.remark), 'span2')}</div><p class="muted sm" id="vdue" style="margin:10px 0 0"></p>${dl('dl_vp', uniq([...vendorNames(), ...pumpNames()]))}`,
    del: rec ? async () => { if (await confirmBox('Delete this payment of ' + inr(r.amount) + '?')) { removeRow('vpay', r.id); render(); } else formVpay(rec); } : null,
    onOpen: f => showDue(f), onInput: (e, f) => { if (e.target.name === 'vendor' || e.target.name === 'site') showDue(f); },
    onSubmit: v => {
      if (!req(v.site, 'Choose a site') || !req(isDate(v.date), 'Enter the date') || !req(v.vendor.trim(), 'Enter the vendor') || !req(num(v.amount), 'Enter the amount')) return false;
      const o = { ...r, site: v.site, date: v.date, vendor: v.vendor.trim(), amount: num(v.amount), paidBy: v.paidBy, mode: v.mode, remark: v.remark.trim() };
      upsert('vpay', o); toast('Payment saved');
      if (MODAL && MODAL.after) { const a = MODAL.after; setTimeout(a, 0); }
    }
  });
  function showDue(f) {
    const k = norm(f.vendor.value); if (!k) { $('#vdue').textContent = ''; return; }
    const saved = UI.site; UI.site = f.site.value; const L = ledgers(); UI.site = saved;
    const x = [...L.V, ...L.P].find(x => x.key === k);
    $('#vdue').textContent = x ? `${x.name} at ${siteName(f.site.value)}: billed ${inr(x.billed)}, paid ${inr(x.paid)}, balance ${inr(x.due)}` : 'New party for this site.';
  }
}

/* --- owner payment --- */
function formOpay(rec, preset) {
  if (needSite()) return;
  const r = rec ? { ...rec } : Object.assign({ id: uid(), site: defSite(), date: today(), paidBy: UI.lastPayer, mode: 'Online' }, preset || {});
  const A = access('opay', rec); if (A.mode === 'none') { toast(A.why); return; }
  const billOpts = (owner, site) => [['', 'Advance / not against a bill'], ...DB.bill.filter(b => b.site === site && (!owner || norm(b.owner) === norm(owner)) && (billDue(b) > 0.5 || b.id === r.billId)).sort(byDateDesc).map(b => [b.id, `${b.no || 'Bill'} · ${fmtDs(b.date)} · due ${inr(billDue(b))}`])];
  openModal({
    title: rec ? (A.mode === 'view' ? 'Owner payment' : 'Edit owner payment') : 'Pay a machine owner', access: A, rec, coll: 'opay',
    body: `<div class="fgrid">${fld('Site', selSite('site', r.site))}${fld('Date', dateInp('date', r.date))}
      ${fld('Machine owner', inp('owner', r.owner, 'list="dl_o" autocomplete="off" required'))}${fld('Against bill', sel('billId', billOpts(r.owner, r.site), r.billId))}
      ${fld('Amount (₹)', numInp('amount', r.amount, 'required'))}${fld('Paid by', sel('paidBy', peopleOpts(r.paidBy), r.paidBy))}
      ${fld('Mode', sel('mode', modeOpts(r.mode), r.mode))}${fld('Remark', inp('remark', r.remark))}</div>${dl('dl_o', ownerNames())}`,
    del: rec ? async () => { if (await confirmBox('Delete this owner payment of ' + inr(r.amount) + '?')) { removeRow('opay', r.id); render(); } else formOpay(rec); } : null,
    onChange: (e, f) => { if (['owner', 'site'].includes(e.target.name)) { const cur = f.billId.value; f.billId.innerHTML = billOpts(f.owner.value, f.site.value).map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join(''); } },
    onSubmit: v => {
      if (!req(v.site, 'Choose a site') || !req(isDate(v.date), 'Enter the date') || !req(v.owner.trim(), 'Enter the owner') || !req(num(v.amount), 'Enter the amount')) return false;
      const o = { ...r, site: v.site, date: v.date, owner: v.owner.trim(), billId: v.billId, amount: num(v.amount), paidBy: v.paidBy, mode: v.mode, remark: v.remark.trim() };
      upsert('opay', o); toast('Owner payment saved');
      if (o.billId) setTimeout(() => viewBill(o.billId), 0);
    }
  });
}

/* --- rent bill --- */
let BF = null;
function formBill(rec) {
  if (needSite()) return;
  const s = DB.settings;
  BF = rec ? JSON.parse(JSON.stringify(rec)) : { id: uid(), site: defSite(), date: today(), owner: '', from: '', to: '', lines: [], commPct: num(s.commPct), comm: 0, deduct: '', deductNote: '', note: '', no: s.billPrefix + String(s.billNext).padStart(3, '0') };
  if (rec && !has(BF.commPct)) BF.commPct = billTotal(rec) ? rnd(num(rec.comm) / billTotal(rec) * 100, 2) : 0;
  const owners = site => uniq(DB.machines.filter(m => m.site === site).map(m => m.owner));
  const A = access('bill', rec); if (A.mode === 'none') { toast(A.why); return; }
  if (!rec && !isAdmin()) BF.no = nextBillNo();
  openModal({
    title: rec ? 'Edit rent bill' : 'New rent bill', size: 'wide', saveLabel: 'Save bill', access: A, rec, coll: 'bill',
    body: `<div class="fgrid">${fld('Site', selSite('site', BF.site))}${fld('Machine owner', inp('owner', BF.owner, 'list="dl_ob" autocomplete="off" required'))}
      ${fld('Period from', `<input type="date" name="from" id="f_from" value="${esc(BF.from)}">`)}${fld('Period to', `<input type="date" name="to" id="f_to" value="${esc(BF.to)}">`)}
      ${fld('Bill no.', inp('no', BF.no))}${fld('Bill date', dateInp('date', BF.date))}</div>
      <div class="toolbar" style="margin:14px 0 10px"><button type="button" class="btn" data-act="billFill">Work out from machine log</button><button type="button" class="btn ghost" data-act="billLine">${svg('plus')}Add line</button><span class="muted sm" id="billMsg"></span></div>
      <div id="billLines"></div>
      <div class="fgrid" style="margin-top:14px">${fld(`Commission % <span class="hint">· ${esc(s.commParty)}</span>`, numInp('commPct', BF.commPct))}${fld('Commission (₹)', numInp('comm', BF.comm))}
        ${fld('Other deduction (₹)', numInp('deduct', BF.deduct))}${fld('Deduction note', inp('deductNote', BF.deductNote, 'placeholder="e.g. advance given"'))}${fld('Note', inp('note', BF.note), 'span2')}</div>
      <div class="totals" id="billTot"></div>${dl('dl_ob', owners(BF.site))}`,
    del: rec ? async () => {
      const n = DB.opay.filter(p => p.billId === rec.id).length;
      if (await confirmBox(`Delete bill ${esc(rec.no || '')}?${n ? ` Its ${n} payment(s) stay as advances to the owner.` : ''}`)) {
        DB.opay.filter(p => p.billId === rec.id).forEach(p => upsert('opay', { ...p, billId: '' }));
        removeRow('bill', rec.id); render(); toast('Bill deleted');
      } else formBill(rec);
    } : null,
    onOpen: () => drawLines(),
    onInput: (e, f) => {
      const t = e.target, n = t.name;
      if (t.dataset.li != null) {
        const L = BF.lines[+t.dataset.li]; L[t.dataset.k] = t.value;
        if (t.dataset.k === 'units' || t.dataset.k === 'rate') { L.amount = has(L.units) && has(L.rate) ? Math.round(num(L.units) * num(L.rate)) : L.amount; const a = $(`[data-li="${t.dataset.li}"][data-k="amount"]`); if (a) a.value = L.amount; }
        recomputeComm(f); drawTotals(); return;
      }
      if (['site', 'owner', 'from', 'to', 'no', 'date', 'deductNote', 'note'].includes(n)) BF[n] = t.value;
      if (n === 'commPct') { BF.commPct = t.value; recomputeComm(f); }
      if (n === 'comm') { BF.comm = t.value; BF.commPct = billTotal(BF) ? rnd(num(t.value) / billTotal(BF) * 100, 2) : BF.commPct; f.commPct.value = BF.commPct; }
      if (n === 'deduct') BF.deduct = t.value;
      drawTotals();
    },
    onChange: (e, f) => { if (e.target.name === 'site') { BF.site = e.target.value; $('#dl_ob').innerHTML = owners(BF.site).map(o => `<option value="${esc(o)}"></option>`).join(''); } },
    onSubmit: v => {
      if (!req(BF.site, 'Choose a site') || !req(BF.owner.trim(), 'Enter the machine owner') || !req(BF.lines.length, 'Add at least one line')) return false;
      const o = { ...BF, owner: BF.owner.trim(), comm: Math.round(num(BF.comm)), commPct: nv(BF.commPct), deduct: nv(BF.deduct),
        lines: BF.lines.map(l => ({ mno: String(l.mno || '').trim(), basis: l.basis, units: nv(l.units), rate: nv(l.rate), amount: Math.round(num(l.amount)) })) };
      if (!rec && isAdmin()) { s.billNext = Math.max(num(s.billNext), billNoNum(o.no)) + 1; saveMeta(); }
      upsert('bill', o); toast(rec ? 'Bill updated' : 'Bill saved');
      setTimeout(() => viewBill(o.id), 0);
    }
  });
  function recomputeComm(f) { if (has(BF.commPct)) { BF.comm = Math.round(billTotal(BF) * num(BF.commPct) / 100); if (f.comm) f.comm.value = BF.comm; } }
}
/* managers cannot change the bill counter in Setup, so their bill number is worked out from existing bills */
const billNoNum = no => { const m = String(no || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
function nextBillNo() { const s = DB.settings; const n = Math.max(num(s.billNext), ...DB.bill.map(b => billNoNum(b.no) + 1)); return s.billPrefix + String(n).padStart(3, '0'); }
const payPatch = v => ({ status: v.status || 'Paid', paidBy: v.status === 'Unpaid' ? '' : (v.paidBy || ''), mode: v.status === 'Unpaid' ? '' : (v.mode || '') });
function drawLines() {
  const box = $('#billLines'); if (!box) return;
  box.innerHTML = BF.lines.length ? `<div class="lines"><div class="ln head"><span>Machine</span><span>Basis</span><span>Hours / days</span><span>Rate (₹)</span><span>Amount (₹)</span><span></span></div>
    ${BF.lines.map((l, i) => `<div class="ln"><input class="inp" data-li="${i}" data-k="mno" value="${esc(l.mno)}" placeholder="Machine / work" aria-label="Machine">
      <select class="inp" data-li="${i}" data-k="basis" aria-label="Basis"><option${l.basis !== 'Daily' ? ' selected' : ''} value="Hourly">Per hour</option><option${l.basis === 'Daily' ? ' selected' : ''} value="Daily">Per day</option></select>
      <input class="inp" data-li="${i}" data-k="units" value="${esc(l.units)}" inputmode="decimal" aria-label="Hours or days"><input class="inp" data-li="${i}" data-k="rate" value="${esc(l.rate)}" inputmode="decimal" aria-label="Rate">
      <input class="inp" data-li="${i}" data-k="amount" value="${esc(l.amount)}" inputmode="decimal" aria-label="Amount"><button type="button" class="icon-btn" data-act="billDelLine" data-id="${i}" aria-label="Remove line">${svg('x')}</button></div>`).join('')}</div>`
    : '<div class="calc">No lines yet. Choose the owner and period, then “Work out from machine log”, or add lines by hand.</div>';
  drawTotals();
}
function drawTotals() {
  const el = $('#billTot'); if (!el) return;
  const t = billTotal(BF), c = num(BF.comm), d = num(BF.deduct);
  el.innerHTML = `<span>Total rent</span><span>${inr(t)}</span><span>Commission (${esc(DB.settings.commParty)})</span><span>− ${inr(c)}</span>${d ? `<span>Other deduction</span><span>− ${inr(d)}</span>` : ''}<span><b>Owner's share</b></span><span class="g">${inr(t - c - d)}</span>`;
}
function billFill() {
  const f = $('#mform'); if (!f) return;
  BF.site = f.site.value; BF.owner = f.owner.value; BF.from = f.from.value; BF.to = f.to.value;
  if (!BF.owner.trim()) { toast('Enter the machine owner first'); return; }
  const ms = DB.machines.filter(m => m.site === BF.site && norm(m.owner) === norm(BF.owner));
  if (!ms.length) { $('#billMsg').textContent = 'No machines of this owner on this site.'; return; }
  const inR = d => (!BF.from || d >= BF.from) && (!BF.to || d <= BF.to);
  const lines = [];
  for (const m of ms) {
    const logs = DB.mlog.filter(r => r.site === BF.site && mkey(r.mno) === mkey(m.no) && isDate(r.date) && inR(r.date));
    if (!logs.length) continue;
    const daily = m.basis === 'Daily';
    const units = daily ? new Set(logs.filter(r => hrsOf(r) > 0 || has(r.outR) || has(r.diesel)).map(r => r.date)).size : rnd(sum(logs, hrsOf), 2);
    const rate = rnd(unitRate(m), 2);
    lines.push({ mno: m.no + ' · ' + m.type, basis: daily ? 'Daily' : 'Hourly', units, rate: rate || '', amount: rate ? Math.round(units * rate) : '' });
  }
  BF.lines = lines;
  if (has(BF.commPct)) { BF.comm = Math.round(billTotal(BF) * num(BF.commPct) / 100); f.comm.value = BF.comm; }
  $('#billMsg').textContent = lines.length ? `${lines.length} machine(s) found.${lines.some(l => !l.rate) ? ' Some rates are not set – type them in, or set them in the Machine list.' : ''}` : 'No machine log entries in this period.';
  drawLines();
}
function billText(b) {
  const lines = (b.lines || []).map(l => `${l.mno}: ${qty(l.units, 2)} ${l.basis === 'Daily' ? 'days' : 'hrs'} × ${inr(l.rate)} = ${inr(l.amount)}`).join('\n');
  return `*Machine Rent Bill ${b.no || ''}*\n${DB.settings.company} · ${siteName(b.site)}\nOwner: ${b.owner}\nPeriod: ${fmtD(b.from)} – ${fmtD(b.to)}\n\n${lines}\n\nTotal rent: ${inr(billTotal(b))}\nCommission (${DB.settings.commParty}): ${inr(b.comm)}${num(b.deduct) ? `\nDeduction${b.deductNote ? ' (' + b.deductNote + ')' : ''}: ${inr(b.deduct)}` : ''}\n*Owner's share: ${inr(billShare(b))}*\nPaid: ${inr(billPaid(b))}\n*Balance: ${inr(billDue(b))}*`;
}
function viewBill(id) {
  reindex();
  const b = DB.bill.find(x => x.id === id); if (!b) return;
  const pays = DB.opay.filter(p => p.billId === id).sort(byDateDesc);
  openModal({
    title: `Rent bill ${b.no || ''}`, size: 'wide',
    body: `<div class="toolbar" style="justify-content:space-between;margin-bottom:12px"><dl class="kv"><dt>Owner</dt><dd>${esc(b.owner)}</dd><dt>Site</dt><dd>${esc(siteName(b.site))}</dd><dt>Period</dt><dd>${fmtD(b.from)} – ${fmtD(b.to)}</dd><dt>Bill date</dt><dd>${fmtD(b.date)}</dd></dl>${dueChip(billDue(b))}</div>
      <div class="tbl"><table class="rt"><thead><tr><th>Machine</th><th>Basis</th><th class="n">Hours / days</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>
      ${(b.lines || []).map(l => `<tr>${td('Machine', esc(l.mno), 'c1')}${td('Basis', l.basis === 'Daily' ? 'Per day' : 'Per hour')}${td('Units', qty(l.units, 2), 'n')}${td('Rate', inr(l.rate), 'n')}${td('Amount', inr(l.amount), 'n main')}</tr>`).join('')}</tbody></table></div>
      <div class="totals"><span>Total rent</span><span>${inr(billTotal(b))}</span><span>Commission (${esc(DB.settings.commParty)})</span><span>− ${inr(b.comm)}</span>${num(b.deduct) ? `<span>Deduction${b.deductNote ? ' · ' + esc(b.deductNote) : ''}</span><span>− ${inr(b.deduct)}</span>` : ''}<span><b>Owner's share</b></span><span>${inr(billShare(b))}</span><span>Paid to owner</span><span>${inr(billPaid(b))}</span><span><b>Balance</b></span><span class="g">${inr(billDue(b))}</span></div>
      <h3 style="font-size:18px;margin:18px 0 8px">Payments to owner</h3>
      ${pays.length ? `<div class="plist">${pays.map(p => `<div class="prow" data-act="editOpay" data-id="${esc(p.id)}"><span class="t">${fmtD(p.date)} · ${esc([p.paidBy, p.mode].filter(Boolean).join(' · ') || 'Payment')}</span><span class="d">${esc(p.remark || '')}</span><span class="a">${inr(p.amount)}</span></div>`).join('')}</div>` : '<p class="muted" style="margin:0">No payment recorded yet.</p>'}
      ${b.note ? `<p class="muted sm">${esc(b.note)}</p>` : ''}`,
    rec: b, coll: 'bill',
    extra: `${access('bill', b).mode === 'edit' ? `<button type="button" class="btn left" data-act="editBill" data-id="${esc(b.id)}">Edit bill</button>` : ''}<button type="button" class="btn${access('bill', b).mode === 'edit' ? '' : ' left'}" data-act="copyBill" data-id="${esc(b.id)}">${svg('copy')}Copy</button>${billDue(b) > 0.5 && canAdd('opay') ? `<button type="button" class="btn primary" data-act="payBill" data-id="${esc(b.id)}">Record payment</button>` : ''}`
  });
}

/* --- party statement --- */
function viewParty(kind, name) {
  reindex();
  const k = norm(name), ok = r => inSite(r);
  const ent = [];
  if (kind === 'vendor') {
    DB.exp.filter(r => ok(r) && norm(r.vendor) === k).forEach(r => { ent.push({ d: r.date, site: r.site, t: [r.cat, r.desc].filter(Boolean).join(' · '), dr: num(r.amount), cr: 0, act: 'editExp', id: r.id }); if (r.status === 'Paid') ent.push({ d: r.date, site: r.site, t: 'Paid on the spot' + (r.paidBy ? ' by ' + r.paidBy : ''), dr: 0, cr: num(r.amount), act: 'editExp', id: r.id }); });
  } else if (kind === 'pump') {
    DB.dsl.filter(r => ok(r) && norm(r.vendor) === k).forEach(r => { ent.push({ d: r.date, site: r.site, t: `Diesel ${qty(r.litres)} L${r.bill ? ' · bill ' + r.bill : ''}`, dr: num(r.amount), cr: 0, act: 'editDsl', id: r.id }); if (r.status === 'Paid') ent.push({ d: r.date, site: r.site, t: 'Paid' + (r.paidBy ? ' by ' + r.paidBy : ''), dr: 0, cr: num(r.amount), act: 'editDsl', id: r.id }); });
  } else {
    DB.bill.filter(b => ok(b) && norm(b.owner) === k).forEach(b => ent.push({ d: b.date, site: b.site, t: `Rent bill ${b.no || ''} (owner share)`, dr: billShare(b), cr: 0, act: 'viewBill', id: b.id }));
    DB.opay.filter(p => ok(p) && norm(p.owner) === k).forEach(p => ent.push({ d: p.date, site: p.site, t: 'Payment' + (p.paidBy ? ' by ' + p.paidBy : '') + (p.billId ? '' : ' (advance)'), dr: 0, cr: num(p.amount), act: 'editOpay', id: p.id }));
  }
  if (kind !== 'owner') DB.vpay.filter(r => ok(r) && norm(r.vendor) === k).forEach(r => ent.push({ d: r.date, site: r.site, t: 'Payment' + (r.paidBy ? ' by ' + r.paidBy : '') + (r.mode ? ' · ' + r.mode : ''), dr: 0, cr: num(r.amount), act: 'editVpay', id: r.id }));
  ent.sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')) || (b.dr - a.dr));
  let bal = 0; ent.forEach(e => { bal += e.dr - e.cr; e.bal = bal; });
  const billed = sum(ent, e => e.dr), paid = sum(ent, e => e.cr);
  const text = `*Statement – ${name}*\n${scopeName()}\n` + ent.map(e => `${fmtDs(e.d)} ${e.t}: ${e.dr ? inr(e.dr) : '−' + inr(e.cr)}`).join('\n') + `\n\nBilled: ${inr(billed)}\nPaid: ${inr(paid)}\n*Balance: ${inr(billed - paid)}*`;
  openModal({
    title: name, size: 'wide',
    body: `<div class="toolbar" style="justify-content:space-between;margin-bottom:12px"><div class="strip"><span>${kind === 'vendor' ? 'Vendor' : kind === 'pump' ? 'Diesel pump' : 'Machine owner'} · ${esc(scopeName())}</span><span>Billed <b>${inr(billed)}</b></span><span>Paid <b>${inr(paid)}</b></span></div>${dueChip(billed - paid)}</div>
    <div class="tbl"><table class="rt"><thead><tr><th>Date</th>${showSiteCol() ? '<th>Site</th>' : ''}<th>Detail</th><th class="n">Bill</th><th class="n">Paid</th><th class="n">Balance</th></tr></thead><tbody>
    ${ent.slice().reverse().map(e => `<tr data-act="${e.act}" data-id="${esc(e.id)}">${td('Date', fmtDs(e.d), 'c1')}${showSiteCol() ? td('Site', esc(siteName(e.site))) : ''}${td('Detail', `<span class="clip">${esc(e.t)}</span>`)}${td('Bill', e.dr ? inr(e.dr) : '', 'n')}${td('Paid', e.cr ? inr(e.cr) : '', 'n')}${td('Balance', inr(e.bal), 'n main')}</tr>`).join('')}</tbody></table></div>`,
    extra: `<button type="button" class="btn left" data-act="copyTxt" data-v="${esc(text)}">${svg('copy')}Copy statement</button>${billed - paid > 0.5 && canAdd(kind === 'owner' ? 'opay' : 'vpay') ? `<button type="button" class="btn primary" data-act="payParty" data-id="${esc(kind)}" data-v="${esc(name)}">Record payment</button>` : ''}`
  });
}

/* --- machine master --- */
function formMachine(rec) {
  if (needSite()) return;
  if (!isAdmin()) { toast('Only the admin can add or change machines.'); return; }
  const types = DB.settings.types;
  const r = rec ? { ...rec } : { id: uid(), site: defSite(), type: types[0].type, basis: types[0].basis, pkgUnits: types[0].units };
  openModal({
    title: rec ? 'Edit machine ' + rec.no : 'Add machine',
    body: `<div class="fgrid">${fld('Site', selSite('site', r.site))}${fld('Machine no.', inp('no', r.no, 'required placeholder="e.g. PC-25"'))}
      ${fld('Type', sel('type', uniq([...types.map(t => t.type), r.type]), r.type))}${fld('Make', inp('make', r.make, 'list="dl_mk" placeholder="e.g. Tata Hitachi"'))}
      ${fld('Owner', inp('owner', r.owner, 'list="dl_ow" autocomplete="off"'))}${fld('Operator / driver', inp('operator', r.operator, 'list="dl_dr" autocomplete="off"'))}
      ${fld('Rent basis', sel('basis', [['Hourly', 'Per hour (package of hours)'], ['Daily', 'Per day worked (package of days)']], r.basis))}${fld('Package size', numInp('pkgUnits', r.pkgUnits))}
      ${fld('Package rent (₹)', numInp('pkgRate', r.pkgRate, 'placeholder="e.g. rent for 240 hrs"'))}${fld('Rate', `<div class="calc" id="mRate"></div>`)}
      ${rec ? fld('Status', seg('removed', ['On site', 'Removed'], r.removed ? 'Removed' : 'On site'), 'span2') : ''}</div>
      ${dl('dl_mk', uniq(['Tata Hitachi', 'JCB', 'Sany', 'XCMG', 'Hyundai', 'Komatsu', 'CAT', ...DB.machines.map(m => m.make)]))}${dl('dl_ow', ownerNames())}${dl('dl_dr', driverNames())}`,
    del: rec ? async () => {
      const n = DB.mlog.filter(x => x.site === rec.site && mkey(x.mno) === mkey(rec.no)).length;
      if (n) { toast(`${rec.no} has ${n} log entries. Mark it Removed instead.`); formMachine(rec); return; }
      if (await confirmBox('Delete machine ' + esc(rec.no) + '?')) { DB.machines = DB.machines.filter(m => m.id !== rec.id); saveMeta(); render(); } else formMachine(rec);
    } : null,
    onOpen: f => showRate(f),
    onInput: (e, f) => { if (e.target.name === 'type') { const t = types.find(x => x.type === e.target.value); if (t) { f.basis.value = t.basis; f.pkgUnits.value = t.units; } } showRate(f); },
    onSubmit: v => {
      const no = v.no.trim().toUpperCase().replace(/\s*-\s*/g, '-');
      if (!req(v.site, 'Choose a site') || !req(no, 'Enter the machine number')) return false;
      if (DB.machines.some(m => m.id !== r.id && m.site === v.site && mkey(m.no) === mkey(no))) { toast(no + ' already exists on this site'); return false; }
      const o = { ...r, site: v.site, no, type: v.type, make: v.make.trim(), owner: v.owner.trim(), operator: v.operator.trim(), basis: v.basis, pkgUnits: nv(v.pkgUnits), pkgRate: nv(v.pkgRate) };
      if (rec) { if (v.removed === 'Removed') { o.removed = true; o.removedOn = o.removedOn || today(); } else { delete o.removed; delete o.removedOn; } }
      if (rec && mkey(rec.no) !== mkey(no)) writeRows('mlog', DB.mlog.filter(x => x.site === rec.site && mkey(x.mno) === mkey(rec.no)).map(x => ({ ...x, mno: no })));
      const i = DB.machines.findIndex(m => m.id === r.id); if (i >= 0) DB.machines[i] = o; else DB.machines.push(o);
      saveMeta(); toast(rec ? 'Machine updated' : 'Machine added');
    }
  });
  function showRate(f) { const ur = num(f.pkgUnits.value) ? num(f.pkgRate.value) / num(f.pkgUnits.value) : 0; $('#mRate').innerHTML = ur ? `<b>${inr(ur)}</b> per ${f.basis.value === 'Daily' ? 'day' : 'hour'}` : 'Enter package rent and size'; }
}
function formBulkRate() {
  if (needSite()) return;
  if (!isAdmin()) { toast('Only the admin can set rates.'); return; }
  const types = DB.settings.types;
  openModal({
    title: 'Set rent rates',
    body: `<p class="muted sm" style="margin-top:0">Applies one package rent to many machines at once. Example: Poclain on a 240-hour package, Hiwa on a 30-day rate billed per day worked.</p><div class="fgrid">${fld('Site', selSite('site', defSite()))}${fld('Type', sel('type', types.map(t => t.type), types[0].type))}
      ${fld('Owner <span class="hint">· optional</span>', inp('owner', '', 'list="dl_ow" autocomplete="off" placeholder="All owners"'))}${fld('Rent basis', sel('basis', [['Hourly', 'Per hour'], ['Daily', 'Per day worked']], types[0].basis))}
      ${fld('Package size', numInp('pkgUnits', types[0].units))}${fld('Package rent (₹)', numInp('pkgRate', '', 'required'))}</div><p class="calc" id="brInfo" style="margin-top:12px"></p>${dl('dl_ow', ownerNames())}`,
    saveLabel: 'Apply',
    onOpen: f => info(f),
    onInput: (e, f) => { if (e.target.name === 'type') { const t = types.find(x => x.type === e.target.value); if (t) { f.basis.value = t.basis; f.pkgUnits.value = t.units; } } info(f); },
    onSubmit: v => {
      if (!req(num(v.pkgRate), 'Enter the package rent')) return false;
      const list = match(v); list.forEach(m => { m.basis = v.basis; m.pkgUnits = num(v.pkgUnits); m.pkgRate = num(v.pkgRate); });
      saveMeta(); toast(`Rate set for ${list.length} machine(s)`);
    }
  });
  function match(v) { return DB.machines.filter(m => m.site === v.site && m.type === v.type && !m.removed && (!v.owner.trim() || norm(m.owner) === norm(v.owner))); }
  function info(f) { const v = { site: f.site.value, type: f.type.value, owner: f.owner.value }; const n = match(v).length; const ur = num(f.pkgUnits.value) ? num(f.pkgRate.value) / num(f.pkgUnits.value) : 0; $('#brInfo').innerHTML = `${n} machine(s) will get this rate${ur ? ` · <b>${inr(ur)}</b> per ${f.basis.value === 'Daily' ? 'day' : 'hour'}` : ''}.`; }
}

/* --- setup forms --- */
function formSite(rec) {
  const r = rec ? { ...rec } : { id: uid(), kind: 'Plot development', status: 'Active' };
  openModal({
    title: rec ? 'Edit site' : 'Add site',
    body: `<div class="fgrid">${fld('Site name', inp('name', r.name, 'required'), 'span2')}${fld('Location', inp('place', r.place))}${fld('Type of work', sel('kind', ['Plot development', 'Construction', 'Interior', 'Office'], r.kind))}
      ${fld('Status', seg('status', ['Active', 'Completed'], r.status || 'Active'))}${fld('Diesel opening stock (L)', numInp('dieselOpening', r.dieselOpening))}${fld('Note', inp('note', r.note), 'span2')}</div>`,
    del: rec ? async () => {
      const used = COLLS.reduce((a, c) => a + DB[c].filter(x => x.site === rec.id).length, 0) + DB.machines.filter(m => m.site === rec.id).length;
      if (used) { toast(`This site has ${used} entries. Mark it Completed instead.`); formSite(rec); return; }
      if (await confirmBox('Delete site ' + esc(rec.name) + '?')) { DB.sites = DB.sites.filter(s => s.id !== rec.id); saveMeta(); render(); } else formSite(rec);
    } : null,
    onSubmit: v => {
      if (!req(v.name.trim(), 'Enter the site name')) return false;
      const o = { ...r, name: v.name.trim(), place: v.place.trim(), kind: v.kind, status: v.status, dieselOpening: nv(v.dieselOpening), note: v.note.trim() };
      const i = DB.sites.findIndex(s => s.id === r.id); if (i >= 0) DB.sites[i] = o; else DB.sites.push(o);
      saveMeta(); toast(rec ? 'Site updated' : 'Site added');
    }
  });
}
function renameEverywhere(field, colls, from, to) {
  for (const c of colls) { const rows = DB[c].filter(r => r[field] && norm(r[field]) === norm(from)).map(r => ({ ...r, [field]: to })); if (rows.length) writeRows(c, rows); }
}
function formPerson(rec) {
  const r = rec ? { ...rec } : { id: uid(), cash: false };
  openModal({
    title: rec ? 'Edit person' : 'Add person', size: 'narrow',
    body: `<div class="fgrid">${fld('Name', inp('name', r.name, 'required'), 'span2')}<label class="check span2" style="grid-column:1/-1"><input type="checkbox" name="cash" id="f_cash"${r.cash ? ' checked' : ''}> Gets money in advance (keep a running balance)</label></div>`,
    del: rec ? async () => { if (await confirmBox('Remove ' + esc(rec.name) + ' from the list? Their past entries stay.')) { DB.people = DB.people.filter(p => p.id !== rec.id); saveMeta(); render(); } else formPerson(rec); } : null,
    onSubmit: v => {
      const name = v.name.trim(); if (!req(name, 'Enter the name')) return false;
      if (DB.people.some(p => p.id !== r.id && norm(p.name) === norm(name))) { toast(name + ' is already in the list'); return false; }
      if (rec && rec.name !== name) { renameEverywhere('paidBy', ['exp', 'dsl', 'vpay', 'opay'], rec.name, name); renameEverywhere('person', ['fund'], rec.name, name); }
      const o = { ...r, name, cash: !!v.cash }; const i = DB.people.findIndex(p => p.id === r.id); if (i >= 0) DB.people[i] = o; else DB.people.push(o);
      saveMeta();
    }
  });
}
function formCat(rec) {
  const r = rec ? { ...rec } : { id: uid() };
  openModal({
    title: rec ? 'Edit expense head' : 'Add expense head', size: 'narrow',
    body: `<div class="fgrid">${fld('Head name', inp('name', r.name, 'required'), 'span2')}${fld('Default unit', inp('unit', r.unit, 'list="dl_u" placeholder="e.g. Brass"'), 'span2')}</div>${dl('dl_u', unitNames())}`,
    del: rec ? async () => {
      const n = DB.exp.filter(x => x.cat === rec.name).length;
      if (n) { toast(`${n} expenses use this head. Rename it instead.`); formCat(rec); return; }
      if (await confirmBox('Delete head ' + esc(rec.name) + '?')) { DB.cats = DB.cats.filter(c => c.id !== rec.id); saveMeta(); render(); } else formCat(rec);
    } : null,
    onSubmit: v => {
      const name = v.name.trim(); if (!req(name, 'Enter the head name')) return false;
      if (DB.cats.some(c => c.id !== r.id && norm(c.name) === norm(name))) { toast('This head already exists'); return false; }
      if (rec && rec.name !== name) renameEverywhere('cat', ['exp'], rec.name, name);
      const o = { ...r, name, unit: v.unit.trim() }; const i = DB.cats.findIndex(c => c.id === r.id); if (i >= 0) DB.cats[i] = o; else DB.cats.push(o);
      saveMeta();
    }
  });
}
function formType(idx) {
  const list = DB.settings.types; const rec = idx != null ? list[+idx] : null;
  const r = rec ? { ...rec } : { type: '', basis: 'Hourly', units: 240 };
  openModal({
    title: rec ? 'Edit machine type' : 'Add machine type', size: 'narrow',
    body: `<div class="fgrid">${fld('Type', inp('type', r.type, 'required'), 'span2')}${fld('Rent basis', sel('basis', [['Hourly', 'Per hour'], ['Daily', 'Per day worked']], r.basis))}${fld('Package size', numInp('units', r.units))}</div><p class="muted sm">New machines of this type start with this basis. Existing machines keep their own setting.</p>`,
    onSubmit: v => {
      const t = v.type.trim(); if (!req(t, 'Enter the type')) return false;
      const o = { type: t, basis: v.basis, units: num(v.units) || (v.basis === 'Daily' ? 30 : 240) };
      if (rec) { if (rec.type !== t) DB.machines.forEach(m => { if (m.type === rec.type) m.type = t; }); list[+idx] = o; } else list.push(o);
      saveMeta();
    }
  });
}
function formSettings() {
  const s = DB.settings;
  openModal({
    title: 'Bills & payments',
    body: `<div class="fgrid">${fld('Company name', inp('company', s.company))}${fld('Commission party', inp('commParty', s.commParty))}
      ${fld('Default commission %', numInp('commPct', s.commPct))}${fld('Bill no. prefix', inp('billPrefix', s.billPrefix))}${fld('Next bill no.', numInp('billNext', s.billNext))}
      ${fld('Payment modes <span class="hint">· comma separated</span>', inp('modes', s.modes.join(', ')), 'span2')}</div>`,
    onSubmit: v => {
      Object.assign(s, { company: v.company.trim() || 'Veershree Realty', commParty: v.commParty.trim() || 'Mangalmurti Developers', commPct: num(v.commPct), billPrefix: v.billPrefix, billNext: Math.max(1, Math.round(num(v.billNext)) || 1),
        modes: v.modes.split(',').map(x => x.trim()).filter(Boolean) });
      if (!s.modes.length) s.modes = MODES.slice();
      saveMeta();
    }
  });
}
function quickAdd() {
  const Q = [['exp', 'add', 'Expense', 'JCB, murum, road, labour…'], ['mlog', 'add', 'Machine daily sheet', 'All machines of a site', 'mlogBulk'], ['mlog', 'add', 'Machine entry', 'One machine, one day'],
    ['dsl', 'add', 'Diesel bill', 'Pump, litres, amount'], ['fund', 'add', 'Money received', isMgr() ? 'Money you received' : 'Advance to Rushi or Sahil'], ['vpay', 'add', 'Vendor payment', 'Pay a vendor or pump'],
    ['opay', 'add', 'Owner payment', 'Pay a machine owner'], ['bill', 'newBill', 'Rent bill', 'From the machine log']].filter(q => canAdd(q[0]));
  if (!Q.length) { toast('Your role is view only.'); return; }
  openModal({
    title: 'New entry', size: 'narrow', foot: false,
    body: `<div class="qa">${Q.map(([c, act, b, s, id]) => `<button type="button" data-act="${act}" data-id="${id || c}"><b>${b}</b><span>${s}</span></button>`).join('')}</div>${isMgr() ? '<p class="muted sm" style="margin:12px 0 0">Your entries go to the admin for approval.</p>' : ''}`
  });
}

/* ================= IMPORT / EXPORT ================= */
let xlsxP = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxP) xlsxP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = res; s.onerror = () => { xlsxP = null; rej(new Error('Excel reader could not load. Check the internet connection.')); }; document.head.appendChild(s); });
  return xlsxP;
}
async function saveFile(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  try {
    const file = new File([blob], filename, { type: mime || blob.type || 'application/octet-stream' });
    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('Saved ' + filename);
}
const stamp = () => today();
function backup() {
  if (!isAdmin()) { toast('Only the admin can save a full backup.'); return; }
  const data = { v: 1, _t: Date.now(), settings: DB.settings, sites: DB.sites, people: DB.people, cats: DB.cats, machines: DB.machines };
  for (const c of COLLS) data[c] = DB[c].map(stripLocal);
  saveFile(`veershree-plot-expense-backup-${stamp()}.json`, JSON.stringify({ app: 'veershree-plot-expense', v: 1, exported: new Date().toISOString(), by: ME.email, data }), 'application/json');
}

/* rows for export */
function expRows(rows) { return rows.map(r => ({ Date: r.date || '', Site: siteName(r.site), Head: r.cat || '', 'Vendor / Party': r.vendor || '', 'Work / Description': r.desc || '', Qty: has(r.qty) ? num(r.qty) : '', Unit: r.unit || '', Rate: has(r.rate) ? num(r.rate) : '', Amount: num(r.amount), Status: r.status || 'Unpaid', 'Paid By': r.paidBy || '', Mode: r.mode || '', 'Bill No': r.bill || '', 'Plot / Phase': r.plot || '', Remark: r.remark || '' })); }
function mlogRows(rows) { return rows.map(r => { const m = machineOf(r) || {}; return { Date: r.date || '', Site: siteName(r.site), 'Machine No': r.mno || '', Type: m.type || '', Owner: m.owner || '', Driver: r.driver || '', 'Worked With': r.attach || '', 'In Reading': has(r.inR) ? num(r.inR) : '', 'Out Reading': has(r.outR) ? num(r.outR) : '', Hours: rnd(hrsOf(r), 2), 'Diesel (L)': has(r.diesel) ? num(r.diesel) : '', Remark: r.remark || '' }; }); }
function dslRows(rows) { return rows.map(r => ({ Date: r.date || '', Site: siteName(r.site), Pump: r.vendor || '', 'Litres': has(r.litres) ? num(r.litres) : '', 'Rate / L': num(r.litres) && num(r.amount) ? rnd(r.amount / r.litres, 2) : '', Amount: num(r.amount), 'Bill No': r.bill || '', Status: r.status || 'Unpaid', 'Paid By': r.paidBy || '', Mode: r.mode || '', Remark: r.remark || '' })); }
function toCSV(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [keys.join(','), ...rows.map(r => keys.map(k => q(r[k])).join(','))].join('\n');
}
function csv(which) {
  let rows = [], name = which;
  if (which === 'exp') { rows = expRows(scoped('exp').sort(byDateDesc)); name = 'expenses'; }
  if (which === 'mlog') { rows = mlogRows(scoped('mlog').sort(byDateDesc)); name = 'machine-log'; }
  if (which === 'dsl') { rows = dslRows(scoped('dsl').sort(byDateDesc)); name = 'diesel'; }
  if (which === 'fund') { rows = DB.fund.filter(f => inPeriod(f.date)).sort(byDateDesc).map(r => ({ Date: r.date, 'Received By': r.person, From: r.from || '', Amount: num(r.amount), Mode: r.mode || '', Remark: r.remark || '' })); name = 'money-received'; }
  if (which === 'party') { const L = ledgers(); rows = [...L.V, ...L.P, ...L.O].map(x => ({ Name: x.name, Type: { vendor: 'Vendor', pump: 'Diesel pump', owner: 'Machine owner' }[x.kind], Entries: x.n, Billed: rnd(x.billed, 0), Paid: rnd(x.paid, 0), Balance: x.due })); name = 'party-balances'; }
  if (which === 'msum') { const per = new Map(); scoped('mlog').forEach(r => { const k = r.site + '|' + mkey(r.mno); const m = machineOf(r) || {}; const o = per.get(k) || { Site: siteName(r.site), Machine: r.mno, Type: m.type || '', Owner: m.owner || '', Days: new Set(), Hours: 0, 'Diesel (L)': 0 }; o.Days.add(r.date); o.Hours += hrsOf(r); o['Diesel (L)'] += num(r.diesel); per.set(k, o); }); rows = [...per.values()].map(o => ({ ...o, Days: o.Days.size, Hours: rnd(o.Hours, 1), 'Diesel (L)': rnd(o['Diesel (L)'], 1) })); name = 'machine-summary'; }
  if (!rows.length) { toast('Nothing to export for this selection'); return; }
  saveFile(`${name}-${stamp()}.csv`, toCSV(rows), 'text/csv');
}
async function exportXlsx() {
  try { toast('Preparing Excel…'); await loadXLSX(); } catch (e) { toast(e.message); return; }
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows, widths) => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No entries' }]); if (rows.length) ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: widths && widths[k] || Math.min(40, Math.max(10, k.length + 2)) })); XLSX.utils.book_append_sheet(wb, ws, name); };
  const ss = siteSummary().filter(x => (x.total || x.hrs) && (UI.site === 'all' || x.s.id === UI.site));
  addSheet('Site Summary', ss.map(x => ({ Site: x.s.name, Location: x.s.place || '', Expenses: rnd(x.e, 0), Diesel: rnd(x.d, 0), 'Rent (net of commission)': rnd(x.b, 0), Commission: rnd(x.c, 0), 'Total Cost': rnd(x.total, 0), 'Paid Out': rnd(x.paid, 0), 'Machine Hours': rnd(x.hrs, 1) })), { Site: 30 });
  addSheet('Head Summary', heads().map(h => ({ Head: h.label, Amount: rnd(h.value, 0) })), { Head: 32 });
  addSheet('Expenses', expRows(scoped('exp').sort(byDateDesc)), { 'Work / Description': 36, 'Vendor / Party': 22, Site: 26 });
  addSheet('Machine Log', mlogRows(scoped('mlog').sort(byDateDesc)), { Site: 26 });
  addSheet('Diesel', dslRows(scoped('dsl').sort(byDateDesc)), { Site: 26, Pump: 22 });
  addSheet('Rent Bills', scoped('bill').sort(byDateDesc).map(b => ({ 'Bill No': b.no || '', Date: b.date || '', Site: siteName(b.site), Owner: b.owner || '', From: b.from || '', To: b.to || '', Total: billTotal(b), Commission: num(b.comm), Deduction: num(b.deduct), 'Owner Share': billShare(b), Paid: billPaid(b), Balance: billDue(b) })));
  addSheet('Bill Lines', scoped('bill').flatMap(b => (b.lines || []).map(l => ({ 'Bill No': b.no || '', Owner: b.owner || '', Machine: l.mno, Basis: l.basis === 'Daily' ? 'Per day' : 'Per hour', Units: num(l.units), Rate: num(l.rate), Amount: num(l.amount) }))));
  addSheet('Owner Payments', scoped('opay').sort(byDateDesc).map(p => ({ Date: p.date, Site: siteName(p.site), Owner: p.owner, 'Bill No': (DB.bill.find(b => b.id === p.billId) || {}).no || 'Advance', Amount: num(p.amount), 'Paid By': p.paidBy || '', Mode: p.mode || '', Remark: p.remark || '' })));
  addSheet('Vendor Payments', scoped('vpay').sort(byDateDesc).map(p => ({ Date: p.date, Site: siteName(p.site), 'Vendor / Pump': p.vendor, Amount: num(p.amount), 'Paid By': p.paidBy || '', Mode: p.mode || '', Remark: p.remark || '' })));
  addSheet('Money Received', DB.fund.filter(f => inPeriod(f.date)).sort(byDateDesc).map(r => ({ Date: r.date, 'Received By': r.person, From: r.from || '', Amount: num(r.amount), Mode: r.mode || '', Remark: r.remark || '' })));
  const L = ledgers();
  addSheet('Party Balances', [...L.V, ...L.P, ...L.O].map(x => ({ Name: x.name, Type: { vendor: 'Vendor', pump: 'Diesel pump', owner: 'Machine owner' }[x.kind], Billed: rnd(x.billed, 0), Paid: rnd(x.paid, 0), Balance: x.due })), { Name: 28 });
  addSheet('Machines', DB.machines.filter(m => UI.site === 'all' || m.site === UI.site).map(m => ({ Site: siteName(m.site), 'Machine No': m.no, Type: m.type, Make: m.make || '', Owner: m.owner || '', Operator: m.operator || '', 'Rent Basis': m.basis === 'Daily' ? 'Per day' : 'Per hour', 'Package Size': num(m.pkgUnits), 'Package Rent': has(m.pkgRate) ? num(m.pkgRate) : '', Status: m.removed ? 'Removed' : 'On site' })));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const nm = (UI.site === 'all' ? 'all-sites' : siteName(UI.site).toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '-' + stamp();
  saveFile(`veershree-plot-expense-${nm}.xlsx`, new Blob([out]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/* --- import helpers --- */
function parseDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return isoLocal(new Date(v.getTime() + 12 * 3600e3));
  if (typeof v === 'number' && v > 20000 && v < 80000) { const t = new Date(Math.round((v - 25569) * 86400e3)); return t.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3,})[-\/. ,]*(\d{2,4})$/);
  if (m) { const mi = MON.findIndex(x => x.toLowerCase() === m[2].slice(0, 3).toLowerCase()); if (mi >= 0) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`; } }
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (m) { const d = +m[1], mo = +m[2], y = m[3].length === 2 ? '20' + m[3] : m[3]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  return '';
}
function parsePayer(text) {
  const s = String(text || '').trim(); if (!s) return { person: '', mode: '', pending: false };
  if (/pending|unpaid|baki|due/i.test(s)) return { person: '', mode: '', pending: true };
  const parts = s.split(/\s*[-–]\s*/).filter(Boolean);
  const modeOf = p => MODES.find(x => x.toLowerCase() === p.toLowerCase());
  let mode = '', person = s;
  if (parts.length >= 2) { if (modeOf(parts[0])) { mode = modeOf(parts[0]); person = parts.slice(1).join(' '); } else if (modeOf(parts[parts.length - 1])) { mode = modeOf(parts[parts.length - 1]); person = parts.slice(0, -1).join(' '); } }
  else if (modeOf(s)) return { person: '', mode: modeOf(s), pending: false };
  const known = DB.people.find(p => norm(p.name) === norm(person) || norm(p.name).split(' ')[0] === norm(person).split(' ')[0] && norm(person).split(' ')[0].length > 3);
  return { person: known ? known.name : title(person), mode, pending: false };
}
function guessType(s) {
  const t = norm(s);
  if (/pock|pocl|^pc|excav/.test(t)) return 'Poclain';
  if (/hiwa|hywa|hydra|^hw/.test(t)) return 'Hiwa';
  if (/jcb/.test(t)) return 'JCB';
  if (/tract|^tr/.test(t)) return 'Tractor';
  if (/dozer|^bd|^dz/.test(t)) return 'Bulldozer';
  if (/roller/.test(t)) return 'Roller';
  if (/gen|^g-/.test(t)) return 'Generator';
  return title(s) || 'Poclain';
}
function matchCat(sheetName) {
  const words = norm(sheetName).replace(/expenses?|sheet|\d+/g, ' ').replace(/[^a-z ]/g, ' ').split(' ').filter(w => w.length > 1);
  if (!words.length) return '';
  let best = null, bestExtra = 99;
  for (const c of DB.cats) { const cw = norm(c.name).replace(/[^a-z ]/g, ' ').split(' ').filter(Boolean); if (words.every(w => cw.some(x => x.startsWith(w) || w.startsWith(x)))) { const extra = cw.length - words.length; if (extra < bestExtra) { best = c.name; bestExtra = extra; } } }
  return best || title(words.join(' '));
}
const sig = (coll, r) => {
  const a = x => rnd(x, 2);
  switch (coll) {
    case 'exp': return [r.site, r.date, norm(r.vendor), norm(r.desc), a(r.amount), norm(r.cat)].join('|');
    case 'dsl': return [r.site, r.date, norm(r.vendor), a(r.litres), a(r.amount)].join('|');
    case 'mlog': return [r.site, r.date, mkey(r.mno), a(r.inR), a(r.outR), a(r.diesel), a(r.hrs)].join('|');
    case 'vpay': return [r.site, r.date, norm(r.vendor), a(r.amount)].join('|');
    case 'opay': return [r.site, r.date, norm(r.owner), a(r.amount)].join('|');
    case 'fund': return [r.date, norm(r.person), a(r.amount), norm(r.from)].join('|');
    case 'bill': return [r.site, norm(r.no), norm(r.owner), r.date].join('|');
  }
  return r.id;
};
function mergeRows(coll, rows) {
  const have = new Set(DB[coll].map(r => sig(coll, r)));
  const ids = new Set(DB[coll].map(r => r.id));
  const add = [];
  for (const r of rows) { const s = sig(coll, r); if (have.has(s) || ids.has(r.id)) continue; have.add(s); ids.add(r.id); add.push(r); }
  addRows(coll, add);
  return add.length;
}
function ensureMachines(site, list, replace) {
  const prev = new Map(DB.machines.filter(m => m.site === site).map(m => [mkey(m.no), m]));
  if (replace) DB.machines = DB.machines.filter(m => m.site !== site);
  let n = 0;
  for (let m of list) {
    if (!m.no) continue;
    const ex = DB.machines.find(x => x.site === site && mkey(x.no) === mkey(m.no));
    if (ex) { for (const k of ['type', 'make', 'owner', 'operator', 'basis', 'pkgRate', 'pkgUnits']) if (has(m[k]) && !has(ex[k])) ex[k] = m[k]; continue; }
    const t = DB.settings.types.find(x => x.type === m.type) || { basis: 'Hourly', units: 240 };
    const o = prev.get(mkey(m.no)) || {};
    if (!has(m.pkgRate) && has(o.pkgRate)) m = { ...m, pkgRate: o.pkgRate, basis: m.basis || o.basis, pkgUnits: m.pkgUnits || o.pkgUnits };
    if (!m.operator && o.operator) m = { ...m, operator: o.operator };
    if (!m.owner && o.owner) m = { ...m, owner: o.owner };
    if (!m.make && o.make) m = { ...m, make: o.make };
    DB.machines.push({ id: o.id || uid(), site, no: m.no, type: m.type || 'Poclain', make: m.make || '', owner: m.owner || '', operator: m.operator || '', basis: m.basis || t.basis, pkgRate: has(m.pkgRate) ? m.pkgRate : '', pkgUnits: m.pkgUnits || t.units, ...(m.removed ? { removed: true } : {}) });
    n++;
  }
  return n;
}
function ensurePeople(names) { let ch = false; for (const n of names) { const s = String(n || '').trim(); if (s && !DB.people.some(p => norm(p.name) === norm(s))) { DB.people.push({ id: uid(), name: s, cash: false }); ch = true; } } return ch; }
function ensureCats(names) { for (const n of names) { const s = String(n || '').trim(); if (s && !DB.cats.some(c => norm(c.name) === norm(s))) DB.cats.push({ id: uid(), name: s, unit: '' }); } }

/* --- Excel import --- */
async function importExcel(file) {
  try { toast('Reading ' + file.name + '…'); await loadXLSX(); } catch (e) { toast(e.message); return; }
  let wb; try { wb = XLSX.read(await file.arrayBuffer(), { cellDates: true }); } catch (e) { toast('This file could not be read as Excel.'); return; }
  const plan = [];
  for (const name of wb.SheetNames) {
    if (/dashboard|summary|read ?me|vendor master/i.test(name)) continue;
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    let hi = -1;
    for (let i = 0; i < Math.min(10, aoa.length); i++) { const cells = aoa[i].map(c => norm(c)); if (cells.includes('date') || cells.some(c => /^machine no/.test(c))) { hi = i; break; } }
    if (hi < 0) continue;
    const H = aoa[hi].map(c => norm(c));
    const col = (...pats) => H.findIndex(h => h && pats.some(p => p.test(h)));
    const c = {
      date: col(/^date$/), mno: col(/^machine no/), mtype: col(/machine type|^type$/), inR: col(/^in reading|^in$|opening|start reading/), outR: col(/^out reading|^out$|closing|end reading/),
      hrs: col(/total hr|^hours?$|hrs/), diesel: col(/diesel filled|diesel \(l\)|^diesel$/), litres: col(/total diesel|litre|ltr|qty \(l\)/), vendor: col(/vendor|party|pump/), bill: col(/bill|voucher/),
      amount: col(/amount/), status: col(/paid ?\/ ?unpaid|status|payment done|payment send/), paidBy: col(/paid by/), mode: col(/payment mode|^mode$/), desc: col(/work|description|particular|details/),
      qty: col(/^qty|quantity|brass/), rate: col(/^rate/), remark: col(/remark/), plot: col(/plot/), driver: col(/driver|operator/), owner: col(/owner/)
    };
    let kind = '';
    if (c.mno >= 0 && (c.inR >= 0 || c.outR >= 0) && c.date >= 0) kind = 'mlog';
    else if (c.mno >= 0 && c.date < 0) kind = 'machines';
    else if (c.date >= 0 && c.litres >= 0 && c.amount >= 0) kind = 'dsl';
    else if (c.date >= 0 && c.amount >= 0) kind = 'exp';
    if (!kind) continue;
    const g = (row, k) => c[k] >= 0 ? row[c[k]] : '';
    const rows = []; let lastDate = '';
    for (let i = hi + 1; i < aoa.length; i++) {
      const row = aoa[i]; if (!row || !row.some(x => String(x).trim())) continue;
      if (kind === 'machines') {
        const no = String(g(row, 'mno')).trim(); if (!no) continue;
        const parts = String(g(row, 'mtype')).split(/\s+-\s+|\s-|-\s/).map(x => x.trim()).filter(Boolean);
        rows.push({ no: no.toUpperCase().replace(/\s*-\s*/g, '-'), type: guessType(parts[0] || no), owner: parts.length >= 2 ? title(parts[1]) : String(g(row, 'owner') || '').trim(), make: parts.length >= 3 ? title(parts.slice(2).join(' ')) : '' });
        continue;
      }
      let date = parseDate(g(row, 'date'));
      if (!date && lastDate) { const m2 = String(g(row, 'date')).trim().match(/^(\d{1,2})[\/.-](\d{1,2})$/); if (m2) { let a = +m2[1], b2 = +m2[2]; const mo = a > 12 ? b2 : (b2 > 12 ? a : b2), dd = a > 12 ? a : (b2 > 12 ? b2 : a); if (mo >= 1 && mo <= 12) date = `${lastDate.slice(0, 4)}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; } }
      if (date) lastDate = date;
      if (kind === 'mlog') {
        const mno = String(g(row, 'mno')).trim(); if (!mno) continue;
        const inR = g(row, 'inR'), outR = g(row, 'outR'), ds = g(row, 'diesel'), hr = g(row, 'hrs');
        if (!has(String(inR).trim()) && !has(String(outR).trim()) && !has(String(ds).trim()) && !has(String(hr).trim())) continue;
        rows.push({ id: uid(), date, mno: mno.toUpperCase().replace(/\s*-\s*/g, '-'), driver: String(g(row, 'driver') || '').trim(), inR: nv(inR), outR: nv(outR), hrs: has(inR) && has(outR) ? '' : nv(hr), diesel: nv(ds), remark: String(g(row, 'remark') || '').trim() });
        continue;
      }
      const amount = nv(g(row, 'amount'));
      const p = parsePayer(g(row, 'paidBy'));
      const st = norm(g(row, 'status'));
      const paid = /^(paid|yes|done|y|ok|sent)/.test(st) || (!st && p.person && !p.pending);
      if (kind === 'dsl') {
        const vendor = String(g(row, 'vendor')).trim(), litres = nv(g(row, 'litres'));
        if (!vendor && !litres && !amount) continue;
        rows.push({ id: uid(), date, vendor, litres, bill: String(g(row, 'bill') || '').replace(/^-$/, '').trim(), amount, status: paid ? 'Paid' : 'Unpaid', paidBy: paid ? p.person : '', mode: paid ? (p.mode || String(g(row, 'mode') || '').trim()) : '', remark: String(g(row, 'remark') || '').trim() });
        continue;
      }
      const vendor = String(g(row, 'vendor')).replace(/^-$/, '').trim(), desc = String(g(row, 'desc')).trim();
      if (!num(amount) && !desc) continue;
      if (!num(amount) && !vendor && !date) continue;
      const qv = g(row, 'qty'), rt = nv(g(row, 'rate'));
      const qn = String(qv).match(/^([\d.,]+)\s*([a-zA-Z ]*)$/);
      const q = qn ? num(qn[1]) : '';
      const amt = has(amount) ? amount : (q && rt ? rnd(q * rt, 2) : '');
      rows.push({ id: uid(), date, vendor, desc, qty: q === '' ? '' : q, unit: qn && qn[2] ? qn[2].trim() : (c.qty >= 0 && /brass/.test(H[c.qty]) ? 'Brass' : ''), rate: rt, amount: amt,
        status: paid ? 'Paid' : 'Unpaid', paidBy: paid ? p.person : '', mode: paid ? (String(g(row, 'mode') || '').trim() || p.mode) : '', bill: c.bill >= 0 ? String(g(row, 'bill') || '').trim() : '', plot: String(g(row, 'plot') || '').trim(), remark: String(g(row, 'remark') || '').trim(), cat: '' });
    }
    if (rows.length) plan.push({ sheet: name, kind, rows, cat: kind === 'exp' ? matchCat(name) : '' });
  }
  if (!plan.length) { toast('No expense, diesel or machine sheets found in this file.'); return; }
  plan.sort((a, b) => (b.kind === 'machines') - (a.kind === 'machines'));
  const kindLabel = { exp: 'Expenses', dsl: 'Diesel purchases', mlog: 'Machine log', machines: 'Machine list' };
  const cats = uniq([...DB.cats.map(c => c.name), ...plan.map(p => p.cat)]);
  openModal({
    title: 'Import ' + file.name, size: 'wide', saveLabel: 'Import',
    body: `<div class="fgrid" style="margin-bottom:14px">${fld('Put these entries in site', selSite('site', defSite()))}${fld('Machine list', `<label class="check"><input type="checkbox" name="replace" id="f_replace"> Replace this site's machine list with the file's</label>`)}</div>
      <div class="tbl"><table class="rt"><thead><tr><th>Use</th><th>Sheet</th><th>Found</th><th class="n">Rows</th><th>Expense head</th></tr></thead><tbody>
      ${plan.map((p, i) => `<tr>${td('Use', `<input type="checkbox" name="use_${i}" checked aria-label="Import ${esc(p.sheet)}">`, 'c1')}${td('Sheet', esc(p.sheet), 'main')}${td('Found', kindLabel[p.kind])}${td('Rows', p.rows.length, 'n')}${td('Head', p.kind === 'exp' ? sel('cat_' + i, cats, p.cat) : '<span class="muted">—</span>')}</tr>`).join('')}
      </tbody></table></div><p class="muted sm">Entries already in the website (same date, party and amount) are skipped, so importing the same file twice is safe.</p>`,
    onSubmit: v => {
      const site = v.site; if (!site) { toast('Choose a site'); return false; }
      const res = []; let replaced = false;
      plan.forEach((p, i) => {
        if (!v['use_' + i]) return;
        if (p.kind === 'machines') { const n = ensureMachines(site, p.rows, !!v.replace && !replaced); replaced = true; res.push(`${n} machines`); saveMeta(); return; }
        const rows = p.rows.map(r => ({ ...r, site, ...(p.kind === 'exp' ? { cat: v['cat_' + i] || p.cat } : {}) }));
        if (p.kind === 'exp') ensureCats([v['cat_' + i] || p.cat]);
        if (p.kind === 'mlog') ensureMachines(site, uniq(rows.map(r => r.mno)).map(no => ({ no, type: guessType(no) })), false);
        if (ensurePeople(rows.map(r => r.paidBy)) || p.kind === 'exp' || p.kind === 'mlog') saveMeta();
        const n = mergeRows(p.kind, rows); res.push(`${n} of ${rows.length} from ${p.sheet}`);
      });
      UI.site = site; saveUI();
      toast('Imported ' + res.join(', '));
    }
  });
}

/* --- Site Manager backup import --- */
function importAppBackup(raw, fileName) {
  const sites = Array.isArray(raw.sites) ? raw.sites : (raw.machineLog || raw.expenseLog ? [raw] : []);
  if (!sites.length && !Array.isArray(raw.mfunds)) { toast('This file is not a Site Manager backup.'); return; }
  const guess = s => { const n = norm(s.name); const hit = DB.sites.find(x => norm(x.name) === n) || DB.sites.find(x => n && (norm(x.name).includes(n) || n.includes(norm(x.name)))) || DB.sites.find(x => x.place && n.includes(norm(x.place))); return hit ? hit.id : '__new'; };
  const cnt = s => ['machineLog', 'dieselLog', 'expenseLog', 'murumLog', 'vendorPayments', 'ownerPayments', 'bills', 'funds'].reduce((a, k) => a + (Array.isArray(s[k]) ? s[k].length : 0), 0);
  openModal({
    title: 'Import ' + fileName, size: 'wide', saveLabel: 'Import',
    body: `<p class="muted sm" style="margin-top:0">Pick which site in this website each app site goes to. Entries already here are skipped.</p>
      <div class="tbl"><table class="rt"><thead><tr><th>App site</th><th class="n">Machines</th><th class="n">Entries</th><th>Goes to</th><th>Machine list</th></tr></thead><tbody>
      ${sites.map((s, i) => `<tr>${td('App site', `<span class="main">${esc(s.name || 'Site ' + (i + 1))}</span>`, 'c1')}${td('Machines', (s.machines || []).length, 'n')}${td('Entries', cnt(s), 'n')}${td('Goes to', sel('to_' + i, [['__skip', 'Do not import'], ['__new', '+ New site: ' + (s.name || 'Site')], ...DB.sites.map(x => [x.id, x.name])], guess(s)))}${td('Machine list', `<label class="check"><input type="checkbox" name="rep_${i}"${(s.machines || []).length ? ' checked' : ''}> Use the app's list</label>`)}</tr>`).join('')}
      </tbody></table></div>${Array.isArray(raw.mfunds) && raw.mfunds.length ? `<p class="sm">Also found <b>${raw.mfunds.length}</b> manager money entries (${esc(uniq(raw.mfunds.map(f => f.manager)).join(', '))}).</p>` : ''}`,
    onSubmit: v => {
      const S = x => String(x == null ? '' : x).trim(), D = parseDate, N = nv;
      const ST = r => norm(r && r.status) === 'paid' ? 'Paid' : 'Unpaid';
      const murumCat = (DB.cats.find(c => /murum/i.test(c.name)) || { name: 'Murum / Filling' }).name;
      let total = 0;
      sites.forEach((s, i) => {
        let to = v['to_' + i]; if (to === '__skip') return;
        if (to === '__new') { const ns = { id: uid(), name: S(s.name) || 'New site', place: '', kind: 'Plot development', status: 'Active', dieselOpening: N(s.stockOpening), note: '' }; DB.sites.push(ns); to = ns.id; }
        const rate = {}; (s.rateMaster || []).forEach(r => { if (r && r.type) rate[r.type] = r; });
        const ms = (s.machines || []).filter(m => m && m.no).map(m => { const r = rate[m.type] || {}; return { no: S(m.no).toUpperCase().replace(/\s*-\s*/g, '-'), type: S(m.type) || guessType(m.no), make: S(m.make), owner: S(m.owner), operator: S(m.operator), basis: r.basis === 'Daily' ? 'Daily' : 'Hourly', pkgRate: N(r.packageRate) || '', pkgUnits: N(r.packageUnits) || (r.basis === 'Daily' ? 30 : 240), removed: !!m.removed }; });
        if (ms.length) ensureMachines(to, ms, !!v['rep_' + i]);
        const cats = [];
        const exp = (s.expenseLog || []).filter(Boolean).map(r => { cats.push(S(r.category)); return { id: S(r.id) || uid(), site: to, date: D(r.date), cat: S(r.category) || 'Other / Miscellaneous', vendor: S(r.vendor), desc: S(r.desc), amount: N(r.amount), status: ST(r), paidBy: ST(r) === 'Paid' ? S(r.paidBy) : '', mode: S(r.mode), remark: S(r.remark) }; });
        const mur = (s.murumLog || []).filter(Boolean).map(r => ({ id: S(r.id) || uid(), site: to, date: D(r.date), cat: murumCat, vendor: S(r.vendor), desc: 'Murum' + (num(r.trips) ? ' – ' + num(r.trips) + ' trips' : ''), qty: N(r.qty), unit: S(s.murumUnit) || 'Brass', rate: N(r.rate), amount: has(r.amount) ? N(r.amount) : (num(r.qty) && num(r.rate) ? rnd(num(r.qty) * num(r.rate), 2) : ''), status: ST(r), paidBy: ST(r) === 'Paid' ? S(r.paidBy) : '', mode: S(r.mode), remark: S(r.remark) }));
        ensureCats(cats.concat(mur.length ? [murumCat] : []));
        const ml = (s.machineLog || []).filter(r => r && r.machineNo).map(r => ({ id: S(r.id) || uid(), site: to, date: D(r.date), mno: S(r.machineNo).toUpperCase().replace(/\s*-\s*/g, '-'), inR: N(r.inR), outR: N(r.outR), diesel: N(r.diesel), remark: S(r.remark), driver: S(r.driver) }));
        const ds = (s.dieselLog || []).filter(Boolean).map(r => ({ id: S(r.id) || uid(), site: to, date: D(r.date), vendor: S(r.vendor), litres: N(r.litres), bill: S(r.bill), amount: N(r.amount), status: ST(r), paidBy: ST(r) === 'Paid' ? S(r.paidBy) : '', mode: S(r.mode), remark: S(r.remark) }));
        const vp = (s.vendorPayments || []).filter(Boolean).map(r => ({ id: S(r.id) || uid(), site: to, date: D(r.date), vendor: S(r.vendor), amount: N(r.amount), paidBy: S(r.paidBy), mode: S(r.mode), remark: S(r.remark) }));
        const op = (s.ownerPayments || []).filter(Boolean).map(r => ({ id: S(r.id) || uid(), site: to, date: D(r.date), owner: S(r.owner), billId: '', amount: N(r.amount), paidBy: S(r.paidBy), mode: S(r.mode), remark: S(r.remark) }));
        const bl = [];
        (s.bills || []).filter(Boolean).forEach(b => {
          const id = S(b.id) || uid();
          const lines = (b.items || []).filter(Boolean).map(it => ({ mno: S(it.desc), basis: 'Hourly', units: N(it.hours), rate: N(it.rate), amount: N(it.amount) }));
          bl.push({ id, site: to, no: S(b.no), date: D(b.date), owner: S(b.owner), from: D(b.from), to: D(b.to), lines, comm: num(b.commission), commPct: N(b.commPct), deduct: '', note: S(b.note) });
          (b.payments || []).filter(p => p && num(p.amount)).forEach(p => op.push({ id: S(p.id) || uid(), site: to, date: D(p.date), owner: S(b.owner), billId: id, amount: num(p.amount), paidBy: S(p.paidBy), mode: S(p.mode), remark: S(p.remark) }));
        });
        const fd = (s.funds || []).filter(Boolean).map(r => ({ id: S(r.id) || uid(), date: D(r.date), person: S(r.person), from: S(r.from), amount: N(r.amount), mode: S(r.mode), remark: S(r.remark) }));
        ensurePeople([...exp, ...mur, ...ds, ...vp, ...op].map(r => r.paidBy).concat(fd.map(f => f.person)));
        total += mergeRows('exp', exp.concat(mur)) + mergeRows('mlog', ml) + mergeRows('dsl', ds) + mergeRows('vpay', vp) + mergeRows('bill', bl) + mergeRows('opay', op) + mergeRows('fund', fd);
      });
      if (Array.isArray(raw.mfunds)) {
        const fd = raw.mfunds.filter(f => f && f.manager).map(f => ({ id: S(f.id) || uid(), date: D(f.date), person: S(f.manager), from: S(f.from), amount: N(f.amount), mode: S(f.mode), remark: S(f.remark) }));
        uniq(fd.map(f => f.person)).forEach(n => { const p = DB.people.find(x => norm(x.name) === norm(n)); if (p) p.cash = true; else DB.people.push({ id: uid(), name: n, cash: true }); });
        total += mergeRows('fund', fd);
      }
      saveMeta();
      toast(`Imported ${total.toLocaleString('en-IN')} entries`);
    }
  });
}
function restoreBackup(raw, fileName) {
  const data = raw && raw.app === 'veershree-plot-expense' ? raw.data : null;
  if (!data) { importAppBackup(raw, fileName || 'backup'); return; }
  importOldBackup(raw, fileName || 'backup');
}
async function handleFile(input) {
  const file = input.files && input.files[0]; input.value = ''; if (!file) return;
  const kind = input.dataset.file;
  if (kind === 'xlsx') { if (/\.json$/i.test(file.name)) { toast('That is a .json file. Use the Site Manager backup button.'); return; } importExcel(file); return; }
  let raw; try { raw = JSON.parse(await file.text()); } catch (e) { toast('This file is not a valid .json backup.'); return; }
  if (!isAdmin()) { toast('Only the admin can import.'); return; }
  if (kind === 'check') { if (raw && raw.app === 'veershree-plot-expense') runCheck(normalizeDB(raw.data), 'Check against ' + file.name, file.name); else toast('Choose a backup (.json) of this app or the old app.'); return; }
  if (!Store.meta && !(raw && raw.app === 'veershree-plot-expense')) { toast('First import the backup of the old Plot Expense Manager.'); return; }
  if (kind === 'restore') restoreBackup(raw, file.name);
  else if (raw && raw.app === 'veershree-plot-expense') restoreBackup(raw, file.name);
  else importAppBackup(raw, file.name);
}
async function clearAll() {
  if (!isAdmin()) return;
  if (!await confirmBox('Move every expense, machine entry, diesel bill, rent bill, payment and money entry to the Recycle Bin? Sites, people, heads and machines stay. Nothing is removed for good.', { ok: 'Move all to Recycle Bin' })) return;
  for (const c of COLLS) for (const r of DB[c].slice()) patchRow(c, r, { _del: true, _delBy: ME.uid, _delByName: ME.name, _delAt: Date.now(), _delWhy: 'Delete all entries' });
  render(); toast('All entries moved to the Recycle Bin');
}

/* ================= EVENTS ================= */
function go(page, sub) {
  if (!PAGES[page]) page = 'dashboard';
  PAGE = page; closeMenu();
  try { if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page); } catch (e) {}
  render(); window.scrollTo(0, 0);
  if (sub === 'import') setTimeout(() => { const el = $('#import'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
}
function closeMenu() { $('#rail').classList.remove('open'); $('#scrim').hidden = true; }
const ADD = { exp: () => formExp(), mlog: () => formMlog(), mlogBulk: () => formBulk(), dsl: () => formDsl(), fund: () => formFund(), vpay: () => formVpay(), opay: () => formOpay(), machine: () => formMachine(), site: () => formSite(), person: () => formPerson(), cat: () => formCat(), type: () => formType() };
const find = (c, id) => DB[c].find(r => r.id === id);
const ACTS = {
  nav: (id, v) => go(id, v),
  menu: () => { $('#rail').classList.add('open'); $('#scrim').hidden = false; },
  closeMenu,
  quickAdd,
  add: id => { closeModal(); ADD[id] && ADD[id](); },
  closeModal: () => { const m = MODAL; closeModal(); if (m && m.onCloseX) m.onCloseX(); },
  mdel: () => { const f = MODAL && MODAL.del; if (f) f(); },
  tab: (id, v) => { UI.tab[id] = v; saveUI(); render(); },
  more: id => { UI.limit[id] = (UI.limit[id] || 150) + 300; render(); },
  pickSite: id => { UI.site = id; saveUI(); render(); },
  editExp: id => { const r = find('exp', id); if (r) formExp(r); },
  editMlog: id => { const r = find('mlog', id); if (r) formMlog(r); },
  editDsl: id => { const r = find('dsl', id); if (r) formDsl(r); },
  editFund: id => { const r = find('fund', id); if (r) formFund(r); },
  editVpay: id => { const r = find('vpay', id); if (r) formVpay(r); },
  editOpay: id => { const r = find('opay', id); if (r) formOpay(r); },
  editMachine: id => { const m = DB.machines.find(x => x.id === id); if (m) formMachine(m); },
  editUserSelf: () => go('account'),
  editSite: id => { const s = siteObj(id); if (s) formSite(s); },
  editPerson: id => { const p = DB.people.find(x => x.id === id); if (p) formPerson(p); },
  editCat: id => { const c = DB.cats.find(x => x.id === id); if (c) formCat(c); },
  editType: id => formType(id),
  editSettings: formSettings,
  bulkRate: formBulkRate,
  machLog: (id, v) => { UI.tab.mach = 'log'; UI.q.machines = id; if (UI.site === 'all' && v) UI.site = v; saveUI(); render(); },
  newBill: () => { closeModal(); formBill(); },
  viewBill: id => viewBill(id),
  editBill: id => { const b = find('bill', id); if (b) formBill(b); },
  copyBill: id => { const b = find('bill', id); if (b) copyText(billText(b)); },
  payBill: id => { const b = find('bill', id); if (b) formOpay(null, { site: b.site, owner: b.owner, billId: b.id, amount: Math.round(billDue(b)) }); },
  billFill, billLine: () => { BF.lines.push({ mno: '', basis: 'Hourly', units: '', rate: '', amount: '' }); drawLines(); },
  billDelLine: id => { BF.lines.splice(+id, 1); drawLines(); },
  party: (id, v) => viewParty(id, v),
  payParty: (id, v) => { const L = ledgers(); const x = [...L.V, ...L.P, ...L.O].find(x => x.kind === id && x.name === v); const amt = x ? Math.round(x.due) : ''; if (id === 'owner') formOpay(null, { owner: v, amount: amt }); else formVpay(null, { vendor: v, amount: amt }); },
  copyTxt: (id, v) => copyText(v),
  regFor: id => { UI.regPerson = id; UI.tab.cash = 'reg'; saveUI(); render(); },
  regDay: (id, v) => { UI.regDate = addDays(UI.regDate || today(), +v); saveUI(); render(); },
  copyReg: () => copyText(register(UI.regPerson || 'Rushi', UI.regDate || today()).text),
  csv: id => csv(id), xlsx: exportXlsx, backup, clearAll,
  print: () => window.print(),
  saveAgain: () => { const f = $('#mform'); if (!f) return; f._again = true; if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true })); },
  sync: () => { const [s, , title] = syncState(); if (s === 'error') { Store.err = ''; startSync(); setSync(); } toast(title); },
  approve: (id, v) => approve(v, id),
  signOut: doSignOut, reload: () => location.reload(),
  gForgot: async () => { const f = gate.querySelector('form'); const email = f && f.email ? f.email.value.trim() : ''; if (!email) { gErr('Type your email first, then tap "Forgot password?".'); return; } try { await CLOUD.resetPassword(email); gErr(''); toast('Password reset email sent to ' + email); } catch (e) { gErr(authMsg(e)); } },
  gOwner: () => gateOwner(), gBack: async () => gateLogin('', await CLOUD.ownerClaimed()),
  addUser: () => formUser(null), editUser: id => { const u = USERS.find(x => x.uid === id); if (u) formUser(u); },
  resetPass: async (id, v) => { try { await CLOUD.resetPassword(v); toast('Reset email sent to ' + v); } catch (e) { toast(authMsg(e)); } },
  changePass: formChangePass, theme: (id, v) => setTheme(v || ''), secCheck: securityCheck, startFresh,
  resync: async () => { if (!await confirmBox('Download every entry again from the online database? Changes not uploaded yet are kept.', { ok: 'Download again', danger: false })) return; for (const [k, r] of [...Store.all.entries()]) if (!r.$pend) Store.all.delete(k); Store.cursors = {}; Store.firstSynced = false; rebuild(); startSync(); persistSoon(); render(); }
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  if (t.closest('#modal') && !t.closest('.dlg')) return;
  const fn = ACTS[t.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(t.dataset.id, t.dataset.v, t, e);
});
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') { const m = MODAL; closeModal(); if (m && m.onCloseX) m.onCloseX(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && MODAL) { const m = MODAL; closeModal(); if (m.onCloseX) m.onCloseX(); } });
let qT = 0;
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset && t.dataset.f === 'q') { clearTimeout(qT); qT = setTimeout(() => { UI.q[PAGE] = t.value; UI.limit = {}; render(); }, 160); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset && t.dataset.file) { handleFile(t); return; }
  const f = t.dataset && t.dataset.f; if (!f || f === 'q' || t.closest('#modal')) return;
  if (f === 'period' && t.value === 'custom' && !UI.from) { UI.from = isoLocal(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); UI.to = today(); }
  UI[f] = t.value; UI.limit = {}; saveUI(); render();
});
/* tooltip for bars */
const tip = $('#tip');
document.addEventListener('pointerover', e => { const t = e.target.closest('[data-tip]'); if (!t) { tip.hidden = true; return; } tip.textContent = t.dataset.tip; tip.hidden = false; });
document.addEventListener('pointermove', e => { if (tip.hidden) return; const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14), y = Math.max(8, e.clientY - tip.offsetHeight - 10); tip.style.left = x + 'px'; tip.style.top = y + 'px'; });
document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-tip]'))) tip.hidden = true; });
window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES[h] && h !== PAGE) go(h); });

/* ================= LOGIN & START ================= */
const gate = $('#gate');
function showGate(inner) {
  gate.innerHTML = `<div class="gate-card"><div class="gate-brand"><b>VEERSHREE</b><span>Plot Expense Manager</span></div>${inner}</div>`;
  gate.hidden = false; document.body.classList.add('gated');
  const f = gate.querySelector('form');
  if (f) { f.addEventListener('submit', e => { e.preventDefault(); const fn = GATE_SUBMIT[f.dataset.form]; if (fn) fn(Object.fromEntries(new FormData(f).entries()), f); }); setTimeout(() => { const i = f.querySelector('input'); if (i && window.innerWidth > 640) i.focus(); }, 50); }
}
function hideGate() { gate.hidden = true; gate.innerHTML = ''; document.body.classList.remove('gated'); }
const gErr = msg => { const el = $('#gErr'); if (el) el.textContent = msg || ''; const b = gate.querySelector('button[type=submit]'); if (b) b.disabled = false; };
const gBusy = () => { const b = gate.querySelector('button[type=submit]'); if (b) b.disabled = true; gErr(''); };
const authMsg = e => {
  const c = (e && e.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return 'Wrong email or password.';
  if (/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes and try again.';
  if (/network-request-failed/.test(c)) return 'No internet. The first sign-in on a phone needs the internet.';
  if (/email-already-in-use/.test(c)) return 'This email already has a login.';
  if (/weak-password/.test(c)) return 'Password must be at least 6 characters.';
  if (/user-disabled/.test(c)) return 'This login is switched off.';
  if (/permission-denied/.test(c)) return 'Not allowed. The security rules may not be published yet (see the setup guide).';
  return (e && e.message) || 'Something went wrong.';
};
const field = (label, name, type = 'text', attrs = '') => `<label class="fld"><span>${label}</span><input name="${name}" type="${type}" ${attrs}></label>`;

function gateConfig() {
  showGate(`<h1>One step left</h1><p class="gate-msg">This copy of the app is not connected to your Firebase project yet.</p>
    <ol class="gate-steps"><li>Open <b>firebase-config.js</b> in your GitHub repository.</li><li>Paste the <code>firebaseConfig</code> block from Firebase → Project settings → Your apps.</li><li>Save (commit) the file, wait one minute, and open this page again.</li></ol>`);
}
function gateLogin(msg, claimed) {
  showGate(`<form data-form="login" class="gate-form" novalidate><h1>Sign in</h1>
    ${field('Email', 'email', 'email', 'autocomplete="username" required')}${field('Password', 'pass', 'password', 'autocomplete="current-password" required')}
    <p class="gate-err" id="gErr">${esc(msg || '')}</p>
    <button class="btn primary" type="submit">Sign in</button>
    <button class="btn ghost" type="button" data-act="gForgot">Forgot password?</button>
    ${claimed === false ? `<div class="gate-sep"></div><p class="sm gate-msg">First time? Nobody has set up this app yet.</p><button class="btn" type="button" data-act="gOwner">Set up the owner account</button>` : ''}
  </form>`);
}
function gateOwner() {
  showGate(`<form data-form="owner" class="gate-form" novalidate><h1>Owner account</h1>
    <p class="gate-msg sm">You will be the admin. Use an email you can open, so you can reset the password if you forget it.</p>
    ${field('Your name', 'name', 'text', 'required autocomplete="name" value="Rushi"')}${field('Email', 'email', 'email', 'required autocomplete="username"')}
    ${field('Password', 'pass', 'password', 'required autocomplete="new-password" minlength="6"')}${field('Password again', 'pass2', 'password', 'required autocomplete="new-password"')}
    <p class="gate-err" id="gErr"></p><button class="btn primary" type="submit">Create owner account</button><button class="btn ghost" type="button" data-act="gBack">Back to sign in</button></form>`);
}
function gateClaim() {
  showGate(`<form data-form="claim" class="gate-form" novalidate><h1>Set up as owner</h1><p class="gate-msg">You are signed in as <b>${esc(ME.email)}</b>. Nobody owns this app yet. Make this login the admin?</p>
    ${field('Your name', 'name', 'text', 'required value="Rushi"')}<p class="gate-err" id="gErr"></p>
    <button class="btn primary" type="submit">Make me the admin</button><button class="btn ghost" type="button" data-act="signOut">Sign out</button></form>`);
}
function gateNoAccess() {
  showGate(`<h1>Almost there</h1><p class="gate-msg">You are signed in as <b>${esc(ME.email)}</b>, but the admin has not given this login access yet. Ask the admin to add you in <b>Users</b>.</p><button class="btn" data-act="reload">Check again</button><button class="btn ghost" data-act="signOut">Sign out</button>`);
}
function gateInactive() {
  showGate(`<h1>Login switched off</h1><p class="gate-msg">The admin has switched off <b>${esc(ME.email)}</b>. Ask the admin if this is a mistake.</p><button class="btn ghost" data-act="signOut">Sign out</button>`);
}
const GATE_SUBMIT = {
  async login(v) {
    if (!v.email || !v.pass) { gErr('Enter your email and password.'); return; }
    gBusy(); try { await CLOUD.signIn(v.email, v.pass); } catch (e) { gErr(authMsg(e)); }
  },
  async owner(v) {
    if (!v.name.trim() || !v.email.trim()) { gErr('Enter your name and email.'); return; }
    if ((v.pass || '').length < 6) { gErr('Password must be at least 6 characters.'); return; }
    if (v.pass !== v.pass2) { gErr('The two passwords are not the same.'); return; }
    gBusy(); Store.claiming = { name: v.name.trim(), email: v.email.trim() };
    try {
      const claimed = await CLOUD.ownerClaimed();
      if (claimed) { Store.claiming = null; gErr('An owner already exists. Sign in instead.'); return; }
      await CLOUD.createOwnerAccount(v.email, v.pass);
      await CLOUD.claimOwner({ name: v.name.trim(), email: v.email.trim().toLowerCase(), person: 'Rushi' });
    } catch (e) { gErr(authMsg(e)); } finally { Store.claiming = null; }
  },
  async claim(v) {
    if (!v.name.trim()) { gErr('Enter your name.'); return; }
    gBusy(); try { await CLOUD.claimOwner({ name: v.name.trim(), email: ME.email.toLowerCase(), person: 'Rushi' }); } catch (e) { gErr(authMsg(e)); }
  }
};

const profSig = p => [p.role, (p.sites || []).slice().sort().join(','), p.person || ''].join('|');
let profUnsub = null, appShown = false;
function resetSession() {
  if (Store.stop) { Store.stop(); Store.stop = null; }
  Object.assign(ME, { uid: '', email: '', name: '', role: '', sites: [], person: '', active: false });
  Store.all = new Map(); Store.cursors = {}; Store.meta = null; Store.metaLoaded = false; Store.firstSynced = false; Store.err = ''; Store.profSig = '';
  DB = blankDB(); BIN = []; ALLSITES = []; USERS = [];
  PAGE = 'dashboard'; try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  if (usersUnsub) { usersUnsub(); usersUnsub = null; }
}
async function onUser(u) {
  if (profUnsub) { profUnsub(); profUnsub = null; }
  if (!u) { resetSession(); appShown = false; gateLogin('', await CLOUD.ownerClaimed()); return; }
  ME.uid = u.uid; ME.email = u.email;
  const snap = await loadSnapshot(u.uid);
  Store.wseq = Store.bootSeq = Math.max(0, ...[...Store.all.values()].map(r => r.$pend || 0));
  if (snap && snap.me && snap.me.active && snap.me.uid === u.uid) {
    Object.assign(ME, snap.me); Store.profSig = profSig(ME); rebuild(); enterApp();
  } else showGate('<p class="gate-msg">Opening…</p>');
  profUnsub = CLOUD.watchProfile(u.uid, p => onProfile(p, u), e => { if (!appShown) showGate(`<p class="gate-msg">Could not read your login details: ${esc(authMsg(e))}</p><button class="btn" data-act="reload">Try again</button><button class="btn ghost" data-act="signOut">Sign out</button>`); });
}
async function onProfile(p, u) {
  if (!p) {
    if (Store.claiming) return;
    const c = await CLOUD.ownerClaimed();
    if (c === false) gateClaim(); else gateNoAccess();
    return;
  }
  if (!p.active) { if (Store.stop) { Store.stop(); Store.stop = null; } appShown = false; gateInactive(); return; }
  const sig = profSig(p), changed = Store.profSig && Store.profSig !== sig;
  Object.assign(ME, { name: p.name || u.email, email: p.email || u.email, role: p.role, sites: Array.isArray(p.sites) ? p.sites : [], person: p.person || '', active: true });
  if (changed) { Store.all = new Map(); Store.cursors = {}; Store.firstSynced = false; }
  Store.profSig = sig;
  rebuild(); persistSoon(); enterApp();
  if (changed || !Store.stop) startSync();
  if (isAdmin()) watchUsersList();
}
function enterApp() {
  hideGate();
  if (!appShown) { appShown = true; const h = (location.hash || '').slice(1); if (PAGES[h]) PAGE = h; }
  if (isMgr() && UI.site !== 'all' && !ME.sites.includes(UI.site)) UI.site = 'all';
  if (isMgr() && ME.person) UI.regPerson = ME.person;
  setSync(); render();
}
let USERS = [], usersUnsub = null;
function watchUsersList() { if (usersUnsub || !CLOUD.watchUsers) return; usersUnsub = CLOUD.watchUsers(list => { USERS = list; if (PAGE === 'users') scheduleRender(); }, () => {}); }
async function doSignOut() {
  const n = Store.pendingCount();
  if (n && !await confirmBox(`${n} change${n > 1 ? 's are' : ' is'} not uploaded yet. If you sign out now ${n > 1 ? 'they' : 'it'} may be lost. Sign out anyway?`, { ok: 'Sign out' })) return;
  closeModal();
  if (ME.uid) await IDB.del('snap:' + ME.uid);
  try { await CLOUD.signOut(); } catch (e) { location.reload(); }
}
/* theme: Auto / Light / Dark */
const THEME_KEY = 'vpem-theme';
function applyTheme() { let t = ''; try { t = localStorage.getItem(THEME_KEY) || ''; } catch (e) {} if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
function setTheme(t) { try { if (t) localStorage.setItem(THEME_KEY, t); else localStorage.removeItem(THEME_KEY); } catch (e) {} applyTheme(); render(); }
const curTheme = () => { try { return localStorage.getItem(THEME_KEY) || ''; } catch (e) { return ''; } };

(async function boot() {
  applyTheme();
  const cfg = window.FIREBASE_CONFIG;
  if (!window.VPEM_CLOUD_FACTORY && (!cfg || !cfg.apiKey || /PASTE|YOUR_/i.test(String(cfg.apiKey)))) { gateConfig(); return; }
  showGate('<p class="gate-msg">Opening…</p>');
  try { CLOUD = await (window.VPEM_CLOUD_FACTORY || createCloud)(cfg); }
  catch (e) { showGate(`<p class="gate-msg">The app could not start. The first time you open it on a phone, it needs the internet.</p><p class="muted sm">${esc(e && e.message || e)}</p><button class="btn primary" data-act="reload">Try again</button>`); return; }
  CLOUD.onAuth(onUser);
  if (window.VPEM_CLOUD_FACTORY) window.__vpem = { get DB() { return DB; }, Store, ME, UI, get BIN() { return BIN; } }; // automated tests only
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); }); });
    }).catch(() => {});
  }
})();
function showUpdate() { const t = $('#toast'); if ($('#updBar')) return; const el = document.createElement('button'); el.id = 'updBar'; el.className = 'toast upd'; el.dataset.act = 'reload'; el.textContent = 'A new version is ready. Tap to update.'; t.appendChild(el); }

/* ================= USERS (admin) ================= */
function pgUsers() {
  if (!isAdmin()) return '<div class="empty">Only the admin can manage users.</div>';
  const list = USERS.slice().sort((a, b) => (b.active !== false) - (a.active !== false) || ['admin', 'manager', 'accountant', 'viewer'].indexOf(a.role) - ['admin', 'manager', 'accountant', 'viewer'].indexOf(b.role) || natCmp(a.name, b.name));
  const sitesOf = u => u.role === 'manager' ? ((u.sites || []).map(siteName).join(', ') || '<span class="chip bad">No site</span>') : '<span class="muted">All sites</span>';
  return `<div class="scope"><b>People who can log in</b><span>Only the admin adds users, sets roles and assigns sites.</span></div>
  <div class="toolbar"><button class="btn primary" data-act="addUser">${svg('plus')}Add user</button><span class="grow"></span></div>
  <div class="card"><div class="tbl">${list.length ? `<table class="rt"><thead><tr><th>Name</th><th>Role</th><th>Sites</th><th>Cash book</th><th>Status</th></tr></thead><tbody>
  ${list.map(u => `<tr data-act="editUser" data-id="${esc(u.uid)}">${td('Name', `<span class="main">${esc(u.name || '')}</span><span class="sub">${esc(u.email || '')}</span>`, 'c1')}${td('Role', `<span class="chip ${u.role === 'admin' ? 'gold' : ''}">${esc(ROLE_LABEL[u.role] || u.role)}</span>`)}${td('Sites', sitesOf(u))}${td('Cash book', esc(u.person || '—'))}${td('Status', u.active === false ? '<span class="chip bad">Switched off</span>' : '<span class="chip good">Active</span>')}</tr>`).join('')}
  </tbody></table>` : '<div class="empty">Loading users…</div>'}</div></div>
  <section class="card"><div class="card-h"><h2>What each role can do</h2></div><div class="card-b"><dl class="kv roles">
    <dt>Admin</dt><dd>Everything: users, sites, setup, approve, delete, import and backup.</dd>
    <dt>Site Manager</dt><dd>Sees and adds entries only for the sites you assign. Sees only their own cash book. Their entries wait for your approval, and they cannot change an entry after it is approved.</dd>
    <dt>Accountant</dt><dd>Sees everything. Marks expenses and diesel bills as paid, and records vendor payments, owner payments and money given to cash holders.</dd>
    <dt>Viewer</dt><dd>Partners and owners: read-only dashboards, reports and statements.</dd></dl></div></section>`;
}
function formUser(rec) {
  const r = rec ? { ...rec } : { role: 'manager', sites: [], person: '', active: true };
  const self = rec && rec.uid === ME.uid;
  const people = uniq(DB.people.map(p => p.name));
  const siteBoxes = ALLSITES.map(s => `<label class="check"><input type="checkbox" name="site_${esc(s.id)}"${(r.sites || []).includes(s.id) ? ' checked' : ''}> ${esc(s.name)}${s.status === 'Completed' ? ' <span class="muted sm">(completed)</span>' : ''}</label>`).join('');
  openModal({
    title: rec ? 'Edit user' : 'Add user', saveLabel: rec ? 'Save' : 'Create login',
    body: `<div class="fgrid">${fld('Name', inp('name', r.name, 'required placeholder="e.g. Sahil"'))}
      ${fld('Email (login ID)', inp('email', r.email, `type="email" autocomplete="off" ${rec ? 'readonly' : 'required'}`))}
      ${rec ? '' : fld('Password <span class="hint">· at least 6 characters</span>', inp('pass', genPass(), 'autocomplete="off" required'))}
      ${fld('Role', sel('role', [['manager', 'Site Manager'], ['accountant', 'Accountant'], ['viewer', 'Viewer (partner / owner)'], ['admin', 'Admin']], r.role, self ? 'disabled' : ''))}
      ${fld('Cash book person <span class="hint">· whose cash book this login sees</span>', sel('person', [['', '— none —'], ...people], r.person))}
      ${rec ? fld('Status', seg('active', ['Active', 'Switched off'], r.active === false ? 'Switched off' : 'Active')) : ''}
      <div class="fld span2" id="uSites"><span>Sites this manager works on</span><div class="checks">${siteBoxes || '<span class="muted">Add sites in Setup first.</span>'}</div></div>
    </div>${self ? '<p class="muted sm">You cannot change your own role or switch yourself off.</p>' : ''}${rec ? `<p class="sm" style="margin:12px 0 0"><button type="button" class="btn sm" data-act="resetPass" data-v="${esc(r.email)}">Send password reset email</button></p>` : '<p class="muted sm">After saving, send the email and password to the person. They can change the password in My account.</p>'}`,
    onOpen: f => { $('#uSites').hidden = f.role.value !== 'manager'; },
    onChange: (e, f) => { if (e.target.name === 'role') $('#uSites').hidden = f.role.value !== 'manager'; },
    onSubmit: v => {
      const name = (v.name || '').trim(), email = (v.email || r.email || '').trim().toLowerCase();
      const role = self ? 'admin' : v.role;
      const sites = role === 'manager' ? ALLSITES.filter(s => v['site_' + s.id]).map(s => s.id) : [];
      if (!req(name, 'Enter the name') || !req(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'Enter a valid email')) return false;
      if (role === 'manager' && !sites.length) { toast('Tick at least one site for this manager'); return false; }
      if (role === 'manager' && !v.person) { toast('Choose whose cash book this manager sees'); return false; }
      const data = { name, email, role, sites, person: v.person || '', active: self ? true : v.active !== 'Switched off' };
      (async () => {
        try {
          let id = rec && rec.uid;
          if (!id) {
            if ((v.pass || '').length < 6) { toast('Password must be at least 6 characters'); return; }
            toast('Creating login…');
            id = await CLOUD.createUser(email, v.pass);
            data.createdAt = Date.now(); data.createdBy = ME.uid;
          }
          await CLOUD.saveUser(id, data);
          closeModal(); render();
          if (!rec) shareLogin(name, email, v.pass); else toast('User saved');
        } catch (e) { toast(authMsg(e)); }
      })();
      return false;
    }
  });
}
function genPass() { const w = ['plot', 'site', 'gold', 'navy', 'road', 'murum', 'jcb', 'waki']; return w[Math.floor(Math.random() * w.length)] + '-' + Math.floor(1000 + Math.random() * 9000); }
function shareLogin(name, email, pass) {
  const url = location.origin + location.pathname;
  const text = `*Veershree Plot Expense Manager*\nHi ${name}, here is your login.\nOpen: ${url}\nEmail: ${email}\nPassword: ${pass}\nOn iPhone: open the link in Safari → Share → Add to Home Screen.`;
  openModal({ title: 'Login created', size: 'narrow', body: `<p style="margin-top:0">Send these details to <b>${esc(name)}</b>:</p><pre class="txt">${esc(text)}</pre>`,
    extra: `<button type="button" class="btn left" data-act="copyTxt" data-v="${esc(text)}">${svg('copy')}Copy</button><a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">Send on WhatsApp</a>` });
}

/* ================= MY ACCOUNT ================= */
function pgAccount() {
  const t = curTheme();
  const [st, stTxt, stTitle] = syncState();
  return `<div class="grid2">
  <section class="card"><div class="card-h"><h2>${esc(ME.name)}</h2><span class="chip ${isAdmin() ? 'gold' : ''}">${esc(ROLE_LABEL[ME.role] || ME.role)}</span></div><div class="card-b"><dl class="kv">
    <dt>Email</dt><dd>${esc(ME.email)}</dd><dt>Sites</dt><dd>${isMgr() ? esc(ME.sites.map(siteName).join(', ') || 'None yet') : 'All sites'}</dd>
    <dt>Cash book</dt><dd>${esc(ME.person || '—')}</dd></dl>
    <div class="toolbar" style="margin-top:14px"><button class="btn" data-act="changePass">Change password</button><button class="btn danger" data-act="signOut">Sign out</button></div></div></section>
  <section class="card"><div class="card-h"><h2>Look</h2></div><div class="card-b"><div class="tabs" role="tablist">${[['', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button role="tab" aria-selected="${t === v}" data-act="theme" data-v="${v}">${l}</button>`).join('')}</div>
    <p class="muted sm" style="margin:10px 0 0">Auto follows your phone's dark mode setting.</p></div></section>
  <section class="card"><div class="card-h"><h2>Data on this device</h2><span class="sync" data-s="${st}">${esc(stTxt)}</span></div><div class="card-b">
    <p style="margin-top:0">${esc(stTitle)}</p>
    <dl class="kv"><dt>Entries on this device</dt><dd>${COLLS.reduce((a, c) => a + DB[c].length, 0).toLocaleString('en-IN')}</dd><dt>Waiting to upload</dt><dd>${Store.pendingCount()}</dd></dl>
    <p class="muted sm">The app works without network on site. Entries are kept on this phone and upload by themselves when the network is back.</p>
    <button class="btn" data-act="resync">Download everything again</button></div></section>
  <section class="card"><div class="card-h"><h2>Security check</h2></div><div class="card-b">
    ${isAdmin() ? '<p style="margin:0">As admin you are allowed everything. To test the rules, sign in on another phone as a manager, accountant or viewer and run this check there.</p>'
      : `<p style="margin-top:0">Tries a few things your role is <b>not</b> allowed to do, and confirms the online database refuses each one. Needs the internet.</p><button class="btn primary" data-act="secCheck">Run security check</button><div id="secOut" style="margin-top:12px"></div>`}
  </div></section></div>`;
}
function formChangePass() {
  openModal({ title: 'Change password', size: 'narrow', saveLabel: 'Change',
    body: `<div class="fgrid">${fld('Current password', '<input name="old" type="password" autocomplete="current-password" required>', 'span2')}${fld('New password', '<input name="n1" type="password" autocomplete="new-password" required>', 'span2')}${fld('New password again', '<input name="n2" type="password" autocomplete="new-password" required>', 'span2')}</div>`,
    onSubmit: v => {
      if ((v.n1 || '').length < 6) { toast('At least 6 characters'); return false; }
      if (v.n1 !== v.n2) { toast('The two new passwords are not the same'); return false; }
      CLOUD.changePassword(v.old, v.n1).then(() => { closeModal(); toast('Password changed'); }).catch(e => toast(authMsg(e)));
      return false;
    } });
}
async function securityCheck() {
  const out = $('#secOut'); if (!out) return;
  if (!navigator.onLine) { out.innerHTML = '<p class="chip bad">Connect to the internet first.</p>'; return; }
  const tests = [], tid = 'selftest-' + Date.now().toString(36);
  const T = (name, kind, fn) => tests.push({ name, kind, fn });
  const mk = (coll, site, extra) => ({ id: tid + '-' + tests.length, site, date: today(), amount: 1, desc: 'Security check (ignore)', _c: coll, _by: ME.uid, _byName: ME.name, _at: Date.now(), _appr: 'pending', _test: true, ...extra });
  const setOp = r => [{ type: 'set', path: entryPath(r._c, r), data: r }];
  const otherSite = ALLSITES.find(s => !siteVisible(s.id)), mySite = DB.sites[0];
  const anyEntry = [...DB.exp, ...DB.dsl].find(r => r.$p && !r.$xs);
  const otherPerson = DB.people.map(p => p.name).find(n => norm(n) !== norm(ME.person));
  const remarkProbe = r => ({ ops: [{ type: 'patch', path: r.$p, data: { remark: (r.remark || '') + ' ·' } }], undo: [{ type: 'patch', path: r.$p, data: { remark: r.remark || '' } }] });
  T('Change your own role to admin', 'w', () => ({ run: () => CLOUD.saveUser(ME.uid, { role: 'admin' }) }));
  T('Change Setup (sites, people, machines)', 'w', () => ({ run: () => CLOUD.saveMeta(Store.meta || { v: 1 }) }));
  T('See the list of all users', 'r', () => ({ run: () => CLOUD.probeRead('users') }));
  if (isMgr()) {
    if (otherSite) T(`Add an entry to a site that is not yours (${otherSite.name})`, 'w', () => ({ ops: setOp(mk('exp', otherSite.id)) }));
    if (otherSite) T(`Read entries of a site that is not yours (${otherSite.name})`, 'r', () => ({ run: () => CLOUD.probeRead('site', safeId(otherSite.id)) }));
    if (mySite) T('Add an entry that is already approved', 'w', () => ({ ops: setOp(mk('exp', mySite.id, { _appr: 'approved' })) }));
    if (mySite) T('Add an entry marked as deleted', 'w', () => ({ ops: setOp(mk('exp', mySite.id, { _del: true })) }));
    const appr = [...DB.exp, ...DB.dsl, ...DB.mlog].find(r => r._appr === 'approved' && r.$p && !r.$xs);
    if (appr) T('Change an approved entry', 'w', () => remarkProbe(appr));
    if (otherPerson) T(`Read ${otherPerson}'s cash book`, 'r', () => ({ run: () => CLOUD.probeRead('funds', otherPerson) }));
  } else {
    if (mySite) T('Add an expense', 'w', () => ({ ops: setOp(mk('exp', mySite.id, { _appr: 'approved' })) }));
    if (anyEntry) T('Change the details of an expense', 'w', () => remarkProbe(anyEntry));
    if (isViewer() && mySite) T('Record a vendor payment', 'w', () => ({ ops: setOp(mk('vpay', mySite.id, { vendor: 'Security check', _appr: 'approved' })) }));
  }
  out.innerHTML = '<p class="muted">Checking…</p>';
  const res = [];
  for (const t of tests) {
    const p = t.fn();
    const job = p.run ? p.run() : CLOUD.commit(p.ops);
    const r = await Promise.race([job.then(() => 'allowed', e => (e && e.code === 'permission-denied') ? 'blocked' : 'error:' + ((e && e.code) || 'unknown')), sleep(12000).then(() => 'timeout')]);
    if (r === 'allowed' && p.undo) { try { await CLOUD.commit(p.undo); } catch (e) {} }
    res.push({ name: t.name, r });
  }
  const bad = res.filter(x => x.r === 'allowed').length;
  out.innerHTML = `<div class="banner ${bad ? 'bad' : 'good'}">${bad ? `<b>${bad} problem${bad > 1 ? 's' : ''} found.</b> Tell Claude which line says "Allowed".` : `<b>All ${res.length} checks passed.</b> The online database refused everything your role should not do.`}</div>
    <div class="plist" style="margin-top:8px">${res.map(x => `<div class="prow"><span class="t">${esc(x.name)}</span><span class="a">${x.r === 'blocked' ? '<span class="chip good">Blocked</span>' : x.r === 'allowed' ? '<span class="chip bad">Allowed</span>' : x.r === 'timeout' ? '<span class="chip warn">No answer</span>' : `<span class="chip warn">${esc(x.r)}</span>`}</span></div>`).join('')}</div>`;
}

/* ================= FIRST START (admin, empty database) ================= */
function pgWelcome() {
  return `<div class="card"><div class="card-b welcome">
    <h2>Welcome, ${esc(ME.name)}</h2>
    <p>The online database is empty. Bring in the data from your current app first, so nothing is lost.</p>
    <ol class="gate-steps"><li>Open the <b>old</b> Plot Expense Manager on the phone where you entered your data.</li><li>Go to <b>Reports → Backup (.json)</b> and save the file.</li><li>Choose that file here. The app uploads it and then shows a check screen comparing every total.</li></ol>
    <div class="toolbar"><label class="btn primary file-btn">${svg('up')}Choose backup file (.json)<input type="file" accept=".json,application/json" data-file="restore"></label></div>
    <div class="gate-sep"></div>
    <p class="muted sm">No old data? Start with the standard lists: your 11 sites, 6 people, 15 expense heads and the Waki machine list.</p>
    <button class="btn" data-act="startFresh">Start with the standard lists</button>
  </div></div>`;
}
function startFresh() {
  const s = starterDB();
  Object.assign(DB, { settings: s.settings, sites: s.sites, people: s.people, cats: s.cats, machines: s.machines });
  saveMeta(); toast('Standard lists added'); render();
}

/* ================= IMPORT OLD BACKUP + CHECK ================= */
const valN = v => (v === '' || v == null) ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
const bizSame = (a, b) => { const ks = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => k[0] !== '_' && k[0] !== '$')); for (const k of ks) if (valN(a[k]) !== valN(b[k])) return false; return true; };
function dedupeIds(rows) {
  const seen = new Set(); let n = 0;
  const out = rows.map(r => { const k = docIdFor('x', r.id); if (seen.has(k)) { n++; const nr = { ...r, id: uid(), _origId: r.id }; seen.add(docIdFor('x', nr.id)); return nr; } seen.add(k); return r; });
  return { rows: out, n };
}
const KIND = { exp: 'Expenses', mlog: 'Machine log', dsl: 'Diesel bills', vpay: 'Vendor payments', opay: 'Owner payments', bill: 'Rent bills', fund: 'Money received' };
function importOldBackup(raw, fileName) {
  if (!isAdmin()) { toast('Only the admin can import.'); return; }
  if (!navigator.onLine || !Store.online) { toast('Connect to the internet to import, so the check can read everything back.'); return; }
  const inc = normalizeDB(raw.data);
  let dupes = 0;
  const plan = {};
  for (const c of COLLS) {
    const d = dedupeIds(inc[c]); inc[c] = d.rows; dupes += d.n;
    const inBackup = new Set();
    const p = { total: inc[c].length, add: [], upd: [], same: 0, binned: [], extra: [] };
    for (const r of inc[c]) {
      const k = keyOf(c, r); inBackup.add(k);
      const cur = Store.all.get(k);
      if (!cur || cur._movedTo) p.add.push(r);
      else if (cur._del) p.binned.push(r);
      else if (bizSame(cur, r)) p.same++;
      else p.upd.push(r);
    }
    for (const r of DB[c]) if (!inBackup.has(keyOf(c, r))) p.extra.push(r);
    plan[c] = p;
  }
  const emptyMeta = !Store.meta;
  const rows = COLLS.map(c => { const p = plan[c]; return `<tr>${td('Type', KIND[c], 'c1')}${td('In backup', p.total, 'n')}${td('New', p.add.length, 'n')}${td('Changed', p.upd.length, 'n')}${td('Same', p.same, 'n')}${td('Only in app', p.extra.length, 'n')}</tr>`; }).join('');
  const nWrite = COLLS.reduce((a, c) => a + plan[c].add.length + plan[c].upd.length, 0);
  openModal({
    title: 'Import ' + fileName, size: 'wide', saveLabel: 'Import and check',
    body: `<p style="margin-top:0">Backup made on <b>${esc(raw.exported ? fmtD(String(raw.exported).slice(0, 10)) : 'unknown date')}</b> · ${inc.sites.length} sites · ${inc.machines.length} machines · ${inc.people.length} people · ${inc.cats.length} heads.</p>
      <div class="tbl"><table class="rt"><thead><tr><th>Type</th><th class="n">In backup</th><th class="n">New</th><th class="n">Changed</th><th class="n">Same</th><th class="n">Only in app</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${dupes ? `<p class="banner">${dupes} entr${dupes > 1 ? 'ies' : 'y'} in the backup shared an ID with another entry. They get a new ID and keep the old one in "_origId". Nothing is dropped.</p>` : ''}
      <div class="fgrid" style="margin-top:12px">
        <label class="check span2" style="grid-column:1/-1"><input type="checkbox" name="masters"${emptyMeta ? ' checked disabled' : ''}> Use the backup's sites, people, expense heads, machines and settings${emptyMeta ? ' (first import)' : ' (replaces the current ones)'}</label>
        ${emptyMeta ? '' : `<label class="check span2" style="grid-column:1/-1"><input type="checkbox" name="exact"> Make the app match the backup exactly: entries only in the app go to the Recycle Bin${COLLS.some(c => plan[c].binned.length) ? ', deleted ones come back' : ''}</label>`}
      </div>
      <p class="muted sm">IDs and every field are kept as they are. Old entries come in as <b>Approved</b>. ${nWrite.toLocaleString('en-IN')} entries will be uploaded.${nWrite > 18000 ? ' <b>More than the free daily limit (20,000 writes): the rest uploads tomorrow.</b>' : ''}</p>`,
    onSubmit: v => {
      const masters = emptyMeta || !!v.masters, exact = !emptyMeta && !!v.exact;
      closeModal();
      runImport(inc, plan, { masters, exact, fileName });
      return false;
    }
  });
}
function progress(msg) {
  openModal({ title: 'Please wait', size: 'narrow', foot: false, body: `<p style="margin:0" id="progMsg">${esc(msg)}</p><p class="muted sm">Keep this screen open.</p>` });
  MODAL.onCloseX = null;
}
const setProg = msg => { const el = $('#progMsg'); if (el) el.textContent = msg; };
async function runImport(inc, plan, o) {
  progress('Saving sites, people, heads and machines…');
  try {
    if (o.masters) Object.assign(DB, { settings: inc.settings, sites: inc.sites, people: inc.people, cats: inc.cats, machines: inc.machines });
    else {
      const addMissing = (k) => { const have = new Set(DB[k].map(x => x.id)); inc[k].forEach(x => { if (!have.has(x.id)) DB[k].push(x); }); };
      ['sites', 'people', 'cats', 'machines'].forEach(addMissing);
    }
    await saveMeta();
    let done = 0; const total = COLLS.reduce((a, c) => a + plan[c].add.length + plan[c].upd.length + (o.exact ? plan[c].binned.length : 0), 0);
    for (const c of COLLS) {
      const list = [...plan[c].add, ...plan[c].upd, ...(o.exact ? plan[c].binned : [])].map(r => ({ ...r, _appr: r._appr || 'approved' }));
      for (let i = 0; i < list.length; i += 400) {
        setProg(`Uploading entries… ${done.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}${Store.online ? '' : ' (waiting for network)'}`);
        const ok = await writeRows(c, list.slice(i, i + 400));
        if (ok === false) throw new Error(Store.err || 'Upload stopped');
        done += Math.min(400, list.length - i);
      }
    }
    if (o.exact) {
      const extras = COLLS.flatMap(c => plan[c].extra.map(r => [c, r]));
      for (let i = 0; i < extras.length; i += 400) {
        setProg(`Moving ${extras.length} entries to the Recycle Bin…`);
        await Promise.all(extras.slice(i, i + 400).map(([c, r]) => patchRow(c, r, { _del: true, _delBy: ME.uid, _delByName: ME.name, _delAt: Date.now(), _delWhy: 'Not in backup ' + o.fileName })));
      }
    }
    await runCheck(inc, 'Import check', o.fileName);
  } catch (e) {
    closeModal();
    openModal({ title: 'Import stopped', size: 'narrow', body: `<p style="margin-top:0">${esc(e.message || e)}</p><p>Nothing already uploaded is lost. Fix the problem and import the same file again: entries already uploaded are skipped.</p>` });
  }
}
async function runCheck(oldData, title, fileName) {
  progress('Reading everything back from the online database…');
  let fresh;
  try {
    const keys = [...new Set(ALLSITES.map(s => safeId(s.id)))].concat('_nosite');
    const rows = await CLOUD.getAllServer(keys);
    const meta = await CLOUD.getMetaServer() || {};
    fresh = blankDB(); fresh.sites = meta.sites || []; fresh.people = meta.people || [];
    for (const r of rows) { if (r._test || r._movedTo || r._del || !fresh[r._c]) continue; fresh[r._c].push(r); }
  } catch (e) { closeModal(); toast('Could not read back: ' + (e.code || e.message)); return; }
  const A = OldCalc.summary(oldData), B = OldCalc.summary(fresh);
  const cmp = OldCalc.compare(A, B);
  closeModal();
  const ok = cmp.bad === 0;
  const cell = (a, b, f = inr) => OldCalc.eq(a, b) ? f(a) : `<span class="diff">${f(a)} → ${f(b)}</span>`;
  const mark = okk => okk ? '<span class="chip good">Match</span>' : '<span class="chip bad">Differs</span>';
  const siteRows = cmp.sites.map(s => `<tr>${td('Site', `<span class="main">${esc(s.name)}</span>`, 'c1')}${td('Expenses', cell(s.a.exp, s.b.exp), 'n')}${td('Diesel', cell(s.a.dsl, s.b.dsl), 'n')}${td('Rent bills', cell(s.a.rent, s.b.rent), 'n')}${td('Commission', cell(s.a.comm, s.b.comm), 'n')}${td('Vendor paid', cell(s.a.vpay, s.b.vpay), 'n')}${td('Owner paid', cell(s.a.opay, s.b.opay), 'n')}${td('Hours', cell(s.a.hrs, s.b.hrs, x => qty(x, 2)), 'n')}${td('Check', mark(s.ok))}</tr>`).join('');
  const headRows = cmp.heads.map(h => `<tr>${td('Head', esc(h.label), 'c1')}${td('Backup', inr(h.a), 'n')}${td('New app', inr(h.b), 'n')}${td('Check', mark(h.ok))}</tr>`).join('');
  const pplRows = cmp.people.map(p => `<tr>${td('Person', esc(p.name), 'c1')}${td('Received', cell(p.a.rec, p.b.rec), 'n')}${td('Spent', cell(p.a.spent, p.b.spent), 'n')}${td('Balance', cell(p.a.bal, p.b.bal), 'n')}${td('Check', mark(p.ok))}</tr>`).join('');
  const cntRows = cmp.counts.map(c => `<tr>${td('Type', KIND[c.k] || c.k, 'c1')}${td('Backup', c.a, 'n')}${td('New app', c.b, 'n')}${td('Check', mark(c.ok))}</tr>`).join('');
  const summaryText = `Veershree import check (${fmtD(today())})\nFile: ${fileName || ''}\nResult: ${ok ? 'ALL ' + cmp.n + ' CHECKS MATCH' : cmp.bad + ' of ' + cmp.n + ' checks differ'}\nTotal cost (expenses + diesel + full rent): backup ${inr(A.grand.cost)} · new app ${inr(B.grand.cost)}\nEntries: backup ${A.grand.n} · new app ${B.grand.n}`;
  openModal({
    title, size: 'wide',
    body: `<div class="banner ${ok ? 'good' : 'bad'}">${ok ? `<b>Everything matches.</b> All ${cmp.n} checks: totals per site, per head, per person and entry counts are exactly the same in the backup and in the online database.` : `<b>${cmp.bad} of ${cmp.n} checks differ.</b> Do not start using the new app yet. Send Claude a screenshot of the red lines.`}</div>
      <p class="muted sm">Rent here is the full bill amount, the way the old app counted it, so the two can be compared. The new Dashboard shows rent minus commission.</p>
      <h3 class="ck-h">Entries</h3><div class="tbl"><table class="rt"><thead><tr><th>Type</th><th class="n">Backup</th><th class="n">New app</th><th>Check</th></tr></thead><tbody>${cntRows}</tbody></table></div>
      <h3 class="ck-h">By site</h3><div class="tbl"><table class="rt"><thead><tr><th>Site</th><th class="n">Expenses</th><th class="n">Diesel</th><th class="n">Rent bills</th><th class="n">Commission</th><th class="n">Vendor paid</th><th class="n">Owner paid</th><th class="n">Hours</th><th>Check</th></tr></thead><tbody>${siteRows}</tbody>
        <tfoot><tr>${td('', 'Total', 'c1')}${td('Expenses', cell(A.grand.exp, B.grand.exp), 'n')}${td('Diesel', cell(A.grand.dsl, B.grand.dsl), 'n')}${td('Rent bills', cell(A.grand.rent, B.grand.rent), 'n')}${td('Commission', cell(A.grand.comm, B.grand.comm), 'n')}${td('Vendor paid', cell(A.grand.vpay, B.grand.vpay), 'n')}${td('Owner paid', cell(A.grand.opay, B.grand.opay), 'n')}${td('Hours', cell(A.grand.hrs, B.grand.hrs, x => qty(x, 2)), 'n')}${td('Check', '')}</tr></tfoot></table></div>
      <h3 class="ck-h">By head</h3><div class="tbl"><table class="rt"><thead><tr><th>Head</th><th class="n">Backup</th><th class="n">New app</th><th>Check</th></tr></thead><tbody>${headRows}</tbody></table></div>
      <h3 class="ck-h">Cash book</h3><div class="tbl"><table class="rt"><thead><tr><th>Person</th><th class="n">Received</th><th class="n">Spent</th><th class="n">Balance</th><th>Check</th></tr></thead><tbody>${pplRows}</tbody></table></div>`,
    extra: `<button type="button" class="btn left" data-act="copyTxt" data-v="${esc(summaryText)}">${svg('copy')}Copy result</button>`
  });
}


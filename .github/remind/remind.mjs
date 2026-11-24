/* =========================================================
   Reminder robot — runs on GitHub every 10 minutes.
   1. Signs in to Firebase as the "Reminder robot" login (read-only).
   2. After the reminder time (Site Manager → Menu → Supervisor reminders), for every
      supervisor and every site of theirs: if the day is not marked "Done for today" and
      not every working machine has a reading, it sends the supervisor's phones a reminder
      (again every 10 minutes) and tells the admin once.
   It never fails loudly: a problem is written to sm_botlog/last and the run ends normally,
   so GitHub does not send failure emails every 10 minutes.
   ========================================================= */
import webpush from 'web-push';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const RAW = (process.env.REMINDER_SECRET || '').trim();
if (!RAW) { log('No REMINDER_SECRET yet. Set it up in Site Manager → Menu → Supervisor reminders.'); process.exit(0); }

let C;
try { C = JSON.parse(RAW.startsWith('{') ? RAW : Buffer.from(RAW.replace(/\s+/g, ''), 'base64url').toString('utf8')); }
catch (e) { log('REMINDER_SECRET is not readable. Copy it again from the app.'); process.exit(0); }

const AUTH = process.env.AUTH_BASE || 'https://identitytoolkit.googleapis.com/v1/';
const FS = (process.env.FS_BASE || 'https://firestore.googleapis.com/v1/') + `projects/${C.project}/databases/(default)/documents/`;
const NOW = process.env.NOW_MS ? Number(process.env.NOW_MS) : Date.now();
const ist = new Date(NOW + 5.5 * 3600e3).toISOString();
const TODAY = ist.slice(0, 10), HM = ist.slice(11, 16);
let TOKEN = '';

/* ---------- Firestore REST ---------- */
const decode = v => {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeMap(v.mapValue.fields);
  return null;
};
const decodeMap = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));
const encode = x => x === null || x === undefined ? { nullValue: null }
  : typeof x === 'boolean' ? { booleanValue: x }
  : typeof x === 'number' ? (Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x })
  : typeof x === 'string' ? { stringValue: x }
  : Array.isArray(x) ? { arrayValue: { values: x.map(encode) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, encode(v)])) } };
const seg = p => p.split('/').map(encodeURIComponent).join('/');
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return j;
}
async function getDoc(path) {
  try { const j = await call('GET', FS + seg(path)); return decodeMap(j.fields); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
async function listDocs(coll) {
  const out = []; let page = '';
  do {
    const j = await call('GET', FS + seg(coll) + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
    for (const d of j.documents || []) out.push({ id: d.name.split('/').pop(), data: decodeMap(d.fields) });
    page = j.nextPageToken || '';
  } while (page);
  return out;
}
const setDoc = (path, data) => call('PATCH', FS + seg(path), { fields: encode(data).mapValue.fields });
const delDoc = path => call('DELETE', FS + seg(path)).catch(() => {});
async function machineNosOn(sk, date) {
  const j = await call('POST', FS + seg('sm_sites/' + sk) + ':runQuery', { structuredQuery: {
    from: [{ collectionId: 'entries' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: '_c' }, op: 'EQUAL', value: { stringValue: 'machineLog' } } },
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: date } } }] } },
    select: { fields: [{ fieldPath: 'machineNo' }, { fieldPath: '_del' }, { fieldPath: '_test' }] } } });
  const nos = new Set();
  for (const x of j) if (x.document) { const d = decodeMap(x.document.fields); if (!d._del && !d._test && d.machineNo) nos.add(norm(d.machineNo)); }
  return nos;
}
const norm = s => String(s || '').trim().toLowerCase();
const safeId = id => { let s = String(id == null ? '' : id).replace(/\//g, '_').trim(); if (/^__.*__$/.test(s)) s = 'x' + s; return s.slice(0, 600); };

/* ---------- push ---------- */
let SENT = 0;
async function sendTo(subs, msg) {
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.data.endpoint, keys: s.data.keys }, JSON.stringify(msg), { TTL: 3600, urgency: 'high', topic: String(msg.tag || 'remind').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
      SENT++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { log('removing an old phone', s.id); await delDoc('sm_push/' + s.id); }
      else log('push failed', s.id, e.statusCode || '', String(e.body || e.message).slice(0, 160));
    }
  }
}

async function main() {
  const si = await fetch(AUTH + 'accounts:signInWithPassword?key=' + encodeURIComponent(C.apiKey), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: C.email, password: C.password, returnSecureToken: true }) });
  const sj = await si.json().catch(() => ({}));
  if (!si.ok) { log('The robot could not sign in:', sj.error && sj.error.message); return; }
  TOKEN = sj.idToken;
  webpush.setVapidDetails(/^(https:|mailto:)/.test(C.subject || '') ? C.subject : 'https://github.com', C.vapidPublic, C.vapidPrivate);

  const R = await getDoc('sm_meta/remind') || {};
  const status = { at: NOW, today: TODAY, time: HM, ok: true, sent: 0, note: '' };
  const subs = await listDocs('sm_push');
  const subsOf = uid => subs.filter(s => s.data.uid === uid && s.data.endpoint);

  /* a test from the admin */
  const test = await getDoc('sm_botlog/test');
  if (test && test.uid && !test.doneAt && NOW - (test.at || 0) < 6 * 3600e3) {
    await sendTo(subsOf(test.uid), { title: 'Test reminder', body: 'Reminders work on this phone.', tag: 'test', url: C.subject });
    await setDoc('sm_botlog/test', { ...test, doneAt: NOW });
  }

  if (!R.on) { status.note = 'Reminders are off'; }
  else if (R.vapidPublic && R.vapidPublic !== C.vapidPublic) { status.ok = false; status.note = 'The GitHub key is older than the one in the app. Copy the new key to GitHub.'; }
  else if (HM < (R.time || '19:00') || HM > (R.until || '23:30')) { status.note = 'Outside the reminder time'; }
  else {
    const users = (await listDocs('users')).filter(u => u.data.active === true);
    const sups = users.filter(u => u.data.role === 'supervisor');
    const admins = users.filter(u => u.data.role === 'admin');
    const day = await getDoc('sm_botlog/' + TODAY) || {};
    const told = day.told || {};
    const sites = new Map();
    let checked = 0, behind = 0;
    for (const sup of sups) {
      for (const siteId of (sup.data.sites || [])) {
        const sk = safeId(siteId);
        if (!sites.has(sk)) sites.set(sk, await getDoc('sm_sites/' + sk));
        const site = sites.get(sk); if (!site) continue;
        checked++;
        const done = await getDoc('sm_days/' + sk + '_' + TODAY);
        if (done && done.done) continue;
        const working = (site.machines || []).filter(m => m && m.no && !m.removed);
        const have = await machineNosOn(sk, TODAY);
        const filled = working.filter(m => have.has(norm(m.no))).length, total = working.length;
        if (total && filled >= total) continue;
        behind++;
        const where = site.name || 'Your site';
        await sendTo(subsOf(sup.id), { title: "Fill today's machine readings", body: `${where}: ${filled} of ${total} machines filled. Fill the rest, or tap "Done for today" in the app.`, tag: 'sup-' + sk, url: C.subject + 'supervisor/' });
        const key = sup.id + '|' + sk;
        if (R.notifyAdmin !== false && !told[key]) {
          for (const a of admins) await sendTo(subsOf(a.id), { title: `${sup.data.name || 'A supervisor'} has not filled today's readings`, body: `${where}: ${filled} of ${total} machines filled by ${HM}.`, tag: 'adm-' + sk, url: C.subject });
          told[key] = NOW;
        }
      }
    }
    await setDoc('sm_botlog/' + TODAY, { told, at: NOW });
    status.note = `Checked ${checked} supervisor site${checked === 1 ? '' : 's'}, ${behind} not done`;
  }
  status.sent = SENT;
  await setDoc('sm_botlog/last', status);
  log(status.note, '· notifications sent:', SENT);
}

main().catch(async e => {
  log('Robot problem:', e.message);
  try { if (TOKEN) await setDoc('sm_botlog/last', { at: NOW, today: TODAY, time: HM, ok: false, sent: SENT, note: 'Problem: ' + String(e.message).slice(0, 200) }); } catch (x) { }
});

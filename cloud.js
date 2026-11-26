/* =========================================================
   Site Manager — cloud layer (Firebase)
   Login (email + password), user profiles, and offline-first sync.

   Firestore layout
     config/owner                          { uid }          who set the app up first
     users/{uid}                           { name, email, role, sites[], person, active }
     sm_meta/app                           managers, delete password, bill logo size
     sm_meta/logos                         logo, bill logo (pictures)
     sm_sites/{siteId}                     one site: name, machines, rates, masters, settings
     sm_sites/{siteId}/entries/{coll_id}   one machine entry / diesel bill / expense / payment / bill / murum / reminder
     sm_mfunds/{id}                        money given to a manager (also: money received, entered in the Manager app)
   Every document carries _u (server time of last change) and _ub (who changed it).
   Each phone keeps a full copy and downloads only what changed since last time.
   ========================================================= */
const SDK = (window.VPEM_SDK_BASE || 'https://www.gstatic.com/firebasejs/13.4.0/');
let F = null;
async function loadSDK() {
  if (F) return F;
  const [app, auth, fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
  F = { ...app, ...auth, ...fs };
  return F;
}
export const safeId = id => {
  let s = String(id == null ? '' : id).replace(/\//g, '_').trim();
  if (!s) s = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (/^__.*__$/.test(s)) s = 'x' + s;
  return s.slice(0, 600);
};
const toPlain = data => { const o = {}; for (const k in data) { const v = data[k]; o[k] = v && typeof v.toMillis === 'function' ? v.toMillis() : v; } return o; };

export async function createCloud(config) {
  const f = await loadSDK();
  const app = f.initializeApp(config);
  const auth = f.initializeAuth(app, { persistence: [f.indexedDBLocalPersistence, f.browserLocalPersistence] });
  let db;
  try { db = f.initializeFirestore(app, { localCache: f.persistentLocalCache({ tabManager: f.persistentMultipleTabManager() }), ignoreUndefinedProperties: true }); }
  catch (e) { db = f.initializeFirestore(app, { localCache: f.memoryLocalCache(), ignoreUndefinedProperties: true }); }
  const ref = path => f.doc(db, ...path.split('/'));
  let uid = '';
  return {
    kind: 'firebase',
    onAuth(cb) { return f.onAuthStateChanged(auth, u => { uid = u ? u.uid : ''; cb(u ? { uid: u.uid, email: u.email || '' } : null); }); },
    signIn: (email, pass) => f.signInWithEmailAndPassword(auth, email.trim(), pass),
    signOut: () => f.signOut(auth),
    resetPassword: email => f.sendPasswordResetEmail(auth, email.trim()),
    async changePassword(oldPass, newPass) {
      const u = auth.currentUser; if (!u) throw new Error('Not signed in');
      await f.reauthenticateWithCredential(u, f.EmailAuthProvider.credential(u.email, oldPass));
      await f.updatePassword(u, newPass);
    },
    createOwnerAccount: (email, pass) => f.createUserWithEmailAndPassword(auth, email.trim(), pass),
    async ownerClaimed() { try { const s = await f.getDocFromServer(ref('config/owner')); return s.exists() ? (s.data().uid || true) : false; } catch (e) { return null; } },
    async claimOwner(profile) {
      const u = auth.currentUser; if (!u) throw new Error('Not signed in');
      await f.setDoc(ref('config/owner'), { uid: u.uid, at: f.serverTimestamp() });
      await f.setDoc(ref('users/' + u.uid), { ...profile, role: 'admin', active: true, sites: [], createdAt: Date.now(), createdBy: u.uid });
    },
    watchProfile(id, cb, onErr) {
      return f.onSnapshot(ref('users/' + id), { includeMetadataChanges: true }, s => {
        if (!s.exists() && s.metadata.fromCache) return;
        cb(s.exists() ? { uid: id, ...toPlain(s.data()) } : null);
      }, e => onErr && onErr(e));
    },
    watchUsers(cb, onErr) { return f.onSnapshot(f.collection(db, 'users'), q => cb(q.docs.map(d => ({ uid: d.id, ...toPlain(d.data()) }))), e => onErr && onErr(e)); },
    /* a throw-away second Firebase instance, so the admin stays signed in while creating someone else's login */
    async createUser(email, pass) {
      const sec = f.initializeApp(config, 'add-user-' + Date.now());
      try {
        const sAuth = f.initializeAuth(sec, { persistence: f.inMemoryPersistence });
        const cred = await f.createUserWithEmailAndPassword(sAuth, email.trim(), pass);
        await f.signOut(sAuth);
        return cred.user.uid;
      } finally { try { await f.deleteApp(sec); } catch (e) {} }
    },
    saveUser: (id, data) => f.setDoc(ref('users/' + id), data, { merge: true }),
    async getDocServer(path) { const s = await f.getDocFromServer(ref(path)); return s.exists() ? toPlain(s.data()) : null; },
    /* everything, straight from the server (used by the import check) */
    async getAllServer() {
      const out = [];
      const add = (q, base) => q.docs.forEach(d => out.push({ path: base + d.id, data: toPlain(d.data()) }));
      const sites = await f.getDocsFromServer(f.collection(db, 'sm_sites'));
      add(sites, 'sm_sites/');
      for (const sd of sites.docs) add(await f.getDocsFromServer(f.collection(db, 'sm_sites', sd.id, 'entries')), 'sm_sites/' + sd.id + '/entries/');
      add(await f.getDocsFromServer(f.collection(db, 'sm_mfunds')), 'sm_mfunds/');
      add(await f.getDocsFromServer(f.collection(db, 'sm_meta')), 'sm_meta/');
      return out;
    },
    /* ops: {type:'set'|'patch', path, data}; every op is stamped with server time and the user.
       All batches are handed to Firestore at once, so they queue on the phone even offline. */
    async commit(ops) {
      const stamp = d => ({ ...d, _u: f.serverTimestamp(), _ub: uid });
      const run = list => {
        const b = f.writeBatch(db);
        for (const op of list) {
          if (op.type === 'set') b.set(ref(op.path), stamp(op.data));
          else if (op.type === 'patch') b.update(ref(op.path), stamp(op.data));
        }
        return b.commit();
      };
      const settle = async jobs => { const r = await Promise.allSettled(jobs); const bad = r.find(x => x.status === 'rejected'); if (bad) throw bad.reason; };
      const jobs = [];
      for (let i = 0; i < ops.length; i += 400) {
        const chunk = ops.slice(i, i + 400);
        /* a refused big batch is sent again in small pieces: the security rules allow only a few look-ups per request,
           and this also keeps one refused change from holding back the rest */
        jobs.push(run(chunk).catch(e => {
          if (!e || e.code !== 'permission-denied' || chunk.length <= 8) throw e;
          const small = []; for (let j = 0; j < chunk.length; j += 8) small.push(run(chunk.slice(j, j + 8)));
          return settle(small);
        }));
      }
      await settle(jobs);
    },
    waitPending: () => f.waitForPendingWrites(db),
    /* true: the current rules are published; false: older rules; null: could not tell (offline) */
    async rulesOk(v) { try { await f.getDocFromServer(ref('sm_rules/' + v)); return true; } catch (e) { return e && e.code === 'permission-denied' ? false : null; } },
    /* ---- used by the Supervisor app ---- */
    watchDoc(path, cb, onErr) {
      return f.onSnapshot(ref(path), { includeMetadataChanges: true }, s => cb(s.exists() ? toPlain(s.data({ serverTimestamps: 'estimate' })) : null, { fromCache: s.metadata.fromCache, pending: s.metadata.hasPendingWrites }), e => onErr && onErr(e));
    },
    /* one kind of entry (machineLog / dieselLog) of one site on one date — two equality filters, no extra index needed */
    watchDay(sk, coll, date, cb, onErr) {
      const q = f.query(f.collection(db, 'sm_sites', sk, 'entries'), f.where('_c', '==', coll), f.where('date', '==', date));
      return f.onSnapshot(q, { includeMetadataChanges: true }, snap => cb(snap.docs.map(d => ({ path: d.ref.path, data: toPlain(d.data({ serverTimestamps: 'estimate' })), pending: d.metadata.hasPendingWrites })), { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites }), e => onErr && onErr(e));
    },
    watchSites(cb, onErr) {
      return f.onSnapshot(f.collection(db, 'sm_sites'), snap => cb(snap.docs.map(d => ({ path: d.ref.path, data: toPlain(d.data({ serverTimestamps: 'estimate' })) }))), e => onErr && onErr(e));
    },
    async getDay(sk, coll, date) {
      const q = f.query(f.collection(db, 'sm_sites', sk, 'entries'), f.where('_c', '==', coll), f.where('date', '==', date));
      let snap; try { snap = await f.getDocs(q); } catch (e) { snap = await f.getDocsFromCache(q); }
      return snap.docs.map(d => ({ path: d.ref.path, data: toPlain(d.data({ serverTimestamps: 'estimate' })) }));
    },
    /* ---- used by the Manager app ---- */
    /* one person's entries on one site, whatever the capitals in "Paid by" (one field, no extra index needed) */
    watchPaidBy(sk, names, cb, onErr) {
      const q = f.query(f.collection(db, 'sm_sites', sk, 'entries'), f.where('paidBy', 'in', names.slice(0, 30)));
      return f.onSnapshot(q, { includeMetadataChanges: true }, snap => cb(snap.docs.map(d => ({ path: d.ref.path, data: toPlain(d.data({ serverTimestamps: 'estimate' })), pending: d.metadata.hasPendingWrites })), { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites }), e => onErr && onErr(e));
    },
    /* money given to one manager (the security rules allow a manager only his own name) */
    watchMfunds(person, cb, onErr) {
      const q = f.query(f.collection(db, 'sm_mfunds'), f.where('manager', '==', person));
      return f.onSnapshot(q, { includeMetadataChanges: true }, snap => cb(snap.docs.map(d => ({ path: d.ref.path, data: toPlain(d.data({ serverTimestamps: 'estimate' })), pending: d.metadata.hasPendingWrites })), { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites }), e => onErr && onErr(e));
    },
    async probeRead(kind, arg) {
      let q;
      if (kind === 'users') q = f.query(f.collection(db, 'users'), f.limit(1));
      else if (kind === 'site') q = f.query(f.collection(db, 'sm_sites', arg, 'entries'), f.limit(1));
      else if (kind === 'mfunds') q = f.query(f.collection(db, 'sm_mfunds'), f.where('manager', '==', arg), f.limit(1));
      return (await f.getDocsFromServer(q)).size;
    },
    /* plan = { all: bool, sites: [siteId] (when not all), person, cursors }
       h = { onDocs(key, changes, cursor, fromCache), onState({online}), onError(e, key) } */
    startSync(plan, h) {
      const unsubs = [], fromCache = new Map(), running = new Set();
      const state = () => h.onState({ online: navigator.onLine && fromCache.size > 0 && [...fromCache.values()].every(v => !v) });
      const changesOf = (snap, delta, curRef) => {
        const out = [];
        for (const c of snap.docChanges({ includeMetadataChanges: true })) {
          const d = c.doc, pending = d.metadata.hasPendingWrites;
          const u = d.get('_u');
          if (delta && !pending && u && typeof u.seconds === 'number' && (!curRef.c || u.seconds > curRef.c.s || (u.seconds === curRef.c.s && u.nanoseconds > curRef.c.n))) curRef.c = { s: u.seconds, n: u.nanoseconds };
          out.push({ type: c.type, path: d.ref.path, docId: d.id, data: toPlain(d.data({ serverTimestamps: 'estimate' }) || {}), pending });
        }
        return out;
      };
      const listenQuery = (key, q, delta) => {
        if (running.has(key)) return; running.add(key);
        const curRef = { c: plan.cursors && plan.cursors[key] ? { ...plan.cursors[key] } : null };
        const qq = delta ? f.query(q, f.where('_u', '>', curRef.c ? new f.Timestamp(curRef.c.s, curRef.c.n || 0) : new f.Timestamp(0, 0))) : q;
        unsubs.push(f.onSnapshot(qq, { includeMetadataChanges: true }, snap => {
          fromCache.set(key, snap.metadata.fromCache); state();
          h.onDocs(key, changesOf(snap, delta, curRef), delta ? curRef.c : null, snap.metadata.fromCache);
        }, e => h.onError(e, key)));
      };
      const listenDoc = (key, path) => {
        if (running.has(key)) return; running.add(key);
        unsubs.push(f.onSnapshot(ref(path), { includeMetadataChanges: true }, s => {
          fromCache.set(key, s.metadata.fromCache); state();
          if (!s.exists() && s.metadata.fromCache) return;
          h.onDocs(key, [{ type: s.exists() ? 'modified' : 'removed', path, docId: s.id, data: s.exists() ? toPlain(s.data({ serverTimestamps: 'estimate' })) : {}, pending: s.metadata.hasPendingWrites }], null, s.metadata.fromCache);
        }, e => h.onError(e, key)));
      };
      const entriesOf = sid => listenQuery('e:' + sid, f.collection(db, 'sm_sites', sid, 'entries'), true);
      listenDoc('m:app', 'sm_meta/app');
      listenDoc('m:logos', 'sm_meta/logos');
      if (plan.all) {
        /* every site; a site that appears later gets its entries listener at once */
        running.add('sites');
        unsubs.push(f.onSnapshot(f.collection(db, 'sm_sites'), { includeMetadataChanges: true }, snap => {
          fromCache.set('sites', snap.metadata.fromCache); state();
          h.onDocs('sites', changesOf(snap, false, {}), null, snap.metadata.fromCache);
          snap.docs.forEach(d => entriesOf(d.id));
        }, e => h.onError(e, 'sites')));
        listenQuery('mf', f.collection(db, 'sm_mfunds'), true);
      } else {
        for (const sid of plan.sites) { listenDoc('s:' + sid, 'sm_sites/' + sid); entriesOf(sid); }
        if (plan.person) listenQuery('mfp', f.query(f.collection(db, 'sm_mfunds'), f.where('manager', '==', plan.person)), false);
      }
      const on = () => state();
      window.addEventListener('online', on); window.addEventListener('offline', on);
      return () => { unsubs.forEach(u => { try { u(); } catch (e) {} }); window.removeEventListener('online', on); window.removeEventListener('offline', on); };
    }
  };
}

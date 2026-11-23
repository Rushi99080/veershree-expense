/* =========================================================
   Veershree Plot Expense Manager — cloud layer (Firebase)
   Login (email + password), user profiles, and offline-first sync.

   Firestore layout
     config/owner                    { uid, at }  — who set the app up first
     users/{uid}                     { name, email, role, sites[], person, active }
     meta/main                       { settings, sites, people, cats, machines }
     sites/{siteId}/entries/{docId}  one expense / machine log / diesel / payment / bill
     funds/{docId}                   money received by a cash holder (not tied to a site)
   Every entry carries _c (its type), _u (server time of last change) and _ub (who changed it).
   Each device keeps its own full copy and only downloads what changed since last time.
   ========================================================= */
const SDK = (window.VPEM_SDK_BASE || 'https://www.gstatic.com/firebasejs/13.4.0/');

let F = null; // loaded Firebase modules
async function loadSDK() {
  if (F) return F;
  const [app, auth, fs] = await Promise.all([
    import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')
  ]);
  F = { ...app, ...auth, ...fs };
  return F;
}

/* doc ids: never contain "/" and never collide between entry types */
export const safeId = id => {
  let s = String(id == null ? '' : id).replace(/\//g, '_').trim();
  if (!s) s = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (/^__.*__$/.test(s)) s = 'x' + s;
  return s.slice(0, 600);
};
export const docIdFor = (coll, id) => coll + '_' + safeId(id);

const toPlain = data => {
  const o = {};
  for (const k in data) {
    const v = data[k];
    o[k] = v && typeof v.toMillis === 'function' ? v.toMillis() : v;
  }
  return o;
};

export async function createCloud(config) {
  const f = await loadSDK();
  const app = f.initializeApp(config);
  const auth = f.initializeAuth(app, { persistence: [f.indexedDBLocalPersistence, f.browserLocalPersistence] });
  let db;
  try {
    db = f.initializeFirestore(app, { localCache: f.persistentLocalCache({ tabManager: f.persistentMultipleTabManager() }), ignoreUndefinedProperties: true });
  } catch (e) {
    db = f.initializeFirestore(app, { localCache: f.memoryLocalCache(), ignoreUndefinedProperties: true });
  }
  if (window.VPEM_EMULATOR) { // only used for local testing
    try { f.connectAuthEmulator(auth, 'http://' + window.VPEM_EMULATOR.auth, { disableWarnings: true }); f.connectFirestoreEmulator(db, ...window.VPEM_EMULATOR.fs.split(':').map((x, i) => i ? +x : x)); } catch (e) {}
  }
  const ref = path => f.doc(db, ...path.split('/'));
  let uid = '';

  const cloud = {
    kind: 'firebase',
    /* ---------- auth ---------- */
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
    async ownerClaimed() {
      try { const s = await f.getDocFromServer(ref('config/owner')); return s.exists() ? (s.data().uid || true) : false; }
      catch (e) { return null; }
    },
    async claimOwner(profile) {
      const u = auth.currentUser; if (!u) throw new Error('Not signed in');
      await f.setDoc(ref('config/owner'), { uid: u.uid, at: f.serverTimestamp() });
      await f.setDoc(ref('users/' + u.uid), { ...profile, role: 'admin', active: true, sites: [], createdAt: Date.now(), createdBy: u.uid });
    },
    /* ---------- profiles ---------- */
    watchProfile(id, cb, onErr) {
      return f.onSnapshot(ref('users/' + id), { includeMetadataChanges: true }, s => {
        if (!s.exists() && s.metadata.fromCache) return; // wait for the server before saying "no profile"
        cb(s.exists() ? { uid: id, ...toPlain(s.data()) } : null, s.metadata.fromCache);
      }, e => onErr && onErr(e));
    },
    watchUsers(cb, onErr) {
      return f.onSnapshot(f.collection(db, 'users'), q => cb(q.docs.map(d => ({ uid: d.id, ...toPlain(d.data()) }))), e => onErr && onErr(e));
    },
    /* Creating a login for someone else needs a second, throw-away Firebase instance,
       otherwise the admin would be signed out and signed in as the new person. */
    async createUser(email, pass) {
      const sec = f.initializeApp(config, 'add-user-' + Date.now());
      try {
        const sAuth = f.initializeAuth(sec, { persistence: f.inMemoryPersistence });
        if (window.VPEM_EMULATOR) try { f.connectAuthEmulator(sAuth, 'http://' + window.VPEM_EMULATOR.auth, { disableWarnings: true }); } catch (e) {}
        const cred = await f.createUserWithEmailAndPassword(sAuth, email.trim(), pass);
        await f.signOut(sAuth);
        return cred.user.uid;
      } finally { try { await f.deleteApp(sec); } catch (e) {} }
    },
    saveUser: (id, data) => f.setDoc(ref('users/' + id), data, { merge: true }),

    /* ---------- data ---------- */
    saveMeta: meta => f.setDoc(ref('meta/main'), { ...meta, _u: f.serverTimestamp(), _ub: uid }),
    async getMetaServer() { const s = await f.getDocFromServer(ref('meta/main')); return s.exists() ? toPlain(s.data()) : null; },
    async getDocServer(path) { const s = await f.getDocFromServer(ref(path)); return s.exists() ? toPlain(s.data()) : null; },
    /* full download straight from the server (used by the import check) */
    async getAllServer(siteKeys) {
      const out = [];
      for (const sk of siteKeys) {
        const q = await f.getDocsFromServer(f.collection(db, 'sites', sk, 'entries'));
        q.docs.forEach(d => out.push({ ...toPlain(d.data()), $p: 'sites/' + sk + '/entries/' + d.id }));
      }
      const q = await f.getDocsFromServer(f.collection(db, 'funds'));
      q.docs.forEach(d => out.push({ ...toPlain(d.data()), $p: 'funds/' + d.id }));
      return out;
    },
    /* ops: {type:'set'|'patch'|'delete', path, data}. Every set/patch is stamped with server time and the user.
       Resolves when the server has accepted every op (stays pending while offline). */
    async commit(ops) {
      const stamp = d => ({ ...d, _u: f.serverTimestamp(), _ub: uid });
      // every batch is handed to Firestore at once, so all of them are queued on the phone even when offline
      const jobs = [];
      for (let i = 0; i < ops.length; i += 400) {
        const b = f.writeBatch(db);
        for (const op of ops.slice(i, i + 400)) {
          if (op.type === 'set') b.set(ref(op.path), stamp(op.data));
          else if (op.type === 'patch') b.update(ref(op.path), stamp(op.data));
          else if (op.type === 'delete') b.delete(ref(op.path));
        }
        jobs.push(b.commit());
      }
      await Promise.all(jobs);
    },
    waitPending: () => f.waitForPendingWrites(db),
    /* used by the security check: tries a read the user should not be allowed to do */
    async probeRead(kind, arg) {
      let q;
      if (kind === 'users') q = f.query(f.collection(db, 'users'), f.limit(1));
      else if (kind === 'site') q = f.query(f.collection(db, 'sites', arg, 'entries'), f.limit(1));
      else if (kind === 'funds') q = f.query(f.collection(db, 'funds'), f.where('person', '==', arg), f.limit(1));
      return (await f.getDocsFromServer(q)).size;
    },

    /* Listeners. plan = { sites:[{key, mode:'all'|'paidBy'}], funds:'all'|'person'|'', person, cursors:{} }
       h = { onMeta(meta, fromCache), onDocs(key, changes, cursor), onState({online}), onError(e) } */
    startSync(plan, h) {
      const unsubs = [];
      const fromCache = new Map();
      const state = () => h.onState({ online: navigator.onLine && fromCache.size > 0 && [...fromCache.values()].every(v => !v) });
      const ts = c => c && typeof c.s === 'number' ? new f.Timestamp(c.s, c.n || 0) : null;
      const listen = (key, q, delta) => {
        let cur = plan.cursors && plan.cursors[key] ? { ...plan.cursors[key] } : null;
        const qq = delta && ts(cur) ? f.query(q, f.where('_u', '>', ts(cur))) : (delta ? f.query(q, f.where('_u', '>', new f.Timestamp(0, 0))) : q);
        unsubs.push(f.onSnapshot(qq, { includeMetadataChanges: true }, snap => {
          fromCache.set(key, snap.metadata.fromCache); state();
          const changes = [];
          for (const c of snap.docChanges({ includeMetadataChanges: true })) {
            const d = c.doc, data = d.data({ serverTimestamps: 'estimate' }) || {};
            const pending = d.metadata.hasPendingWrites;
            const u = d.get('_u');
            if (delta && !pending && u && typeof u.seconds === 'number' && (!cur || u.seconds > cur.s || (u.seconds === cur.s && u.nanoseconds > cur.n))) cur = { s: u.seconds, n: u.nanoseconds };
            changes.push({ type: c.type, path: d.ref.path, docId: d.id, data: toPlain(data), pending });
          }
          h.onDocs(key, changes, delta ? cur : null, snap.metadata.fromCache);
        }, e => { h.onError(e, key); }));
      };
      unsubs.push(f.onSnapshot(ref('meta/main'), { includeMetadataChanges: true }, s => {
        fromCache.set('meta', s.metadata.fromCache); state();
        if (s.metadata.hasPendingWrites) return;
        if (!s.exists() && s.metadata.fromCache) return;
        h.onMeta(s.exists() ? toPlain(s.data()) : null, s.metadata.fromCache);
      }, e => h.onError(e, 'meta')));
      for (const s of plan.sites) {
        const col = f.collection(db, 'sites', s.key, 'entries');
        if (s.mode === 'all') listen('s:' + s.key, col, true);
        else if (s.mode === 'paidBy' && plan.person) listen('x:' + s.key, f.query(col, f.where('paidBy', '==', plan.person)), false);
      }
      const fcol = f.collection(db, 'funds');
      if (plan.funds === 'all') listen('f', fcol, true);
      else if (plan.funds === 'person' && plan.person) listen('fp', f.query(fcol, f.where('person', '==', plan.person)), false);
      const on = () => state(), off = () => state();
      window.addEventListener('online', on); window.addEventListener('offline', off);
      return () => { unsubs.forEach(u => { try { u(); } catch (e) {} }); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
    }
  };
  return cloud;
}

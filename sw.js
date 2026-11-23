/* Offline app shell for Veershree Site Manager.
   The app's own files: network first (so updates show up), phone copy when there is no network.
   Firebase library and fonts: phone copy first (they never change).
   Login and database traffic is never touched here — Firebase keeps its own offline copy. */
const VERSION = 'vsm-3.0.2';
const CORE = ['./', 'index.html', 'sync.js?v=3.0.2', 'cloud.js?v=3.0.1', 'firebase-config.js?v=3', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];
const SDK = 'https://www.gstatic.com/firebasejs/13.4.0/';
const LIBS = [SDK + 'firebase-app.js', SDK + 'firebase-auth.js', SDK + 'firebase-firestore.js'];
const PASS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebaseinstallations|googleapis\.com\/(?!css)/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all([...CORE, ...LIBS].map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* only this app's old copies (and the retired Plot Expense build at this address) — other apps on the same website are left alone */
    for (const k of await caches.keys()) if ((k.startsWith('vsm-') || k.startsWith('vpem-')) && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
const timeout = (ms, p) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); }); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (PASS.test(url.href) && !url.href.startsWith(SDK)) return;
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin) {
    if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return; // other apps on this website: not ours
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      try {
        const res = await timeout(5000, fetch(req, { cache: 'no-cache' }));
        if (res && res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' ? await c.match('index.html') || await c.match('./') : null);
        return hit || Response.error();
      }
    })());
    return;
  }
  if (url.href.startsWith(SDK) || /fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }
      catch (err) { return Response.error(); }
    })());
  }
});

/* Offline app shell for the Veershree Supervisor app.
   Its own files and the shared ones one level up (cloud.js, firebase-config.js): network first, phone copy offline.
   Firebase library: phone copy first. Login and database traffic is never touched here. */
const VERSION = 'vsup-1.2.0';
const CORE = ['./', 'index.html', 'sup.js?v=1.2.0', '../cloud.js?v=3.1.0', '../ai.js?v=1.0.0', '../push.js?v=1.0.0', '../firebase-config.js?v=3', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];
const SDK = 'https://www.gstatic.com/firebasejs/13.4.0/';
const LIBS = [SDK + 'firebase-app.js', SDK + 'firebase-auth.js', SDK + 'firebase-firestore.js'];
const PASS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebaseinstallations|googleapis\.com\/(?!css)/;
const BASE = new URL('../', self.registration.scope).pathname;   // the Site Manager folder (shared files live there)

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all([...CORE, ...LIBS].map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('vsup-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
const timeout = (ms, p) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); }); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (PASS.test(url.href) && !url.href.startsWith(SDK)) return;
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(BASE)) return;
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
  if (url.href.startsWith(SDK)) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && res.ok) c.put(req, res.clone()); return res; }
      catch (err) { return Response.error(); }
    })());
  }
});

/* reminders from the reminder robot */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Reminder', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Reminder', {
    body: d.body || '', tag: d.tag || 'remind', renotify: true, requireInteraction: true,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: [500, 150, 500, 150, 900],
    data: { url: d.url || self.registration.scope }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(url) && 'focus' in c) return c.focus();
    return clients.openWindow(url);
  })());
});

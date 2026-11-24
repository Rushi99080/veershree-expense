/* =========================================================
   Reminders on the phone (web push) — Site Manager and Supervisor app
   The reminder robot (a GitHub schedule, see .github/remind) checks every
   10 minutes after the reminder time and sends these notifications.
   ========================================================= */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const p = t + '='.repeat((4 - t.length % 4) % 4); return Uint8Array.from(atob(p), c => c.charCodeAt(0)); };

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* what this phone can do: 'ok' | 'ios-home' (iPhone: add to Home Screen first) | 'no' (browser cannot) */
export function pushSupport() {
  if (window.SM_PUSH_MOCK) return window.SM_PUSH_MOCK.support();
  if (!('serviceWorker' in navigator)) return 'no';
  if (!('PushManager' in window) || !('Notification' in window)) return isIOS() && !isStandalone() ? 'ios-home' : 'no';
  return 'ok';
}
/* 'on' | 'off' | 'blocked' */
export async function pushState() {
  if (window.SM_PUSH_MOCK) return window.SM_PUSH_MOCK.state();
  if (pushSupport() !== 'ok') return 'off';
  if (Notification.permission === 'denied') return 'blocked';
  try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription(); return sub && Notification.permission === 'granted' ? 'on' : 'off'; }
  catch (e) { return 'off'; }
}
async function subId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return b64u(h).slice(0, 32);
}
/* ask for permission, subscribe this phone, and tell the online database where to send */
export async function enablePush(cloud, me, vapidPublic, app) {
  if (!vapidPublic) throw new Error('Reminders are not set up yet. The admin sets them up in Site Manager → Menu → Supervisor reminders.');
  let sub;
  if (window.SM_PUSH_MOCK) sub = await window.SM_PUSH_MOCK.subscribe(vapidPublic);
  else {
    const sup = pushSupport();
    if (sup === 'ios-home') throw new Error('On iPhone: tap Share → Add to Home Screen, open the app from the Home Screen, then turn reminders on.');
    if (sup !== 'ok') throw new Error('This browser cannot show reminders. Use Chrome on Android, or Safari on iPhone (from the Home Screen).');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this app. Allow them in the phone settings, then try again.' : 'Notifications were not allowed.');
    const reg = await navigator.serviceWorker.ready;
    const old = await reg.pushManager.getSubscription();
    if (old) { const k = old.options && old.options.applicationServerKey; if (k && b64u(k) !== vapidPublic) await old.unsubscribe(); }
    sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(vapidPublic) });
  }
  const j = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
  const id = await subId(j.endpoint);
  await cloud.commit([{ type: 'set', path: 'sm_push/' + id, data: { uid: me.uid, name: me.name || '', role: me.role || '', app, endpoint: j.endpoint, keys: j.keys, ua: navigator.userAgent.slice(0, 160), at: Date.now() } }]);
  return id;
}
/* a notification on this phone right now (checks that the phone shows them) */
export async function localTest(title, body) {
  if (window.SM_PUSH_MOCK) return window.SM_PUSH_MOCK.local(title, body);
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, { body, tag: 'test', icon: 'icons/icon-192.png', vibrate: [300, 120, 300] });
}
/* the robot's key pair (made once by the admin; the private half goes only to GitHub) */
export async function genVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { pub: b64u(raw), priv: jwk.d };
}
export const randomPass = (n = 28) => b64u(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
export const toB64u = s => b64u(new TextEncoder().encode(s));

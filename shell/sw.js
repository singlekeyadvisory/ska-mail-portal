/* Single Key Advisory Mail - service worker
   Strategy: network-first for the app shell + code parts so new deploys go live
   on the next load/relaunch, with a cached fallback for offline. Everything else
   (Supabase auth/API, Google, the mail runner) passes straight through and is
   never cached. */
const CACHE = 'ska-mail-v1';
const APP1 = 'https://app.singlekeyadvisory.com/app1.part';
const SHELL = [
  '/', '/app2.part', APP1,
  '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png', '/icon-maskable.png', '/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))
  ));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isShell(url) {
  if (url.href === APP1) return true;
  if (url.origin !== self.location.origin) return false;
  return url.pathname === '/' ||
         url.pathname === '/app2.part' ||
         url.pathname === '/manifest.webmanifest' ||
         /^\/(icon-192|icon-512|icon-maskable|apple-touch-icon)\.png$/.test(url.pathname);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;               // never touch POST/auth
  let url; try { url = new URL(req.url); } catch (_) { return; }
  const nav = req.mode === 'navigate';
  if (!nav && !isShell(url)) return;              // pass through Supabase/API/fonts/etc.

  const key = nav ? '/' : req;
  e.respondWith((async () => {
    try {
      const net = await fetch(req);
      if (net && net.ok) {
        const c = await caches.open(CACHE);
        c.put(key, net.clone()).catch(() => {});
      }
      return net;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = await c.match(key);
      if (hit) return hit;
      if (nav) { const idx = await c.match('/'); if (idx) return idx; }
      throw err;
    }
  })());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---- push notifications ---- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Single Key Advisory Mail';
  const opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        try { await c.focus(); } catch (_) {}
        if (url && url !== '/' && c.navigate) { try { await c.navigate(url); } catch (_) {} }
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

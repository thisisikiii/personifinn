// Offline shell: network first, cache as fallback. API calls are never cached here;
// app.js keeps the last state and the unsent transactions in localStorage.
const CACHE = 'pf-shell-v1';
const SHELL = ['/app', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || (url.origin === location.origin && url.pathname.startsWith('/api/'))) return;
  e.respondWith(
    fetch(e.request).then(res => {
      // opaque responses are the CDN scripts and fonts
      if (res.ok || res.type === 'opaque') caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res.clone();
    }).catch(() => caches.match(e.request).then(hit => hit ?? (e.request.mode === 'navigate' ? caches.match('/app') : Response.error())))
  );
});

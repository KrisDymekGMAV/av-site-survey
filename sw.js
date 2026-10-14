/* Service worker: caches the app so it opens with no signal. */
const CACHE = 'avss-v1.0.3';
const ASSETS = ['./', './index.html', './app.js', './styles.css', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  // cache: 'reload' bypasses the browser's HTTP cache, so a new version never stores old copies of the files.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google APIs etc. always go to the network
  if (req.mode === 'navigate') {
    // Network first (so updates arrive), fall back to the cached app when offline or on a weak signal.
    e.respondWith(timeout(fetch(req), 4000).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return r;
    }).catch(() => caches.match('./', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});

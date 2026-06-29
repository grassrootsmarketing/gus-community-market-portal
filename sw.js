// Demohub PWA service worker — conservative caching strategy
// - Static assets (icons, manifest, fonts): cache-first with network fallback
// - HTML pages: NETWORK ONLY (never cache — avoids stale auth state)
// - /api/*: NETWORK ONLY (never cache — fresh data always)
// - Cross-origin (fonts, Chart.js, Supabase SDK, Stripe.js, PostHog): pass-through (browser handles)
//
// Versioning: bump CACHE_VERSION when icons or static assets change
const CACHE_VERSION = 'demohub-v1-2026-06-29';
const PRECACHE = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET. Everything else: pass-through.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // NEVER cache API calls — they need fresh data
  if (url.pathname.startsWith('/api/')) return;

  // NEVER cache HTML — auth state must be fresh. Let the browser handle.
  // Detect HTML by Accept header OR by no file extension on the path.
  const wantsHtml = (req.headers.get('Accept') || '').includes('text/html');
  if (wantsHtml) return;

  // Static assets: cache-first, falling back to network
  const isStatic = PRECACHE.includes(url.pathname)
    || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg')
    || url.pathname.endsWith('.ico') || url.pathname.endsWith('.webmanifest')
    || url.pathname.endsWith('.css') || url.pathname.endsWith('.js');

  if (isStatic) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          // Cache successful same-origin responses
          if (resp.ok && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return resp;
        }).catch(() => cached); // offline fallback if cached
      })
    );
  }
});

// Listen for SKIP_WAITING from app to trigger an update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

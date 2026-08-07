/* kissd service worker.
 *
 * Hand-written rather than generated, because Vite's asset names are already
 * content-hashed — there is nothing a precache manifest would buy that a
 * cache-first rule on /assets/ doesn't. The three rules are:
 *
 *   navigation  → network-first, falling back to the cached shell when offline
 *   /assets/*   → cache-first (hashed filenames can never go stale)
 *   other GETs  → stale-while-revalidate (icons, manifest, favicon)
 *
 * Anything under /api/ or /ws is never touched: those are live, authenticated
 * and sometimes streamed, and a cached copy of them would be both wrong and a
 * small privacy leak.
 */

const SHELL = 'kissd-shell-v1';
const ASSETS = 'kissd-assets-v1';
const RUNTIME = 'kissd-runtime-v1';
const KEEP = [SHELL, ASSETS, RUNTIME];

const SHELL_URL = '/index.html';
// Hashed assets accumulate across deploys; keep the cache from growing forever.
const ASSET_LIMIT = 60;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Lets the page ask a waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  // keys() returns insertion order, so the front of the list is the oldest.
  await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((k) => cache.delete(k)));
}

// The shell is what makes the installed app open offline instead of showing
// the browser's dinosaur. API calls inside it will still fail, and the pages
// already render their own error state for that.
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL);
      cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: ASSETS });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSETS);
    await cache.put(request, response.clone());
    trim(ASSETS, ASSET_LIMIT).catch(() => {}); // housekeeping, never the caller's problem
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  const response = cached || (await network);
  if (!response) throw new Error('offline');
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

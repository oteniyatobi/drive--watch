// ==========================================
// DRIVERWATCH SERVICE WORKER — v2
// Network-first strategy: always fetches fresh code from server.
// Falls back to cache only when offline.
// activate event purges ALL old caches so no user is ever stuck.
// ==========================================

const CACHE_NAME = 'driverwatch-v5';
const ASSETS = [
    '/',
    '/index.html',
    '/login.html',
    '/style.css',
    '/app.js',
    '/login.js',
    '/map.js',
    '/supabase-config.js',
    '/favicon.png',
    '/manifest.json'
];

// INSTALL: pre-cache core assets
self.addEventListener('install', (event) => {
    self.skipWaiting(); // Activate immediately — don't wait for old tabs to close
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// ACTIVATE: delete ALL old caches so returning users always get fresh code
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) =>
            Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => {
                        console.log('[SW] Purging old cache:', name);
                        return caches.delete(name);
                    })
            )
        ).then(() => self.clients.claim()) // Take control of all open tabs immediately
    );
});

// Version-pinned libraries and the AI model never change at the same URL,
// so they are served from cache after the first visit (this is what makes reopening fast).
const CACHE_FIRST_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

function isCacheFirst(url) {
    return CACHE_FIRST_HOSTS.includes(url.hostname) ||
        (url.origin === self.location.origin && (url.pathname.startsWith('/model/') || url.pathname.startsWith('/assets/')));
}

// FETCH: cache-first for libraries/model, network-first for the app's own code.
self.addEventListener('fetch', (event) => {
    // Only handle GET requests for same-origin or cached assets
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    // Live data (Supabase, our API, map tiles) always goes straight to the network.
    if (url.pathname.startsWith('/api/')) return;
    if (url.origin !== self.location.origin && !CACHE_FIRST_HOSTS.includes(url.hostname)) return;

    if (isCacheFirst(url)) {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
                if (res && (res.ok || res.type === 'opaque')) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return res;
            }))
        );
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // Got a fresh response — update the cache in the background
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Network failed (offline) — serve from cache
                return caches.match(event.request);
            })
    );
});

// ==========================================
// DRIVERWATCH SERVICE WORKER — v2
// Network-first strategy: always fetches fresh code from server.
// Falls back to cache only when offline.
// activate event purges ALL old caches so no user is ever stuck.
// ==========================================

const CACHE_NAME = 'driverwatch-v2';
const ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/map.js',
    '/firebase-config.js',
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

// FETCH: Network-first. Always try the network; cache is only the offline fallback.
self.addEventListener('fetch', (event) => {
    // Only handle GET requests for same-origin or cached assets
    if (event.request.method !== 'GET') return;

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

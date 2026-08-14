// Service Worker for InsertaBot PWA
// Implements caching strategy and offline support

const CACHE_VERSION = 'v1';
const CACHE_NAME = `insertabot-${CACHE_VERSION}`;

// Assets to cache on install
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/index.js',
];

// Install event: cache critical assets
self.addEventListener('install', (event) => {
  console.log('[SW] Install event');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching assets on install');
      return cache.addAll(ASSETS_TO_CACHE).catch((error) => {
        console.warn('[SW] Failed to cache some assets:', error);
        // Continue even if some assets fail to cache
        return Promise.resolve();
      });
    })
  );
  // Take control immediately
  self.skipWaiting();
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate event');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Claim all clients immediately
  return self.clients.claim();
});

// Fetch event: implement caching strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests and non-GET methods
  if (url.origin !== location.origin || request.method !== 'GET') {
    return;
  }

  // Skip WebSocket and streaming requests
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // Network-first strategy for HTML and dynamic content
  if (request.destination === 'document' || url.pathname === '/') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache successful responses
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Fall back to cache when offline
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // Return offline fallback if needed
            return new Response('Offline: Unable to load content', { status: 503 });
          });
        })
    );
    return;
  }

  // Cache-first strategy for static assets (JS, CSS, fonts, etc.)
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'font' ||
    request.destination === 'image'
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request)
          .then((response) => {
            // Only cache successful responses
            if (response.ok) {
              const responseToCache = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, responseToCache);
              });
            }
            return response;
          })
          .catch(() => {
            // Return a default response for failed asset requests
            if (request.destination === 'image') {
              return new Response(
                '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect fill="#ccc" width="1" height="1"/></svg>',
                { headers: { 'Content-Type': 'image/svg+xml' } }
              );
            }
            return new Response('Offline: Asset unavailable', { status: 503 });
          });
      })
    );
    return;
  }

  // Default: network-first for everything else
  event.respondWith(
    fetch(request)
      .catch(() => {
        return caches.match(request).then((cachedResponse) => {
          return cachedResponse || new Response('Offline: Unable to load content', { status: 503 });
        });
      })
  );
});

// Handle messages from clients (optional: for future features)
self.addEventListener('message', (event) => {
  console.log('[SW] Received message:', event.data);

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('[SW] Cache cleared');
      event.ports[0].postMessage({ success: true });
    });
  }
});

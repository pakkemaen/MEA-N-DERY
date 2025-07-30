// A simple service worker for PWA installation and basic caching.

const CACHE_NAME = 'meandery-cache-v1';
const urlsToCache = [
  '/',
  '/MEA(N)DERY.html',
  // Add other assets like CSS or JS files if you have them
];

// Install the service worker and cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Serve cached content when offline
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request);
      }
    )
  );
});
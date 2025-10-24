// A simple service worker for PWA installation and basic caching.

const CACHE_NAME = 'meandery-cache-v2'; // Verhoog de versie voor een schone update
const urlsToCache = [
  '/',
  'index.html',
  'icon-192x192.png', // Voeg het icoon uit manifest.json toe
  'icon-512x512.png'  // Voeg het icoon uit manifest.json toe
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
        if (response) {
          return response; // Geef het antwoord uit de cache
        }
        return fetch(event.request); // Vraag het netwerk aan als het niet in de cache zit
      })
  );
});
const CACHE_NAME = 'meandery-cache-v3'; // Versie omhoog naar v3!

// We cachen alleen de bestanden die ZEKER bestaan.
// Als hier één bestand tussen staat dat niet bestaat, crasht de hele app-update.
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './secrets.js' 
  // Iconen tijdelijk weggehaald om crashes te voorkomen.
  // Voeg ze pas toe als je zeker weet dat de bestanden in de map staan!
];

// 1. Installeren en Cachen
self.addEventListener('install', event => {
  // Forceer de nieuwe service worker om meteen actief te worden
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
          console.error("Cache addAll failed. Waarschijnlijk bestaat een bestand niet:", err);
      })
  );
});

// 2. Oude caches opruimen (Activeer)
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('Oude cache verwijderd:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Neem controle over alle open tabbladen
});

// 3. Fetch (Netwerk eerst, dan Cache - Veiliger voor updates)
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Als netwerk lukt: update de cache met de nieuwe versie
        if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });
        return response;
      })
      .catch(() => {
        // Als netwerk faalt (offline): gebruik cache
        return caches.match(event.request);
      })
  );
});
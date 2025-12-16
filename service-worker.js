const CACHE_NAME = 'meandery-cache-v5'; // Versie opgehoogd naar v5

// ALLEEN bestanden die 100% zeker bestaan hierin zetten!
// Als er één mist, crasht je hele app-update.
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
  // './secrets.js' <--- UITGEZET VOOR DE ZEKERHEID (wordt later wel geladen door app.js)
];

self.addEventListener('install', event => {
  self.skipWaiting(); // Forceer directe activatie van de nieuwe versie
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caching essential files');
        // We gebruiken hier een trucje: als één bestand faalt, gaat de rest tenminste door
        return Promise.all(
          urlsToCache.map(url => {
            return cache.add(url).catch(err => {
              console.error('Kon bestand niet cachen (niet erg):', url, err);
            });
          })
        );
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Verwijder ALLE oude caches die niet v5 zijn
          if (cacheName !== CACHE_NAME) {
            console.log('Oude cache verwijderd:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Neem direct controle over de pagina
});

self.addEventListener('fetch', event => {
  // Netwerk-eerst strategie voor HTML en JS (zorgt dat je updates sneller ziet)
  if (event.request.mode === 'navigate' || event.request.destination === 'script') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
  } else {
    // Cache-eerst voor afbeeldingen en fonts (sneller laden)
    event.respondWith(
      caches.match(event.request)
        .then(response => response || fetch(event.request))
    );
  }
});
const CACHE_NAME = 'meandery-cache-v8-modular'; // Versie verhoogd voor de nieuwe structuur 🚀

// Lijst met bestanden die we willen bewaren voor offline gebruik
// CRUCIAAL: Alle nieuwe modules staan hier nu bij!
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './secrets.js',       
  './firebase-init.js', // Nieuw
  './app.js',           // De hoofd orchestrator
  './state.js',         // Nieuw
  './utils.js',         // Nieuw
  './brewing.js',       // Nieuw
  './inventory.js',     // Nieuw
  './tools.js',         // Nieuw
  './label-forge.js',   // Nieuw
  './logo.png',         // (Optioneel: als je die hebt, voeg toe)
  './favicon.png'       // (Optioneel: als je die hebt, voeg toe)
];

// 1. INSTALLATIE: Downloaden en Cachen
self.addEventListener('install', event => {
  // Zorg dat de nieuwe versie direct actief wordt
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache v7');
        // We gebruiken de "veilige" methode:
        // Als 1 bestand faalt (404), crasht NIET de hele installatie.
        return Promise.all(
          urlsToCache.map(url => {
            return cache.add(url).catch(err => {
              console.warn('Kon bestand niet cachen (niet erg, we gaan door):', url);
            });
          })
        );
      })
  );
});

// 2. ACTIVATIE: Oude rommel opruimen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Verwijder alles wat niet v7 is
          if (cacheName !== CACHE_NAME) {
            console.log('Oude cache verwijderd:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Neem direct de controle over
});

// 3. FETCH: Hoe halen we data op?
self.addEventListener('fetch', event => {
  // Voor HTML, JS en CSS: Probeer EERST het netwerk (altijd de nieuwste versie),
  // als dat faalt (offline), pak dan de cache.
  if (event.request.destination === 'document' || 
      event.request.destination === 'script' || 
      event.request.destination === 'style') {
      
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Als we online zijn: update de cache direct met de nieuwste versie
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Als we offline zijn: geef de cache
          return caches.match(event.request);
        })
    );
  } else {
    // Voor plaatjes en fonts: Eerst cache (sneller), dan netwerk
    event.respondWith(
      caches.match(event.request)
        .then(response => response || fetch(event.request))
    );
  }
});
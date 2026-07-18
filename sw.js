const CACHE_NAME = "avionase-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./board.js",
  "./ai.js",
  "./firebase-init.js",
  "./game-local.js",
  "./multiplayer.js",
  "./ship-shapes.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => { /* best effort — a missing asset shouldn't block install */ }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  // Never cache Firebase/Firestore traffic — the game needs live data, not
  // a stale offline snapshot of scores and matches.
  if (url.includes("googleapis.com") || url.includes("gstatic.com")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});

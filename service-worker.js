const SHELL_CACHE = "slco-protocols-shell-v2";
const RUNTIME_CACHE = "slco-protocols-runtime-v2";

// Everything needed for the app shell + navigation data + pdf.js to work
// offline. PDFs are cached lazily on first view (and eagerly via the
// Settings > Download All button) into RUNTIME_CACHE instead, since they're
// large and shouldn't block install.
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/pdfjs/pdf.min.mjs",
  "./js/pdfjs/pdf.worker.min.mjs",
  "./data/protocols.json",
  "./data/search-index.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // PDFs: cache-first, populate runtime cache on first successful fetch.
  if (url.pathname.includes("/pdfs/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
            }
            return res;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  // App shell + data: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

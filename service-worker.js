const SHELL_CACHE = "slco-protocols-shell-v4";
const RUNTIME_CACHE = "slco-protocols-runtime-v3";
// Procedure videos are only stored when the user saves them (player or
// Settings > Download All). Unversioned so protocol updates don't discard a
// large download; video files carry their own version in the file name and
// the app prunes old ones.
const VIDEO_CACHE = "slco-protocols-videos";

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
  "./data/videos.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" skips the browser's HTTP cache, so a new service worker
  // never pairs a fresh app.js with a stale index.html (or vice versa).
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: "reload" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== VIDEO_CACHE)
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

  // Videos: play from the saved copy if there is one, otherwise straight from
  // the network (never cached here: players fetch in partial ranges).
  if (url.pathname.includes("/videos/")) {
    event.respondWith(videoResponse(req));
    return;
  }

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

// <video> asks for byte ranges, and iOS won't play a response that ignores
// them, so a saved video is served as a 206 slice of the cached file.
async function videoResponse(req) {
  const cache = await caches.open(VIDEO_CACHE);
  const cached = await cache.match(req.url);
  if (!cached) return fetch(req);
  const range = req.headers.get("range");
  if (!range) return cached;
  const blob = await cached.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0;
  let end = size - 1;
  if (m && m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2]) {
    start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
  }
  if (!m || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

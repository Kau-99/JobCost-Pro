const CACHE = "jobcost-v36";
const ASSETS = [
  "./index.html",
  "./app.js",
  "./config.js",
  "./utils.js",
  "./db.js",
  "./firebase-config.js",
  "./styles.css",
  "./manifest.json",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.js",
  "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.allSettled(ASSETS.map((url) => c.add(url).catch(() => {}))),
      ),
  );
  /* Do NOT call skipWaiting() here — the update toast in the app handles it. */
});

self.addEventListener("message", (e) => {
  if (e.data?.action === "skipWaiting") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  /* Only handle GET requests */
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  /* Network-first for CDN scripts so updates are picked up */
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
    return;
  }

  /* Cache-first for local assets */
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      });
    }),
  );
});

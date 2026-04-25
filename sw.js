/* ═══════════════════════════════════════════════════════════
   JobCost Pro — Enterprise Service Worker
   Strategy:
     • Install   → strict pre-cache of App Shell only
     • Activate  → purge ALL stale caches, claim clients
     • Fetch     → Stale-While-Revalidate for shell + CDN libs
                   Network-First for external APIs
                   Pass-through for Firebase internals (they own their cache)
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME = "jobcost-pro-v5";

/* ── App Shell: must be available 100% offline ── */
const CORE_ASSETS = [
  "./index.html",
  "./app.js",
  "./config.js",
  "./utils.js",
  "./db.js",
  "./firebase-config.js",
  "./subscription.js",
  "./demoData.js",
  "./styles.css",
  "./manifest.json",
];

/* ─── INSTALL ────────────────────────────────────────────── */
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)),
  );
  /*
   * Do NOT call skipWaiting() here.
   * The in-app update toast sends the "skipWaiting" message
   * so the user controls when the new version activates.
   */
});

/* ─── MESSAGE (from app.js update toast) ────────────────── */
self.addEventListener("message", (e) => {
  if (e.data?.action === "skipWaiting") self.skipWaiting();
});

/* ─── ACTIVATE ───────────────────────────────────────────── */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => {
              console.log(`[SW] Purging old cache: ${k}`);
              return caches.delete(k);
            }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/* ─── HELPERS ────────────────────────────────────────────── */

/**
 * Firebase Firestore, Auth, and token endpoints manage their own
 * offline persistence (IndexedDB). Intercepting them breaks that
 * mechanism — let them pass through untouched.
 */
function isFirebaseInternal(url) {
  const h = url.hostname;
  return (
    h === "firestore.googleapis.com" ||
    h === "identitytoolkit.googleapis.com" ||
    h === "securetoken.googleapis.com" ||
    h === "apis.google.com" ||
    h.endsWith(".firebaseio.com") ||
    h.endsWith(".cloudfunctions.net")
  );
}

/** Static CDN libs (chart.js, jsPDF, Firebase SDK, etc.) */
function isCDNStatic(url) {
  return (
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "www.gstatic.com" ||   /* Firebase SDK */
    url.hostname === "cdnjs.cloudflare.com" ||
    url.hostname === "unpkg.com"
  );
}

/** Our own origin (App Shell files) */
function isLocalAsset(url) {
  return url.origin === self.location.origin;
}

/**
 * Stale-While-Revalidate
 * → Respond immediately from cache (fast)
 * → Fetch from network in background to refresh cache
 */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  /* Background revalidation — runs regardless of whether we had a cache hit */
  const revalidate = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  return cached ?? (await revalidate);
}

/**
 * Network-First with cache fallback
 * → Try network first (freshest data)
 * → On failure, fall back to cache
 * → Used for third-party APIs (geocoding, weather, holidays)
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    return (
      cached ??
      new Response(JSON.stringify({ error: "Network unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
}

/* ─── FETCH ──────────────────────────────────────────────── */
self.addEventListener("fetch", (e) => {
  /* Only intercept GET */
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  /* Only intercept http(s) */
  if (!url.protocol.startsWith("http")) return;

  /* ① Firebase internals — always pass through */
  if (isFirebaseInternal(url)) return;

  /* ② App Shell + CDN libs — Stale-While-Revalidate */
  if (isLocalAsset(url) || isCDNStatic(url)) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  /* ③ External APIs (geocoding, weather, holidays) — Network-First */
  e.respondWith(networkFirst(e.request));
});

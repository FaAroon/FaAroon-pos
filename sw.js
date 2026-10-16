const CACHE_NAME = "alawadly-v1";
const CORE_ASSETS = ["./index.html", "./style.css?v=202609011813", "./app.js", "./manifest.json"];
// Requests for our own app shell (not Firestore calls or CDN scripts) — these
// always skip the browser's HTTP cache and go straight to the network, so a
// new app.js reaches every device the moment it's uploaded, with no version
// number to bump anywhere.
const APP_FILE_NAMES = ["index.html", "app.js", "manifest.json", "style.css"];
function isAppFile(url) {
  const path = new URL(url).pathname;
  return APP_FILE_NAMES.some((name) => path.endsWith("/" + name) || path.endsWith(name));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for everything (Firestore calls, CDN scripts, app files) so data
// always stays live; falls back to the cached shell only if totally offline.
// For our own app files specifically, the network request also skips the
// browser's HTTP cache (cache: "no-store") and silently refreshes the
// offline-fallback copy on every successful load — so the fallback is never
// more than "as of the last time this device was online" stale, automatically.
self.addEventListener("fetch", (event) => {
  if (isAppFile(event.request.url)) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// The old periodic background check was removed: it signed in with Anonymous
// Auth (disabled for a long time, and refused by the current Firestore rules,
// which require a verified e-mail + password sign-in), so it could never work.

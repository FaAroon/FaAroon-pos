const CACHE_NAME = "faaroon-dev-v1";
const CORE_ASSETS = ["./index.html", "./style.css?v=202609011813", "./app.js", "./manifest.json"];
// The third-party scripts index.html needs before the app can even start (Tailwind,
// React, React-DOM, the QR reader). They used to be fetched from the internet on
// every open and never stored, so with no internet the app opened to a black screen.
// Now they are stored at install time and served from the cache (refreshed in the
// background whenever there is internet).
const CDN_SCRIPTS = [
  "https://cdn.tailwindcss.com",
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://unpkg.com/html5-qrcode",
];
// Requests for our own app shell (not Firestore calls or CDN scripts) — these
// always skip the browser's HTTP cache and go straight to the network, so a
// new app.js reaches every device the moment it's uploaded, with no version
// number to bump anywhere.
const APP_FILE_NAMES = ["index.html", "app.js", "manifest.json", "style.css"];
function isAppFile(url) {
  const path = new URL(url).pathname;
  return APP_FILE_NAMES.some((name) => path.endsWith("/" + name) || path.endsWith(name));
}
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

// Fetch a CDN script so it can be stored: normal (CORS) request first, plain
// (no-cors, opaque) request if the host does not allow CORS. Either kind works for a <script> tag.
function fetchCdn(url) {
  return fetch(url).catch(() => fetch(new Request(url, { mode: "no-cors" })));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS).catch(() => {});
      // One by one and independent: a failing CDN must not stop the others (or the install).
      await Promise.all(CDN_SCRIPTS.map((url) => fetchCdn(url).then((res) => cache.put(url, res)).catch(() => {})));
    }).catch(() => {})
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

function storable(response) {
  return response && (response.ok || response.type === "opaque");
}
function remember(key, response) {
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)).catch(() => {});
}

// Network first; if the network fails — or does not answer within waitMs (a Wi-Fi
// with no internet just hangs) and we have a stored copy — the stored copy is used.
// Only good answers are stored, so a 404 can never replace the working copy.
function networkFirst(request, fetchOptions, cacheKey, waitMs) {
  const net = fetch(request, fetchOptions).then((response) => {
    if (storable(response)) remember(cacheKey, response);
    return response;
  });
  const stored = () => caches.match(cacheKey);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const timer = waitMs ? setTimeout(() => stored().then((hit) => { if (hit) finish(resolve, hit); }), waitMs) : null;
    net.then(
      (response) => { clearTimeout(timer); finish(resolve, response); },
      (err) => {
        clearTimeout(timer);
        stored().then((hit) => (hit ? finish(resolve, hit) : finish(reject, err)));
      }
    );
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Firestore writes etc.: the page handles those (offline queue); not the service worker's business.
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Opening / reloading the app: the page itself. Always fall back to the stored index.html.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, { cache: "no-store" }, INDEX_URL, 4000).catch(() => Response.error()));
    return;
  }

  // Our own files: freshest copy from the network, stored copy when offline / unresponsive.
  if (url.origin === self.location.origin && isAppFile(request.url)) {
    event.respondWith(networkFirst(request, { cache: "no-store" }, request, 8000).catch(() => Response.error()));
    return;
  }

  // The stored third-party scripts: stored copy first (fast and works offline), refreshed in the background.
  if (CDN_SCRIPTS.includes(request.url)) {
    event.respondWith(
      caches.match(request.url).then((hit) => {
        const refresh = fetchCdn(request.url).then((res) => { if (storable(res)) remember(request.url, res); return res; });
        if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
        return refresh;
      }).catch(() => Response.error())
    );
    return;
  }

  // Everything else (icons, Firestore reads, ...): network first, stored copy if one exists.
  event.respondWith(
    fetch(request)
      .then((response) => { if (url.origin === self.location.origin && storable(response)) remember(request, response); return response; })
      .catch(() => caches.match(request).then((hit) => hit || Response.error()))
  );
});

// The old periodic background check was removed: it signed in with Anonymous
// Auth (disabled for a long time, and refused by the current Firestore rules,
// which require a verified e-mail + password sign-in), so it could never work.

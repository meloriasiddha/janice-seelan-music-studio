// Offline support: the app shell is cached on install; instrument samples and fonts
// are cached the first time they are used. Bump VERSION after changing app files.
const VERSION = "hs-1.0.1";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "vendor/lame.min.js",
  "js/app.js", "js/ui.js", "js/engine.js", "js/store.js", "js/pitch.js", "js/recorder.js", "js/export.js", "js/tunes.js", "js/panels.js", "js/instruments.js",
  "samples/manifest.json", "icons/icon-192.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== "hs-samples").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Samples and fonts never change: cache first.
  if (url.pathname.includes("/samples/") && !url.pathname.endsWith("manifest.json") || url.host.includes("fonts.g")) {
    e.respondWith(caches.open("hs-samples").then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const res = await fetch(e.request); if (res.ok || res.type === "opaque") c.put(e.request, res.clone()); return res;
    }));
    return;
  }
  // App files: network first so updates arrive, cache when offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
  }
});

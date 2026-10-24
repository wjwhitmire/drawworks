// Service worker: caches the app shell only (this page, its icons, fonts and manifest) so the scheduler opens
// offline. It never sees schedules, which live in IndexedDB, and never touches other hosts.
const CACHE = "cpm-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-maskable.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
  "./fonts/fira-sans-latin-400-normal.woff2", "./fonts/fira-sans-latin-500-normal.woff2", "./fonts/fira-sans-latin-600-normal.woff2",
  "./fonts/fira-sans-latin-700-normal.woff2", "./fonts/fira-mono-latin-400-normal.woff2", "./fonts/fira-mono-latin-500-normal.woff2",
  "./fonts/sofia-sans-condensed-latin-wght-normal.woff2"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); }
      return r;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  const name = url.pathname.split("/").pop();
  const path = (url.pathname.includes("/fonts/") ? "./fonts/" : "./") + name;
  if (SHELL.includes(path)) e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});

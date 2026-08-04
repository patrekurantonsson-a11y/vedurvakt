/* Veðurvakt — offline support.
 *
 * Deliberately network-first for everything. A cache-first worker is faster but
 * can serve yesterday's JavaScript for days, which is a miserable thing to
 * debug; here the network always wins when it answers, and the cache only
 * stands in when it does not. The practical effect: open the app with no
 * signal and you still get the page and the last forecast it managed to fetch,
 * with the age shown on screen as always.
 */

const CACHE = "vedurvakt-v1";

const SHELL = [
  "./",
  "./index.html",
  "./samanburdur.html",
  "./skilmalar.html",
  "./personuvernd.html",
  "./heimildir.html",
  "./style.css",
  "./common.js",
  "./app.js",
  "./compare.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {})            // a missing file must not block installing
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Map tiles and forecast APIs are somebody else's; leave them alone.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});

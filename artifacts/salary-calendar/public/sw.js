/* eslint-disable no-restricted-globals */
// Salary-calendar service worker. Caches:
//  - OSM tiles (CartoCDN basemaps + nominatim) — cache-first, very long-lived
//  - OSRM /route and /table responses — cache-first
//  - App shell (HTML/JS/CSS) — network-first; falls back to cache when offline
// Bumping VERSION purges old caches.

const VERSION = "v3";
const TILES_CACHE = `tiles-${VERSION}`;
const ROUTING_CACHE = `routing-${VERSION}`;
const APP_CACHE = `app-${VERSION}`;

const TILE_HOST_RE = /basemaps\.cartocdn\.com|tile\.openstreetmap\.org/;
const ROUTING_HOST_RE = /router\.project-osrm\.org|nominatim\.openstreetmap\.org/;

self.addEventListener("install", (event) => {
  // Activate immediately so new worker takes over without manual reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) => k !== TILES_CACHE && k !== ROUTING_CACHE && k !== APP_CACHE,
          )
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "PREFETCH_TILES") {
    event.waitUntil(prefetchTiles(data.urls || [], event.source));
  } else if (data.type === "PREFETCH_ROUTES") {
    event.waitUntil(prefetchRoutes(data.urls || []));
  } else if (data.type === "CACHE_INFO") {
    event.waitUntil(reportCacheInfo(event.source));
  } else if (data.type === "CLEAR_TILES") {
    event.waitUntil(caches.delete(TILES_CACHE));
  }
});

async function reportCacheInfo(client) {
  try {
    const tilesCache = await caches.open(TILES_CACHE);
    const tileKeys = await tilesCache.keys();
    const routingCache = await caches.open(ROUTING_CACHE);
    const routingKeys = await routingCache.keys();
    if (client) {
      client.postMessage({
        type: "CACHE_INFO",
        tiles: tileKeys.length,
        routes: routingKeys.length,
      });
    }
  } catch {}
}

async function prefetchTiles(urls, client) {
  const cache = await caches.open(TILES_CACHE);
  let done = 0;
  let failed = 0;
  const queue = urls.slice();
  const concurrency = 6;
  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      try {
        const existing = await cache.match(url);
        if (existing) {
          done += 1;
        } else {
          const res = await fetch(url, { mode: "cors" });
          if (res.ok) {
            await cache.put(url, res.clone());
            done += 1;
          } else {
            failed += 1;
          }
        }
      } catch {
        failed += 1;
      }
      if (client && (done + failed) % 25 === 0) {
        client.postMessage({
          type: "PREFETCH_PROGRESS",
          done,
          failed,
          total: urls.length,
        });
      }
    }
  }
  const workers = [];
  for (let i = 0; i < concurrency; i += 1) workers.push(worker());
  await Promise.all(workers);
  if (client) {
    client.postMessage({
      type: "PREFETCH_COMPLETE",
      done,
      failed,
      total: urls.length,
    });
  }
}

async function prefetchRoutes(urls) {
  const cache = await caches.open(ROUTING_CACHE);
  await Promise.all(
    urls.map(async (url) => {
      try {
        const existing = await cache.match(url);
        if (existing) return;
        const res = await fetch(url);
        if (res.ok) await cache.put(url, res.clone());
      } catch {}
    }),
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  if (TILE_HOST_RE.test(url.host)) {
    event.respondWith(cacheFirst(req, TILES_CACHE));
    return;
  }
  if (ROUTING_HOST_RE.test(url.host)) {
    event.respondWith(cacheFirstWithRefresh(req, ROUTING_CACHE));
    return;
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (hit) return hit;
    return new Response("offline", { status: 503, statusText: "offline" });
  }
}

async function cacheFirstWithRefresh(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) {
    // Soft-refresh in the background so cache stays warm.
    fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
      })
      .catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return new Response(JSON.stringify({ code: "Offline" }), {
      status: 599,
      headers: { "content-type": "application/json" },
    });
  }
}

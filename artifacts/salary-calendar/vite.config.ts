import { defineConfig, type Plugin, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Proxy `/_tiles/openfreemap/*` → https://tiles.openfreemap.org/* in BOTH the
// Vite dev server and the `vite preview` server, so 3D map tiles work even on
// networks where the upstream Cloudflare host is unreachable (RU + some ISPs).
function openFreeMapProxyPlugin(): Plugin {
  const UPSTREAM = "https://tiles.openfreemap.org";
  const PREFIX = "/_tiles/openfreemap";

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return next();
    const upstreamUrl = UPSTREAM + req.url.slice(PREFIX.length);
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          // Forward only safe headers; drop cookies/auth.
          "user-agent": "salary-calendar-3dmap-proxy/1.0",
          "accept-encoding": "identity",
        },
      });
      res.statusCode = upstreamRes.status;
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      const cc = upstreamRes.headers.get("cache-control");
      if (cc) res.setHeader("cache-control", cc);
      res.setHeader("access-control-allow-origin", "*");
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(
        `OpenFreeMap proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    name: "openfreemap-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// Proxy raster OSM tiles via several mirrors. Used as the primary basemap
// because it's the most reliable global source — vector styles (OpenFreeMap
// liberty / positron) have been tripping over expression evaluation errors on
// recent tile versions, leaving the canvas blank. Raster tiles can never
// have that class of problem: they're just PNGs.
//
// The path scheme is `/_tiles/osm/{mirror}/{z}/{x}/{y}.png` where {mirror} is
// one of: `a`, `b`, `c` (the standard OSM tile.openstreetmap.org sub-domains).
// We round-robin between them on the client to spread load and stay within
// OSM's tile usage policy.
function osmTileProxyPlugin(): Plugin {
  const PREFIX = "/_tiles/osm";
  const MIRRORS: Record<string, string> = {
    a: "https://a.tile.openstreetmap.org",
    b: "https://b.tile.openstreetmap.org",
    c: "https://c.tile.openstreetmap.org",
  };

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return next();
    const rest = req.url.slice(PREFIX.length); // /a/14/9574/4769.png
    const match = rest.match(/^\/([abc])(\/.+)$/);
    if (!match) return next();
    const upstreamUrl = MIRRORS[match[1]] + match[2];
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          // OSM Tile Usage Policy requires a meaningful, identifying UA so
          // operators can contact us if there's a problem.
          "user-agent":
            "spb-courier-navigator/1.0 (self-hosted; contact via app)",
          "accept-encoding": "identity",
        },
      });
      res.statusCode = upstreamRes.status;
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      // Tiles change rarely; cache aggressively so the courier can re-use
      // them between sessions / when bouncing between stairwells.
      res.setHeader("cache-control", "public, max-age=604800, immutable");
      res.setHeader("access-control-allow-origin", "*");
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(
        `OSM proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    name: "osm-tile-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// Proxy Mapillary vector tiles via the same-origin Replit domain. Direct
// requests to `tiles.mapillary.com` fail with ERR_NAME_NOT_RESOLVED on
// many Russian ISPs (the host sits behind Cloudflare which is partially
// blocked there). Same trick as the openFreeMap proxy above.
//
// Path scheme: `/_tiles/mapillary/{rest}` → `https://tiles.mapillary.com/{rest}`.
function mapillaryTileProxyPlugin(): Plugin {
  const UPSTREAM = "https://tiles.mapillary.com";
  const PREFIX = "/_tiles/mapillary";

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return next();
    const upstreamUrl = UPSTREAM + req.url.slice(PREFIX.length);
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          "user-agent": "salary-calendar-mapillary-proxy/1.0",
          "accept-encoding": "identity",
        },
      });
      res.statusCode = upstreamRes.status;
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      // Tiles are content-addressed, cache hard.
      res.setHeader("cache-control", "public, max-age=86400");
      res.setHeader("access-control-allow-origin", "*");
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(
        `Mapillary tile proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    name: "mapillary-tile-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// Proxy the Mapillary Graph API the same way. Used as a fallback path
// for the street-view image search; also handy if we later add features
// that depend on Graph endpoints. Path: `/_api/mapillary/{rest}` →
// `https://graph.mapillary.com/{rest}`.
function mapillaryGraphProxyPlugin(): Plugin {
  const UPSTREAM = "https://graph.mapillary.com";
  const PREFIX = "/_api/mapillary";

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return next();
    const upstreamUrl = UPSTREAM + req.url.slice(PREFIX.length);
    const incomingAuth = req.headers["authorization"];
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          "user-agent": "salary-calendar-mapillary-proxy/1.0",
          "accept-encoding": "identity",
          ...(typeof incomingAuth === "string"
            ? { authorization: incomingAuth }
            : {}),
        },
      });
      res.statusCode = upstreamRes.status;
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      res.setHeader("cache-control", "no-cache");
      res.setHeader("access-control-allow-origin", "*");
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(
        `Mapillary graph proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    name: "mapillary-graph-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Yandex panorama proxies.
//
// The browser cannot embed `www.mapillary.com` (DNS-blocked at most
// Russian ISPs) and the official Yandex map widget hits per-IP rate
// limits on its internal panorama lookup (`api-maps.yandex.ru` returns
// 429 when many users share an upstream NAT). To dodge both problems we
// build our own viewer and route every Yandex request through this
// origin: the browser only ever talks to us; Yandex sees a single
// server-side IP that we cache aggressively.
//
//   GET /_api/yandex-pano?ll=lng,lat
//   GET /_api/yandex-pano?oid=<panorama-id>
//       → https://api-maps.yandex.ru/services/panoramas/1.x/?…
//       Returns the panorama metadata JSON (image id, tile zooms,
//       neighbouring panoramas, historical versions).
//       Server-side LRU-ish cache (200 entries, 24 h TTL) so repeated
//       lookups for the same point/oid are free.
//
//   GET /_tiles/yandex-pano/{imageId}/{z}.{x}.{y}
//       → https://pano.maps.yandex.net/{imageId}/{z}.{x}.{y}
//       Equirectangular tile JPEGs (256×256). Content-addressed by
//       imageId, so we set strong long-lived cache headers.
// ──────────────────────────────────────────────────────────────────────────

type CacheEntry = { value: { status: number; body: Buffer; ct: string }; expiresAt: number };

function makeLruCache(maxEntries: number) {
  const map = new Map<string, CacheEntry>();
  return {
    get(key: string): CacheEntry["value"] | null {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt < Date.now()) {
        map.delete(key);
        return null;
      }
      // Re-insert to mark as most-recently-used.
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key: string, value: CacheEntry["value"], ttlMs: number) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}

function yandexPanoApiProxyPlugin(): Plugin {
  const UPSTREAM = "https://api-maps.yandex.ru/services/panoramas/1.x/";
  const PREFIX = "/_api/yandex-pano";
  const cache = makeLruCache(200);
  // Yandex panoramas don't change often; 24h cache is fine and
  // dramatically reduces 429s. The dataset version updates only when the
  // city is rephotographed.
  const TTL_MS = 24 * 60 * 60 * 1000;

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return next();
    const qIdx = req.url.indexOf("?");
    const incomingQs = qIdx >= 0 ? req.url.slice(qIdx + 1) : "";
    const incoming = new URLSearchParams(incomingQs);
    const ll = incoming.get("ll");
    const oid = incoming.get("oid");
    if (!ll && !oid) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "ll or oid required" }));
      return;
    }
    const cacheKey = oid ? `oid:${oid}` : `ll:${ll}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.statusCode = cached.status;
      res.setHeader("content-type", cached.ct);
      res.setHeader("cache-control", "public, max-age=3600");
      res.setHeader("x-cache", "HIT");
      res.setHeader("access-control-allow-origin", "*");
      res.end(cached.body);
      return;
    }

    const upstreamParams = new URLSearchParams({
      l: "stv",
      lang: "ru_RU",
      origin: "userAction",
      provider: "streetview",
    });
    if (oid) upstreamParams.set("oid", oid);
    if (ll) upstreamParams.set("ll", ll);
    const upstreamUrl = `${UPSTREAM}?${upstreamParams.toString()}`;
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          referer: "https://yandex.ru/maps/",
          accept: "application/json,*/*",
          "accept-encoding": "identity",
        },
      });
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      const ct = upstreamRes.headers.get("content-type") ?? "application/json";
      // Only cache successful payloads. 429 should NOT be cached.
      if (upstreamRes.ok) {
        cache.set(cacheKey, { status: upstreamRes.status, body: buf, ct }, TTL_MS);
      }
      res.statusCode = upstreamRes.status;
      res.setHeader("content-type", ct);
      res.setHeader(
        "cache-control",
        upstreamRes.ok ? "public, max-age=3600" : "no-store",
      );
      res.setHeader("x-cache", "MISS");
      res.setHeader("access-control-allow-origin", "*");
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(
        `Yandex panorama API proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    name: "yandex-pano-api-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function yandexPanoTileProxyPlugin(): Plugin {
  const UPSTREAM = "https://pano.maps.yandex.net";
  const PREFIX = "/_tiles/yandex-pano";

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return next();
    // Strip query string from URL when computing upstream path. Tile URLs
    // never carry meaningful query params upstream, but Vite/devtools may
    // tack on `?t=` for cache-busting during dev.
    const path = req.url.slice(PREFIX.length).split("?")[0];
    if (!/^\/[A-Za-z0-9_-]+\/\d+\.\d+\.\d+$/.test(path)) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain");
      res.end("bad pano tile path");
      return;
    }
    const upstreamUrl = UPSTREAM + path;
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 salary-calendar-pano-proxy/1.0",
          referer: "https://yandex.ru/maps/",
          "accept-encoding": "identity",
        },
      });
      res.statusCode = upstreamRes.status;
      const ct = upstreamRes.headers.get("content-type") ?? "image/jpeg";
      res.setHeader("content-type", ct);
      // Tiles are immutable per imageId. Cache hard.
      res.setHeader("cache-control", "public, max-age=604800, immutable");
      res.setHeader("access-control-allow-origin", "*");
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(
        `Yandex pano tile proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    name: "yandex-pano-tile-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    openFreeMapProxyPlugin(),
    osmTileProxyPlugin(),
    mapillaryTileProxyPlugin(),
    mapillaryGraphProxyPlugin(),
    yandexPanoApiProxyPlugin(),
    yandexPanoTileProxyPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

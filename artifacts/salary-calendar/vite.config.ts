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

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

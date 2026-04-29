# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Salary calendar app — map

The map page (`/map`) supports four layer modes that cycle on the bottom-left layer button (or via `?layer=` query param):

- `default` — Carto dark/light tiles (Leaflet)
- `detail` — full OSM tiles for entrance-level detail (Leaflet)
- `satellite` — Esri World Imagery + labels (Leaflet)
- `3d` — MapLibre GL with OpenFreeMap vector tiles, 3D building extrusions, pitched camera

The `3d` mode is rendered by `Map3D.tsx` (uses `maplibre-gl`). It falls back to a friendly message if WebGL is unavailable. The `POV` button (also bottom-left) opens a Mapillary panorama of the currently selected delivery/pending point (or the user's GPS position) in a fullscreen modal (`MapillaryPanorama.tsx`); the modal also offers links to open the panorama in Mapillary's full app or Yandex Panoramas.

No Mapillary API key is required because the panorama is loaded via Mapillary's public embed URL.

The 3D map's vector tiles, fonts, sprites and style JSON are routed through a same-origin proxy at `/_tiles/openfreemap/*` (implemented in `vite.config.ts` as the `openFreeMapProxyPlugin`). The plugin runs in both `vite` (dev) and `vite preview` modes. This is required because the upstream Cloudflare host `tiles.openfreemap.org` is intermittently unreachable from some Russian ISPs without a VPN, so the user's browser hits the same Replit domain that served the app, and the server then fetches from openfreemap.org. `Map3D.tsx` uses MapLibre's `transformRequest` to rewrite any absolute upstream URLs in the style JSON to go through the proxy as well.

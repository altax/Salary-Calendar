# Salary Calendar

Russian-language minimalist salary tracker for a courier in St. Petersburg.

## Stack

- React 19 + Vite
- Tailwind v4 + shadcn-ui (monochrome theme)
- Wouter (routing)
- date-fns/ru
- framer-motion
- JetBrains Mono (UI), DM Sans, Fraunces
- Leaflet + react-leaflet 5 (map)
- localStorage (no backend)

## Routes

- `/` — month calendar (`components/Calendar.tsx`)
- `/map` — delivery map (`pages/MapView.tsx`)
- `/map?date=YYYY-MM-DD` — filtered to a specific day

## State

- `lib/store.ts` — `useSalaryStore`: entries (per-day per-job RUB), jobs, schedule anchors, obligations, goals, savings, tax, theme, currency
- `lib/deliveries.ts` — `useDeliveriesStore`: deliveries (geotagged, money-bearing) + pending orders (route stops). Syncs deltas back into the salary entries via an `onChange` callback so calendar totals stay consistent.

All localStorage keys are prefixed `salary-calendar:`. A one-time reset (`salary-calendar:reset:map-v1`) wipes pre-map data on first load to start clean for the geo features (theme is preserved).

## Map feature

- Tiles: CartoDB Dark Matter / Positron (no API key)
- Tap on map → add point dialog (delivery with amount, or pending order)
- Address search via Nominatim (SPB viewbox)
- Route optimizer: nearest-neighbor seed + 2-opt refinement (`lib/route-optimizer.ts`), uses real-road duration matrix when available
- Day-modal opens from a calendar day popover when that day has deliveries

## Turn-by-turn navigator

Drive mode (`components/DriveMode.tsx`) is a real navigator on top of OSRM:

- `lib/routing.ts` — `RoutingProvider` interface + `OsrmProvider` (default base `https://router.project-osrm.org`, override with `VITE_OSRM_BASE`). Exposes `getRoute` (geometry, legs, steps with maneuver type/modifier/street name) and `getMatrix` (full distance/duration matrix).
- `lib/use-route.ts` — `useRoute` and `useDistanceMatrix` React hooks, dedupe by point fingerprint, abort on stale.
- `lib/route-progress.ts` — projects GPS onto the polyline (segment search with last-segment hint, falls back to full scan if drift > 80 m), reports `distanceFromStart`, `distanceToEnd`, `offRouteM`, current/next maneuver step and `distanceToNextManeuverM`. Helpers `sliceGeometry` / `traveledGeometry` split the polyline at the user's projection.
- `lib/voice.ts` — Web Speech API wrapper (ru-RU), `StepAnnouncer` triggers maneuver prompts at 250 m / 80 m / 30 m exactly once per step. Russian phrasing built from OSRM `maneuver.type` + `modifier` + `name`. Mute button in the drive-mode top bar.
- Drive mode behavior:
  - Fetches a fresh route from current GPS through every remaining pending stop.
  - Top maneuver card: arrow icon + instruction ("поверните направо на Бухарестскую"), plus the next step preview and remaining-distance counter.
  - Map renders the full route (pending) by real roads, the upcoming portion bright blue, the traveled portion dimmed grey, and small arrow markers at each future maneuver.
  - Auto-arrival: within 30 m of the active stop on the final step → opens the "✓ доставлено" sum dialog, voice says "Вы прибыли".
  - Auto-reroute: if `offRouteM > 60` and 5 s after start with 10 s cooldown → re-fetches route from the current GPS, voice says "Маршрут перестроен".
- Header KPIs (km / ETA in the bar) use the real OSRM duration when available, with a haversine fallback when offline.

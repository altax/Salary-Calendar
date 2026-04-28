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
- `lib/deliveries.ts` — `useDeliveriesStore`: deliveries (geotagged, money-bearing) only. Syncs deltas back into the salary entries via an `onChange` callback so calendar totals stay consistent. (Used to also hold pending orders; that has migrated into waves.)
- `lib/waves.ts` — `useWavesStore`: groups pending orders into **waves** (one trip out from depot and back). Persisted at `salary-calendar:waves:v1`. One active wave at a time; finished waves stay in history with their built route geometry / distance / duration so you can re-open them. On first load the legacy `salary-calendar:pending:v1` is migrated into a single active wave. API: `ensureActiveWave`, `addStop`, `updateStop`, `removeStop`, `reorderStops`, `completeStop`, `skipStop`, `saveDeliveryRoute`, `saveReturnRoute`, `finishActiveWave`, `reopenWave`, `deleteWave`, `startNewWave`, plus `setSelectedWaveId` for the WaveTabs UI.

All localStorage keys are prefixed `salary-calendar:`. A one-time reset (`salary-calendar:reset:map-v1`) wipes pre-map data on first load to start clean for the geo features (theme is preserved).

## Map feature

- Tiles: CartoDB Dark Matter / Positron (no API key)
- Tap on map → add point dialog (delivery with amount, or pending order)
- Address search via Nominatim (SPB viewbox)
- Route optimizer (`lib/route-optimizer.ts`): nearest-neighbor seed → closed-tour 2-opt → or-opt (1/2/3-stop relocation) → far-first orientation. Uses real OSRM duration matrix when available, haversine fallback otherwise. The closed-tour cost includes the return-to-depot leg, so 2-opt swaps that shorten the closing edge are taken. Far-first orientation reverses the tour if the last stop is farther from depot than the first — total km is identical but starting with the farthest stop wins on battery use, fatigue, abandonment risk, and final return distance.
- Routing profile (`lib/routing.ts`): runtime-switchable `bike` / `foot` / `car`. Bike & foot use `routing.openstreetmap.de/routed-{bike,foot}` (allows pedestrian shortcuts and cycle paths — important for e-bike couriers). Car uses `router.project-osrm.org`. `useRoute` and `useDistanceMatrix` re-key on profile and refetch on switch. Selection persisted in `localStorage` under `salary-calendar:routing-profile:v1` and restored in `main.tsx` before the first fetch. UI: cycling chip in MapView header (🚲 / 🚶 / 🚗).
- Service worker `ROUTING_HOST_RE` covers both `router.project-osrm.org` and `routing.openstreetmap.de`, so all three profiles work offline once cached.
- Day-modal opens from a calendar day popover when that day has deliveries

## Turn-by-turn navigator

Drive mode (`components/DriveMode.tsx`) is a real navigator on top of OSRM with a per-leg state machine ("driving" → "returning" → "finished"):

- `lib/routing.ts` — `RoutingProvider` interface + `OsrmProvider` (default base `https://router.project-osrm.org`, override with `VITE_OSRM_BASE`). Exposes `getRoute` (geometry, legs, steps with maneuver type/modifier/street name) and `getMatrix` (full distance/duration matrix). When the OSRM fetch fails AND the service worker has nothing cached, falls back to a haversine straight-line route (`source: "straight"`, ~40 km/h). Triggers an "Маршрут построен по прямой — нет связи" voice prompt instead of the normal route-built announcement.
- `lib/use-route.ts` — `useRoute` and `useDistanceMatrix` React hooks, dedupe by point fingerprint, abort on stale.
- `lib/route-progress.ts` — projects GPS onto the polyline (segment search with last-segment hint, falls back to full scan if drift > 80 m), reports `distanceFromStart`, `distanceToEnd`, `offRouteM`, current/next maneuver step and `distanceToNextManeuverM`. Indexes per-leg geometry, distances and durations (`legVertexStart/End`, `legCumDistances`, `legDurations`); helpers `getLegGeometry` and `legSliceFromProjection` slice each individual leg for the visual leg-status renderer.
- `lib/voice.ts` — Web Speech API wrapper (ru-RU). `StepAnnouncer` triggers maneuver prompts at 250 / 80 / 30 m once per step. `StopAnnouncer` calls out the next stop's address at 400 m and 80 m. Plus one-shot prompts: `announceRouteBuilt`, `announceOfflineFallbackRoute`, `announceStopDelivered` (with proper Russian plurals), `announceReturningToDepot`, `announceShiftFinished`. Mute button in the top bar.
- Drive mode behavior:
  - **State machine.** `driving` (delivering pending) → `returning` (auto-built route from current GPS to depot once last stop is delivered) → `finished` (within 50 m of depot).
  - **Stable route.** The route is fetched once and reused across deliveries; it is rebuilt only on (a) initial GPS, (b) a NEW pending stop appearing, (c) skip / manual reroute, (d) off-route detection (>60 m from polyline, >5 s after start, ≤1 reroute per 10 s), (e) mode change.
  - **Per-leg visual status.** Each delivery leg renders independently: completed → green dashed + green ✓ marker at endpoint; active → bright blue thick polyline (sliced from current projection forward); upcoming → grey dashed. The return-to-depot leg uses purple. Toggle the entire overlay with the eye button (persisted in `salary-calendar:drive:route-visible`).
  - **Maneuver card.** Arrow + instruction + street, with next-step preview and a distance counter that turns amber inside 200 m and red inside 50 m.
  - **Stops side panel.** Collapsible right-side list (toggle persisted in `salary-calendar:drive:stops-open`) showing every stop with status (done ✓ / active / upcoming), per-leg km and ETA, plus the depot row.
  - **Header.** Mode label, stop counter (`3 / 7`), eye / mute buttons, current speed (km/h from GPS) when moving, total remaining km and ETA computed from real progress.
  - **Bottom panel.** Driving: address of next stop, three counters (по прямой / по дороге / финиш-clock), big "✓ доставлено" + "пропустить". Returning: depot address, same three counters, "я уже в депо" override. Finished: "смена окончена" + готово.
  - **Reroute button** in bottom-right of the map for manual recalculation.
  - **Voice flow.** "Маршрут построен. 5 точек, 12,4 километров, около 28 минут." → maneuvers (250/80/30 m) → "Невский проспект 22 — через 350 метров" → "Невский — рядом, готовьтесь к остановке" → "Вы прибыли" → "Заказ доставлен. Осталось 4 точки." → after the last stop: "Заказ доставлен. Все точки выполнены, строю маршрут до депо." → "Все заказы доставлены. Маршрут до депо построен." → at depot: "Вы прибыли в депо. Смена окончена. Хорошего отдыха."
- Header KPIs (km / ETA in the bar) use the real OSRM duration scaled by remaining-distance ratio.

## Waves (multi-trip workflow)

Couriers can do multiple trips per day: drive out, deliver everything, come back to the depot, load up again. Each trip is a **wave** (`lib/waves.ts`).

- **Active wave.** Newly added pending orders go onto the active wave. Calendar money still flows through `useDeliveriesStore` so totals on `/` stay unchanged.
- **WaveTabs panel** (right side of `/map`, next to obligations). Lists the active wave + finished waves. Per wave: pending / done counts, finish/reopen/delete actions. "+ новая волна" closes the active wave and opens a fresh one. Selecting a finished tab inspects that wave's polylines on the map; otherwise only the active wave is rendered, so the screen does not pile up after each trip.
- **DriveMode integration.** Active wave's pending stops are handed to DriveMode. When the courier hits the depot at the end of a return trip, `onFinishWave` closes the wave (`finishActiveWave`). Built delivery/return geometries are persisted into the wave snapshot via `saveDeliveryRoute` / `saveReturnRoute`.

## Offline maps

Designed for spotty mobile coverage on delivery routes.

- `public/sw.js` — service worker. Cache-first for OSM tiles (`basemaps.cartocdn.com`, `tile.openstreetmap.org`) and OSRM/Nominatim responses (`router.project-osrm.org`, `nominatim.openstreetmap.org`). App shell is left to the network. Versioned caches (`tiles-v3`, `routing-v3`, `app-v3`); bumping `VERSION` purges old caches on activate. Handles `PREFETCH_TILES` / `PREFETCH_ROUTES` / `CACHE_INFO` / `CLEAR_TILES` postMessages.
- `lib/offline-maps.ts` — main-thread controller. `tilesForBounds`, `boundsAround`, `SPB_BOUNDS`. `prefetchTiles(urls, onProgress)` walks zoom levels (default SPB at z 12-16) and posts to the SW; the SW worker pool downloads at concurrency 6 and reports progress. `prefetchRoutingUrls`, `readCacheInfo`, `clearTileCache` round it out.
- "**Скачать карту**" UI (in the WaveTabs / settings area) prefetches the SPB tile range plus the active wave's OSRM route URL so the next trip works offline. An offline indicator surfaces when `!navigator.onLine`.
- **Routing fallback chain.** Online → live OSRM. SW has a hit → cached OSRM. Both fail → `OsrmProvider.getRoute` builds a haversine straight-line route (`source: "straight"`) so DriveMode keeps working; `announceOfflineFallbackRoute` ("Маршрут построен по прямой — нет связи") fires instead of the normal route-built prompt. `getMatrix` falls back to a haversine matrix the same way so the route optimizer still produces a sensible order offline.
- `src/main.tsx` registers the SW under `BASE_URL` so it works under the workspace iframe path too.

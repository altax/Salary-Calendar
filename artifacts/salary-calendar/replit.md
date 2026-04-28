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

Drive mode (`components/DriveMode.tsx`) is a real navigator on top of OSRM with a per-leg state machine ("driving" → "returning" → "finished"):

- `lib/routing.ts` — `RoutingProvider` interface + `OsrmProvider` (default base `https://router.project-osrm.org`, override with `VITE_OSRM_BASE`). Exposes `getRoute` (geometry, legs, steps with maneuver type/modifier/street name) and `getMatrix` (full distance/duration matrix).
- `lib/use-route.ts` — `useRoute` and `useDistanceMatrix` React hooks, dedupe by point fingerprint, abort on stale.
- `lib/route-progress.ts` — projects GPS onto the polyline (segment search with last-segment hint, falls back to full scan if drift > 80 m), reports `distanceFromStart`, `distanceToEnd`, `offRouteM`, current/next maneuver step and `distanceToNextManeuverM`. Indexes per-leg geometry, distances and durations (`legVertexStart/End`, `legCumDistances`, `legDurations`); helpers `getLegGeometry` and `legSliceFromProjection` slice each individual leg for the visual leg-status renderer.
- `lib/voice.ts` — Web Speech API wrapper (ru-RU). `StepAnnouncer` triggers maneuver prompts at 250 / 80 / 30 m once per step. `StopAnnouncer` calls out the next stop's address at 400 m and 80 m. Plus one-shot prompts: `announceRouteBuilt`, `announceStopDelivered` (with proper Russian plurals), `announceReturningToDepot`, `announceShiftFinished`. Mute button in the top bar.
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

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
- Route optimizer: nearest-neighbor seed + 2-opt refinement (`lib/route-optimizer.ts`)
- Day-modal opens from a calendar day popover when that day has deliveries

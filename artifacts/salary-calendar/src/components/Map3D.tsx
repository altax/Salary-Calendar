import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  Map as MLMap,
  Marker as MLMarker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cn } from "@/lib/utils";
import type { Delivery, PendingOrder } from "@/lib/deliveries";
import type { ResolvedJob, Depot } from "@/lib/store";
import type { GeoPosition } from "@/lib/geolocation";

const SPB_CENTER: [number, number] = [30.3351, 59.9343];

// Both tile sources are proxied through our own server (Vite dev proxy /
// production proxy) because the upstream Cloudflare host
// `tiles.openfreemap.org` is intermittently unreachable in some networks (RU)
// and we want a single, predictable origin for caching.
const OPENFREEMAP_PROXY_PREFIX = "/_tiles/openfreemap";
const OPENFREEMAP_UPSTREAM = "https://tiles.openfreemap.org";
const OSM_PROXY_PREFIX = "/_tiles/osm";

function proxyOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}

function rewriteOpenFreeMapUrl(url: string): string {
  // MapLibre loads tiles inside a Web Worker which cannot resolve relative
  // URLs against window.location, so always return an absolute URL.
  if (url.startsWith(OPENFREEMAP_UPSTREAM)) {
    return proxyOrigin() + OPENFREEMAP_PROXY_PREFIX + url.slice(OPENFREEMAP_UPSTREAM.length);
  }
  if (url.startsWith(OPENFREEMAP_PROXY_PREFIX)) {
    return proxyOrigin() + url;
  }
  return url;
}

// Build a self-contained inline style backed by OSM raster tiles served
// through our same-origin proxy. We use a small inline style instead of
// loading a vector style JSON because the OpenFreeMap "liberty" and
// "positron" styles both fail expression evaluation on recent tile
// versions ("Expected value to be of type number, but found null"), which
// silently leaves the entire canvas blank. Raster tiles are immune to that
// class of issue: they're just PNGs with no per-feature expressions.
function buildBaseStyle(theme: "dark" | "light"): maplibregl.StyleSpecification {
  const origin = proxyOrigin();
  const subs = ["a", "b", "c"];
  const tiles = subs.map((s) => `${origin}${OSM_PROXY_PREFIX}/${s}/{z}/{x}/{y}.png`);
  const background = theme === "dark" ? "#0a0d12" : "#f3f4f7";
  return {
    version: 8,
    glyphs: `${origin}${OPENFREEMAP_PROXY_PREFIX}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      osm: {
        type: "raster",
        tiles,
        tileSize: 256,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": background },
      },
      {
        id: "osm-tiles",
        type: "raster",
        source: "osm",
        minzoom: 0,
        maxzoom: 22,
        // In dark mode we tone the bright OSM raster down so it matches the
        // app's dark theme without losing legibility on the e-bike tablet.
        // In light mode we still desaturate + dim slightly so the bright
        // asphalt doesn't dominate the frame and the route line + selected
        // building stay the visual anchors.
        paint:
          theme === "dark"
            ? { "raster-brightness-min": 0.0, "raster-brightness-max": 0.55, "raster-saturation": -0.35, "raster-contrast": 0.1 }
            : { "raster-brightness-min": 0.05, "raster-brightness-max": 0.82, "raster-saturation": -0.22, "raster-contrast": 0.05 },
      },
    ],
  };
}

// Add the OpenFreeMap vector source on top of the raster basemap purely so
// we can render 3D building extrusions. We do NOT load any of OpenFreeMap's
// vector layers (which is what was crashing) — just the building polygons.
function addOpenMapTilesVectorSource(map: MLMap) {
  if (map.getSource("openmaptiles")) return;
  try {
    map.addSource("openmaptiles", {
      type: "vector",
      url: `${proxyOrigin()}${OPENFREEMAP_PROXY_PREFIX}/planet`,
    } as any);
  } catch (err) {
    console.warn("[Map3D] failed to add openmaptiles source", err);
  }
}

// Extract the courier-relevant house number from a free-form Russian address
// string like "ул. Будапештская, д. 12 корп. 3" or "Ленина 4А". The number is
// what the courier looks for on the building wall, so we want the *first*
// human-meaningful house identifier (with optional letter and corpus part)
// and nothing else.
function extractHouseNumber(address?: string | null): string | null {
  if (!address) return null;
  const compact = (s: string) => s.replace(/\s+/g, "");
  // 1. Explicit "д. N" / "дом N" form.
  const m1 = address.match(
    /д(?:ом)?\.?\s*(\d{1,4}[а-яА-Яa-zA-Z]?(?:\/\d+)?(?:\s*к(?:орп)?\.?\s*\d+[а-яА-Я]?)?)/i,
  );
  if (m1) return compact(m1[1]);
  // 2. Number directly after a comma — typical OSM display form.
  const m2 = address.match(
    /,\s*(\d{1,4}[а-яА-Яa-zA-Z]?(?:\/\d+)?(?:\s*к(?:орп)?\.?\s*\d+[а-яА-Я]?)?)/,
  );
  if (m2) return compact(m2[1]);
  // 3. Anything that looks like a standalone short number (last resort).
  const m3 = address.match(/\b(\d{1,4}[а-яА-Яa-zA-Z]?)\b/);
  if (m3) return m3[1];
  return null;
}

// Find the point on a polygon feature's outline that is closest (in plain
// 2D lng/lat space — fine for the ~50 m distances we care about) to the
// given coordinate. Used to anchor the "last mile" dashed line at the
// building edge instead of its centre, which would otherwise draw a line
// straight through the building.
function closestPointOnFeature(
  feature: GeoJSON.Feature,
  lng: number,
  lat: number,
): [number, number] | null {
  const g = feature.geometry as any;
  let rings: number[][][] | null = null;
  if (g?.type === "Polygon") rings = g.coordinates as number[][][];
  else if (g?.type === "MultiPolygon")
    rings = (g.coordinates as number[][][][]).flat() as number[][][];
  if (!rings || rings.length === 0) return null;

  let best: [number, number] | null = null;
  let bestDist = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((lng - ax) * dx + (lat - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d2 = (px - lng) * (px - lng) + (py - lat) * (py - lat);
      if (d2 < bestDist) {
        bestDist = d2;
        best = [px, py];
      }
    }
  }
  return best;
}

function jobColor(job: ResolvedJob | undefined, theme: "dark" | "light"): string {
  if (job?.color) return job.color;
  if (job?.id === "ozon") return theme === "dark" ? "#fafafa" : "#0a0a0a";
  return theme === "dark" ? "#888" : "#666";
}

// We deliberately do NOT pre-probe WebGL via `document.createElement("canvas")`
// — that probe returns `null` in several real-world Chromium contexts where
// MapLibre's own canvas would actually render fine (Replit's embedded preview
// iframe, some Android tablets, headless screenshot environments, certain
// GPU-blacklist configurations). Instead we let MapLibre attempt to initialise
// the canvas itself; if it genuinely cannot get a WebGL context it throws
// during construction and we fall back gracefully via the try/catch below.

function applyDarkTheme(map: MLMap, theme: "dark" | "light") {
  const isDark = theme === "dark";
  const water = isDark ? "#0a0d12" : "#cde2ff";
  const land = isDark ? "#101216" : "#f3f4f7";
  const road = isDark ? "#2a2e36" : "#ffffff";
  const roadCasing = isDark ? "#0a0c10" : "#d8dde6";
  const labelColor = isDark ? "#cfd3da" : "#1c1c20";
  const labelHalo = isDark ? "#000000" : "#ffffff";
  const buildingColor = isDark ? "#1c1f25" : "#dde0e6";

  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers as any[]) {
    const id: string = layer.id ?? "";
    try {
      if (layer.type === "background") {
        map.setPaintProperty(id, "background-color", land);
      }
      if (id.includes("water") && layer.type === "fill") {
        map.setPaintProperty(id, "fill-color", water);
      }
      if (
        (id.includes("landuse") || id.includes("park") || id.includes("landcover")) &&
        layer.type === "fill"
      ) {
        map.setPaintProperty(id, "fill-color", isDark ? "#15171c" : "#e7eae6");
        map.setPaintProperty(id, "fill-opacity", 0.6);
      }
      if (
        (id.includes("road") || id.includes("street") || id.includes("highway")) &&
        layer.type === "line"
      ) {
        const isCasing = id.includes("casing") || id.includes("outline");
        map.setPaintProperty(id, "line-color", isCasing ? roadCasing : road);
      }
      if (layer.type === "symbol") {
        map.setPaintProperty(id, "text-color", labelColor);
        map.setPaintProperty(id, "text-halo-color", labelHalo);
        map.setPaintProperty(id, "text-halo-width", 1.4);
      }
      if (id.includes("building") && layer.type === "fill") {
        map.setPaintProperty(id, "fill-color", buildingColor);
      }
    } catch {
      // ignore layers that don't support a property
    }
  }
}

function add3DBuildings(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("3d-buildings")) return;
  const isDark = theme === "dark";
  const buildingColor = isDark ? "#1c1f25" : "#dde0e6";
  const buildingTop = isDark ? "#272b33" : "#cdd1d8";
  const buildingTall = isDark ? "#3a3f48" : "#b9bdc4";

  // Make sure the OpenMapTiles vector source is loaded — only used for 3D
  // building geometry on top of the OSM raster basemap.
  addOpenMapTilesVectorSource(map);
  const source = "openmaptiles";
  const sourceLayer = "building";

  // No symbol layers in our inline style, so just append at the end.
  const beforeId: string | undefined = undefined;

  // Defensive height expression: openmaptiles building features may have
  // null `render_height` / `height` properties. Both `coalesce` and
  // direct `get` can yield null, which crashes MapLibre's interpolation
  // (`Expected value to be of type number, but found null`). We use
  // `case` + `has` + `to-number` (with fallback) to guarantee a number.
  const heightExpr: any = [
    "case",
    ["has", "render_height"],
    ["to-number", ["get", "render_height"], 8],
    ["has", "height"],
    ["to-number", ["get", "height"], 8],
    8,
  ];
  const baseExpr: any = [
    "case",
    ["has", "render_min_height"],
    ["to-number", ["get", "render_min_height"], 0],
    ["has", "min_height"],
    ["to-number", ["get", "min_height"], 0],
    0,
  ];

  map.addLayer(
    {
      id: "3d-buildings",
      source,
      "source-layer": sourceLayer,
      type: "fill-extrusion",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          heightExpr,
          0,
          buildingColor,
          50,
          buildingTop,
          150,
          buildingTall,
        ],
        "fill-extrusion-height": heightExpr,
        "fill-extrusion-base": baseExpr,
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
      },
    } as any,
    beforeId,
  );

  // ---- Selected-building highlight ----
  // We don't toggle feature-state on the original vector tiles because
  // openmaptiles building features don't reliably carry stable feature IDs
  // across tiles (the same building can appear as multiple features with
  // different IDs at tile borders). Instead we keep a tiny GeoJSON source
  // with the selected polygon's geometry and render it as a second
  // fill-extrusion layer on top, painted in bright orange.
  if (!map.getSource("selected-building")) {
    map.addSource("selected-building", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("selected-building-extrusion")) {
    map.addLayer({
      id: "selected-building-extrusion",
      type: "fill-extrusion",
      source: "selected-building",
      minzoom: 14,
      paint: {
        // Bright orange on dark theme, slightly deeper on light.
        "fill-extrusion-color": isDark ? "#ff7a1a" : "#ea580c",
        // Slightly taller than the original so it visually "lifts" above
        // the rest of the city (~+4 m or 4% of height, whichever is larger).
        "fill-extrusion-height": [
          "max",
          ["+", ["coalesce", ["get", "render_height"], 8], 4],
          ["*", ["coalesce", ["get", "render_height"], 8], 1.04],
        ],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
      },
    } as any);
  }
  if (!map.getLayer("selected-building-outline")) {
    // Thin glowing outline at the building's footprint to make it pop on the
    // ground-plane when the camera is high (pitch ≈ 0).
    map.addLayer({
      id: "selected-building-outline",
      type: "line",
      source: "selected-building",
      minzoom: 14,
      paint: {
        "line-color": "#ffb300",
        "line-width": 2,
        "line-opacity": 0.9,
      },
    } as any);
  }
  // ---- House-number label on the selected building ----
  // The single biggest thing courier needs to confirm "this is the right
  // building" is the *number on the door*. We extract it from the delivery /
  // pending order's address client-side and stuff it into the polygon's
  // `housenumber` property (see the selection effect), then this symbol layer
  // renders it big and orange-haloed at the polygon's pole-of-inaccessibility.
  if (!map.getLayer("selected-building-number")) {
    map.addLayer({
      id: "selected-building-number",
      type: "symbol",
      source: "selected-building",
      minzoom: 14,
      layout: {
        "text-field": ["coalesce", ["get", "housenumber"], ""],
        "text-font": ["Noto Sans Bold"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          14,
          17,
          26,
          19,
          38,
          21,
          54,
        ],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-padding": 0,
        "symbol-placement": "point",
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#ff7a1a",
        "text-halo-width": 2.5,
        "text-halo-blur": 0.5,
      },
    } as any);
  }
}

export type Map3DProps = {
  deliveries: Delivery[];
  pending: PendingOrder[];
  jobs: ResolvedJob[];
  theme: "dark" | "light";
  depot?: Depot | null;
  showDepot?: boolean;
  userPosition?: GeoPosition | null;
  followUser?: boolean;
  activePendingId?: string | null;
  onMapClick?: (lat: number, lng: number) => void;
  onDeliveryClick?: (id: string) => void;
  onPendingClick?: (id: string) => void;
  onDepotClick?: () => void;
  selectedId?: string | null;
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
  showRoute?: boolean;
  showPendingRoute?: boolean;
  filterJob?: string | null;
  className?: string;
  initialZoom?: number;
  pendingRouteGeometry?: [number, number][] | null;
  activeRouteGeometry?: [number, number][] | null;
  traveledGeometry?: [number, number][] | null;
  onMapReady?: (map: MLMap) => void;
};

export default function Map3D({
  deliveries,
  pending,
  jobs,
  theme,
  depot,
  showDepot = true,
  userPosition,
  followUser = false,
  activePendingId,
  onMapClick,
  onDeliveryClick,
  onPendingClick,
  onDepotClick,
  selectedId,
  flyTo,
  showRoute = true,
  showPendingRoute = true,
  filterJob,
  className,
  initialZoom = 14,
  pendingRouteGeometry,
  activeRouteGeometry,
  traveledGeometry,
  onMapReady,
}: Map3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<Map<string, MLMarker>>(new Map());
  const userMarkerRef = useRef<MLMarker | null>(null);
  const isLoadedRef = useRef(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [initError, setInitError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const jobsById = useMemo(() => {
    const map = new Map<string, ResolvedJob>();
    for (const j of jobs) map.set(j.id, j);
    return map;
  }, [jobs]);

  const sortedDeliveries = useMemo(
    () =>
      deliveries
        .filter((d) => !filterJob || d.jobId === filterJob)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp),
    [deliveries, filterJob],
  );

  // Initialise map once
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    // Browsers cap simultaneous fetches per origin at ~6; bumping MapLibre's
    // global limit lets it pipeline more tile requests so the visible
    // viewport fills in noticeably faster on first load. This is a global
    // setter (not a per-map MapOptions field) in maplibre-gl 5.x.
    try {
      (maplibregl as any).setMaxParallelImageRequests?.(32);
    } catch {}

    console.log("[Map3D] init start");
    setLoading(true);

    let map: MLMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildBaseStyle(themeRef.current),
        center: depot ? [depot.lng, depot.lat] : SPB_CENTER,
        zoom: initialZoom,
        pitch: 60,
        bearing: -17,
        // `failIfMajorPerformanceCaveat: false` lets MapLibre fall back to
        // software-rendered WebGL (SwiftShader / llvmpipe) when no GPU is
        // available — without this, embedded preview iframes and low-end
        // tablets refuse to create a context and the user just sees the
        // "WebGL unavailable" fallback even though rendering would work.
        canvasContextAttributes: {
          antialias: true,
          failIfMajorPerformanceCaveat: false,
        },
        attributionControl: { compact: true },
        maxPitch: 78,
        // ---- Loading-speed knobs ----
        // `fadeDuration: 0` removes the 300 ms cross-fade MapLibre normally
        // plays when a new tile arrives — on slow networks the screen can
        // sit half-blank for almost a second per tile, which feels broken.
        fadeDuration: 0,
        // Tiles served by our proxy already have long cache headers, and
        // re-requesting expired ones every few minutes just stalls the
        // network for no visual gain.
        refreshExpiredTiles: false,
        // Any URL that points at the OpenFreeMap upstream (e.g. the
        // openmaptiles vector source we add later for 3D buildings, or
        // glyph URLs in the inline style) must be routed through our
        // same-origin proxy so it works on networks that block the
        // upstream Cloudflare host.
        transformRequest: (url) => ({ url: rewriteOpenFreeMapUrl(url) }),
      });
    } catch (err) {
      console.error("[Map3D] map ctor failed", err);
      const raw = err instanceof Error ? err.message : String(err);
      // MapLibre serialises a WebGL context-creation failure as a JSON blob
      // (with `type:"webglcontextcreationerror"`); detect it and show a short
      // human-readable message instead of dumping the JSON into the UI.
      const isWebGLFailure = /webgl/i.test(raw);
      setInitError(
        isWebGLFailure
          ? "У этого браузера не получилось создать WebGL-контекст для 3D-карты. Это часто бывает во встроенном предпросмотре Replit или на старом GPU. Открой ссылку в обычной вкладке Chrome / Firefox, либо переключись в обычный режим кнопкой 3D слева."
          : `Не удалось создать 3D-карту: ${raw}. Переключись в обычный режим кнопкой 3D слева.`,
      );
      setLoading(false);
      return;
    }

    mapRef.current = map;

    map.on("error", (e: any) => {
      const msg = e?.error?.message ?? String(e?.error ?? e);
      console.warn("[Map3D] runtime error:", msg, e);
    });

    let tileOk = 0;
    let tileFail = 0;
    map.on("dataloading", (e: any) => {
      if (e.dataType === "source" && e.tile) {
        // eslint-disable-next-line no-console
        console.log("[Map3D] tile loading", e.sourceId, e.tile?.tileID?.canonical);
      }
    });
    map.on("data", (e: any) => {
      if (e.dataType === "source" && e.tile && e.isSourceLoaded) {
        tileOk += 1;
      }
    });
    map.on("idle", () => {
      const canvas = map.getCanvas();
      // eslint-disable-next-line no-console
      console.log(
        "[Map3D] idle — canvas:",
        canvas.width,
        "x",
        canvas.height,
        "css:",
        canvas.clientWidth,
        "x",
        canvas.clientHeight,
        "tiles ok:",
        tileOk,
        "fail:",
        tileFail,
        "center:",
        map.getCenter(),
        "zoom:",
        map.getZoom(),
      );
    });

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );

    map.on("load", () => {
      if (cancelled) return;
      console.log("[Map3D] map loaded — forcing resize");
      isLoadedRef.current = true;
      setLoading(false);

      // Force MapLibre to re-measure the container in case its dimensions
      // weren't yet finalised when the map was constructed (common when the
      // map mounts inside a flex/grid that resolves its size after first
      // paint).
      try {
        map.resize();
      } catch (err) {
        console.warn("[Map3D] resize failed", err);
      }

      try {
        // NOTE: applyDarkTheme is intentionally disabled — it caused style
        // expression evaluation errors on some tile versions, leaving the map
        // blank. We keep the vanilla OpenFreeMap "liberty" colors for now and
        // only add 3D building extrusions on top.
        // applyDarkTheme(map, themeRef.current);
        add3DBuildings(map, themeRef.current);
      } catch (err) {
        console.warn("[Map3D] extrusion apply failed", err);
      }

      // Empty sources for routes
      try {
        map.addSource("pending-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addSource("active-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addSource("traveled-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        // "Last mile": straight dashed orange line from the end of the
        // road-snapped route to the actual delivery point (entrance / yard).
        // This explicitly answers the courier's question "OK, I parked —
        // now where do I walk?" instead of leaving them guessing.
        map.addSource("last-mile", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addLayer({
          id: "pending-route-line",
          type: "line",
          source: "pending-route",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": themeRef.current === "dark" ? "#3b82f6" : "#1d4ed8",
            "line-width": 4,
            "line-opacity": 0.85,
            "line-dasharray": [2, 1.2],
          },
        });

        // ---- Active route: 3-layer stack for visibility ----
        // Bottom: dark casing makes the route pop on both light asphalt
        // and dark theme. Middle: bright cyan main line, fat enough to
        // see at a glance even at high pitch. Top: directional arrows
        // repeated along the line so you instantly know which way is
        // forward without hunting for the user dot.
        map.addLayer({
          id: "active-route-casing",
          type: "line",
          source: "active-route",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#0c1f3a",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              5,
              16,
              12,
              19,
              22,
            ],
            "line-opacity": 0.95,
          },
        });
        map.addLayer({
          id: "active-route-line",
          type: "line",
          source: "active-route",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#38bdf8",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              3,
              16,
              8,
              19,
              16,
            ],
            "line-opacity": 1,
          },
        });
        map.addLayer({
          id: "active-route-arrows",
          type: "symbol",
          source: "active-route",
          minzoom: 14,
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 80,
            "text-field": "▶",
            "text-font": ["Noto Sans Bold"],
            "text-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              14,
              11,
              17,
              16,
              19,
              22,
            ],
            "text-keep-upright": false,
            "text-allow-overlap": true,
            "text-ignore-placement": true,
            "text-padding": 0,
          },
          paint: {
            "text-color": "#0c1f3a",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.6,
          },
        } as any);

        map.addLayer({
          id: "traveled-route-line",
          type: "line",
          source: "traveled-route",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": themeRef.current === "dark" ? "#52525b" : "#a1a1aa",
            "line-width": 3,
            "line-opacity": 0.7,
          },
        });

        // Last-mile dashed line, drawn on top of everything else so it
        // remains visible even when overlapping the active route.
        map.addLayer({
          id: "last-mile-line",
          type: "line",
          source: "last-mile",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#ff7a1a",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              14,
              3,
              17,
              5,
              19,
              7,
            ],
            "line-opacity": 0.95,
            "line-dasharray": [1.4, 1.2],
          },
        });
      } catch (err) {
        console.warn("[Map3D] route layers failed", err);
      }

      onMapReady?.(map);
    });

    map.on("click", (e) => {
      onMapClick?.(e.lngLat.lat, e.lngLat.lng);
    });

    return () => {
      cancelled = true;
      isLoadedRef.current = false;
      for (const m of markersRef.current.values()) m.remove();
      markersRef.current.clear();
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync delivery + pending markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;

    const want = new Set<string>();

    // Delivery markers (numbered, finished)
    sortedDeliveries.forEach((d, idx) => {
      const id = `d:${d.id}`;
      want.add(id);
      const job = jobsById.get(d.jobId);
      const color = jobColor(job, theme);
      const fg = color === "#fafafa" || color.toLowerCase() === "#ffffff" ? "#0a0a0a" : "#fff";
      const isSel = selectedId === d.id;

      const html = `
        <div class="m3d-marker m3d-delivery${isSel ? " m3d-selected" : ""}"
          style="--mc:${color};--mfg:${fg};">
          ${String(idx + 1).padStart(2, "0")}
        </div>`;

      let marker = markersRef.current.get(id);
      if (!marker) {
        const el = document.createElement("div");
        el.innerHTML = html;
        el.style.cursor = "pointer";
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onDeliveryClick?.(d.id);
        });
        marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([d.lng, d.lat])
          .addTo(map);
        markersRef.current.set(id, marker);
      } else {
        marker.setLngLat([d.lng, d.lat]);
        const el = marker.getElement();
        el.innerHTML = html;
        el.onclick = (ev) => {
          ev.stopPropagation();
          onDeliveryClick?.(d.id);
        };
      }
    });

    // Pending markers (dashed, ordered by position in array)
    pending.forEach((p, idx) => {
      const id = `p:${p.id}`;
      want.add(id);
      const job = jobsById.get(p.jobId);
      const color = jobColor(job, theme);
      const isActive = activePendingId === p.id;
      const isSel = selectedId === p.id;

      const html = `
        <div class="m3d-marker m3d-pending${isActive ? " m3d-pending-active" : ""}${isSel ? " m3d-selected" : ""}"
          style="--mc:${color};">
          ${idx + 1}
        </div>`;

      let marker = markersRef.current.get(id);
      if (!marker) {
        const el = document.createElement("div");
        el.innerHTML = html;
        el.style.cursor = "pointer";
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onPendingClick?.(p.id);
        });
        marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([p.lng, p.lat])
          .addTo(map);
        markersRef.current.set(id, marker);
      } else {
        marker.setLngLat([p.lng, p.lat]);
        const el = marker.getElement();
        el.innerHTML = html;
        el.onclick = (ev) => {
          ev.stopPropagation();
          onPendingClick?.(p.id);
        };
      }
    });

    // Depot marker
    if (depot && showDepot) {
      const id = "depot";
      want.add(id);
      const html = `<div class="m3d-marker m3d-depot" title="Депо">⌂</div>`;
      let marker = markersRef.current.get(id);
      if (!marker) {
        const el = document.createElement("div");
        el.innerHTML = html;
        el.style.cursor = "pointer";
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onDepotClick?.();
        });
        marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([depot.lng, depot.lat])
          .addTo(map);
        markersRef.current.set(id, marker);
      } else {
        marker.setLngLat([depot.lng, depot.lat]);
      }
    }

    // Drop stale markers
    for (const [id, m] of markersRef.current) {
      if (!want.has(id)) {
        m.remove();
        markersRef.current.delete(id);
      }
    }
  }, [
    sortedDeliveries,
    pending,
    jobsById,
    theme,
    depot,
    showDepot,
    selectedId,
    activePendingId,
    onDeliveryClick,
    onPendingClick,
    onDepotClick,
  ]);

  // User position marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;
    if (!userPosition) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    const heading = userPosition.heading ?? null;
    const html = `
      <div class="m3d-user">
        ${heading != null ? `<div class="m3d-user-arrow" style="transform: translate(-50%, -100%) rotate(${heading}deg);"></div>` : ""}
        <div class="m3d-user-dot"></div>
      </div>`;
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.innerHTML = html;
      userMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([userPosition.lng, userPosition.lat])
        .addTo(map);
    } else {
      userMarkerRef.current.setLngLat([userPosition.lng, userPosition.lat]);
      userMarkerRef.current.getElement().innerHTML = html;
    }
    if (followUser) {
      // POV-style chase camera: high pitch, course-up bearing (when we
      // have a real heading), and the user marker pushed to the bottom
      // third of the screen via `padding` so the road *ahead* of us
      // dominates the frame — same composition as a car-nav app.
      const canvasH = map.getCanvas().clientHeight || 600;
      const hasHeading = heading != null && Number.isFinite(heading);
      map.easeTo({
        center: [userPosition.lng, userPosition.lat],
        zoom: Math.max(map.getZoom(), hasHeading ? 18 : 17),
        pitch: hasHeading ? 72 : Math.max(map.getPitch(), 60),
        bearing: hasHeading ? (heading as number) : map.getBearing(),
        // `padding.bottom` shifts the visual center *down*, which moves
        // the geographic center *up* in the viewport — i.e. the user
        // dot ends up ~30 % from the bottom edge.
        padding: hasHeading
          ? { top: 0, right: 0, bottom: Math.round(canvasH * 0.45), left: 0 }
          : { top: 0, right: 0, bottom: 0, left: 0 },
        duration: 600,
        essential: true,
      });
    }
  }, [userPosition, followUser]);

  // Routes sync
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;
    const src = map.getSource("pending-route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!showPendingRoute || !pendingRouteGeometry || pendingRouteGeometry.length < 2) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    src.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: pendingRouteGeometry.map(([lat, lng]) => [lng, lat]) },
      properties: {},
    } as any);
  }, [pendingRouteGeometry, showPendingRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;
    const src = map.getSource("active-route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!showRoute || !activeRouteGeometry || activeRouteGeometry.length < 2) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    src.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: activeRouteGeometry.map(([lat, lng]) => [lng, lat]) },
      properties: {},
    } as any);
  }, [activeRouteGeometry, showRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;
    const src = map.getSource("traveled-route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!traveledGeometry || traveledGeometry.length < 2) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    src.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: traveledGeometry.map(([lat, lng]) => [lng, lat]) },
      properties: {},
    } as any);
  }, [traveledGeometry]);

  // FlyTo
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    map.flyTo({
      center: [flyTo.lng, flyTo.lat],
      zoom: flyTo.zoom ?? Math.max(map.getZoom(), 17),
      pitch: 60,
      duration: 900,
      essential: true,
    });
  }, [flyTo]);

  // ---- Highlight the selected building ----
  // Whenever a delivery / pending stop is selected we look up its lat/lng,
  // ask the renderer "which building footprint sits under this point?", and
  // copy that polygon into the `selected-building` GeoJSON source so the
  // orange extrusion layer added in `add3DBuildings` lights it up.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;

    // Resolve the selection to a [lng, lat] target *and* the human-readable
    // address — we need the address to extract the house number for the big
    // orange label drawn on top of the selected polygon.
    let target: { lng: number; lat: number; address?: string } | null = null;
    if (selectedId) {
      const d = deliveries.find((x) => x.id === selectedId);
      if (d) target = { lng: d.lng, lat: d.lat, address: d.address };
      if (!target) {
        const p = pending.find((x) => x.id === selectedId);
        if (p) target = { lng: p.lng, lat: p.lat, address: p.address };
      }
    }

    const clearSelection = () => {
      const src = map.getSource("selected-building") as
        | maplibregl.GeoJSONSource
        | undefined;
      src?.setData({ type: "FeatureCollection", features: [] });
      const lm = map.getSource("last-mile") as
        | maplibregl.GeoJSONSource
        | undefined;
      lm?.setData({ type: "FeatureCollection", features: [] });
    };

    if (!target) {
      clearSelection();
      return;
    }
    const t = target;
    const houseNumber = extractHouseNumber(t.address);

    const findBuildingAtTarget = (): GeoJSON.Feature | null => {
      // The 3d-buildings layer must exist before we can query it.
      if (!map.getLayer("3d-buildings")) return null;
      const point = map.project([t.lng, t.lat]);
      // Direct hit first…
      let features = map.queryRenderedFeatures(point, {
        layers: ["3d-buildings"],
      });
      // …then expand the search ring (delivery markers can sit on the
      // pavement next to the building, not on the polygon itself).
      if (features.length === 0) {
        const radii = [12, 28, 60];
        for (const r of radii) {
          features = map.queryRenderedFeatures(
            [
              [point.x - r, point.y - r],
              [point.x + r, point.y + r],
            ],
            { layers: ["3d-buildings"] },
          );
          if (features.length > 0) break;
        }
      }
      if (features.length === 0) return null;
      // Pick the building whose centroid (approximated by the bbox of its
      // first ring) is closest to the click point — avoids picking a giant
      // courtyard polygon when a small house is right under the cursor.
      let best = features[0];
      let bestDist = Infinity;
      for (const f of features) {
        const g: any = f.geometry;
        const ring: number[][] | undefined =
          g?.type === "Polygon"
            ? g.coordinates?.[0]
            : g?.type === "MultiPolygon"
              ? g.coordinates?.[0]?.[0]
              : undefined;
        if (!ring || ring.length === 0) continue;
        let cx = 0;
        let cy = 0;
        for (const [lx, ly] of ring) {
          cx += lx;
          cy += ly;
        }
        cx /= ring.length;
        cy /= ring.length;
        const dx = cx - t.lng;
        const dy = cy - t.lat;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = f;
        }
      }
      return {
        type: "Feature",
        geometry: best.geometry as GeoJSON.Geometry,
        properties: { ...(best.properties ?? {}) },
      };
    };

    const apply = () => {
      const src = map.getSource("selected-building") as
        | maplibregl.GeoJSONSource
        | undefined;
      if (!src) return false;
      const feature = findBuildingAtTarget();
      if (feature) {
        // Inject the courier-readable house number so the symbol layer
        // `selected-building-number` can render it big over the polygon.
        if (houseNumber) {
          feature.properties = { ...(feature.properties ?? {}), housenumber: houseNumber };
        }
        src.setData({ type: "FeatureCollection", features: [feature] });
        // Also draw the "last mile" — a straight dashed line from the
        // closest point on the building footprint (parking edge) to the
        // exact target coordinate (entrance / yard pin). If we don't have
        // a building polygon, skip — the marker itself is enough.
        const lm = map.getSource("last-mile") as
          | maplibregl.GeoJSONSource
          | undefined;
        if (lm) {
          const edge = closestPointOnFeature(feature, t.lng, t.lat);
          if (edge) {
            const dx = edge[0] - t.lng;
            const dy = edge[1] - t.lat;
            // Skip the dashed line if the entrance is essentially on the
            // building edge already — drawing a 1-meter dash adds noise.
            const distDeg2 = dx * dx + dy * dy;
            if (distDeg2 > 1e-9) {
              lm.setData({
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: [edge, [t.lng, t.lat]],
                },
                properties: {},
              } as any);
            } else {
              lm.setData({ type: "FeatureCollection", features: [] });
            }
          }
        }
        return true;
      }
      return false;
    };

    // Clear stale highlight while we look for the new one.
    clearSelection();

    // Try immediately; if the building tile around `target` isn't loaded
    // yet (we just changed selection and the camera is still flying) wait
    // for the next idle frame and try again — up to a small number of
    // retries so we don't leak listeners forever.
    if (apply()) return;

    let attempts = 0;
    const onIdle = () => {
      attempts += 1;
      if (apply() || attempts >= 4) {
        map.off("idle", onIdle);
      }
    };
    map.on("idle", onIdle);
    return () => {
      map.off("idle", onIdle);
    };
  }, [selectedId, deliveries, pending]);

  return (
    // `min-h-[520px]` is a *defensive* floor: even if a grandparent in the
    // page collapses (narrow viewport, header wraps, flex/grid track shrinks
    // to its 1fr basis, etc.) the map itself refuses to render in less than
    // 520px so the canvas can't end up as a 300px strip.
    <div className={cn("relative w-full h-full min-h-[520px]", className)}>
      {/* Container uses block layout (w-full h-full) instead of `absolute
          inset-0` so its height is driven by the outer div's min-height even
          when the absolute positioning containing block would otherwise
          collapse to 0. */}
      <div ref={containerRef} className="w-full h-full min-h-[520px]" />
      {loading && !initError ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/40">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground animate-pulse">
            загружаю 3D-карту…
          </div>
        </div>
      ) : null}
      {initError ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6 bg-background/80 backdrop-blur-sm">
          <div className="max-w-md text-center space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              3D недоступно
            </div>
            <div className="text-sm text-foreground">{initError}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

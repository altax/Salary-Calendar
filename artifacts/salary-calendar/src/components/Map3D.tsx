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
        paint:
          theme === "dark"
            ? { "raster-brightness-min": 0.0, "raster-brightness-max": 0.55, "raster-saturation": -0.35, "raster-contrast": 0.1 }
            : {},
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

function jobColor(job: ResolvedJob | undefined, theme: "dark" | "light"): string {
  if (job?.color) return job.color;
  if (job?.id === "ozon") return theme === "dark" ? "#fafafa" : "#0a0a0a";
  return theme === "dark" ? "#888" : "#666";
}

function detectWebGL(): { ok: boolean; reason?: string } {
  try {
    const probe = document.createElement("canvas");
    const gl =
      (probe.getContext("webgl2") as WebGL2RenderingContext | null) ||
      (probe.getContext("webgl") as WebGLRenderingContext | null) ||
      (probe.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!gl) return { ok: false, reason: "Контекст WebGL не создан." };
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Неизвестная ошибка WebGL.",
    };
  }
}

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

    console.log("[Map3D] init start");
    setLoading(true);

    const webgl = detectWebGL();
    if (!webgl.ok) {
      console.warn("[Map3D] webgl unavailable:", webgl.reason);
      setInitError(
        `Этому браузеру недоступен WebGL (${webgl.reason ?? ""}). 3D-карта не запустится. Вернись в обычный режим кнопкой 3D слева.`,
      );
      setLoading(false);
      return;
    }

    let map: MLMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildBaseStyle(themeRef.current),
        center: depot ? [depot.lng, depot.lat] : SPB_CENTER,
        zoom: initialZoom,
        pitch: 60,
        bearing: -17,
        canvasContextAttributes: { antialias: true },
        attributionControl: { compact: true },
        maxPitch: 75,
        // Any URL that points at the OpenFreeMap upstream (e.g. the
        // openmaptiles vector source we add later for 3D buildings, or
        // glyph URLs in the inline style) must be routed through our
        // same-origin proxy so it works on networks that block the
        // upstream Cloudflare host.
        transformRequest: (url) => ({ url: rewriteOpenFreeMapUrl(url) }),
      });
    } catch (err) {
      console.error("[Map3D] map ctor failed", err);
      setInitError(
        err instanceof Error
          ? `Не удалось создать 3D-карту: ${err.message}`
          : "Не удалось создать 3D-карту.",
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
        map.addLayer({
          id: "active-route-line",
          type: "line",
          source: "active-route",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#22c55e",
            "line-width": 5,
            "line-opacity": 0.95,
          },
        });
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
      map.easeTo({
        center: [userPosition.lng, userPosition.lat],
        zoom: Math.max(map.getZoom(), 17),
        duration: 600,
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

  return (
    <div className={cn("relative w-full h-full", className)}>
      <div ref={containerRef} className="absolute inset-0" />
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

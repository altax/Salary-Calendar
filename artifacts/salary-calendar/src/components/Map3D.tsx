import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  Map as MLMap,
  Marker as MLMarker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import SunCalc from "suncalc";
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  LightingEffect,
  AmbientLight,
  _SunLight as SunLight,
  type Layer,
} from "@deck.gl/core";
import { PathLayer, ColumnLayer } from "@deck.gl/layers";
import mlcontour from "maplibre-contour";
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
// Satellite imagery — ArcGIS World Imagery, free w/ attribution. This is
// the single highest-impact change vs. a flat vector basemap: courtyards,
// asphalt, parking lots, trees, even individual cars become recognisable
// instead of being painted-on flat shapes. Same source the 2D MapView
// already uses in "satellite" mode, so no new external dependency.
const SAT_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SAT_ATTR =
  'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
// AWS Terrarium DEM (Mapzen-format) — free, open, CORS-enabled. Drives
// MapLibre's `setTerrain` so hills look like hills instead of a flat
// plane. If AWS is unreachable we silently degrade to flat ground — the
// raster basemap and 3D buildings still render fine without DEM.
const TERRAIN_DEM_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

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
  const osmTiles = subs.map((s) => `${origin}${OSM_PROXY_PREFIX}/${s}/{z}/{x}/{y}.png`);
  const background = theme === "dark" ? "#0a0d12" : "#1f2a36";
  return {
    version: 8,
    glyphs: `${origin}${OPENFREEMAP_PROXY_PREFIX}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      // Satellite imagery — the actual ground photo. Loaded directly
      // from ArcGIS (CORS-enabled, no proxy needed).
      satellite: {
        type: "raster",
        tiles: [SAT_TILES],
        tileSize: 256,
        attribution: SAT_ATTR,
        maxzoom: 19,
      },
      // Plain OSM raster as a *fallback* drawn underneath satellite. If a
      // satellite tile fails to load we still see something instead of a
      // black void. Heavily dimmed so it doesn't fight the photograph.
      osm: {
        type: "raster",
        tiles: osmTiles,
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
        // Bottom: dimmed OSM as a safety net for missing sat tiles.
        id: "osm-fallback",
        type: "raster",
        source: "osm",
        minzoom: 0,
        maxzoom: 22,
        paint: {
          "raster-brightness-min": 0.0,
          "raster-brightness-max": 0.35,
          "raster-saturation": -0.6,
          "raster-opacity": 0.6,
        },
      },
      {
        // Real ground photograph. We warm-tint the raster a touch so it
        // matches the warmer Google-style palette instead of looking
        // like a washed-out aerial-survey photograph (which is exactly
        // what raw Esri imagery is). `raster-hue-rotate` shifts the
        // overall tone toward yellow-warm, `raster-saturation` modestly
        // boosts colour, and `raster-contrast` gives shadows real
        // depth so trees / buildings on the photo read as 3D too.
        id: "satellite-tiles",
        type: "raster",
        source: "satellite",
        minzoom: 0,
        maxzoom: 22,
        paint:
          theme === "dark"
            ? {
                "raster-brightness-min": 0.0,
                "raster-brightness-max": 0.65,
                "raster-saturation": -0.05,
                "raster-contrast": 0.18,
                "raster-hue-rotate": 8,
              }
            : {
                "raster-brightness-min": 0.06,
                "raster-brightness-max": 1.0,
                "raster-saturation": 0.18,
                "raster-contrast": 0.22,
                "raster-hue-rotate": 6,
              },
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

// ---- Geometry helpers used by the deck.gl tree scatter ----

// Flatten Polygon / MultiPolygon coordinates to a single array of rings.
// Rings are *raw* lng/lat pairs — we never reproject because the trees we
// scatter are in the same WGS84 space deck.gl understands natively.
function ringsOf(geometry: any): number[][][] | null {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return geometry.coordinates as number[][][];
  if (geometry.type === "MultiPolygon")
    return (geometry.coordinates as number[][][][]).flat();
  return null;
}

function bboxOf(rings: number[][][]): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

// Linear congruential PRNG. We need a *deterministic* PRNG seeded by the
// polygon's bbox so the same park keeps the same tree positions across
// every move/zoom — a stochastic scatter would flicker on every frame.
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// Cheap stable 32-bit hash of a (lng, lat) tuple → seed for `lcg`.
function hashCoord(x: number, y: number): number {
  const ix = Math.floor((x + 180) * 1e5);
  const iy = Math.floor((y + 90) * 1e5);
  let h = ix ^ Math.imul(iy, 0x9e37_79b1);
  h = Math.imul(h ^ (h >>> 15), 0x85eb_ca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Even-odd ray-cast point-in-polygon, honouring holes: ring 0 is the
// outer boundary, every subsequent ring is a hole. We treat the
// *combined* parity of all rings as the inside test (standard GeoJSON
// Polygon convention).
function pointInRings(x: number, y: number, rings: number[][][]): boolean {
  let inside = false;
  for (let r = 0; r < rings.length; r += 1) {
    const ring = rings[r];
    let inThisRing = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inThisRing = !inThisRing;
    }
    if (r === 0) inside = inThisRing;
    else if (inThisRing) inside = !inside; // hole punches a hole
  }
  return inside;
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

// Astronomically correct sun position for the courier's actual lat/lng &
// local time, courtesy of `suncalc`. SunCalc returns:
//   altitude — radians above horizon (>0 day, <0 night)
//   azimuth  — radians from south, west-positive (NOTE: NOT from north!)
// We translate to MapLibre's convention:
//   azimuth — degrees clockwise from north
//   polar   — degrees from straight up (0=zenith, 90=horizon)
// and pick a colour temperature that matches real-world light: deep blue
// at night, warm orange near sunrise/sunset, neutral white at midday.
function computeSolarLight(
  date: Date,
  lat = 59.9343, // default to SPb so it works even before first GPS fix
  lng = 30.3351,
): { azimuth: number; polar: number; intensity: number; color: string } {
  const sun = SunCalc.getPosition(date, lat, lng);
  // SunCalc azimuth: 0 = south, +west. Map convention: 0 = north, +east.
  // North-from-south is +180°, then we flip the sign because we want the
  // *direction the sun is in*, not the direction it points to.
  const azimuth = ((sun.azimuth * 180) / Math.PI + 180 + 360) % 360;
  const altitudeDeg = (sun.altitude * 180) / Math.PI;
  // Below horizon → render moon-like cool light from anti-sun direction
  // so the city doesn't go pitch-black. We still want SOME shading so 3D
  // is readable; pick a fixed low elevation moon-ish position.
  if (altitudeDeg < -2) {
    return {
      azimuth: (azimuth + 180) % 360,
      polar: 80,
      intensity: 0.12,
      color: "#8aa7d4",
    };
  }
  // Polar = 90° - altitude. Clamp to keep the sun above the rendered horizon.
  const polar = Math.max(2, Math.min(88, 90 - altitudeDeg));
  // Intensity: peaks at noon-ish, soft at horizon. Use a smooth curve.
  const intensity = Math.max(
    0.15,
    Math.min(0.6, 0.15 + Math.sin((Math.PI * altitudeDeg) / 180) * 0.55),
  );
  // Colour temperature: warm near horizon, white at zenith. Anchored at
  // ~3000 K (golden hour) → ~5800 K (midday).
  let color = "#ffffff";
  if (altitudeDeg < 6) color = "#ff9f5a"; // golden hour
  else if (altitudeDeg < 12) color = "#ffd28a"; // soft warm
  else if (altitudeDeg < 25) color = "#fff1d2"; // morning / late afternoon
  return { azimuth, polar, intensity, color };
}

function applySolarLight(map: MLMap, theme: "dark" | "light") {
  try {
    const { azimuth, polar, intensity, color } = computeSolarLight(new Date());
    map.setLight({
      anchor: "map",
      // [radial, azimuth, polar] in degrees — radial=1.5 keeps the source
      // off-center so faces facing the sun are noticeably lighter than
      // those in shadow.
      position: [1.5, azimuth, polar],
      color,
      intensity: theme === "dark" ? Math.max(0.15, intensity * 0.7) : intensity,
    });
  } catch (err) {
    console.warn("[Map3D] setLight failed", err);
  }
}

// Build a deck.gl `LightingEffect` synced with the same astronomically
// correct sun position MapLibre uses for `setLight`. Anything rendered via
// the deck.gl overlay (route ribbon, 3D trees, future glTF models) gets
// shaded by the *real* sun for the courier's actual local time, which means
// the highlights on tree canopies and the route ribbon match the highlights
// on the buildings — instead of looking like two unrelated 3D scenes
// stacked on top of each other.
function buildLightingEffect(date: Date, lat: number, lng: number): LightingEffect {
  const ambient = new AmbientLight({
    color: [255, 255, 255],
    intensity: 1.2,
  });
  // SunLight expects an absolute UTC timestamp in ms. It internally
  // computes its own sun position from the timestamp + viewport latitude,
  // which is consistent enough with our SunCalc output that the highlights
  // line up to within a few degrees.
  const sun = new SunLight({
    timestamp: date.getTime(),
    color: [255, 240, 220],
    intensity: 1.6,
    _shadow: true,
  });
  // Centre shadows on the courier's actual position so the deck.gl shadow
  // map covers the visible viewport tightly (rather than wasting half its
  // resolution on Antarctica).
  void lat;
  void lng;
  return new LightingEffect({ ambient, sun });
}

function applyAtmosphere(map: MLMap, theme: "dark" | "light") {
  try {
    // Pull the time-of-day sun so the sky / horizon palette actually
    // matches the lighting on the buildings — golden-warm at sunrise &
    // sunset, neutral blue at midday, deep navy at night. Without this
    // the sky is always the same colour and the scene reads as fake.
    const { polar, color: sunColor } = computeSolarLight(new Date());
    // High polar = sun near horizon → strong warm sunset palette.
    const sunsetMix = Math.max(0, Math.min(1, (polar - 50) / 35));
    if (theme === "dark") {
      map.setSky({
        "sky-color": sunsetMix > 0.4 ? "#1b1224" : "#0a1428",
        "sky-horizon-blend": 0.5,
        "horizon-color": sunsetMix > 0.4 ? "#5a3320" : "#1f2a3d",
        "horizon-fog-blend": 0.85,
        "fog-color": sunsetMix > 0.4 ? "#1a0e08" : "#0c0e12",
        "fog-ground-blend": 0.55,
        "atmosphere-blend": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          1,
          16,
          0.7,
          20,
          0.2,
        ],
      } as any);
    } else {
      // Daytime / dawn / dusk warm gradient. The horizon picks up the
      // sun colour so distant buildings fade into the same hue as the
      // sun on their faces — that's the "they're really far away"
      // depth cue Google has and we don't, until now.
      const isWarmHour = sunsetMix > 0.3;
      map.setSky({
        "sky-color": isWarmHour ? "#f3c590" : "#9fbedc",
        "sky-horizon-blend": 0.65,
        "horizon-color": isWarmHour ? sunColor : "#dbe6f0",
        "horizon-fog-blend": 0.85,
        "fog-color": isWarmHour ? "#f0d4ad" : "#cdd9e6",
        "fog-ground-blend": 0.55,
        "atmosphere-blend": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          1,
          16,
          0.6,
          20,
          0.15,
        ],
      } as any);
    }
  } catch (err) {
    console.warn("[Map3D] setSky failed", err);
  }
}

// Add cast shadows for buildings, projected onto the satellite ground
// in the anti-sun direction. This is the single biggest "buildings are
// really sitting on this photograph" cue we can ship without textured
// 3D meshes — every box now has a real-feeling soft shadow that moves
// with time of day, which is the gestalt cue Google Earth has and an
// untextured extrusion stack does not.
//
// Implementation: a duplicate fill (NOT extrusion) layer of building
// footprints, painted semi-transparent black, displaced via
// `fill-translate` in map-pixel space along the projected sun-azimuth.
// We sit the layer JUST BELOW `3d-buildings` so the part of the shadow
// under the building itself is hidden by the extrusion — only the part
// that *extends past the footprint* is visible, exactly like a real
// cast shadow.
function addBuildingShadows(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("building-shadow")) return;
  addOpenMapTilesVectorSource(map);
  if (!map.getSource("openmaptiles")) return;
  const { azimuth, polar } = computeSolarLight(new Date());
  // Sun height above horizon: polar==0 → directly overhead, polar==90 → on
  // horizon. Real shadow length = h / tan(altitude). altitude = 90-polar.
  const altitudeRad = ((90 - polar) * Math.PI) / 180;
  // Cap so a low sun doesn't produce kilometre-long pixel shadows that
  // look wrong on screen. 2.4 ≈ shadow 2.4× building height, plenty.
  const lenPerH = Math.min(
    2.4,
    1 / Math.max(0.18, Math.tan(altitudeRad)),
  );
  // Rough "average building height" we're projecting for. The fill
  // layer can't read per-feature height into the translate paint
  // expression (translate doesn't accept data expressions), so we
  // approximate with one offset that looks right for the bulk of
  // residential / commercial stock (~16 m).
  const avgHeightM = 16;
  // Convert metres → screen pixels at zoom 17 in Питер (~4 m/px). This
  // is a fixed ratio because fill-translate is in pixels, not metres.
  const metresPerPx = 4;
  const lengthPx = (avgHeightM * lenPerH) / metresPerPx;
  // Anti-sun direction (the side the shadow falls on). MapLibre +x = east,
  // +y = south in map-pixel space when translate-anchor is "map".
  const antiAzRad = ((azimuth + 180) * Math.PI) / 180;
  const dx = Math.sin(antiAzRad) * lengthPx;
  const dy = -Math.cos(antiAzRad) * lengthPx;
  try {
    map.addLayer({
      id: "building-shadow",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-color": "#000000",
        "fill-opacity": theme === "dark" ? 0.32 : 0.28,
        "fill-translate": [dx, dy],
        "fill-translate-anchor": "map",
        // No outline — pure soft pad of darkness on the ground.
        "fill-antialias": true,
      },
    } as any);
  } catch (err) {
    console.warn("[Map3D] building shadows failed", err);
  }
}

// Module-level singleton so we add the maplibre-contour DemSource exactly
// once per page load even if the map is recreated (theme switch, route
// change, …). DemSource registers a global protocol handler — calling
// `setupMaplibre` twice would silently leak workers.
let demSourceSingleton: any = null;
function getDemSource(): any {
  if (demSourceSingleton) return demSourceSingleton;
  demSourceSingleton = new (mlcontour as any).DemSource({
    url: TERRAIN_DEM_TILES,
    encoding: "terrarium",
    maxzoom: 12,
    worker: true,
    cacheSize: 100,
    // 4s instead of 10s — AWS Terrarium tiles are slow from RU and a long
    // timeout just means each missed tile blocks a worker for 10s, gumming
    // up subsequent fetches. Better to fail fast and let terrain degrade.
    timeoutMs: 4_000,
  });
  demSourceSingleton.setupMaplibre(maplibregl);
  return demSourceSingleton;
}

// Enable real 3D terrain via an AWS Terrarium DEM source. Even gentle
// elevation makes the world feel like a *place* instead of a flat
// diorama — ridges cast shading on themselves, roads visibly climb,
// the horizon stops being a perfect line. We keep exaggeration *very*
// modest (0.4) because the courier's main beats are flat city blocks
// where higher exaggeration would warp the satellite photograph and the
// building bases into a melted mess; at 0.4, hilly outskirts (Pulkovo,
// Karelian isthmus) still read as elevated while flat blocks stay flat.
function applyTerrain(map: MLMap) {
  if (map.getSource("dem")) return;
  try {
    const dem = getDemSource();
    map.addSource("dem", {
      type: "raster-dem",
      // Route raster-DEM tile fetches through maplibre-contour's shared
      // protocol so the same downloaded tile drives both `setTerrain`
      // (3D relief) and the contour-line vector source below — no double
      // network cost.
      tiles: [dem.sharedDemProtocolUrl],
      tileSize: 256,
      maxzoom: 12,
      attribution:
        '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Tilezen Joerd</a>',
    } as any);
    map.setTerrain({ source: "dem", exaggeration: 0.4 } as any);
  } catch (err) {
    console.warn("[Map3D] terrain failed (non-fatal)", err);
  }
}

// Add subtle topographic contour lines derived client-side from the same
// DEM tiles `applyTerrain` uses. Even when terrain exaggeration is dialled
// down, contour lines give the courier an instant read on which way is
// uphill — exactly the cue you lose on a flat satellite photograph. Very
// thin, low-opacity lines so they whisper rather than shout.
function addContourLines(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("contour-line")) return;
  try {
    const dem = getDemSource();
    map.addSource("contour-source", {
      type: "vector",
      tiles: [
        dem.contourProtocolUrl({
          // Major contours every 50 m, minor every 10 m. Питер's elevation
          // span is ~70 m end-to-end so this gives 1-2 majors visible at
          // typical zoom rather than dense pasta.
          thresholds: { 11: [50, 10], 12: [50, 10], 13: [25, 5], 14: [10, 2] },
          elevationKey: "ele",
          levelKey: "level",
          contourLayer: "contours",
        }),
      ],
      maxzoom: 15,
    } as any);
    const lineColor = theme === "dark" ? "#a08762" : "#5a4624";
    map.addLayer({
      id: "contour-line",
      type: "line",
      source: "contour-source",
      "source-layer": "contours",
      minzoom: 11,
      paint: {
        "line-color": lineColor,
        "line-width": ["match", ["get", "level"], 1, 0.9, 0.4],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          0.35,
          14,
          0.55,
          17,
          0.0,
        ],
      },
    } as any);
  } catch (err) {
    console.warn("[Map3D] contour lines failed (non-fatal)", err);
  }
}

// Render rivers / canals / sea as a *deep* blue with a touch of vertical
// depth so the Neva and Финский залив feel like water rather than blue
// stickers on the satellite photograph. Uses openmaptiles `water` polygons
// drawn under the buildings + road overlay.
function addWaterDepth(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("water-depth")) return;
  addOpenMapTilesVectorSource(map);
  if (!map.getSource("openmaptiles")) return;
  try {
    map.addLayer(
      {
        id: "water-depth",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: {
          "fill-color": theme === "dark" ? "#0b2238" : "#3f6c9b",
          "fill-opacity": theme === "dark" ? 0.78 : 0.55,
          "fill-antialias": true,
        },
      } as any,
      // Sit just above the satellite raster but under everything else.
      map.getLayer("road-overlay-casing") ? "road-overlay-casing" : undefined,
    );
  } catch (err) {
    console.warn("[Map3D] water depth failed", err);
  }
}

// Draw a thin vector road overlay on top of the satellite photo. Without
// this the photographed asphalt is hard to read at speed — too much
// noise from cars/lane markings/shadows. With it, every street has a
// crisp white casing and a darker centre line, so the road network
// "pops" off the photo the same way it does in Google's hybrid view.
function addRoadOverlay(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("road-overlay-line")) return;
  addOpenMapTilesVectorSource(map);
  if (!map.getSource("openmaptiles")) return;
  // Driveable road classes from openmaptiles `transportation` layer.
  const ROAD_CLASSES = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "minor",
    "service",
    "residential",
    "unclassified",
    "living_street",
  ];
  const isRoad: any = ["in", ["get", "class"], ["literal", ROAD_CLASSES]];
  // Width grows with zoom + ramps up with road class importance.
  const widthExpr: any = [
    "interpolate",
    ["exponential", 1.4],
    ["zoom"],
    12,
    [
      "match",
      ["get", "class"],
      "motorway",
      2.0,
      "trunk",
      1.6,
      "primary",
      1.2,
      "secondary",
      0.9,
      0.6,
    ],
    18,
    [
      "match",
      ["get", "class"],
      "motorway",
      18,
      "trunk",
      15,
      "primary",
      12,
      "secondary",
      10,
      "tertiary",
      8,
      "service",
      4,
      6,
    ],
  ];
  try {
    map.addLayer({
      id: "road-overlay-casing",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: isRoad,
      minzoom: 12,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": theme === "dark" ? "#0f1418" : "#ffffff",
        "line-opacity": theme === "dark" ? 0.6 : 0.85,
        // NOTE: must be a standalone top-level interpolate over ["zoom"].
        // MapLibre forbids nesting `["zoom"]` inside arithmetic ops, so we
        // can't reuse `widthExpr` here via `["*", widthExpr, 1.6]` — we
        // hard-code the casing widths (slightly bigger than `widthExpr`
        // per class) instead.
        "line-width": [
          "interpolate",
          ["exponential", 1.4],
          ["zoom"],
          12,
          [
            "match",
            ["get", "class"],
            "motorway",
            3.2,
            "trunk",
            2.6,
            "primary",
            2.0,
            "secondary",
            1.5,
            1.0,
          ],
          18,
          [
            "match",
            ["get", "class"],
            "motorway",
            22,
            "trunk",
            19,
            "primary",
            16,
            "secondary",
            14,
            "tertiary",
            12,
            "service",
            8,
            10,
          ],
        ],
      },
    } as any);
    map.addLayer({
      id: "road-overlay-line",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: isRoad,
      minzoom: 12,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color":
          theme === "dark"
            ? [
                "match",
                ["get", "class"],
                "motorway",
                "#fbbf24",
                "trunk",
                "#fbbf24",
                "primary",
                "#e5e7eb",
                "#cbd5e1",
              ]
            : [
                "match",
                ["get", "class"],
                "motorway",
                "#f59e0b",
                "trunk",
                "#f59e0b",
                "primary",
                "#fde68a",
                "#f1f5f9",
              ],
        "line-opacity": theme === "dark" ? 0.78 : 0.88,
        "line-width": widthExpr,
      },
    } as any);
  } catch (err) {
    console.warn("[Map3D] road overlay failed", err);
  }
}

// Extrude wooded / green areas as low volumes. Real trees are tall
// stochastic shapes, but even a flat 4 m green slab (woods) + 1.5 m
// grass slab dramatically improves the "this is a place" feeling
// because the courtyard in front of the destination is no longer
// painted onto the ground — it has *thickness*.
function addGreenVolumes(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("green-volume-wood")) return;
  addOpenMapTilesVectorSource(map);
  if (!map.getSource("openmaptiles")) return;
  try {
    map.addLayer({
      id: "green-volume-wood",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      minzoom: 13,
      paint: {
        "fill-extrusion-color": theme === "dark" ? "#1f3a23" : "#3b7a3a",
        "fill-extrusion-base": 0,
        "fill-extrusion-height": [
          "interpolate",
          ["linear"],
          ["zoom"],
          13,
          0,
          15,
          4,
          18,
          8,
        ],
        "fill-extrusion-opacity": 0.85,
      },
    } as any);
    map.addLayer({
      id: "green-volume-grass",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["grass", "park"]]],
      minzoom: 14,
      paint: {
        "fill-extrusion-color": theme === "dark" ? "#2c4a2e" : "#7fb87b",
        "fill-extrusion-base": 0,
        "fill-extrusion-height": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          0,
          17,
          1.5,
          19,
          2.2,
        ],
        "fill-extrusion-opacity": 0.7,
      },
    } as any);
  } catch (err) {
    console.warn("[Map3D] green volumes failed", err);
  }
}

// Add commercial POIs (shops, supermarkets, ПВЗ-like points) from the
// openmaptiles `poi` source-layer. We deliberately keep the visual very
// quiet — small bright dot at zoom 16+, name label at 17+ — so the
// route + selected building stay the heroes but the courier still
// sees recognisable landmarks ("оп, тут Пятёрочка на углу — да, я уже
// почти у точки").
function addPoiLandmarks(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("poi-shops-dot")) return;
  addOpenMapTilesVectorSource(map);
  if (!map.getSource("openmaptiles")) return;
  // openmaptiles `poi` layer carries a `class` field. We pick everyday-life
  // anchors a courier actually uses to confirm they're in the right area.
  const SHOP_CLASSES = [
    "shop",
    "supermarket",
    "convenience",
    "mall",
    "department_store",
    "alcohol",
    "bakery",
    "clothes",
    "marketplace",
    "fast_food",
    "cafe",
    "restaurant",
    "bank",
    "atm",
    "post",
    "pharmacy",
  ];
  try {
    map.addLayer({
      id: "poi-shops-dot",
      type: "circle",
      source: "openmaptiles",
      "source-layer": "poi",
      filter: ["in", ["get", "class"], ["literal", SHOP_CLASSES]],
      minzoom: 16,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          16,
          2.5,
          18,
          4,
          20,
          5.5,
        ],
        "circle-color": "#ffb84d",
        "circle-stroke-color": theme === "dark" ? "#1a1a20" : "#1f2937",
        "circle-stroke-width": 1,
        "circle-opacity": 0.9,
      },
    } as any);
    map.addLayer({
      id: "poi-shops-label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "poi",
      filter: ["in", ["get", "class"], ["literal", SHOP_CLASSES]],
      minzoom: 17,
      layout: {
        "text-field": ["coalesce", ["get", "name:ru"], ["get", "name"], ""],
        "text-font": ["Noto Sans Bold"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          17,
          10,
          19,
          12,
          21,
          14,
        ],
        "text-offset": [0, 0.9],
        "text-anchor": "top",
        "text-padding": 4,
        "text-optional": true,
      },
      paint: {
        "text-color": theme === "dark" ? "#ffd9a8" : "#7a3d00",
        "text-halo-color": theme === "dark" ? "#0a0d12" : "#ffffff",
        "text-halo-width": 1.4,
      },
    } as any);
  } catch (err) {
    console.warn("[Map3D] poi layer failed", err);
  }
}

// Add the on-asphalt maneuver arrow — a single big rotated chevron drawn
// at the upcoming turn point. Reads the rotation angle from the feature's
// `bearing` property so we can update just the source on every frame.
function addManeuverArrow(map: MLMap) {
  if (map.getSource("next-maneuver")) return;
  try {
    map.addSource("next-maneuver", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "next-maneuver-glow",
      type: "circle",
      source: "next-maneuver",
      minzoom: 14,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          12,
          17,
          26,
          19,
          44,
        ],
        "circle-color": "#38bdf8",
        "circle-opacity": 0.18,
        "circle-blur": 0.6,
      },
    } as any);
    map.addLayer({
      id: "next-maneuver-arrow",
      type: "symbol",
      source: "next-maneuver",
      minzoom: 14,
      layout: {
        "text-field": ["get", "arrow"],
        "text-font": ["Noto Sans Bold"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          22,
          17,
          42,
          19,
          64,
        ],
        // Lay the glyph flat on the ground, rotated into the road's
        // bearing so it reads "from behind the steering wheel".
        "text-rotation-alignment": "map",
        "text-pitch-alignment": "map",
        "text-rotate": ["get", "bearing"],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-padding": 0,
      },
      paint: {
        "text-color": "#0c1f3a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 3,
        "text-halo-blur": 0.4,
      },
    } as any);
  } catch (err) {
    console.warn("[Map3D] maneuver arrow layer failed", err);
  }
}

// Mask out parking-lot dotted markings baked into the OSM raster by drawing
// a flat fill on top using the `landuse` vector layer where class=parking.
// Without this, every parking lot looks like a noisy hatched mess that
// fights with the route line and the highlighted building.
function addParkingMask(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("parking-mask")) return;
  // Need the openmaptiles vector source — same one used for 3D buildings.
  addOpenMapTilesVectorSource(map);
  if (!map.getSource("openmaptiles")) return;
  try {
    map.addLayer(
      {
        id: "parking-mask",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landuse",
        filter: ["==", ["get", "class"], "parking"],
        paint: {
          "fill-color": theme === "dark" ? "#161a20" : "#cfd4dc",
          "fill-opacity": 0.85,
        },
      } as any,
      // Draw under the 3D buildings if they're already in the style.
      map.getLayer("3d-buildings") ? "3d-buildings" : undefined,
    );
  } catch (err) {
    console.warn("[Map3D] parking mask failed", err);
  }
}

function add3DBuildings(map: MLMap, theme: "dark" | "light") {
  if (map.getLayer("3d-buildings")) return;
  const isDark = theme === "dark";
  // Color ramp now reads as a proxy for *building type* via height —
  // courier-relevant because:
  //   0-12 m   → warm tan = private houses, garages, ПВЗ-боксы
  //   12-30 m  → neutral steel = панельки, residential apartments
  //   30-80 m  → cool blue = коммерческие башни, бизнес-центры
  //   80 m+    → bright steel = небоскрёбы, ориентиры
  // The contrast between bands is intentionally bigger than before so
  // even a fast glance tells the courier "это жилой район" vs "это БЦ".
  // Natural palette tuned to *blend* with the satellite photograph rather
  // than fight it. Crayon-bright extrusion colours (steel-blue towers,
  // orange low-rises) make the scene look like Lego on top of a photo.
  // Real Google-3D buildings have textured beige-grey facades; we
  // approximate with desaturated cream → warm grey → cool grey, all
  // close in luminance to the average satellite ground tone.
  // Lifted dark-theme palette: at a few % brighter the buildings read
  // as light-grey solid models lit from above (which is what they should
  // look like on a satellite navigator), instead of burnt smudges that
  // blend into the satellite shadows.
  const buildingColor = isDark ? "#5a5852" : "#e6dcc9"; // low / warm grey
  const buildingMid = isDark ? "#65676d" : "#cfc6b8"; // mid / cool grey
  const buildingTop = isDark ? "#71757d" : "#b9b3aa"; // tall / lighter grey
  const buildingTall = isDark ? "#7c828c" : "#a39f97"; // tower / palest grey

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
          12,
          buildingColor,
          22,
          buildingMid,
          45,
          buildingTop,
          90,
          buildingTall,
          200,
          buildingTall,
        ],
        "fill-extrusion-height": heightExpr,
        "fill-extrusion-base": baseExpr,
        "fill-extrusion-opacity": 0.92,
        // Vertical gradient was making buildings look like they were melting
        // into the satellite imagery (darker near the ground, lighter at
        // top — on satellite that reads as a smudged shadow, not a solid
        // structure). Solid color + SunLight directional shading gives
        // them the volume of a real model without the "drip" artefact.
        "fill-extrusion-vertical-gradient": false,
        // NOTE: `fill-extrusion-ambient-occlusion-*` exists in Mapbox GL JS
        // but is NOT a MapLibre paint property — adding it spams the
        // console with "unknown property" errors and the AO never
        // renders anyway. Building grounding comes from SunLight only.
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

export type Map3DNextManeuver = {
  lat: number;
  lng: number;
  /** A short glyph that visually summarises the turn — e.g. "↰", "↱", "↑". */
  arrow: string;
  /** OSRM modifier ("left", "right", "slight left", …) or null. */
  modifier?: string | null;
  /** Bearing in degrees the user is facing *before* the turn. */
  bearingBefore?: number | null;
  /** Bearing in degrees the user will face *after* the turn. */
  bearingAfter?: number | null;
  /** Distance from current GPS position to the maneuver point, in meters. */
  distanceM: number;
};

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
  /**
   * Upcoming turn descriptor. When provided and `followUser` is true, the
   * camera will pull back + lower its pitch on approach so the courier
   * sees the whole intersection, and a giant rotated arrow is drawn on
   * the asphalt at the maneuver point.
   */
  nextManeuver?: Map3DNextManeuver | null;
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
  nextManeuver,
  onMapReady,
}: Map3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<Map<string, MLMarker>>(new Map());
  const userMarkerRef = useRef<MLMarker | null>(null);
  const isLoadedRef = useRef(false);
  // deck.gl overlay shares the MapLibre WebGL context and renders 3D
  // content (route ribbon, scattered trees, future glTF models) on top
  // of the basemap. Multiple independent useEffects each own a *named*
  // slot in `deckLayersRef`; `pushDeckLayers` recombines them and shoves
  // the result into the overlay so they don't trample each other.
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  const deckLayersRef = useRef<{
    route?: Layer;
    trees?: Layer;
    treeTrunks?: Layer;
  }>({});
  const pushDeckLayers = useCallback(() => {
    const overlay = deckOverlayRef.current;
    if (!overlay) return;
    const slots = deckLayersRef.current;
    // Order matters: tree trunks first so the canopy hides their tops,
    // then route ribbon last so it sits visually on top of foliage.
    const layers = [slots.treeTrunks, slots.trees, slots.route].filter(
      Boolean,
    ) as Layer[];
    overlay.setProps({ layers });
  }, []);
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
      // Tile fetch errors are expected on flaky links (especially the AWS
      // Terrarium DEM bucket — slow from RU). Terrain & contour lines
      // degrade silently when tiles fail to load, so don't spam the
      // console with one warning per missed tile.
      if (
        e?.tile != null ||
        /timed out|Failed to fetch|NetworkError|AbortError/i.test(msg)
      ) {
        return;
      }
      console.warn("[Map3D] runtime error:", msg, e);
    });

    // Tile-loading metrics. We deliberately do NOT log every tile (used to
    // spam the console with hundreds of lines per move) — just keep counters
    // and emit a single summary line on the *first* idle after load so we
    // can confirm the basemap actually painted, then go quiet.
    let tileOk = 0;
    let firstIdleLogged = false;
    map.on("data", (e: any) => {
      if (e.dataType === "source" && e.tile && e.isSourceLoaded) {
        tileOk += 1;
      }
    });
    map.on("idle", () => {
      if (firstIdleLogged) return;
      firstIdleLogged = true;
      const canvas = map.getCanvas();
      console.log(
        "[Map3D] first idle — canvas %dx%d, tiles loaded: %d, zoom %s",
        canvas.clientWidth,
        canvas.clientHeight,
        tileOk,
        map.getZoom().toFixed(2),
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
        // 3D terrain — subtle (exaggeration 0.4) so flat city blocks stay
        // flat while hilly outskirts (Pulkovo, Karelian isthmus) read as
        // elevated. Drives `setTerrain` AND the contour-line vector source
        // below from one shared DEM tile fetch (maplibre-contour).
        applyTerrain(map);
        // Deep-blue water polygons (Neva / Финский залив). Drawn early
        // so the road overlay & buildings sit on top of it.
        addWaterDepth(map, themeRef.current);
        // Crisp vector road overlay over the satellite photo so the
        // network is legible at a glance even where the photograph is
        // shadowed or noisy.
        addRoadOverlay(map, themeRef.current);
        // 3D buildings — the single layer that makes the difference between
        // "satellite photo" and "I'm flying through a city". Painted in a
        // solid warm tone (no vertical gradient — gradient on satellite
        // looks like the buildings are melting into the ground).
        add3DBuildings(map, themeRef.current);
        // NOTE intentionally NOT loaded on satellite anymore:
        //   - addGreenVolumes (extruded grass/wood slabs): satellite already
        //     photographs trees & grass from above, so adding flat 4-8 m
        //     green prisms on top creates dark muddy blobs across every
        //     park / courtyard.
        //   - tree scatter (deck.gl ColumnLayers): same reason — duplicates
        //     real photographed trees with stylised brown columns and
        //     turns courtyards into a blob carpet at navigator pitch.
        //   - addBuildingShadows: combined with vertical-gradient on the
        //     extrusion this produced the "melting shadow" look the user
        //     called out. Real cast shadows now come from SunLight only.
        //   - addContourLines: visual noise at navigator zoom, especially
        //     in flat СПб where contour density doesn't add information.
        //   - addParkingMask: only useful against the dimmed OSM fallback;
        //     on real satellite imagery parking lots already look like
        //     parking lots.
        // Atmosphere: hazy horizon + ground-fog blend at distance, makes
        // the pitched 3D camera feel like depth instead of a flat diorama.
        applyAtmosphere(map, themeRef.current);
        // Time-of-day directional light: building faces facing the sun
        // get noticeably brighter than shaded ones, which is the single
        // cheapest visual cue that screams "this is 3D, not a sketch".
        applySolarLight(map, themeRef.current);
        // Commercial POI dots & labels (shops, supermarkets, bakeries, …).
        addPoiLandmarks(map, themeRef.current);
        // On-asphalt rotated chevron at the next maneuver point.
        addManeuverArrow(map);
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

      // Mount deck.gl as a MapLibre custom layer. It piggybacks on the
      // same WebGL context (no extra canvas, no z-fighting with markers)
      // and lets us render true 3D content (route ribbon, scattered trees,
      // future glTF models, future Google 3D-Tiles) interleaved with the
      // map layers. The `LightingEffect` here is what makes deck.gl
      // geometry pick up sun position so highlights match the buildings.
      try {
        const center = map.getCenter();
        const overlay = new MapboxOverlay({
          interleaved: true,
          layers: [],
          effects: [buildLightingEffect(new Date(), center.lat, center.lng)],
        });
        map.addControl(overlay as unknown as maplibregl.IControl);
        deckOverlayRef.current = overlay;
      } catch (err) {
        console.warn("[Map3D] deck.gl overlay failed", err);
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
      // Smart camera: if a maneuver is coming up within ~120 m we pull
      // back and lower the pitch a touch so the entire intersection
      // (and which lane to be in) fits inside the frame. After the
      // maneuver passes, the chase camera snaps back to its tight POV.
      const approachM = nextManeuver?.distanceM ?? Infinity;
      const isApproachingTurn = nextManeuver != null && approachM < 120;
      const isVeryClose = nextManeuver != null && approachM < 45;
      const baseZoom = hasHeading ? 17.6 : 17;
      const baseTurnZoom = hasHeading ? 16.5 : 16;
      const zoom = isApproachingTurn ? baseTurnZoom : baseZoom;
      // Lowered pitch (62° instead of 72°) so the upper quarter of the
      // viewport actually shows sky + horizon. Without visible horizon
      // the scene reads as a flat texture viewed from above; with it
      // the brain locks into "I'm in 3D space" instantly. Approaching a
      // turn we drop further so the whole intersection fits in frame.
      const pitch = isApproachingTurn
        ? isVeryClose
          ? 42
          : 50
        : hasHeading
          ? 62
          : Math.max(map.getPitch(), 55);
      // When very close to the turn, also pull the user marker more
      // toward the centre (less bottom padding) so we see what's
      // happening on *both* sides of the intersection.
      const bottomPad = isVeryClose
        ? Math.round(canvasH * 0.25)
        : isApproachingTurn
          ? Math.round(canvasH * 0.35)
          : Math.round(canvasH * 0.45);
      map.easeTo({
        center: [userPosition.lng, userPosition.lat],
        zoom: Math.max(map.getZoom() - 0.15, zoom),
        pitch,
        bearing: hasHeading ? (heading as number) : map.getBearing(),
        padding: hasHeading
          ? { top: 0, right: 0, bottom: bottomPad, left: 0 }
          : { top: 0, right: 0, bottom: 0, left: 0 },
        duration: 600,
        essential: true,
      });
    }
  }, [userPosition, followUser, nextManeuver?.distanceM]);

  // ---- Sync the on-asphalt maneuver arrow ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoadedRef.current) return;
    const src = map.getSource("next-maneuver") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!src) return;
    if (!nextManeuver || !Number.isFinite(nextManeuver.lat) || !Number.isFinite(nextManeuver.lng)) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    // Rotate so the chevron lays "into" the new road. We prefer the
    // bearing the courier will have *after* the turn (where the road
    // they're aiming at goes), and fall back to bearingBefore if that's
    // all we have. Subtract 0 — MapLibre's text-rotate is degrees
    // clockwise from north, same as OSRM.
    const rot =
      nextManeuver.bearingAfter ??
      nextManeuver.bearingBefore ??
      0;
    src.setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: [nextManeuver.lng, nextManeuver.lat] },
      properties: {
        arrow: nextManeuver.arrow || "↑",
        bearing: rot,
        modifier: nextManeuver.modifier ?? "",
      },
    } as any);
  }, [
    nextManeuver?.lat,
    nextManeuver?.lng,
    nextManeuver?.arrow,
    nextManeuver?.modifier,
    nextManeuver?.bearingBefore,
    nextManeuver?.bearingAfter,
  ]);

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

  // 3D route ribbon via deck.gl. The flat blue stripe on the asphalt
  // (above) tells the courier WHICH road to follow; this hovering ribbon
  // ~5 m up gives the navigation a real volumetric "neon trail" feel
  // that reads as 3D from any pitch.
  useEffect(() => {
    if (!deckOverlayRef.current) return;
    if (!showRoute || !activeRouteGeometry || activeRouteGeometry.length < 2) {
      deckLayersRef.current.route = undefined;
      pushDeckLayers();
      return;
    }
    // PathLayer eats [lng, lat, z] tuples. Lift each vertex 5 metres so
    // the ribbon floats just above buildings' ground floor and stays
    // visible when the camera is pitched steeply.
    const path = activeRouteGeometry.map(
      ([lat, lng]) => [lng, lat, 5] as [number, number, number],
    );
    deckLayersRef.current.route = new PathLayer({
      id: "route-3d-ribbon",
      data: [{ path }],
      getPath: (d: any) => d.path,
      // Bright cyan-blue gradient that matches our flat route casing.
      getColor: [70, 160, 255, 220],
      getWidth: 6,
      widthUnits: "meters",
      widthMinPixels: 4,
      widthMaxPixels: 28,
      capRounded: true,
      jointRounded: true,
      billboard: false,
      parameters: {
        // Render translucent against everything else, but still write to
        // depth so it occludes itself correctly along sharp turns.
        depthTest: true,
      },
    });
    pushDeckLayers();
  }, [activeRouteGeometry, showRoute, pushDeckLayers]);

  // 3D scattered trees were tried as a "courtyard depth" cue but failed
  // visually on satellite imagery: the photo already contains real trees
  // (correctly shaded, correctly placed), so adding deck.gl ColumnLayer
  // trunks + canopies on top duplicates them as muddy brown/dark-green
  // blobs that turn every park & courtyard into a blob carpet at
  // navigator pitch. Disabled. Effect now only ensures the slot is
  // clear so any previous layers are removed.
  useEffect(() => {
    deckLayersRef.current.trees = undefined;
    deckLayersRef.current.treeTrunks = undefined;
    pushDeckLayers();
  }, []);

  // Refresh deck.gl SunLight every 5 minutes so the highlight direction
  // tracks the actual sun across the day — a courier on a long shift
  // will see morning gold roll to white midday roll to evening warm.
  useEffect(() => {
    const overlay = deckOverlayRef.current;
    if (!overlay) return;
    const tick = () => {
      const map = mapRef.current;
      const c = map?.getCenter() ?? { lat: SPB_CENTER[1], lng: SPB_CENTER[0] };
      try {
        overlay.setProps({
          effects: [buildLightingEffect(new Date(), c.lat, c.lng)],
        });
      } catch {
        // overlay may be disposed mid-tick on theme switch — non-fatal.
      }
    };
    const id = window.setInterval(tick, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

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

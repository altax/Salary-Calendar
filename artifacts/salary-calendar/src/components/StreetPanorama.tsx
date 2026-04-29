import { useEffect, useRef, useState } from "react";
import maplibregl, { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cn } from "@/lib/utils";

export type StreetPanoramaProps = {
  open: boolean;
  lat: number | null;
  lng: number | null;
  title?: string;
  onClose: () => void;
};

const SAT_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SAT_ATTR =
  '© <a href="https://www.esri.com">Esri</a> · World Imagery';
const OFM_TILE_TEMPLATE = "/_tiles/openfreemap/planet/{z}/{x}/{y}.pbf";

// Camera defaults tuned for "standing on the street, looking forward".
// Pitch is at MapLibre's hard maximum (85°) so the horizon is just
// below the top of the canvas; zoom is high so the camera is close to
// the ground. Bearing starts pointing north and the user spins it.
const DEFAULT_PITCH = 85;
const DEFAULT_ZOOM = 19.5;

/**
 * Real, in-house street-level 3D panorama. Opens as a fullscreen modal
 * and renders a brand-new MapLibre instance pinned to the requested
 * coordinate, with the camera lowered to eye level (pitch 85°, very
 * high zoom). Only bearing rotation is exposed to the user — they spin
 * around the point to "look around" exactly like a true panorama, but
 * the imagery is the same satellite + 3D buildings + terrain we already
 * have. No external panorama service or API key needed.
 */
export default function StreetPanorama({
  open,
  lat,
  lng,
  title,
  onClose,
}: StreetPanoramaProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [bearing, setBearing] = useState(0);
  const [pitch, setPitch] = useState(DEFAULT_PITCH);
  const [autoSpin, setAutoSpin] = useState(false);

  // Esc closes the modal — same affordance the old iframe panorama had.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Build the panorama MapLibre instance every time the modal opens at
  // a new coordinate. We tear it down on close so the WebGL context is
  // released — keeping a hidden second MapLibre alive eats GPU memory.
  useEffect(() => {
    if (!open || lat == null || lng == null) return;
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      center: [lng, lat],
      zoom: DEFAULT_ZOOM,
      pitch: DEFAULT_PITCH,
      bearing: 0,
      maxPitch: 85,
      minZoom: 17.5,
      maxZoom: 21,
      // Drag-to-pan would let the user wander away from the panorama
      // point and break the "I am standing here" illusion. We keep
      // ONLY drag-to-rotate so the gesture mimics turning your head.
      dragPan: false,
      // Touch-pan analogue: also off, only touch-rotate stays on.
      touchPitch: true,
      touchZoomRotate: true,
      doubleClickZoom: false,
      attributionControl: { compact: true },
      style: {
        version: 8,
        glyphs:
          "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          satellite: {
            type: "raster",
            tiles: [SAT_TILES],
            tileSize: 256,
            attribution: SAT_ATTR,
            maxzoom: 19,
          },
          openmaptiles: {
            type: "vector",
            tiles: [`${window.location.origin}${OFM_TILE_TEMPLATE}`],
            minzoom: 0,
            maxzoom: 14,
            attribution:
              '© <a href="https://openfreemap.org">OpenFreeMap</a>',
          },
        },
        layers: [
          // Sky horizon — without this the area above the buildings is
          // flat black at this pitch and the scene reads as "broken".
          {
            id: "sky",
            type: "background",
            paint: {
              "background-color": [
                "interpolate",
                ["linear"],
                ["zoom"],
                17,
                "#0d1422",
                21,
                "#1a2740",
              ],
            },
          },
          {
            id: "sat",
            type: "raster",
            source: "satellite",
            paint: { "raster-opacity": 0.95 },
          },
          // Water polygons drawn as opaque blue so rivers/canals feel
          // like water instead of a satellite-photo blue blur.
          {
            id: "water",
            type: "fill",
            source: "openmaptiles",
            "source-layer": "water",
            paint: {
              "fill-color": "#0c2a45",
              "fill-opacity": 0.9,
            },
          },
          // 3D building extrusions — the heart of the panorama. Without
          // these the user is just looking at a tilted satellite photo.
          {
            id: "buildings-3d",
            type: "fill-extrusion",
            source: "openmaptiles",
            "source-layer": "building",
            minzoom: 14,
            paint: {
              "fill-extrusion-color": [
                "case",
                ["has", "colour"],
                ["get", "colour"],
                "#5b6470",
              ],
              "fill-extrusion-height": [
                "coalesce",
                ["get", "render_height"],
                ["*", ["coalesce", ["get", "levels"], 3], 3.2],
                10,
              ],
              "fill-extrusion-base": [
                "coalesce",
                ["get", "render_min_height"],
                0,
              ],
              "fill-extrusion-opacity": 0.96,
              "fill-extrusion-vertical-gradient": true,
            },
          },
        ],
        // Sky pillar drawn by MapLibre when pitch > 60° — soft warm
        // horizon glow that fades into deeper blue overhead. Costs us
        // nothing, sells the depth instantly.
        sky: {
          "sky-color": "#1a2740",
          "horizon-color": "#3a4d6d",
          "fog-color": "#1a2740",
          "horizon-fog-blend": 0.4,
          "fog-ground-blend": 0.5,
          "atmosphere-blend": [
            "interpolate",
            ["linear"],
            ["zoom"],
            17,
            0.6,
            21,
            0.2,
          ],
        } as any,
      } as any,
    });

    mapRef.current = map;

    map.on("rotate", () => {
      setBearing(map.getBearing());
    });
    map.on("pitchend", () => {
      setPitch(map.getPitch());
    });

    return () => {
      try {
        map.remove();
      } catch {
        // best-effort: WebGL context may already be lost
      }
      mapRef.current = null;
    };
  }, [open, lat, lng]);

  // Optional: slow auto-rotate. Useful as a "screensaver" so the user
  // can preview the spot without manually dragging. 3°/sec — slow
  // enough to read the buildings, fast enough to feel alive.
  useEffect(() => {
    if (!autoSpin) return;
    const map = mapRef.current;
    if (!map) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      try {
        map.setBearing((map.getBearing() + 3 * dt) % 360);
      } catch {
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoSpin, open]);

  // Bearing slider — gives users a coarse "spin to direction" control
  // alongside drag-to-rotate.
  const onBearingSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const b = Number(e.target.value);
    setBearing(b);
    mapRef.current?.setBearing(b);
  };
  const onPitchSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const p = Number(e.target.value);
    setPitch(p);
    mapRef.current?.setPitch(p);
  };

  if (!open || lat == null || lng == null) return null;

  // External fallback links for users whose target spot has actual
  // photographic panoramas published — Yandex covers SPb properly.
  const yandexPanoUrl = `https://yandex.ru/maps/?ll=${lng}%2C${lat}&panorama%5Bpoint%5D=${lng}%2C${lat}&panorama%5Bdirection%5D=${bearing.toFixed(1)}%2C0&z=19`;
  const dgisUrl = `https://2gis.ru/geo/${lng}%2C${lat}?m=${lng}%2C${lat}%2F19`;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[9999] bg-background/95 backdrop-blur-sm flex flex-col",
      )}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            POV / 3D-панорама
          </div>
          {title ? (
            <div className="text-sm font-medium truncate">{title}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoSpin((v) => !v)}
            className={cn(
              "h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border transition-colors",
              autoSpin
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted",
            )}
          >
            {autoSpin ? "пауза" : "вращать"}
          </button>
          <a
            href={yandexPanoUrl}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            яндекс пано ↗
          </a>
          <a
            href={dgisUrl}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            2gis ↗
          </a>
          <button
            onClick={onClose}
            className="h-8 px-3 text-[11px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors"
            aria-label="Закрыть"
          >
            закрыть ✕
          </button>
        </div>
      </div>

      <div className="flex-1 relative bg-black">
        <div ref={containerRef} className="absolute inset-0" />

        {/* Compass / heading indicator (top-left). */}
        <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-background/80 border border-border backdrop-blur-sm">
          <div
            className="w-6 h-6 flex items-center justify-center"
            style={{ transform: `rotate(${-bearing}deg)` }}
            aria-hidden
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5">
              <path
                d="M12 2 L15 13 L12 11 L9 13 Z"
                fill="currentColor"
                className="text-primary"
              />
              <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeOpacity="0.3" />
            </svg>
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] font-mono">
            {Math.round(((bearing % 360) + 360) % 360)}°
          </div>
        </div>

        {/* Drag hint, fades after first interaction (we just keep it
            permanently low-opacity since space is cheap). */}
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.2em] text-foreground/60 pointer-events-none">
          тяни мышью / пальцем — крути вокруг себя
        </div>

        {/* Bearing + pitch sliders (bottom). */}
        <div className="absolute bottom-3 left-3 right-3 flex items-center gap-4 px-4 py-3 rounded-lg bg-background/80 border border-border backdrop-blur-sm">
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground w-10 shrink-0">азимут</span>
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={Math.round(((bearing % 360) + 360) % 360)}
              onChange={onBearingSlider}
              className="flex-1 accent-primary"
            />
          </div>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground w-10 shrink-0">наклон</span>
            <input
              type="range"
              min={50}
              max={85}
              step={1}
              value={Math.round(pitch)}
              onChange={onPitchSlider}
              className="flex-1 accent-primary"
            />
          </div>
        </div>
      </div>

      <div className="px-4 py-2 border-t border-border text-[10px] uppercase tracking-[0.18em] text-muted-foreground flex items-center justify-between">
        <span>3D-сцена строится из спутника + OSM в реальном времени</span>
        <span className="font-mono">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
      </div>
    </div>
  );
}

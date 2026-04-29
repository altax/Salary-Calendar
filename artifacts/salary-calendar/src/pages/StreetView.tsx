import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";

// Default starting point: Palace Square, St Petersburg.
const DEFAULT_LAT = 59.9398;
const DEFAULT_LNG = 30.3146;

type Coord = { lat: number; lng: number };

/**
 * Build a Yandex Map Widget URL in street-view (panorama) mode.
 *
 * Why Yandex instead of Mapillary?
 *   • Mapillary's www.mapillary.com (and tiles.mapillary.com) sit behind
 *     Cloudflare, which is heavily DNS-blocked at most Russian ISPs —
 *     embedding their viewer fails with "ERR_NAME_NOT_RESOLVED" for the
 *     courier audience this app actually targets.
 *   • Yandex Panoramas have an order of magnitude more coverage in
 *     St Petersburg (full coverage of city centre + most of suburbs).
 *   • The widget at https://yandex.ru/map-widget/v1 is an official,
 *     iframe-friendly embed (no X-Frame-Options or frame-ancestors
 *     restrictions), and requires no API key for non-commercial use.
 *
 * Reference: https://yandex.ru/dev/maps/embed/doc/dg/concepts/map-widget.html
 */
function buildYandexPanoramaUrl({ lat, lng }: Coord) {
  const point = `${lng.toFixed(6)},${lat.toFixed(6)}`;
  const params = new URLSearchParams({
    ll: point,
    z: "18",
    l: "stv,sta", // street-view tiles + the panorama layer marker
    "panorama[point]": point,
    // direction: yaw 0° = north, pitch 0° = horizon. Faces north by default.
    "panorama[direction]": "0,0",
    // span: horizontal FOV ~120°, vertical ~60° — feels like walking eye level.
    "panorama[span]": "120.000000,60.000000",
    lang: "ru_RU",
  });
  return `https://yandex.ru/map-widget/v1/?${params.toString()}`;
}

function buildYandexMapsExternalUrl({ lat, lng }: Coord) {
  const point = `${lng.toFixed(6)},${lat.toFixed(6)}`;
  const params = new URLSearchParams({
    ll: point,
    z: "18",
    l: "stv,sta",
    "panorama[point]": point,
    "panorama[direction]": "0,0",
    "panorama[span]": "120.000000,60.000000",
  });
  return `https://yandex.ru/maps/?${params.toString()}`;
}

export default function StreetView() {
  const [, setLocation] = useLocation();

  // The starting coordinate. Read once from the URL query string; updates
  // happen via internal state (geolocation, manual reload).
  const initialCoord = useMemo<Coord>(() => {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng };
    }
    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  }, []);

  const [coord, setCoord] = useState<Coord>(initialCoord);
  // Bumping this key forces the iframe to remount, which Yandex needs in
  // order to re-run its panorama lookup at the new point.
  const [reloadKey, setReloadKey] = useState(0);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Esc → back to map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLocation("/map");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLocation]);

  const onUseGeolocation = () => {
    if (!navigator.geolocation) {
      setGeoError("Геолокация недоступна в этом браузере");
      return;
    }
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setReloadKey((k) => k + 1);
      },
      (err) => setGeoError(`Геолокация: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const onReload = () => setReloadKey((k) => k + 1);

  const onResetToStart = () => {
    setCoord(initialCoord);
    setReloadKey((k) => k + 1);
  };

  const isAtStart =
    Math.abs(coord.lat - initialCoord.lat) < 1e-6 &&
    Math.abs(coord.lng - initialCoord.lng) < 1e-6;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/map"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            ← карта
          </Link>
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hidden sm:block">
            STREET&nbsp;VIEW · ЯНДЕКС&nbsp;ПАНОРАМЫ
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isAtStart && (
            <button
              onClick={onResetToStart}
              className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors"
              title="Вернуться к стартовой точке маршрута"
            >
              ⟲ к старту
            </button>
          )}
          <button
            onClick={onReload}
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors"
          >
            ↻ обновить
          </button>
          <button
            onClick={onUseGeolocation}
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors"
          >
            ◎ моё место
          </button>
          <a
            href={buildYandexMapsExternalUrl(coord)}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
            title="Открыть в полноразмерном Яндекс Картах"
          >
            на весь экран ↗
          </a>
        </div>
      </div>

      <div className="relative flex-1 bg-black">
        <iframe
          key={reloadKey}
          src={buildYandexPanoramaUrl(coord)}
          title="Yandex street panorama"
          className="absolute inset-0 w-full h-full border-0"
          allow="fullscreen; geolocation; accelerometer; gyroscope"
          // Yandex sets cookies to identify pano sessions; allow them.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />

        {geoError && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-2 rounded-md bg-red-500/90 text-white text-[11px] uppercase tracking-[0.18em]">
            {geoError}
          </div>
        )}

        <div
          className={cn(
            "absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-background/70 border border-border backdrop-blur-sm",
            "text-[10px] uppercase tracking-[0.2em] text-foreground/70 pointer-events-none max-w-[90vw] text-center",
          )}
        >
          тяни — крутить · стрелки на земле — двигаться · колесо — зум
        </div>
      </div>

      <div className="px-4 py-2 border-t border-border bg-background/95 text-[10px] uppercase tracking-[0.18em] text-muted-foreground flex items-center justify-between gap-3">
        <span className="truncate">панорамы © Яндекс</span>
        <span className="font-mono shrink-0">
          {coord.lat.toFixed(5)}, {coord.lng.toFixed(5)}
        </span>
      </div>
    </div>
  );
}

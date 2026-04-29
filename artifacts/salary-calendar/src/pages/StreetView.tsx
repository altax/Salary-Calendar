import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { findNearestImage, type FoundImage } from "@/lib/mapillary-search";

const TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;

// Default starting point: Palace Square, St Petersburg.
const DEFAULT_LAT = 59.9398;
const DEFAULT_LNG = 30.3146;
const SEARCH_RADIUS_M = 800;

type Status =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "loaded"; found: FoundImage }
  | { kind: "no-imagery" }
  | { kind: "error"; message: string };

/**
 * Build the URL for Mapillary's official embedded panorama viewer.
 * The embed page (https://www.mapillary.com/embed) is a full-blown
 * Angular SPA that runs THEIR own 360° photo viewer — same one you'd
 * see on mapillary.com itself: drag-to-rotate, click navigation arrows
 * on the ground to move between connected images, zoom, fullscreen,
 * compass, the lot. It uses Mapillary's own session/auth on their
 * domain, so we don't need our app's API token to have read scope.
 */
function buildEmbedUrl(imageId: string) {
  const params = new URLSearchParams({
    image_key: imageId,
    style: "photo",
    map_style: "Mapillary streets",
  });
  return `https://www.mapillary.com/embed?${params.toString()}`;
}

export default function StreetView() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [panoOnly, setPanoOnly] = useState(true);

  const startCoord = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng };
    }
    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  }, []);

  const search = (lat: number, lng: number, forcePano = panoOnly) => {
    if (!TOKEN) {
      setStatus({ kind: "error", message: "VITE_MAPILLARY_TOKEN не задан" });
      return;
    }
    setStatus({ kind: "searching" });
    findNearestImage(TOKEN, lat, lng, SEARCH_RADIUS_M, forcePano)
      .then((found) => {
        if (!found && forcePano) {
          // Fall back to ANY image if no panorama within range.
          return findNearestImage(TOKEN, lat, lng, SEARCH_RADIUS_M, false);
        }
        return found;
      })
      .then((found) => {
        if (!found) {
          setStatus({ kind: "no-imagery" });
          return;
        }
        setStatus({ kind: "loaded", found });
      })
      .catch((err: unknown) => {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  // Initial search on mount.
  useEffect(() => {
    search(startCoord.lat, startCoord.lng);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-search when the pano-only toggle flips.
  const togglePano = () => {
    const next = !panoOnly;
    setPanoOnly(next);
    const c =
      status.kind === "loaded"
        ? { lat: status.found.lat, lng: status.found.lng }
        : startCoord;
    search(c.lat, c.lng, next);
  };

  // Esc → back to map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLocation("/map");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLocation]);

  const onUseGeolocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => search(pos.coords.latitude, pos.coords.longitude),
      (err) => {
        setStatus({ kind: "error", message: `Геолокация: ${err.message}` });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const display =
    status.kind === "loaded"
      ? { lat: status.found.lat, lng: status.found.lng }
      : startCoord;
  const yandexUrl = `https://yandex.ru/maps/?ll=${display.lng}%2C${display.lat}&panorama%5Bpoint%5D=${display.lng}%2C${display.lat}&z=18`;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/map"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            ← карта
          </Link>
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            STREET&nbsp;VIEW · MAPILLARY
          </div>
          {status.kind === "loaded" && (
            <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground font-mono hidden sm:block">
              {status.found.isPano ? "360° pano" : "perspective"} ·{" "}
              {Math.round(status.found.distance)} м от запроса
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={togglePano}
            className={cn(
              "h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border transition-colors",
              panoOnly
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted",
            )}
            disabled={status.kind === "searching"}
            title="Только сферические 360° фото"
          >
            ◯ только 360°
          </button>
          <button
            onClick={() => search(startCoord.lat, startCoord.lng)}
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors"
            disabled={status.kind === "searching"}
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
            href={yandexUrl}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            яндекс пано ↗
          </a>
        </div>
      </div>

      <div className="relative flex-1 bg-black">
        {status.kind === "loaded" && (
          <iframe
            key={status.found.id}
            src={buildEmbedUrl(status.found.id)}
            title="Mapillary street view"
            className="absolute inset-0 w-full h-full border-0"
            allow="fullscreen; accelerometer; gyroscope"
          />
        )}

        {status.kind === "searching" && (
          <Overlay>
            <div className="text-sm uppercase tracking-[0.2em] animate-pulse">
              ищу ближайшую панораму…
            </div>
          </Overlay>
        )}
        {status.kind === "no-imagery" && (
          <Overlay>
            <div className="text-sm uppercase tracking-[0.2em] text-yellow-300">
              в радиусе {SEARCH_RADIUS_M} м панорам не найдено
            </div>
            <div className="mt-2 text-[11px] text-foreground/60 max-w-md text-center">
              У Mapillary тут нет покрытия. В Yandex Панорамах СПб обычно есть — попробуй там.
            </div>
            <a
              href={yandexUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 h-9 px-4 text-[11px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
            >
              открыть в яндексе ↗
            </a>
          </Overlay>
        )}
        {status.kind === "error" && (
          <Overlay>
            <div className="text-sm uppercase tracking-[0.2em] text-red-400">
              ошибка
            </div>
            <div className="mt-2 text-[11px] text-foreground/70 max-w-md text-center font-mono break-all px-4">
              {status.message}
            </div>
          </Overlay>
        )}

        {status.kind === "loaded" && (
          <div
            className={cn(
              "absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-background/70 border border-border backdrop-blur-sm",
              "text-[10px] uppercase tracking-[0.2em] text-foreground/70 pointer-events-none",
            )}
          >
            тяни — крутить · стрелки на земле — двигаться · колесо — зум
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border bg-background/95 text-[10px] uppercase tracking-[0.18em] text-muted-foreground flex items-center justify-between">
        <span>панорамы © Mapillary contributors · CC BY-SA</span>
        <span className="font-mono">
          {display.lat.toFixed(5)}, {display.lng.toFixed(5)}
        </span>
      </div>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-auto">
      {children}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Viewer } from "mapillary-js";
import "mapillary-js/dist/mapillary.css";
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
  | { kind: "loading"; found: FoundImage }
  | { kind: "loaded"; imageId: string; isPano: boolean }
  | { kind: "no-imagery" }
  | { kind: "error"; message: string };

export default function StreetView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [bearing, setBearing] = useState(0);
  const [currentCoord, setCurrentCoord] = useState<{ lat: number; lng: number } | null>(null);

  const startCoord = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng };
    }
    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  }, []);

  // Init the viewer ONCE; subsequent navigation uses viewer.moveTo().
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!TOKEN) {
      setStatus({
        kind: "error",
        message: "VITE_MAPILLARY_TOKEN не задан",
      });
      return;
    }

    let cancelled = false;
    setStatus({ kind: "searching" });

    findNearestImage(TOKEN, startCoord.lat, startCoord.lng, SEARCH_RADIUS_M)
      .then((found) => {
        if (cancelled) return;
        if (!found) {
          setStatus({ kind: "no-imagery" });
          return;
        }
        setStatus({ kind: "loading", found });
        const viewer = new Viewer({
          accessToken: TOKEN,
          container,
          imageId: found.id,
          component: { cover: false },
        });
        viewerRef.current = viewer;

        viewer.on("image", (e: any) => {
          const img = e?.image;
          if (!img) return;
          const lat: number | undefined = img.lngLat?.lat ?? img.computedLngLat?.lat;
          const lng: number | undefined = img.lngLat?.lng ?? img.computedLngLat?.lng;
          if (typeof lat === "number" && typeof lng === "number") {
            setCurrentCoord({ lat, lng });
          }
          setStatus({
            kind: "loaded",
            imageId: img.id ?? found.id,
            isPano: !!img.isPano,
          });
        });

        viewer.on("bearing", (e: any) => {
          if (typeof e?.bearing === "number") setBearing(e.bearing);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      try {
        viewerRef.current?.remove();
      } catch {
        /* noop — WebGL context may already be gone */
      }
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize on layout change.
  useEffect(() => {
    const onResize = () => {
      try {
        viewerRef.current?.resize();
      } catch {
        /* not ready */
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Esc → back to map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLocation("/map");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLocation]);

  const jumpTo = async (lat: number, lng: number) => {
    if (!viewerRef.current || !TOKEN) return;
    setStatus({ kind: "searching" });
    try {
      const found = await findNearestImage(TOKEN, lat, lng, SEARCH_RADIUS_M);
      if (!found) {
        setStatus({ kind: "no-imagery" });
        return;
      }
      await viewerRef.current.moveTo(found.id);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onUseGeolocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => jumpTo(pos.coords.latitude, pos.coords.longitude),
      (err) => {
        setStatus({
          kind: "error",
          message: `Геолокация: ${err.message}`,
        });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const displayCoord = currentCoord ?? startCoord;
  const yandexUrl = `https://yandex.ru/maps/?ll=${displayCoord.lng}%2C${displayCoord.lat}&panorama%5Bpoint%5D=${displayCoord.lng}%2C${displayCoord.lat}&z=18`;

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
        </div>
        <div className="flex items-center gap-2">
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

      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0 bg-black" />

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
            <div className="mt-2 text-[11px] text-foreground/70 max-w-md text-center font-mono">
              {status.message}
            </div>
          </Overlay>
        )}

        {(status.kind === "loaded" || status.kind === "loading") && (
          <div className="absolute bottom-3 left-3 flex items-center gap-3 px-3 py-2 rounded-lg bg-background/80 border border-border backdrop-blur-sm">
            <div
              className="w-7 h-7 flex items-center justify-center"
              style={{ transform: `rotate(${-bearing}deg)` }}
              aria-hidden
            >
              <svg viewBox="0 0 24 24" className="w-6 h-6">
                <path
                  d="M12 2 L15 13 L12 11 L9 13 Z"
                  fill="currentColor"
                  className="text-primary"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="11"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.3"
                />
              </svg>
            </div>
            <div className="flex flex-col">
              <div className="text-[10px] uppercase tracking-[0.18em] font-mono">
                {Math.round(((bearing % 360) + 360) % 360)}°
              </div>
              <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
                {displayCoord.lat.toFixed(5)}, {displayCoord.lng.toFixed(5)}
              </div>
            </div>
          </div>
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
          {status.kind === "loaded" && (status.isPano ? "360° pano" : "perspective")}
          {status.kind === "loading" && "загрузка…"}
          {status.kind === "searching" && "поиск…"}
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

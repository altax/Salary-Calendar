import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { YandexPanoramaViewer } from "@/components/YandexPanoramaViewer";
import {
  fetchPanoByOid,
  fetchPanoByPoint,
  type LoadedPano,
  type LngLat,
} from "@/lib/yandex-pano";

// Default starting point: Palace Square, St Petersburg.
const DEFAULT_START: LngLat = { lat: 59.9398, lng: 30.3146 };

type Status =
  | { kind: "loading" }
  | { kind: "ok"; pano: LoadedPano }
  | { kind: "no-imagery" }
  | { kind: "error"; message: string };

export default function StreetView() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const startRef = useRef<LngLat | null>(null);

  const initialCoord = useMemo<LngLat>(() => {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng };
    }
    return DEFAULT_START;
  }, []);

  const loadByPoint = (p: LngLat) => {
    setStatus({ kind: "loading" });
    fetchPanoByPoint(p)
      .then((pano) => {
        if (!pano) {
          setStatus({ kind: "no-imagery" });
          return;
        }
        if (!startRef.current) startRef.current = pano.position;
        setStatus({ kind: "ok", pano });
      })
      .catch((err: unknown) => {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const loadByOid = (oid: string) => {
    setStatus({ kind: "loading" });
    fetchPanoByOid(oid)
      .then((pano) => {
        if (!pano) {
          setStatus({ kind: "no-imagery" });
          return;
        }
        setStatus({ kind: "ok", pano });
      })
      .catch((err: unknown) => {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  // Initial load.
  useEffect(() => {
    loadByPoint(initialCoord);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setStatus({ kind: "error", message: "Геолокация недоступна" });
      return;
    }
    setStatus({ kind: "loading" });
    navigator.geolocation.getCurrentPosition(
      (pos) => loadByPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setStatus({ kind: "error", message: `Геолокация: ${err.message}` }),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const onResetToStart = () => loadByPoint(initialCoord);

  // Coords currently shown.
  const displayCoord =
    status.kind === "ok" ? status.pano.position : initialCoord;
  const yandexExternalUrl = useMemo(() => {
    const point = `${displayCoord.lng.toFixed(6)},${displayCoord.lat.toFixed(6)}`;
    const params = new URLSearchParams({
      ll: point,
      z: "18",
      l: "stv,sta",
      "panorama[point]": point,
      "panorama[direction]": "0,0",
      "panorama[span]": "120.000000,60.000000",
    });
    return `https://yandex.ru/maps/?${params.toString()}`;
  }, [displayCoord.lat, displayCoord.lng]);

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
          {status.kind === "ok" && (
            <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground font-mono hidden md:block">
              {new Date(status.pano.timestamp * 1000).toLocaleDateString("ru-RU", {
                month: "short",
                year: "numeric",
              })}
              {status.pano.thoroughfares.length > 0 &&
                ` · ↗ ${status.pano.thoroughfares.length}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onResetToStart}
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors"
            title="К стартовой точке"
          >
            ⟲ старт
          </button>
          <button
            onClick={onUseGeolocation}
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors"
          >
            ◎ моё место
          </button>
          <a
            href={yandexExternalUrl}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
            title="Открыть в Яндекс.Картах"
          >
            на я.картах ↗
          </a>
        </div>
      </div>

      <div className="relative flex-1 bg-black">
        {status.kind === "ok" && (
          <YandexPanoramaViewer
            key={status.pano.imageId}
            pano={status.pano}
            onNavigate={(next) => setStatus({ kind: "ok", pano: next })}
            onError={(message) => setStatus({ kind: "error", message })}
          />
        )}

        {status.kind === "loading" && (
          <Overlay>
            <div className="text-sm uppercase tracking-[0.2em] animate-pulse">
              ищу панораму…
            </div>
          </Overlay>
        )}

        {status.kind === "no-imagery" && (
          <Overlay>
            <div className="text-sm uppercase tracking-[0.2em] text-yellow-300">
              у Яндекса нет панорамы в этой точке
            </div>
            <div className="mt-2 text-[11px] text-foreground/60 max-w-md text-center">
              Попробуй сдвинуться на ближайшую улицу или открой Я.Карты на полный экран.
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={onResetToStart}
                className="h-9 px-4 text-[11px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors"
              >
                ⟲ к старту
              </button>
              <a
                href={yandexExternalUrl}
                target="_blank"
                rel="noreferrer"
                className="h-9 px-4 text-[11px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
              >
                на я.картах ↗
              </a>
            </div>
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
            <button
              onClick={onResetToStart}
              className="mt-4 h-9 px-4 text-[11px] uppercase tracking-[0.2em] rounded-md border border-border hover:bg-muted transition-colors"
            >
              ⟲ к старту
            </button>
          </Overlay>
        )}

        {status.kind === "ok" && (
          <div
            className={cn(
              "absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-background/70 border border-border backdrop-blur-sm",
              "text-[10px] uppercase tracking-[0.2em] text-foreground/70 pointer-events-none max-w-[90vw] text-center",
            )}
          >
            тяни — крутить · ▲ на земле — идти к соседней панораме · колесо — зум
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border bg-background/95 text-[10px] uppercase tracking-[0.18em] text-muted-foreground flex items-center justify-between gap-3">
        <span className="truncate">панорамы © Яндекс</span>
        <span className="font-mono shrink-0">
          {displayCoord.lat.toFixed(5)}, {displayCoord.lng.toFixed(5)}
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

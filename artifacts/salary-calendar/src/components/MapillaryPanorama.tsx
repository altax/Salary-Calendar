import { useEffect } from "react";
import { cn } from "@/lib/utils";

export type MapillaryPanoramaProps = {
  open: boolean;
  lat: number | null;
  lng: number | null;
  title?: string;
  onClose: () => void;
};

export default function MapillaryPanorama({
  open,
  lat,
  lng,
  title,
  onClose,
}: MapillaryPanoramaProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || lat == null || lng == null) return null;

  // Mapillary's web app embedded view. Centred on the requested coordinate at
  // zoom 18 — Mapillary picks the closest available street-level photo and
  // opens it in panorama mode.
  const mapillaryUrl = `https://www.mapillary.com/embed?map_style=Mapillary%20light&image_key=&style=photo&lat=${lat}&lng=${lng}&z=18`;

  // Fallback link to open the full Mapillary app (in case the embed has no
  // nearby photo and the iframe shows the fallback map).
  const fullAppUrl = `https://www.mapillary.com/app/?lat=${lat}&lng=${lng}&z=18&panos=true`;
  const yandexPanoUrl = `https://yandex.ru/maps/?ll=${lng}%2C${lat}&panorama%5Bpoint%5D=${lng}%2C${lat}&panorama%5Bdirection%5D=0%2C0&z=19`;

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
            POV / панорама
          </div>
          {title ? (
            <div className="text-sm font-medium truncate">{title}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={fullAppUrl}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            mapillary ↗
          </a>
          <a
            href={yandexPanoUrl}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center"
          >
            яндекс пано ↗
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
        <iframe
          key={`${lat},${lng}`}
          title="Mapillary panorama"
          src={mapillaryUrl}
          className="w-full h-full border-0"
          allow="fullscreen; geolocation"
        />
      </div>
      <div className="px-4 py-2 border-t border-border text-[10px] uppercase tracking-[0.18em] text-muted-foreground flex items-center justify-between">
        <span>панорамы Mapillary · если нет покрытия — открой в Яндекс</span>
        <span className="font-mono">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
      </div>
    </div>
  );
}

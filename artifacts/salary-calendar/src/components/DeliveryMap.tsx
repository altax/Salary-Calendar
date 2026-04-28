import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { Delivery, PendingOrder } from "@/lib/deliveries";
import type { ResolvedJob } from "@/lib/store";

const SPB_CENTER: [number, number] = [59.9343, 30.3351];

const DARK_TILES =
  "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const DARK_LABELS =
  "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png";
const LIGHT_TILES =
  "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png";
const LIGHT_LABELS =
  "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png";

const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function jobColor(job: ResolvedJob | undefined, theme: "dark" | "light"): string {
  if (job?.color) return job.color;
  if (job?.id === "ozon") return theme === "dark" ? "#fafafa" : "#0a0a0a";
  return theme === "dark" ? "#888" : "#666";
}

function makeNumberedIcon(opts: {
  index: number;
  color: string;
  fg: string;
  outline: string;
  size?: number;
}) {
  const { index, color, fg, outline, size = 26 } = opts;
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background: ${color};
      color: ${fg};
      border: 1.5px solid ${outline};
      box-shadow: 0 0 0 2px rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
      font-size: ${size <= 22 ? 9 : 10}px;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1;
    ">${String(index).padStart(2, "0")}</div>
  `;
  return L.divIcon({
    className: "delivery-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makePendingIcon(opts: {
  index: number;
  color: string;
  outline: string;
  size?: number;
}) {
  const { index, color, outline, size = 24 } = opts;
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 4px;
      background: transparent;
      color: ${color};
      border: 1.5px dashed ${color};
      box-shadow: 0 0 0 2px rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1;
      transform: rotate(45deg);
    "><span style="transform: rotate(-45deg);">${String(index).padStart(2, "0")}</span></div>
  `;
  return L.divIcon({
    className: "pending-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function ClickHandler({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FlyTo({ target }: { target: { lat: number; lng: number; zoom?: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lng], target.zoom ?? Math.max(map.getZoom(), 15), {
      duration: 0.8,
    });
  }, [target, map]);
  return null;
}

function FitBounds({ points }: { points: { lat: number; lng: number }[] }) {
  const map = useMap();
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (points.length < 2) return;
    const key = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|");
    if (key === lastKey.current) return;
    lastKey.current = key;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: true });
  }, [points, map]);
  return null;
}

export type DeliveryMapProps = {
  deliveries: Delivery[];
  pending: PendingOrder[];
  jobs: ResolvedJob[];
  theme: "dark" | "light";
  onMapClick?: (lat: number, lng: number) => void;
  onDeliveryClick?: (id: string) => void;
  onPendingClick?: (id: string) => void;
  selectedId?: string | null;
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
  fitToAll?: boolean;
  showRoute?: boolean;
  filterJob?: string | null;
  className?: string;
  interactive?: boolean;
};

export default function DeliveryMap({
  deliveries,
  pending,
  jobs,
  theme,
  onMapClick,
  onDeliveryClick,
  onPendingClick,
  selectedId,
  flyTo,
  fitToAll,
  showRoute = true,
  filterJob,
  className,
  interactive = true,
}: DeliveryMapProps) {
  const sortedDeliveries = useMemo(
    () =>
      deliveries
        .filter((d) => !filterJob || d.jobId === filterJob)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp),
    [deliveries, filterJob],
  );

  const jobMap = useMemo(() => {
    const m = new Map<string, ResolvedJob>();
    for (const j of jobs) m.set(j.id, j);
    return m;
  }, [jobs]);

  const fg = theme === "dark" ? "#0a0a0a" : "#fafafa";
  const outline = theme === "dark" ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.85)";

  const fitPoints = useMemo(() => {
    if (!fitToAll) return [] as { lat: number; lng: number }[];
    const pts: { lat: number; lng: number }[] = [];
    for (const d of sortedDeliveries) pts.push({ lat: d.lat, lng: d.lng });
    for (const p of pending) pts.push({ lat: p.lat, lng: p.lng });
    return pts;
  }, [fitToAll, sortedDeliveries, pending]);

  const routeByJob = useMemo(() => {
    if (!showRoute) return [] as { color: string; positions: [number, number][] }[];
    const groups = new Map<string, Delivery[]>();
    for (const d of sortedDeliveries) {
      const arr = groups.get(d.jobId) || [];
      arr.push(d);
      groups.set(d.jobId, arr);
    }
    const result: { color: string; positions: [number, number][] }[] = [];
    for (const [jobId, list] of groups.entries()) {
      const job = jobMap.get(jobId);
      const positions: [number, number][] = list.map((d) => [d.lat, d.lng]);
      if (positions.length >= 2) {
        result.push({ color: jobColor(job, theme), positions });
      }
    }
    return result;
  }, [sortedDeliveries, showRoute, jobMap, theme]);

  return (
    <div className={className} style={{ position: "relative", height: "100%", width: "100%" }}>
      <MapContainer
        center={SPB_CENTER}
        zoom={11}
        scrollWheelZoom={interactive}
        zoomControl={interactive}
        dragging={interactive}
        doubleClickZoom={interactive}
        attributionControl={false}
        style={{ height: "100%", width: "100%", background: theme === "dark" ? "#0a0a0a" : "#f5f5f5" }}
      >
        <TileLayer url={theme === "dark" ? DARK_TILES : LIGHT_TILES} attribution={TILE_ATTR} />
        <TileLayer url={theme === "dark" ? DARK_LABELS : LIGHT_LABELS} />
        {interactive && onMapClick && <ClickHandler onClick={onMapClick} />}
        <FlyTo target={flyTo ?? null} />
        {fitToAll && <FitBounds points={fitPoints} />}

        {routeByJob.map((r, i) => (
          <Polyline
            key={i}
            positions={r.positions}
            pathOptions={{
              color: r.color,
              weight: 2,
              opacity: 0.7,
              dashArray: "4 4",
            }}
          />
        ))}

        {sortedDeliveries.map((d, i) => {
          const job = jobMap.get(d.jobId);
          const color = jobColor(job, theme);
          const isSelected = selectedId === d.id;
          return (
            <Marker
              key={d.id}
              position={[d.lat, d.lng]}
              icon={makeNumberedIcon({
                index: i + 1,
                color,
                fg,
                outline,
                size: isSelected ? 32 : 26,
              })}
              eventHandlers={{
                click: () => onDeliveryClick?.(d.id),
              }}
            >
              <Tooltip direction="top" offset={[0, -14]} opacity={1} className="map-tooltip">
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, lineHeight: 1.4 }}>
                  <div style={{ opacity: 0.7 }}>
                    {new Date(d.timestamp).toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {job?.label ?? d.jobId}
                  </div>
                  <div style={{ fontWeight: 700 }}>
                    {Math.round(d.amountRub)} ₽
                  </div>
                  {d.address && (
                    <div style={{ opacity: 0.7, marginTop: 2 }}>{d.address}</div>
                  )}
                </div>
              </Tooltip>
            </Marker>
          );
        })}

        {pending.map((p, i) => {
          const job = jobMap.get(p.jobId);
          const color = jobColor(job, theme);
          const isSelected = selectedId === p.id;
          return (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              icon={makePendingIcon({
                index: i + 1,
                color,
                outline,
                size: isSelected ? 30 : 24,
              })}
              eventHandlers={{
                click: () => onPendingClick?.(p.id),
              }}
            >
              <Tooltip direction="top" offset={[0, -14]} opacity={1} className="map-tooltip">
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, lineHeight: 1.4 }}>
                  <div style={{ opacity: 0.7 }}>
                    ожидает · {job?.label ?? p.jobId}
                  </div>
                  {p.address && <div style={{ opacity: 0.9 }}>{p.address}</div>}
                </div>
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}

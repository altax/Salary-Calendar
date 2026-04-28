import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Tooltip,
  Circle,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { Delivery, PendingOrder } from "@/lib/deliveries";
import type { ResolvedJob, Depot } from "@/lib/store";
import type { GeoPosition } from "@/lib/geolocation";

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
  active?: boolean;
  size?: number;
}) {
  const { index, color, outline, active, size = 28 } = opts;
  const bg = active ? color : "transparent";
  const fg = active ? (color === "#fafafa" ? "#0a0a0a" : "#fff") : color;
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background: ${bg};
      color: ${fg};
      border: ${active ? 2 : 1.5}px ${active ? "solid" : "dashed"} ${color};
      box-shadow: 0 0 0 2px ${outline}${active ? ", 0 0 0 6px " + color + "33" : ""};
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
      font-size: ${size <= 24 ? 10 : 11}px;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1;
    ">${index}</div>
  `;
  return L.divIcon({
    className: "pending-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeDepotIcon(opts: { theme: "dark" | "light"; size?: number }) {
  const { theme, size = 32 } = opts;
  const bg = theme === "dark" ? "#fafafa" : "#0a0a0a";
  const fg = theme === "dark" ? "#0a0a0a" : "#fafafa";
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 6px;
      background: ${bg};
      color: ${fg};
      border: 2px solid ${bg};
      box-shadow: 0 0 0 3px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
    ">⌂</div>
  `;
  return L.divIcon({
    className: "depot-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeCheckIcon(opts: { theme: "dark" | "light"; size?: number }) {
  const { theme, size = 22 } = opts;
  const bg = theme === "dark" ? "#22c55e" : "#16a34a";
  const fg = "#fff";
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background: ${bg};
      color: ${fg};
      border: 2px solid ${theme === "dark" ? "#0a0a0a" : "#fafafa"};
      box-shadow: 0 0 0 2px rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    ">✓</div>
  `;
  return L.divIcon({
    className: "check-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeManeuverIcon(opts: { arrow: string; theme: "dark" | "light"; size?: number }) {
  const { arrow, theme, size = 22 } = opts;
  const bg = theme === "dark" ? "#fafafa" : "#0a0a0a";
  const fg = theme === "dark" ? "#0a0a0a" : "#fafafa";
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background: ${bg};
      color: ${fg};
      border: 2px solid ${bg};
      box-shadow: 0 0 0 2px rgba(0,0,0,0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    ">${arrow}</div>
  `;
  return L.divIcon({
    className: "maneuver-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeUserIcon(opts: { heading: number | null; size?: number }) {
  const { heading, size = 22 } = opts;
  const arrow =
    heading != null
      ? `<div style="position:absolute; top:-4px; left:50%; transform: translate(-50%, -100%) rotate(${heading}deg); transform-origin: 50% 100%;">
           <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid #3b82f6;"></div>
         </div>`
      : "";
  const html = `
    <div style="position:relative; width: ${size}px; height: ${size}px;">
      ${arrow}
      <div style="
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: #3b82f6;
        border: 3px solid #fff;
        box-shadow: 0 0 0 2px rgba(59,130,246,0.4), 0 2px 8px rgba(0,0,0,0.5);
      "></div>
    </div>
  `;
  return L.divIcon({
    className: "user-marker",
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

function FitBounds({ points, animate = true }: { points: { lat: number; lng: number }[]; animate?: boolean }) {
  const map = useMap();
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (points.length < 2) return;
    const key = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|");
    if (key === lastKey.current) return;
    lastKey.current = key;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15, animate });
  }, [points, map, animate]);
  return null;
}

function FollowUser({ position }: { position: GeoPosition | null }) {
  const map = useMap();
  useEffect(() => {
    if (!position) return;
    map.setView([position.lat, position.lng], Math.max(map.getZoom(), 16), {
      animate: true,
    });
  }, [position?.lat, position?.lng]);
  return null;
}

export type ManeuverMarker = {
  lat: number;
  lng: number;
  arrow: string;
  label?: string;
};

export type RouteLegSegment = {
  geometry: [number, number][];
  status: "done" | "active" | "upcoming";
  endLabel?: string;
  endLatLng?: { lat: number; lng: number };
  kind?: "delivery" | "return";
};

export type DeliveryMapProps = {
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
  fitToAll?: boolean;
  showRoute?: boolean;
  showPendingRoute?: boolean;
  filterJob?: string | null;
  className?: string;
  interactive?: boolean;
  initialZoom?: number;
  pendingRouteGeometry?: [number, number][] | null;
  activeRouteGeometry?: [number, number][] | null;
  traveledGeometry?: [number, number][] | null;
  maneuvers?: ManeuverMarker[] | null;
  routeLegs?: RouteLegSegment[] | null;
  showRouteOverlay?: boolean;
};

export default function DeliveryMap({
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
  fitToAll,
  showRoute = true,
  showPendingRoute = true,
  filterJob,
  className,
  interactive = true,
  initialZoom = 11,
  pendingRouteGeometry,
  activeRouteGeometry,
  traveledGeometry,
  maneuvers,
  routeLegs,
  showRouteOverlay = true,
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
    if (depot && showDepot) pts.push({ lat: depot.lat, lng: depot.lng });
    for (const d of sortedDeliveries) pts.push({ lat: d.lat, lng: d.lng });
    for (const p of pending) pts.push({ lat: p.lat, lng: p.lng });
    return pts;
  }, [fitToAll, sortedDeliveries, pending, depot, showDepot]);

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

  const pendingRoutePositions = useMemo(() => {
    if (!showPendingRoute || pending.length === 0) return null;
    if (pendingRouteGeometry && pendingRouteGeometry.length >= 2) {
      return pendingRouteGeometry;
    }
    const positions: [number, number][] = [];
    if (depot) positions.push([depot.lat, depot.lng]);
    for (const p of pending) positions.push([p.lat, p.lng]);
    return positions;
  }, [pending, depot, showPendingRoute, pendingRouteGeometry]);

  const activeRoutePositions = useMemo(() => {
    if (activeRouteGeometry && activeRouteGeometry.length >= 2) {
      return activeRouteGeometry;
    }
    if (!activePendingId || !userPosition) return null;
    const target = pending.find((p) => p.id === activePendingId);
    if (!target) return null;
    return [
      [userPosition.lat, userPosition.lng],
      [target.lat, target.lng],
    ] as [number, number][];
  }, [activePendingId, userPosition, pending, activeRouteGeometry]);

  const accentColor = theme === "dark" ? "#fafafa" : "#0a0a0a";

  return (
    <div className={className} style={{ position: "relative", height: "100%", width: "100%" }}>
      <MapContainer
        center={depot ? [depot.lat, depot.lng] : SPB_CENTER}
        zoom={initialZoom}
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
        {followUser && <FollowUser position={userPosition ?? null} />}

        {showRouteOverlay && !routeLegs && pendingRoutePositions && pendingRoutePositions.length >= 2 && (
          <Polyline
            positions={pendingRoutePositions}
            pathOptions={{
              color: accentColor,
              weight: pendingRouteGeometry ? 5 : 3,
              opacity: pendingRouteGeometry ? 0.45 : 0.55,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        )}

        {showRouteOverlay && !routeLegs && activeRoutePositions && (
          <Polyline
            positions={activeRoutePositions}
            pathOptions={{
              color: "#3b82f6",
              weight: activeRouteGeometry ? 6 : 4,
              opacity: 0.92,
              dashArray: activeRouteGeometry ? undefined : "8 6",
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        )}

        {showRouteOverlay && !routeLegs && traveledGeometry && traveledGeometry.length >= 2 && (
          <Polyline
            positions={traveledGeometry}
            pathOptions={{
              color: theme === "dark" ? "#444" : "#bbb",
              weight: 5,
              opacity: 0.7,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        )}

        {showRouteOverlay && routeLegs?.map((leg, i) => {
          if (leg.geometry.length < 2) return null;
          const isReturn = leg.kind === "return";
          if (leg.status === "done") {
            return (
              <Polyline
                key={`leg-done-${i}`}
                positions={leg.geometry}
                pathOptions={{
                  color: theme === "dark" ? "#3a5a3a" : "#7fbf7f",
                  weight: 4,
                  opacity: 0.45,
                  dashArray: "2 7",
                  lineCap: "round",
                  lineJoin: "round",
                }}
              />
            );
          }
          if (leg.status === "active") {
            return (
              <Polyline
                key={`leg-active-${i}`}
                positions={leg.geometry}
                pathOptions={{
                  color: isReturn ? "#a855f7" : "#3b82f6",
                  weight: 7,
                  opacity: 0.95,
                  lineCap: "round",
                  lineJoin: "round",
                }}
              />
            );
          }
          return (
            <Polyline
              key={`leg-up-${i}`}
              positions={leg.geometry}
              pathOptions={{
                color: theme === "dark" ? "#888" : "#5a5a5a",
                weight: 4,
                opacity: 0.55,
                dashArray: "9 6",
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          );
        })}

        {showRouteOverlay && routeLegs?.map((leg, i) =>
          leg.status === "done" && leg.endLatLng ? (
            <Marker
              key={`leg-check-${i}`}
              position={[leg.endLatLng.lat, leg.endLatLng.lng]}
              icon={makeCheckIcon({ theme })}
              interactive={false}
              keyboard={false}
              zIndexOffset={400}
            />
          ) : null,
        )}

        {showRouteOverlay && maneuvers?.map((m, i) => (
          <Marker
            key={`mv-${i}`}
            position={[m.lat, m.lng]}
            icon={makeManeuverIcon({ arrow: m.arrow, theme })}
            interactive={false}
            keyboard={false}
            zIndexOffset={500}
          />
        ))}

        {routeByJob.map((r, i) => (
          <Polyline
            key={i}
            positions={r.positions}
            pathOptions={{
              color: r.color,
              weight: 2,
              opacity: 0.55,
              dashArray: "4 4",
            }}
          />
        ))}

        {depot && showDepot && (
          <Marker
            position={[depot.lat, depot.lng]}
            icon={makeDepotIcon({ theme })}
            eventHandlers={{ click: () => onDepotClick?.() }}
          >
            <Tooltip direction="top" offset={[0, -16]} opacity={1} className="map-tooltip">
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, lineHeight: 1.4 }}>
                <div style={{ opacity: 0.7 }}>депо · старт</div>
                <div style={{ fontWeight: 700 }}>{depot.name}</div>
                <div style={{ opacity: 0.7 }}>{depot.address}</div>
              </div>
            </Tooltip>
          </Marker>
        )}

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
                size: isSelected ? 32 : 24,
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
          const isActive = activePendingId === p.id;
          return (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              icon={makePendingIcon({
                index: i + 1,
                color: isActive ? "#3b82f6" : color,
                outline,
                active: isActive,
                size: isSelected || isActive ? 34 : 28,
              })}
              eventHandlers={{
                click: () => onPendingClick?.(p.id),
              }}
            >
              <Tooltip direction="top" offset={[0, -14]} opacity={1} className="map-tooltip">
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, lineHeight: 1.4 }}>
                  <div style={{ opacity: 0.7 }}>
                    {isActive ? "следующая" : "ожидает"} · {job?.label ?? p.jobId}
                  </div>
                  {p.address && <div style={{ opacity: 0.9 }}>{p.address}</div>}
                </div>
              </Tooltip>
            </Marker>
          );
        })}

        {userPosition && (
          <>
            <Circle
              center={[userPosition.lat, userPosition.lng]}
              radius={Math.max(userPosition.accuracy, 10)}
              pathOptions={{
                color: "#3b82f6",
                weight: 1,
                opacity: 0.4,
                fillColor: "#3b82f6",
                fillOpacity: 0.1,
              }}
            />
            <Marker
              position={[userPosition.lat, userPosition.lng]}
              icon={makeUserIcon({ heading: userPosition.heading })}
              zIndexOffset={1000}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1} className="map-tooltip">
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
                  моё местоположение
                  {userPosition.speed != null && userPosition.speed > 0.5 && (
                    <div style={{ opacity: 0.7 }}>
                      {(userPosition.speed * 3.6).toFixed(0)} км/ч
                    </div>
                  )}
                </div>
              </Tooltip>
            </Marker>
          </>
        )}
      </MapContainer>
    </div>
  );
}

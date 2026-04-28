import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGeolocation } from "@/lib/geolocation";
import { type PendingOrder } from "@/lib/deliveries";
import type { Depot, ResolvedJob } from "@/lib/store";
import DeliveryMap, { type ManeuverMarker } from "@/components/DeliveryMap";
import { useRoute } from "@/lib/use-route";
import {
  buildRouteIndex,
  computeProgress,
  sliceGeometry,
  traveledGeometry as buildTraveled,
  distanceM as distanceMeters,
} from "@/lib/route-progress";
import {
  createVoiceController,
  StepAnnouncer,
  maneuverArrow,
  maneuverInstruction,
} from "@/lib/voice";
import { cn } from "@/lib/utils";

export type DriveModeProps = {
  pending: PendingOrder[];
  jobs: ResolvedJob[];
  depot: Depot;
  theme: "dark" | "light";
  onExit: () => void;
  onCompleteStop: (id: string, amountRub: number) => void;
  onSkipStop: (id: string) => void;
};

const ARRIVAL_RADIUS_M = 30;
const OFF_ROUTE_THRESHOLD_M = 60;
const REROUTE_COOLDOWN_MS = 10_000;
const REROUTE_MIN_AGE_MS = 5_000;

function formatKm(km: number): string {
  if (km <= 0) return "—";
  if (km < 1) return `${Math.round(km * 1000)} м`;
  return `${km.toFixed(1)} км`;
}

function formatMeters(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 50) return "сейчас";
  if (m < 1000) return `${Math.round(m / 10) * 10} м`;
  return `${(m / 1000).toFixed(1)} км`;
}

function formatEtaSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.round(sec / 60);
  if (m < 1) return "<1 мин";
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m - h * 60} мин`;
}

export default function DriveMode({
  pending,
  jobs,
  depot,
  theme,
  onExit,
  onCompleteStop,
  onSkipStop,
}: DriveModeProps) {
  const { position, status, error } = useGeolocation(true);
  const [completing, setCompleting] = useState<{ id: string; value: string } | null>(null);
  const [muted, setMuted] = useState(false);

  const active = pending[0] ?? null;
  const job = active ? jobs.find((j) => j.id === active.jobId) : undefined;

  const voiceRef = useRef(createVoiceController(false));
  const announcerRef = useRef(new StepAnnouncer());
  const lastSegmentRef = useRef<number | undefined>(undefined);
  const lastRerouteAtRef = useRef<number>(0);
  const driveStartedAtRef = useRef<number>(Date.now());
  const lastActiveIdRef = useRef<string | null>(null);
  const arrivalAnnouncedRef = useRef<boolean>(false);
  const arrivalTriggeredRef = useRef<string | null>(null);

  useEffect(() => {
    voiceRef.current.setMuted(muted);
  }, [muted]);

  // Build the route from current position (or depot if no GPS yet) to all remaining pending stops.
  const [rerouteVersion, setRerouteVersion] = useState(0);
  const routeAnchor = useMemo(() => {
    if (position) return { lat: position.lat, lng: position.lng };
    return { lat: depot.lat, lng: depot.lng };
  }, [position?.lat, position?.lng, depot.lat, depot.lng, rerouteVersion]);

  const routePoints = useMemo(() => {
    if (pending.length === 0) return null;
    return [routeAnchor, ...pending.map((p) => ({ lat: p.lat, lng: p.lng }))];
  }, [pending, routeAnchor]);

  const route = useRoute(routePoints);

  // Reset announcer / segment when active stop changes
  useEffect(() => {
    if (active?.id !== lastActiveIdRef.current) {
      lastActiveIdRef.current = active?.id ?? null;
      announcerRef.current.reset();
      lastSegmentRef.current = undefined;
      arrivalAnnouncedRef.current = false;
    }
  }, [active?.id]);

  const routeIndex = useMemo(() => {
    if (!route.route) return null;
    return buildRouteIndex(route.route);
  }, [route.route]);

  const progress = useMemo(() => {
    if (!routeIndex || !position) return null;
    return computeProgress(
      routeIndex,
      { lat: position.lat, lng: position.lng },
      40,
      lastSegmentRef.current,
    );
  }, [routeIndex, position?.lat, position?.lng]);

  useEffect(() => {
    if (progress) lastSegmentRef.current = progress.segmentIndex;
  }, [progress?.segmentIndex]);

  // Maneuvers to show on the map (next ~5 ahead)
  const maneuvers: ManeuverMarker[] | null = useMemo(() => {
    if (!routeIndex || !routeIndex.steps.length) return null;
    const startIdx = progress?.currentStepIndex ?? 0;
    const out: ManeuverMarker[] = [];
    for (let i = startIdx; i < routeIndex.steps.length && out.length < 8; i += 1) {
      const s = routeIndex.steps[i];
      if (s.maneuver.type === "depart") continue;
      const arr = maneuverArrow(s);
      if (arr === "↑" && s.maneuver.type === "continue") continue;
      out.push({ lat: s.maneuver.location[0], lng: s.maneuver.location[1], arrow: arr });
    }
    return out;
  }, [routeIndex, progress?.currentStepIndex]);

  // Active route geometry (upcoming portion) and traveled geometry (faded behind)
  const upcomingGeometry = useMemo(() => {
    if (!routeIndex) return null;
    if (!progress || !position) return routeIndex.geometry;
    return sliceGeometry(routeIndex, progress.segmentIndex, progress.projection);
  }, [routeIndex, progress?.segmentIndex, progress?.projection.lat, progress?.projection.lng, position]);

  const traveledGeo = useMemo(() => {
    if (!routeIndex || !progress || !position) return null;
    if (progress.segmentIndex <= 0) return null;
    return buildTraveled(routeIndex, progress.segmentIndex, progress.projection);
  }, [routeIndex, progress?.segmentIndex, progress?.projection.lat, progress?.projection.lng, position]);

  // Distance from user to active stop (straight-line as a fast fallback; route covers real one)
  const distanceToActiveM = useMemo(() => {
    if (!active || !position) return 0;
    return distanceMeters(
      { lat: position.lat, lng: position.lng },
      { lat: active.lat, lng: active.lng },
    );
  }, [active, position?.lat, position?.lng]);

  const remainingTotalKm = useMemo(() => {
    if (route.route) return route.route.distance / 1000;
    if (pending.length === 0) return 0;
    let cursor = position
      ? { lat: position.lat, lng: position.lng }
      : { lat: depot.lat, lng: depot.lng };
    let total = 0;
    for (const p of pending) {
      total += distanceMeters(cursor, { lat: p.lat, lng: p.lng }) / 1000;
      cursor = { lat: p.lat, lng: p.lng };
    }
    return total;
  }, [pending, position?.lat, position?.lng, depot, route.route]);

  const remainingTotalSec = route.route?.duration ?? 0;

  const totalStops = pending.length;
  const completedSoFar = 0;

  // Voice + arrival + reroute
  useEffect(() => {
    if (!progress || !active) return;
    const voice = voiceRef.current;
    const announcer = announcerRef.current;

    // Reroute logic: if off-route too far, ignore for a few seconds after start, otherwise reroute with cooldown.
    const now = Date.now();
    const elapsed = now - driveStartedAtRef.current;
    if (
      progress.offRouteM > OFF_ROUTE_THRESHOLD_M &&
      elapsed > REROUTE_MIN_AGE_MS &&
      now - lastRerouteAtRef.current > REROUTE_COOLDOWN_MS &&
      !route.loading
    ) {
      lastRerouteAtRef.current = now;
      announcer.announceRerouted(voice);
      announcer.reset();
      lastSegmentRef.current = undefined;
      setRerouteVersion((v) => v + 1);
      return;
    }

    // Maneuver voice prompts
    announcer.considerAnnounce(
      voice,
      progress.currentStep,
      progress.distanceToNextManeuverM,
    );

    // Arrival detection: within 30 m of the active stop and arriving step is the last
    const isLastStep =
      routeIndex && progress.currentStepIndex >= routeIndex.steps.length - 1;
    const distToStopM = distanceMeters(
      { lat: position!.lat, lng: position!.lng },
      { lat: active.lat, lng: active.lng },
    );
    if (distToStopM <= ARRIVAL_RADIUS_M && isLastStep) {
      if (arrivalTriggeredRef.current !== active.id) {
        arrivalTriggeredRef.current = active.id;
        if (!arrivalAnnouncedRef.current) {
          arrivalAnnouncedRef.current = true;
          announcer.announceArrival(voice);
        }
        if (!completing) {
          const presetRate = job?.perOrderRateRub ?? active.priceRub ?? 0;
          setCompleting({
            id: active.id,
            value: presetRate > 0 ? String(presetRate) : "",
          });
        }
      }
    }
  }, [
    progress?.distanceFromStartM,
    progress?.offRouteM,
    progress?.currentStepIndex,
    route.loading,
    routeIndex,
    active?.id,
    position?.lat,
    position?.lng,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    return () => {
      voiceRef.current.cancel();
    };
  }, []);

  const finishCompletion = useCallback(() => {
    if (!completing || !active) return;
    const v = Number(completing.value);
    if (!Number.isFinite(v) || v <= 0) return;
    onCompleteStop(active.id, v);
    setCompleting(null);
    arrivalAnnouncedRef.current = false;
    arrivalTriggeredRef.current = null;
  }, [completing, active, onCompleteStop]);

  const currentStep = progress?.currentStep ?? null;
  const nextStep = progress?.nextStep ?? null;
  const arrow = maneuverArrow(currentStep);
  const instruction = maneuverInstruction(currentStep);
  const distToManeuver = progress?.distanceToNextManeuverM ?? 0;

  return (
    <div className="fixed inset-0 z-[2000] bg-background text-foreground flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 h-14 px-4 flex items-center justify-between border-b border-border bg-card">
        <button
          onClick={onExit}
          className="h-10 px-4 rounded-md border border-border text-[12px] font-medium uppercase tracking-[0.2em] hover:bg-muted transition-colors"
        >
          ← выйти
        </button>
        <div className="flex flex-col items-center">
          <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            режим вождения
          </div>
          <div className="text-[14px] font-semibold tabular-nums">
            {totalStops > 0
              ? `${completedSoFar + 1} / ${totalStops}`
              : "маршрут пуст"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMuted((m) => !m)}
            className={cn(
              "h-10 px-3 rounded-md border text-[11px] font-medium uppercase tracking-[0.2em] transition-colors",
              muted
                ? "border-border text-muted-foreground hover:bg-muted"
                : "border-primary bg-primary/10 text-foreground",
            )}
            title={muted ? "Голос выключен" : "Голос включён"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <div className="flex flex-col items-end text-right">
            <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              осталось
            </div>
            <div className="text-[14px] font-semibold tabular-nums">
              {formatKm(remainingTotalKm)}
              {remainingTotalSec > 0 ? ` · ${formatEtaSec(remainingTotalSec)}` : ""}
            </div>
          </div>
        </div>
      </div>

      {/* GPS / routing status banner */}
      {(status === "denied" ||
        status === "unavailable" ||
        status === "error" ||
        status === "requesting" ||
        route.error ||
        route.loading) && (
        <div
          className={cn(
            "shrink-0 px-4 py-2 text-center text-[11px] uppercase tracking-[0.2em]",
            status === "requesting" || route.loading
              ? "bg-muted text-muted-foreground"
              : "bg-destructive/15 text-destructive",
          )}
        >
          {status === "requesting" && "ищу GPS…"}
          {status === "denied" && "✕ нет разрешения на геолокацию — разреши в браузере"}
          {status === "unavailable" && "✕ GPS недоступен"}
          {status === "error" && `✕ ${error || "ошибка GPS"}`}
          {status !== "requesting" &&
            status !== "denied" &&
            status !== "unavailable" &&
            status !== "error" &&
            route.loading &&
            "строю маршрут…"}
          {!route.loading && route.error && `✕ маршрут: ${route.error}`}
        </div>
      )}

      {/* Maneuver card */}
      {currentStep && active && (
        <div className="shrink-0 px-3 pt-3">
          <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-center gap-4">
            <div className="shrink-0 w-14 h-14 rounded-lg bg-primary text-primary-foreground flex items-center justify-center text-[26px] leading-none">
              {arrow}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {currentStep.maneuver.type === "arrive"
                  ? "прибытие"
                  : "следующий манёвр"}
              </div>
              <div className="text-[20px] font-semibold leading-tight truncate">
                {instruction || (currentStep.name || "продолжайте")}
              </div>
              {nextStep && (
                <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                  потом · {maneuverInstruction(nextStep).toLowerCase()}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                через
              </div>
              <div className="text-[22px] font-semibold tabular-nums leading-tight">
                {formatMeters(distToManeuver)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Map */}
      <div className="flex-1 min-h-0 relative">
        <DeliveryMap
          deliveries={[]}
          pending={pending}
          jobs={jobs}
          depot={depot}
          showDepot={pending.length === 0}
          theme={theme}
          userPosition={position}
          followUser={!!position}
          activePendingId={active?.id ?? null}
          showRoute={false}
          showPendingRoute={false}
          fitToAll={!position && pending.length > 0}
          initialZoom={position ? 16 : 12}
          activeRouteGeometry={upcomingGeometry}
          traveledGeometry={traveledGeo}
          maneuvers={maneuvers}
        />
      </div>

      {/* Bottom panel */}
      <div className="shrink-0 bg-card border-t border-border">
        {!active ? (
          <div className="p-6 text-center">
            <div className="text-[14px] font-semibold mb-2">маршрут завершён</div>
            <div className="text-[11px] text-muted-foreground mb-4">
              все заказы доставлены
            </div>
            <button
              onClick={onExit}
              className="h-12 px-6 rounded-md bg-primary text-primary-foreground text-[12px] font-medium uppercase tracking-[0.2em]"
            >
              готово
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                следующая остановка
              </span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {job?.label ?? active.jobId}
              </span>
            </div>
            <div className="text-[18px] font-semibold leading-tight">
              {active.address || `${active.lat.toFixed(5)}, ${active.lng.toFixed(5)}`}
            </div>
            <div className="flex items-center justify-between text-[14px] tabular-nums">
              <div>
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  по прямой
                </span>
                <span className="text-[20px] font-semibold">
                  {position ? formatMeters(distanceToActiveM) : "ждём GPS"}
                </span>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  до конца маршрута
                </span>
                <span className="text-[20px] font-semibold">
                  {progress
                    ? formatMeters(progress.distanceToEndM)
                    : route.route
                      ? formatKm(remainingTotalKm)
                      : "—"}
                </span>
              </div>
            </div>

            {completing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  finishCompletion();
                }}
                className="flex items-center gap-2 pt-1"
              >
                <input
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={completing.value}
                  onChange={(e) =>
                    setCompleting((c) =>
                      c ? { ...c, value: e.target.value.replace(/\D/g, "") } : c,
                    )
                  }
                  placeholder="сумма ₽"
                  className="flex-1 h-12 px-3 rounded-md border border-border bg-background text-[18px] tabular-nums focus:outline-none focus:border-foreground/40"
                />
                <button
                  type="submit"
                  className="h-12 px-5 rounded-md bg-primary text-primary-foreground text-[12px] font-semibold uppercase tracking-[0.2em]"
                >
                  ок
                </button>
                <button
                  type="button"
                  onClick={() => setCompleting(null)}
                  className="h-12 px-3 rounded-md border border-border text-[12px] uppercase tracking-[0.2em] text-muted-foreground"
                >
                  ×
                </button>
              </form>
            ) : (
              <div className="flex items-stretch gap-2 pt-1">
                <button
                  onClick={() => {
                    const presetRate = job?.perOrderRateRub ?? active.priceRub ?? 0;
                    setCompleting({
                      id: active.id,
                      value: presetRate > 0 ? String(presetRate) : "",
                    });
                  }}
                  className="flex-1 h-14 rounded-md bg-primary text-primary-foreground text-[14px] font-semibold uppercase tracking-[0.2em] active:scale-[0.98] transition-transform"
                >
                  ✓ доставлено
                </button>
                <button
                  onClick={() => {
                    onSkipStop(active.id);
                    arrivalAnnouncedRef.current = false;
                    arrivalTriggeredRef.current = null;
                  }}
                  className="h-14 px-4 rounded-md border border-border text-[11px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Пропустить эту остановку и взять следующую"
                >
                  пропустить
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGeolocation } from "@/lib/geolocation";
import { type PendingOrder } from "@/lib/deliveries";
import type { Depot, ResolvedJob } from "@/lib/store";
import DeliveryMap, {
  type ManeuverMarker,
  type RouteLegSegment,
} from "@/components/DeliveryMap";
import { useRoute } from "@/lib/use-route";
import {
  buildRouteIndex,
  computeProgress,
  distanceM as distanceMeters,
  getLegGeometry,
  legSliceFromProjection,
  type LatLng,
} from "@/lib/route-progress";
import {
  createVoiceController,
  StepAnnouncer,
  StopAnnouncer,
  maneuverArrow,
  maneuverInstruction,
  announceRouteBuilt,
  announceStopDelivered,
  announceReturningToDepot,
  announceShiftFinished,
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
const DEPOT_ARRIVAL_RADIUS_M = 50;
const OFF_ROUTE_THRESHOLD_M = 60;
const REROUTE_COOLDOWN_MS = 10_000;
const REROUTE_MIN_AGE_MS = 5_000;
const ROUTE_VISIBLE_KEY = "salary-calendar:drive:route-visible";
const STOPS_PANEL_KEY = "salary-calendar:drive:stops-open";

type Mode = "driving" | "returning" | "finished";

type RouteRequest = {
  points: LatLng[];
  stopIds: string[];
  kind: "delivery" | "return";
  builtAt: number;
};

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

function formatArrivalClock(secsFromNow: number): string {
  if (!Number.isFinite(secsFromNow) || secsFromNow <= 0) return "—";
  const date = new Date(Date.now() + secsFromNow * 1000);
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function loadBool(key: string, def: boolean): boolean {
  if (typeof window === "undefined") return def;
  try {
    const v = window.localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {}
  return def;
}

function saveBool(key: string, v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, v ? "1" : "0");
  } catch {}
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
  const [routeVisible, setRouteVisible] = useState(() =>
    loadBool(ROUTE_VISIBLE_KEY, true),
  );
  const [stopsOpen, setStopsOpen] = useState(() =>
    loadBool(STOPS_PANEL_KEY, false),
  );
  const [mode, setMode] = useState<Mode>(() =>
    pending.length === 0 ? "returning" : "driving",
  );
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);

  const voiceRef = useRef(createVoiceController(false));
  const announcerRef = useRef(new StepAnnouncer());
  const stopAnnouncerRef = useRef(new StopAnnouncer());
  const lastSegmentRef = useRef<number | undefined>(undefined);
  const lastRerouteAtRef = useRef<number>(0);
  const driveStartedAtRef = useRef<number>(Date.now());
  const arrivalAnnouncedRef = useRef<boolean>(false);
  const arrivalTriggeredRef = useRef<string | null>(null);
  const lastBuiltRouteIdRef = useRef<string | null>(null);
  const finishAnnouncedRef = useRef<boolean>(false);
  const lastModeRef = useRef<Mode>(mode);

  useEffect(() => {
    voiceRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    saveBool(ROUTE_VISIBLE_KEY, routeVisible);
  }, [routeVisible]);

  useEffect(() => {
    saveBool(STOPS_PANEL_KEY, stopsOpen);
  }, [stopsOpen]);

  // Build initial delivery route as soon as GPS is available and we have stops.
  useEffect(() => {
    if (!position) return;
    if (mode !== "driving") return;
    if (pending.length === 0) return;
    if (routeRequest && routeRequest.kind === "delivery") {
      // Rebuild only if NEW stop appeared (pending grew beyond what's in current route).
      const knownIds = new Set(routeRequest.stopIds);
      const hasNew = pending.some((p) => !knownIds.has(p.id));
      if (!hasNew) return;
    }
    setRouteRequest({
      points: [
        { lat: position.lat, lng: position.lng },
        ...pending.map((p) => ({ lat: p.lat, lng: p.lng })),
      ],
      stopIds: pending.map((p) => p.id),
      kind: "delivery",
      builtAt: Date.now(),
    });
  }, [position?.lat, position?.lng, mode, pending.map((p) => p.id).join("|")]);

  // Switch to "returning" once all stops are done in driving mode.
  useEffect(() => {
    if (mode === "driving" && pending.length === 0 && routeRequest?.kind === "delivery") {
      setMode("returning");
    }
  }, [pending.length, mode, routeRequest?.kind]);

  // Build return-to-depot route when entering returning mode.
  useEffect(() => {
    if (mode !== "returning") return;
    if (!position) return;
    if (routeRequest?.kind === "return") return;
    setRouteRequest({
      points: [
        { lat: position.lat, lng: position.lng },
        { lat: depot.lat, lng: depot.lng },
      ],
      stopIds: ["__depot__"],
      kind: "return",
      builtAt: Date.now(),
    });
    announceReturningToDepot(voiceRef.current);
  }, [mode, position?.lat, position?.lng, depot.lat, depot.lng, routeRequest?.kind]);

  // Reset announcers/segment tracking when mode or route changes
  useEffect(() => {
    if (mode !== lastModeRef.current) {
      lastModeRef.current = mode;
      announcerRef.current.reset();
      stopAnnouncerRef.current.reset();
      lastSegmentRef.current = undefined;
      arrivalAnnouncedRef.current = false;
      arrivalTriggeredRef.current = null;
      driveStartedAtRef.current = Date.now();
    }
  }, [mode]);

  const route = useRoute(routeRequest?.points ?? null);

  // Announce route built once
  useEffect(() => {
    if (!route.route || !routeRequest) return;
    const id = `${routeRequest.builtAt}:${routeRequest.kind}`;
    if (lastBuiltRouteIdRef.current === id) return;
    lastBuiltRouteIdRef.current = id;
    if (routeRequest.kind === "delivery" && pending.length > 0) {
      announceRouteBuilt(
        voiceRef.current,
        route.route.distance / 1000,
        route.route.duration,
        pending.length,
      );
    }
    announcerRef.current.reset();
    stopAnnouncerRef.current.reset();
    lastSegmentRef.current = undefined;
    arrivalAnnouncedRef.current = false;
    arrivalTriggeredRef.current = null;
  }, [route.route, routeRequest?.builtAt, routeRequest?.kind, pending.length]);

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

  // Map current pending list onto route legs.
  // For delivery routes: route has N legs for N original stops.
  // Stops already completed = originalCount - pending.length.
  const completedLegsCount = useMemo(() => {
    if (!routeRequest || routeRequest.kind !== "delivery") return 0;
    const original = routeRequest.stopIds.length;
    return Math.max(0, Math.min(original, original - pending.length));
  }, [routeRequest, pending.length]);

  const currentLegIdx = useMemo(() => {
    if (!routeIndex) return 0;
    if (routeRequest?.kind === "return") return 0;
    return Math.min(completedLegsCount, routeIndex.legCount - 1);
  }, [routeIndex, completedLegsCount, routeRequest?.kind]);

  // Build leg segments for the map
  const routeLegs: RouteLegSegment[] | null = useMemo(() => {
    if (!routeIndex) return null;
    if (!routeRequest) return null;
    const out: RouteLegSegment[] = [];
    for (let i = 0; i < routeIndex.legCount; i += 1) {
      let geom: [number, number][];
      let status: "done" | "active" | "upcoming";
      if (i < currentLegIdx) {
        status = "done";
        geom = getLegGeometry(routeIndex, i);
      } else if (i === currentLegIdx) {
        status = "active";
        geom =
          progress && position
            ? legSliceFromProjection(
                routeIndex,
                i,
                progress.segmentIndex,
                progress.projection,
              )
            : getLegGeometry(routeIndex, i);
      } else {
        status = "upcoming";
        geom = getLegGeometry(routeIndex, i);
      }
      // Endpoint label: stop address or "депо"
      const endLatLngArr = routeIndex.geometry[routeIndex.legVertexEnd[i]];
      const endLatLng = endLatLngArr
        ? { lat: endLatLngArr[0], lng: endLatLngArr[1] }
        : undefined;
      let endLabel: string | undefined;
      if (routeRequest.kind === "delivery") {
        const stopId = routeRequest.stopIds[i];
        const orig = pending.find((p) => p.id === stopId);
        endLabel = orig?.address;
      } else {
        endLabel = "депо";
      }
      out.push({
        geometry: geom,
        status,
        endLatLng,
        endLabel,
        kind: routeRequest.kind,
      });
    }
    return out;
  }, [
    routeIndex,
    routeRequest,
    currentLegIdx,
    progress?.segmentIndex,
    progress?.projection.lat,
    progress?.projection.lng,
    position,
    pending,
  ]);

  // Maneuvers for upcoming portion only
  const maneuvers: ManeuverMarker[] | null = useMemo(() => {
    if (!routeIndex || !routeIndex.steps.length) return null;
    const startIdx = progress?.currentStepIndex ?? 0;
    const out: ManeuverMarker[] = [];
    for (let i = startIdx; i < routeIndex.steps.length && out.length < 10; i += 1) {
      const s = routeIndex.steps[i];
      if (s.maneuver.type === "depart") continue;
      const arr = maneuverArrow(s);
      if (arr === "↑" && s.maneuver.type === "continue") continue;
      out.push({ lat: s.maneuver.location[0], lng: s.maneuver.location[1], arrow: arr });
    }
    return out;
  }, [routeIndex, progress?.currentStepIndex]);

  const active = mode === "driving" ? pending[0] ?? null : null;
  const job = active ? jobs.find((j) => j.id === active.jobId) : undefined;

  // Distance to current target (active stop in driving mode, depot in returning mode)
  const distanceToTargetM = useMemo(() => {
    if (!position) return 0;
    if (mode === "returning") {
      return distanceMeters(
        { lat: position.lat, lng: position.lng },
        { lat: depot.lat, lng: depot.lng },
      );
    }
    if (!active) return 0;
    return distanceMeters(
      { lat: position.lat, lng: position.lng },
      { lat: active.lat, lng: active.lng },
    );
  }, [active, position?.lat, position?.lng, mode, depot.lat, depot.lng]);

  // Voice + arrival + reroute logic
  useEffect(() => {
    if (!progress) return;
    if (mode === "finished") return;
    if (!position) return;

    const voice = voiceRef.current;
    const announcer = announcerRef.current;

    // Reroute: off-route detection
    const now = Date.now();
    const elapsed = now - driveStartedAtRef.current;
    if (
      progress.offRouteM > OFF_ROUTE_THRESHOLD_M &&
      elapsed > REROUTE_MIN_AGE_MS &&
      now - lastRerouteAtRef.current > REROUTE_COOLDOWN_MS &&
      !route.loading &&
      routeRequest
    ) {
      lastRerouteAtRef.current = now;
      announcer.announceRerouted(voice);
      announcer.reset();
      stopAnnouncerRef.current.reset();
      lastSegmentRef.current = undefined;
      // Rebuild current request from current GPS
      if (routeRequest.kind === "delivery") {
        setRouteRequest({
          points: [
            { lat: position.lat, lng: position.lng },
            ...pending.map((p) => ({ lat: p.lat, lng: p.lng })),
          ],
          stopIds: pending.map((p) => p.id),
          kind: "delivery",
          builtAt: Date.now(),
        });
      } else {
        setRouteRequest({
          points: [
            { lat: position.lat, lng: position.lng },
            { lat: depot.lat, lng: depot.lng },
          ],
          stopIds: ["__depot__"],
          kind: "return",
          builtAt: Date.now(),
        });
      }
      return;
    }

    // Maneuver voice prompts
    announcer.considerAnnounce(
      voice,
      progress.currentStep,
      progress.distanceToNextManeuverM,
    );

    // Stop approach announcements
    if (mode === "driving" && active) {
      const label = active.address?.trim() || "следующая точка";
      stopAnnouncerRef.current.considerAnnounce(
        voice,
        active.id,
        label.length > 60 ? label.slice(0, 60) : label,
        distanceToTargetM,
      );
    }

    // Arrival detection
    const isLastStep =
      routeIndex && progress.currentStepIndex >= routeIndex.steps.length - 1;
    if (mode === "driving" && active) {
      if (distanceToTargetM <= ARRIVAL_RADIUS_M && isLastStep) {
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
    } else if (mode === "returning") {
      if (distanceToTargetM <= DEPOT_ARRIVAL_RADIUS_M && !finishAnnouncedRef.current) {
        finishAnnouncedRef.current = true;
        announceShiftFinished(voice);
        setMode("finished");
      }
    }
  }, [
    progress?.distanceFromStartM,
    progress?.offRouteM,
    progress?.currentStepIndex,
    distanceToTargetM,
    route.loading,
    routeIndex,
    routeRequest,
    active?.id,
    position?.lat,
    position?.lng,
    mode,
    depot.lat,
    depot.lng,
    pending.map((p) => p.id).join("|"),
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

  const totalStops = routeRequest?.kind === "delivery" ? routeRequest.stopIds.length : 0;
  const stopNumber = mode === "driving" ? Math.min(totalStops, completedLegsCount + 1) : totalStops;

  const remainingTotalKm = useMemo(() => {
    if (route.route && progress) {
      return Math.max(0, progress.distanceToEndM) / 1000;
    }
    if (route.route) return route.route.distance / 1000;
    return 0;
  }, [route.route, progress?.distanceToEndM]);

  const remainingTotalSec = useMemo(() => {
    if (!route.route) return 0;
    if (!progress || routeIndex == null) return route.route.duration;
    // Linear interpolation: remaining duration ≈ route.duration * (distToEnd / totalLength)
    const total = routeIndex.totalLength;
    if (total <= 0) return 0;
    return route.route.duration * (progress.distanceToEndM / total);
  }, [route.route, progress?.distanceToEndM, routeIndex]);

  const speedKmh = position?.speed != null && position.speed > 0.5
    ? Math.round(position.speed * 3.6)
    : null;

  const finishCompletion = useCallback(
    (overrideId?: string, overrideAmount?: number) => {
      const id = overrideId ?? completing?.id;
      const amount = overrideAmount ?? Number(completing?.value);
      if (!id || !Number.isFinite(amount) || amount <= 0) return;
      onCompleteStop(id, amount);
      announceStopDelivered(voiceRef.current, Math.max(0, pending.length - 1));
      setCompleting(null);
      arrivalAnnouncedRef.current = false;
      arrivalTriggeredRef.current = null;
    },
    [completing, onCompleteStop, pending.length],
  );

  const manualArrived = useCallback(() => {
    if (!active) return;
    const presetRate = job?.perOrderRateRub ?? active.priceRub ?? 0;
    setCompleting({
      id: active.id,
      value: presetRate > 0 ? String(presetRate) : "",
    });
  }, [active, job]);

  const requestReroute = useCallback(() => {
    if (!position) return;
    const v = voiceRef.current;
    announcerRef.current.reset();
    stopAnnouncerRef.current.reset();
    lastSegmentRef.current = undefined;
    if (mode === "driving" && pending.length > 0) {
      setRouteRequest({
        points: [
          { lat: position.lat, lng: position.lng },
          ...pending.map((p) => ({ lat: p.lat, lng: p.lng })),
        ],
        stopIds: pending.map((p) => p.id),
        kind: "delivery",
        builtAt: Date.now(),
      });
    } else if (mode === "returning") {
      setRouteRequest({
        points: [
          { lat: position.lat, lng: position.lng },
          { lat: depot.lat, lng: depot.lng },
        ],
        stopIds: ["__depot__"],
        kind: "return",
        builtAt: Date.now(),
      });
    }
    v.speak("Пересчитываю маршрут.");
  }, [position?.lat, position?.lng, mode, pending, depot.lat, depot.lng]);

  const currentStep = progress?.currentStep ?? null;
  const nextStep = progress?.nextStep ?? null;
  const arrow = maneuverArrow(currentStep);
  const instruction = maneuverInstruction(currentStep);
  const distToManeuver = progress?.distanceToNextManeuverM ?? 0;

  // Maneuver urgency colour
  const maneuverUrgency: "far" | "mid" | "near" =
    distToManeuver < 50 ? "near" : distToManeuver < 200 ? "mid" : "far";

  const fitPoints = useMemo(() => {
    if (position) return [];
    const pts: { lat: number; lng: number }[] = [{ lat: depot.lat, lng: depot.lng }];
    for (const p of pending) pts.push({ lat: p.lat, lng: p.lng });
    return pts;
  }, [position, pending, depot.lat, depot.lng]);

  return (
    <div className="fixed inset-0 z-[2000] bg-background text-foreground flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 h-14 px-3 flex items-center justify-between border-b border-border bg-card gap-2">
        <button
          onClick={onExit}
          className="h-10 px-3 rounded-md border border-border text-[11px] font-medium uppercase tracking-[0.2em] hover:bg-muted transition-colors"
        >
          ← выйти
        </button>
        <div className="flex flex-col items-center min-w-0">
          <div className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground truncate">
            {mode === "driving"
              ? "режим вождения"
              : mode === "returning"
                ? "возврат в депо"
                : "смена окончена"}
          </div>
          <div className="text-[14px] font-semibold tabular-nums truncate">
            {mode === "driving" && totalStops > 0
              ? `${stopNumber} / ${totalStops}`
              : mode === "returning"
                ? "→ депо"
                : "✓ готово"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setRouteVisible((v) => !v)}
            className={cn(
              "h-10 w-10 rounded-md border text-[14px] transition-colors flex items-center justify-center",
              routeVisible
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
            title={routeVisible ? "Скрыть маршрут" : "Показать маршрут"}
          >
            {routeVisible ? "👁" : "⊘"}
          </button>
          <button
            onClick={() => setMuted((m) => !m)}
            className={cn(
              "h-10 w-10 rounded-md border text-[14px] transition-colors flex items-center justify-center",
              muted
                ? "border-border text-muted-foreground hover:bg-muted"
                : "border-primary bg-primary/10 text-foreground",
            )}
            title={muted ? "Голос выключен" : "Голос включён"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <div className="flex flex-col items-end text-right pl-1">
            <div className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
              {speedKmh != null ? `${speedKmh} км/ч` : "осталось"}
            </div>
            <div className="text-[13px] font-semibold tabular-nums leading-tight">
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
      {currentStep && mode !== "finished" && (
        <div className="shrink-0 px-3 pt-3">
          <div
            className={cn(
              "rounded-xl border bg-card px-4 py-3 flex items-center gap-4 transition-all",
              maneuverUrgency === "near"
                ? "border-red-500/70 ring-2 ring-red-500/30"
                : maneuverUrgency === "mid"
                  ? "border-amber-500/60"
                  : "border-border",
            )}
          >
            <div
              className={cn(
                "shrink-0 w-16 h-16 rounded-lg flex items-center justify-center text-[32px] leading-none font-bold",
                maneuverUrgency === "near"
                  ? "bg-red-500 text-white"
                  : maneuverUrgency === "mid"
                    ? "bg-amber-500 text-black"
                    : "bg-primary text-primary-foreground",
              )}
            >
              {arrow}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {currentStep.maneuver.type === "arrive"
                  ? mode === "returning"
                    ? "прибытие в депо"
                    : "прибытие к точке"
                  : "следующий манёвр"}
              </div>
              <div className="text-[22px] font-semibold leading-tight truncate">
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
              <div
                className={cn(
                  "text-[26px] font-semibold tabular-nums leading-tight",
                  maneuverUrgency === "near" && "text-red-500",
                  maneuverUrgency === "mid" && "text-amber-500",
                )}
              >
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
          showDepot={mode === "returning" || mode === "finished" || pending.length === 0}
          theme={theme}
          userPosition={position}
          followUser={!!position}
          activePendingId={active?.id ?? null}
          showRoute={false}
          showPendingRoute={false}
          fitToAll={!position && fitPoints.length > 1}
          initialZoom={position ? 16 : 12}
          routeLegs={routeLegs}
          maneuvers={maneuvers}
          showRouteOverlay={routeVisible}
        />

        {/* Stops side panel toggle */}
        {(mode === "driving" || mode === "returning") && totalStops > 0 && (
          <button
            onClick={() => setStopsOpen((v) => !v)}
            className="absolute top-3 right-3 z-[1000] h-10 px-3 rounded-md border border-border bg-card/95 backdrop-blur text-[10px] uppercase tracking-[0.2em] font-medium hover:bg-muted shadow-md"
          >
            {stopsOpen ? "× список" : `≡ список · ${pending.length}`}
          </button>
        )}

        {/* Reroute button */}
        {mode !== "finished" && position && (
          <button
            onClick={requestReroute}
            className="absolute bottom-3 right-3 z-[1000] h-10 px-3 rounded-md border border-border bg-card/95 backdrop-blur text-[10px] uppercase tracking-[0.2em] font-medium hover:bg-muted shadow-md"
            title="Пересчитать маршрут"
          >
            ⟲ пересчёт
          </button>
        )}

        {/* Stops panel */}
        {stopsOpen && (mode === "driving" || mode === "returning") && (
          <div className="absolute top-14 right-3 bottom-3 w-[280px] z-[999] rounded-xl border border-border bg-card/97 backdrop-blur shadow-xl overflow-hidden flex flex-col">
            <div className="shrink-0 px-3 py-2 border-b border-border">
              <div className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                все точки маршрута
              </div>
              <div className="text-[12px] font-semibold tabular-nums">
                {pending.length} осталось · ⌂ депо
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {routeRequest?.kind === "delivery" &&
                routeRequest.stopIds.map((sid, i) => {
                  const inPending = pending.find((p) => p.id === sid);
                  const isDone = !inPending;
                  const isActive = inPending && pending[0]?.id === sid;
                  const legDur = routeIndex?.legDurations[i] ?? 0;
                  const legDist = routeIndex?.legDistances[i] ?? 0;
                  return (
                    <div
                      key={sid}
                      className={cn(
                        "px-3 py-2 border-b border-border/40 text-[11px] flex gap-2",
                        isActive && "bg-primary/10",
                        isDone && "opacity-50",
                      )}
                    >
                      <div
                        className={cn(
                          "shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold",
                          isDone
                            ? "bg-green-600 text-white"
                            : isActive
                              ? "bg-primary text-primary-foreground"
                              : "border border-border text-muted-foreground",
                        )}
                      >
                        {isDone ? "✓" : i + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
                          {inPending?.address ||
                            routeRequest.stopIds[i].slice(0, 8) ||
                            "точка"}
                        </div>
                        <div className="text-muted-foreground tabular-nums text-[10px]">
                          {formatKm(legDist / 1000)} · {formatEtaSec(legDur)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              {/* Depot row */}
              <div
                className={cn(
                  "px-3 py-2 text-[11px] flex gap-2",
                  mode === "returning" && "bg-purple-500/10",
                )}
              >
                <div className="shrink-0 w-6 h-6 rounded-md bg-foreground text-background flex items-center justify-center text-[12px] font-bold">
                  ⌂
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{depot.name || "депо"}</div>
                  <div className="text-muted-foreground truncate text-[10px]">
                    {depot.address}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom panel */}
      <div className="shrink-0 bg-card border-t border-border">
        {mode === "finished" ? (
          <div className="p-6 text-center">
            <div className="text-[14px] font-semibold mb-2">смена окончена</div>
            <div className="text-[11px] text-muted-foreground mb-4">
              все заказы доставлены, вернулись в депо
            </div>
            <button
              onClick={onExit}
              className="h-12 px-6 rounded-md bg-primary text-primary-foreground text-[12px] font-medium uppercase tracking-[0.2em]"
            >
              готово
            </button>
          </div>
        ) : mode === "returning" ? (
          <div className="p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                возврат в депо
              </span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-purple-500">
                ⌂ {depot.name || "депо"}
              </span>
            </div>
            <div className="text-[18px] font-semibold leading-tight">
              {depot.address}
            </div>
            <div className="flex items-center justify-between text-[14px] tabular-nums">
              <div>
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  по прямой
                </span>
                <span className="text-[20px] font-semibold">
                  {position ? formatMeters(distanceToTargetM) : "ждём GPS"}
                </span>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  по дороге
                </span>
                <span className="text-[20px] font-semibold">
                  {progress
                    ? formatMeters(progress.distanceToEndM)
                    : route.route
                      ? formatKm(remainingTotalKm)
                      : "—"}
                </span>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  прибытие
                </span>
                <span className="text-[20px] font-semibold">
                  {remainingTotalSec > 0 ? formatArrivalClock(remainingTotalSec) : "—"}
                </span>
              </div>
            </div>
            <button
              onClick={() => {
                finishAnnouncedRef.current = true;
                announceShiftFinished(voiceRef.current);
                setMode("finished");
              }}
              className="w-full h-12 rounded-md border border-border text-[11px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              я уже в депо
            </button>
          </div>
        ) : !active ? (
          <div className="p-6 text-center">
            <div className="text-[14px] font-semibold mb-2">маршрут пуст</div>
            <div className="text-[11px] text-muted-foreground mb-4">
              добавь точки на карте
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
                следующая остановка · {stopNumber} из {totalStops}
              </span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {job?.label ?? active.jobId}
              </span>
            </div>
            <div className="text-[18px] font-semibold leading-tight">
              {active.address || `${active.lat.toFixed(5)}, ${active.lng.toFixed(5)}`}
            </div>
            <div className="flex items-center justify-between text-[14px] tabular-nums gap-2">
              <div>
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  по прямой
                </span>
                <span className="text-[20px] font-semibold">
                  {position ? formatMeters(distanceToTargetM) : "ждём GPS"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  по дороге
                </span>
                <span className="text-[20px] font-semibold">
                  {progress
                    ? formatMeters(progress.distanceToEndM)
                    : route.route
                      ? formatKm(remainingTotalKm)
                      : "—"}
                </span>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  финиш
                </span>
                <span className="text-[20px] font-semibold">
                  {remainingTotalSec > 0 ? formatArrivalClock(remainingTotalSec) : "—"}
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
                  onClick={manualArrived}
                  className="flex-1 h-14 rounded-md bg-primary text-primary-foreground text-[14px] font-semibold uppercase tracking-[0.2em] active:scale-[0.98] transition-transform"
                >
                  ✓ доставлено
                </button>
                <button
                  onClick={() => {
                    onSkipStop(active.id);
                    arrivalAnnouncedRef.current = false;
                    arrivalTriggeredRef.current = null;
                    announcerRef.current.reset();
                    stopAnnouncerRef.current.reset();
                    lastSegmentRef.current = undefined;
                    // Parent moves the skipped stop to the end → reorder & reroute from current GPS
                    if (position) {
                      const reordered = pending
                        .filter((p) => p.id !== active.id)
                        .concat([active]);
                      setRouteRequest({
                        points: [
                          { lat: position.lat, lng: position.lng },
                          ...reordered.map((p) => ({ lat: p.lat, lng: p.lng })),
                        ],
                        stopIds: reordered.map((p) => p.id),
                        kind: "delivery",
                        builtAt: Date.now(),
                      });
                    }
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

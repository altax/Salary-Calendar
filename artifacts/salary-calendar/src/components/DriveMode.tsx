import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useGeolocation, type GeoPosition } from "@/lib/geolocation";
import { type PendingOrder } from "@/lib/deliveries";
import type { Depot, ResolvedJob } from "@/lib/store";
import Map3D from "@/components/Map3D";
import DeliveryMap, {
  type ManeuverMarker,
  type RouteLegSegment,
  type MapLayerMode,
} from "@/components/DeliveryMap";
import { useRoute } from "@/lib/use-route";
import {
  buildRouteIndex,
  computeProgress,
  distanceM as distanceMeters,
  bearingDeg,
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
  announceOfflineFallbackRoute,
  announceStopDelivered,
  announceStopUndone,
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
  onUndoCompleteStop?: (id: string) => void;
  onSkipStop: (id: string) => void;
  onSaveDeliveryRoute?: (
    geometry: [number, number][],
    distanceM: number,
    durationS: number,
  ) => void;
  onSaveReturnRoute?: (
    geometry: [number, number][],
    distanceM: number,
    durationS: number,
  ) => void;
  onFinishWave?: () => void;
  layerMode?: MapLayerMode;
  onLayerChange?: (mode: MapLayerMode) => void;
};

const ARRIVAL_RADIUS_M = 30;
const DEPOT_ARRIVAL_RADIUS_M = 50;
const OFF_ROUTE_THRESHOLD_M = 60;
const REROUTE_COOLDOWN_MS = 10_000;
const REROUTE_MIN_AGE_MS = 5_000;
const ROUTE_VISIBLE_KEY = "salary-calendar:drive:route-visible";
const STOPS_PANEL_KEY = "salary-calendar:drive:stops-open";
const SIM_SPEED_KEY = "salary-calendar:drive:sim-speed";
const SIM_TICK_MS = 250;
const SIM_AUTOCOMPLETE_DELAY_MS = 3000;
const UNDO_WINDOW_MS = 5_000;
const COURSE_UP_KEY = "salary-calendar:drive:course-up";
const SIM_SPEED_PRESETS = [10, 30, 60, 120] as const;

type Mode = "driving" | "returning" | "finished";

type LastCompletedSnapshot = {
  stopId: string;
  amount: number;
  address?: string;
  expireAt: number;
};

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
  onUndoCompleteStop,
  onSkipStop,
  onSaveDeliveryRoute,
  onSaveReturnRoute,
  onFinishWave,
  layerMode = "default",
  onLayerChange,
}: DriveModeProps) {
  // GPS simulator state. When `simEnabled` is true we ignore the real device
  // GPS and synthesize positions by walking the current route geometry. This
  // lets the user dry-run the entire wave (delivery legs → arrival auto-pop
  // → next leg → return-to-depot → шифт finished) without going outside.
  const [simEnabled, setSimEnabled] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [simSpeedKmh, setSimSpeedKmh] = useState<number>(() => {
    if (typeof window === "undefined") return 30;
    try {
      const raw = window.localStorage.getItem(SIM_SPEED_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= 5 && n <= 200) return n;
    } catch {}
    return 30;
  });
  const [simPosition, setSimPosition] = useState<GeoPosition | null>(null);
  const [simPanelOpen, setSimPanelOpen] = useState(false);

  const realGeo = useGeolocation(!simEnabled);
  const position: GeoPosition | null = simEnabled ? simPosition : realGeo.position;
  const status = simEnabled ? "watching" : realGeo.status;
  const error = simEnabled ? null : realGeo.error;

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
  const [lastCompleted, setLastCompleted] =
    useState<LastCompletedSnapshot | null>(null);
  const [, forceTick] = useState(0);
  // Course-up rotation. When true and we have a heading, we rotate the map
  // so the user's direction of travel always points up the screen.
  const [courseUp, setCourseUp] = useState(() => loadBool(COURSE_UP_KEY, true));
  // Smoothed heading for course-up rotation — raw GPS heading is jittery,
  // so we low-pass-filter it to avoid the map spinning every tick.
  const [smoothedHeading, setSmoothedHeading] = useState<number | null>(null);

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
  const simPausedForCompletionRef = useRef<boolean>(false);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    voiceRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    saveBool(ROUTE_VISIBLE_KEY, routeVisible);
  }, [routeVisible]);

  useEffect(() => {
    saveBool(STOPS_PANEL_KEY, stopsOpen);
  }, [stopsOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SIM_SPEED_KEY, String(simSpeedKmh));
    } catch {}
  }, [simSpeedKmh]);

  useEffect(() => {
    saveBool(COURSE_UP_KEY, courseUp);
  }, [courseUp]);

  // Smooth heading: lerp toward the new GPS heading by 25% each update,
  // and shortcut when the angular delta is large (>90°) so a hard turn
  // doesn't take 2 seconds to register.
  useEffect(() => {
    const h = position?.heading;
    if (h == null || !Number.isFinite(h)) return;
    setSmoothedHeading((prev) => {
      if (prev == null) return h;
      let delta = ((h - prev + 540) % 360) - 180;
      if (Math.abs(delta) > 90) return h;
      return (prev + delta * 0.3 + 360) % 360;
    });
  }, [position?.heading]);

  // When the simulator is first enabled, drop the synthetic position at depot
  // (or wherever the real GPS last was, if we have a fix) so that the route
  // builder has somewhere to start from.
  useEffect(() => {
    if (!simEnabled) {
      setSimRunning(false);
      return;
    }
    if (simPosition) return;
    const seed = realGeo.position
      ? { lat: realGeo.position.lat, lng: realGeo.position.lng }
      : { lat: depot.lat, lng: depot.lng };
    setSimPosition({
      lat: seed.lat,
      lng: seed.lng,
      accuracy: 5,
      heading: null,
      speed: 0,
      timestamp: Date.now(),
    });
  }, [simEnabled, depot.lat, depot.lng, realGeo.position, simPosition]);

  // Build initial delivery route as soon as GPS is available and we have stops.
  useEffect(() => {
    if (!position) return;
    if (mode !== "driving") return;
    if (pending.length === 0) return;
    if (routeRequest && routeRequest.kind === "delivery") {
      // Rebuild whenever the SET of pending stops changed (added, removed,
      // or reordered). Removing a stop happens after every "✓ доставлено",
      // and we want a fresh route from the current GPS to the remaining
      // stops — otherwise the leftover original geometry shows a confusing
      // blue line passing through the just-completed point.
      const same =
        routeRequest.stopIds.length === pending.length &&
        routeRequest.stopIds.every((id, i) => id === pending[i]?.id);
      if (same) return;
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

  // Announce route built once + persist into the wave snapshot
  useEffect(() => {
    if (!route.route || !routeRequest) return;
    const id = `${routeRequest.builtAt}:${routeRequest.kind}`;
    if (lastBuiltRouteIdRef.current === id) return;
    lastBuiltRouteIdRef.current = id;
    if (routeRequest.kind === "delivery" && pending.length > 0) {
      if (route.route.source === "straight") {
        announceOfflineFallbackRoute(voiceRef.current);
      } else {
        announceRouteBuilt(
          voiceRef.current,
          route.route.distance / 1000,
          route.route.duration,
          pending.length,
        );
      }
      onSaveDeliveryRoute?.(
        route.route.geometry,
        route.route.distance,
        route.route.duration,
      );
    } else if (routeRequest.kind === "return") {
      if (route.route.source === "straight") {
        announceOfflineFallbackRoute(voiceRef.current);
      }
      onSaveReturnRoute?.(
        route.route.geometry,
        route.route.distance,
        route.route.duration,
      );
    }
    announcerRef.current.reset();
    stopAnnouncerRef.current.reset();
    lastSegmentRef.current = undefined;
    arrivalAnnouncedRef.current = false;
    arrivalTriggeredRef.current = null;
  }, [route.route, routeRequest?.builtAt, routeRequest?.kind, pending.length, onSaveDeliveryRoute, onSaveReturnRoute]);

  const routeIndex = useMemo(() => {
    if (!route.route) return null;
    return buildRouteIndex(route.route);
  }, [route.route]);

  // ----------------------------------------------------------------
  // GPS simulator: advance synthetic position along the active route
  // ----------------------------------------------------------------
  const simDistRef = useRef<number>(0);
  const simBuiltAtRef = useRef<number>(0);

  // Reset traveled distance when the route is rebuilt — the new geometry
  // always starts from the current position, so distFromStart=0.
  useEffect(() => {
    if (!routeRequest) return;
    if (routeRequest.builtAt !== simBuiltAtRef.current) {
      simBuiltAtRef.current = routeRequest.builtAt;
      simDistRef.current = 0;
      // If we paused for a stop completion, auto-restart the sim now that
      // the new route geometry is ready.
      if (simEnabled && simPausedForCompletionRef.current) {
        simPausedForCompletionRef.current = false;
        setSimRunning(true);
      }
    }
  }, [routeRequest?.builtAt, simEnabled]);

  // When a stop arrival is confirmed (completing dialog appears) in sim mode,
  // pause the sim so it doesn't keep dragging the blue line past the stop.
  useEffect(() => {
    if (!simEnabled) return;
    if (completing) {
      simPausedForCompletionRef.current = true;
      setSimRunning(false);
    }
  }, [simEnabled, completing?.id]);

  // When mode switches to "returning" and the sim is enabled, auto-start
  // so the driver doesn't have to press ▶ again for the depot leg.
  useEffect(() => {
    if (!simEnabled) return;
    if (routeRequest?.kind !== "return") return;
    simPausedForCompletionRef.current = false;
    setSimRunning(true);
  }, [simEnabled, routeRequest?.kind]);

  useEffect(() => {
    if (!simEnabled || !simRunning) return;
    if (!routeIndex || routeIndex.geometry.length < 2) return;
    const speedMps = Math.max(0.5, simSpeedKmh / 3.6);
    const tick = () => {
      const idx = routeIndex;
      const stepM = speedMps * (SIM_TICK_MS / 1000);
      const nextDist = Math.min(idx.totalLength, simDistRef.current + stepM);
      simDistRef.current = nextDist;
      // Find segment whose cum range contains nextDist
      let segI = 0;
      while (
        segI < idx.cumLengths.length - 2 &&
        idx.cumLengths[segI + 1] < nextDist
      ) {
        segI += 1;
      }
      const segLen = idx.segLengths[segI] || 1;
      const t = Math.max(0, Math.min(1, (nextDist - idx.cumLengths[segI]) / segLen));
      const a = idx.geometry[segI];
      const b = idx.geometry[segI + 1] ?? a;
      const lat = a[0] + (b[0] - a[0]) * t;
      const lng = a[1] + (b[1] - a[1]) * t;
      const heading = bearingDeg(
        { lat: a[0], lng: a[1] },
        { lat: b[0], lng: b[1] },
      );
      setSimPosition({
        lat,
        lng,
        accuracy: 5,
        heading: Number.isFinite(heading) ? heading : null,
        speed: speedMps,
        timestamp: Date.now(),
      });
      // Auto-pause once the synthetic driver hits the very end of the route —
      // the existing arrival/finish handlers below will pick it up.
      if (nextDist >= idx.totalLength - 0.5) {
        setSimRunning(false);
      }
    };
    const id = window.setInterval(tick, SIM_TICK_MS);
    return () => window.clearInterval(id);
  }, [simEnabled, simRunning, routeIndex, simSpeedKmh, routeRequest?.builtAt]);

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

  // Maneuvers for upcoming portion only. Show only the next 2 MEANINGFUL
  // turns — straight-throughs, departures and arrivals are skipped because
  // they read as noisy random arrows on the map ("the arrows look like they
  // show wrong direction" feedback).
  const MEANINGFUL_TYPES = useMemo(
    () =>
      new Set([
        "turn",
        "merge",
        "fork",
        "end of road",
        "on ramp",
        "off ramp",
        "roundabout",
        "rotary",
        "exit roundabout",
        "exit rotary",
        "roundabout turn",
      ]),
    [],
  );
  const maneuvers: ManeuverMarker[] | null = useMemo(() => {
    if (!routeIndex || !routeIndex.steps.length) return null;
    const startIdx = progress?.currentStepIndex ?? 0;
    const out: ManeuverMarker[] = [];
    for (let i = startIdx; i < routeIndex.steps.length && out.length < 2; i += 1) {
      const s = routeIndex.steps[i];
      if (!MEANINGFUL_TYPES.has(s.maneuver.type)) continue;
      const mod = s.maneuver.modifier;
      if (s.maneuver.type === "turn" && mod === "straight") continue;
      out.push({
        lat: s.maneuver.location[0],
        lng: s.maneuver.location[1],
        arrow: maneuverArrow(s),
      });
    }
    return out;
  }, [routeIndex, progress?.currentStepIndex, MEANINGFUL_TYPES]);

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
        onFinishWave?.();
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
      // Snapshot the address BEFORE we mutate `pending` so the toast can
      // show "↻ отменить — ул. Восстания, 1" even after the stop is gone.
      const wasLast = pending.length === 1 && pending[0].id === id;
      const snap = wasLast
        ? {
            stopId: id,
            amount,
            address: pending[0]?.address,
            expireAt: Date.now() + UNDO_WINDOW_MS,
          }
        : null;
      onCompleteStop(id, amount);
      announceStopDelivered(voiceRef.current, Math.max(0, pending.length - 1));
      setCompleting(null);
      arrivalAnnouncedRef.current = false;
      arrivalTriggeredRef.current = null;
      if (snap) setLastCompleted(snap);
    },
    [completing, onCompleteStop, pending],
  );

  // Auto-submit the completion modal when the simulator drove us to a stop.
  // We use the preset rate (per-order rate from the job, or the stop's price);
  // if neither is set, we fall back to ₽100 so the dry-run still flows.
  useEffect(() => {
    if (!simEnabled || !completing) return;
    const stop = pending.find((p) => p.id === completing.id);
    if (!stop) return;
    const stopJob = jobs.find((j) => j.id === stop.jobId);
    const presetRate =
      stopJob?.perOrderRateRub ?? stop.priceRub ?? 100;
    const handle = window.setTimeout(() => {
      finishCompletion(completing.id, presetRate);
    }, SIM_AUTOCOMPLETE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [simEnabled, completing, pending, jobs, finishCompletion]);

  // Lightweight 1Hz tick while the undo toast is visible — drives the
  // countdown text and auto-dismiss.
  useEffect(() => {
    if (!lastCompleted) return;
    const id = window.setInterval(() => {
      if (Date.now() >= lastCompleted.expireAt) {
        setLastCompleted(null);
      } else {
        forceTick((n) => n + 1);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [lastCompleted]);

  const handleUndoLast = useCallback(() => {
    if (!lastCompleted) return;
    onUndoCompleteStop?.(lastCompleted.stopId);
    // Force a fresh delivery route. Setting mode back to driving lets the
    // route-rebuild useEffect rerun (it gates on mode === "driving").
    setMode("driving");
    arrivalAnnouncedRef.current = false;
    arrivalTriggeredRef.current = null;
    announcerRef.current.reset();
    stopAnnouncerRef.current.reset();
    finishAnnouncedRef.current = false;
    announceStopUndone(voiceRef.current);
    setLastCompleted(null);
  }, [lastCompleted, onUndoCompleteStop]);

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
      <div className="shrink-0 h-11 px-2 flex items-center justify-between border-b border-border bg-card gap-1.5">
        <button
          onClick={onExit}
          className="h-8 px-2.5 rounded-md border border-border text-[10px] font-medium uppercase tracking-[0.18em] hover:bg-muted transition-colors"
        >
          ← выйти
        </button>
        <div className="flex flex-col items-center min-w-0 leading-none">
          <div className="text-[8px] uppercase tracking-[0.22em] text-muted-foreground truncate">
            {mode === "driving"
              ? "вождение"
              : mode === "returning"
                ? "→ депо"
                : "готово"}
          </div>
          <div className="text-[13px] font-semibold tabular-nums truncate mt-0.5">
            {mode === "driving" && totalStops > 0
              ? `${stopNumber} / ${totalStops}`
              : mode === "returning"
                ? "возврат"
                : "✓"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCourseUp((v) => !v)}
            className={cn(
              "h-8 w-8 rounded-md border text-[13px] transition-colors flex items-center justify-center",
              courseUp
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
            title={courseUp ? "Карта по курсу — выкл" : "Карта по курсу — вкл"}
          >
            {courseUp ? "↥" : "N"}
          </button>
          <button
            onClick={() => setRouteVisible((v) => !v)}
            className={cn(
              "h-8 w-8 rounded-md border text-[13px] transition-colors flex items-center justify-center",
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
              "h-8 w-8 rounded-md border text-[13px] transition-colors flex items-center justify-center",
              muted
                ? "border-border text-muted-foreground hover:bg-muted"
                : "border-primary bg-primary/10 text-foreground",
            )}
            title={muted ? "Голос выключен" : "Голос включён"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <button
            onClick={() => {
              if (!simEnabled) {
                setSimEnabled(true);
                setSimPanelOpen(true);
              } else {
                setSimPanelOpen((v) => !v);
              }
            }}
            className={cn(
              "h-10 w-auto px-2 rounded-md border text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center justify-center",
              simEnabled
                ? "border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
            title={simEnabled ? "Симулятор GPS включён" : "Симулятор GPS"}
          >
            {simEnabled ? `СИМ ${simSpeedKmh}` : "СИМ"}
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

      {/* Arrival banner — replaces the maneuver card the moment we trigger
          arrival, so the courier sees a big unmistakable "ВЫ ПРИБЫЛИ" instead
          of stale turn instructions while the completion modal is up. */}
      {completing && mode === "driving" && active && (
        <div className="shrink-0 px-3 pt-2">
          <div className="rounded-lg border-2 border-emerald-500 bg-emerald-500/15 px-3 py-2 flex items-center gap-3">
            <div className="shrink-0 w-10 h-10 rounded-md bg-emerald-500 text-white flex items-center justify-center text-[22px] font-bold leading-none">
              ✓
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[9px] uppercase tracking-[0.25em] text-emerald-700 dark:text-emerald-400 font-semibold">
                вы прибыли
              </div>
              <div className="text-[15px] font-semibold leading-tight truncate">
                {active.address || "к точке доставки"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Maneuver card */}
      {currentStep && mode !== "finished" && !completing && (
        <div className="shrink-0 px-3 pt-2">
          <div
            className={cn(
              "rounded-lg border bg-card px-2.5 py-2 flex items-center gap-2.5 transition-all",
              maneuverUrgency === "near"
                ? "border-red-500/70 ring-1 ring-red-500/30"
                : maneuverUrgency === "mid"
                  ? "border-amber-500/60"
                  : "border-border",
            )}
          >
            <div
              className={cn(
                "shrink-0 w-11 h-11 rounded-md flex items-center justify-center text-[24px] leading-none font-bold",
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
              <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground leading-none">
                {currentStep.maneuver.type === "arrive"
                  ? mode === "returning"
                    ? "прибытие в депо"
                    : "прибытие к точке"
                  : "манёвр"}
              </div>
              <div className="text-[16px] font-semibold leading-tight truncate mt-0.5">
                {instruction || (currentStep.name || "продолжайте")}
              </div>
              {nextStep && (
                <div className="text-[10px] text-muted-foreground truncate leading-none mt-0.5">
                  потом · {maneuverInstruction(nextStep).toLowerCase()}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground leading-none">
                через
              </div>
              <div
                className={cn(
                  "text-[20px] font-semibold tabular-nums leading-tight mt-0.5",
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
        {layerMode === "3d" ? (
          // 3D POV mode: MapLibre with the chase camera enabled while we
          // have a GPS fix (high pitch + course-up bearing), the active
          // stop fed in as `selectedId` so its building extrudes in
          // bright orange, and the current route shown as the "pending"
          // line. We don't pass `onMapReady` here because zoom buttons
          // below already early-return for 3D.
          <Map3D
            deliveries={[]}
            pending={pending}
            jobs={jobs}
            theme={theme}
            depot={depot}
            userPosition={position}
            followUser={!!position}
            selectedId={active?.id ?? null}
            showRoute={false}
            showPendingRoute={true}
            pendingRouteGeometry={route.route?.geometry ?? null}
          />
        ) : (
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
            autoZoomBack={!!position}
            onMapReady={(m) => { mapRef.current = m; }}
            layerMode={layerMode}
            bearing={
              courseUp && (mode === "driving" || mode === "returning")
                ? smoothedHeading
                : null
            }
          />
        )}
        {/* Zoom + layer buttons */}
        <div className="absolute bottom-16 left-3 z-[1200] flex flex-col gap-1.5 pointer-events-auto">
          {onLayerChange && (
            <button
              onClick={() => {
                const order: MapLayerMode[] = ["default", "detail", "satellite", "3d"];
                const idx = order.indexOf(layerMode);
                const next = order[(idx + 1) % order.length];
                onLayerChange(next);
              }}
              className={cn(
                "w-9 h-9 rounded-md border border-border bg-card/95 backdrop-blur text-[14px] flex items-center justify-center shadow-md hover:bg-muted transition-colors font-bold",
                layerMode === "3d" && "bg-blue-600 text-white border-blue-600",
              )}
              title={
                layerMode === "default"
                  ? "Стиль: карта"
                  : layerMode === "detail"
                    ? "Стиль: детальная OSM"
                    : layerMode === "satellite"
                      ? "Стиль: спутник"
                      : "Стиль: 3D POV"
              }
            >
              {layerMode === "default"
                ? "🗺"
                : layerMode === "detail"
                  ? "🏙"
                  : layerMode === "satellite"
                    ? "🛰"
                    : "3D"}
            </button>
          )}
          <button
            onClick={() => mapRef.current?.zoomIn()}
            className="w-9 h-9 rounded-md border border-border bg-card/95 backdrop-blur text-[18px] font-bold flex items-center justify-center shadow-md hover:bg-muted transition-colors leading-none"
            title="Приблизить"
          >+</button>
          <button
            onClick={() => mapRef.current?.zoomOut()}
            className="w-9 h-9 rounded-md border border-border bg-card/95 backdrop-blur text-[18px] font-bold flex items-center justify-center shadow-md hover:bg-muted transition-colors leading-none"
            title="Отдалить"
          >−</button>
        </div>

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
                onFinishWave?.();
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

      {/* GPS simulator panel — floating, bottom-left */}
      {simEnabled && simPanelOpen && (
        <div className="absolute bottom-24 left-3 z-[2050] w-[200px] rounded-lg border border-amber-500/60 bg-card/95 backdrop-blur p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-600 dark:text-amber-400">
              ⚠ симулятор
            </div>
            <button
              onClick={() => setSimPanelOpen(false)}
              className="text-muted-foreground hover:text-foreground text-[14px] leading-none"
              title="Скрыть панель"
            >
              ×
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1 mb-2">
            {SIM_SPEED_PRESETS.map((s) => (
              <button
                key={s}
                onClick={() => setSimSpeedKmh(s)}
                className={cn(
                  "h-8 rounded text-[10px] font-semibold tabular-nums transition-colors",
                  simSpeedKmh === s
                    ? "bg-amber-500 text-white"
                    : "border border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => setSimRunning((r) => !r)}
              disabled={!routeIndex}
              className={cn(
                "flex-1 h-9 rounded text-[11px] font-bold uppercase tracking-wider transition-colors",
                simRunning
                  ? "bg-amber-500 text-white"
                  : "border border-amber-500 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10",
                !routeIndex && "opacity-40 cursor-not-allowed",
              )}
              title={routeIndex ? "" : "Дождитесь построения маршрута"}
            >
              {simRunning ? "⏸ пауза" : "▶ старт"}
            </button>
            <button
              onClick={() => {
                setSimRunning(false);
                setSimEnabled(false);
                setSimPanelOpen(false);
                setSimPosition(null);
                simDistRef.current = 0;
              }}
              className="h-9 px-2 rounded border border-border text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted transition-colors"
              title="Выключить симулятор и вернуться к реальному GPS"
            >
              GPS
            </button>
          </div>
          <div className="mt-2 text-[9px] text-muted-foreground tabular-nums leading-tight">
            {simSpeedKmh} км/ч · {Math.round(simDistRef.current)} м
          </div>
        </div>
      )}

      {/* Undo toast — appears for 5s after the LAST "✓ доставлено" tap */}
      {lastCompleted && (() => {
        const remaining = Math.max(
          0,
          Math.ceil((lastCompleted.expireAt - Date.now()) / 1000),
        );
        return (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-[2100] flex items-center gap-3 px-4 py-3 rounded-xl border border-primary/60 bg-card shadow-2xl">
            <div className="flex flex-col">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                волна закрыта
              </div>
              <div className="text-[12px] font-semibold truncate max-w-[180px]">
                {lastCompleted.address || "последняя точка"} · {lastCompleted.amount}₽
              </div>
            </div>
            <button
              onClick={handleUndoLast}
              className="h-11 px-4 rounded-lg bg-primary text-primary-foreground text-[12px] font-bold uppercase tracking-wider hover:bg-primary/90 transition-colors tabular-nums"
            >
              ↻ отменить ({remaining})
            </button>
          </div>
        );
      })()}
    </div>
  );
}

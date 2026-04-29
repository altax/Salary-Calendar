import { useEffect, useMemo, useRef, useState } from "react";
import {
  YandexPanoramaViewer,
  type GroundDot,
  type GroundPin,
} from "@/components/YandexPanoramaViewer";
import {
  fetchPanoByPoint,
  type LoadedPano,
} from "@/lib/yandex-pano";
import {
  bearingDeg,
  distanceM,
  type LatLng,
  type RouteIndex,
  type RouteProgress,
} from "@/lib/route-progress";
import type { Depot } from "@/lib/store";
import type { PendingOrder } from "@/lib/deliveries";

type Props = {
  /** Live GPS / simulator position. */
  position: LatLng | null;
  /** Active route polyline + index. */
  routeIndex: RouteIndex | null;
  /** Progress along the route (segment, projection, etc). */
  progress: RouteProgress | null;
  /** All pending stops in visit order; first is the active one. */
  pending: PendingOrder[];
  /** Depot, drawn as a violet pin in returning mode. */
  depot: Depot;
  /** True when we're returning to depot (no pending stops). */
  returning: boolean;
};

// Refresh the panorama only when the courier has moved this much from
// the centre of the currently displayed pano. Lower → more loads, more
// "smooth" walking; higher → fewer loads but longer stale image.
const REFRESH_DISTANCE_M = 18;

// How far ahead along the route to sample for the ground trail.
const TRAIL_LOOKAHEAD_M = 120;

// Maximum number of dots to draw on the trail. We sub-sample more
// densely near the camera and sparser further away.
const MAX_TRAIL_DOTS = 28;

/**
 * "Windshield camera" view used inside DriveMode. Loads the Yandex
 * panorama at the courier's current GPS, orients the camera along the
 * direction of travel, and paints the route the courier should follow
 * as a yellow trail of dots on the asphalt with a tall pin at the next
 * delivery / depot.
 *
 * Whenever the (real or simulated) GPS moves more than REFRESH_DISTANCE_M
 * away from the centre of the displayed panorama, we transparently swap
 * to a fresh panorama at the new location.
 */
export default function DriveModePanorama({
  position,
  routeIndex,
  progress,
  pending,
  depot,
  returning,
}: Props) {
  const [pano, setPano] = useState<LoadedPano | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "no-imagery" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Anchor we used for the last successful pano fetch — used to decide
  // whether we've drifted far enough to refetch.
  const lastFetchedAt = useRef<LatLng | null>(null);
  // The latest position requested. We keep one in flight at a time.
  const inflight = useRef<Promise<unknown> | null>(null);

  // Decide if we should kick off a refetch. Runs whenever position changes.
  useEffect(() => {
    if (!position) return;
    if (inflight.current) return;
    if (
      pano &&
      lastFetchedAt.current &&
      distanceM(position, lastFetchedAt.current) < REFRESH_DISTANCE_M
    ) {
      return;
    }
    setStatus("loading");
    const target = { lat: position.lat, lng: position.lng };
    const p = fetchPanoByPoint({ lng: target.lng, lat: target.lat })
      .then((next) => {
        if (!next) {
          // No imagery here — keep showing the old pano (if any) and
          // mark status so the overlay can hint the user.
          setStatus("no-imagery");
          // Still treat this point as "tried" so we don't hammer the
          // API every tick when courier is in a panorama-less area.
          lastFetchedAt.current = target;
          return;
        }
        // Yandex returns the nearest pano to the point; remember THAT
        // location as our anchor so we don't refetch unless the courier
        // walks far from where the pano was actually shot.
        lastFetchedAt.current = {
          lat: next.position.lat,
          lng: next.position.lng,
        };
        setPano(next);
        setStatus("idle");
        setErrorMsg(null);
      })
      .catch((err: unknown) => {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
  }, [position?.lat, position?.lng, pano]);

  // ── Initial yaw: bearing along the route. We compute the bearing
  // from the courier's current snapped projection toward a polyline
  // vertex ~25m further along the route.
  const initialYaw = useMemo(() => {
    if (!position || !routeIndex || !progress) return undefined;
    const lookahead = pickLookaheadPoint(routeIndex, progress, 25);
    if (!lookahead) return undefined;
    return bearingDeg(progress.projection, lookahead);
  }, [position?.lat, position?.lng, routeIndex, progress?.segmentIndex, progress?.distanceFromStartM]);

  // ── Ground trail and pin geometry, computed relative to the current
  // panorama centre (NOT the GPS position — these can differ by a few
  // metres because Yandex snaps to the nearest captured pano).
  const { dots, pins } = useMemo(() => {
    if (!pano) return { dots: [] as GroundDot[], pins: [] as GroundPin[] };
    const center: LatLng = { lat: pano.position.lat, lng: pano.position.lng };
    const dotsOut: GroundDot[] = [];

    if (routeIndex && progress) {
      const trail = sampleTrailAhead(
        routeIndex,
        progress,
        TRAIL_LOOKAHEAD_M,
        MAX_TRAIL_DOTS,
      );
      for (const pt of trail) {
        const d = distanceM(center, pt);
        if (d < 1.5 || d > 100) continue;
        dotsOut.push({
          bearingDeg: bearingDeg(center, pt),
          distanceM: d,
          color: "#ffd400",
          sizeM: 0.8,
        });
      }
    }

    const pinsOut: GroundPin[] = [];
    if (returning) {
      const target: LatLng = { lat: depot.lat, lng: depot.lng };
      const d = distanceM(center, target);
      if (d <= 100 && d > 1) {
        pinsOut.push({
          bearingDeg: bearingDeg(center, target),
          distanceM: d,
          color: "#a855f7",
          heightM: 5,
          label: "депо",
        });
      }
    } else if (pending[0]) {
      const target: LatLng = { lat: pending[0].lat, lng: pending[0].lng };
      const d = distanceM(center, target);
      if (d <= 100 && d > 1) {
        pinsOut.push({
          bearingDeg: bearingDeg(center, target),
          distanceM: d,
          color: "#22c55e",
          heightM: 5,
          label: "следующая",
        });
      }
    }

    return { dots: dotsOut, pins: pinsOut };
  }, [
    pano?.imageId,
    pano?.position.lat,
    pano?.position.lng,
    routeIndex,
    progress?.segmentIndex,
    progress?.distanceFromStartM,
    returning,
    depot.lat,
    depot.lng,
    pending,
  ]);

  if (!pano && status === "loading") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black text-foreground/70">
        <div className="text-[11px] uppercase tracking-[0.2em] animate-pulse">
          ищу панораму…
        </div>
      </div>
    );
  }

  if (!pano && status === "no-imagery") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-center px-6">
        <div className="text-sm uppercase tracking-[0.2em] text-yellow-300">
          нет панорамы в этой точке
        </div>
        <div className="mt-2 text-[11px] text-foreground/60 max-w-md">
          Здесь Яндекс не снимал улицу. Переключись на карту, либо подойди ближе к
          проезжей части — панорама подгрузится автоматически.
        </div>
      </div>
    );
  }

  if (!pano && status === "error") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-center px-6">
        <div className="text-sm uppercase tracking-[0.2em] text-red-400">
          ошибка панорамы
        </div>
        <div className="mt-2 text-[11px] text-foreground/70 max-w-md font-mono break-all">
          {errorMsg}
        </div>
      </div>
    );
  }

  if (!pano) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black text-foreground/70">
        <div className="text-[11px] uppercase tracking-[0.2em]">
          ждём GPS…
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <YandexPanoramaViewer
        pano={pano}
        onNavigate={(next) => {
          // In drive mode the user shouldn't normally click arrows
          // (we hide them anyway). If something forces a manual jump,
          // accept it as the new anchor.
          lastFetchedAt.current = {
            lat: next.position.lat,
            lng: next.position.lng,
          };
          setPano(next);
        }}
        onError={(msg) => setErrorMsg(msg)}
        initialYawDegrees={initialYaw}
        routeDots={dots}
        pins={pins}
        showThoroughfareArrows={false}
      />
      {status === "no-imagery" && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-yellow-500/15 border border-yellow-500/40 text-[10px] uppercase tracking-[0.18em] text-yellow-200 pointer-events-none">
          нет свежей панорамы — двигайся к улице
        </div>
      )}
    </div>
  );
}

/**
 * Walk along the polyline starting from the courier's projection and
 * collect points at roughly even spacing for `maxDist` metres ahead.
 * The returned points are in route-coordinate order (closest first).
 */
function sampleTrailAhead(
  index: RouteIndex,
  progress: RouteProgress,
  maxDist: number,
  maxPoints: number,
): LatLng[] {
  const out: LatLng[] = [];
  const geometry = index.geometry;
  if (geometry.length < 2) return out;
  // Step distance in metres between sampled trail dots. We make the
  // first few dots closer together so the trail blooms out from under
  // the camera, and stretch them out further away.
  const stepFor = (i: number) => {
    if (i < 4) return 2;
    if (i < 8) return 4;
    return 8;
  };

  // Start from the projection point itself.
  let segI = progress.segmentIndex;
  let cum = 0;

  let stepIdx = 0;
  let target = stepFor(stepIdx);

  let cursor: LatLng = progress.projection;
  let cursorRemaining = distanceM(cursor, {
    lat: geometry[segI + 1]?.[0] ?? cursor.lat,
    lng: geometry[segI + 1]?.[1] ?? cursor.lng,
  });
  let segEnd: LatLng = {
    lat: geometry[segI + 1]?.[0] ?? cursor.lat,
    lng: geometry[segI + 1]?.[1] ?? cursor.lng,
  };

  while (cum < maxDist && out.length < maxPoints) {
    if (cursorRemaining >= target) {
      // Interpolate `target` metres along the current segment.
      const f = target / Math.max(1e-6, cursorRemaining);
      const next: LatLng = {
        lat: cursor.lat + (segEnd.lat - cursor.lat) * f,
        lng: cursor.lng + (segEnd.lng - cursor.lng) * f,
      };
      out.push(next);
      cum += target;
      cursor = next;
      cursorRemaining = distanceM(cursor, segEnd);
      stepIdx += 1;
      target = stepFor(stepIdx);
    } else {
      // Step over to next segment.
      cum += cursorRemaining;
      segI += 1;
      if (segI >= geometry.length - 1) break;
      cursor = segEnd;
      segEnd = {
        lat: geometry[segI + 1][0],
        lng: geometry[segI + 1][1],
      };
      cursorRemaining = distanceM(cursor, segEnd);
    }
  }
  return out;
}

/**
 * Find a polyline point ~`distAhead` metres along the route past the
 * current projection. Used to set the initial camera bearing.
 */
function pickLookaheadPoint(
  index: RouteIndex,
  progress: RouteProgress,
  distAhead: number,
): LatLng | null {
  const geometry = index.geometry;
  if (geometry.length < 2) return null;
  let cursor: LatLng = progress.projection;
  let segI = progress.segmentIndex;
  let remaining = distAhead;
  while (remaining > 0 && segI < geometry.length - 1) {
    const segEnd: LatLng = {
      lat: geometry[segI + 1][0],
      lng: geometry[segI + 1][1],
    };
    const segDist = distanceM(cursor, segEnd);
    if (segDist >= remaining) {
      const f = remaining / Math.max(1e-6, segDist);
      return {
        lat: cursor.lat + (segEnd.lat - cursor.lat) * f,
        lng: cursor.lng + (segEnd.lng - cursor.lng) * f,
      };
    }
    remaining -= segDist;
    cursor = segEnd;
    segI += 1;
  }
  return cursor;
}

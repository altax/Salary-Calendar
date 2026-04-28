import type { RouteResult, RouteStep } from "@/lib/routing";

export type LatLng = { lat: number; lng: number };

export type RouteProgress = {
  segmentIndex: number;
  projection: LatLng;
  distanceFromStartM: number;
  distanceToEndM: number;
  offRouteM: number;
  currentStepIndex: number;
  currentStep: RouteStep | null;
  nextStep: RouteStep | null;
  distanceToNextManeuverM: number;
  bearingDeg: number | null;
};

const EARTH_R = 6371000;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const λ1 = toRad(a.lng);
  const λ2 = toRad(b.lng);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function projectToSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { point: LatLng; t: number; distM: number } {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(meanLat);
  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;
  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const dxp = px - projX;
  const dyp = py - projY;
  const distM = Math.sqrt(dxp * dxp + dyp * dyp);
  const point: LatLng = {
    lat: a.lat + (projY / mPerDegLat),
    lng: a.lng + (projX / mPerDegLng),
  };
  return { point, t, distM };
}

export function buildSegmentLengths(geometry: [number, number][]): number[] {
  const out: number[] = [];
  for (let i = 1; i < geometry.length; i += 1) {
    out.push(
      distanceM(
        { lat: geometry[i - 1][0], lng: geometry[i - 1][1] },
        { lat: geometry[i][0], lng: geometry[i][1] },
      ),
    );
  }
  return out;
}

export type RouteIndex = {
  geometry: [number, number][];
  segLengths: number[];
  cumLengths: number[];
  totalLength: number;
  steps: RouteStep[];
  stepEntryDistances: number[];
  legCount: number;
  legCumDistances: number[];
  legVertexStart: number[];
  legVertexEnd: number[];
  legDurations: number[];
  legDistances: number[];
};

export function buildRouteIndex(route: RouteResult): RouteIndex {
  const geometry = route.geometry;
  const segLengths = buildSegmentLengths(geometry);
  const cumLengths: number[] = [0];
  for (let i = 0; i < segLengths.length; i += 1) {
    cumLengths.push(cumLengths[i] + segLengths[i]);
  }
  const totalLength = cumLengths[cumLengths.length - 1] ?? 0;
  const steps: RouteStep[] = [];
  for (const leg of route.legs) for (const s of leg.steps) steps.push(s);
  const stepEntryDistances: number[] = [];
  let acc = 0;
  for (const s of steps) {
    stepEntryDistances.push(acc);
    acc += s.distance;
  }

  const legCount = route.legs.length;
  const legCumDistances: number[] = [0];
  const legDistances: number[] = [];
  const legDurations: number[] = [];
  for (const leg of route.legs) {
    legDistances.push(leg.distance);
    legDurations.push(leg.duration);
    legCumDistances.push(legCumDistances[legCumDistances.length - 1] + leg.distance);
  }

  const legVertexStart: number[] = [0];
  for (let li = 1; li < legCumDistances.length; li += 1) {
    let i = legVertexStart[li - 1];
    while (i < cumLengths.length - 1 && cumLengths[i] < legCumDistances[li]) i += 1;
    legVertexStart.push(i);
  }
  const legVertexEnd: number[] = [];
  for (let li = 0; li < legCount; li += 1) {
    legVertexEnd.push(legVertexStart[li + 1] ?? geometry.length - 1);
  }

  return {
    geometry,
    segLengths,
    cumLengths,
    totalLength,
    steps,
    stepEntryDistances,
    legCount,
    legCumDistances,
    legVertexStart,
    legVertexEnd,
    legDurations,
    legDistances,
  };
}

export function getLegGeometry(
  index: RouteIndex,
  legIndex: number,
): [number, number][] {
  if (legIndex < 0 || legIndex >= index.legCount) return [];
  const start = index.legVertexStart[legIndex];
  const end = index.legVertexEnd[legIndex];
  return index.geometry.slice(start, end + 1);
}

export function currentLegIndex(index: RouteIndex, distFromStartM: number): number {
  for (let i = index.legCount - 1; i >= 0; i -= 1) {
    if (distFromStartM + 0.5 >= index.legCumDistances[i]) return i;
  }
  return 0;
}

export function legSliceFromProjection(
  index: RouteIndex,
  legIndex: number,
  segmentIndex: number,
  projection: LatLng,
): [number, number][] {
  if (legIndex < 0 || legIndex >= index.legCount) return [];
  const legEnd = index.legVertexEnd[legIndex];
  const legStart = index.legVertexStart[legIndex];
  if (segmentIndex < legStart) {
    return getLegGeometry(index, legIndex);
  }
  if (segmentIndex >= legEnd) {
    return [
      [projection.lat, projection.lng],
      index.geometry[legEnd],
    ];
  }
  const out: [number, number][] = [[projection.lat, projection.lng]];
  for (let i = segmentIndex + 1; i <= legEnd; i += 1) {
    out.push(index.geometry[i]);
  }
  return out;
}

export function computeProgress(
  index: RouteIndex,
  pos: LatLng,
  searchWindow: number = 30,
  prevSegmentIndex?: number,
): RouteProgress {
  const { geometry, segLengths, cumLengths, totalLength, steps, stepEntryDistances } =
    index;
  if (geometry.length < 2) {
    return {
      segmentIndex: 0,
      projection: pos,
      distanceFromStartM: 0,
      distanceToEndM: 0,
      offRouteM: 0,
      currentStepIndex: 0,
      currentStep: null,
      nextStep: null,
      distanceToNextManeuverM: 0,
      bearingDeg: null,
    };
  }
  const start = Math.max(0, (prevSegmentIndex ?? 0) - 1);
  const end = Math.min(
    segLengths.length,
    prevSegmentIndex != null
      ? Math.min(segLengths.length, prevSegmentIndex + searchWindow)
      : segLengths.length,
  );
  let bestI = start;
  let bestDist = Infinity;
  let bestT = 0;
  let bestPoint: LatLng = { lat: geometry[start][0], lng: geometry[start][1] };
  for (let i = start; i < end; i += 1) {
    const a: LatLng = { lat: geometry[i][0], lng: geometry[i][1] };
    const b: LatLng = { lat: geometry[i + 1][0], lng: geometry[i + 1][1] };
    const r = projectToSegment(pos, a, b);
    if (r.distM < bestDist) {
      bestDist = r.distM;
      bestI = i;
      bestT = r.t;
      bestPoint = r.point;
    }
  }
  if (prevSegmentIndex != null && bestDist > 80) {
    bestI = 0;
    bestDist = Infinity;
    for (let i = 0; i < segLengths.length; i += 1) {
      const a: LatLng = { lat: geometry[i][0], lng: geometry[i][1] };
      const b: LatLng = { lat: geometry[i + 1][0], lng: geometry[i + 1][1] };
      const r = projectToSegment(pos, a, b);
      if (r.distM < bestDist) {
        bestDist = r.distM;
        bestI = i;
        bestT = r.t;
        bestPoint = r.point;
      }
    }
  }
  const distFromStart = cumLengths[bestI] + bestT * segLengths[bestI];
  const distToEnd = Math.max(0, totalLength - distFromStart);

  let stepIdx = 0;
  for (let i = stepEntryDistances.length - 1; i >= 0; i -= 1) {
    if (distFromStart + 1 >= stepEntryDistances[i]) {
      stepIdx = i;
      break;
    }
  }
  const cur = steps[stepIdx] ?? null;
  const nxt = steps[stepIdx + 1] ?? null;
  const stepEnd = (stepEntryDistances[stepIdx] ?? 0) + (cur?.distance ?? 0);
  const distToNextManeuver = Math.max(0, stepEnd - distFromStart);

  const a = geometry[bestI];
  const b = geometry[bestI + 1];
  const heading = bearingDeg(
    { lat: a[0], lng: a[1] },
    { lat: b[0], lng: b[1] },
  );

  return {
    segmentIndex: bestI,
    projection: bestPoint,
    distanceFromStartM: distFromStart,
    distanceToEndM: distToEnd,
    offRouteM: bestDist,
    currentStepIndex: stepIdx,
    currentStep: cur,
    nextStep: nxt,
    distanceToNextManeuverM: distToNextManeuver,
    bearingDeg: heading,
  };
}

export function sliceGeometry(
  index: RouteIndex,
  fromSegmentIndex: number,
  fromPoint: LatLng,
): [number, number][] {
  const out: [number, number][] = [[fromPoint.lat, fromPoint.lng]];
  for (let i = fromSegmentIndex + 1; i < index.geometry.length; i += 1) {
    out.push(index.geometry[i]);
  }
  return out;
}

export function traveledGeometry(
  index: RouteIndex,
  upToSegmentIndex: number,
  upToPoint: LatLng,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= upToSegmentIndex; i += 1) out.push(index.geometry[i]);
  out.push([upToPoint.lat, upToPoint.lng]);
  return out;
}

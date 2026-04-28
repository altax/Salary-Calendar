import { haversineKm } from "@/lib/deliveries";

export type RoutePoint = {
  id: string;
  lat: number;
  lng: number;
};

export type DistFn = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;

const START_ID = "__start__";

// ─── Seeds ────────────────────────────────────────────────────────────────

export function nearestNeighborRoute<T extends RoutePoint>(
  start: { lat: number; lng: number },
  points: T[],
  dist: DistFn = haversineKm,
): T[] {
  if (points.length === 0) return [];
  const remaining = points.slice();
  const ordered: T[] = [];
  let cursor = { lat: start.lat, lng: start.lng };
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = dist(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    cursor = { lat: next.lat, lng: next.lng };
  }
  return ordered;
}

// ─── Tour cost helpers ────────────────────────────────────────────────────

// Cost of the OPEN path: depot → s1 → s2 → ... → sN. Used by legacy callers.
function openLength<T extends RoutePoint>(start: T, route: T[], dist: DistFn): number {
  if (route.length === 0) return 0;
  let s = dist(start, route[0]);
  for (let i = 1; i < route.length; i += 1) s += dist(route[i - 1], route[i]);
  return s;
}

// Cost of the CLOSED tour: depot → s1 → ... → sN → depot.
// This is what we actually do in real life — the courier returns to depot.
function closedLength<T extends RoutePoint>(start: T, route: T[], dist: DistFn): number {
  if (route.length === 0) return 0;
  return openLength(start, route, dist) + dist(route[route.length - 1], start);
}

// ─── 2-opt ────────────────────────────────────────────────────────────────
// Classic 2-opt over a CLOSED tour. We treat the depot as a fixed node at
// position 0 and never move it. Reversing any internal segment that improves
// total length (including the closing edge back to depot) is accepted.

export function twoOptImprove<T extends RoutePoint>(
  start: { lat: number; lng: number },
  route: T[],
  maxIterations = 50,
  dist: DistFn = haversineKm,
): T[] {
  if (route.length < 3) return route;
  const startNode = { id: START_ID, lat: start.lat, lng: start.lng } as T;
  // Closed cycle as an array: [depot, s1, s2, ..., sN, depot].
  let best: T[] = [startNode, ...route, startNode];
  let bestLen = totalCycle(best, dist);
  let improved = true;
  let iter = 0;
  while (improved && iter < maxIterations) {
    improved = false;
    iter += 1;
    // i ranges over inner edges (depot stays at 0 and last index).
    for (let i = 1; i < best.length - 2; i += 1) {
      for (let k = i + 1; k < best.length - 1; k += 1) {
        const next: T[] = best
          .slice(0, i)
          .concat(best.slice(i, k + 1).reverse())
          .concat(best.slice(k + 1));
        const nextLen = totalCycle(next, dist);
        if (nextLen + 1e-9 < bestLen) {
          best = next;
          bestLen = nextLen;
          improved = true;
        }
      }
    }
  }
  // Strip both depots and return only the stops.
  return best.slice(1, -1);
}

function totalCycle<T extends RoutePoint>(cycle: T[], dist: DistFn): number {
  let s = 0;
  for (let i = 1; i < cycle.length; i += 1) s += dist(cycle[i - 1], cycle[i]);
  return s;
}

// ─── Or-opt ───────────────────────────────────────────────────────────────
// Or-opt: lift a short chain of consecutive stops (length 1, 2, or 3) and
// reinsert it elsewhere in the tour. Catches moves that 2-opt misses
// (especially "this stop should be visited later in the trip").

export function orOptImprove<T extends RoutePoint>(
  start: { lat: number; lng: number },
  route: T[],
  maxIterations = 30,
  dist: DistFn = haversineKm,
): T[] {
  if (route.length < 4) return route;
  const startNode = { id: START_ID, lat: start.lat, lng: start.lng } as T;
  let best: T[] = [startNode, ...route, startNode];
  let bestLen = totalCycle(best, dist);
  let improved = true;
  let iter = 0;
  const segLens = [1, 2, 3];
  while (improved && iter < maxIterations) {
    improved = false;
    iter += 1;
    for (const segLen of segLens) {
      // i = first inner index of segment to lift.
      for (let i = 1; i + segLen <= best.length - 1; i += 1) {
        const chain = best.slice(i, i + segLen);
        const without = best.slice(0, i).concat(best.slice(i + segLen));
        // Try every reinsertion position j (between depot and depot).
        for (let j = 1; j < without.length; j += 1) {
          if (j >= i && j <= i + segLen) continue; // same place
          const candidate = without.slice(0, j).concat(chain, without.slice(j));
          const candLen = totalCycle(candidate, dist);
          if (candLen + 1e-9 < bestLen) {
            best = candidate;
            bestLen = candLen;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }
  return best.slice(1, -1);
}

// ─── Far-first orientation ────────────────────────────────────────────────
// For a CLOSED tour the reverse direction has identical total length, but
// in real e-bike delivery work it's better to start with the FARTHEST stop
// from depot — battery and energy are at peak, the return-to-depot leg at
// the end is short, and any mid-trip abort leaves you closer to depot.

export function orientFarthestFirst<T extends RoutePoint>(
  start: { lat: number; lng: number },
  route: T[],
  dist: DistFn = haversineKm,
): T[] {
  if (route.length < 2) return route;
  const startLatLng = { lat: start.lat, lng: start.lng };
  const dFirst = dist(startLatLng, route[0]);
  const dLast = dist(startLatLng, route[route.length - 1]);
  if (dLast > dFirst) return route.slice().reverse();
  return route;
}

// ─── End-to-end optimizer ────────────────────────────────────────────────
// Convenience: nearest-neighbor seed → 2-opt → or-opt → far-first.
// All distances measured by `dist` (real OSRM matrix when available, haversine
// otherwise). Returns the stops in the order they should be visited.

export function optimizeRoute<T extends RoutePoint>(
  start: { lat: number; lng: number },
  points: T[],
  dist: DistFn = haversineKm,
  options?: { maxIter?: number; farFirst?: boolean },
): T[] {
  if (points.length <= 1) return points.slice();
  const seed = nearestNeighborRoute(start, points, dist);
  const after2opt = twoOptImprove(start, seed, options?.maxIter ?? 50, dist);
  const afterOrOpt = orOptImprove(start, after2opt, options?.maxIter ?? 30, dist);
  const farFirst = options?.farFirst ?? true;
  return farFirst ? orientFarthestFirst(start, afterOrOpt, dist) : afterOrOpt;
}

export function makeMatrixDistFn(
  ids: string[],
  matrix: number[][],
  startId = START_ID,
): DistFn {
  const idx = new Map<string, number>();
  ids.forEach((id, i) => idx.set(id, i));
  return (a, b) => {
    const ai = idx.get((a as any).id ?? startId);
    const bi = idx.get((b as any).id ?? startId);
    if (ai == null || bi == null || !matrix[ai] || matrix[ai][bi] == null) {
      return haversineKm(a, b) * 1000;
    }
    return matrix[ai][bi];
  };
}

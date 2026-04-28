import { haversineKm } from "@/lib/deliveries";

export type RoutePoint = {
  id: string;
  lat: number;
  lng: number;
};

export type DistFn = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;

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

export function twoOptImprove<T extends RoutePoint>(
  start: { lat: number; lng: number },
  route: T[],
  maxIterations = 50,
  dist: DistFn = haversineKm,
): T[] {
  if (route.length < 4) return route;
  const all = [{ id: "__start__", lat: start.lat, lng: start.lng } as T, ...route];
  const totalLen = (arr: T[]) => {
    let s = 0;
    for (let i = 1; i < arr.length; i += 1) s += dist(arr[i - 1], arr[i]);
    return s;
  };
  let best = all.slice();
  let bestLen = totalLen(best);
  let improved = true;
  let iter = 0;
  while (improved && iter < maxIterations) {
    improved = false;
    iter += 1;
    for (let i = 1; i < best.length - 2; i += 1) {
      for (let k = i + 1; k < best.length - 1; k += 1) {
        const next: T[] = best
          .slice(0, i)
          .concat(best.slice(i, k + 1).reverse())
          .concat(best.slice(k + 1));
        const nextLen = totalLen(next);
        if (nextLen + 1e-9 < bestLen) {
          best = next;
          bestLen = nextLen;
          improved = true;
        }
      }
    }
  }
  return best.slice(1);
}

export function makeMatrixDistFn(
  ids: string[],
  matrix: number[][],
  startId = "__start__",
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

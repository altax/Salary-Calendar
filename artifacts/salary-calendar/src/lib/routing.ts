export type LatLng = { lat: number; lng: number };

export type ManeuverType =
  | "depart"
  | "arrive"
  | "turn"
  | "continue"
  | "merge"
  | "on ramp"
  | "off ramp"
  | "fork"
  | "end of road"
  | "new name"
  | "roundabout"
  | "rotary"
  | "roundabout turn"
  | "exit roundabout"
  | "exit rotary"
  | "use lane"
  | "notification"
  | string;

export type ManeuverModifier =
  | "left"
  | "right"
  | "straight"
  | "uturn"
  | "slight left"
  | "slight right"
  | "sharp left"
  | "sharp right"
  | string;

export type RouteStep = {
  distance: number;
  duration: number;
  geometry: [number, number][];
  name: string;
  ref?: string;
  maneuver: {
    type: ManeuverType;
    modifier?: ManeuverModifier;
    location: [number, number];
    bearingBefore?: number;
    bearingAfter?: number;
    exit?: number;
  };
};

export type RouteLeg = {
  distance: number;
  duration: number;
  steps: RouteStep[];
};

export type RouteResult = {
  distance: number;
  duration: number;
  geometry: [number, number][];
  legs: RouteLeg[];
  // "osrm" — real route from OSRM (live or SW cache).
  // "straight" — offline straight-line haversine fallback.
  source?: "osrm" | "straight";
};

export type RouteMatrix = {
  distances: number[][];
  durations: number[][];
};

export interface RoutingProvider {
  getRoute(points: LatLng[]): Promise<RouteResult>;
  getMatrix(points: LatLng[]): Promise<RouteMatrix>;
}

const DEFAULT_OSRM_BASE = "https://router.project-osrm.org";

export class OsrmProvider implements RoutingProvider {
  constructor(private readonly base: string = DEFAULT_OSRM_BASE) {}

  private encodeCoords(points: LatLng[]): string {
    return points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  }

  async getRoute(points: LatLng[]): Promise<RouteResult> {
    if (points.length < 2) throw new Error("routing: need at least 2 points");
    const coords = this.encodeCoords(points);
    const url = `${this.base}/route/v1/driving/${coords}?overview=full&steps=true&geometries=geojson&annotations=false&continue_straight=true`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`routing: ${res.status} ${res.statusText}`);
      const json = await res.json();
      if (json.code !== "Ok" || !json.routes?.length) {
        throw new Error(`routing: ${json.code || "no route"}`);
      }
      const r = json.routes[0];
      const geometry: [number, number][] = (r.geometry?.coordinates ?? []).map(
        (c: [number, number]) => [c[1], c[0]] as [number, number],
      );
      const legs: RouteLeg[] = (r.legs ?? []).map((leg: any) => ({
        distance: leg.distance ?? 0,
        duration: leg.duration ?? 0,
        steps: (leg.steps ?? []).map((s: any) => normalizeStep(s)),
      }));
      return {
        distance: r.distance ?? 0,
        duration: r.duration ?? 0,
        geometry,
        legs,
        source: "osrm",
      };
    } catch (err) {
      // Offline / SW returned 599 / DNS / etc. Build a straight-line fallback
      // so DriveMode still has something to show and announce.
      return buildStraightLineRoute(points);
    }
  }

  async getMatrix(points: LatLng[]): Promise<RouteMatrix> {
    if (points.length < 2) {
      const n = points.length;
      const zero = Array.from({ length: n }, () => new Array(n).fill(0));
      return { distances: zero, durations: zero };
    }
    const coords = this.encodeCoords(points);
    const url = `${this.base}/table/v1/driving/${coords}?annotations=distance,duration`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`matrix: ${res.status} ${res.statusText}`);
      const json = await res.json();
      if (json.code !== "Ok") throw new Error(`matrix: ${json.code}`);
      return {
        distances: json.distances ?? [],
        durations: json.durations ?? [],
      };
    } catch (err) {
      return buildStraightLineMatrix(points);
    }
  }
}

// Average urban driving speed used when we have no real routing data.
const STRAIGHT_LINE_SPEED_MPS = 11; // ~40 km/h

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildStraightLineRoute(points: LatLng[]): RouteResult {
  const geometry: [number, number][] = points.map((p) => [p.lat, p.lng]);
  const legs: RouteLeg[] = [];
  let totalDist = 0;
  let totalDur = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversineMeters(a, b);
    const t = d / STRAIGHT_LINE_SPEED_MPS;
    totalDist += d;
    totalDur += t;
    const isLast = i === points.length - 1;
    legs.push({
      distance: d,
      duration: t,
      steps: [
        {
          distance: d,
          duration: t,
          geometry: [
            [a.lat, a.lng],
            [b.lat, b.lng],
          ],
          name: "по прямой",
          maneuver: {
            type: i === 1 ? "depart" : "continue",
            location: [a.lat, a.lng],
          },
        },
        {
          distance: 0,
          duration: 0,
          geometry: [[b.lat, b.lng]],
          name: "",
          maneuver: {
            type: isLast ? "arrive" : "continue",
            location: [b.lat, b.lng],
          },
        },
      ],
    });
  }
  return {
    distance: totalDist,
    duration: totalDur,
    geometry,
    legs,
    source: "straight",
  };
}

function buildStraightLineMatrix(points: LatLng[]): RouteMatrix {
  const n = points.length;
  const distances: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const durations: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const d = haversineMeters(points[i], points[j]);
      distances[i][j] = d;
      durations[i][j] = d / STRAIGHT_LINE_SPEED_MPS;
    }
  }
  return { distances, durations };
}

function normalizeStep(raw: any): RouteStep {
  const geom: [number, number][] = (raw.geometry?.coordinates ?? []).map(
    (c: [number, number]) => [c[1], c[0]] as [number, number],
  );
  const m = raw.maneuver ?? {};
  const loc: [number, number] = m.location
    ? [m.location[1], m.location[0]]
    : geom[0] ?? [0, 0];
  return {
    distance: raw.distance ?? 0,
    duration: raw.duration ?? 0,
    geometry: geom,
    name: raw.name ?? "",
    ref: raw.ref || undefined,
    maneuver: {
      type: m.type ?? "continue",
      modifier: m.modifier,
      location: loc,
      bearingBefore: m.bearing_before,
      bearingAfter: m.bearing_after,
      exit: m.exit,
    },
  };
}

let defaultProvider: RoutingProvider | null = null;
export function getRoutingProvider(): RoutingProvider {
  if (!defaultProvider) {
    const base =
      (typeof import.meta !== "undefined" &&
        (import.meta as any).env?.VITE_OSRM_BASE) ||
      DEFAULT_OSRM_BASE;
    defaultProvider = new OsrmProvider(base);
  }
  return defaultProvider;
}

export function flattenSteps(route: RouteResult): RouteStep[] {
  const out: RouteStep[] = [];
  for (const leg of route.legs) for (const s of leg.steps) out.push(s);
  return out;
}

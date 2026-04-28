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
    };
  }

  async getMatrix(points: LatLng[]): Promise<RouteMatrix> {
    if (points.length < 2) {
      const n = points.length;
      const zero = Array.from({ length: n }, () => new Array(n).fill(0));
      return { distances: zero, durations: zero };
    }
    const coords = this.encodeCoords(points);
    const url = `${this.base}/table/v1/driving/${coords}?annotations=distance,duration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`matrix: ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json.code !== "Ok") throw new Error(`matrix: ${json.code}`);
    return {
      distances: json.distances ?? [],
      durations: json.durations ?? [],
    };
  }
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

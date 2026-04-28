import { useEffect, useRef, useState } from "react";
import {
  getRoutingProfile,
  getRoutingProvider,
  subscribeRoutingProfile,
  type LatLng,
  type RouteProfile,
  type RouteResult,
} from "@/lib/routing";

// React-hook view of the active routing profile. Components that use the
// profile reactively (re-fetch on switch) read from this.
export function useRoutingProfile(): RouteProfile {
  const [p, setP] = useState<RouteProfile>(() => getRoutingProfile());
  useEffect(() => subscribeRoutingProfile(setP), []);
  return p;
}

export type RouteState = {
  route: RouteResult | null;
  loading: boolean;
  error: string | null;
};

function pointsKey(points: LatLng[]): string {
  return points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

export function useRoute(points: LatLng[] | null): RouteState {
  const profile = useRoutingProfile();
  const [state, setState] = useState<RouteState>({
    route: null,
    loading: false,
    error: null,
  });
  const lastKey = useRef<string>("");
  const reqId = useRef(0);

  useEffect(() => {
    if (!points || points.length < 2) {
      lastKey.current = "";
      setState({ route: null, loading: false, error: null });
      return;
    }
    const key = `${profile}|${pointsKey(points)}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    const myReq = ++reqId.current;
    setState((s) => ({ route: s.route, loading: true, error: null }));
    getRoutingProvider(profile)
      .getRoute(points)
      .then((r) => {
        if (myReq !== reqId.current) return;
        setState({ route: r, loading: false, error: null });
      })
      .catch((e: Error) => {
        if (myReq !== reqId.current) return;
        setState({ route: null, loading: false, error: e.message });
      });
  }, [profile, points ? pointsKey(points) : null]);

  return state;
}

export type MatrixState = {
  ids: string[];
  durations: number[][] | null;
  distances: number[][] | null;
  loading: boolean;
  error: string | null;
};

export function useDistanceMatrix(
  points: ({ id: string; lat: number; lng: number })[] | null,
): MatrixState {
  const profile = useRoutingProfile();
  const [state, setState] = useState<MatrixState>({
    ids: [],
    durations: null,
    distances: null,
    loading: false,
    error: null,
  });
  const lastKey = useRef<string>("");
  const reqId = useRef(0);

  useEffect(() => {
    if (!points || points.length < 2) {
      lastKey.current = "";
      setState({ ids: [], durations: null, distances: null, loading: false, error: null });
      return;
    }
    const key = `${profile}|${points.map((p) => `${p.id}:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|")}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    const myReq = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    getRoutingProvider(profile)
      .getMatrix(points.map((p) => ({ lat: p.lat, lng: p.lng })))
      .then((m) => {
        if (myReq !== reqId.current) return;
        setState({
          ids: points.map((p) => p.id),
          durations: m.durations,
          distances: m.distances,
          loading: false,
          error: null,
        });
      })
      .catch((e: Error) => {
        if (myReq !== reqId.current) return;
        setState({ ids: [], durations: null, distances: null, loading: false, error: e.message });
      });
  }, [profile, points ? points.map((p) => `${p.id}:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|") : null]);

  return state;
}

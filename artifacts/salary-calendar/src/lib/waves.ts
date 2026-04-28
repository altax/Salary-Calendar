import { useCallback, useEffect, useMemo, useState } from "react";
import type { JobId, Depot } from "@/lib/store";

const WAVES_KEY = "salary-calendar:waves:v1";
const PENDING_LEGACY_KEY = "salary-calendar:pending:v1";
const SELECTED_WAVE_KEY = "salary-calendar:waves:selected";

export type WaveStopStatus = "pending" | "delivered" | "skipped";

export type WaveStop = {
  id: string;
  jobId: JobId;
  lat: number;
  lng: number;
  address?: string;
  priceRub?: number;
  status: WaveStopStatus;
  amountRub?: number;
  deliveredAt?: number;
  deliveryId?: string;
  createdAt: number;
};

export type WaveRouteSnapshot = {
  geometry?: [number, number][];
  distanceM?: number;
  durationS?: number;
  builtAt?: number;
};

export type Wave = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  depot: { lat: number; lng: number; name: string; address: string };
  stops: WaveStop[];
  delivery?: WaveRouteSnapshot;
  returnTrip?: WaveRouteSnapshot;
};

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadWaves(): Wave[] {
  try {
    const raw = localStorage.getItem(WAVES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Wave[];
  } catch {}
  return [];
}

function loadSelectedId(): string | null {
  try {
    return localStorage.getItem(SELECTED_WAVE_KEY);
  } catch {
    return null;
  }
}

function migrateLegacyPending(depot: Depot): Wave | null {
  try {
    const raw = localStorage.getItem(PENDING_LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.removeItem(PENDING_LEGACY_KEY);
      return null;
    }
    const stops: WaveStop[] = parsed.map((p: any) => ({
      id: typeof p.id === "string" ? p.id : makeId(),
      jobId: p.jobId,
      lat: Number(p.lat),
      lng: Number(p.lng),
      address: p.address,
      priceRub: typeof p.priceRub === "number" ? p.priceRub : undefined,
      status: "pending",
      createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    }));
    const wave: Wave = {
      id: makeId(),
      startedAt: Date.now(),
      depot: {
        lat: depot.lat,
        lng: depot.lng,
        name: depot.name,
        address: depot.address,
      },
      stops,
    };
    localStorage.removeItem(PENDING_LEGACY_KEY);
    return wave;
  } catch {
    return null;
  }
}

export function useWavesStore(depot: Depot) {
  const [waves, setWaves] = useState<Wave[]>(() => {
    const loaded = loadWaves();
    if (loaded.length === 0) {
      const migrated = migrateLegacyPending(depot);
      if (migrated) return [migrated];
    }
    return loaded;
  });
  const [selectedWaveId, setSelectedWaveIdState] = useState<string | null>(() =>
    loadSelectedId(),
  );

  useEffect(() => {
    try {
      localStorage.setItem(WAVES_KEY, JSON.stringify(waves));
    } catch {}
  }, [waves]);

  useEffect(() => {
    try {
      if (selectedWaveId) localStorage.setItem(SELECTED_WAVE_KEY, selectedWaveId);
      else localStorage.removeItem(SELECTED_WAVE_KEY);
    } catch {}
  }, [selectedWaveId]);

  const setSelectedWaveId = useCallback((id: string | null) => {
    setSelectedWaveIdState(id);
  }, []);

  const activeWave = useMemo(
    () => waves.find((w) => !w.finishedAt) ?? null,
    [waves],
  );

  const finishedWaves = useMemo(
    () =>
      waves
        .filter((w) => !!w.finishedAt)
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
    [waves],
  );

  // Resolve which wave the UI is showing on the map. If selected is invalid or
  // the active wave is empty and nothing chosen — fall back to active.
  const visibleWave = useMemo<Wave | null>(() => {
    if (selectedWaveId) {
      const found = waves.find((w) => w.id === selectedWaveId);
      if (found) return found;
    }
    return activeWave;
  }, [selectedWaveId, waves, activeWave]);

  const ensureActiveWave = useCallback((): Wave => {
    if (activeWave) return activeWave;
    const w: Wave = {
      id: makeId(),
      startedAt: Date.now(),
      depot: {
        lat: depot.lat,
        lng: depot.lng,
        name: depot.name,
        address: depot.address,
      },
      stops: [],
    };
    setWaves((prev) => [...prev, w]);
    setSelectedWaveIdState(null);
    return w;
  }, [activeWave, depot]);

  const updateActiveWave = useCallback(
    (updater: (w: Wave) => Wave) => {
      setWaves((prev) => {
        const idx = prev.findIndex((w) => !w.finishedAt);
        if (idx < 0) {
          const fresh: Wave = {
            id: makeId(),
            startedAt: Date.now(),
            depot: {
              lat: depot.lat,
              lng: depot.lng,
              name: depot.name,
              address: depot.address,
            },
            stops: [],
          };
          return [...prev, updater(fresh)];
        }
        const next = prev.slice();
        next[idx] = updater(prev[idx]);
        return next;
      });
    },
    [depot],
  );

  const addStop = useCallback(
    (
      input: Omit<WaveStop, "id" | "status" | "createdAt"> &
        Partial<Pick<WaveStop, "id" | "status" | "createdAt">>,
    ): WaveStop => {
      const stop: WaveStop = {
        id: input.id ?? makeId(),
        jobId: input.jobId,
        lat: input.lat,
        lng: input.lng,
        address: input.address,
        priceRub: input.priceRub,
        status: input.status ?? "pending",
        createdAt: input.createdAt ?? Date.now(),
      };
      updateActiveWave((w) => ({ ...w, stops: [...w.stops, stop] }));
      return stop;
    },
    [updateActiveWave],
  );

  const updateStop = useCallback(
    (id: string, patch: Partial<Omit<WaveStop, "id">>) => {
      updateActiveWave((w) => ({
        ...w,
        stops: w.stops.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      }));
    },
    [updateActiveWave],
  );

  const removeStop = useCallback(
    (id: string) => {
      updateActiveWave((w) => ({
        ...w,
        stops: w.stops.filter((s) => s.id !== id),
      }));
    },
    [updateActiveWave],
  );

  const reorderStops = useCallback(
    (orderedPendingIds: string[]) => {
      updateActiveWave((w) => {
        const map = new Map(w.stops.map((s) => [s.id, s] as const));
        const orderedPending: WaveStop[] = [];
        for (const id of orderedPendingIds) {
          const s = map.get(id);
          if (s && s.status === "pending") {
            orderedPending.push(s);
            map.delete(id);
          }
        }
        // Preserve already-resolved stops at the front (in original order) and
        // append any pending we didn't see at the end (defensive).
        const resolved = w.stops.filter((s) => s.status !== "pending");
        const leftover = Array.from(map.values()).filter((s) => s.status === "pending");
        return { ...w, stops: [...resolved, ...orderedPending, ...leftover] };
      });
    },
    [updateActiveWave],
  );

  const completeStop = useCallback(
    (id: string, amount: number, deliveryId?: string) => {
      updateActiveWave((w) => ({
        ...w,
        stops: w.stops.map((s) =>
          s.id === id
            ? {
                ...s,
                status: "delivered" as const,
                amountRub: amount,
                deliveredAt: Date.now(),
                deliveryId,
              }
            : s,
        ),
      }));
    },
    [updateActiveWave],
  );

  const undoCompleteStop = useCallback(
    (id: string) => {
      updateActiveWave((w) => ({
        ...w,
        stops: w.stops.map((s) =>
          s.id === id
            ? {
                ...s,
                status: "pending" as const,
                amountRub: undefined,
                deliveredAt: undefined,
                deliveryId: undefined,
              }
            : s,
        ),
      }));
    },
    [updateActiveWave],
  );

  const skipStop = useCallback(
    (id: string) => {
      updateActiveWave((w) => ({
        ...w,
        stops: w.stops.map((s) =>
          s.id === id ? { ...s, status: "skipped" as const } : s,
        ),
      }));
    },
    [updateActiveWave],
  );

  const saveDeliveryRoute = useCallback(
    (geometry: [number, number][], distanceM: number, durationS: number) => {
      updateActiveWave((w) => ({
        ...w,
        delivery: { geometry, distanceM, durationS, builtAt: Date.now() },
      }));
    },
    [updateActiveWave],
  );

  const saveReturnRoute = useCallback(
    (geometry: [number, number][], distanceM: number, durationS: number) => {
      updateActiveWave((w) => ({
        ...w,
        returnTrip: { geometry, distanceM, durationS, builtAt: Date.now() },
      }));
    },
    [updateActiveWave],
  );

  const finishActiveWave = useCallback(() => {
    setWaves((prev) => {
      const idx = prev.findIndex((w) => !w.finishedAt);
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = { ...prev[idx], finishedAt: Date.now() };
      return next;
    });
    setSelectedWaveIdState(null);
  }, []);

  const reopenWave = useCallback((id: string) => {
    setWaves((prev) => {
      // Only one wave can be active. If another active exists, finish it first.
      let touched = prev.map((w) =>
        !w.finishedAt && w.id !== id ? { ...w, finishedAt: Date.now() } : w,
      );
      touched = touched.map((w) =>
        w.id === id ? { ...w, finishedAt: undefined } : w,
      );
      return touched;
    });
    setSelectedWaveIdState(null);
  }, []);

  const deleteWave = useCallback((id: string) => {
    setWaves((prev) => prev.filter((w) => w.id !== id));
    setSelectedWaveIdState((cur) => (cur === id ? null : cur));
  }, []);

  const startNewWave = useCallback(() => {
    setWaves((prev) => {
      const finished = prev.map((w) =>
        !w.finishedAt ? { ...w, finishedAt: Date.now() } : w,
      );
      const fresh: Wave = {
        id: makeId(),
        startedAt: Date.now(),
        depot: {
          lat: depot.lat,
          lng: depot.lng,
          name: depot.name,
          address: depot.address,
        },
        stops: [],
      };
      return [...finished, fresh];
    });
    setSelectedWaveIdState(null);
  }, [depot]);

  return {
    waves,
    activeWave,
    finishedWaves,
    visibleWave,
    selectedWaveId,
    setSelectedWaveId,
    ensureActiveWave,
    addStop,
    updateStop,
    removeStop,
    reorderStops,
    completeStop,
    undoCompleteStop,
    skipStop,
    saveDeliveryRoute,
    saveReturnRoute,
    finishActiveWave,
    reopenWave,
    deleteWave,
    startNewWave,
  };
}

export function pendingStops(wave: Wave | null | undefined): WaveStop[] {
  if (!wave) return [];
  return wave.stops.filter((s) => s.status === "pending");
}

export function deliveredStops(wave: Wave | null | undefined): WaveStop[] {
  if (!wave) return [];
  return wave.stops.filter((s) => s.status === "delivered");
}

export function waveStopsByStatus(wave: Wave | null | undefined) {
  if (!wave) {
    return { pending: [] as WaveStop[], delivered: [] as WaveStop[], skipped: [] as WaveStop[] };
  }
  return {
    pending: wave.stops.filter((s) => s.status === "pending"),
    delivered: wave.stops.filter((s) => s.status === "delivered"),
    skipped: wave.stops.filter((s) => s.status === "skipped"),
  };
}

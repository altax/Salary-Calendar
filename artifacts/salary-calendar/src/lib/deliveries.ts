import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import type { JobId } from "@/lib/store";

const DELIVERIES_KEY = "salary-calendar:deliveries:v1";
const PENDING_KEY = "salary-calendar:pending:v1";

export type Delivery = {
  id: string;
  jobId: JobId;
  amountRub: number;
  lat: number;
  lng: number;
  address?: string;
  timestamp: number;
};

export type PendingOrder = {
  id: string;
  jobId: JobId;
  lat: number;
  lng: number;
  address?: string;
  createdAt: number;
};

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadDeliveries(): Delivery[] {
  try {
    const raw = localStorage.getItem(DELIVERIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Delivery[];
  } catch {}
  return [];
}

function loadPending(): PendingOrder[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PendingOrder[];
  } catch {}
  return [];
}

export type DeliveryDelta = {
  dateIso: string;
  jobId: JobId;
  delta: number;
};

export function useDeliveriesStore(onChange?: (d: DeliveryDelta) => void) {
  const [deliveries, setDeliveries] = useState<Delivery[]>(() => loadDeliveries());
  const [pending, setPending] = useState<PendingOrder[]>(() => loadPending());

  useEffect(() => {
    try {
      localStorage.setItem(DELIVERIES_KEY, JSON.stringify(deliveries));
    } catch {}
  }, [deliveries]);

  useEffect(() => {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {}
  }, [pending]);

  const addDelivery = useCallback(
    (input: Omit<Delivery, "id">): Delivery => {
      const d: Delivery = { id: makeId(), ...input };
      setDeliveries((prev) => [...prev, d]);
      const dateIso = format(new Date(d.timestamp), "yyyy-MM-dd");
      onChange?.({ dateIso, jobId: d.jobId, delta: d.amountRub });
      return d;
    },
    [onChange],
  );

  const updateDelivery = useCallback(
    (
      id: string,
      patch: Partial<Pick<Delivery, "amountRub" | "jobId" | "address" | "lat" | "lng">>,
    ) => {
      setDeliveries((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx < 0) return prev;
        const before = prev[idx];
        const after: Delivery = { ...before, ...patch };
        const next = prev.slice();
        next[idx] = after;
        const dateIso = format(new Date(before.timestamp), "yyyy-MM-dd");
        if (before.jobId === after.jobId) {
          const delta = after.amountRub - before.amountRub;
          if (delta !== 0) onChange?.({ dateIso, jobId: before.jobId, delta });
        } else {
          onChange?.({ dateIso, jobId: before.jobId, delta: -before.amountRub });
          onChange?.({ dateIso, jobId: after.jobId, delta: after.amountRub });
        }
        return next;
      });
    },
    [onChange],
  );

  const removeDelivery = useCallback(
    (id: string) => {
      setDeliveries((prev) => {
        const target = prev.find((d) => d.id === id);
        if (!target) return prev;
        const dateIso = format(new Date(target.timestamp), "yyyy-MM-dd");
        onChange?.({ dateIso, jobId: target.jobId, delta: -target.amountRub });
        return prev.filter((d) => d.id !== id);
      });
    },
    [onChange],
  );

  const addPending = useCallback((input: Omit<PendingOrder, "id" | "createdAt">) => {
    const p: PendingOrder = { id: makeId(), createdAt: Date.now(), ...input };
    setPending((prev) => [...prev, p]);
    return p;
  }, []);

  const updatePending = useCallback(
    (id: string, patch: Partial<Omit<PendingOrder, "id" | "createdAt">>) => {
      setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    [],
  );

  const removePending = useCallback((id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const reorderPending = useCallback((orderedIds: string[]) => {
    setPending((prev) => {
      const map = new Map(prev.map((p) => [p.id, p] as const));
      const next: PendingOrder[] = [];
      for (const id of orderedIds) {
        const p = map.get(id);
        if (p) {
          next.push(p);
          map.delete(id);
        }
      }
      for (const p of map.values()) next.push(p);
      return next;
    });
  }, []);

  const completePending = useCallback(
    (id: string, amountRub: number) => {
      const target = pending.find((p) => p.id === id);
      if (!target) return null;
      const delivery = addDelivery({
        jobId: target.jobId,
        amountRub,
        lat: target.lat,
        lng: target.lng,
        address: target.address,
        timestamp: Date.now(),
      });
      removePending(id);
      return delivery;
    },
    [pending, addDelivery, removePending],
  );

  return {
    deliveries,
    pending,
    addDelivery,
    updateDelivery,
    removeDelivery,
    addPending,
    updatePending,
    removePending,
    reorderPending,
    completePending,
  };
}

export function deliveriesByDay(deliveries: Delivery[], dateIso: string): Delivery[] {
  return deliveries.filter(
    (d) => format(new Date(d.timestamp), "yyyy-MM-dd") === dateIso,
  );
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function totalRouteKm(points: { lat: number; lng: number }[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) {
    sum += haversineKm(points[i - 1], points[i]);
  }
  return sum;
}

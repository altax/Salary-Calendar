import { useEffect, useRef, useState } from "react";

export type GeoPosition = {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  timestamp: number;
};

export type GeoStatus = "idle" | "requesting" | "watching" | "denied" | "unavailable" | "error";

export function useGeolocation(enabled: boolean): {
  position: GeoPosition | null;
  status: GeoStatus;
  error: string | null;
} {
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [status, setStatus] = useState<GeoStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (watchIdRef.current != null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setStatus("idle");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      setError("Геолокация недоступна в этом браузере");
      return;
    }

    setStatus("requesting");
    setError(null);

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus("watching");
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading ?? null,
          speed: pos.coords.speed ?? null,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
          setError("Нужно разрешение на геолокацию");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setStatus("unavailable");
          setError("GPS недоступен");
        } else {
          setStatus("error");
          setError(err.message || "Ошибка GPS");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000,
      },
    );
    watchIdRef.current = id;

    return () => {
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [enabled]);

  return { position, status, error };
}

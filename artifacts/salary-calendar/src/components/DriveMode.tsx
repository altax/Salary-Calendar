import { useEffect, useMemo, useState } from "react";
import { useGeolocation } from "@/lib/geolocation";
import { haversineKm, type PendingOrder } from "@/lib/deliveries";
import type { Depot, ResolvedJob } from "@/lib/store";
import DeliveryMap from "@/components/DeliveryMap";
import { cn } from "@/lib/utils";

export type DriveModeProps = {
  pending: PendingOrder[];
  jobs: ResolvedJob[];
  depot: Depot;
  theme: "dark" | "light";
  onExit: () => void;
  onCompleteStop: (id: string, amountRub: number) => void;
  onSkipStop: (id: string) => void;
};

const AVG_KMH = 25;

function formatEta(km: number): string {
  if (km <= 0) return "—";
  const minutes = (km / AVG_KMH) * 60;
  if (minutes < 1) return "<1 мин";
  if (minutes < 60) return `~${Math.round(minutes)} мин`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `~${h} ч ${m} мин`;
}

function formatKm(km: number): string {
  if (km <= 0) return "—";
  if (km < 1) return `${Math.round(km * 1000)} м`;
  return `${km.toFixed(1)} км`;
}

export default function DriveMode({
  pending,
  jobs,
  depot,
  theme,
  onExit,
  onCompleteStop,
  onSkipStop,
}: DriveModeProps) {
  const { position, status, error } = useGeolocation(true);
  const [completing, setCompleting] = useState<{ id: string; value: string } | null>(null);

  const active = pending[0] ?? null;
  const job = active ? jobs.find((j) => j.id === active.jobId) : undefined;

  const distanceToActive = useMemo(() => {
    if (!active || !position) return 0;
    return haversineKm({ lat: position.lat, lng: position.lng }, { lat: active.lat, lng: active.lng });
  }, [active, position?.lat, position?.lng]);

  const remainingTotal = useMemo(() => {
    if (pending.length === 0) return 0;
    let total = 0;
    let cursor = position
      ? { lat: position.lat, lng: position.lng }
      : { lat: depot.lat, lng: depot.lng };
    for (const p of pending) {
      total += haversineKm(cursor, { lat: p.lat, lng: p.lng });
      cursor = { lat: p.lat, lng: p.lng };
    }
    return total;
  }, [pending, position?.lat, position?.lng, depot]);

  const totalStops = pending.length;
  const completedSoFar = 0;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const finishCompletion = () => {
    if (!completing || !active) return;
    const v = Number(completing.value);
    if (!Number.isFinite(v) || v <= 0) return;
    onCompleteStop(active.id, v);
    setCompleting(null);
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-background text-foreground flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 h-14 px-4 flex items-center justify-between border-b border-border bg-card">
        <button
          onClick={onExit}
          className="h-10 px-4 rounded-md border border-border text-[12px] font-medium uppercase tracking-[0.2em] hover:bg-muted transition-colors"
        >
          ← выйти
        </button>
        <div className="flex flex-col items-center">
          <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            режим вождения
          </div>
          <div className="text-[14px] font-semibold tabular-nums">
            {totalStops > 0
              ? `${completedSoFar + 1} / ${totalStops}`
              : "маршрут пуст"}
          </div>
        </div>
        <div className="flex flex-col items-end text-right">
          <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            осталось
          </div>
          <div className="text-[14px] font-semibold tabular-nums">
            {formatKm(remainingTotal)}
          </div>
        </div>
      </div>

      {/* GPS status banner */}
      {(status === "denied" ||
        status === "unavailable" ||
        status === "error" ||
        status === "requesting") && (
        <div
          className={cn(
            "shrink-0 px-4 py-2 text-center text-[11px] uppercase tracking-[0.2em]",
            status === "requesting"
              ? "bg-muted text-muted-foreground"
              : "bg-destructive/15 text-destructive",
          )}
        >
          {status === "requesting" && "ищу GPS…"}
          {status === "denied" && "✕ нет разрешения на геолокацию — разреши в браузере"}
          {status === "unavailable" && "✕ GPS недоступен"}
          {status === "error" && `✕ ${error || "ошибка GPS"}`}
        </div>
      )}

      {/* Map */}
      <div className="flex-1 min-h-0 relative">
        <DeliveryMap
          deliveries={[]}
          pending={pending}
          jobs={jobs}
          depot={depot}
          showDepot={pending.length === 0}
          theme={theme}
          userPosition={position}
          followUser={!!position}
          activePendingId={active?.id ?? null}
          showRoute={false}
          showPendingRoute={true}
          fitToAll={!position && pending.length > 0}
          initialZoom={position ? 16 : 12}
        />
      </div>

      {/* Bottom panel */}
      <div className="shrink-0 bg-card border-t border-border">
        {!active ? (
          <div className="p-6 text-center">
            <div className="text-[14px] font-semibold mb-2">маршрут завершён</div>
            <div className="text-[11px] text-muted-foreground mb-4">
              все заказы доставлены
            </div>
            <button
              onClick={onExit}
              className="h-12 px-6 rounded-md bg-primary text-primary-foreground text-[12px] font-medium uppercase tracking-[0.2em]"
            >
              готово
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                следующая остановка
              </span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {job?.label ?? active.jobId}
              </span>
            </div>
            <div className="text-[18px] font-semibold leading-tight">
              {active.address || `${active.lat.toFixed(5)}, ${active.lng.toFixed(5)}`}
            </div>
            <div className="flex items-center justify-between text-[14px] tabular-nums">
              <div>
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  расстояние
                </span>
                <span className="text-[20px] font-semibold">
                  {position ? formatKm(distanceToActive) : "ждём GPS"}
                </span>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground text-[10px] uppercase tracking-[0.2em] block">
                  ехать
                </span>
                <span className="text-[20px] font-semibold">
                  {position ? formatEta(distanceToActive) : "—"}
                </span>
              </div>
            </div>

            {completing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  finishCompletion();
                }}
                className="flex items-center gap-2 pt-1"
              >
                <input
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={completing.value}
                  onChange={(e) =>
                    setCompleting((c) =>
                      c ? { ...c, value: e.target.value.replace(/\D/g, "") } : c,
                    )
                  }
                  placeholder="сумма ₽"
                  className="flex-1 h-12 px-3 rounded-md border border-border bg-background text-[18px] tabular-nums focus:outline-none focus:border-foreground/40"
                />
                <button
                  type="submit"
                  className="h-12 px-5 rounded-md bg-primary text-primary-foreground text-[12px] font-semibold uppercase tracking-[0.2em]"
                >
                  ок
                </button>
                <button
                  type="button"
                  onClick={() => setCompleting(null)}
                  className="h-12 px-3 rounded-md border border-border text-[12px] uppercase tracking-[0.2em] text-muted-foreground"
                >
                  ×
                </button>
              </form>
            ) : (
              <div className="flex items-stretch gap-2 pt-1">
                <button
                  onClick={() => {
                    const presetRate = job?.perOrderRateRub ?? 0;
                    setCompleting({
                      id: active.id,
                      value: presetRate > 0 ? String(presetRate) : "",
                    });
                  }}
                  className="flex-1 h-14 rounded-md bg-primary text-primary-foreground text-[14px] font-semibold uppercase tracking-[0.2em] active:scale-[0.98] transition-transform"
                >
                  ✓ доставлено
                </button>
                <button
                  onClick={() => onSkipStop(active.id)}
                  className="h-14 px-4 rounded-md border border-border text-[11px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Пропустить эту остановку и взять следующую"
                >
                  пропустить
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

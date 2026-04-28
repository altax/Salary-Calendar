import { useMemo } from "react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import DeliveryMap from "@/components/DeliveryMap";
import { deliveriesByDay, totalRouteKm } from "@/lib/deliveries";
import type { Delivery } from "@/lib/deliveries";
import type { ResolvedJob, Theme } from "@/lib/store";
import { cn } from "@/lib/utils";

export type DayDetailModalProps = {
  open: boolean;
  onClose: () => void;
  date: Date | null;
  deliveries: Delivery[];
  jobs: ResolvedJob[];
  theme: Theme;
  onRemoveDelivery: (id: string) => void;
};

export default function DayDetailModal({
  open,
  onClose,
  date,
  deliveries,
  jobs,
  theme,
  onRemoveDelivery,
}: DayDetailModalProps) {
  const [, setLocation] = useLocation();

  const dateIso = date ? format(date, "yyyy-MM-dd") : "";
  const dayDeliveries = useMemo(
    () =>
      date
        ? deliveriesByDay(deliveries, dateIso)
            .slice()
            .sort((a, b) => a.timestamp - b.timestamp)
        : [],
    [deliveries, dateIso, date],
  );

  const total = dayDeliveries.reduce((s, d) => s + d.amountRub, 0);
  const km = totalRouteKm(dayDeliveries);
  const avg = dayDeliveries.length > 0 ? total / dayDeliveries.length : 0;
  const perKm = km > 0 ? total / km : 0;

  const jobMap = new Map(jobs.map((j) => [j.id, j]));

  const perJob = useMemo(() => {
    const acc: Record<string, { count: number; sum: number }> = {};
    for (const d of dayDeliveries) {
      const cur = acc[d.jobId] || { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += d.amountRub;
      acc[d.jobId] = cur;
    }
    return acc;
  }, [dayDeliveries]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-[920px] w-[92vw] p-0 gap-0 border border-border bg-card overflow-hidden"
      >
        <DialogHeader className="px-5 py-3 border-b border-border">
          <DialogTitle className="text-[11px] font-medium uppercase tracking-[0.25em] text-muted-foreground flex items-baseline gap-3">
            <span>день</span>
            {date && (
              <span className="text-foreground tabular-nums">
                {format(date, "d MMMM yyyy", { locale: ru })}
              </span>
            )}
            <span className="text-muted-foreground/60">·</span>
            <span className="tabular-nums">
              {dayDeliveries.length.toString().padStart(2, "0")} заказ{dayDeliveries.length === 1 ? "" : dayDeliveries.length < 5 && dayDeliveries.length > 0 ? "а" : "ов"}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div
          className="grid"
          style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", height: "min(72vh, 560px)" }}
        >
          <div className="relative">
            {dayDeliveries.length > 0 ? (
              <DeliveryMap
                deliveries={dayDeliveries}
                pending={[]}
                jobs={jobs}
                theme={theme}
                fitToAll
                interactive
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-muted-foreground text-[11px] uppercase tracking-[0.2em]">
                в этот день не было доставок
              </div>
            )}
          </div>

          <div className="border-l border-border flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-border space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">итого</span>
                <span className="text-lg font-semibold tabular-nums">
                  {Math.round(total)} ₽
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <Stat label="км" value={km > 0 ? km.toFixed(1) : "—"} />
                <Stat label="₽/км" value={perKm > 0 ? Math.round(perKm).toString() : "—"} />
                <Stat label="ср. чек" value={avg > 0 ? Math.round(avg).toString() : "—"} />
              </div>
              {Object.keys(perJob).length > 0 && (
                <div className="pt-2 space-y-1.5">
                  {Object.entries(perJob).map(([jobId, v]) => {
                    const job = jobMap.get(jobId);
                    return (
                      <div key={jobId} className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">
                          {job?.label || jobId}
                        </span>
                        <span className="tabular-nums text-foreground">
                          {v.count} · {Math.round(v.sum)} ₽
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {dayDeliveries.length === 0 ? (
                <div className="px-4 py-6 text-[11px] text-muted-foreground">
                  пока нет точек
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {dayDeliveries.map((d, i) => {
                    const job = jobMap.get(d.jobId);
                    return (
                      <li
                        key={d.id}
                        className="px-4 py-2.5 flex items-start gap-3 hover-elevate group"
                      >
                        <span className="text-[10px] tabular-nums text-muted-foreground w-5 mt-0.5">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[11px] tabular-nums text-foreground">
                              {new Date(d.timestamp).toLocaleTimeString("ru-RU", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            <span className="text-[12px] font-semibold tabular-nums">
                              {Math.round(d.amountRub)} ₽
                            </span>
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">
                            {job?.label || d.jobId}
                            {d.address && <> · {d.address}</>}
                          </div>
                        </div>
                        <button
                          onClick={() => onRemoveDelivery(d.id)}
                          className="opacity-0 group-hover:opacity-100 text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-opacity"
                          title="Удалить доставку"
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="px-4 py-3 border-t border-border">
              <button
                onClick={() => {
                  onClose();
                  setLocation(`/map?date=${dateIso}`);
                }}
                className="w-full h-9 rounded-md border border-border text-[11px] font-medium uppercase tracking-[0.2em] text-foreground hover:bg-muted transition-colors"
              >
                открыть на карте →
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="text-[12px] font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

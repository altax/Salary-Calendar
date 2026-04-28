import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { format, isSameDay, parseISO, startOfMonth, startOfWeek } from "date-fns";
import { ru } from "date-fns/locale";
import {
  useSalaryStore,
  type JobId,
  type ResolvedJob,
  type Depot,
} from "@/lib/store";
import {
  useDeliveriesStore,
  totalRouteKm,
  haversineKm,
  type Delivery,
  type PendingOrder,
} from "@/lib/deliveries";
import { searchAddress, reverseGeocode, type GeocodeResult } from "@/lib/geocode";
import {
  nearestNeighborRoute,
  twoOptImprove,
  makeMatrixDistFn,
} from "@/lib/route-optimizer";
import { useGeolocation } from "@/lib/geolocation";
import { useRoute, useDistanceMatrix } from "@/lib/use-route";
import DeliveryMap from "@/components/DeliveryMap";
import DriveMode from "@/components/DriveMode";
import { cn } from "@/lib/utils";

type RangeKey = "today" | "week" | "month" | "all" | "date";

const TODAY_ISO = () => format(new Date(), "yyyy-MM-dd");

function rangeMatches(range: RangeKey, dateIso: string | null, ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  if (range === "all") return true;
  if (range === "date" && dateIso) {
    return format(d, "yyyy-MM-dd") === dateIso;
  }
  if (range === "today") return isSameDay(d, now);
  if (range === "week") {
    const start = startOfWeek(now, { weekStartsOn: 1 });
    return d >= start;
  }
  if (range === "month") {
    return d >= startOfMonth(now);
  }
  return true;
}

function useQueryDateParam(): string | null {
  const [location] = useLocation();
  return useMemo(() => {
    const idx = location.indexOf("?");
    if (idx < 0) return null;
    const params = new URLSearchParams(location.slice(idx + 1));
    const v = params.get("date");
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  }, [location]);
}

export default function MapView() {
  const salary = useSalaryStore();
  const queryDate = useQueryDateParam();

  const onDeliveryDelta = useCallback(
    ({ dateIso, jobId, delta }: { dateIso: string; jobId: JobId; delta: number }) => {
      const cur = salary.entries[dateIso] || {};
      const next: Partial<Record<JobId, number>> = {};
      for (const j of salary.jobs) {
        const v = cur[j.id];
        if (typeof v === "number" && v > 0) next[j.id] = v;
      }
      const curJob = next[jobId] || 0;
      const newJob = Math.max(0, Math.round((curJob + delta) * 100) / 100);
      if (newJob > 0) next[jobId] = newJob;
      else delete next[jobId];
      salary.setDayEntries(dateIso, next, "RUB", { skipUndo: true, skipRecent: true });
    },
    [salary],
  );

  const deliveriesStore = useDeliveriesStore(onDeliveryDelta);

  const [range, setRange] = useState<RangeKey>(queryDate ? "date" : "all");
  const [filterJob, setFilterJob] = useState<string | null>(null);
  const [showRoute, setShowRoute] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number; zoom?: number } | null>(null);
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [driving, setDriving] = useState(false);
  const [depotEditOpen, setDepotEditOpen] = useState(false);

  const { position: userPosition, status: gpsStatus } = useGeolocation(gpsEnabled);

  useEffect(() => {
    if (queryDate) setRange("date");
  }, [queryDate]);

  // Auto-optimize pending list from depot whenever pending IDs change.
  const pendingIdsKey = useMemo(
    () =>
      deliveriesStore.pending
        .map((p) => p.id)
        .slice()
        .sort()
        .join(","),
    [deliveriesStore.pending],
  );

  // Real road distance matrix from depot through all pending stops.
  const matrixPoints = useMemo(() => {
    if (deliveriesStore.pending.length < 2) return null;
    return [
      { id: "__start__", lat: salary.depot.lat, lng: salary.depot.lng },
      ...deliveriesStore.pending.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
    ];
  }, [deliveriesStore.pending, salary.depot.lat, salary.depot.lng]);

  const matrix = useDistanceMatrix(matrixPoints);

  useEffect(() => {
    if (deliveriesStore.pending.length < 2) return;
    const start = { lat: salary.depot.lat, lng: salary.depot.lng };
    const dist = matrix.durations
      ? makeMatrixDistFn(matrix.ids, matrix.durations)
      : undefined;
    const ordered = nearestNeighborRoute(start, deliveriesStore.pending, dist);
    const refined = twoOptImprove(start, ordered, 50, dist);
    const newOrder = refined.map((p) => p.id);
    const curOrder = deliveriesStore.pending.map((p) => p.id);
    if (newOrder.join("|") !== curOrder.join("|")) {
      deliveriesStore.reorderPending(newOrder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIdsKey, salary.depot.lat, salary.depot.lng, matrix.durations]);

  // Real road geometry for the planned pending route (depot → all stops).
  const pendingRoutePoints = useMemo(() => {
    if (deliveriesStore.pending.length === 0) return null;
    return [
      { lat: salary.depot.lat, lng: salary.depot.lng },
      ...deliveriesStore.pending.map((p) => ({ lat: p.lat, lng: p.lng })),
    ];
  }, [deliveriesStore.pending, salary.depot.lat, salary.depot.lng]);

  const pendingRoute = useRoute(pendingRoutePoints);

  const visibleDeliveries = useMemo(
    () =>
      deliveriesStore.deliveries
        .filter((d) => (filterJob ? d.jobId === filterJob : true))
        .filter((d) => rangeMatches(range, queryDate, d.timestamp)),
    [deliveriesStore.deliveries, filterJob, range, queryDate],
  );

  const sortedVisible = useMemo(
    () => visibleDeliveries.slice().sort((a, b) => b.timestamp - a.timestamp),
    [visibleDeliveries],
  );

  const totalRub = visibleDeliveries.reduce((s, d) => s + d.amountRub, 0);
  const km = useMemo(
    () =>
      totalRouteKm(
        visibleDeliveries.slice().sort((a, b) => a.timestamp - b.timestamp),
      ),
    [visibleDeliveries],
  );
  const avgChek = visibleDeliveries.length > 0 ? totalRub / visibleDeliveries.length : 0;
  const perKm = km > 0 ? totalRub / km : 0;

  const perJob = useMemo(() => {
    const acc: Record<string, { count: number; sum: number }> = {};
    for (const d of visibleDeliveries) {
      const cur = acc[d.jobId] || { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += d.amountRub;
      acc[d.jobId] = cur;
    }
    return acc;
  }, [visibleDeliveries]);

  // Pending route metrics (from depot through ordered stops)
  const pendingKm = useMemo(() => {
    if (deliveriesStore.pending.length === 0) return 0;
    if (pendingRoute.route) return pendingRoute.route.distance / 1000;
    const points = [
      { lat: salary.depot.lat, lng: salary.depot.lng },
      ...deliveriesStore.pending.map((p) => ({ lat: p.lat, lng: p.lng })),
    ];
    return totalRouteKm(points);
  }, [deliveriesStore.pending, salary.depot, pendingRoute.route]);

  const pendingPotentialRub = useMemo(() => {
    let sum = 0;
    for (const p of deliveriesStore.pending) {
      const job = salary.jobs.find((j) => j.id === p.jobId);
      const rate = p.priceRub ?? job?.perOrderRateRub ?? 0;
      sum += rate;
    }
    return sum;
  }, [deliveriesStore.pending, salary.jobs]);

  const [addingPoint, setAddingPoint] = useState<{
    lat: number;
    lng: number;
    address?: string;
  } | null>(null);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setAddingPoint({ lat, lng });
    reverseGeocode(lat, lng)
      .then((addr) => {
        if (!addr) return;
        setAddingPoint((cur) =>
          cur && cur.lat === lat && cur.lng === lng && !cur.address
            ? { ...cur, address: addr }
            : cur,
        );
      })
      .catch(() => {});
  }, []);

  if (driving) {
    return (
      <DriveMode
        pending={deliveriesStore.pending}
        jobs={salary.jobs}
        depot={salary.depot}
        theme={salary.theme}
        onExit={() => setDriving(false)}
        onCompleteStop={(id, amount) => {
          deliveriesStore.completePending(id, amount);
        }}
        onSkipStop={(id) => {
          // move to end of queue
          const ids = deliveriesStore.pending.map((p) => p.id);
          const next = ids.filter((x) => x !== id).concat([id]);
          deliveriesStore.reorderPending(next);
        }}
      />
    );
  }

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground overflow-hidden p-3 sm:p-4">
      <div
        className="mx-auto w-full max-w-[1280px] h-full grid gap-3 min-h-0"
        style={{
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        <header className="col-span-2 rounded-2xl border border-border bg-card flex items-center justify-between px-4 py-2.5 min-h-0 gap-3 flex-wrap">
          <div className="flex items-baseline gap-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              [route]
            </span>
            <span className="text-sm font-medium tabular-nums">
              карта доставок
            </span>
            {queryDate && (
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                / {format(parseISO(queryDate), "d MMM yyyy", { locale: ru })}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <DepotChip
              depot={salary.depot}
              onEdit={() => setDepotEditOpen(true)}
            />
            <div className="w-px h-5 bg-border mx-1" />
            <RangeChips range={range} setRange={setRange} hasDate={!!queryDate} />
            <div className="w-px h-5 bg-border mx-1" />
            <JobFilter jobs={salary.jobs} filter={filterJob} setFilter={setFilterJob} />
            <div className="w-px h-5 bg-border mx-1" />
            <button
              onClick={() => setShowRoute((s) => !s)}
              className={cn(
                "h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] rounded-md transition-colors border",
                showRoute
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title="История маршрута доставок"
            >
              история
            </button>
            <button
              onClick={() => setGpsEnabled((g) => !g)}
              className={cn(
                "h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] rounded-md transition-colors border",
                gpsEnabled
                  ? "bg-blue-600 text-white border-blue-600"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title={gpsStatus === "denied" ? "Нет разрешения на GPS" : "Показать моё местоположение"}
            >
              ◉ gps {gpsStatus === "watching" ? "вкл" : ""}
            </button>
            <div className="w-px h-5 bg-border mx-1" />
            <Link
              href="/"
              className="h-7 px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground border border-border rounded-md hover:bg-muted transition-colors flex items-center"
            >
              ← календарь
            </Link>
          </div>
        </header>

        <div className="rounded-2xl border border-border bg-card overflow-hidden relative">
          <DeliveryMap
            deliveries={visibleDeliveries}
            pending={deliveriesStore.pending}
            jobs={salary.jobs}
            theme={salary.theme}
            depot={salary.depot}
            userPosition={userPosition}
            followUser={false}
            onMapClick={handleMapClick}
            onDeliveryClick={(id) => setSelectedId(id)}
            onPendingClick={(id) => setSelectedId(id)}
            selectedId={selectedId}
            flyTo={flyTo}
            showRoute={showRoute}
            showPendingRoute={true}
            pendingRouteGeometry={pendingRoute.route?.geometry ?? null}
          />
          <div className="absolute bottom-3 left-3 z-[400] pointer-events-none">
            <div className="rounded-md bg-background/85 backdrop-blur-sm border border-border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span>тапни по карте → новая точка · ⌂ — депо</span>
            </div>
          </div>
          <SearchBox
            onPick={(r) => {
              setFlyTo({ lat: r.lat, lng: r.lng, zoom: 16 });
              setAddingPoint({ lat: r.lat, lng: r.lng, address: r.shortName });
            }}
          />
        </div>

        <Sidebar
          jobs={salary.jobs}
          totalRub={totalRub}
          km={km}
          avgChek={avgChek}
          perKm={perKm}
          perJob={perJob}
          pendingKm={pendingKm}
          pendingPotentialRub={pendingPotentialRub}
          deliveries={sortedVisible}
          pending={deliveriesStore.pending}
          selectedId={selectedId}
          shifts={salary.shifts}
          onSetShiftActive={salary.setShiftActive}
          isShiftActive={salary.isShiftActive}
          onSelect={(id, lat, lng) => {
            setSelectedId(id);
            setFlyTo({ lat, lng, zoom: 16 });
          }}
          onRemoveDelivery={(id) => deliveriesStore.removeDelivery(id)}
          onRemovePending={(id) => deliveriesStore.removePending(id)}
          onCompletePending={(id, amount) => deliveriesStore.completePending(id, amount)}
          onAddPendingFromAddress={(r, jobId) => {
            const job = salary.jobs.find((j) => j.id === jobId);
            return deliveriesStore.addPending({
              jobId,
              lat: r.lat,
              lng: r.lng,
              address: r.shortName,
              priceRub: job?.perOrderRateRub,
            });
          }}
          onStartDriving={() => setDriving(true)}
        />
      </div>

      {addingPoint && (
        <AddDeliveryDialog
          lat={addingPoint.lat}
          lng={addingPoint.lng}
          address={addingPoint.address}
          jobs={salary.jobs}
          onCancel={() => setAddingPoint(null)}
          onSubmitDelivery={(jobId, amount) => {
            const d = deliveriesStore.addDelivery({
              jobId,
              amountRub: amount,
              lat: addingPoint.lat,
              lng: addingPoint.lng,
              address: addingPoint.address,
              timestamp: Date.now(),
            });
            setSelectedId(d.id);
            setAddingPoint(null);
          }}
          onSubmitPending={(jobId) => {
            const job = salary.jobs.find((j) => j.id === jobId);
            const p = deliveriesStore.addPending({
              jobId,
              lat: addingPoint.lat,
              lng: addingPoint.lng,
              address: addingPoint.address,
              priceRub: job?.perOrderRateRub,
            });
            setSelectedId(p.id);
            setAddingPoint(null);
          }}
        />
      )}

      {depotEditOpen && (
        <DepotEditDialog
          depot={salary.depot}
          onCancel={() => setDepotEditOpen(false)}
          onSubmit={(d) => {
            salary.setDepot(d);
            setDepotEditOpen(false);
            setFlyTo({ lat: d.lat, lng: d.lng, zoom: 15 });
          }}
        />
      )}
    </div>
  );
}

function DepotChip({ depot, onEdit }: { depot: Depot; onEdit: () => void }) {
  return (
    <button
      onClick={onEdit}
      className="h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center gap-1.5 max-w-[260px]"
      title={`Депо: ${depot.address}`}
    >
      <span className="text-foreground">⌂ депо</span>
      <span className="text-muted-foreground truncate">{depot.address}</span>
    </button>
  );
}

function RangeChips({
  range,
  setRange,
  hasDate,
}: {
  range: RangeKey;
  setRange: (r: RangeKey) => void;
  hasDate: boolean;
}) {
  const options: { key: RangeKey; label: string }[] = [
    { key: "today", label: "день" },
    { key: "week", label: "неделя" },
    { key: "month", label: "месяц" },
    { key: "all", label: "всё" },
  ];
  return (
    <div className="flex items-center rounded-md border border-border overflow-hidden">
      {hasDate && (
        <button
          onClick={() => setRange("date")}
          className={cn(
            "h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] transition-colors border-r border-border",
            range === "date"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          этот день
        </button>
      )}
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => setRange(o.key)}
          className={cn(
            "h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] transition-colors",
            range === o.key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function JobFilter({
  jobs,
  filter,
  setFilter,
}: {
  jobs: ResolvedJob[];
  filter: string | null;
  setFilter: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border overflow-hidden">
      <button
        onClick={() => setFilter(null)}
        className={cn(
          "h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] transition-colors border-r border-border",
          filter === null
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
      >
        все
      </button>
      {jobs.map((j, idx) => (
        <button
          key={j.id}
          onClick={() => setFilter(j.id)}
          className={cn(
            "h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] transition-colors",
            idx > 0 && "border-l border-border",
            filter === j.id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
          title={j.label}
        >
          {j.short}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ onPick }: { onPick: (r: GeocodeResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const t = setTimeout(() => {
      searchAddress(query, controller.signal)
        .then((r) => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 350);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query]);

  return (
    <div className="absolute top-3 right-3 z-[500] w-[280px]">
      <div className="rounded-md border border-border bg-background/90 backdrop-blur-sm overflow-hidden">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Поиск адреса в Питере…"
          className="w-full h-9 px-3 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      {open && (results.length > 0 || loading) && (
        <div className="mt-1 rounded-md border border-border bg-popover overflow-hidden max-h-[260px] overflow-y-auto shadow-lg">
          {loading && (
            <div className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              ищу…
            </div>
          )}
          {!loading &&
            results.map((r, i) => (
              <button
                key={i}
                onClick={() => {
                  onPick(r);
                  setOpen(false);
                  setQuery("");
                  setResults([]);
                }}
                className="w-full text-left px-3 py-2 text-[11px] hover:bg-muted transition-colors border-b border-border last:border-b-0"
              >
                <div className="text-foreground truncate">{r.shortName}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {r.displayName}
                </div>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

type SidebarProps = {
  jobs: ResolvedJob[];
  totalRub: number;
  km: number;
  avgChek: number;
  perKm: number;
  perJob: Record<string, { count: number; sum: number }>;
  pendingKm: number;
  pendingPotentialRub: number;
  deliveries: Delivery[];
  pending: PendingOrder[];
  selectedId: string | null;
  shifts: Record<string, Partial<Record<JobId, boolean>>>;
  onSetShiftActive: (dateIso: string, jobId: JobId, active: boolean) => void;
  isShiftActive: (dateIso: string, jobId: JobId) => boolean;
  onSelect: (id: string, lat: number, lng: number) => void;
  onRemoveDelivery: (id: string) => void;
  onRemovePending: (id: string) => void;
  onCompletePending: (id: string, amount: number) => void;
  onAddPendingFromAddress: (r: GeocodeResult, jobId: JobId) => void;
  onStartDriving: () => void;
};

function Sidebar(props: SidebarProps) {
  const [tab, setTab] = useState<"pending" | "done">(
    props.pending.length > 0 ? "pending" : "done",
  );
  const today = TODAY_ISO();
  const jobsWithBonus = props.jobs.filter((j) => j.shiftBonusRub > 0);

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border space-y-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            итого
          </span>
          <span className="text-lg font-semibold tabular-nums">
            {Math.round(props.totalRub)} ₽
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="точек" value={props.deliveries.length.toString()} />
          <Stat label="км" value={props.km > 0 ? props.km.toFixed(1) : "—"} />
          <Stat label="₽/км" value={props.perKm > 0 ? Math.round(props.perKm).toString() : "—"} />
        </div>

        {jobsWithBonus.length > 0 && (
          <div className="space-y-1 pt-1">
            <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
              смена сегодня
            </div>
            {jobsWithBonus.map((j) => {
              const active = props.isShiftActive(today, j.id);
              return (
                <button
                  key={j.id}
                  onClick={() => props.onSetShiftActive(today, j.id, !active)}
                  className={cn(
                    "w-full h-8 rounded-md border text-[11px] font-medium uppercase tracking-[0.15em] transition-colors flex items-center justify-between px-2.5",
                    active
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  <span>
                    {active ? "✓" : "○"} {j.label}
                  </span>
                  <span className="tabular-nums">+{j.shiftBonusRub} ₽</span>
                </button>
              );
            })}
          </div>
        )}

        {Object.keys(props.perJob).length > 0 && (
          <div className="pt-1 space-y-1">
            {Object.entries(props.perJob).map(([jobId, v]) => {
              const job = props.jobs.find((j) => j.id === jobId);
              return (
                <div key={jobId} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground truncate">
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

      <div className="flex border-b border-border shrink-0">
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")}>
          маршрут · {props.pending.length}
        </TabButton>
        <TabButton active={tab === "done"} onClick={() => setTab("done")}>
          готово · {props.deliveries.length}
        </TabButton>
      </div>

      {tab === "pending" ? (
        <PendingList
          pending={props.pending}
          jobs={props.jobs}
          selectedId={props.selectedId}
          pendingKm={props.pendingKm}
          pendingPotentialRub={props.pendingPotentialRub}
          onSelect={props.onSelect}
          onRemove={props.onRemovePending}
          onComplete={props.onCompletePending}
          onAdd={props.onAddPendingFromAddress}
          onStartDriving={props.onStartDriving}
        />
      ) : (
        <DeliveriesList
          deliveries={props.deliveries}
          jobs={props.jobs}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          onRemove={props.onRemoveDelivery}
        />
      )}
    </div>
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 h-9 text-[10px] font-medium uppercase tracking-[0.18em] transition-colors",
        active
          ? "bg-foreground/[0.04] text-foreground border-b-2 border-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function DeliveriesList({
  deliveries,
  jobs,
  selectedId,
  onSelect,
  onRemove,
}: {
  deliveries: Delivery[];
  jobs: ResolvedJob[];
  selectedId: string | null;
  onSelect: (id: string, lat: number, lng: number) => void;
  onRemove: (id: string) => void;
}) {
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  if (deliveries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center">
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          нет доставок в этом фильтре
          <br />
          <span className="text-muted-foreground/70 text-[10px]">
            тапни по карте чтобы добавить
          </span>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex-1 overflow-y-auto divide-y divide-border">
      {deliveries.map((d, i) => {
        const job = jobMap.get(d.jobId);
        const total = deliveries.length;
        return (
          <li
            key={d.id}
            className={cn(
              "px-4 py-2.5 flex items-start gap-3 hover-elevate group cursor-pointer",
              selectedId === d.id && "bg-foreground/[0.04]",
            )}
            onClick={() => onSelect(d.id, d.lat, d.lng)}
          >
            <span className="text-[10px] tabular-nums text-muted-foreground w-5 mt-0.5">
              {String(total - i).padStart(2, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] tabular-nums text-foreground">
                  {format(new Date(d.timestamp), "d MMM · HH:mm", { locale: ru })}
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
              onClick={(e) => {
                e.stopPropagation();
                onRemove(d.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-opacity"
              title="Удалить"
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PendingList({
  pending,
  jobs,
  selectedId,
  pendingKm,
  pendingPotentialRub,
  onSelect,
  onRemove,
  onComplete,
  onAdd,
  onStartDriving,
}: {
  pending: PendingOrder[];
  jobs: ResolvedJob[];
  selectedId: string | null;
  pendingKm: number;
  pendingPotentialRub: number;
  onSelect: (id: string, lat: number, lng: number) => void;
  onRemove: (id: string) => void;
  onComplete: (id: string, amount: number) => void;
  onAdd: (r: GeocodeResult, jobId: JobId) => void;
  onStartDriving: () => void;
}) {
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const [completing, setCompleting] = useState<{ id: string; value: string } | null>(null);
  const [adding, setAdding] = useState<{ q: string; jobId: JobId; results: GeocodeResult[]; loading: boolean }>({
    q: "",
    jobId: jobs[0]?.id || "ozon",
    results: [],
    loading: false,
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (adding.q.trim().length < 3) {
      setAdding((s) => ({ ...s, results: [] }));
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const c = new AbortController();
    abortRef.current = c;
    setAdding((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      searchAddress(adding.q, c.signal)
        .then((r) => setAdding((s) => ({ ...s, results: r, loading: false })))
        .catch(() => setAdding((s) => ({ ...s, loading: false })));
    }, 350);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [adding.q]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2.5 border-b border-border space-y-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <input
            value={adding.q}
            onChange={(e) => setAdding((s) => ({ ...s, q: e.target.value }))}
            placeholder="вписать адрес заказа…"
            className="flex-1 h-9 px-2.5 rounded-md border border-border bg-background text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/40"
          />
          <select
            value={adding.jobId}
            onChange={(e) => setAdding((s) => ({ ...s, jobId: e.target.value as JobId }))}
            className="h-9 px-2 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:border-foreground/40"
          >
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.short}
              </option>
            ))}
          </select>
        </div>
        {adding.q.trim().length >= 3 && (
          <div className="rounded-md border border-border max-h-[160px] overflow-y-auto bg-popover">
            {adding.loading && (
              <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                ищу…
              </div>
            )}
            {!adding.loading && adding.results.length === 0 && (
              <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">
                ничего не найдено
              </div>
            )}
            {adding.results.map((r, i) => (
              <button
                key={i}
                onClick={() => {
                  onAdd(r, adding.jobId);
                  setAdding({ q: "", jobId: adding.jobId, results: [], loading: false });
                }}
                className="w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-muted transition-colors border-b border-border last:border-b-0"
              >
                <div className="text-foreground truncate">{r.shortName}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {r.displayName}
                </div>
              </button>
            ))}
          </div>
        )}

        {pending.length >= 1 && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="маршрут"
                value={pendingKm > 0 ? `${pendingKm.toFixed(1)} км` : "—"}
              />
              <Stat
                label="заработок"
                value={pendingPotentialRub > 0 ? `${pendingPotentialRub} ₽` : "—"}
              />
            </div>
            <button
              onClick={onStartDriving}
              className="w-full h-12 rounded-md bg-primary text-primary-foreground text-[13px] font-semibold uppercase tracking-[0.2em] active:scale-[0.98] transition-transform"
            >
              ▶ поехали
            </button>
          </>
        )}
      </div>

      {pending.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            добавь адреса заказов
            <br />
            <span className="text-muted-foreground/70 text-[10px]">
              маршрут построится автоматически от депо
            </span>
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-border">
          {pending.map((p, i) => {
            const job = jobMap.get(p.jobId);
            const isCompleting = completing?.id === p.id;
            const prev =
              i === 0
                ? null
                : { lat: pending[i - 1].lat, lng: pending[i - 1].lng };
            const distFromPrev = prev
              ? haversineKm(prev, { lat: p.lat, lng: p.lng })
              : 0;
            return (
              <li
                key={p.id}
                className={cn(
                  "px-4 py-2.5 flex items-start gap-3 hover-elevate group cursor-pointer",
                  selectedId === p.id && "bg-foreground/[0.04]",
                  i === 0 && "bg-foreground/[0.02]",
                )}
                onClick={() => onSelect(p.id, p.lat, p.lng)}
              >
                <span
                  className={cn(
                    "text-[11px] tabular-nums w-5 mt-0.5 font-semibold",
                    i === 0 ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] text-foreground truncate">
                      {p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`}
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                      {job?.short}
                      {i > 0 && <> · {distFromPrev.toFixed(1)} км</>}
                      {i === 0 && <> · от депо</>}
                    </span>
                  </div>
                  {isCompleting ? (
                    <form
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = Number(completing!.value);
                        if (!Number.isFinite(v) || v <= 0) return;
                        onComplete(p.id, v);
                        setCompleting(null);
                      }}
                      className="mt-1.5 flex items-center gap-1.5"
                    >
                      <input
                        autoFocus
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={completing!.value}
                        onChange={(e) =>
                          setCompleting((c) =>
                            c ? { ...c, value: e.target.value.replace(/\D/g, "") } : c,
                          )
                        }
                        placeholder="сумма ₽"
                        className="flex-1 h-7 px-2 rounded-md border border-border bg-background text-[11px] tabular-nums focus:outline-none focus:border-foreground/40"
                      />
                      <button
                        type="submit"
                        className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-[10px] uppercase tracking-[0.18em]"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={() => setCompleting(null)}
                        className="h-7 px-2 rounded-md border border-border text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
                      >
                        ×
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-1.5 mt-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const rate = p.priceRub ?? job?.perOrderRateRub ?? 0;
                          setCompleting({
                            id: p.id,
                            value: rate > 0 ? String(rate) : "",
                          });
                        }}
                        className="text-[10px] uppercase tracking-[0.18em] text-foreground hover:text-foreground/80"
                      >
                        ✓ доставлено
                      </button>
                      <span className="text-muted-foreground/50">·</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(p.id);
                        }}
                        className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-destructive"
                      >
                        удалить
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddDeliveryDialog({
  lat,
  lng,
  address,
  jobs,
  onCancel,
  onSubmitDelivery,
  onSubmitPending,
}: {
  lat: number;
  lng: number;
  address?: string;
  jobs: ResolvedJob[];
  onCancel: () => void;
  onSubmitDelivery: (jobId: JobId, amount: number) => void;
  onSubmitPending: (jobId: JobId) => void;
}) {
  const initialJob = jobs[0]?.id || "ozon";
  const [jobId, setJobId] = useState<JobId>(initialJob);
  const initialJobObj = jobs.find((j) => j.id === initialJob);
  const [amount, setAmount] = useState(
    initialJobObj && initialJobObj.perOrderRateRub > 0
      ? String(initialJobObj.perOrderRateRub)
      : "",
  );

  // re-fill amount default when job changes
  useEffect(() => {
    const job = jobs.find((j) => j.id === jobId);
    if (job && job.perOrderRateRub > 0) setAmount(String(job.perOrderRateRub));
  }, [jobId, jobs]);

  return (
    <div
      className="fixed inset-0 z-[1000] bg-black/70 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="rounded-2xl border border-border bg-card w-full max-w-[400px] p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            новая точка
          </span>
          <button
            onClick={onCancel}
            className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
          >
            закрыть
          </button>
        </div>

        <div className="text-[11px] text-foreground">
          {address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`}
        </div>

        <div className="flex items-center gap-1.5">
          {jobs.map((j) => (
            <button
              key={j.id}
              onClick={() => setJobId(j.id)}
              className={cn(
                "h-9 flex-1 rounded-md text-[11px] font-medium uppercase tracking-[0.18em] transition-colors border",
                jobId === j.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {j.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onSubmitPending(jobId)}
          className="w-full h-11 rounded-md bg-primary text-primary-foreground text-[12px] font-semibold uppercase tracking-[0.2em]"
        >
          + в маршрут
        </button>

        <div className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground text-center pt-1">
          или сразу отметить как доставленное
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(amount);
            if (!Number.isFinite(v) || v <= 0) return;
            onSubmitDelivery(jobId, v);
          }}
        >
          <div className="flex items-center gap-2">
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="сумма ₽"
              className="flex-1 h-10 px-3 rounded-md border border-border bg-background text-[14px] tabular-nums focus:outline-none focus:border-foreground/40"
            />
            <button
              type="submit"
              disabled={!amount || Number(amount) <= 0}
              className="h-10 px-4 rounded-md border border-border text-[11px] font-medium uppercase tracking-[0.2em] text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ✓ доставлено
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DepotEditDialog({
  depot,
  onCancel,
  onSubmit,
}: {
  depot: Depot;
  onCancel: () => void;
  onSubmit: (d: Partial<Depot>) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    const t = setTimeout(() => {
      searchAddress(query, c.signal)
        .then((r) => setResults(r))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 350);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [query]);

  return (
    <div
      className="fixed inset-0 z-[1000] bg-black/70 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="rounded-2xl border border-border bg-card w-full max-w-[420px] p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            ⌂ депо · откуда стартуешь
          </span>
          <button
            onClick={onCancel}
            className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
          >
            закрыть
          </button>
        </div>
        <div className="rounded-md border border-border px-3 py-2 text-[11px]">
          <div className="text-muted-foreground text-[9px] uppercase tracking-[0.2em]">
            сейчас
          </div>
          <div className="text-foreground">{depot.address}</div>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="новый адрес производства…"
          className="w-full h-10 px-3 rounded-md border border-border bg-background text-[12px] focus:outline-none focus:border-foreground/40"
        />
        {(results.length > 0 || loading) && (
          <div className="rounded-md border border-border max-h-[260px] overflow-y-auto bg-popover">
            {loading && (
              <div className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                ищу…
              </div>
            )}
            {!loading &&
              results.map((r, i) => (
                <button
                  key={i}
                  onClick={() =>
                    onSubmit({
                      lat: r.lat,
                      lng: r.lng,
                      address: r.shortName,
                    })
                  }
                  className="w-full text-left px-3 py-2 text-[11px] hover:bg-muted transition-colors border-b border-border last:border-b-0"
                >
                  <div className="text-foreground truncate">{r.shortName}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {r.displayName}
                  </div>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

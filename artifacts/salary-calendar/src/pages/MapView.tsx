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
import {
  useWavesStore,
  pendingStops,
  type Wave,
  type WaveStop,
} from "@/lib/waves";
import { searchAddress, reverseGeocode, type GeocodeResult } from "@/lib/geocode";
import {
  optimizeRoute,
  makeMatrixDistFn,
} from "@/lib/route-optimizer";
import { useGeolocation } from "@/lib/geolocation";
import { useRoute, useDistanceMatrix, useRoutingProfile } from "@/lib/use-route";
import {
  PROFILE_LABELS,
  setRoutingProfile,
  type RouteProfile,
} from "@/lib/routing";
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
  const wavesStore = useWavesStore(salary.depot);

  // The pending list = pending stops of the ACTIVE wave (the one being filled
  // / driven). Selecting a finished wave does NOT change what's pending.
  const pending: WaveStop[] = useMemo(
    () => pendingStops(wavesStore.activeWave),
    [wavesStore.activeWave],
  );

  // Wave shown on the map: active by default, or a finished one if the user
  // opened its tab. Used to render historical route geometry.
  const visibleWave = wavesStore.visibleWave;
  const isViewingFinishedWave =
    !!visibleWave && !!visibleWave.finishedAt && visibleWave.id !== wavesStore.activeWave?.id;

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
    () => pending.map((p) => p.id).slice().sort().join(","),
    [pending],
  );

  // Real road distance matrix from depot through all pending stops.
  const matrixPoints = useMemo(() => {
    if (pending.length < 2) return null;
    return [
      { id: "__start__", lat: salary.depot.lat, lng: salary.depot.lng },
      ...pending.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
    ];
  }, [pending, salary.depot.lat, salary.depot.lng]);

  const matrix = useDistanceMatrix(matrixPoints);

  useEffect(() => {
    if (pending.length < 2) return;
    const start = { lat: salary.depot.lat, lng: salary.depot.lng };
    const dist = matrix.durations
      ? makeMatrixDistFn(matrix.ids, matrix.durations)
      : undefined;
    // Full optimizer: nearest-neighbor seed → 2-opt → or-opt → far-first
    // orientation. `dist` is the real OSRM duration matrix when loaded,
    // haversine fallback otherwise.
    const refined = optimizeRoute(start, pending, dist, { farFirst: true });
    const newOrder = refined.map((p) => p.id);
    const curOrder = pending.map((p) => p.id);
    if (newOrder.join("|") !== curOrder.join("|")) {
      wavesStore.reorderStops(newOrder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIdsKey, salary.depot.lat, salary.depot.lng, matrix.durations]);

  // Real road geometry for the planned pending route (depot → all stops) of
  // the active wave. Always fetched while the active wave has pending stops.
  const pendingRoutePoints = useMemo(() => {
    if (pending.length === 0) return null;
    return [
      { lat: salary.depot.lat, lng: salary.depot.lng },
      ...pending.map((p) => ({ lat: p.lat, lng: p.lng })),
    ];
  }, [pending, salary.depot.lat, salary.depot.lng]);

  const pendingRoute = useRoute(pendingRoutePoints);

  // Persist the active wave's planned route geometry so it survives reload
  // and remains viewable as a finished wave.
  useEffect(() => {
    const r = pendingRoute.route;
    if (!r || !wavesStore.activeWave || pending.length === 0) return;
    wavesStore.saveDeliveryRoute(r.geometry, r.distance, r.duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRoute.route]);

  // Auto-finish the active wave once every stop is resolved. Without this the
  // wave gets stuck in an "all delivered but not finalised" limbo: it does not
  // appear in the "готово" tab and its markers + route stay glued to the map.
  // We skip the check while DriveMode is open because it relies on the active
  // wave to drive the return-to-depot leg; the same auto-finish then fires the
  // moment the user closes DriveMode.
  useEffect(() => {
    if (driving) return;
    const aw = wavesStore.activeWave;
    if (!aw) return;
    const pendingCount = aw.stops.filter((s) => s.status === "pending").length;
    const doneCount = aw.stops.filter((s) => s.status === "delivered").length;
    if (pendingCount === 0 && doneCount > 0) {
      wavesStore.finishActiveWave();
    }
  }, [driving, wavesStore.activeWave, wavesStore]);

  const visibleDeliveries = useMemo(
    () =>
      deliveriesStore.deliveries
        .filter((d) => (filterJob ? d.jobId === filterJob : true))
        .filter((d) => rangeMatches(range, queryDate, d.timestamp)),
    [deliveriesStore.deliveries, filterJob, range, queryDate],
  );

  // Set of delivery IDs that belong to a FINISHED wave. These are hidden
  // from the map by default — the user re-summons them by clicking the
  // corresponding wave card in the "готово" tab.
  const finishedWaveDeliveryIds = useMemo(() => {
    const set = new Set<string>();
    for (const w of wavesStore.finishedWaves) {
      for (const s of w.stops) if (s.deliveryId) set.add(s.deliveryId);
    }
    return set;
  }, [wavesStore.finishedWaves]);

  // What actually goes on the map. Three modes:
  //  • A finished wave is selected → ONLY that wave's deliveries (matched by
  //    deliveryId or coordinates).
  //  • No wave selected → strip out all finished-wave deliveries so the map
  //    shows just the active wave + orphan history.
  //  • While inside the active wave → everything visible (current behavior).
  const mapDeliveries = useMemo(() => {
    if (isViewingFinishedWave && visibleWave) {
      return visibleDeliveries.filter(
        (d) =>
          !!visibleWave.stops.find(
            (s) => s.deliveryId === d.id || (s.lat === d.lat && s.lng === d.lng),
          ),
      );
    }
    return visibleDeliveries.filter((d) => !finishedWaveDeliveryIds.has(d.id));
  }, [visibleDeliveries, isViewingFinishedWave, visibleWave, finishedWaveDeliveryIds]);

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
    if (pending.length === 0) return 0;
    if (pendingRoute.route) return pendingRoute.route.distance / 1000;
    const points = [
      { lat: salary.depot.lat, lng: salary.depot.lng },
      ...pending.map((p) => ({ lat: p.lat, lng: p.lng })),
    ];
    return totalRouteKm(points);
  }, [pending, salary.depot, pendingRoute.route]);

  const pendingPotentialRub = useMemo(() => {
    let sum = 0;
    for (const p of pending) {
      const job = salary.jobs.find((j) => j.id === p.jobId);
      const rate = p.priceRub ?? job?.perOrderRateRub ?? 0;
      sum += rate;
    }
    return sum;
  }, [pending, salary.jobs]);

  // Bridge: complete a pending stop → write to delivery history AND mark
  // the wave's stop as delivered (so calendar earnings stay correct).
  const completePendingStop = useCallback(
    (id: string, amount: number) => {
      const target = pending.find((p) => p.id === id);
      if (!target) return;
      const d = deliveriesStore.addDelivery({
        jobId: target.jobId,
        amountRub: amount,
        lat: target.lat,
        lng: target.lng,
        address: target.address,
        timestamp: Date.now(),
      });
      wavesStore.completeStop(id, amount, d.id);
    },
    [pending, deliveriesStore, wavesStore],
  );

  // Reverse of completePendingStop. Used by the "↻ отменить" toast that the
  // drive screen pops up after the LAST "доставлено" tap.
  const undoCompletePendingStop = useCallback(
    (id: string) => {
      const wave = wavesStore.activeWave;
      const stop = wave?.stops.find((s) => s.id === id);
      if (!stop) return;
      if (stop.deliveryId) {
        deliveriesStore.removeDelivery(stop.deliveryId);
      }
      wavesStore.undoCompleteStop(id);
    },
    [wavesStore, deliveriesStore],
  );

  // Translate a wave's pending stop into the legacy PendingOrder shape used
  // throughout the existing UI components without changing their signatures.
  const pendingForUi: PendingOrder[] = useMemo(
    () =>
      pending.map((s) => ({
        id: s.id,
        jobId: s.jobId,
        lat: s.lat,
        lng: s.lng,
        address: s.address,
        priceRub: s.priceRub,
        createdAt: s.createdAt,
      })),
    [pending],
  );

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
        pending={pendingForUi}
        jobs={salary.jobs}
        depot={salary.depot}
        theme={salary.theme}
        onExit={() => setDriving(false)}
        onCompleteStop={(id, amount) => {
          completePendingStop(id, amount);
        }}
        onUndoCompleteStop={(id) => {
          undoCompletePendingStop(id);
        }}
        onSkipStop={(id) => {
          // move to end of queue (keeps stop in active wave)
          const ids = pending.map((p) => p.id);
          const next = ids.filter((x) => x !== id).concat([id]);
          wavesStore.reorderStops(next);
        }}
        onSaveDeliveryRoute={(g, dM, dS) => wavesStore.saveDeliveryRoute(g, dM, dS)}
        onSaveReturnRoute={(g, dM, dS) => wavesStore.saveReturnRoute(g, dM, dS)}
        onFinishWave={() => wavesStore.finishActiveWave()}
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
            <ProfileChip />
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
            deliveries={mapDeliveries}
            pending={isViewingFinishedWave ? [] : pendingForUi}
            jobs={salary.jobs}
            theme={salary.theme}
            depot={salary.depot}
            userPosition={userPosition}
            followUser={false}
            onMapClick={isViewingFinishedWave ? undefined : handleMapClick}
            onDeliveryClick={(id) => setSelectedId(id)}
            onPendingClick={(id) => setSelectedId(id)}
            selectedId={selectedId}
            flyTo={flyTo}
            showRoute={showRoute}
            showPendingRoute={!isViewingFinishedWave}
            pendingRouteGeometry={
              isViewingFinishedWave
                ? visibleWave?.delivery?.geometry ?? null
                : pendingRoute.route?.geometry ?? null
            }
          />
          <WaveTabs
            activeWave={wavesStore.activeWave}
            selectedWaveId={wavesStore.selectedWaveId}
            onClearSelection={() => wavesStore.setSelectedWaveId(null)}
            onFinishActive={() => wavesStore.finishActiveWave()}
            onStartNew={() => wavesStore.startNewWave()}
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
          pending={pendingForUi}
          selectedId={selectedId}
          shifts={salary.shifts}
          onSetShiftActive={salary.setShiftActive}
          isShiftActive={salary.isShiftActive}
          finishedWaves={wavesStore.finishedWaves}
          selectedWaveId={wavesStore.selectedWaveId}
          onSelectWave={(id) => wavesStore.setSelectedWaveId(id)}
          onReopenWave={(id) => wavesStore.reopenWave(id)}
          onDeleteWave={(id) => wavesStore.deleteWave(id)}
          onSelect={(id, lat, lng) => {
            setSelectedId(id);
            setFlyTo({ lat, lng, zoom: 16 });
          }}
          onRemoveDelivery={(id) => deliveriesStore.removeDelivery(id)}
          onRemovePending={(id) => wavesStore.removeStop(id)}
          onCompletePending={(id, amount) => completePendingStop(id, amount)}
          onAddPendingFromAddress={(r, jobId) => {
            const job = salary.jobs.find((j) => j.id === jobId);
            wavesStore.ensureActiveWave();
            const stop = wavesStore.addStop({
              jobId,
              lat: r.lat,
              lng: r.lng,
              address: r.shortName,
              priceRub: job?.perOrderRateRub,
            });
            return {
              id: stop.id,
              jobId: stop.jobId,
              lat: stop.lat,
              lng: stop.lng,
              address: stop.address,
              priceRub: stop.priceRub,
              createdAt: stop.createdAt,
            } as PendingOrder;
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
            wavesStore.ensureActiveWave();
            const stop = wavesStore.addStop({
              jobId,
              lat: addingPoint.lat,
              lng: addingPoint.lng,
              address: addingPoint.address,
              priceRub: job?.perOrderRateRub,
            });
            setSelectedId(stop.id);
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

const PROFILE_KEY = "salary-calendar:routing-profile:v1";
const PROFILE_GLYPH: Record<RouteProfile, string> = {
  bike: "🚲",
  car: "🚗",
};
const PROFILE_ORDER: RouteProfile[] = ["bike", "car"];

function ProfileChip() {
  const profile = useRoutingProfile();
  // One-time hydration from localStorage so the user's last choice survives
  // reloads. We do this in a layout-safe effect so the first render always
  // matches SSR-equivalent state.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw === "bike" || raw === "car") {
        setRoutingProfile(raw);
      } else if (raw === "foot") {
        setRoutingProfile("bike");
        localStorage.setItem(PROFILE_KEY, "bike");
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cycle = () => {
    const i = PROFILE_ORDER.indexOf(profile);
    const next = PROFILE_ORDER[(i + 1) % PROFILE_ORDER.length];
    setRoutingProfile(next);
    try {
      localStorage.setItem(PROFILE_KEY, next);
    } catch {}
  };
  return (
    <button
      onClick={cycle}
      className="h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] rounded-md border border-border hover:bg-muted transition-colors flex items-center gap-1.5"
      title={`Профиль маршрута: ${PROFILE_LABELS[profile]} — нажми чтобы переключить`}
    >
      <span>{PROFILE_GLYPH[profile]}</span>
      <span className="text-muted-foreground">{PROFILE_LABELS[profile]}</span>
    </button>
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
  finishedWaves: Wave[];
  selectedWaveId: string | null;
  onSelectWave: (id: string | null) => void;
  onReopenWave: (id: string) => void;
  onDeleteWave: (id: string) => void;
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
  // If a finished wave gets selected from outside (e.g. via DriveMode), jump
  // to the "готово" tab automatically so the user sees what's highlighted.
  useEffect(() => {
    if (props.selectedWaveId) setTab("done");
  }, [props.selectedWaveId]);
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
          готово · {props.finishedWaves.length}
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
        <FinishedWavesList
          waves={props.finishedWaves}
          selectedWaveId={props.selectedWaveId}
          jobs={props.jobs}
          onSelect={props.onSelectWave}
          onReopen={props.onReopenWave}
          onDelete={props.onDeleteWave}
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

function FinishedWavesList({
  waves,
  selectedWaveId,
  jobs,
  onSelect,
  onReopen,
  onDelete,
}: {
  waves: Wave[];
  selectedWaveId: string | null;
  jobs: ResolvedJob[];
  onSelect: (id: string | null) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  if (waves.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center">
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          ещё нет завершённых волн
          <br />
          <span className="text-muted-foreground/70 text-[10px]">
            закончи текущую волну, чтобы она появилась здесь
          </span>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex-1 overflow-y-auto divide-y divide-border">
      {waves.map((w, i) => {
        const sel = selectedWaveId === w.id;
        const delivered = w.stops.filter((s) => s.status === "delivered");
        const total = w.stops.length;
        const earnings = delivered.reduce((sum, s) => {
          if (typeof s.amountRub === "number") return sum + s.amountRub;
          const job = jobMap.get(s.jobId);
          return sum + (s.priceRub ?? job?.perOrderRateRub ?? 0);
        }, 0);
        const km = w.delivery?.distanceM ? w.delivery.distanceM / 1000 : null;
        const finishedAt = w.finishedAt ? new Date(w.finishedAt) : null;
        const startedAt = new Date(w.startedAt);
        // Wave numbers count from oldest = 1; the array is newest-first.
        const waveNumber = waves.length - i;
        return (
          <li key={w.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => onSelect(sel ? null : w.id)}
              className={cn(
                "w-full text-left px-4 py-3 flex flex-col gap-1.5 transition-colors",
                sel ? "bg-foreground/[0.06]" : "hover:bg-muted/40",
              )}
              title={sel ? "Скрыть с карты" : "Показать маршрут на карте"}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] font-semibold text-foreground">
                  волна {waveNumber}
                  {sel && (
                    <span className="ml-2 text-[9px] text-primary">● на карте</span>
                  )}
                </span>
                <span className="text-[12px] font-semibold tabular-nums">
                  {Math.round(earnings)} ₽
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground tabular-nums">
                <span>
                  {format(startedAt, "d MMM", { locale: ru })}
                  {finishedAt && (
                    <>
                      {" · "}
                      {format(startedAt, "HH:mm", { locale: ru })}–
                      {format(finishedAt, "HH:mm", { locale: ru })}
                    </>
                  )}
                </span>
                <span>
                  {delivered.length}/{total} точек
                  {km !== null && <> · {km.toFixed(1)} км</>}
                </span>
              </div>
            </button>
            {sel && (
              <div className="px-4 pb-3 pt-1 flex items-center gap-2 bg-foreground/[0.06]">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(null);
                  }}
                  className="h-7 px-2.5 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Скрыть маршрут с карты"
                >
                  ✕ скрыть
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReopen(w.id);
                  }}
                  className="h-7 px-2.5 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Вернуть как активную волну"
                >
                  ↻ возобновить
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Удалить эту волну из архива?")) onDelete(w.id);
                  }}
                  className="h-7 px-2.5 text-[10px] uppercase tracking-[0.18em] rounded-md border border-border text-red-500 hover:bg-muted ml-auto transition-colors"
                  title="Удалить из архива"
                >
                  удалить
                </button>
              </div>
            )}
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

// Slim floating bar over the map: shows the ACTIVE wave indicator + start/
// finish controls, and a "back to active" button when the user is previewing
// a finished wave from the "готово" tab. Finished-wave chips themselves now
// live in the sidebar's "готово" tab.
function WaveTabs({
  activeWave,
  selectedWaveId,
  onClearSelection,
  onFinishActive,
  onStartNew,
}: {
  activeWave: Wave | null;
  selectedWaveId: string | null;
  onClearSelection: () => void;
  onFinishActive: () => void;
  onStartNew: () => void;
}) {
  const activePending = activeWave?.stops.filter((s) => s.status === "pending").length ?? 0;
  const activeDone = activeWave?.stops.filter((s) => s.status === "delivered").length ?? 0;
  const previewingFinished = !!selectedWaveId;

  // If there's nothing to show, render nothing.
  if (!activeWave && !previewingFinished) return null;

  return (
    <div className="absolute top-3 left-3 right-3 z-[450] pointer-events-none">
      <div className="pointer-events-auto rounded-md bg-background/90 backdrop-blur-sm border border-border shadow-lg overflow-x-auto">
        <div className="flex items-stretch divide-x divide-border min-w-min">
          {previewingFinished && (
            <button
              onClick={onClearSelection}
              className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 whitespace-nowrap text-primary hover:bg-muted transition-colors"
              title="Скрыть архивную волну с карты"
            >
              ← к активной
            </button>
          )}
          {activeWave && (
            <div
              className={cn(
                "px-3 py-2 text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 whitespace-nowrap",
                previewingFinished ? "text-muted-foreground" : "text-foreground",
              )}
              title="Текущая волна заказов"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold">волна · в работе</span>
              <span className="opacity-70">
                {activeDone}/{activeDone + activePending}
              </span>
            </div>
          )}
          <div className="ml-auto flex items-stretch divide-x divide-border">
            {activeWave && activePending === 0 && activeDone > 0 && (
              <button
                onClick={onFinishActive}
                className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400 hover:bg-muted whitespace-nowrap"
                title="Завершить текущую волну (она появится во вкладке «готово»)"
              >
                ✓ завершить волну
              </button>
            )}
            {activeWave && activePending > 0 && (
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Завершить текущую волну? Невыполненные точки останутся в архиве этой волны.",
                    )
                  ) {
                    onFinishActive();
                  }
                }}
                className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground hover:bg-muted whitespace-nowrap"
                title="Завершить волну, даже если есть невыполненные точки"
              >
                завершить
              </button>
            )}
            {!activeWave && (
              <button
                onClick={onStartNew}
                className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-foreground hover:bg-muted whitespace-nowrap"
                title="Начать новую волну заказов"
              >
                + новая волна
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

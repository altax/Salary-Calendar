import { useState, useEffect, useCallback } from "react";
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  differenceInCalendarDays,
  setDate,
  parseISO,
} from "date-fns";

const ENTRIES_V2_KEY = "salary-calendar:entries:v2";
const ENTRIES_V3_KEY = "salary-calendar:entries:v3";
const CURRENCY_KEY = "salary-calendar:currency:v2";
const RATES_KEY = "salary-calendar:rates:v1";
const OBLIGATIONS_KEY = "salary-calendar:obligations:v1";
const SCHEDULE_LEGACY_KEY = "salary-calendar:schedule:v1";
const SCHEDULE_ANCHORS_KEY = "salary-calendar:schedule-anchors:v1";
const SCHEDULE_OVERRIDES_KEY = "salary-calendar:schedule-overrides:v1";
const GOAL_KEY = "salary-calendar:goal:v1";
const THEME_KEY = "salary-calendar:theme:v1";

export type SchedulePattern = { work: number; off: number };
export type Theme = "dark" | "light";

export const SCHEDULE_PATTERNS: { id: string; label: string; pattern: SchedulePattern }[] = [
  { id: "2/2", label: "2/2", pattern: { work: 2, off: 2 } },
  { id: "3/3", label: "3/3", pattern: { work: 3, off: 3 } },
  { id: "5/2", label: "5/2", pattern: { work: 5, off: 2 } },
  { id: "1/3", label: "1/3", pattern: { work: 1, off: 3 } },
];

export type Obligation = {
  id: string;
  name: string;
  amountRub: number;
};

function loadObligations(): Obligation[] {
  try {
    const raw = localStorage.getItem(OBLIGATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Obligation[];
  } catch {}
  return [];
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export type Currency = "RUB" | "USD" | "EUR";
export type JobId = "ozon" | "dostaevsky";

export type DayEntry = Partial<Record<JobId, number>>;
export type Entries = Record<string, DayEntry>;

export type ScheduleAnchor = {
  anchorIso: string;
  pattern: SchedulePattern;
};
export type ScheduleAnchors = Partial<Record<JobId, ScheduleAnchor>>;
export type ScheduleOverrides = Record<string, Partial<Record<JobId, boolean>>>;

function loadScheduleAnchors(): ScheduleAnchors {
  try {
    const raw = localStorage.getItem(SCHEDULE_ANCHORS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ScheduleAnchors;
  } catch {}
  return {};
}

function loadScheduleOverrides(): ScheduleOverrides {
  try {
    const raw = localStorage.getItem(SCHEDULE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ScheduleOverrides;
  } catch {}
  return {};
}

function loadGoal(): number | null {
  try {
    const raw = localStorage.getItem(GOAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed === "number" && parsed > 0) return parsed;
  } catch {}
  return null;
}

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {}
  return "dark";
}

export const JOBS: { id: JobId; short: string; label: string }[] = [
  { id: "ozon", short: "о", label: "Озон ПВЗ" },
  { id: "dostaevsky", short: "д", label: "Достаевский" },
];

const ALLOWED: Currency[] = ["RUB", "USD", "EUR"];

type Rates = {
  base: "RUB";
  values: Record<Currency, number>;
  fetchedAt: number;
};

const FALLBACK_RATES: Rates = {
  base: "RUB",
  values: { RUB: 1, USD: 1 / 92, EUR: 1 / 100 },
  fetchedAt: 0,
};

const RATE_TTL_MS = 6 * 60 * 60 * 1000;

function loadCachedRates(): Rates {
  try {
    const raw = localStorage.getItem(RATES_KEY);
    if (!raw) return FALLBACK_RATES;
    const parsed = JSON.parse(raw) as Rates;
    if (parsed?.values?.RUB && parsed?.values?.USD && parsed?.values?.EUR) {
      return parsed;
    }
  } catch {}
  return FALLBACK_RATES;
}

async function fetchRates(): Promise<Rates | null> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) return null;
    const data = await res.json();
    const usdToRub = data?.rates?.RUB as number | undefined;
    const usdToEur = data?.rates?.EUR as number | undefined;
    if (!usdToRub || !usdToEur) return null;
    return {
      base: "RUB",
      values: {
        RUB: 1,
        USD: 1 / usdToRub,
        EUR: usdToEur / usdToRub,
      },
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function loadEntries(): Entries {
  try {
    const v3 = localStorage.getItem(ENTRIES_V3_KEY);
    if (v3) return JSON.parse(v3) as Entries;
    const v2 = localStorage.getItem(ENTRIES_V2_KEY);
    if (v2) {
      const old = JSON.parse(v2) as Record<string, number>;
      const migrated: Entries = {};
      for (const [k, v] of Object.entries(old)) {
        if (typeof v === "number" && v > 0) migrated[k] = { ozon: v };
      }
      return migrated;
    }
  } catch {}
  return {};
}

export function dayTotal(entry: DayEntry | undefined): number {
  if (!entry) return 0;
  let sum = 0;
  for (const job of JOBS) {
    const v = entry[job.id];
    if (typeof v === "number") sum += v;
  }
  return sum;
}

/** Pure helper: is the given day a scheduled work day for the job? */
export function isScheduledByAnchor(
  date: Date,
  anchor: ScheduleAnchor | undefined,
): boolean {
  if (!anchor) return false;
  const cycle = anchor.pattern.work + anchor.pattern.off;
  if (cycle <= 0) return false;
  const anchorDate = parseISO(anchor.anchorIso);
  const diff = differenceInCalendarDays(date, anchorDate);
  // Use modulo that handles negative diffs (cycle continues backwards too)
  const mod = ((diff % cycle) + cycle) % cycle;
  return mod < anchor.pattern.work;
}

export function useSalaryStore() {
  const [entries, setEntries] = useState<Entries>(() => loadEntries());

  const [currency, setCurrencyState] = useState<Currency>(() => {
    const stored = localStorage.getItem(CURRENCY_KEY);
    if (stored && (ALLOWED as string[]).includes(stored)) {
      return stored as Currency;
    }
    return "RUB";
  });

  const [rates, setRates] = useState<Rates>(() => loadCachedRates());
  const [obligations, setObligations] = useState<Obligation[]>(() =>
    loadObligations(),
  );
  const [scheduleAnchors, setScheduleAnchors] = useState<ScheduleAnchors>(
    () => loadScheduleAnchors(),
  );
  const [scheduleOverrides, setScheduleOverrides] = useState<ScheduleOverrides>(
    () => loadScheduleOverrides(),
  );
  const [goalRub, setGoalRub] = useState<number | null>(() => loadGoal());
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());

  // Apply theme to <html> root
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  // One-time cleanup of legacy schedule key
  useEffect(() => {
    try {
      localStorage.removeItem(SCHEDULE_LEGACY_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(ENTRIES_V3_KEY, JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(CURRENCY_KEY, currency);
  }, [currency]);

  useEffect(() => {
    localStorage.setItem(OBLIGATIONS_KEY, JSON.stringify(obligations));
  }, [obligations]);

  useEffect(() => {
    localStorage.setItem(SCHEDULE_ANCHORS_KEY, JSON.stringify(scheduleAnchors));
  }, [scheduleAnchors]);

  useEffect(() => {
    localStorage.setItem(SCHEDULE_OVERRIDES_KEY, JSON.stringify(scheduleOverrides));
  }, [scheduleOverrides]);

  useEffect(() => {
    if (goalRub == null) localStorage.removeItem(GOAL_KEY);
    else localStorage.setItem(GOAL_KEY, JSON.stringify(goalRub));
  }, [goalRub]);

  useEffect(() => {
    const cached = loadCachedRates();
    const isStale =
      !cached.fetchedAt || Date.now() - cached.fetchedAt > RATE_TTL_MS;
    if (!isStale) return;
    let cancelled = false;
    fetchRates().then((next) => {
      if (cancelled || !next) return;
      setRates(next);
      try {
        localStorage.setItem(RATES_KEY, JSON.stringify(next));
      } catch {}
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrency = (next: string) => {
    if ((ALLOWED as string[]).includes(next)) {
      setCurrencyState(next as Currency);
    }
  };

  const setTheme = (next: Theme) => setThemeState(next);
  const toggleTheme = () =>
    setThemeState((t) => (t === "dark" ? "light" : "dark"));

  const convert = useCallback(
    (amount: number, from: Currency, to: Currency) => {
      if (from === to) return amount;
      const amountInRub = from === "RUB" ? amount : amount / rates.values[from];
      return to === "RUB" ? amountInRub : amountInRub * rates.values[to];
    },
    [rates],
  );

  const setDayEntries = (
    dateIso: string,
    amountsInDisplay: Partial<Record<JobId, number>>,
    displayCurrency: Currency,
  ) => {
    const next: DayEntry = {};
    for (const job of JOBS) {
      const raw = amountsInDisplay[job.id];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        continue;
      const inRub =
        displayCurrency === "RUB" ? raw : raw / rates.values[displayCurrency];
      next[job.id] = Math.round(inRub * 100) / 100;
    }
    setEntries((prev) => {
      const updated = { ...prev };
      if (Object.keys(next).length === 0) {
        delete updated[dateIso];
      } else {
        updated[dateIso] = next;
      }
      return updated;
    });
  };

  const addObligation = (
    name: string,
    amountInDisplay: number,
    displayCurrency: Currency,
  ) => {
    const trimmed = name.trim();
    if (!trimmed || !Number.isFinite(amountInDisplay) || amountInDisplay <= 0)
      return;
    const amountRub =
      displayCurrency === "RUB"
        ? amountInDisplay
        : amountInDisplay / rates.values[displayCurrency];
    setObligations((prev) => [
      ...prev,
      {
        id: makeId(),
        name: trimmed,
        amountRub: Math.round(amountRub * 100) / 100,
      },
    ]);
  };

  const updateObligation = (
    id: string,
    name: string,
    amountInDisplay: number,
    displayCurrency: Currency,
  ) => {
    const trimmed = name.trim();
    if (!trimmed || !Number.isFinite(amountInDisplay) || amountInDisplay <= 0)
      return;
    const amountRub =
      displayCurrency === "RUB"
        ? amountInDisplay
        : amountInDisplay / rates.values[displayCurrency];
    setObligations((prev) =>
      prev.map((o) =>
        o.id === id
          ? { ...o, name: trimmed, amountRub: Math.round(amountRub * 100) / 100 }
          : o,
      ),
    );
  };

  const removeObligation = (id: string) => {
    setObligations((prev) => prev.filter((o) => o.id !== id));
  };

  const setGoal = (amountInDisplay: number, displayCurrency: Currency) => {
    if (!Number.isFinite(amountInDisplay) || amountInDisplay <= 0) {
      setGoalRub(null);
      return;
    }
    const amountRub =
      displayCurrency === "RUB"
        ? amountInDisplay
        : amountInDisplay / rates.values[displayCurrency];
    setGoalRub(Math.round(amountRub * 100) / 100);
  };

  const clearGoal = () => setGoalRub(null);

  /**
   * Set/replace the rolling schedule anchor for a job. The anchor is
   * `startDayInMonth` of `monthDate` and the cycle continues forwards
   * AND backwards from there indefinitely.
   */
  const applyScheduleAnchor = (
    jobId: JobId,
    pattern: SchedulePattern,
    startDayInMonth: number,
    monthDate: Date,
  ) => {
    if (pattern.work <= 0) return;
    const monthStart = startOfMonth(monthDate);
    const monthEnd = endOfMonth(monthDate);
    const safeStartDay = Math.max(
      1,
      Math.min(startDayInMonth, monthEnd.getDate()),
    );
    const startDate = setDate(monthStart, safeStartDay);
    setScheduleAnchors((prev) => ({
      ...prev,
      [jobId]: {
        anchorIso: format(startDate, "yyyy-MM-dd"),
        pattern,
      },
    }));
    // Drop any per-day overrides for this job (they would conflict with new anchor)
    setScheduleOverrides((prev) => {
      const next: ScheduleOverrides = {};
      for (const [k, v] of Object.entries(prev)) {
        const { [jobId]: _drop, ...rest } = v;
        if (Object.keys(rest).length > 0) next[k] = rest;
      }
      return next;
    });
  };

  /** Remove anchor and overrides for a single job entirely. */
  const clearScheduleForJob = (jobId: JobId) => {
    setScheduleAnchors((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    setScheduleOverrides((prev) => {
      const next: ScheduleOverrides = {};
      for (const [k, v] of Object.entries(prev)) {
        const { [jobId]: _drop, ...rest } = v;
        if (Object.keys(rest).length > 0) next[k] = rest;
      }
      return next;
    });
  };

  /** Toggle a single day's schedule status for a job (on -> off / off -> on). */
  const toggleScheduleDay = (jobId: JobId, date: Date) => {
    const key = format(date, "yyyy-MM-dd");
    const anchor = scheduleAnchors[jobId];
    const baseScheduled = isScheduledByAnchor(date, anchor);
    setScheduleOverrides((prev) => {
      const cur = prev[key] || {};
      const explicit = cur[jobId];
      const newValue =
        explicit === undefined ? !baseScheduled : !explicit;

      // If newValue matches base, remove override (collapse to default)
      let nextDay: Partial<Record<JobId, boolean>> = { ...cur };
      if (newValue === baseScheduled) {
        delete nextDay[jobId];
      } else {
        nextDay[jobId] = newValue;
      }
      const next: ScheduleOverrides = { ...prev };
      if (Object.keys(nextDay).length === 0) {
        delete next[key];
      } else {
        next[key] = nextDay;
      }
      return next;
    });
  };

  const getScheduledJobsFor = useCallback(
    (date: Date): JobId[] => {
      const key = format(date, "yyyy-MM-dd");
      const overrides = scheduleOverrides[key] || {};
      const result: JobId[] = [];
      for (const job of JOBS) {
        const explicit = overrides[job.id];
        const isOn =
          explicit !== undefined
            ? explicit
            : isScheduledByAnchor(date, scheduleAnchors[job.id]);
        if (isOn) result.push(job.id);
      }
      return result;
    },
    [scheduleAnchors, scheduleOverrides],
  );

  // --- Backup / restore ---

  const exportData = () => {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
      currency,
      obligations,
      scheduleAnchors,
      scheduleOverrides,
      goalRub,
      theme,
    };
  };

  const importData = (data: unknown): boolean => {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    try {
      if (d.entries && typeof d.entries === "object") {
        setEntries(d.entries as Entries);
      }
      if (typeof d.currency === "string" && (ALLOWED as string[]).includes(d.currency)) {
        setCurrencyState(d.currency as Currency);
      }
      if (Array.isArray(d.obligations)) {
        setObligations(d.obligations as Obligation[]);
      }
      if (d.scheduleAnchors && typeof d.scheduleAnchors === "object") {
        setScheduleAnchors(d.scheduleAnchors as ScheduleAnchors);
      }
      if (d.scheduleOverrides && typeof d.scheduleOverrides === "object") {
        setScheduleOverrides(d.scheduleOverrides as ScheduleOverrides);
      }
      if (typeof d.goalRub === "number" || d.goalRub === null) {
        setGoalRub((d.goalRub as number | null) ?? null);
      }
      if (d.theme === "dark" || d.theme === "light") {
        setThemeState(d.theme);
      }
      return true;
    } catch {
      return false;
    }
  };

  return {
    entries,
    currency,
    setCurrency,
    setDayEntries,
    convert,
    rates,
    obligations,
    addObligation,
    updateObligation,
    removeObligation,
    scheduleAnchors,
    scheduleOverrides,
    applyScheduleAnchor,
    clearScheduleForJob,
    toggleScheduleDay,
    getScheduledJobsFor,
    goalRub,
    setGoal,
    clearGoal,
    theme,
    setTheme,
    toggleTheme,
    exportData,
    importData,
  };
}

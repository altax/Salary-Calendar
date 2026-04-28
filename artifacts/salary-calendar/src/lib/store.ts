import { useState, useEffect, useCallback, useRef } from "react";
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  differenceInCalendarDays,
  setDate,
  parseISO,
  subDays,
} from "date-fns";

const ENTRIES_V2_KEY = "salary-calendar:entries:v2";
const ENTRIES_V3_KEY = "salary-calendar:entries:v3";
const CURRENCY_KEY = "salary-calendar:currency:v2";
const RATES_KEY = "salary-calendar:rates:v1";
const OBLIGATIONS_KEY = "salary-calendar:obligations:v2";
const OBLIGATIONS_LEGACY_KEY = "salary-calendar:obligations:v1";
const SCHEDULE_LEGACY_KEY = "salary-calendar:schedule:v1";
const SCHEDULE_ANCHORS_KEY = "salary-calendar:schedule-anchors:v1";
const SCHEDULE_OVERRIDES_KEY = "salary-calendar:schedule-overrides:v1";
const GOAL_KEY = "salary-calendar:goal:v1";
const THEME_KEY = "salary-calendar:theme:v1";
const SAVINGS_GOAL_KEY = "salary-calendar:savings-goal:v1";
const TAX_RATE_KEY = "salary-calendar:tax-rate:v1";
const CATEGORIES_KEY = "salary-calendar:categories:v1";
const JOB_CONFIGS_KEY = "salary-calendar:job-configs:v1";
const RECENT_AMOUNTS_KEY = "salary-calendar:recent-amounts:v1";

const UNDO_LIMIT = 30;
const RECENT_AMOUNTS_LIMIT = 6;

export type SchedulePattern = { work: number; off: number };
export type Theme = "dark" | "light";

export const SCHEDULE_PATTERNS: { id: string; label: string; pattern: SchedulePattern }[] = [
  { id: "2/2", label: "2/2", pattern: { work: 2, off: 2 } },
  { id: "3/3", label: "3/3", pattern: { work: 3, off: 3 } },
  { id: "5/2", label: "5/2", pattern: { work: 5, off: 2 } },
  { id: "1/3", label: "1/3", pattern: { work: 1, off: 3 } },
];

export type Category = {
  id: string;
  name: string;
};

export const DEFAULT_CATEGORIES: Category[] = [
  { id: "housing", name: "жильё" },
  { id: "food", name: "еда" },
  { id: "telecom", name: "связь" },
  { id: "subs", name: "подписки" },
  { id: "transport", name: "транспорт" },
  { id: "other", name: "разное" },
];

export type Obligation = {
  id: string;
  name: string;
  amountRub: number;
  categoryId?: string;
};

export type SavingsGoal = {
  name: string;
  targetRub: number;
  deadlineIso: string;
};

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

export type JobConfig = {
  label?: string;
  short?: string;
  color?: string | null;
};
export type JobConfigs = Partial<Record<JobId, JobConfig>>;

export type ResolvedJob = {
  id: JobId;
  short: string;
  label: string;
  color: string | null;
};

export const DEFAULT_JOBS: ResolvedJob[] = [
  { id: "ozon", short: "о", label: "Озон ПВЗ", color: null },
  { id: "dostaevsky", short: "д", label: "Достаевский", color: null },
];

export const JOB_COLOR_PALETTE: { value: string; label: string }[] = [
  { value: "#0f172a", label: "графит" },
  { value: "#0ea5e9", label: "синий" },
  { value: "#10b981", label: "зелёный" },
  { value: "#f59e0b", label: "янтарь" },
  { value: "#ef4444", label: "красный" },
  { value: "#8b5cf6", label: "фиолет" },
  { value: "#ec4899", label: "розовый" },
  { value: "#64748b", label: "сланец" },
];

// Backwards-compatible "JOBS" export used as a fallback; UI should use the
// store-resolved `jobs` for live customization.
export const JOBS = DEFAULT_JOBS;

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

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadObligations(): Obligation[] {
  try {
    const raw = localStorage.getItem(OBLIGATIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Obligation[];
    }
    // Migrate v1 (no categories)
    const legacy = localStorage.getItem(OBLIGATIONS_LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) return parsed as Obligation[];
    }
  } catch {}
  return [];
}

function loadCategories(): Category[] {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    if (!raw) return DEFAULT_CATEGORIES;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as Category[];
  } catch {}
  return DEFAULT_CATEGORIES;
}

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

function loadSavingsGoal(): SavingsGoal | null {
  try {
    const raw = localStorage.getItem(SAVINGS_GOAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.name === "string" &&
      typeof parsed.targetRub === "number" &&
      typeof parsed.deadlineIso === "string"
    ) {
      return parsed as SavingsGoal;
    }
  } catch {}
  return null;
}

function loadTaxRate(): number {
  try {
    const raw = localStorage.getItem(TAX_RATE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (typeof parsed === "number" && parsed >= 0 && parsed <= 50) return parsed;
  } catch {}
  return 0;
}

function loadJobConfigs(): JobConfigs {
  try {
    const raw = localStorage.getItem(JOB_CONFIGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as JobConfigs;
  } catch {}
  return {};
}

function loadRecentAmounts(): Record<JobId, number[]> {
  try {
    const raw = localStorage.getItem(RECENT_AMOUNTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          ozon: Array.isArray(parsed.ozon) ? parsed.ozon : [],
          dostaevsky: Array.isArray(parsed.dostaevsky) ? parsed.dostaevsky : [],
        };
      }
    }
  } catch {}
  return { ozon: [], dostaevsky: [] };
}

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {}
  return "dark";
}

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
  for (const job of DEFAULT_JOBS) {
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
  const mod = ((diff % cycle) + cycle) % cycle;
  return mod < anchor.pattern.work;
}

function resolveJobs(configs: JobConfigs): ResolvedJob[] {
  return DEFAULT_JOBS.map((j) => {
    const cfg = configs[j.id] || {};
    return {
      id: j.id,
      short: (cfg.short || j.short).slice(0, 2),
      label: cfg.label || j.label,
      color: cfg.color ?? null,
    };
  });
}

type UndoEntry = {
  type: "day";
  dateIso: string;
  prev: DayEntry | undefined;
};

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
  const [categories, setCategories] = useState<Category[]>(() => loadCategories());
  const [scheduleAnchors, setScheduleAnchors] = useState<ScheduleAnchors>(
    () => loadScheduleAnchors(),
  );
  const [scheduleOverrides, setScheduleOverrides] = useState<ScheduleOverrides>(
    () => loadScheduleOverrides(),
  );
  const [goalRub, setGoalRub] = useState<number | null>(() => loadGoal());
  const [savingsGoal, setSavingsGoalState] = useState<SavingsGoal | null>(
    () => loadSavingsGoal(),
  );
  const [taxRate, setTaxRateState] = useState<number>(() => loadTaxRate());
  const [jobConfigs, setJobConfigs] = useState<JobConfigs>(() => loadJobConfigs());
  const [recentAmounts, setRecentAmounts] = useState<Record<JobId, number[]>>(
    () => loadRecentAmounts(),
  );
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());

  // Undo stack stays in a ref so it doesn't trigger re-renders.
  const undoStackRef = useRef<UndoEntry[]>([]);
  const [undoCount, setUndoCount] = useState(0);

  const jobs = resolveJobs(jobConfigs);

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
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
  }, [categories]);

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
    if (savingsGoal == null) localStorage.removeItem(SAVINGS_GOAL_KEY);
    else localStorage.setItem(SAVINGS_GOAL_KEY, JSON.stringify(savingsGoal));
  }, [savingsGoal]);

  useEffect(() => {
    localStorage.setItem(TAX_RATE_KEY, JSON.stringify(taxRate));
  }, [taxRate]);

  useEffect(() => {
    localStorage.setItem(JOB_CONFIGS_KEY, JSON.stringify(jobConfigs));
  }, [jobConfigs]);

  useEffect(() => {
    localStorage.setItem(RECENT_AMOUNTS_KEY, JSON.stringify(recentAmounts));
  }, [recentAmounts]);

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

  const pushUndo = (entry: UndoEntry) => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > UNDO_LIMIT) stack.shift();
    setUndoCount(stack.length);
  };

  const recordRecentAmount = (jobId: JobId, amountRub: number) => {
    if (!Number.isFinite(amountRub) || amountRub <= 0) return;
    const rounded = Math.round(amountRub);
    setRecentAmounts((prev) => {
      const cur = prev[jobId] || [];
      const filtered = cur.filter((v) => v !== rounded);
      filtered.unshift(rounded);
      return {
        ...prev,
        [jobId]: filtered.slice(0, RECENT_AMOUNTS_LIMIT),
      };
    });
  };

  const setDayEntries = (
    dateIso: string,
    amountsInDisplay: Partial<Record<JobId, number>>,
    displayCurrency: Currency,
    options?: { skipUndo?: boolean; skipRecent?: boolean },
  ) => {
    const next: DayEntry = {};
    for (const job of DEFAULT_JOBS) {
      const raw = amountsInDisplay[job.id];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        continue;
      const inRub =
        displayCurrency === "RUB" ? raw : raw / rates.values[displayCurrency];
      next[job.id] = Math.round(inRub * 100) / 100;
    }
    setEntries((prev) => {
      const updated = { ...prev };
      const before = prev[dateIso];
      if (Object.keys(next).length === 0) {
        if (before === undefined) return prev;
        delete updated[dateIso];
      } else {
        updated[dateIso] = next;
      }
      if (!options?.skipUndo) {
        pushUndo({ type: "day", dateIso, prev: before });
      }
      return updated;
    });
    if (!options?.skipRecent) {
      for (const job of DEFAULT_JOBS) {
        const v = next[job.id];
        if (typeof v === "number" && v > 0) {
          recordRecentAmount(job.id, v);
        }
      }
    }
  };

  const undoLastDayEntry = (): boolean => {
    const stack = undoStackRef.current;
    const top = stack.pop();
    setUndoCount(stack.length);
    if (!top) return false;
    if (top.type === "day") {
      setEntries((prev) => {
        const updated = { ...prev };
        if (top.prev === undefined) {
          delete updated[top.dateIso];
        } else {
          updated[top.dateIso] = top.prev;
        }
        return updated;
      });
      return true;
    }
    return false;
  };

  const addObligation = (
    name: string,
    amountInDisplay: number,
    displayCurrency: Currency,
    categoryId?: string,
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
        categoryId,
      },
    ]);
  };

  const updateObligation = (
    id: string,
    name: string,
    amountInDisplay: number,
    displayCurrency: Currency,
    categoryId?: string,
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
          ? {
              ...o,
              name: trimmed,
              amountRub: Math.round(amountRub * 100) / 100,
              categoryId,
            }
          : o,
      ),
    );
  };

  const removeObligation = (id: string) => {
    setObligations((prev) => prev.filter((o) => o.id !== id));
  };

  const addCategory = (name: string): Category | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const cat: Category = { id: makeId(), name: trimmed };
    setCategories((prev) => [...prev, cat]);
    return cat;
  };

  const renameCategory = (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, name: trimmed } : c)),
    );
  };

  const removeCategory = (id: string) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
    setObligations((prev) =>
      prev.map((o) =>
        o.categoryId === id ? { ...o, categoryId: undefined } : o,
      ),
    );
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

  const setSavingsGoal = (
    name: string,
    amountInDisplay: number,
    deadlineIso: string,
    displayCurrency: Currency,
  ) => {
    const trimmed = name.trim();
    if (!trimmed || !Number.isFinite(amountInDisplay) || amountInDisplay <= 0) {
      return;
    }
    if (!deadlineIso) return;
    const targetRub =
      displayCurrency === "RUB"
        ? amountInDisplay
        : amountInDisplay / rates.values[displayCurrency];
    setSavingsGoalState({
      name: trimmed,
      targetRub: Math.round(targetRub * 100) / 100,
      deadlineIso,
    });
  };

  const clearSavingsGoal = () => setSavingsGoalState(null);

  const setTaxRate = (rate: number) => {
    if (!Number.isFinite(rate) || rate < 0 || rate > 50) return;
    setTaxRateState(rate);
  };

  const setJobConfig = (
    jobId: JobId,
    cfg: { label?: string; short?: string; color?: string | null },
  ) => {
    setJobConfigs((prev) => {
      const next: JobConfigs = { ...prev };
      const cur = next[jobId] || {};
      next[jobId] = {
        ...cur,
        ...(cfg.label !== undefined ? { label: cfg.label.trim() || undefined } : {}),
        ...(cfg.short !== undefined ? { short: cfg.short.trim().slice(0, 2) || undefined } : {}),
        ...(cfg.color !== undefined ? { color: cfg.color } : {}),
      };
      // Drop empty configs entirely
      const v = next[jobId]!;
      if (!v.label && !v.short && !v.color) delete next[jobId];
      return next;
    });
  };

  const resetJobConfig = (jobId: JobId) => {
    setJobConfigs((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  };

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
    setScheduleOverrides((prev) => {
      const next: ScheduleOverrides = {};
      for (const [k, v] of Object.entries(prev)) {
        const { [jobId]: _drop, ...rest } = v;
        if (Object.keys(rest).length > 0) next[k] = rest;
      }
      return next;
    });
  };

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

  const toggleScheduleDay = (jobId: JobId, date: Date) => {
    const key = format(date, "yyyy-MM-dd");
    const anchor = scheduleAnchors[jobId];
    const baseScheduled = isScheduledByAnchor(date, anchor);
    setScheduleOverrides((prev) => {
      const cur = prev[key] || {};
      const explicit = cur[jobId];
      const newValue =
        explicit === undefined ? !baseScheduled : !explicit;

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
      for (const job of DEFAULT_JOBS) {
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

  /** Sum of all entries (in RUB) over an arbitrary day range. */
  const sumRangeRub = useCallback(
    (startDate: Date, endDate: Date): number => {
      let sum = 0;
      const days = eachDayOfInterval({ start: startDate, end: endDate });
      for (const d of days) {
        const entry = entries[format(d, "yyyy-MM-dd")];
        if (entry) sum += dayTotal(entry);
      }
      return sum;
    },
    [entries],
  );

  /** Streak in days, counting back from today (inclusive). */
  const computeStreak = useCallback((): number => {
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i += 1) {
      const d = subDays(today, i);
      const entry = entries[format(d, "yyyy-MM-dd")];
      if (entry && dayTotal(entry) > 0) streak += 1;
      else if (i === 0) {
        // Today not yet logged — try yesterday onward
        continue;
      } else break;
    }
    return streak;
  }, [entries]);

  const exportData = () => {
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      entries,
      currency,
      obligations,
      categories,
      scheduleAnchors,
      scheduleOverrides,
      goalRub,
      savingsGoal,
      taxRate,
      jobConfigs,
      recentAmounts,
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
      if (Array.isArray(d.categories) && d.categories.length > 0) {
        setCategories(d.categories as Category[]);
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
      if (d.savingsGoal === null) setSavingsGoalState(null);
      else if (
        d.savingsGoal &&
        typeof d.savingsGoal === "object"
      ) {
        const sg = d.savingsGoal as SavingsGoal;
        if (sg.name && sg.targetRub > 0 && sg.deadlineIso) {
          setSavingsGoalState(sg);
        }
      }
      if (typeof d.taxRate === "number") setTaxRateState(d.taxRate);
      if (d.jobConfigs && typeof d.jobConfigs === "object") {
        setJobConfigs(d.jobConfigs as JobConfigs);
      }
      if (d.recentAmounts && typeof d.recentAmounts === "object") {
        const r = d.recentAmounts as Record<string, unknown>;
        setRecentAmounts({
          ozon: Array.isArray(r.ozon) ? (r.ozon as number[]) : [],
          dostaevsky: Array.isArray(r.dostaevsky) ? (r.dostaevsky as number[]) : [],
        });
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
    undoLastDayEntry,
    undoCount,
    convert,
    rates,
    obligations,
    addObligation,
    updateObligation,
    removeObligation,
    categories,
    addCategory,
    renameCategory,
    removeCategory,
    scheduleAnchors,
    scheduleOverrides,
    applyScheduleAnchor,
    clearScheduleForJob,
    toggleScheduleDay,
    getScheduledJobsFor,
    goalRub,
    setGoal,
    clearGoal,
    savingsGoal,
    setSavingsGoal,
    clearSavingsGoal,
    taxRate,
    setTaxRate,
    jobs,
    jobConfigs,
    setJobConfig,
    resetJobConfig,
    recentAmounts,
    theme,
    setTheme,
    toggleTheme,
    exportData,
    importData,
    sumRangeRub,
    computeStreak,
  };
}

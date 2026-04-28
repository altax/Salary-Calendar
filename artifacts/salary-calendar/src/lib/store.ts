import { useState, useEffect, useCallback } from "react";

const ENTRIES_V2_KEY = "salary-calendar:entries:v2";
const ENTRIES_V3_KEY = "salary-calendar:entries:v3";
const CURRENCY_KEY = "salary-calendar:currency:v2";
const RATES_KEY = "salary-calendar:rates:v1";

export type Currency = "RUB" | "USD" | "EUR";
export type JobId = "ozon" | "dostaevsky";

export type DayEntry = Partial<Record<JobId, number>>;
export type Entries = Record<string, DayEntry>;

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

  useEffect(() => {
    localStorage.setItem(ENTRIES_V3_KEY, JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(CURRENCY_KEY, currency);
  }, [currency]);

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

  return {
    entries,
    currency,
    setCurrency,
    setDayEntries,
    convert,
    rates,
  };
}

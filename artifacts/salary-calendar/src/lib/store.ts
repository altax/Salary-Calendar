import { useState, useEffect, useCallback } from "react";

const ENTRIES_KEY = "salary-calendar:entries:v2";
const CURRENCY_KEY = "salary-calendar:currency:v2";
const RATES_KEY = "salary-calendar:rates:v1";

export type Entries = Record<string, number>;
export type Currency = "RUB" | "USD" | "EUR";

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

export function useSalaryStore() {
  const [entries, setEntries] = useState<Entries>(() => {
    try {
      const stored =
        localStorage.getItem(ENTRIES_KEY) ??
        localStorage.getItem("salary-calendar:entries:v1");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const [currency, setCurrencyState] = useState<Currency>(() => {
    const stored = localStorage.getItem(CURRENCY_KEY);
    if (stored && (ALLOWED as string[]).includes(stored)) {
      return stored as Currency;
    }
    return "RUB";
  });

  const [rates, setRates] = useState<Rates>(() => loadCachedRates());

  useEffect(() => {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
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

  const setEntryInCurrency = (
    dateIso: string,
    amountInDisplayCurrency: number,
    displayCurrency: Currency,
  ) => {
    const amountInRub =
      displayCurrency === "RUB"
        ? amountInDisplayCurrency
        : amountInDisplayCurrency / rates.values[displayCurrency];
    setEntries((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(amountInRub) || amountInRub <= 0) {
        delete next[dateIso];
      } else {
        next[dateIso] = Math.round(amountInRub * 100) / 100;
      }
      return next;
    });
  };

  return {
    entries,
    currency,
    setCurrency,
    setEntryInCurrency,
    convert,
    rates,
  };
}

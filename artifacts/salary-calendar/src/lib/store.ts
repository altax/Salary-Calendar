import { useState, useEffect } from "react";

const ENTRIES_KEY = "salary-calendar:entries:v1";
const CURRENCY_KEY = "salary-calendar:currency:v2";

export type Entries = Record<string, number>;
export type Currency = "RUB" | "USD" | "EUR";

const ALLOWED: Currency[] = ["RUB", "USD", "EUR"];

export function useSalaryStore() {
  const [entries, setEntries] = useState<Entries>(() => {
    try {
      const stored = localStorage.getItem(ENTRIES_KEY);
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

  useEffect(() => {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(CURRENCY_KEY, currency);
  }, [currency]);

  const setCurrency = (next: string) => {
    if ((ALLOWED as string[]).includes(next)) {
      setCurrencyState(next as Currency);
    }
  };

  const setEntry = (dateIso: string, amount: number) => {
    setEntries((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(amount) || amount <= 0) {
        delete next[dateIso];
      } else {
        next[dateIso] = amount;
      }
      return next;
    });
  };

  return { entries, currency, setCurrency, setEntry };
}

import { useState, useEffect } from "react";

const ENTRIES_KEY = "salary-calendar:entries:v1";
const CURRENCY_KEY = "salary-calendar:currency:v1";

export type Entries = Record<string, number>;

export function useSalaryStore() {
  const [entries, setEntries] = useState<Entries>(() => {
    try {
      const stored = localStorage.getItem(ENTRIES_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const [currency, setCurrency] = useState<string>(() => {
    return localStorage.getItem(CURRENCY_KEY) || "USD";
  });

  useEffect(() => {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(CURRENCY_KEY, currency);
  }, [currency]);

  const setEntry = (dateIso: string, amount: number) => {
    setEntries((prev) => {
      const next = { ...prev };
      if (amount <= 0) {
        delete next[dateIso];
      } else {
        next[dateIso] = amount;
      }
      return next;
    });
  };

  return { entries, currency, setCurrency, setEntry };
}

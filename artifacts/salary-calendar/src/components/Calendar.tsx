import { useState, useMemo } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  isWeekend,
} from "date-fns";
import { ru } from "date-fns/locale";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useSalaryStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const CURRENCIES = [
  { code: "RUB", symbol: "₽", label: "Рубль" },
  { code: "USD", symbol: "$", label: "Доллар" },
  { code: "EUR", symbol: "€", label: "Евро" },
] as const;

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const WEEK_OPTIONS = { weekStartsOn: 1 as const };

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function MoneyTicker({ value, currency }: { value: number; currency: string }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={`${value}-${currency}`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="inline-block tabular-nums"
      >
        {formatMoney(value, currency)}
      </motion.span>
    </AnimatePresence>
  );
}

export default function Calendar() {
  const { entries, currency, setCurrency, setEntry } = useSalaryStore();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const gridStart = startOfWeek(monthStart, WEEK_OPTIONS);
  const gridEnd = endOfWeek(monthEnd, WEEK_OPTIONS);

  const days = useMemo(
    () => eachDayOfInterval({ start: gridStart, end: gridEnd }),
    [gridStart.getTime(), gridEnd.getTime()],
  );

  const weeks = useMemo(() => {
    const w: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) w.push(days.slice(i, i + 7));
    return w;
  }, [days]);

  const getDayTotal = (date: Date) =>
    entries[format(date, "yyyy-MM-dd")] || 0;

  const getWeekTotal = (weekDays: Date[]) =>
    weekDays
      .filter((d) => isSameMonth(d, currentDate))
      .reduce((sum, d) => sum + getDayTotal(d), 0);

  const monthDays = useMemo(
    () => eachDayOfInterval({ start: monthStart, end: monthEnd }),
    [monthStart.getTime(), monthEnd.getTime()],
  );

  const monthTotal = useMemo(
    () => monthDays.reduce((sum, d) => sum + getDayTotal(d), 0),
    [monthDays, entries],
  );

  const daysWithEntries = useMemo(
    () => monthDays.filter((d) => getDayTotal(d) > 0).length,
    [monthDays, entries],
  );

  const averagePerDay =
    daysWithEntries > 0 ? monthTotal / daysWithEntries : 0;

  const bestDay = useMemo(() => {
    let best = 0;
    for (const d of monthDays) best = Math.max(best, getDayTotal(d));
    return best;
  }, [monthDays, entries]);

  const handleSave = (date: Date) => {
    const normalized = editValue.replace(",", ".").trim();
    const num = parseFloat(normalized);
    setEntry(format(date, "yyyy-MM-dd"), Number.isFinite(num) ? num : 0);
    setOpenKey(null);
  };

  const handleClear = (date: Date) => {
    setEntry(format(date, "yyyy-MM-dd"), 0);
    setOpenKey(null);
  };

  const monthLabel = format(currentDate, "LLLL yyyy", { locale: ru });
  const monthLabelCapitalized =
    monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground overflow-hidden flex flex-col">
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 py-4 flex-1 flex flex-col min-h-0 gap-3">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
              {monthLabelCapitalized}
            </h1>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hidden sm:inline">
              Календарь дохода
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-md border border-border bg-card overflow-hidden">
              <button
                onClick={() => setCurrentDate(subMonths(currentDate, 1))}
                aria-label="Предыдущий месяц"
                className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentDate(new Date())}
                className="h-8 px-3 text-xs font-medium border-x border-border text-foreground hover:bg-muted transition-colors"
              >
                Сегодня
              </button>
              <button
                onClick={() => setCurrentDate(addMonths(currentDate, 1))}
                aria-label="Следующий месяц"
                className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="h-8 w-[110px] bg-card border-border text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.symbol} {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>

        {/* Calendar Card */}
        <div className="rounded-xl border border-border bg-card overflow-hidden flex-1 flex flex-col min-h-0">
          {/* Weekday labels */}
          <div className="grid grid-cols-[repeat(7,1fr)_110px] border-b border-border bg-muted/40 shrink-0">
            {WEEKDAYS.map((day, i) => (
              <div
                key={day}
                className={cn(
                  "py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.15em]",
                  i >= 5 ? "text-muted-foreground/70" : "text-muted-foreground",
                )}
              >
                {day}
              </div>
            ))}
            <div className="py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground border-l border-border">
              Неделя
            </div>
          </div>

          {/* Weeks */}
          <div className="flex-1 flex flex-col min-h-0">
            {weeks.map((week, wi) => {
              const weekTotal = getWeekTotal(week);
              const isLastWeek = wi === weeks.length - 1;
              return (
                <div
                  key={wi}
                  className={cn(
                    "grid grid-cols-[repeat(7,1fr)_110px] flex-1 min-h-0",
                    !isLastWeek && "border-b border-border",
                  )}
                >
                  {week.map((day, di) => {
                    const isCurrentMonth = isSameMonth(day, currentDate);
                    const isToday = isSameDay(day, new Date());
                    const amt = getDayTotal(day);
                    const key = format(day, "yyyy-MM-dd");
                    const isOpen = openKey === key;
                    const weekend = isWeekend(day);
                    const isLastCol = di === 6;

                    return (
                      <Popover
                        key={key}
                        open={isOpen}
                        onOpenChange={(open) => {
                          if (open) {
                            setOpenKey(key);
                            setEditValue(amt ? String(amt) : "");
                          } else if (isOpen) {
                            setOpenKey(null);
                          }
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            className={cn(
                              "p-2 flex flex-col items-start justify-between text-left transition-colors outline-none relative min-h-0",
                              !isLastCol && "border-r border-border",
                              !isCurrentMonth && "bg-muted/20",
                              isCurrentMonth && "hover:bg-muted/40",
                              isCurrentMonth && weekend && "bg-muted/15",
                              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
                            )}
                          >
                            <span
                              className={cn(
                                "text-xs font-medium tabular-nums w-6 h-6 flex items-center justify-center rounded-full",
                                !isCurrentMonth && "text-muted-foreground/50",
                                isCurrentMonth && !isToday && "text-foreground",
                                isToday &&
                                  "bg-primary text-primary-foreground font-semibold",
                              )}
                            >
                              {format(day, "d")}
                            </span>

                            {amt > 0 && isCurrentMonth && (
                              <motion.span
                                initial={{ opacity: 0, scale: 0.92 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.15 }}
                                className="text-xs font-semibold tabular-nums text-foreground self-stretch text-right truncate"
                              >
                                {formatMoney(amt, currency)}
                              </motion.span>
                            )}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-60 p-3"
                          align="center"
                          sideOffset={4}
                        >
                          <div className="space-y-2.5">
                            <div className="text-xs font-medium text-muted-foreground">
                              {format(day, "d MMMM yyyy", { locale: ru })}
                            </div>
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                handleSave(day);
                              }}
                              className="flex gap-2"
                            >
                              <Input
                                autoFocus
                                inputMode="decimal"
                                placeholder="0"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="h-8 text-sm tabular-nums"
                              />
                              <Button
                                type="submit"
                                size="sm"
                                className="h-8 px-3"
                              >
                                ОК
                              </Button>
                            </form>
                            {amt > 0 && (
                              <button
                                type="button"
                                onClick={() => handleClear(day)}
                                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                              >
                                Удалить запись
                              </button>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    );
                  })}

                  {/* Week total cell */}
                  <div className="flex flex-col items-end justify-center px-3 border-l border-border bg-muted/20 min-h-0">
                    <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground mb-0.5">
                      Итого
                    </span>
                    <span className="text-xs sm:text-sm font-semibold tabular-nums text-foreground truncate max-w-full">
                      <MoneyTicker value={weekTotal} currency={currency} />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Summary footer */}
        <div className="rounded-xl border border-border bg-card px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 shrink-0">
          <div className="flex items-baseline gap-3">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Итого за месяц
            </span>
            <span className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums">
              <MoneyTicker value={monthTotal} currency={currency} />
            </span>
          </div>

          <div className="flex items-center gap-5 text-xs">
            <Stat label="Дней" value={String(daysWithEntries)} />
            <Stat label="Среднее" value={formatMoney(averagePerDay, currency)} />
            <Stat label="Лучший" value={formatMoney(bestDay, currency)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

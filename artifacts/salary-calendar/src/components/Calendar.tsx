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
    <div className="h-[100dvh] w-full bg-background text-foreground overflow-hidden flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-[1100px] h-full max-h-[760px] grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 min-h-0">
        {/* Calendar panel */}
        <section className="rounded-2xl border border-border bg-card flex flex-col min-h-0 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold tracking-tight">
                {monthLabelCapitalized}
              </h1>
            </div>
            <div className="flex items-center rounded-md border border-border overflow-hidden">
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
          </div>

          {/* Weekday labels */}
          <div className="grid grid-cols-7 border-b border-border bg-muted/30 shrink-0">
            {WEEKDAYS.map((day, i) => (
              <div
                key={day}
                className={cn(
                  "py-2 text-center text-[10px] font-semibold uppercase tracking-[0.18em]",
                  i >= 5
                    ? "text-muted-foreground/60"
                    : "text-muted-foreground",
                )}
              >
                {day}
              </div>
            ))}
          </div>

          {/* Weeks */}
          <div className="flex-1 grid grid-rows-[repeat(var(--weeks),1fr)] min-h-0"
               style={{ ["--weeks" as any]: weeks.length }}>
            {weeks.map((week, wi) => {
              const weekTotal = getWeekTotal(week);
              const isLastWeek = wi === weeks.length - 1;
              return (
                <div
                  key={wi}
                  className={cn(
                    "grid grid-cols-7 min-h-0",
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
                              "flex flex-col items-stretch justify-between text-left transition-colors outline-none relative min-h-0 px-2 py-1.5",
                              !isLastCol && "border-r border-border",
                              !isCurrentMonth && "bg-muted/15 text-muted-foreground/60",
                              isCurrentMonth && weekend && "bg-muted/10",
                              isCurrentMonth && "hover:bg-muted/40",
                              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
                              amt > 0 && isCurrentMonth && "bg-primary/5",
                            )}
                          >
                            <div className="flex items-center justify-between">
                              <span
                                className={cn(
                                  "text-xs font-medium tabular-nums w-5 h-5 flex items-center justify-center rounded-full",
                                  isToday &&
                                    "bg-primary text-primary-foreground font-semibold",
                                )}
                              >
                                {format(day, "d")}
                              </span>
                            </div>

                            {amt > 0 && isCurrentMonth && (
                              <motion.span
                                initial={{ opacity: 0, y: 2 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.15 }}
                                className="text-[13px] font-semibold tabular-nums text-foreground text-right truncate"
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
                </div>
              );
            })}
          </div>
        </section>

        {/* Sidebar */}
        <aside className="flex flex-col gap-4 min-h-0">
          {/* Month total hero */}
          <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Итого за месяц
              </span>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="h-7 w-[88px] bg-transparent border-border text-xs px-2">
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
            <div className="text-3xl font-semibold tracking-tight tabular-nums leading-tight">
              <MoneyTicker value={monthTotal} currency={currency} />
            </div>
            <p className="text-xs text-muted-foreground">
              {daysWithEntries === 0
                ? "Нажмите на день, чтобы добавить запись."
                : `${daysWithEntries} ${plural(daysWithEntries, ["день", "дня", "дней"])} с записью`}
            </p>
          </div>

          {/* Weekly totals list */}
          <div className="rounded-2xl border border-border bg-card flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border shrink-0">
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                По неделям
              </span>
            </div>
            <ul className="flex-1 overflow-auto">
              {weeks.map((week, wi) => {
                const weekTotal = getWeekTotal(week);
                const monthDaysInWeek = week.filter((d) =>
                  isSameMonth(d, currentDate),
                );
                if (monthDaysInWeek.length === 0) return null;
                const first = monthDaysInWeek[0];
                const last = monthDaysInWeek[monthDaysInWeek.length - 1];
                return (
                  <li
                    key={wi}
                    className="flex items-center justify-between px-4 py-2 border-b border-border last:border-b-0"
                  >
                    <div className="flex flex-col leading-tight">
                      <span className="text-xs font-medium">
                        Неделя {wi + 1}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {format(first, "d")}–{format(last, "d MMM", { locale: ru })}
                      </span>
                    </div>
                    <span className="text-sm font-semibold tabular-nums">
                      <MoneyTicker value={weekTotal} currency={currency} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Mini stats */}
          <div className="rounded-2xl border border-border bg-card grid grid-cols-2 divide-x divide-border shrink-0">
            <Stat label="Среднее" value={formatMoney(averagePerDay, currency)} />
            <Stat label="Лучший день" value={formatMoney(bestDay, currency)} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-start gap-0.5 px-4 py-3">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground truncate max-w-full">
        {value}
      </span>
    </div>
  );
}

function plural(n: number, forms: [string, string, string]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

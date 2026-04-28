import { useState, useMemo, useEffect } from "react";
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
  setMonth,
  setYear,
} from "date-fns";
import { ru } from "date-fns/locale";
import { motion, AnimatePresence } from "framer-motion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSalaryStore, type Currency } from "@/lib/store";
import { cn } from "@/lib/utils";

const CURRENCIES: { code: Currency; symbol: string }[] = [
  { code: "RUB", symbol: "₽" },
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
];

const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const WEEK_OPTIONS = { weekStartsOn: 1 as const };

const MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.round(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function MoneyTicker({
  value,
  currency,
  className,
}: {
  value: number;
  currency: string;
  className?: string;
}) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={`${Math.round(value)}-${currency}`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className={cn("inline-block tabular-nums", className)}
      >
        {formatMoney(value, currency)}
      </motion.span>
    </AnimatePresence>
  );
}

function Tile({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card overflow-hidden flex flex-col min-h-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function TileLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-[0.25em] text-muted-foreground">
      {children}
    </span>
  );
}

export default function Calendar() {
  const {
    entries,
    currency,
    setCurrency,
    setEntryInCurrency,
    convert,
  } = useSalaryStore();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    setPickerYear(currentDate.getFullYear());
  }, [currentDate]);

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

  const getDayRub = (date: Date) =>
    entries[format(date, "yyyy-MM-dd")] || 0;

  const getDayInDisplay = (date: Date) =>
    convert(getDayRub(date), "RUB", currency);

  const getWeekTotal = (weekDays: Date[]) =>
    weekDays
      .filter((d) => isSameMonth(d, currentDate))
      .reduce((sum, d) => sum + getDayInDisplay(d), 0);

  const monthDays = useMemo(
    () => eachDayOfInterval({ start: monthStart, end: monthEnd }),
    [monthStart.getTime(), monthEnd.getTime()],
  );

  const monthTotal = useMemo(
    () => monthDays.reduce((sum, d) => sum + getDayInDisplay(d), 0),
    [monthDays, entries, currency, convert],
  );

  const daysWithEntries = useMemo(
    () => monthDays.filter((d) => getDayRub(d) > 0).length,
    [monthDays, entries],
  );

  const averagePerDay =
    daysWithEntries > 0 ? monthTotal / daysWithEntries : 0;

  const bestDay = useMemo(() => {
    let best = 0;
    for (const d of monthDays) best = Math.max(best, getDayInDisplay(d));
    return best;
  }, [monthDays, entries, currency, convert]);

  const handleSave = (date: Date) => {
    const num = parseInt(editValue, 10);
    setEntryInCurrency(
      format(date, "yyyy-MM-dd"),
      Number.isFinite(num) ? num : 0,
      currency,
    );
    setOpenKey(null);
  };

  const handleClear = (date: Date) => {
    setEntryInCurrency(format(date, "yyyy-MM-dd"), 0, currency);
    setOpenKey(null);
  };

  const monthName = format(currentDate, "LLLL", { locale: ru }).toLowerCase();
  const yearStr = format(currentDate, "yyyy");
  const today = new Date();

  const handlePickMonth = (monthIndex: number) => {
    const next = setMonth(setYear(currentDate, pickerYear), monthIndex);
    setCurrentDate(next);
    setMonthPickerOpen(false);
  };

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground overflow-hidden p-3 sm:p-4">
      <div
        className="mx-auto w-full max-w-[1200px] h-full grid gap-3 min-h-0"
        style={{
          gridTemplateColumns: "minmax(0, 1fr) 280px",
          gridTemplateRows: "auto minmax(0, 1fr) auto",
        }}
      >
        {/* Header bar — spans full width */}
        <header className="col-span-2 rounded-2xl border border-border bg-card flex items-center justify-between px-4 py-2.5 min-h-0">
          <div className="flex items-baseline gap-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              [ledger]
            </span>
            <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  className="text-sm font-medium tabular-nums hover:text-foreground/90 transition-colors flex items-baseline gap-1.5 group"
                  aria-label="Выбрать месяц"
                >
                  <span>{monthName}</span>
                  <span className="text-muted-foreground">/ {yearStr}</span>
                  <span className="text-muted-foreground text-[10px] group-hover:text-foreground/70 transition-colors">
                    ▾
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={8}
                className="w-[260px] p-3"
              >
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={() => setPickerYear((y) => y - 1)}
                    className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                    aria-label="Предыдущий год"
                  >
                    ‹
                  </button>
                  <span className="text-sm font-medium tabular-nums">
                    {pickerYear}
                  </span>
                  <button
                    onClick={() => setPickerYear((y) => y + 1)}
                    className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                    aria-label="Следующий год"
                  >
                    ›
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {MONTHS_SHORT.map((m, i) => {
                    const isSelected =
                      i === currentDate.getMonth() &&
                      pickerYear === currentDate.getFullYear();
                    const isCurrentMonth =
                      i === today.getMonth() &&
                      pickerYear === today.getFullYear();
                    return (
                      <button
                        key={m}
                        onClick={() => handlePickMonth(i)}
                        className={cn(
                          "h-9 rounded-md text-xs font-medium uppercase tracking-[0.1em] transition-colors border",
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary"
                            : isCurrentMonth
                              ? "border-border text-foreground hover:bg-muted"
                              : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => {
                    setCurrentDate(new Date());
                    setMonthPickerOpen(false);
                  }}
                  className="mt-3 w-full h-8 rounded-md text-[11px] font-medium uppercase tracking-[0.2em] border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  сегодня
                </button>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentDate(subMonths(currentDate, 1))}
              aria-label="Предыдущий месяц"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-sm"
            >
              ‹
            </button>
            <button
              onClick={() => setMonthPickerOpen(true)}
              className="h-7 px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground hover:bg-muted rounded-md transition-colors"
            >
              сегодня
            </button>
            <button
              onClick={() => setCurrentDate(addMonths(currentDate, 1))}
              aria-label="Следующий месяц"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-sm"
            >
              ›
            </button>
            <div className="w-px h-5 bg-border mx-1.5" />
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              {CURRENCIES.map((c) => (
                <button
                  key={c.code}
                  onClick={() => setCurrency(c.code)}
                  className={cn(
                    "h-7 w-7 flex items-center justify-center text-xs font-medium transition-colors",
                    currency === c.code
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                  aria-label={c.code}
                >
                  {c.symbol}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* Calendar tile */}
        <Tile>
          {/* Weekday labels */}
          <div className="grid grid-cols-7 border-b border-border shrink-0">
            {WEEKDAYS.map((day, i) => (
              <div
                key={day}
                className={cn(
                  "py-2 text-center text-[10px] font-medium tracking-[0.15em]",
                  i >= 5
                    ? "text-muted-foreground/50"
                    : "text-muted-foreground",
                )}
              >
                {day}
              </div>
            ))}
          </div>

          {/* Weeks */}
          <div
            className="flex-1 grid min-h-0"
            style={{
              gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))`,
            }}
          >
            {weeks.map((week, wi) => {
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
                    const isToday = isSameDay(day, today);
                    const amtRub = getDayRub(day);
                    const amtDisplay = getDayInDisplay(day);
                    const hasEntry = amtRub > 0;
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
                            const displayValue = isCurrentMonth && hasEntry
                              ? Math.round(amtDisplay)
                              : 0;
                            setEditValue(displayValue ? String(displayValue) : "");
                          } else if (isOpen) {
                            setOpenKey(null);
                          }
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            className={cn(
                              "flex flex-col items-stretch justify-between text-left transition-colors outline-none relative min-h-0 px-2 py-1.5 group",
                              !isLastCol && "border-r border-border",
                              !isCurrentMonth && "bg-background/40",
                              isCurrentMonth && weekend && !hasEntry && "bg-muted/20",
                              isCurrentMonth && hasEntry && "bg-foreground/[0.06]",
                              isCurrentMonth && "hover:bg-muted/60",
                              "focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset",
                            )}
                          >
                            {/* Subtle accent stripe for days with entries */}
                            {hasEntry && isCurrentMonth && (
                              <span className="absolute top-0 left-0 right-0 h-px bg-foreground/40" />
                            )}

                            <div className="flex items-center justify-between">
                              <span
                                className={cn(
                                  "text-[11px] font-medium tabular-nums tracking-tight",
                                  !isCurrentMonth && "text-muted-foreground/30",
                                  isCurrentMonth && !isToday && !hasEntry && "text-muted-foreground",
                                  isCurrentMonth && hasEntry && !isToday && "text-foreground",
                                  isToday &&
                                    "text-primary-foreground bg-primary px-1.5 py-0.5 rounded-sm self-start",
                                )}
                              >
                                {format(day, "dd")}
                              </span>
                              {hasEntry && isCurrentMonth && !isToday && (
                                <span className="w-1 h-1 rounded-full bg-foreground/60" />
                              )}
                            </div>

                            {hasEntry && isCurrentMonth && (
                              <motion.span
                                key={`${amtRub}-${currency}`}
                                initial={{ opacity: 0, y: 2 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.18 }}
                                className="text-[12px] font-semibold tabular-nums text-foreground text-right truncate leading-none mt-1"
                              >
                                {formatMoney(amtDisplay, currency)}
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
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                {format(day, "d MMMM yyyy", { locale: ru })}
                              </span>
                              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                {currency}
                              </span>
                            </div>
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                handleSave(day);
                              }}
                              className="flex gap-2"
                            >
                              <input
                                autoFocus
                                inputMode="numeric"
                                pattern="[0-9]*"
                                placeholder="0"
                                value={editValue}
                                onChange={(e) => {
                                  const cleaned = e.target.value.replace(/\D/g, "");
                                  setEditValue(cleaned.replace(/^0+(?=\d)/, ""));
                                }}
                                onKeyDown={(e) => {
                                  const allowed = [
                                    "Backspace", "Delete", "ArrowLeft", "ArrowRight",
                                    "Tab", "Home", "End", "Enter",
                                  ];
                                  if (allowed.includes(e.key)) return;
                                  if (e.metaKey || e.ctrlKey) return;
                                  if (!/^[0-9]$/.test(e.key)) {
                                    e.preventDefault();
                                  }
                                }}
                                className="flex-1 h-8 px-2.5 text-sm tabular-nums font-mono bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                              />
                              <button
                                type="submit"
                                className="h-8 px-3 text-xs font-medium uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
                              >
                                ок
                              </button>
                            </form>
                            {hasEntry && (
                              <button
                                type="button"
                                onClick={() => handleClear(day)}
                                className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
                              >
                                удалить
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
        </Tile>

        {/* Right column: total + weeks */}
        <div className="grid gap-3 min-h-0" style={{ gridTemplateRows: "auto minmax(0, 1fr)" }}>
          {/* Total tile */}
          <Tile className="p-4">
            <TileLabel>итого</TileLabel>
            <div className="mt-2 text-[28px] font-semibold tracking-tight tabular-nums leading-none">
              <MoneyTicker value={monthTotal} currency={currency} />
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground tabular-nums">
              [{daysWithEntries.toString().padStart(2, "0")}/
              {monthDays.length.toString().padStart(2, "0")}] дней
            </div>
          </Tile>

          {/* Weeks tile */}
          <Tile>
            <div className="px-4 py-2 border-b border-border shrink-0 flex items-center justify-between">
              <TileLabel>недели</TileLabel>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                [{weeks.filter(w => w.some(d => isSameMonth(d, currentDate))).length.toString().padStart(2, "0")}]
              </span>
            </div>
            <ul className="flex-1 overflow-auto divide-y divide-border">
              {weeks.map((week, wi) => {
                const monthDaysInWeek = week.filter((d) =>
                  isSameMonth(d, currentDate),
                );
                if (monthDaysInWeek.length === 0) return null;
                const weekTotal = getWeekTotal(week);
                const first = monthDaysInWeek[0];
                const last = monthDaysInWeek[monthDaysInWeek.length - 1];
                return (
                  <li
                    key={wi}
                    className="flex items-center justify-between px-4 py-2.5"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        w{(wi + 1).toString().padStart(2, "0")}
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {format(first, "dd")}—{format(last, "dd")}
                      </span>
                    </div>
                    <span className="text-xs font-semibold tabular-nums">
                      <MoneyTicker value={weekTotal} currency={currency} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </Tile>
        </div>

        {/* Bottom stats bar — spans full width */}
        <div className="col-span-2 grid grid-cols-3 gap-3 min-h-0">
          <Tile className="px-4 py-3">
            <TileLabel>среднее в день</TileLabel>
            <div className="mt-1 text-base font-semibold tabular-nums">
              <MoneyTicker value={averagePerDay} currency={currency} />
            </div>
          </Tile>
          <Tile className="px-4 py-3">
            <TileLabel>лучший день</TileLabel>
            <div className="mt-1 text-base font-semibold tabular-nums">
              <MoneyTicker value={bestDay} currency={currency} />
            </div>
          </Tile>
          <Tile className="px-4 py-3">
            <TileLabel>записей</TileLabel>
            <div className="mt-1 text-base font-semibold tabular-nums">
              {formatNumber(daysWithEntries)}
              <span className="text-muted-foreground">
                {" "}/ {monthDays.length}
              </span>
            </div>
          </Tile>
        </div>
      </div>
    </div>
  );
}

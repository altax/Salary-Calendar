import { useState, useMemo, useEffect, useRef, useCallback } from "react";
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
  isBefore,
  isAfter,
  subDays,
  parseISO,
} from "date-fns";
import { ru } from "date-fns/locale";
import { motion, AnimatePresence } from "framer-motion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useSalaryStore,
  type Currency,
  type JobId,
  type Obligation,
  type SchedulePattern,
  JOBS,
  SCHEDULE_PATTERNS,
  dayTotal,
} from "@/lib/store";
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

function NumericInput({
  value,
  onChange,
  autoFocus,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  onSubmit?: () => void;
}) {
  return (
    <input
      autoFocus={autoFocus}
      inputMode="numeric"
      pattern="[0-9]*"
      placeholder={placeholder}
      value={value}
      onChange={(e) => {
        const cleaned = e.target.value.replace(/\D/g, "");
        onChange(cleaned.replace(/^0+(?=\d)/, ""));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit?.();
          return;
        }
        const allowed = [
          "Backspace", "Delete", "ArrowLeft", "ArrowRight",
          "Tab", "Home", "End",
        ];
        if (allowed.includes(e.key)) return;
        if (e.metaKey || e.ctrlKey) return;
        if (!/^[0-9]$/.test(e.key)) e.preventDefault();
      }}
      className="w-full h-8 px-2.5 text-sm tabular-nums font-mono bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
    />
  );
}

function SchedulePicker({
  currentDate,
  onApply,
  onClear,
}: {
  currentDate: Date;
  onApply: (
    jobId: JobId,
    pattern: SchedulePattern,
    startDayInMonth: number,
    monthDate: Date,
  ) => void;
  onClear: (jobId: JobId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<JobId>("ozon");
  const [patternId, setPatternId] = useState<string>(SCHEDULE_PATTERNS[0].id);
  const [startDay, setStartDay] = useState<string>("1");

  useEffect(() => {
    if (open) setStartDay("1");
  }, [open, currentDate]);

  const monthName = format(currentDate, "LLLL", { locale: ru }).toLowerCase();
  const daysInMonth = endOfMonth(currentDate).getDate();

  const handleApply = () => {
    const pattern =
      SCHEDULE_PATTERNS.find((p) => p.id === patternId)?.pattern ??
      SCHEDULE_PATTERNS[0].pattern;
    const day = Math.max(1, Math.min(parseInt(startDay || "1", 10) || 1, daysInMonth));
    onApply(job, pattern, day, currentDate);
    setOpen(false);
  };

  const handleClear = () => {
    onClear(job);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded-sm hover:bg-muted"
          aria-label="Помощник графика"
        >
          график
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[280px] p-3"
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              график на {monthName}
            </span>
          </div>

          <div className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              работа
            </span>
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              {JOBS.map((j) => (
                <button
                  key={j.id}
                  onClick={() => setJob(j.id)}
                  className={cn(
                    "flex-1 h-8 text-xs font-medium transition-colors flex items-center justify-center gap-1.5",
                    job === j.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "w-3.5 h-3.5 inline-flex items-center justify-center rounded-sm text-[8px] font-bold uppercase",
                      job === j.id
                        ? j.id === "ozon"
                          ? "bg-primary-foreground text-primary"
                          : "border border-primary-foreground text-primary-foreground"
                        : j.id === "ozon"
                          ? "bg-foreground/80 text-background"
                          : "border border-foreground/60 text-foreground/80",
                    )}
                  >
                    {j.short}
                  </span>
                  <span className="truncate">{j.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              цикл
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {SCHEDULE_PATTERNS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPatternId(p.id)}
                  className={cn(
                    "h-8 rounded-md text-xs font-medium tabular-nums transition-colors border",
                    patternId === p.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              первый рабочий день
            </span>
            <NumericInput
              value={startDay}
              onChange={(v) => {
                if (!v) {
                  setStartDay("");
                  return;
                }
                const num = parseInt(v, 10);
                if (Number.isFinite(num)) {
                  setStartDay(String(Math.max(1, Math.min(num, daysInMonth))));
                }
              }}
              onSubmit={handleApply}
              placeholder="1"
            />
            <span className="block text-[9px] text-muted-foreground/70 leading-tight">
              цикл продолжится автоматически в следующих месяцах
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleClear}
              className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
            >
              очистить
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="h-8 px-4 text-xs font-medium uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
            >
              применить
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ObligationsPanel({
  obligations,
  currency,
  convert,
  freeAmount,
  onAdd,
  onUpdate,
  onRemove,
}: {
  obligations: Obligation[];
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  freeAmount: number;
  onAdd: (name: string, amount: number, currency: Currency) => void;
  onUpdate: (
    id: string,
    name: string,
    amount: number,
    currency: Currency,
  ) => void;
  onRemove: (id: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");

  const total = obligations.reduce(
    (s, o) => s + convert(o.amountRub, "RUB", currency),
    0,
  );

  const handleAdd = () => {
    const num = parseInt(newAmount || "0", 10);
    if (!newName.trim() || !Number.isFinite(num) || num <= 0) return;
    onAdd(newName, num, currency);
    setNewName("");
    setNewAmount("");
    setAddOpen(false);
  };

  const handleSaveEdit = () => {
    if (!editId) return;
    const num = parseInt(editAmount || "0", 10);
    if (!editName.trim() || !Number.isFinite(num) || num <= 0) return;
    onUpdate(editId, editName, num, currency);
    setEditId(null);
  };

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-border shrink-0 flex items-center justify-between">
        <TileLabel>обязанности</TileLabel>
        <Popover
          open={addOpen}
          onOpenChange={(open) => {
            setAddOpen(open);
            if (open) {
              setNewName("");
              setNewAmount("");
            }
          }}
        >
          <PopoverTrigger asChild>
            <button
              className="h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-base leading-none"
              aria-label="Добавить обязанность"
            >
              +
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="w-[260px] p-3"
          >
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  новая обязанность
                </span>
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {currency}
                </span>
              </div>
              <input
                autoFocus
                placeholder="название"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                maxLength={40}
                className="w-full h-8 px-2.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <NumericInput
                placeholder="0"
                value={newAmount}
                onChange={setNewAmount}
                onSubmit={handleAdd}
              />
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={handleAdd}
                  className="h-8 px-4 text-xs font-medium uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
                >
                  добавить
                </button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <ul className="flex-1 overflow-auto divide-y divide-border">
        {obligations.length === 0 && (
          <li className="px-4 py-6 text-center text-[11px] text-muted-foreground leading-relaxed">
            нажмите <span className="text-foreground">+</span>
            <br />
            чтобы добавить
            <br />
            аренду, интернет и т.д.
          </li>
        )}
        {obligations.map((o) => {
          const displayAmount = convert(o.amountRub, "RUB", currency);
          const isEditing = editId === o.id;
          return (
            <li key={o.id}>
              <Popover
                open={isEditing}
                onOpenChange={(open) => {
                  if (open) {
                    setEditId(o.id);
                    setEditName(o.name);
                    setEditAmount(String(Math.round(displayAmount)));
                  } else if (isEditing) {
                    setEditId(null);
                  }
                }}
              >
                <PopoverTrigger asChild>
                  <button className="w-full flex items-center justify-between gap-2 px-4 py-2 hover:bg-muted/40 transition-colors text-left outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset">
                    <span className="text-[11px] truncate min-w-0 flex-1">
                      {o.name}
                    </span>
                    <span className="text-xs font-semibold tabular-nums shrink-0">
                      <MoneyTicker
                        value={displayAmount}
                        currency={currency}
                      />
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={4}
                  className="w-[260px] p-3"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                        обязанность
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                        {currency}
                      </span>
                    </div>
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSaveEdit();
                        }
                      }}
                      maxLength={40}
                      className="w-full h-8 px-2.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                    />
                    <NumericInput
                      value={editAmount}
                      onChange={setEditAmount}
                      onSubmit={handleSaveEdit}
                    />
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          onRemove(o.id);
                          setEditId(null);
                        }}
                        className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
                      >
                        удалить
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveEdit}
                        className="h-8 px-4 text-xs font-medium uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
                      >
                        сохранить
                      </button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </li>
          );
        })}
      </ul>

      {obligations.length > 0 && (
        <div className="border-t border-border shrink-0 bg-muted/20 divide-y divide-border">
          <div className="px-4 py-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              всего
            </span>
            <span className="text-sm font-semibold tabular-nums">
              <MoneyTicker value={total} currency={currency} />
            </span>
          </div>
          <div className="px-4 py-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {freeAmount >= 0 ? "свободно" : "не хватает"}
            </span>
            <span
              className={cn(
                "text-sm font-semibold tabular-nums",
                freeAmount < 0 && "text-destructive",
              )}
            >
              <MoneyTicker
                value={Math.abs(freeAmount)}
                currency={currency}
              />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: "dark" | "light";
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-xs"
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

function GoalEditor({
  goalRub,
  currency,
  convert,
  onSet,
  onClear,
}: {
  goalRub: number | null;
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  onSet: (amount: number, currency: Currency) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const displayGoal = goalRub != null ? convert(goalRub, "RUB", currency) : 0;

  useEffect(() => {
    if (open) {
      setVal(goalRub != null ? String(Math.round(displayGoal)) : "");
    }
  }, [open]);

  const handleSave = () => {
    const num = parseInt(val || "0", 10);
    if (!Number.isFinite(num) || num <= 0) {
      onClear();
    } else {
      onSet(num, currency);
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Цель на месяц"
        >
          {goalRub != null ? "цель ✓" : "+ цель"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[240px] p-3">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              цель на месяц
            </span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {currency}
            </span>
          </div>
          <NumericInput
            autoFocus
            value={val}
            onChange={setVal}
            onSubmit={handleSave}
            placeholder="например 150000"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
            >
              убрать
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="h-8 px-4 text-xs font-medium uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
            >
              сохранить
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type ExportData = ReturnType<ReturnType<typeof useSalaryStore>["exportData"]>;

function DataMenu({
  exportData,
  importData,
  buildCsv,
  buildSummary,
}: {
  exportData: () => ExportData;
  importData: (data: unknown) => boolean;
  buildCsv: () => string;
  buildSummary: () => string;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 1500);
  };

  const downloadFile = (
    content: string,
    name: string,
    mime: string,
  ) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleBackup = () => {
    const data = exportData();
    const ts = format(new Date(), "yyyy-MM-dd");
    downloadFile(
      JSON.stringify(data, null, 2),
      `ledger-backup-${ts}.json`,
      "application/json",
    );
    flash("сохранено");
  };

  const handleCsv = () => {
    const ts = format(new Date(), "yyyy-MM");
    downloadFile(buildCsv(), `ledger-${ts}.csv`, "text/csv;charset=utf-8");
    flash("CSV сохранён");
  };

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(buildSummary());
      flash("скопировано");
    } catch {
      flash("не удалось");
    }
  };

  const handleRestore = () => {
    fileRef.current?.click();
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const ok = importData(parsed);
      flash(ok ? "восстановлено" : "ошибка файла");
    } catch {
      flash("ошибка файла");
    }
    e.target.value = "";
    setOpen(false);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-base leading-none"
            aria-label="Меню данных"
          >
            ⋯
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-[200px] p-1">
          <div className="flex flex-col">
            <MenuItem onClick={handleCopySummary} label="скопировать сводку" hint="буфер" />
            <MenuItem onClick={handleCsv} label="экспорт месяца" hint=".csv" />
            <MenuItem onClick={handleBackup} label="резервная копия" hint=".json" />
            <MenuItem onClick={handleRestore} label="восстановить" hint=".json" />
            {feedback && (
              <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground border-t border-border mt-1">
                {feedback}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        onChange={handleFile}
        className="hidden"
      />
    </>
  );
}

function MenuItem({
  onClick,
  label,
  hint,
}: {
  onClick: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-3 px-3 py-2 text-left rounded-md hover:bg-muted transition-colors"
    >
      <span className="text-[11px] truncate">{label}</span>
      {hint && (
        <span className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground shrink-0">
          {hint}
        </span>
      )}
    </button>
  );
}

function Sparkline({
  values,
  max,
  highlight,
}: {
  values: number[];
  max: number;
  highlight?: number;
}) {
  if (max <= 0) {
    return (
      <div className="h-8 flex items-end gap-px opacity-40">
        {values.map((_, i) => (
          <div
            key={i}
            className="flex-1 bg-border rounded-sm"
            style={{ height: "2px" }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="h-8 flex items-end gap-px">
      {values.map((v, i) => {
        const isHighlight = highlight != null && i === highlight;
        return (
          <div
            key={i}
            className={cn(
              "flex-1 rounded-sm",
              v > 0
                ? isHighlight
                  ? "bg-primary"
                  : "bg-foreground/70"
                : "bg-border/40",
            )}
            style={{
              height: v > 0 ? `${Math.max(10, (v / max) * 100)}%` : "8%",
            }}
          />
        );
      })}
    </div>
  );
}

function YearView({
  year,
  setYear,
  entries,
  currency,
  convert,
  onPickMonth,
  onClose,
}: {
  year: number;
  setYear: (updater: number | ((prev: number) => number)) => void;
  entries: Record<string, Partial<Record<JobId, number>>>;
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  onPickMonth: (date: Date) => void;
  onClose: () => void;
}) {
  const today = new Date();
  const months = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const monthDate = new Date(year, i, 1);
      const days = eachDayOfInterval({
        start: startOfMonth(monthDate),
        end: endOfMonth(monthDate),
      });
      const dailyValues = days.map((d) => {
        const entry = entries[format(d, "yyyy-MM-dd")];
        return entry ? convert(dayTotal(entry), "RUB", currency) : 0;
      });
      const perJob: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
      for (const d of days) {
        const entry = entries[format(d, "yyyy-MM-dd")];
        if (!entry) continue;
        for (const job of JOBS) {
          const v = entry[job.id];
          if (typeof v === "number") {
            perJob[job.id] += convert(v, "RUB", currency);
          }
        }
      }
      const total = dailyValues.reduce((a, b) => a + b, 0);
      const worked = dailyValues.filter((v) => v > 0).length;
      const best = dailyValues.reduce((a, b) => Math.max(a, b), 0);
      const bestIdx = best > 0 ? dailyValues.indexOf(best) : -1;
      return {
        monthDate,
        dailyValues,
        total,
        worked,
        best,
        bestIdx,
        perJob,
      };
    });
  }, [year, entries, currency, convert]);

  const yearTotal = months.reduce((s, m) => s + m.total, 0);
  const monthsWithData = months.filter((m) => m.total > 0);
  const avgMonth = monthsWithData.length
    ? yearTotal / monthsWithData.length
    : 0;
  const bestMonth = months.reduce(
    (a, b) => (b.total > a.total ? b : a),
    months[0],
  );
  const yearMaxDay = months.reduce(
    (a, m) => Math.max(a, m.best),
    0,
  );
  const totalWorkedDays = months.reduce((s, m) => s + m.worked, 0);
  const yearAvgPerDay =
    totalWorkedDays > 0 ? yearTotal / totalWorkedDays : 0;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setYear((y) => y - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setYear((y) => y + 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, setYear]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-40 bg-background/95 backdrop-blur-sm overflow-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-auto max-w-[1280px] p-3 sm:p-4">
        {/* Top bar */}
        <div className="rounded-2xl border border-border bg-card flex items-center justify-between px-4 py-2.5 mb-3">
          <div className="flex items-center gap-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              [год]
            </span>
            <button
              onClick={() => setYear((y) => y - 1)}
              aria-label="Предыдущий год"
              title="← предыдущий год"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-sm"
            >
              ‹
            </button>
            <span className="text-sm font-medium tabular-nums">{year}</span>
            <button
              onClick={() => setYear((y) => y + 1)}
              aria-label="Следующий год"
              title="→ следующий год"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-sm"
            >
              ›
            </button>
            <button
              onClick={() => setYear(today.getFullYear())}
              className="h-7 px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground hover:bg-muted rounded-md transition-colors"
            >
              этот год
            </button>
          </div>
          <button
            onClick={onClose}
            title="Esc"
            className="h-7 px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
          >
            закрыть
          </button>
        </div>

        {/* Year-level stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Tile>
            <div className="px-4 py-3">
              <TileLabel>итого</TileLabel>
              <div className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">
                {yearTotal > 0 ? (
                  <MoneyTicker value={yearTotal} currency={currency} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                {monthsWithData.length} из 12 мес
              </div>
            </div>
          </Tile>
          <Tile>
            <div className="px-4 py-3">
              <TileLabel>в среднем / мес</TileLabel>
              <div className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">
                {avgMonth > 0 ? (
                  <MoneyTicker value={avgMonth} currency={currency} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                по активным
              </div>
            </div>
          </Tile>
          <Tile>
            <div className="px-4 py-3">
              <TileLabel>в среднем / день</TileLabel>
              <div className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">
                {yearAvgPerDay > 0 ? (
                  <MoneyTicker value={yearAvgPerDay} currency={currency} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                {totalWorkedDays} раб. дней
              </div>
            </div>
          </Tile>
          <Tile>
            <div className="px-4 py-3">
              <TileLabel>лучший месяц</TileLabel>
              <div className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">
                {bestMonth.total > 0 ? (
                  <MoneyTicker
                    value={bestMonth.total}
                    currency={currency}
                  />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                {bestMonth.total > 0
                  ? format(bestMonth.monthDate, "LLLL", {
                      locale: ru,
                    }).toLowerCase()
                  : "—"}
              </div>
            </div>
          </Tile>
        </div>

        {/* Month grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {months.map((m) => {
            const isCurrent =
              m.monthDate.getMonth() === today.getMonth() &&
              m.monthDate.getFullYear() === today.getFullYear();
            const isFuture =
              m.monthDate.getFullYear() > today.getFullYear() ||
              (m.monthDate.getFullYear() === today.getFullYear() &&
                m.monthDate.getMonth() > today.getMonth());
            const monthLabel = format(m.monthDate, "LLLL", {
              locale: ru,
            }).toLowerCase();

            return (
              <button
                key={m.monthDate.toISOString()}
                onClick={() => onPickMonth(m.monthDate)}
                className={cn(
                  "rounded-2xl border bg-card p-3 text-left hover:bg-muted/30 transition-colors flex flex-col gap-2 outline-none focus-visible:ring-1 focus-visible:ring-primary",
                  isCurrent ? "border-primary/60" : "border-border",
                  isFuture && m.total === 0 && "opacity-60",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "text-[11px] font-medium uppercase tracking-[0.18em]",
                      isCurrent ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {monthLabel}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {m.worked > 0 ? `${m.worked}д` : "—"}
                  </span>
                </div>
                <div className="text-[18px] font-semibold tabular-nums tracking-tight leading-none">
                  {m.total > 0 ? (
                    formatMoney(m.total, currency)
                  ) : (
                    <span className="text-muted-foreground/60 text-sm font-normal">
                      —
                    </span>
                  )}
                </div>
                <Sparkline
                  values={m.dailyValues}
                  max={yearMaxDay}
                  highlight={m.bestIdx}
                />
                <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm bg-foreground/80" />
                    {m.perJob.ozon > 0
                      ? formatMoney(m.perJob.ozon, currency)
                      : "—"}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm border border-foreground/60" />
                    {m.perJob.dostaevsky > 0
                      ? formatMoney(m.perJob.dostaevsky, currency)
                      : "—"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

export default function Calendar() {
  const {
    entries,
    currency,
    setCurrency,
    setDayEntries,
    convert,
    obligations,
    addObligation,
    updateObligation,
    removeObligation,
    scheduleAnchors,
    applyScheduleAnchor,
    clearScheduleForJob,
    toggleScheduleDay,
    getScheduledJobsFor,
    goalRub,
    setGoal,
    clearGoal,
    theme,
    toggleTheme,
    exportData,
    importData,
  } = useSalaryStore();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<JobId, string>>({
    ozon: "",
    dostaevsky: "",
  });
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  const [yearViewOpen, setYearViewOpen] = useState(false);
  const [yearViewYear, setYearViewYear] = useState(
    () => new Date().getFullYear(),
  );

  const openYearView = useCallback(() => {
    setYearViewYear(currentDate.getFullYear());
    setYearViewOpen(true);
  }, [currentDate]);

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

  const getDayEntry = (date: Date) => entries[format(date, "yyyy-MM-dd")];
  const getDayRub = (date: Date) => dayTotal(getDayEntry(date));
  const getDayInDisplay = (date: Date) =>
    convert(getDayRub(date), "RUB", currency);

  const getJobsWorked = (date: Date): JobId[] => {
    const entry = getDayEntry(date);
    if (!entry) return [];
    return JOBS.filter((j) => (entry[j.id] ?? 0) > 0).map((j) => j.id);
  };

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

  const today = new Date();

  // Per-job monthly totals for the sidebar breakdown
  const perJobMonthTotal = useMemo(() => {
    const totals: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
    for (const d of monthDays) {
      const entry = getDayEntry(d);
      if (!entry) continue;
      for (const job of JOBS) {
        const v = entry[job.id];
        if (typeof v === "number") {
          totals[job.id] += convert(v, "RUB", currency);
        }
      }
    }
    return totals;
  }, [monthDays, entries, currency, convert]);

  // Per-job: average earned on a worked day (used as placeholder hint)
  const perJobDailyAverage = useMemo(() => {
    const sums: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
    const counts: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
    for (const d of monthDays) {
      const entry = getDayEntry(d);
      if (!entry) continue;
      for (const job of JOBS) {
        const v = entry[job.id];
        if (typeof v === "number" && v > 0) {
          sums[job.id] += convert(v, "RUB", currency);
          counts[job.id] += 1;
        }
      }
    }
    return {
      ozon: counts.ozon > 0 ? sums.ozon / counts.ozon : 0,
      dostaevsky: counts.dostaevsky > 0 ? sums.dostaevsky / counts.dostaevsky : 0,
    } as Record<JobId, number>;
  }, [monthDays, entries, currency, convert]);

  // Forecast: average per worked day (any job) × remaining scheduled days,
  // added to current monthTotal. Falls back to averagePerDay × remaining days
  // when no schedule is set.
  const forecast = useMemo(() => {
    const todayKey = format(today, "yyyy-MM-dd");
    const remainingDays = monthDays.filter((d) => {
      const k = format(d, "yyyy-MM-dd");
      // strictly after today AND not yet entered
      return k > todayKey && getDayRub(d) === 0;
    });
    if (remainingDays.length === 0) return monthTotal;
    if (averagePerDay <= 0) return monthTotal;

    const anyAnchored = JOBS.some((j) => scheduleAnchors[j.id]);
    if (!anyAnchored) {
      // No schedule — assume every remaining day will earn the average.
      return monthTotal + averagePerDay * remainingDays.length;
    }

    let scheduledDaysAhead = 0;
    for (const d of remainingDays) {
      if (getScheduledJobsFor(d).length > 0) scheduledDaysAhead += 1;
    }
    return monthTotal + averagePerDay * scheduledDaysAhead;
  }, [
    monthDays,
    monthTotal,
    averagePerDay,
    scheduleAnchors,
    getScheduledJobsFor,
    entries,
  ]);

  // Comparison with previous month
  const previousMonthTotal = useMemo(() => {
    const prev = subMonths(currentDate, 1);
    const prevDays = eachDayOfInterval({
      start: startOfMonth(prev),
      end: endOfMonth(prev),
    });
    let sum = 0;
    for (const d of prevDays) {
      const entry = getDayEntry(d);
      if (!entry) continue;
      sum += convert(dayTotal(entry), "RUB", currency);
    }
    return sum;
  }, [currentDate, entries, currency, convert]);

  const comparisonPct = useMemo(() => {
    if (previousMonthTotal <= 0) return null;
    return ((monthTotal - previousMonthTotal) / previousMonthTotal) * 100;
  }, [monthTotal, previousMonthTotal]);

  // Goal in display currency
  const goalDisplay = goalRub != null ? convert(goalRub, "RUB", currency) : 0;
  const goalPct =
    goalRub != null && goalDisplay > 0
      ? Math.min(200, (monthTotal / goalDisplay) * 100)
      : 0;

  // Obligations totals + free amount
  const obligationsTotal = useMemo(
    () =>
      obligations.reduce(
        (s, o) => s + convert(o.amountRub, "RUB", currency),
        0,
      ),
    [obligations, currency, convert],
  );
  const freeAmount = monthTotal - obligationsTotal;

  // Work / off day counts for header
  const { workCount, offCount } = useMemo(() => {
    let work = 0;
    let off = 0;
    const anyAnchored = JOBS.some((j) => scheduleAnchors[j.id]);
    if (!anyAnchored) {
      // Fall back to "worked = days with entries", "off = days without"
      for (const d of monthDays) {
        if (getDayRub(d) > 0) work += 1;
        else off += 1;
      }
      return { workCount: work, offCount: off };
    }
    for (const d of monthDays) {
      const scheduled = getScheduledJobsFor(d).length > 0;
      const worked = getDayRub(d) > 0;
      if (scheduled || worked) work += 1;
      else off += 1;
    }
    return { workCount: work, offCount: off };
  }, [monthDays, scheduleAnchors, getScheduledJobsFor, entries]);

  const handleSave = (date: Date) => {
    const amounts: Partial<Record<JobId, number>> = {};
    for (const job of JOBS) {
      const num = parseInt(editValues[job.id] || "0", 10);
      if (Number.isFinite(num) && num > 0) amounts[job.id] = num;
    }
    setDayEntries(format(date, "yyyy-MM-dd"), amounts, currency);
    setOpenKey(null);
  };

  const handleClear = (date: Date) => {
    setDayEntries(format(date, "yyyy-MM-dd"), {}, currency);
    setOpenKey(null);
  };

  const handleCopyFromYesterday = (date: Date) => {
    const yesterday = subDays(date, 1);
    const entry = getDayEntry(yesterday);
    if (!entry) return;
    const next: Record<JobId, string> = { ozon: "", dostaevsky: "" };
    for (const job of JOBS) {
      const v = entry[job.id];
      if (typeof v === "number" && v > 0) {
        next[job.id] = String(Math.round(convert(v, "RUB", currency)));
      }
    }
    setEditValues(next);
  };

  const monthName = format(currentDate, "LLLL", { locale: ru }).toLowerCase();
  const yearStr = format(currentDate, "yyyy");

  const handlePickMonth = (monthIndex: number) => {
    let next = setYear(currentDate, pickerYear);
    next = setMonth(next, monthIndex);
    next = startOfMonth(next);
    setCurrentDate(next);
    setMonthPickerOpen(false);
  };

  // CSV + summary builders for the data menu
  const buildCsv = useCallback(() => {
    const lines: string[] = [];
    lines.push("дата,озон,достаевский,итого,валюта");
    for (const d of monthDays) {
      const key = format(d, "yyyy-MM-dd");
      const entry = entries[key];
      const ozon = entry?.ozon
        ? Math.round(convert(entry.ozon, "RUB", currency))
        : 0;
      const dost = entry?.dostaevsky
        ? Math.round(convert(entry.dostaevsky, "RUB", currency))
        : 0;
      const total = ozon + dost;
      lines.push(`${key},${ozon},${dost},${total},${currency}`);
    }
    lines.push("");
    lines.push(
      `# итого ${monthName} ${yearStr}: ${Math.round(monthTotal)} ${currency}`,
    );
    return lines.join("\n");
  }, [monthDays, entries, currency, convert, monthName, yearStr, monthTotal]);

  const buildSummary = useCallback(() => {
    const parts: string[] = [];
    parts.push(
      `${monthName} ${yearStr}: ${formatMoney(monthTotal, currency)}`,
    );
    const jobBits = JOBS.filter((j) => perJobMonthTotal[j.id] > 0).map(
      (j) =>
        `${j.label.toLowerCase()} ${formatMoney(perJobMonthTotal[j.id], currency)}`,
    );
    if (jobBits.length) parts.push(jobBits.join(", "));
    parts.push(
      `среднее ${formatMoney(averagePerDay, currency)}/день · ${daysWithEntries} раб. дней`,
    );
    if (obligationsTotal > 0) {
      parts.push(
        `обязательства ${formatMoney(obligationsTotal, currency)} → свободно ${formatMoney(freeAmount, currency)}`,
      );
    }
    if (goalRub != null && goalDisplay > 0) {
      parts.push(`цель ${formatMoney(goalDisplay, currency)} (${Math.round(goalPct)}%)`);
    }
    return parts.join(" • ");
  }, [
    monthName,
    yearStr,
    monthTotal,
    currency,
    perJobMonthTotal,
    averagePerDay,
    daysWithEntries,
    obligationsTotal,
    freeAmount,
    goalRub,
    goalDisplay,
    goalPct,
  ]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if a popover is open or focus is in an input/textarea
      if (openKey || monthPickerOpen) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (yearViewOpen) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrentDate((d) => subMonths(d, 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCurrentDate((d) => addMonths(d, 1));
      } else if (e.key === "t" || e.key === "T" || e.key === "е" || e.key === "Е") {
        e.preventDefault();
        setCurrentDate(new Date());
      } else if (e.key === "y" || e.key === "Y" || e.key === "н" || e.key === "Н") {
        e.preventDefault();
        openYearView();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openKey, monthPickerOpen, yearViewOpen, openYearView]);

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground overflow-hidden p-3 sm:p-4">
      <div
        className="mx-auto w-full max-w-[1280px] h-full grid gap-3 min-h-0"
        style={{
          gridTemplateColumns: "minmax(0, 1fr) 240px 240px",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        {/* Header bar */}
        <header className="col-span-3 rounded-2xl border border-border bg-card flex items-center justify-between px-4 py-2.5 min-h-0">
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

            {/* Work / off day counter */}
            <span
              className="hidden sm:inline-flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums"
              title="Рабочие / выходные дни в месяце"
            >
              <span className="text-foreground/80">{workCount.toString().padStart(2, "0")}</span>
              <span>раб</span>
              <span className="opacity-50">/</span>
              <span className="text-foreground/80">{offCount.toString().padStart(2, "0")}</span>
              <span>вых</span>
            </span>

            <button
              onClick={openYearView}
              title="Y — обзор года"
              className="hidden sm:inline-flex h-7 px-2 items-center text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
            >
              год ▾
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentDate(subMonths(currentDate, 1))}
              aria-label="Предыдущий месяц"
              title="← предыдущий месяц"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors text-sm"
            >
              ‹
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              title="T — сегодня"
              className="h-7 px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground hover:bg-muted rounded-md transition-colors"
            >
              сегодня
            </button>
            <button
              onClick={() => setCurrentDate(addMonths(currentDate, 1))}
              aria-label="Следующий месяц"
              title="→ следующий месяц"
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
            <div className="w-px h-5 bg-border mx-1.5" />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <DataMenu
              exportData={exportData}
              importData={importData}
              buildCsv={buildCsv}
              buildSummary={buildSummary}
            />
          </div>
        </header>

        {/* Calendar tile */}
        <Tile>
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

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${currentDate.getFullYear()}-${currentDate.getMonth()}`}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
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
                      const jobsWorked = getJobsWorked(day);
                      const jobsScheduled = getScheduledJobsFor(day);
                      const visibleJobs = JOBS.filter(
                        (j) =>
                          jobsWorked.includes(j.id) ||
                          jobsScheduled.includes(j.id),
                      );
                      const key = format(day, "yyyy-MM-dd");
                      const isOpen = openKey === key;
                      const weekend = isWeekend(day);
                      const isLastCol = di === 6;
                      const yesterday = subDays(day, 1);
                      const yesterdayEntry = getDayEntry(yesterday);
                      const hasYesterday =
                        !!yesterdayEntry && dayTotal(yesterdayEntry) > 0;

                      return (
                        <Popover
                          key={key}
                          open={isOpen}
                          onOpenChange={(open) => {
                            if (open) {
                              setOpenKey(key);
                              const entry = getDayEntry(day);
                              const next: Record<JobId, string> = {
                                ozon: "",
                                dostaevsky: "",
                              };
                              if (entry && isCurrentMonth) {
                                for (const job of JOBS) {
                                  const v = entry[job.id];
                                  if (typeof v === "number" && v > 0) {
                                    const inDisplay = Math.round(
                                      convert(v, "RUB", currency),
                                    );
                                    next[job.id] = String(inDisplay);
                                  }
                                }
                              }
                              setEditValues(next);
                            } else if (isOpen) {
                              setOpenKey(null);
                            }
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button
                              onContextMenu={(e) => {
                                // Right-click: toggle schedule for the first
                                // scheduled job, or for ozon by default if
                                // none is scheduled but at least one is anchored.
                                if (!isCurrentMonth) return;
                                const targets = jobsScheduled.length
                                  ? jobsScheduled
                                  : JOBS.filter((j) => scheduleAnchors[j.id]).map(
                                      (j) => j.id,
                                    );
                                if (targets.length === 0) return;
                                e.preventDefault();
                                toggleScheduleDay(targets[0], day);
                              }}
                              className={cn(
                                "flex flex-col items-stretch justify-between text-left transition-colors outline-none relative min-h-0 px-2 py-1.5 group",
                                !isLastCol && "border-r border-border",
                                !isCurrentMonth && "bg-background/40",
                                isCurrentMonth && weekend && !hasEntry && "bg-muted/15",
                                isCurrentMonth && hasEntry && "bg-foreground/[0.025]",
                                isCurrentMonth && "hover:bg-muted/40",
                                "focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset",
                              )}
                            >
                              <div className="flex items-center justify-between gap-1">
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

                                {/* Job tag markers (worked = full, scheduled-only = faded) */}
                                {visibleJobs.length > 0 && isCurrentMonth && (
                                  <div className="flex items-center gap-0.5">
                                    {visibleJobs.map((job) => {
                                      const isWorked = jobsWorked.includes(job.id);
                                      return (
                                        <span
                                          key={job.id}
                                          title={`${job.label}${isWorked ? "" : " (план)"}`}
                                          className={cn(
                                            "w-3.5 h-3.5 inline-flex items-center justify-center rounded-sm text-[8px] font-bold uppercase tracking-tight leading-none transition-opacity",
                                            job.id === "ozon"
                                              ? "bg-foreground/80 text-background"
                                              : "border border-foreground/60 text-foreground/80",
                                            !isWorked && "opacity-35",
                                          )}
                                        >
                                          {job.short}
                                        </span>
                                      );
                                    })}
                                  </div>
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
                            className="w-[280px] p-3"
                            align="center"
                            sideOffset={4}
                          >
                            <div className="space-y-3">
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
                                className="space-y-2"
                              >
                                {JOBS.map((job, idx) => {
                                  const isOnSchedule = jobsScheduled.includes(
                                    job.id,
                                  );
                                  const placeholder =
                                    perJobDailyAverage[job.id] > 0
                                      ? String(
                                          Math.round(perJobDailyAverage[job.id]),
                                        )
                                      : "0";
                                  return (
                                    <div
                                      key={job.id}
                                      className="flex items-center gap-2"
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          toggleScheduleDay(job.id, day)
                                        }
                                        title={
                                          isOnSchedule
                                            ? "Убрать из графика"
                                            : "В график"
                                        }
                                        className={cn(
                                          "shrink-0 w-5 h-5 inline-flex items-center justify-center rounded-sm text-[10px] font-bold uppercase transition-opacity",
                                          job.id === "ozon"
                                            ? "bg-foreground/80 text-background"
                                            : "border border-foreground/60 text-foreground/80",
                                          !isOnSchedule && "opacity-35",
                                        )}
                                      >
                                        {job.short}
                                      </button>
                                      <span className="text-[11px] tracking-[0.05em] text-muted-foreground w-[88px] truncate">
                                        {job.label}
                                      </span>
                                      <NumericInput
                                        autoFocus={idx === 0}
                                        placeholder={placeholder}
                                        value={editValues[job.id]}
                                        onChange={(v) =>
                                          setEditValues((prev) => ({
                                            ...prev,
                                            [job.id]: v,
                                          }))
                                        }
                                        onSubmit={() => handleSave(day)}
                                      />
                                    </div>
                                  );
                                })}

                                {hasYesterday && (
                                  <button
                                    type="button"
                                    onClick={() => handleCopyFromYesterday(day)}
                                    className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    ↑ как вчера
                                  </button>
                                )}

                                <div className="flex items-center justify-between gap-2 pt-1">
                                  {hasEntry ? (
                                    <button
                                      type="button"
                                      onClick={() => handleClear(day)}
                                      className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
                                    >
                                      удалить
                                    </button>
                                  ) : (
                                    <span />
                                  )}
                                  <button
                                    type="submit"
                                    className="h-8 px-4 text-xs font-medium uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
                                  >
                                    сохранить
                                  </button>
                                </div>
                              </form>
                            </div>
                          </PopoverContent>
                        </Popover>
                      );
                    })}
                  </div>
                );
              })}
            </motion.div>
          </AnimatePresence>
        </Tile>

        {/* Right column: total + per-job + weeks */}
        <div
          className="grid gap-3 min-h-0"
          style={{ gridTemplateRows: "auto auto minmax(0, 1fr)" }}
        >
          {/* Total tile (merged with stats) */}
          <Tile>
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-center justify-between">
                <TileLabel>итого</TileLabel>
                {comparisonPct != null && (
                  <span
                    className={cn(
                      "text-[10px] tabular-nums font-medium tracking-tight",
                      comparisonPct >= 0
                        ? "text-foreground/70"
                        : "text-destructive/80",
                    )}
                    title={`Прошлый месяц: ${formatMoney(previousMonthTotal, currency)}`}
                  >
                    {comparisonPct >= 0 ? "+" : ""}
                    {comparisonPct.toFixed(0)}%
                  </span>
                )}
              </div>
              <div className="mt-2 text-[28px] font-semibold tracking-tight tabular-nums leading-none">
                <MoneyTicker value={monthTotal} currency={currency} />
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground tabular-nums">
                [{daysWithEntries.toString().padStart(2, "0")}/
                {monthDays.length.toString().padStart(2, "0")}] дней
              </div>

              {/* Forecast */}
              {forecast > monthTotal && (
                <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="uppercase tracking-[0.2em] text-muted-foreground/70 text-[9px]">
                    прогноз
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatMoney(forecast, currency)}
                  </span>
                </div>
              )}

              {/* Goal */}
              <div className="mt-3 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <GoalEditor
                    goalRub={goalRub}
                    currency={currency}
                    convert={convert}
                    onSet={setGoal}
                    onClear={clearGoal}
                  />
                  {goalRub != null && goalDisplay > 0 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {formatMoney(goalDisplay, currency)} ·{" "}
                      <span
                        className={cn(
                          "font-medium",
                          goalPct >= 100 ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {Math.round(goalPct)}%
                      </span>
                    </span>
                  )}
                </div>
                {goalRub != null && goalDisplay > 0 && (
                  <div className="h-[3px] w-full rounded-full bg-muted overflow-hidden">
                    <motion.div
                      initial={false}
                      animate={{ width: `${Math.min(100, goalPct)}%` }}
                      transition={{ duration: 0.32, ease: "easeOut" }}
                      className={cn(
                        "h-full rounded-full",
                        goalPct >= 100 ? "bg-foreground" : "bg-foreground/60",
                      )}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="border-t border-border divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  среднее в день
                </span>
                <span className="text-xs font-semibold tabular-nums">
                  <MoneyTicker value={averagePerDay} currency={currency} />
                </span>
              </div>
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  лучший день
                </span>
                <span className="text-xs font-semibold tabular-nums">
                  <MoneyTicker value={bestDay} currency={currency} />
                </span>
              </div>
            </div>
          </Tile>

          {/* Per-job breakdown + schedule helper */}
          <Tile>
            <div className="px-4 py-2 border-b border-border shrink-0 flex items-center justify-between">
              <TileLabel>по работам</TileLabel>
              <SchedulePicker
                currentDate={currentDate}
                onApply={applyScheduleAnchor}
                onClear={clearScheduleForJob}
              />
            </div>
            <ul className="divide-y divide-border">
              {JOBS.map((job) => (
                <li
                  key={job.id}
                  className="flex items-center justify-between px-4 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        "shrink-0 w-4 h-4 inline-flex items-center justify-center rounded-sm text-[9px] font-bold uppercase",
                        job.id === "ozon"
                          ? "bg-foreground/80 text-background"
                          : "border border-foreground/60 text-foreground/80",
                      )}
                    >
                      {job.short}
                    </span>
                    <span className="text-[11px] truncate">{job.label}</span>
                  </div>
                  <span className="text-xs font-semibold tabular-nums">
                    <MoneyTicker
                      value={perJobMonthTotal[job.id]}
                      currency={currency}
                    />
                  </span>
                </li>
              ))}
            </ul>
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
                    className="flex items-center justify-between px-4 py-2"
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

        {/* Obligations column */}
        <ObligationsPanel
          obligations={obligations}
          currency={currency}
          convert={convert}
          freeAmount={freeAmount}
          onAdd={addObligation}
          onUpdate={updateObligation}
          onRemove={removeObligation}
        />

      </div>

      <AnimatePresence>
        {yearViewOpen && (
          <YearView
            year={yearViewYear}
            setYear={setYearViewYear}
            entries={entries}
            currency={currency}
            convert={convert}
            onPickMonth={(date) => {
              setCurrentDate(startOfMonth(date));
              setYearViewOpen(false);
            }}
            onClose={() => setYearViewOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

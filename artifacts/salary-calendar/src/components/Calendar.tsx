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
  subDays,
  parseISO,
  differenceInCalendarDays,
} from "date-fns";
import { ru } from "date-fns/locale";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "wouter";
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
  type Category,
  type SchedulePattern,
  type ResolvedJob,
  SCHEDULE_PATTERNS,
  JOB_COLOR_PALETTE,
  dayTotal,
  isScheduledByAnchor,
} from "@/lib/store";
import { useDeliveriesStore, deliveriesByDay } from "@/lib/deliveries";
import DayDetailModal from "@/components/DayDetailModal";
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

function JobBadge({
  job,
  size = "sm",
  active = true,
  className,
}: {
  job: ResolvedJob;
  size?: "xs" | "sm" | "md" | "lg";
  active?: boolean;
  className?: string;
}) {
  const sizeCls =
    size === "lg"
      ? "w-5 h-5 text-[10px]"
      : size === "md"
        ? "w-4 h-4 text-[9px]"
        : size === "xs"
          ? "w-3 h-3 text-[7px]"
          : "w-3.5 h-3.5 text-[8px]";

  if (job.color) {
    return (
      <span
        style={{ backgroundColor: job.color, color: "#fff" }}
        className={cn(
          sizeCls,
          "inline-flex items-center justify-center rounded-sm font-bold uppercase tracking-tight leading-none transition-opacity",
          !active && "opacity-35",
          className,
        )}
      >
        {job.short}
      </span>
    );
  }

  // Default styling: first job filled, second outlined
  const isFirst = job.id === "ozon";
  return (
    <span
      className={cn(
        sizeCls,
        "inline-flex items-center justify-center rounded-sm font-bold uppercase tracking-tight leading-none transition-opacity",
        isFirst
          ? "bg-foreground/80 text-background"
          : "border border-foreground/60 text-foreground/80",
        !active && "opacity-35",
        className,
      )}
    >
      {job.short}
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

function ChipSuggestions({
  values,
  onPick,
}: {
  values: number[];
  onPick: (value: number) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className="h-5 px-1.5 text-[10px] tabular-nums rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/40 transition-colors"
        >
          {formatNumber(v)}
        </button>
      ))}
    </div>
  );
}

function SchedulePicker({
  currentDate,
  jobs,
  onApply,
  onClear,
}: {
  currentDate: Date;
  jobs: ResolvedJob[];
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
              {jobs.map((j) => (
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
                  <JobBadge job={j} size="sm" />
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

function CategoryPicker({
  categories,
  value,
  onChange,
  onAddCategory,
}: {
  categories: Category[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  onAddCategory: (name: string) => Category | null;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const handleAdd = () => {
    const cat = onAddCategory(name);
    if (cat) {
      onChange(cat.id);
      setAdding(false);
      setName("");
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        категория
      </span>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className={cn(
            "h-6 px-2 text-[10px] uppercase tracking-[0.15em] rounded border transition-colors",
            value === undefined
              ? "bg-foreground text-background border-foreground"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          без
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={cn(
              "h-6 px-2 text-[10px] uppercase tracking-[0.15em] rounded border transition-colors",
              value === c.id
                ? "bg-foreground text-background border-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            {c.name}
          </button>
        ))}
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="h-6 px-2 text-[10px] uppercase tracking-[0.15em] rounded border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            +
          </button>
        )}
      </div>
      {adding && (
        <div className="flex gap-1.5">
          <input
            autoFocus
            placeholder="название"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
              if (e.key === "Escape") {
                setAdding(false);
                setName("");
              }
            }}
            maxLength={20}
            className="flex-1 h-7 px-2 text-xs bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
          <button
            type="button"
            onClick={handleAdd}
            className="h-7 px-2 text-[10px] uppercase tracking-[0.15em] bg-primary text-primary-foreground rounded-md hover:opacity-90"
          >
            ок
          </button>
        </div>
      )}
    </div>
  );
}

function ObligationsPanel({
  obligations,
  categories,
  currency,
  convert,
  freeAmount,
  taxRate,
  taxAmount,
  taxDueLabel,
  taxDueAmount,
  onAdd,
  onUpdate,
  onRemove,
  onAddCategory,
  onSetTaxRate,
}: {
  obligations: Obligation[];
  categories: Category[];
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  freeAmount: number;
  taxRate: number;
  taxAmount: number;
  taxDueLabel: string | null;
  taxDueAmount: number;
  onAdd: (
    name: string,
    amount: number,
    currency: Currency,
    categoryId?: string,
  ) => void;
  onUpdate: (
    id: string,
    name: string,
    amount: number,
    currency: Currency,
    categoryId?: string,
  ) => void;
  onRemove: (id: string) => void;
  onAddCategory: (name: string) => Category | null;
  onSetTaxRate: (rate: number) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newCategoryId, setNewCategoryId] = useState<string | undefined>();
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCategoryId, setEditCategoryId] = useState<string | undefined>();
  const [taxOpen, setTaxOpen] = useState(false);

  const total = obligations.reduce(
    (s, o) => s + convert(o.amountRub, "RUB", currency),
    0,
  );

  // Group obligations by category for display
  const grouped = useMemo(() => {
    const map = new Map<string, Obligation[]>();
    for (const o of obligations) {
      const key = o.categoryId || "__none";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    return map;
  }, [obligations]);

  const groupTotal = (items: Obligation[]) =>
    items.reduce((s, o) => s + convert(o.amountRub, "RUB", currency), 0);

  // Build display order: categories with items first, then orphan group
  const displayGroups: { id: string; name: string; items: Obligation[] }[] = [];
  for (const c of categories) {
    const items = grouped.get(c.id) || [];
    if (items.length > 0) displayGroups.push({ id: c.id, name: c.name, items });
  }
  const orphan = grouped.get("__none") || [];
  // Also any items with categoryId not in categories list
  const unknownIds: Obligation[] = [];
  for (const [k, items] of grouped.entries()) {
    if (k === "__none") continue;
    if (!categories.find((c) => c.id === k)) unknownIds.push(...items);
  }
  const allOrphan = [...orphan, ...unknownIds];
  if (allOrphan.length > 0) {
    displayGroups.push({ id: "__none", name: "без категории", items: allOrphan });
  }

  const handleAdd = () => {
    const num = parseInt(newAmount || "0", 10);
    if (!newName.trim() || !Number.isFinite(num) || num <= 0) return;
    onAdd(newName, num, currency, newCategoryId);
    setNewName("");
    setNewAmount("");
    setNewCategoryId(undefined);
    setAddOpen(false);
  };

  const handleSaveEdit = () => {
    if (!editId) return;
    const num = parseInt(editAmount || "0", 10);
    if (!editName.trim() || !Number.isFinite(num) || num <= 0) return;
    onUpdate(editId, editName, num, currency, editCategoryId);
    setEditId(null);
  };

  const renderObligationRow = (o: Obligation) => {
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
              setEditCategoryId(o.categoryId);
            } else if (isEditing) {
              setEditId(null);
            }
          }}
        >
          <PopoverTrigger asChild>
            <button className="w-full flex items-center justify-between gap-2 px-4 py-1.5 hover:bg-muted/40 transition-colors text-left outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset">
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
            className="w-[280px] p-3"
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
              <CategoryPicker
                categories={categories}
                value={editCategoryId}
                onChange={setEditCategoryId}
                onAddCategory={onAddCategory}
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
              setNewCategoryId(undefined);
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
            className="w-[280px] p-3"
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
              <CategoryPicker
                categories={categories}
                value={newCategoryId}
                onChange={setNewCategoryId}
                onAddCategory={onAddCategory}
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

      <div className="flex-1 overflow-auto">
        {obligations.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground leading-relaxed">
            нажмите <span className="text-foreground">+</span>
            <br />
            чтобы добавить
            <br />
            аренду, интернет и т.д.
          </div>
        ) : (
          displayGroups.map((g) => {
            const subtotal = groupTotal(g.items);
            return (
              <div key={g.id} className="border-b border-border last:border-b-0">
                <div className="px-4 pt-2 pb-1 flex items-baseline justify-between">
                  <span className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground/70">
                    {g.name}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">
                    {formatMoney(subtotal, currency)}
                  </span>
                </div>
                <ul className="divide-y divide-border/40">
                  {g.items.map(renderObligationRow)}
                </ul>
              </div>
            );
          })
        )}
      </div>

      {(obligations.length > 0 || taxRate > 0) && (
        <div className="border-t border-border shrink-0 bg-muted/20 divide-y divide-border">
          {obligations.length > 0 && (
            <div className="px-4 py-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                всего
              </span>
              <span className="text-sm font-semibold tabular-nums">
                <MoneyTicker value={total} currency={currency} />
              </span>
            </div>
          )}

          {/* Tax row (always visible, lets user enable) */}
          <div className="px-4 py-2 flex items-center justify-between">
            <Popover open={taxOpen} onOpenChange={setTaxOpen}>
              <PopoverTrigger asChild>
                <button
                  className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors flex items-baseline gap-1"
                  aria-label="Настроить налог"
                >
                  <span>налог</span>
                  <span className="tabular-nums">
                    {taxRate > 0 ? `${taxRate}%` : "—"}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={8} className="w-[220px] p-3">
                <div className="space-y-2">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    ставка налога
                  </span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[0, 4, 6].map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          onSetTaxRate(r);
                          setTaxOpen(false);
                        }}
                        className={cn(
                          "h-8 rounded-md text-xs font-medium tabular-nums transition-colors border",
                          taxRate === r
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
                        )}
                      >
                        {r === 0 ? "нет" : `${r}%`}
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-muted-foreground/70 leading-snug pt-1">
                    самозанятый: 4% с физлиц, 6% с юрлиц
                  </p>
                </div>
              </PopoverContent>
            </Popover>
            <span
              className={cn(
                "text-sm font-semibold tabular-nums",
                taxRate > 0 ? "text-foreground" : "text-muted-foreground/40",
              )}
            >
              {taxRate > 0 ? (
                <>
                  −<MoneyTicker value={taxAmount} currency={currency} />
                </>
              ) : (
                "—"
              )}
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

          {taxRate > 0 && taxDueLabel && taxDueAmount > 0 && (
            <div className="px-4 py-2 flex items-center justify-between bg-foreground/[0.04]">
              <span className="text-[10px] uppercase tracking-[0.2em] text-foreground/80">
                к уплате до {taxDueLabel}
              </span>
              <span className="text-sm font-semibold tabular-nums">
                <MoneyTicker value={taxDueAmount} currency={currency} />
              </span>
            </div>
          )}
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

function SavingsGoalEditor({
  savingsGoal,
  currency,
  convert,
  onSet,
  onClear,
}: {
  savingsGoal: { name: string; targetRub: number; deadlineIso: string } | null;
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  onSet: (
    name: string,
    amount: number,
    deadlineIso: string,
    currency: Currency,
  ) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [deadline, setDeadline] = useState("");

  const displayAmount =
    savingsGoal != null ? convert(savingsGoal.targetRub, "RUB", currency) : 0;

  useEffect(() => {
    if (open) {
      setName(savingsGoal?.name || "");
      setAmount(
        savingsGoal != null ? String(Math.round(displayAmount)) : "",
      );
      setDeadline(
        savingsGoal?.deadlineIso || format(addMonths(new Date(), 3), "yyyy-MM-dd"),
      );
    }
  }, [open]);

  const handleSave = () => {
    const num = parseInt(amount || "0", 10);
    if (!name.trim() || !Number.isFinite(num) || num <= 0 || !deadline) return;
    onSet(name, num, deadline, currency);
    setOpen(false);
  };

  // Compute days remaining + per-day required
  let daysLeft = 0;
  let perDay = 0;
  if (savingsGoal) {
    const target = new Date(savingsGoal.deadlineIso);
    daysLeft = Math.max(1, differenceInCalendarDays(target, new Date()));
    perDay = displayAmount / daysLeft;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="w-full text-left flex items-center justify-between gap-2 px-3 py-2 rounded-md hover:bg-muted/40 transition-colors -mx-3"
          aria-label="Копилка"
        >
          <div className="flex flex-col items-start min-w-0">
            <span className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground/70">
              копилка
            </span>
            {savingsGoal ? (
              <span className="text-[11px] text-foreground truncate max-w-full">
                {savingsGoal.name}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                + добавить мечту
              </span>
            )}
          </div>
          {savingsGoal && (
            <div className="flex flex-col items-end shrink-0">
              <span className="text-xs font-semibold tabular-nums">
                {formatMoney(perDay, currency)}/дн
              </span>
              <span className="text-[9px] text-muted-foreground tabular-nums">
                {daysLeft} дн · {formatMoney(displayAmount, currency)}
              </span>
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[260px] p-3">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              копилка / мечта
            </span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {currency}
            </span>
          </div>
          <input
            autoFocus
            placeholder="что хочется накопить"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            className="w-full h-8 px-2.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
          <NumericInput
            placeholder="сумма, например 50000"
            value={amount}
            onChange={setAmount}
          />
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              к дате
            </span>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full h-8 px-2.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
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

function JobEditor({
  job,
  onSave,
  onReset,
}: {
  job: ResolvedJob;
  onSave: (cfg: { label?: string; short?: string; color?: string | null }) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(job.label);
  const [short, setShort] = useState(job.short);
  const [color, setColor] = useState<string | null>(job.color);

  useEffect(() => {
    if (open) {
      setLabel(job.label);
      setShort(job.short);
      setColor(job.color);
    }
  }, [open, job.label, job.short, job.color]);

  const handleSave = () => {
    onSave({ label, short, color });
    setOpen(false);
  };

  const previewJob: ResolvedJob = {
    ...job,
    label,
    short,
    color,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 min-w-0 outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-md hover:bg-muted/40 px-1 -mx-1"
          aria-label={`Настроить ${job.label}`}
        >
          <JobBadge job={job} size="md" />
          <span className="text-[11px] truncate">{job.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[280px] p-3">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              работа
            </span>
            <JobBadge job={previewJob} size="lg" />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              название
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={32}
              className="w-full h-8 px-2.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              значок (1–2 буквы)
            </span>
            <input
              value={short}
              onChange={(e) => setShort(e.target.value.slice(0, 2))}
              maxLength={2}
              className="w-full h-8 px-2.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary uppercase tracking-wider"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              цвет
            </span>
            <div className="flex flex-wrap gap-1.5 items-center">
              <button
                type="button"
                onClick={() => setColor(null)}
                title="по умолчанию"
                className={cn(
                  "h-6 w-6 rounded-md border-2 text-[9px] font-medium uppercase flex items-center justify-center transition-colors",
                  color === null
                    ? "border-primary"
                    : "border-border hover:border-foreground/50",
                )}
              >
                —
              </button>
              {JOB_COLOR_PALETTE.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setColor(c.value)}
                  title={c.label}
                  style={{ backgroundColor: c.value }}
                  className={cn(
                    "h-6 w-6 rounded-md border-2 transition-colors",
                    color === c.value
                      ? "border-primary"
                      : "border-transparent hover:border-foreground/50",
                  )}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
              className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
            >
              сбросить
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
  canUndo,
  onUndo,
}: {
  exportData: () => ExportData;
  importData: (data: unknown) => boolean;
  buildCsv: () => string;
  buildSummary: () => string;
  canUndo: boolean;
  onUndo: () => void;
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
        <PopoverContent align="end" sideOffset={8} className="w-[220px] p-1">
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => {
                if (canUndo) {
                  onUndo();
                  setOpen(false);
                }
              }}
              disabled={!canUndo}
              className={cn(
                "flex items-center justify-between gap-3 px-3 py-2 text-left rounded-md transition-colors",
                canUndo
                  ? "hover:bg-muted text-foreground"
                  : "text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              <span className="text-[11px]">отменить</span>
              <span className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                ⌘Z
              </span>
            </button>
            <div className="my-1 h-px bg-border" />
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

function YearHeatmap({
  year,
  entries,
  currency,
  convert,
  onPickDay,
}: {
  year: number;
  entries: Record<string, Partial<Record<JobId, number>>>;
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  onPickDay: (date: Date) => void;
}) {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const startMonday = startOfWeek(start, WEEK_OPTIONS);
  const endSunday = endOfWeek(end, WEEK_OPTIONS);
  const allDays = eachDayOfInterval({ start: startMonday, end: endSunday });
  const weeks: Date[][] = [];
  for (let i = 0; i < allDays.length; i += 7) weeks.push(allDays.slice(i, i + 7));

  // Compute max for color scaling
  let max = 0;
  for (const d of allDays) {
    if (d.getFullYear() !== year) continue;
    const v = convert(dayTotal(entries[format(d, "yyyy-MM-dd")]), "RUB", currency);
    if (v > max) max = v;
  }

  // Month labels: position by first column where the month starts
  const monthLabelCols: { name: string; col: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    for (const d of week) {
      if (d.getFullYear() !== year) continue;
      const m = d.getMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        monthLabelCols.push({ name: MONTHS_SHORT[m], col: wi });
        break;
      }
    }
  });

  // Squeeze duplicates that landed on same column
  const dedupLabels: { name: string; col: number }[] = [];
  for (const l of monthLabelCols) {
    if (!dedupLabels.find((x) => x.col === l.col)) dedupLabels.push(l);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {year} · 365 дней
        </span>
        <span className="text-[9px] text-muted-foreground/70 ml-auto">
          мало → много
        </span>
        <div className="flex gap-[2px] items-center">
          {[0.15, 0.3, 0.5, 0.75, 1].map((o) => (
            <div
              key={o}
              className="w-2 h-2 rounded-[1px]"
              style={{ backgroundColor: `hsl(var(--foreground) / ${o})` }}
            />
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-block">
          {/* month labels */}
          <div className="flex gap-[2px] mb-1 pl-[18px]">
            {weeks.map((_, wi) => {
              const label = dedupLabels.find((l) => l.col === wi);
              return (
                <div
                  key={wi}
                  className="w-2.5 h-3 text-[8px] uppercase tracking-tight text-muted-foreground/60"
                >
                  {label?.name}
                </div>
              );
            })}
          </div>
          <div className="flex gap-[2px]">
            {/* Weekday labels (Mon, Wed, Fri) */}
            <div className="flex flex-col gap-[2px] mr-1 text-[8px] uppercase text-muted-foreground/60 leading-none">
              {["пн", "", "ср", "", "пт", "", ""].map((w, i) => (
                <div key={i} className="h-2.5 flex items-center">
                  {w}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[2px]">
                {week.map((d) => {
                  const inYear = d.getFullYear() === year;
                  if (!inYear) {
                    return (
                      <div
                        key={d.toISOString()}
                        className="w-2.5 h-2.5"
                      />
                    );
                  }
                  const v = convert(
                    dayTotal(entries[format(d, "yyyy-MM-dd")]),
                    "RUB",
                    currency,
                  );
                  const intensity =
                    max > 0 && v > 0
                      ? Math.max(0.15, Math.min(1, 0.15 + (v / max) * 0.85))
                      : 0;
                  return (
                    <button
                      key={d.toISOString()}
                      type="button"
                      onClick={() => onPickDay(d)}
                      title={`${format(d, "d MMMM", { locale: ru })} · ${formatMoney(v, currency)}`}
                      style={{
                        backgroundColor:
                          v > 0
                            ? `hsl(var(--foreground) / ${intensity})`
                            : `hsl(var(--border) / 0.5)`,
                      }}
                      className="w-2.5 h-2.5 rounded-[2px] hover:ring-1 hover:ring-primary transition-shadow"
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function YearView({
  year,
  setYear,
  entries,
  currency,
  convert,
  jobs,
  onPickMonth,
  onClose,
}: {
  year: number;
  setYear: (updater: number | ((prev: number) => number)) => void;
  entries: Record<string, Partial<Record<JobId, number>>>;
  currency: Currency;
  convert: (amount: number, from: Currency, to: Currency) => number;
  jobs: ResolvedJob[];
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
        for (const job of jobs) {
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
  }, [year, entries, currency, convert, jobs]);

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
      <div className="mx-auto max-w-[1280px] p-3 sm:p-4 space-y-3">
        {/* Top bar */}
        <div className="rounded-2xl border border-border bg-card flex items-center justify-between px-4 py-2.5">
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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

        {/* Heatmap */}
        <Tile>
          <div className="px-4 py-3">
            <YearHeatmap
              year={year}
              entries={entries}
              currency={currency}
              convert={convert}
              onPickDay={(d) => onPickMonth(d)}
            />
          </div>
        </Tile>

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
                  {jobs.map((j) => (
                    <span key={j.id} className="flex items-center gap-1">
                      <JobBadge job={j} size="xs" />
                      {m.perJob[j.id] > 0
                        ? formatMoney(m.perJob[j.id], currency)
                        : "—"}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

function ToastFlash({ message }: { message: string | null }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-md bg-foreground text-background text-[11px] uppercase tracking-[0.2em] shadow-lg pointer-events-none"
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function Calendar() {
  const {
    entries,
    currency,
    setCurrency,
    setDayEntries,
    undoLastDayEntry,
    undoCount,
    convert,
    obligations,
    addObligation,
    updateObligation,
    removeObligation,
    categories,
    addCategory,
    scheduleAnchors,
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
    setJobConfig,
    resetJobConfig,
    recentAmounts,
    theme,
    toggleTheme,
    exportData,
    importData,
    computeStreak,
  } = useSalaryStore();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<JobId, string>>({
    ozon: "",
    dostaevsky: "",
  });
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [dayModalDate, setDayModalDate] = useState<Date | null>(null);

  const onDeliveryDelta = useCallback(
    ({ dateIso, jobId, delta }: { dateIso: string; jobId: JobId; delta: number }) => {
      const cur = entries[dateIso] || {};
      const next: Partial<Record<JobId, number>> = {};
      for (const j of jobs) {
        const v = cur[j.id];
        if (typeof v === "number" && v > 0) next[j.id] = v;
      }
      const curJob = next[jobId] || 0;
      const newJob = Math.max(0, Math.round((curJob + delta) * 100) / 100);
      if (newJob > 0) next[jobId] = newJob;
      else delete next[jobId];
      setDayEntries(dateIso, next, "RUB", { skipUndo: true, skipRecent: true });
    },
    [entries, jobs, setDayEntries],
  );

  const deliveriesStore = useDeliveriesStore(onDeliveryDelta);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  const [yearViewOpen, setYearViewOpen] = useState(false);
  const [yearViewYear, setYearViewYear] = useState(
    () => new Date().getFullYear(),
  );
  const [bottomTab, setBottomTab] = useState<"weeks" | "forecast">("weeks");
  const [toast, setToast] = useState<string | null>(null);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1300);
  }, []);

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
    return jobs.filter((j) => (entry[j.id] ?? 0) > 0).map((j) => j.id);
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

  const perJobMonthTotal = useMemo(() => {
    const totals: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
    for (const d of monthDays) {
      const entry = getDayEntry(d);
      if (!entry) continue;
      for (const job of jobs) {
        const v = entry[job.id];
        if (typeof v === "number") {
          totals[job.id] += convert(v, "RUB", currency);
        }
      }
    }
    return totals;
  }, [monthDays, entries, currency, convert, jobs]);

  const perJobDailyAverage = useMemo(() => {
    const sums: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
    const counts: Record<JobId, number> = { ozon: 0, dostaevsky: 0 };
    for (const d of monthDays) {
      const entry = getDayEntry(d);
      if (!entry) continue;
      for (const job of jobs) {
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
  }, [monthDays, entries, currency, convert, jobs]);

  const forecast = useMemo(() => {
    const todayKey = format(today, "yyyy-MM-dd");
    const remainingDays = monthDays.filter((d) => {
      const k = format(d, "yyyy-MM-dd");
      return k > todayKey && getDayRub(d) === 0;
    });
    if (remainingDays.length === 0) return monthTotal;
    if (averagePerDay <= 0) return monthTotal;

    const anyAnchored = jobs.some((j) => scheduleAnchors[j.id]);
    if (!anyAnchored) {
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
    jobs,
  ]);

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

  const goalDisplay = goalRub != null ? convert(goalRub, "RUB", currency) : 0;
  const goalPct =
    goalRub != null && goalDisplay > 0
      ? Math.min(200, (monthTotal / goalDisplay) * 100)
      : 0;

  const obligationsTotal = useMemo(
    () =>
      obligations.reduce(
        (s, o) => s + convert(o.amountRub, "RUB", currency),
        0,
      ),
    [obligations, currency, convert],
  );

  // Tax: based on current month income
  const taxAmount = useMemo(
    () => (monthTotal * taxRate) / 100,
    [monthTotal, taxRate],
  );

  // Tax due: previous month's accrued tax (samozanyatyi pays by 28th of next month)
  const { taxDueLabel, taxDueAmount } = useMemo(() => {
    if (taxRate <= 0) {
      return { taxDueLabel: null as string | null, taxDueAmount: 0 };
    }
    // The tax that's due THIS calendar month is for the PREVIOUS calendar
    // month's income, payable by the 28th. If we're already past the 28th,
    // surface NEXT month's due (which is for THIS month's income so far).
    const now = new Date();
    let payerMonth: Date;
    let dueDate: Date;
    if (now.getDate() <= 28) {
      payerMonth = subMonths(now, 1);
      dueDate = setMonth(setYear(new Date(now.getFullYear(), now.getMonth(), 28), now.getFullYear()), now.getMonth());
    } else {
      payerMonth = now;
      const next = addMonths(now, 1);
      dueDate = new Date(next.getFullYear(), next.getMonth(), 28);
    }
    const days = eachDayOfInterval({
      start: startOfMonth(payerMonth),
      end: endOfMonth(payerMonth),
    });
    let incomeRub = 0;
    for (const d of days) {
      const entry = getDayEntry(d);
      if (entry) incomeRub += dayTotal(entry);
    }
    const taxRub = (incomeRub * taxRate) / 100;
    const taxInDisplay = convert(taxRub, "RUB", currency);
    const label = format(dueDate, "d MMM", { locale: ru });
    return { taxDueLabel: label, taxDueAmount: taxInDisplay };
  }, [taxRate, entries, currency, convert]);

  const freeAmount = monthTotal - obligationsTotal - taxAmount;

  const { workCount, offCount } = useMemo(() => {
    let work = 0;
    let off = 0;
    const anyAnchored = jobs.some((j) => scheduleAnchors[j.id]);
    if (!anyAnchored) {
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
  }, [monthDays, scheduleAnchors, getScheduledJobsFor, entries, jobs]);

  // Streak: count of consecutive days ending today (or yesterday if today is empty)
  const streak = useMemo(() => computeStreak(), [entries, computeStreak]);

  // Cashflow forecast: next 3 months (predicted income - obligations - tax)
  const cashflow = useMemo(() => {
    // Use rolling 90-day average per worked day, then project per-month based
    // on number of scheduled days (or working days fallback).
    const now = new Date();
    const lookback = 90;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < lookback; i++) {
      const d = subDays(now, i);
      const entry = getDayEntry(d);
      const v = dayTotal(entry);
      if (v > 0) {
        sum += convert(v, "RUB", currency);
        count += 1;
      }
    }
    const avgWorkedDay = count > 0 ? sum / count : averagePerDay;
    const anyAnchored = jobs.some((j) => scheduleAnchors[j.id]);

    const result: {
      monthDate: Date;
      predicted: number;
      obligations: number;
      tax: number;
      net: number;
    }[] = [];
    for (let i = 1; i <= 3; i++) {
      const md = addMonths(currentDate, i);
      const days = eachDayOfInterval({
        start: startOfMonth(md),
        end: endOfMonth(md),
      });
      let scheduledDays = 0;
      for (const d of days) {
        if (anyAnchored) {
          if (getScheduledJobsFor(d).length > 0) scheduledDays += 1;
        } else {
          // Fallback: treat workdays as Mon-Fri average
          if (!isWeekend(d)) scheduledDays += 1;
        }
      }
      const predicted = avgWorkedDay * scheduledDays;
      const tax = (predicted * taxRate) / 100;
      const net = predicted - obligationsTotal - tax;
      result.push({
        monthDate: md,
        predicted,
        obligations: obligationsTotal,
        tax,
        net,
      });
    }
    return result;
  }, [
    entries,
    currency,
    convert,
    averagePerDay,
    scheduleAnchors,
    getScheduledJobsFor,
    obligationsTotal,
    taxRate,
    currentDate,
    jobs,
  ]);

  const handleSave = (date: Date) => {
    const amounts: Partial<Record<JobId, number>> = {};
    for (const job of jobs) {
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
    for (const job of jobs) {
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

  const buildCsv = useCallback(() => {
    const lines: string[] = [];
    const headers = ["дата", ...jobs.map((j) => j.label.toLowerCase()), "итого", "валюта"];
    lines.push(headers.join(","));
    for (const d of monthDays) {
      const key = format(d, "yyyy-MM-dd");
      const entry = entries[key];
      const cells: string[] = [key];
      let total = 0;
      for (const j of jobs) {
        const v = entry?.[j.id]
          ? Math.round(convert(entry[j.id]!, "RUB", currency))
          : 0;
        cells.push(String(v));
        total += v;
      }
      cells.push(String(total));
      cells.push(currency);
      lines.push(cells.join(","));
    }
    lines.push("");
    lines.push(
      `# итого ${monthName} ${yearStr}: ${Math.round(monthTotal)} ${currency}`,
    );
    return lines.join("\n");
  }, [monthDays, entries, currency, convert, monthName, yearStr, monthTotal, jobs]);

  const buildSummary = useCallback(() => {
    const parts: string[] = [];
    parts.push(
      `${monthName} ${yearStr}: ${formatMoney(monthTotal, currency)}`,
    );
    const jobBits = jobs
      .filter((j) => perJobMonthTotal[j.id] > 0)
      .map(
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
    if (taxRate > 0) {
      parts.push(
        `налог ${taxRate}%: ${formatMoney(taxAmount, currency)}`,
      );
    }
    if (goalRub != null && goalDisplay > 0) {
      parts.push(`цель ${formatMoney(goalDisplay, currency)} (${Math.round(goalPct)}%)`);
    }
    if (streak > 0) parts.push(`серия ${streak} дн`);
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
    taxRate,
    taxAmount,
    goalRub,
    goalDisplay,
    goalPct,
    streak,
    jobs,
  ]);

  const handleUndo = useCallback(() => {
    const ok = undoLastDayEntry();
    if (ok) flashToast("отменено");
    else flashToast("нечего отменять");
  }, [undoLastDayEntry, flashToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isInput =
        tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;

      // Ctrl/Cmd+Z is allowed even with popups open or focus elsewhere
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z" || e.key === "я" || e.key === "Я")) {
        if (e.shiftKey) return;
        e.preventDefault();
        handleUndo();
        return;
      }

      if (openKey || monthPickerOpen) return;
      if (isInput) return;
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
  }, [openKey, monthPickerOpen, yearViewOpen, openYearView, handleUndo]);

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

            {streak > 0 && (
              <span
                className="hidden sm:inline-flex items-baseline gap-1 text-[10px] uppercase tracking-[0.2em] text-foreground/80 tabular-nums"
                title={`Подряд отработано ${streak} дн`}
              >
                <span>★</span>
                <span>{streak}</span>
                <span className="text-muted-foreground">подряд</span>
              </span>
            )}

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
            <Link
              href="/map"
              className="h-7 px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground border border-border rounded-md hover:bg-muted transition-colors flex items-center"
              title="Карта доставок"
            >
              карта →
            </Link>
            <div className="w-px h-5 bg-border mx-1.5" />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <DataMenu
              exportData={exportData}
              importData={importData}
              buildCsv={buildCsv}
              buildSummary={buildSummary}
              canUndo={undoCount > 0}
              onUndo={handleUndo}
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
                      const visibleJobs = jobs.filter(
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
                                for (const job of jobs) {
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
                                if (!isCurrentMonth) return;
                                const targets = jobsScheduled.length
                                  ? jobsScheduled
                                  : jobs.filter((j) => scheduleAnchors[j.id]).map(
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

                                {visibleJobs.length > 0 && isCurrentMonth && (
                                  <div className="flex items-center gap-0.5">
                                    {visibleJobs.map((job) => {
                                      const isWorked = jobsWorked.includes(job.id);
                                      return (
                                        <JobBadge
                                          key={job.id}
                                          job={job}
                                          size="sm"
                                          active={isWorked}
                                        />
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
                            className="w-[300px] p-3"
                            align="center"
                            sideOffset={4}
                          >
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                  {format(day, "d MMMM yyyy", { locale: ru })}
                                </span>
                                <div className="flex items-center gap-2">
                                  {deliveriesByDay(deliveriesStore.deliveries, key).length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenKey(null);
                                        setDayModalDate(day);
                                      }}
                                      className="text-[10px] uppercase tracking-[0.2em] text-foreground hover:text-foreground/80 transition-colors flex items-center gap-1"
                                      title="Карта дня и список доставок"
                                    >
                                      ◇ карта · {deliveriesByDay(deliveriesStore.deliveries, key).length}
                                    </button>
                                  )}
                                  <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                    {currency}
                                  </span>
                                </div>
                              </div>

                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleSave(day);
                                }}
                                className="space-y-3"
                              >
                                {jobs.map((job, idx) => {
                                  const isOnSchedule = jobsScheduled.includes(
                                    job.id,
                                  );
                                  const placeholder =
                                    perJobDailyAverage[job.id] > 0
                                      ? String(
                                          Math.round(perJobDailyAverage[job.id]),
                                        )
                                      : "0";
                                  // Recent amounts are stored in RUB; convert to display
                                  const chips = (recentAmounts[job.id] || [])
                                    .map((rub) =>
                                      Math.round(convert(rub, "RUB", currency)),
                                    )
                                    .filter((v, i, arr) => arr.indexOf(v) === i)
                                    .slice(0, 5);
                                  return (
                                    <div key={job.id} className="space-y-1">
                                      <div className="flex items-center gap-2">
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
                                          className="shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-sm"
                                        >
                                          <JobBadge
                                            job={job}
                                            size="lg"
                                            active={isOnSchedule}
                                          />
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
                                      {chips.length > 0 && (
                                        <div className="pl-[124px]">
                                          <ChipSuggestions
                                            values={chips}
                                            onPick={(v) =>
                                              setEditValues((prev) => ({
                                                ...prev,
                                                [job.id]: String(v),
                                              }))
                                            }
                                          />
                                        </div>
                                      )}
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

        {/* Right column: total + per-job + tabbed bottom */}
        <div
          className="grid gap-3 min-h-0"
          style={{ gridTemplateRows: "auto auto minmax(0, 1fr)" }}
        >
          {/* Total tile */}
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

              {/* Savings goal */}
              <div className="mt-3 pt-3 border-t border-border">
                <SavingsGoalEditor
                  savingsGoal={savingsGoal}
                  currency={currency}
                  convert={convert}
                  onSet={setSavingsGoal}
                  onClear={clearSavingsGoal}
                />
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
                jobs={jobs}
                onApply={applyScheduleAnchor}
                onClear={clearScheduleForJob}
              />
            </div>
            <ul className="divide-y divide-border">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex items-center justify-between px-4 py-2 gap-2"
                >
                  <JobEditor
                    job={job}
                    onSave={(cfg) => setJobConfig(job.id, cfg)}
                    onReset={() => resetJobConfig(job.id)}
                  />
                  <span className="text-xs font-semibold tabular-nums shrink-0">
                    <MoneyTicker
                      value={perJobMonthTotal[job.id]}
                      currency={currency}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </Tile>

          {/* Tabbed bottom: weeks / forecast */}
          <Tile>
            <div className="px-4 py-2 border-b border-border shrink-0 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setBottomTab("weeks")}
                  className={cn(
                    "text-[10px] font-medium uppercase tracking-[0.25em] transition-colors",
                    bottomTab === "weeks"
                      ? "text-foreground"
                      : "text-muted-foreground/60 hover:text-muted-foreground",
                  )}
                >
                  недели
                </button>
                <button
                  onClick={() => setBottomTab("forecast")}
                  className={cn(
                    "text-[10px] font-medium uppercase tracking-[0.25em] transition-colors",
                    bottomTab === "forecast"
                      ? "text-foreground"
                      : "text-muted-foreground/60 hover:text-muted-foreground",
                  )}
                >
                  прогноз
                </button>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {bottomTab === "weeks"
                  ? `[${weeks.filter((w) => w.some((d) => isSameMonth(d, currentDate))).length.toString().padStart(2, "0")}]`
                  : "+3 мес"}
              </span>
            </div>
            <div className="flex-1 overflow-auto">
              {bottomTab === "weeks" ? (
                <ul className="divide-y divide-border">
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
              ) : (
                <ul className="divide-y divide-border">
                  {cashflow.map((c) => {
                    const mLabel = format(c.monthDate, "LLL", {
                      locale: ru,
                    }).toLowerCase();
                    return (
                      <li key={c.monthDate.toISOString()} className="px-4 py-2">
                        <div className="flex items-baseline justify-between mb-0.5">
                          <span className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                            {mLabel}
                          </span>
                          <span className="text-xs font-semibold tabular-nums">
                            {formatMoney(c.predicted, currency)}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between text-[10px] tabular-nums text-muted-foreground/80">
                          <span>
                            −{formatMoney(c.obligations, currency)}
                            {c.tax > 0 && ` · −${formatMoney(c.tax, currency)}`}
                          </span>
                          <span
                            className={cn(
                              "font-medium",
                              c.net >= 0
                                ? "text-foreground/80"
                                : "text-destructive/80",
                            )}
                          >
                            {c.net >= 0 ? "= " : "= −"}
                            {formatMoney(Math.abs(c.net), currency)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                  <li className="px-4 py-2 text-[9px] text-muted-foreground/60 leading-snug">
                    прогноз: средняя смена × дней в графике
                  </li>
                </ul>
              )}
            </div>
          </Tile>
        </div>

        {/* Obligations column */}
        <ObligationsPanel
          obligations={obligations}
          categories={categories}
          currency={currency}
          convert={convert}
          freeAmount={freeAmount}
          taxRate={taxRate}
          taxAmount={taxAmount}
          taxDueLabel={taxDueLabel}
          taxDueAmount={taxDueAmount}
          onAdd={addObligation}
          onUpdate={updateObligation}
          onRemove={removeObligation}
          onAddCategory={addCategory}
          onSetTaxRate={setTaxRate}
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
            jobs={jobs}
            onPickMonth={(date) => {
              setCurrentDate(startOfMonth(date));
              setYearViewOpen(false);
            }}
            onClose={() => setYearViewOpen(false)}
          />
        )}
      </AnimatePresence>

      <ToastFlash message={toast} />

      <DayDetailModal
        open={dayModalDate !== null}
        date={dayModalDate}
        deliveries={
          dayModalDate
            ? deliveriesByDay(
                deliveriesStore.deliveries,
                format(dayModalDate, "yyyy-MM-dd"),
              )
            : []
        }
        jobs={jobs}
        theme={theme}
        onClose={() => setDayModalDate(null)}
        onRemoveDelivery={(id) => deliveriesStore.removeDelivery(id)}
      />
    </div>
  );
}

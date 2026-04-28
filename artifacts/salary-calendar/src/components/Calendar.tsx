import React, { useState, useMemo, useRef, useEffect } from "react";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, startOfWeek, endOfWeek, parseISO } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Calculator, Calendar as CalendarIcon, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useSalaryStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const CURRENCIES = [
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
  { code: "JPY", symbol: "¥" },
  { code: "CAD", symbol: "$" },
  { code: "AUD", symbol: "$" },
];

function AnimatedNumber({ value, currency }: { value: number; currency: string }) {
  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(val);
  };

  return (
    <motion.span
      key={value}
      initial={{ opacity: 0.5, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="inline-block"
    >
      {formatCurrency(value)}
    </motion.span>
  );
}

export default function Calendar() {
  const { entries, currency, setCurrency, setEntry } = useSalaryStore();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [editValue, setEditValue] = useState("");

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const days = eachDayOfInterval({ start: startDate, end: endDate });
  const weeks = useMemo(() => {
    const w = [];
    for (let i = 0; i < days.length; i += 7) {
      w.push(days.slice(i, i + 7));
    }
    return w;
  }, [days]);

  const handleNextMonth = () => setCurrentDate(addMonths(currentDate, 1));
  const handlePrevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const handleToday = () => setCurrentDate(new Date());

  const getDayTotal = (date: Date) => {
    return entries[format(date, "yyyy-MM-dd")] || 0;
  };

  const getWeekTotal = (weekDays: Date[]) => {
    return weekDays.reduce((sum, day) => sum + getDayTotal(day), 0);
  };

  const monthTotal = useMemo(() => {
    return eachDayOfInterval({ start: monthStart, end: monthEnd }).reduce(
      (sum, day) => sum + getDayTotal(day),
      0
    );
  }, [monthStart, monthEnd, entries]);

  const daysWithEntries = useMemo(() => {
    return eachDayOfInterval({ start: monthStart, end: monthEnd }).filter(
      (day) => getDayTotal(day) > 0
    ).length;
  }, [monthStart, monthEnd, entries]);

  const averagePerDay = daysWithEntries > 0 ? monthTotal / daysWithEntries : 0;

  const handleSave = (date: Date, val: string) => {
    const num = parseFloat(val);
    setEntry(format(date, "yyyy-MM-dd"), isNaN(num) ? 0 : num);
    setSelectedDate(null);
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col items-center py-8 px-4 sm:px-8">
      <div className="max-w-4xl w-full space-y-8">
        
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-4xl font-serif text-primary tracking-tight">Ledger</h1>
            <p className="text-muted-foreground font-medium flex items-center gap-2">
              <CalendarIcon className="w-4 h-4" />
              {format(currentDate, "MMMM yyyy")}
            </p>
          </div>
          
          <div className="flex items-center gap-2">
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="w-[100px] h-9 bg-card border-card-border shadow-sm">
                <SelectValue placeholder="Currency" />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map(c => (
                  <SelectItem key={c.code} value={c.code}>{c.code} ({c.symbol})</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center bg-card rounded-md border border-card-border p-1 shadow-sm">
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handlePrevMonth}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button variant="ghost" className="h-7 px-3 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={handleToday}>
                Today
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleNextMonth}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </header>

        {/* Main Grid Area */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_250px] gap-8 items-start">
          
          {/* Calendar */}
          <div className="bg-card border border-card-border rounded-xl shadow-sm overflow-hidden">
            {/* Day Labels */}
            <div className="grid grid-cols-7 border-b border-card-border bg-muted/30">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="py-3 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {d}
                </div>
              ))}
            </div>
            
            {/* Weeks */}
            <div className="flex flex-col divide-y divide-card-border">
              {weeks.map((week, i) => (
                <div key={i} className="grid grid-cols-7 lg:grid-cols-[repeat(7,1fr)_auto] divide-x divide-card-border group">
                  {week.map((day, j) => {
                    const isCurrentMonth = isSameMonth(day, currentDate);
                    const isToday = isSameDay(day, new Date());
                    const amt = getDayTotal(day);
                    const isSelected = selectedDate && isSameDay(day, selectedDate);
                    
                    return (
                      <Popover key={j} open={isSelected} onOpenChange={(open) => {
                        if (open) {
                          setSelectedDate(day);
                          setEditValue(amt ? amt.toString() : "");
                        } else {
                          setSelectedDate(null);
                        }
                      }}>
                        <PopoverTrigger asChild>
                          <button
                            className={cn(
                              "min-h-[100px] p-2 sm:p-3 relative flex flex-col justify-between items-start transition-colors outline-none",
                              !isCurrentMonth && "opacity-40 bg-muted/10",
                              isCurrentMonth && "hover:bg-accent/20 focus-visible:bg-accent/30",
                              isToday && "bg-primary/5",
                            )}
                          >
                            <span className={cn(
                              "text-sm font-medium w-7 h-7 flex items-center justify-center rounded-full",
                              isToday ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground"
                            )}>
                              {format(day, "d")}
                            </span>
                            
                            {amt > 0 && (
                              <div className="w-full text-right mt-2">
                                <span className="inline-block px-2 py-1 bg-accent/50 text-accent-foreground text-xs font-semibold rounded-md shadow-sm">
                                  {new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amt)}
                                </span>
                              </div>
                            )}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-3 shadow-lg border-card-border" align="center">
                          <div className="space-y-3">
                            <div className="text-xs font-medium text-muted-foreground">
                              {format(day, "MMMM d, yyyy")}
                            </div>
                            <form onSubmit={(e) => {
                              e.preventDefault();
                              handleSave(day, editValue);
                            }} className="flex gap-2">
                              <Input
                                autoFocus
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                value={editValue}
                                onChange={e => setEditValue(e.target.value)}
                                className="h-8 text-sm"
                              />
                              <Button type="submit" size="sm" className="h-8 px-3">Save</Button>
                            </form>
                          </div>
                        </PopoverContent>
                      </Popover>
                    );
                  })}
                  
                  {/* Weekly Total - visible on large screens as an extra column, hidden on mobile */}
                  <div className="hidden lg:flex flex-col items-center justify-center px-4 bg-muted/20 border-l-2 border-l-transparent group-hover:border-l-accent/30 transition-colors min-w-[100px]">
                    <span className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wider">Week</span>
                    <span className="font-serif text-foreground font-semibold">
                      <AnimatedNumber value={getWeekTotal(week)} currency={currency} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Sidebar Summaries */}
          <div className="space-y-6">
            
            {/* Monthly Total Hero */}
            <div className="bg-primary text-primary-foreground p-6 rounded-xl shadow-md relative overflow-hidden">
              <div className="absolute -right-4 -top-4 opacity-10">
                <Calculator className="w-32 h-32" />
              </div>
              <h2 className="text-primary-foreground/80 font-medium text-sm mb-2 uppercase tracking-wide">Monthly Total</h2>
              <div className="text-4xl sm:text-5xl font-serif tracking-tight drop-shadow-sm">
                <AnimatedNumber value={monthTotal} currency={currency} />
              </div>
            </div>

            {/* Quick Stats */}
            <div className="bg-card border border-card-border p-5 rounded-xl shadow-sm space-y-4">
              <h3 className="font-serif text-lg text-foreground">Month at a glance</h3>
              
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Days logged</span>
                  <span className="font-semibold text-foreground">{daysWithEntries}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Daily average</span>
                  <span className="font-semibold text-foreground">
                    {new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(averagePerDay)}
                  </span>
                </div>
                
                {daysWithEntries === 0 && (
                  <div className="mt-4 pt-4 border-t border-card-border text-sm text-muted-foreground italic text-center">
                    A clean ledger.<br/>Click any day to log an entry.
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}

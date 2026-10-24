import { Month } from '@10db/contracts';
import type { UsageWindow } from '@10db/db';

export interface MonthWindow {
  readonly month: string;
  readonly start: Date;
  readonly end: Date;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The calendar month containing `at`, in the machine's local time (accounts spec §6). */
export function monthOf(at: Date): MonthWindow {
  const start = new Date(at.getFullYear(), at.getMonth(), 1);
  const end = new Date(at.getFullYear(), at.getMonth() + 1, 1);
  return { month: `${String(start.getFullYear())}-${pad(start.getMonth() + 1)}`, start, end };
}

/** A `YYYY-MM` month, in local time. */
export function monthWindow(month: string): MonthWindow {
  const valid = Month.parse(month);
  return monthOf(new Date(Number(valid.slice(0, 4)), Number(valid.slice(5, 7)) - 1, 1));
}

export function usageWindow(window: MonthWindow): UsageWindow {
  return { month: window.month, start: window.start.toISOString(), end: window.end.toISOString() };
}

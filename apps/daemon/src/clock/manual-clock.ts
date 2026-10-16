import type { Clock, Timer } from './index';

interface Pending {
  readonly at: number;
  readonly order: number;
  readonly fn: () => void;
}

/** Test clock: time moves only when `advance` is called, and due timers fire in order. */
export class ManualClock implements Clock {
  private current: number;
  private timers: Pending[] = [];
  private order = 0;

  constructor(start: Date = new Date('2026-10-13T12:00:00.000Z')) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): Timer {
    const timer: Pending = { at: this.current + ms, order: this.order++, fn };
    this.timers.push(timer);
    return {
      cancel: () => {
        this.timers = this.timers.filter((t) => t !== timer);
      },
    };
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = due.at;
      due.fn();
    }
    this.current = target;
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}

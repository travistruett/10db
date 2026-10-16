export interface Timer {
  cancel(): void;
}

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): Timer;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

export { ManualClock } from './manual-clock';

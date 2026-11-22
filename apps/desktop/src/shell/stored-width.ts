import { useSyncExternalStore } from 'react';
import { z } from 'zod';

// A width the builder dragged, kept across restarts under its own key. A cleared or blocked store means
// the default; the width then lasts only until the window closes.

export interface StoredWidthOptions {
  readonly key: string;
  readonly min: number;
  readonly max: number;
  /** The width until the builder drags it; storing it again removes the key. */
  readonly initial: number;
}

export interface StoredWidth {
  /** The width in pixels, and how to set it (clamped to the range). */
  readonly use: () => { readonly width: number; readonly setWidth: (px: number) => void };
}

export function storedWidth({ key, min, max, initial }: StoredWidthOptions): StoredWidth {
  /** A stored width is read from disk: anything that is not a whole number of pixels in range is ignored. */
  const Stored = z.coerce.number().int().min(min).max(max);
  const listeners = new Set<() => void>();
  let inMemory = initial;

  const read = (): number => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === null) return inMemory;
      const parsed = Stored.safeParse(stored);
      return parsed.success ? parsed.data : initial;
    } catch {
      return inMemory;
    }
  };

  const write = (width: number): void => {
    const clamped = Math.round(Math.min(max, Math.max(min, width)));
    if (clamped === read()) return;
    inMemory = clamped;
    try {
      if (clamped === initial) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(clamped));
    } catch {
      // The in-memory width stands.
    }
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    window.addEventListener('storage', listener);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', listener);
    };
  };

  return {
    use: () => ({ width: useSyncExternalStore(subscribe, read), setWidth: write }),
  };
}

/** A width in pixels as the splitter takes it: a fixed size. */
export function px(width: number): `${number}px` {
  // The splitter's type names a number before the unit, which String() would widen to any string.
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  return `${width}px`;
}

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';

// What the builder did to a row (opened it, pressed Allow This) outlives the row: a windowed list
// unmounts rows that scroll away, and a row drawn again must not offer a second go-ahead. The list
// holds one store, keyed by row id; a row drawn outside a list keeps its own state.

/** How far a row is open: closed, showing a failed command's last lines, or whole. */
export type RowOpen = 'closed' | 'peek' | 'open';

class RowStateStore {
  private readonly open = new Map<string, RowOpen>();
  private readonly allowed = new Set<string>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  openOf(id: string): RowOpen | undefined {
    return this.open.get(id);
  }

  isAllowed(id: string): boolean {
    return this.allowed.has(id);
  }

  setOpen(id: string, value: RowOpen): void {
    this.open.set(id, value);
    this.notify();
  }

  allow(id: string): void {
    this.allowed.add(id);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const RowStateContext = createContext<RowStateStore | null>(null);

const noSubscription = (): (() => void) => () => undefined;

/** Holds the row state of every row drawn inside it. */
export function RowStateProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => new RowStateStore());
  return <RowStateContext value={store}>{children}</RowStateContext>;
}

/** How far row `id` is open, starting at `initial`. */
export function useRowOpen(id: string, initial: RowOpen): [RowOpen, (next: RowOpen) => void] {
  const store = useContext(RowStateContext);
  const [local, setLocal] = useState(initial);
  const kept = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.openOf(id));
  if (store === null) return [local, setLocal];
  return [
    kept ?? initial,
    (next) => {
      store.setOpen(id, next);
    },
  ];
}

/** Whether the builder has pressed Allow This on row `id`, and the press. */
export function useAllowed(id: string): [boolean, () => void] {
  const store = useContext(RowStateContext);
  const [local, setLocal] = useState(false);
  const kept = useSyncExternalStore(store?.subscribe ?? noSubscription, () =>
    store === null ? false : store.isAllowed(id),
  );
  if (store === null)
    return [
      local,
      () => {
        setLocal(true);
      },
    ];
  return [
    kept,
    () => {
      store.allow(id);
    },
  ];
}

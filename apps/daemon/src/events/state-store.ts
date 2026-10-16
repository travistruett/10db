import type { Store, TendbDatabase, WriteContext } from '@10db/db';
import type { EventBus } from './bus';

/** The daemon's single write path: commit rows and events, then push the events. */
export interface StateStore {
  readonly db: TendbDatabase;
  now(): string;
  write<T>(fn: (ctx: WriteContext) => T): T;
}

export function createStateStore(store: Store, bus: EventBus): StateStore {
  return {
    db: store.db,
    now: () => store.now(),
    write(fn) {
      const { value, events } = store.write(fn);
      bus.publish(events);
      return value;
    },
  };
}

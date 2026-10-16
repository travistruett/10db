import type { DaemonEvent, EventType } from '@10db/contracts';
import type { TendbDatabase } from '../database';
import type { Json } from '../json';
import * as schema from '../schema';

export type DbTx = Parameters<Parameters<TendbDatabase['transaction']>[0]>[0];
export type DbReader = TendbDatabase | DbTx;

export interface EmitInput {
  readonly type: EventType;
  readonly entityType: string;
  readonly entityId: string;
  readonly data?: Record<string, Json>;
}

export interface WriteContext {
  readonly tx: DbTx;
  /** One timestamp for every row and event in this transaction. */
  readonly now: string;
  emit(event: EmitInput): void;
}

export interface Store {
  readonly db: TendbDatabase;
  now(): string;
  /** Runs `fn` in an IMMEDIATE transaction and appends its events in the same transaction. */
  write<T>(fn: (ctx: WriteContext) => T): { value: T; events: DaemonEvent[] };
}

export function toDaemonEvent(row: typeof schema.events.$inferSelect): DaemonEvent {
  return {
    seq: row.seq,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    data: row.data,
    at: row.at,
  };
}

export function createStore(db: TendbDatabase, clock: () => Date = () => new Date()): Store {
  return {
    db,
    now: () => clock().toISOString(),
    write(fn) {
      return db.transaction(
        (tx) => {
          const now = clock().toISOString();
          const pending: EmitInput[] = [];
          const value = fn({
            tx,
            now,
            emit: (event) => {
              pending.push(event);
            },
          });
          const events = pending.map((e) =>
            toDaemonEvent(
              tx
                .insert(schema.events)
                .values({
                  type: e.type,
                  entityType: e.entityType,
                  entityId: e.entityId,
                  data: e.data ?? {},
                  at: now,
                })
                .returning()
                .get(),
            ),
          );
          return { value, events };
        },
        { behavior: 'immediate' },
      );
    },
  };
}

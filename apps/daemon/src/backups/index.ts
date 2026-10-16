import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TendbDatabase } from '@10db/db';
import { z } from 'zod';
import type { Clock, Timer } from '../clock';

const Journal = z.object({ entries: z.array(z.unknown()) });
const CountRow = z.object({ n: z.number() });

function count(db: TendbDatabase, sql: string): number {
  return CountRow.parse(db.$client.prepare(sql).get()).n;
}

/** True when the migrations folder has entries the database has not applied yet. */
export function hasPendingMigrations(db: TendbDatabase, migrationsDir: string): boolean {
  const journal = Journal.parse(
    JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')),
  );
  const tables = count(
    db,
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
  );
  if (tables === 0) return journal.entries.length > 0;
  return journal.entries.length > count(db, 'SELECT count(*) AS n FROM __drizzle_migrations');
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

/** A consistent online copy via SQLite's backup API (safe while the daemon writes). */
export async function backupDatabase(
  db: TendbDatabase,
  dir: string,
  label: string,
  now: Date,
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `10db-${label}-${stamp(now)}.sqlite`);
  await db.$client.backup(file);
  return file;
}

/** Deletes all but the newest `keep` backups of a label; returns the deleted paths, oldest first. */
export function pruneBackups(dir: string, label: string, keep: number): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`10db-${label}-`) && f.endsWith('.sqlite'))
    .sort()
    .reverse();
  const doomed = files.slice(keep).map((f) => join(dir, f));
  for (const file of doomed) rmSync(file, { force: true });
  return doomed.reverse();
}

/** Milliseconds from `now` to the next local `hour`:00. */
export function msUntilNextHour(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function scheduleNightlyBackup(
  clock: Clock,
  run: () => Promise<void>,
  hour = 3,
  onError: (error: unknown) => void = () => undefined,
): { cancel(): void } {
  let timer: Timer | null = null;
  const arm = (): void => {
    timer = clock.setTimeout(
      () => {
        // A failed backup (a full disk, say) is reported, never left as an unhandled rejection that exits the daemon.
        void run().catch(onError).finally(arm);
      },
      msUntilNextHour(clock.now(), hour),
    );
  };
  arm();
  return {
    cancel: () => {
      timer?.cancel();
    },
  };
}

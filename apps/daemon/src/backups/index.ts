import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
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
  // One fixed name per label: the instance lock makes the daemon its only writer. SQLite's backup opens an
  // existing destination as a database, so a half-written leftover from a killed copy is removed first.
  const partial = join(dir, `10db-${label}.partial`);
  for (const leftover of [partial, `${partial}-journal`, `${partial}-wal`]) {
    rmSync(leftover, { force: true });
  }
  await db.$client.backup(partial);
  renameSync(partial, file);
  return file;
}

const PRE_MIGRATE = 'pre-migrate';

/**
 * The copy taken before migrations: prunes the label to `keep` (so a full disk can clear), copies, then prunes
 * to `keep` again, never deleting the copy just made. Returns the copy, the paths removed and the paths that
 * could not be.
 */
export async function backupBeforeMigrating(
  db: TendbDatabase,
  dir: string,
  now: Date,
  keep: number,
): Promise<{
  readonly file: string;
  readonly removed: readonly string[];
  readonly failed: readonly string[];
}> {
  mkdirSync(dir, { recursive: true });
  const removed: string[] = [];
  const failed = new Set<string>();
  // A copy that can't be deleted is no reason to stay down: the start goes on, the copy still throws if it fails.
  const prune = (spare?: string): void => {
    try {
      const pruned = pruneBackups(dir, PRE_MIGRATE, keep, spare);
      removed.push(...pruned.removed);
      for (const path of pruned.failed) failed.add(path);
    } catch {
      // The folder itself can't be read: left for the next start's prune.
    }
  };
  prune();
  const file = await backupDatabase(db, dir, PRE_MIGRATE, now);
  prune(file);
  return { file, removed, failed: [...failed] };
}

/**
 * Deletes all but the newest `keep` backups of a label, never `spare`. A file that can't be deleted is skipped, so
 * the rest still go. Returns the deleted paths and the ones that couldn't be, oldest first.
 */
export function pruneBackups(
  dir: string,
  label: string,
  keep: number,
  spare?: string,
): { readonly removed: string[]; readonly failed: string[] } {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`10db-${label}-`) && f.endsWith('.sqlite'))
    .sort()
    .reverse();
  const doomed = files
    .slice(keep)
    .map((f) => join(dir, f))
    .filter((path) => path !== spare);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const file of doomed.reverse()) {
    try {
      rmSync(file, { force: true });
      removed.push(file);
    } catch {
      failed.push(file);
    }
  }
  return { removed, failed };
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

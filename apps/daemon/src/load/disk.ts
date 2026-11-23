import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InboxItemId } from '@10db/contracts';
import { findOpenByFoldKey, listProjects, type DbReader } from '@10db/db';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { diskCard, DISK_FOLD_KEY } from './card';
import { projectForMachineCard } from './card-project';
import { CARD_OPENS, Urgency } from '@10db/contracts';
import { CardTier } from '../inbox';

/**
 * Where the free-disk floor is set. Settings has no Capacity section yet, so the link opens Settings
 * itself; the floor is read from the `capacity` app setting (`capacity.ts`).
 */
const CAPACITY_SETTINGS = { to: 'settings', section: 'overview', label: 'Open Settings' } as const;

/** How far above the floor free disk must climb before a hold ends, so it doesn't flap at the edge. */
export const CLEAR_MARGIN_BYTES = 5_000_000_000;

export interface DiskReading {
  /** Null when the volume could not be read. */
  readonly freeBytes: number | null;
  readonly floorBytes: number;
}

export interface DiskHold {
  /** Reads free disk and says whether new lanes wait for it. */
  holding(): boolean;
  /** Free disk now and the floor, as Factory and Settings show them. */
  reading(): DiskReading;
}

export interface DiskHoldOptions {
  /** Free bytes on the volume worktrees are made on; null when it cannot be read. */
  freeBytes(): number | null;
  floorBytes(): number;
  readonly db: DbReader;
  readonly inbox: Pick<InboxService, 'flag' | 'withdraw'>;
  readonly logger: Logger;
}

/**
 * The free bytes a process may use on the volume holding `path`, read at its nearest existing
 * ancestor since the worktree root is made only when the first worktree is cut; null when none reads.
 */
export function systemFreeBytes(path: string): () => number | null {
  return () => {
    for (let at = path; ; at = dirname(at)) {
      try {
        const stats = statfsSync(at);
        return stats.bavail * stats.bsize;
      } catch {
        if (dirname(at) === at) return null;
      }
    }
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Holds new lanes while free disk is below the floor, and lets them go once it is back above the
 * floor plus `CLEAR_MARGIN_BYTES`. A disk it cannot read never holds. One card says so while it
 * holds; a card a run before this one left open is withdrawn when the hold is made.
 */
export function createDiskHold(opts: DiskHoldOptions): DiskHold {
  let card: { readonly id: InboxItemId; body: string } | null = null;
  let held = false;

  for (const project of listProjects(opts.db)) {
    try {
      const stale = findOpenByFoldKey(opts.db, project.id, DISK_FOLD_KEY);
      if (stale) opts.inbox.withdraw(stale.id);
    } catch (error) {
      opts.logger.error(
        { err: errorText(error) },
        'could not withdraw a disk card left from before a restart',
      );
    }
  }

  function raise(freeBytes: number, floorBytes: number): void {
    const content = diskCard({
      freeBytes,
      floorBytes,
      clearBytes: floorBytes + CLEAR_MARGIN_BYTES,
    });
    if (card?.body === content.body) return;
    const projectId = projectForMachineCard(opts.db);
    if (projectId === null) return;
    try {
      const item = opts.inbox.flag({
        projectId,
        workstreamId: null,
        tier: CardTier.Ask,
        urgency: Urgency.High,
        detail: { [CARD_OPENS]: CAPACITY_SETTINGS },
        closesWhen: { by: 'withdrawn', when: 'free disk is above the floor again (disk)' },
        title: content.title,
        body: content.body,
        foldKey: content.foldKey,
        refresh: true,
      });
      card = { id: item.id, body: content.body };
    } catch (error) {
      opts.logger.error({ err: errorText(error) }, 'could not raise the disk card');
    }
  }

  function clear(): void {
    held = false;
    try {
      if (card) opts.inbox.withdraw(card.id);
    } catch (error) {
      opts.logger.error({ err: errorText(error) }, 'could not withdraw the disk card');
    }
    card = null;
  }

  return {
    holding() {
      const freeBytes = opts.freeBytes();
      const floorBytes = opts.floorBytes();
      if (freeBytes === null) {
        if (held) clear();
        return false;
      }
      if (!held && freeBytes < floorBytes) {
        held = true;
        opts.logger.warn({ freeBytes, floorBytes }, 'free disk is low: holding new lanes');
      } else if (held && freeBytes >= floorBytes + CLEAR_MARGIN_BYTES) {
        opts.logger.info({ freeBytes, floorBytes }, 'free disk is back: new lanes may start');
        clear();
      }
      if (held) raise(freeBytes, floorBytes);
      return held;
    },
    reading: () => ({ freeBytes: opts.freeBytes(), floorBytes: opts.floorBytes() }),
  };
}

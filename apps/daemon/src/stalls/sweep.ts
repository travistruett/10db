import {
  BatchState,
  WorkstreamState,
  type ProjectId,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { listActiveProjects, listBatches, listWorkstreams } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import { cardsResolvedByEvent, flagCard, resolveStaleCards, type InboxService } from '../inbox';
import type { Logger } from '../log';
import type { QueueWaits } from '../scheduler';
import { stallCard, stallCardOf } from './card';
import { batchStallKey, findStalls, runStallKey, type QueuedRun } from './rules';
import { STALL } from './thresholds';

/** The reason 10db writes on a Stuck card it closed because the item moved. */
export const STALL_CLEARED_REASON = 'It moved again';

export interface StallSweep {
  start(): void;
  stop(): void;
  /** Looks once: raises a card for each new or changed stall and closes the cards whose stall is gone. */
  sweep(): void;
}

/** The latest run of each task among a batch's runs, which `listWorkstreams` lists oldest first. */
function latestPerTask(runs: readonly WorkstreamDto[]): WorkstreamDto[] {
  const latest = new Map<TaskId, WorkstreamDto>();
  for (const run of runs) latest.set(run.taskId, run);
  return [...latest.values()];
}

/**
 * The watchdog: every minute it reads what is queued, active and shipping in the active projects and
 * keeps one Stuck card per stall. It writes nothing but those cards: it never cancels, retries or
 * abandons on its own.
 */
export function createStallSweep(deps: {
  readonly state: StateStore;
  readonly inbox: Pick<InboxService, 'resolve'>;
  readonly waits: Pick<QueueWaits, 'get'>;
  readonly clock: Clock;
  readonly logger: Logger;
}): StallSweep {
  let timer: Timer | null = null;
  let started = false;

  function sweep(): void {
    const db = deps.state.db;
    const now = deps.clock.now();
    const live = new Set(listActiveProjects(db).map((p) => p.id));
    const inLive = (w: { readonly projectId: ProjectId }): boolean => live.has(w.projectId);
    // A queued run no tick has looked at since the start has no wait yet: its card, and its batch's,
    // stay as they are until one has.
    const unknown = new Set<string>();
    const queued: QueuedRun[] = [];
    for (const run of listWorkstreams(db, { states: [WorkstreamState.Queued] }).filter(inLive)) {
      const wait = deps.waits.get(run.id);
      if (wait === undefined) {
        unknown.add(runStallKey(run.id));
        if (run.batchId !== null) unknown.add(batchStallKey(run.batchId));
        continue;
      }
      queued.push({ run, title: run.taskTitle, wait });
    }
    const active = listWorkstreams(db, {
      states: [WorkstreamState.Starting, WorkstreamState.Running, WorkstreamState.Verifying],
    }).filter(inLive);
    const batches = listBatches(db, {
      states: [BatchState.Open, BatchState.Shipping, BatchState.Cutting],
    })
      .filter(inLive)
      .map((batch) => ({
        batch,
        members: latestPerTask(listWorkstreams(db, { batchId: batch.id })),
      }));
    const open = new Map(
      cardsResolvedByEvent(db, null).flatMap(({ item, when }) => {
        if (when.event !== 'stall_cleared') return [];
        const card = stallCardOf(item);
        return card === null ? [] : [[when.key, card] as const];
      }),
    );
    const stalls = findStalls({
      now,
      queued,
      active,
      batches,
      carried: new Map([...open].map(([key, card]) => [key, card.since])),
    });
    const changed = stalls.filter((s) => open.get(s.key)?.fingerprint !== s.fingerprint);
    if (changed.length > 0)
      deps.state.write((ctx) => {
        for (const stall of changed) flagCard(ctx, stallCard(stall));
      });
    const current = new Set(stalls.map((s) => s.key));
    const closed = resolveStaleCards(db, deps.inbox, null, (when, item) =>
      when.event === 'stall_cleared' &&
      live.has(item.projectId) &&
      !current.has(when.key) &&
      !unknown.has(when.key)
        ? STALL_CLEARED_REASON
        : null,
    );
    if (changed.length > 0 || closed > 0)
      deps.logger.info(
        { component: 'stalls', raised: changed.map((s) => s.key), closed },
        'stall sweep changed its cards',
      );
  }

  function loop(): void {
    try {
      sweep();
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'stall sweep failed',
      );
    }
    if (started) timer = deps.clock.setTimeout(loop, STALL.sweepMs);
  }

  return {
    sweep,
    start() {
      started = true;
      timer ??= deps.clock.setTimeout(loop, STALL.sweepMs);
    },
    stop() {
      started = false;
      timer?.cancel();
      timer = null;
    },
  };
}

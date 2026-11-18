import { availableParallelism, loadavg } from 'node:os';
import { ACTIVE_STATES, BatchState, type WorkstreamId } from '@10db/contracts';
import {
  findOpenByFoldKey,
  getBatchRow,
  getWorkstreamRow,
  listBatches,
  listPassCheckPids,
  listProjects,
  listSessions,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { CardTier, type InboxService } from '../inbox';
import type { Logger } from '../log';
import { STATUS_HYSTERESIS_MS, type StatusService } from '../status';
import { busiestNames, OVERLOAD_FOLD_KEY, overloadStatus } from './card';
import {
  findCulprits,
  systemProcessSnapshot,
  type KnownProcesses,
  type ProcessSnapshot,
} from './culprits';
import {
  createLoadGuard,
  type LoadGuard,
  type LoadGuardOptions,
  type LoadReading,
  type OverloadReport,
} from './guard';

/** The temp dir of each lane session that is running, which the runner records and forgets. */
export interface LaneTempDirs {
  set(id: WorkstreamId, dir: string): void;
  delete(id: WorkstreamId): void;
  entries(): readonly { readonly workstreamId: WorkstreamId; readonly dir: string }[];
}

export function createLaneTempDirs(): LaneTempDirs {
  const dirs = new Map<WorkstreamId, string>();
  return {
    set: (id, dir) => {
      dirs.set(id, dir);
    },
    delete: (id) => {
      dirs.delete(id);
    },
    entries: () => [...dirs].map(([workstreamId, dir]) => ({ workstreamId, dir })),
  };
}

export const systemLoad = (): LoadReading => ({
  load: loadavg()[0] ?? 0,
  cores: availableParallelism(),
});

/** What 10db has running now, from its own records: lane sessions, gates and the worktrees lanes work in. */
export function knownProcesses(
  db: DbReader,
  facts: {
    readonly daemonPid: number;
    readonly tempRoot: string | null;
    readonly tempDirs: LaneTempDirs;
  },
): KnownProcesses {
  const sessions: { pid: number; workstreamId: string; label: string }[] = [];
  const gates: { pid: number; label: string }[] = [];
  const worktrees: { path: string; workstreamId: string; label: string }[] = [];
  const labels = new Map<WorkstreamId, string>();
  const batches = new Map(listBatches(db).map((b) => [b.id, b] as const));
  for (const ws of listWorkstreams(db, { states: ACTIVE_STATES })) {
    const label = `task "${ws.taskTitle}"`;
    labels.set(ws.id, label);
    for (const s of listSessions(db, ws.id)) {
      if (s.endedAt === null && s.pid !== null)
        sessions.push({ pid: s.pid, workstreamId: ws.id, label });
    }
    const gatePid = getWorkstreamRow(db, ws.id).gatePid;
    if (gatePid !== null) gates.push({ pid: gatePid, label: `the gate for ${label}` });
    if (ws.batchId !== null) {
      const path = batches.get(ws.batchId)?.worktreePath;
      if (path) worktrees.push({ path, workstreamId: ws.id, label });
    }
  }
  for (const batch of listBatches(db, { states: [BatchState.Shipping] })) {
    const gatePid = getBatchRow(db, batch.id).gatePid;
    if (gatePid !== null)
      gates.push({ pid: gatePid, label: `the shipping gate of batch "${batch.title}"` });
  }
  for (const check of listPassCheckPids(db))
    gates.push({ pid: check.pid, label: `the UI Workbench check of pass "${check.name}"` });
  return {
    daemonPid: facts.daemonPid,
    tempRoot: facts.tempRoot,
    sessions,
    gates,
    tempDirs: facts.tempDirs.entries().flatMap(({ workstreamId, dir }) => {
      const label = labels.get(workstreamId);
      return label === undefined ? [] : [{ dir, workstreamId, label }];
    }),
    worktrees,
  };
}

export interface LoadMonitorOptions extends Partial<
  Pick<LoadGuardOptions, 'read' | 'sampleMs' | 'overloadFactor' | 'sustainedMs' | 'clearFactor'>
> {
  readonly state: StateStore;
  /** Withdraws the card an earlier run raised for the overload, and posts the notice when a hold ends. */
  readonly inbox: Pick<InboxService, 'withdraw' | 'notice'>;
  readonly status: Pick<StatusService, 'hold' | 'release' | 'busy'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly daemonPid: number;
  /** Where lane temp dirs are made; null when lanes aren't sandboxed. */
  readonly tempRoot: string | null;
  readonly tempDirs: LaneTempDirs;
  /** Called once the overload is over, so the scheduler launches what it held. */
  onCleared(): void;
  /** Tests replace ps and lsof. */
  readonly processes?: ProcessSnapshot;
}

const OVERLOAD_STATUS_KEY = 'overload';

/** A hold shorter than this was never shown, so it earns no notice either. */
const NOTICE_AFTER_MS = STATUS_HYSTERESIS_MS;

function waited(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours)} hour${hours === 1 ? '' : 's'}${rest === 0 ? '' : ` ${String(rest)} min`}`;
}

/**
 * The load guard with its status line: the hold is reported from the moment an overload is declared,
 * with the busy processes as they change, and lifted when it ends. It raises no card; one left open by
 * an earlier run, which raised one, is withdrawn when the monitor is made.
 */
export function createLoadMonitor(opts: LoadMonitorOptions): LoadGuard {
  const db = opts.state.db;
  const processes = opts.processes ?? systemProcessSnapshot();

  // A card an earlier version raised and a run left open would say for good that 10db is holding work.
  for (const project of listProjects(db)) {
    try {
      const stale = findOpenByFoldKey(db, project.id, OVERLOAD_FOLD_KEY);
      if (stale) opts.inbox.withdraw(stale.id);
    } catch (error) {
      opts.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not withdraw an overload card left from before a restart',
      );
    }
  }

  // The latest report of the overload on now, for the notice that says what it was busy with.
  let latest: OverloadReport | null = null;
  // The busiest names from the culprits gathered at the hold's start and at each sample after it.
  let busiest: string[] = [];

  function noticeHoldEnded(report: OverloadReport): void {
    const ms = opts.clock.now().getTime() - report.since.getTime();
    if (ms < NOTICE_AFTER_MS) return;
    const names = busiestNames(report.culprits, 2);
    const mostly = names.length === 0 ? '' : `, mostly with ${names.join(' and ')}`;
    try {
      opts.inbox.notice({
        tier: CardTier.Notice,
        projectId: null,
        taskId: null,
        key: `load-hold:${report.since.toISOString()}`,
        tone: 'info',
        line: `10db waited ${waited(ms)} to start new work because your Mac was busy${mostly}.`,
        body: '',
      });
    } catch (error) {
      opts.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not post the notice that a load hold ended',
      );
    }
  }

  return createLoadGuard({
    clock: opts.clock,
    logger: opts.logger,
    read: opts.read ?? systemLoad,
    ...(opts.sampleMs === undefined ? {} : { sampleMs: opts.sampleMs }),
    ...(opts.overloadFactor === undefined ? {} : { overloadFactor: opts.overloadFactor }),
    ...(opts.sustainedMs === undefined ? {} : { sustainedMs: opts.sustainedMs }),
    ...(opts.clearFactor === undefined ? {} : { clearFactor: opts.clearFactor }),
    culprits: () =>
      findCulprits(processes, () =>
        knownProcesses(db, {
          daemonPid: opts.daemonPid,
          tempRoot: opts.tempRoot,
          tempDirs: opts.tempDirs,
        }),
      ),
    onOverloaded: (report) => {
      latest = report;
      busiest = busiestNames(report.culprits, 3);
      opts.status.hold(OVERLOAD_STATUS_KEY, overloadStatus(report));
    },
    onLevel: (level, holding) => {
      opts.status.busy(level, holding, holding ? busiest : []);
    },
    onCleared: () => {
      opts.status.release(OVERLOAD_STATUS_KEY);
      busiest = [];
      const report = latest;
      latest = null;
      if (report !== null) noticeHoldEnded(report);
      opts.onCleared();
    },
  });
}

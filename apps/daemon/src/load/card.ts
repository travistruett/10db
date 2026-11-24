import { StatusKind } from '@10db/contracts';
import type { StatusHold } from '../status';
import type { Culprit, Owner, OverloadNote, OverloadReport } from './guard';

export const OVERLOAD_FOLD_KEY = 'machine-overloaded';
export const DISK_FOLD_KEY = 'machine-disk-low';

export interface OverloadCard {
  readonly title: string;
  readonly body: string;
  readonly foldKey: string;
}

function whose(owner: Owner): string {
  switch (owner.kind) {
    case 'lane':
      return `the lane for ${owner.label}`;
    case 'gate':
      return owner.label;
    case 'ended-lane':
      return 'left behind by a lane session that has ended (10db’s)';
    case 'daemon':
      return '10db itself, not a lane or a gate';
    case 'other':
      return 'not 10db’s';
  }
}

/** The macOS services that follow every file a worktree's installs and test runs touch. */
const FILE_WATCHERS = /(?:^|\/)(?:mds_stores|mdworker|fseventsd)/;

/** What the builder can do about it, from who owns the busy processes. */
function advice(culprits: readonly Culprit[]): string {
  const left = culprits.filter((c) => c.owner.kind === 'ended-lane');
  const other = culprits.filter((c) => c.owner.kind === 'other');
  const parts: string[] = [];
  if (culprits.some((c) => FILE_WATCHERS.test(c.command)))
    parts.push(
      'Spotlight and the file-change watcher follow every file that worktrees’ installs and test runs touch. Two Inbox cards cut that: one for an older folder of hand-made worktrees Spotlight indexes (make them in a folder named *-worktrees.noindex, which it skips), and Remove Merged Worktrees, for the ones whose pull request merged. 10db’s own worktrees are already kept out of Spotlight and removed when their batch ships.',
    );
  if (left.length > 0)
    parts.push(
      `Stop what an ended lane left behind (${left.map((c) => `kill ${String(c.pid)}`).join(', ')}); 10db starts work again once the load falls.`,
    );
  if (other.length === culprits.length)
    parts.push('Nothing here is 10db’s, so only you can stop it; 10db waits.');
  else if (other.length > 0)
    parts.push(
      `The processes that are not 10db’s are yours to stop (${other.map((c) => `pid ${String(c.pid)}`).join(', ')}).`,
    );
  return parts.join(' ');
}

/** The program's own name from a command line: `/Applications/Foo.app/Contents/MacOS/Foo --x` is `Foo`. */
export function shortName(command: string): string {
  const app = /([^/]+)\.app\//.exec(command);
  if (app?.[1]) return app[1];
  const first = command.trim().split(/\s+/)[0] ?? command;
  return first.split('/').pop() ?? first;
}

/** What a busy macOS service or app is called to someone who does not know its process name. */
function friendlyName(culprit: Culprit): string {
  if (culprit.owner.kind !== 'other') return '10db’s own work';
  const name = shortName(culprit.command);
  switch (name) {
    case 'fseventsd':
      return 'file indexing';
    case 'mds':
    case 'mds_stores':
      return 'Spotlight';
    default:
      return name;
  }
}

/** The busiest things in plain words, most CPU first, each once, at most `limit`. */
export function busiestNames(culprits: readonly Culprit[], limit: number): string[] {
  const names = new Set(culprits.map(friendlyName));
  return [...names].slice(0, limit);
}

/** What the status line says while the Mac is overloaded, rewritten at each sample. */
export function overloadStatus(report: OverloadReport): StatusHold {
  const load = `load ${String(Math.round(report.load))} on ${String(report.cores)} cores`;
  const what =
    report.culprits.length === 0
      ? '10db could not read which processes are using the CPU.'
      : advice(report.culprits);
  return {
    kind: StatusKind.AdmissionHold,
    label: 'Mac overloaded',
    line: `Holding new lanes: the Mac is overloaded (${load})`,
    details:
      `The load average is ${String(Math.round(report.load))} on ${String(report.cores)} cores and has stayed above twice that for several minutes. 10db starts no new lane session or gate until it falls, and starts them again by itself then. Lanes and gates already running carry on.\n\n${what}`.trimEnd(),
    busiest: busiestNames(report.culprits, 3),
    culprits: report.culprits.map((c) => ({
      name: shortName(c.command),
      cpuPct: Math.round(c.cpu),
      owner: whose(c.owner),
    })),
  };
}

/** Whole gigabytes, rounded down so a reading just under the floor never reads as the floor. */
export function gigabytes(bytes: number): string {
  return String(Math.floor(bytes / 1_000_000_000));
}

/** The one card the builder gets while free disk is below the floor. */
export function diskCard(reading: {
  readonly freeBytes: number;
  readonly floorBytes: number;
  readonly clearBytes: number;
}): OverloadCard {
  return {
    title: 'Free disk is low: 10db is holding new lanes',
    body: `${gigabytes(reading.freeBytes)} GB free on the volume 10db makes worktrees on, below the ${gigabytes(reading.floorBytes)} GB floor. 10db starts no new lane until more than ${gigabytes(reading.clearBytes)} GB is free, and starts them again by itself then. Lanes, gates and ships already running carry on, and each batch that ships removes its worktree.`,
    foldKey: DISK_FOLD_KEY,
  };
}

/** A line for a not-shipped card whose gate ran while the Mac was overloaded. */
export function gateNote(note: OverloadNote): string {
  return `The Mac was overloaded while this gate ran (the load average reached ${String(Math.round(note.peakLoad))} on ${String(note.cores)} cores), so timeouts and slow tests may be the machine's rather than the batch's. Check what is using the CPU before treating this as the batch's failure.`;
}

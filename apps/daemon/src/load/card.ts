import type { Culprit, Owner, OverloadNote, OverloadReport } from './guard';

export const OVERLOAD_FOLD_KEY = 'machine-overloaded';

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

function line(c: Culprit): string {
  return `- pid ${String(c.pid)} (${c.command}) at ${String(Math.round(c.cpu))}% of a core: ${whose(c.owner)}`;
}

/** What the builder can do about it, from who owns the busy processes. */
function advice(culprits: readonly Culprit[]): string {
  const left = culprits.filter((c) => c.owner.kind === 'ended-lane');
  const other = culprits.filter((c) => c.owner.kind === 'other');
  const parts: string[] = [];
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

/** The one card the builder gets while the Mac is overloaded, rewritten at each sample. */
export function overloadCard(report: OverloadReport): OverloadCard {
  const what =
    report.culprits.length === 0
      ? '10db could not read which processes are using the CPU.'
      : `Using the most CPU now:\n${report.culprits.map(line).join('\n')}\n\n${advice(report.culprits)}`;
  return {
    title: 'The Mac is overloaded: 10db is holding new lanes and gates',
    body: `The load average is ${String(Math.round(report.load))} on ${String(report.cores)} cores and has stayed far above that for several minutes. 10db starts no new lane session or gate until it falls, and starts them again by itself then. Lanes and gates already running carry on.\n\n${what}`.trimEnd(),
    foldKey: OVERLOAD_FOLD_KEY,
  };
}

/** A line for a not-shipped card whose gate ran while the Mac was overloaded. */
export function gateNote(note: OverloadNote): string {
  return `The Mac was overloaded while this gate ran (the load average reached ${String(Math.round(note.peakLoad))} on ${String(note.cores)} cores), so timeouts and slow tests may be the machine's rather than the batch's. Check what is using the CPU before treating this as the batch's failure.`;
}

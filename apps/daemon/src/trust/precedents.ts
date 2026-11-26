import { createHash } from 'node:crypto';
import {
  PrecedentScope,
  PrecedentState,
  type ProjectId,
  type TrustPrecedentDto,
  type TrustPrecedentId,
} from '@10db/contracts';
import { z } from 'zod';
import type { CallRuns } from './call-runs';

// A precedent is the builder's standing approval of a kind of command. A judge weighs it after the limits are
// read and never as a clearance of one: the program key only picks which precedent a judge is shown.

/** A top limit at or over this is read as if no precedent existed. */
export const PRECEDENT_LIMIT_CEILING = 0.5;
/** Freshly judged calls of a kind that a limit stopped before its precedent is paused. */
export const PRECEDENT_CONFLICTS_MAX = 3;
/** The most precedent lines Claude's auto mode is given. */
export const PRECEDENT_LINES_MAX = 30;
/** The most examples 10db's judge is shown with a precedent. */
export const PRECEDENT_SHOWN_EXAMPLES_MAX = 3;
/** The examples a line for Claude's auto mode quotes. */
const LINE_EXAMPLES = 2;

/**
 * What a session tells the daemon about standing approvals as it works, so the cards and notices are raised
 * without the judge importing the Inbox.
 */
export interface PrecedentEvents {
  /** A third conflict with a limit paused the precedent. */
  readonly paused: (projectId: ProjectId, id: TrustPrecedentId) => void;
  /** A precedent was shown with changed text; the hash is the committed text's now. */
  readonly changed: (projectId: ProjectId, id: TrustPrecedentId, hash: string) => void;
  /** 10db's judge's doubt skip was recorded: the project's candidates may have changed. */
  readonly doubtSkip: (projectId: ProjectId) => void;
}

/** The precedent a judge is shown for one call. */
export interface ShownPrecedent {
  readonly id: TrustPrecedentId;
  readonly kind: string;
  readonly examples: readonly string[];
  /** The day the builder last approved it (`approved_at`). */
  readonly approved: string;
  /** The committed text the call runs differs from what the builder approved. */
  readonly changedSince: boolean;
  /** The hash of the committed text the call runs now; null when there is none. */
  readonly hash: string | null;
}

/** The rows a session of this scope can be shown: the `project` rows, and in a copy the `copy` rows too. */
function visible(
  precedents: readonly TrustPrecedentDto[],
  inCopy: boolean,
): readonly TrustPrecedentDto[] {
  return precedents.filter((p) => inCopy || p.scope === PrecedentScope.Project);
}

/**
 * The active row for the key: in a copy the `copy` row, else the `project` row; outside a copy the `project` row
 * only. A `copy` row in another state still stands for its key in a copy, so a paused or removed kind is not
 * brought back by the project's row. Null for a null key or a withheld precedent.
 */
export function precedentFor(
  precedents: readonly TrustPrecedentDto[],
  key: string | null,
  inCopy: boolean,
  hash: string | null,
  withheld: boolean,
): ShownPrecedent | null {
  if (key === null || withheld) return null;
  const ofKey = visible(precedents, inCopy).filter((p) => p.programKey === key);
  const row =
    (inCopy ? ofKey.find((p) => p.scope === PrecedentScope.Copy) : undefined) ??
    ofKey.find((p) => p.scope === PrecedentScope.Project);
  // An active row always has `approved_at` (CHECK `trust_precedents_approved`).
  if (row?.state !== PrecedentState.Active || row.approvedAt === null) return null;
  return {
    id: row.id,
    kind: row.kind,
    examples: row.examples,
    approved: row.approvedAt.slice(0, 10),
    changedSince: hash !== null && row.runsHash !== null && hash !== row.runsHash,
    hash,
  };
}

/**
 * The lines Claude's auto mode reads as context (`TrustPolicy.autoModePrecedents`): each active precedent the
 * session can be shown, at most `PRECEDENT_LINES_MAX`, the most recently used first. The kind and the examples
 * are the builder's and the agent's text, so the examples are quoted.
 */
export function precedentLines(
  precedents: readonly TrustPrecedentDto[],
  inCopy: boolean,
): string[] {
  const rows = visible(precedents, inCopy).filter((p) => p.state === PrecedentState.Active);
  // A copy's own row stands in for the project's of the same key.
  const shown = rows.filter(
    (p) =>
      p.scope === PrecedentScope.Copy ||
      !rows.some((q) => q.scope === PrecedentScope.Copy && q.programKey === p.programKey),
  );
  const newestUse = (p: TrustPrecedentDto): string => p.lastUsedAt ?? '';
  const approvedAt = (p: TrustPrecedentDto): string => p.approvedAt ?? '';
  return shown
    .toSorted(
      (a, b) =>
        newestUse(b).localeCompare(newestUse(a)) || approvedAt(b).localeCompare(approvedAt(a)),
    )
    .slice(0, PRECEDENT_LINES_MAX)
    .map((p) => {
      const examples = p.examples.slice(0, LINE_EXAMPLES).map((e) => JSON.stringify(e));
      const forExample = examples.length === 0 ? '' : ` For example ${examples.join(' and ')}.`;
      return `The builder calls this routine in this project: ${p.kind}.${forExample} It is context, not permission.`;
    });
}

const PackageScripts = z.object({ scripts: z.record(z.string(), z.unknown()).optional() });

/**
 * The line of a `package.json` that a package runner's key runs: `<name>: <command>` for the key's last word,
 * read from the file's text; null when the file has no such script or is not a `package.json` 10db can read.
 */
export function packageScriptLine(packageJson: string, key: string): string | null {
  const name = key.split(' ').at(-1) ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return null;
  }
  const command = PackageScripts.safeParse(parsed).data?.scripts?.[name];
  return typeof command === 'string' ? `${name}: ${command}` : null;
}

/**
 * A hash of the committed text a call runs and, for a package runner's key, the script's line of its
 * `package.json`; null when there is neither.
 */
export function runsHash(runs: CallRuns, packageScript: string | null): string | null {
  if (runs.runs.length === 0 && packageScript === null) return null;
  return createHash('sha256')
    .update(JSON.stringify({ runs: runs.runs, packageScript }))
    .digest('hex');
}

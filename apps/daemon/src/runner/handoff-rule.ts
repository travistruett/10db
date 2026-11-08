import type { HandoffDto } from '@10db/contracts';

/** What the runner knows at a turn end with a handoff recorded. */
export interface HandoffFacts {
  /** 10db asked for the handoff: its context or account nudge, or a tool's answer. */
  readonly asked: boolean;
  readonly readOnly: boolean;
  /** The read-only step recorded its result in this session. */
  readonly resultRecorded: boolean;
  /** The handoff names work left (`workLeftIn`). */
  readonly leftNamed: boolean;
  /** Changes in the step's claims are uncommitted. */
  readonly uncommitted: boolean;
}

/**
 * Whether the handoff starts a fresh session on the step. One 10db asked for always does: the session was told
 * to commit first and name what is left. One nobody asked for does only while the step's work is outstanding:
 * work it names as left, or, in an edit step, changes left uncommitted; a read-only step that recorded its result
 * has none. Otherwise the session is saying it finished, and the step ends as ending the turn would.
 */
export function handoffStands(facts: HandoffFacts): boolean {
  if (facts.asked) return true;
  if (facts.readOnly) return !facts.resultRecorded && facts.leftNamed;
  return facts.leftNamed || facts.uncommitted;
}

/** The work a handoff says is left: what it names as not done, and what blocks it. */
export function workLeftIn(handoff: HandoffDto): readonly string[] {
  return [...handoff.content.progress.notDone, ...handoff.content.continuity.blockers];
}

/** How many handoffs in a row, nobody asking and no commit between them, end a step. */
export const UNASKED_HANDOFF_LIMIT = 3;

/** A step's run of handoffs nobody asked for, at one commit. */
export interface UnaskedRun {
  readonly gitHead: string;
  readonly count: number;
}

/**
 * The run once one more handoff nobody asked for is written at `gitHead`, and whether it reached
 * `UNASKED_HANDOFF_LIMIT`: a session handing off instead of working, which another session would repeat.
 */
export function nextUnaskedRun(
  run: UnaskedRun | null,
  gitHead: string,
): { readonly run: UnaskedRun; readonly atLimit: boolean } {
  const count = run !== null && run.gitHead === gitHead ? run.count + 1 : 1;
  return { run: { gitHead, count }, atLimit: count >= UNASKED_HANDOFF_LIMIT };
}

import {
  MILESTONES_BEFORE_CUT,
  MilestoneMark,
  ShapeProposalState,
  type MilestoneCut,
  type ShapeProposalId,
} from '@10db/contracts';

// The builder's cut: a Plan with more than a few milestones is cut before Convert makes a task, and a
// milestone left for later is converted only once those before it have merged, so at most one is planned
// ahead. A milestone is a goal proposal; their order is the order the Plan states them in.

/** One goal proposal of the Plan as the cut reads it. */
export interface Milestone {
  readonly id: ShapeProposalId;
  readonly title: string;
  readonly state: ShapeProposalState;
  /** Whether every task it made is done or removed; true for one that made none. */
  readonly merged: boolean;
}

export interface MilestoneJudgement {
  readonly errors: readonly string[];
  /** Milestones marked needed that the selection did not hold; Convert adds them. */
  readonly needed: readonly ShapeProposalId[];
  /** Milestones marked cut; Convert drops each and keeps its outline as a tombstone. */
  readonly cut: readonly ShapeProposalId[];
}

const names = (milestones: readonly Milestone[]): string =>
  milestones.map((m) => m.title).join(', ');

/**
 * Judges a Convert of `selected` against the Plan's `milestones` (in order, superseded ones left out) and
 * the builder's `marks`. The cut list is required when more than five milestones wait and the call would
 * convert one. Marks, when given, decide which milestones convert; a selected milestone with no needed
 * mark in a Plan of more than five milestones waits for the ones before it to merge.
 */
export function judgeMilestones(
  milestones: readonly Milestone[],
  selected: ReadonlySet<ShapeProposalId>,
  marks: readonly MilestoneCut[] | undefined,
): MilestoneJudgement {
  const errors: string[] = [];
  const pending = milestones.filter((m) => m.state === ShapeProposalState.Pending);
  const byId = new Map(pending.map((m) => [m.id, m]));
  const wanted = pending.filter((m) => selected.has(m.id));
  const markOf = new Map<ShapeProposalId, MilestoneMark>();
  for (const { proposalId, mark } of marks ?? []) {
    if (!byId.has(proposalId)) {
      errors.push(`${proposalId} is not a milestone of this Plan that is waiting to be converted`);
    } else if (markOf.has(proposalId) && markOf.get(proposalId) !== mark) {
      errors.push(`${byId.get(proposalId)?.title ?? proposalId} is marked more than one way`);
    } else markOf.set(proposalId, mark);
  }

  const converts =
    wanted.length > 0 || [...markOf.values()].some((mark) => mark === MilestoneMark.Needed);
  const required = pending.length > MILESTONES_BEFORE_CUT && converts;
  if (required) {
    if (marks === undefined)
      errors.push(
        `This Plan has ${String(pending.length)} milestones. Mark each one needed for the goal, later or cut before any task is made: ${names(pending)}`,
      );
    else {
      const unmarked = pending.filter((m) => !markOf.has(m.id));
      if (unmarked.length > 0)
        errors.push(`Mark each milestone needed, later or cut; not marked: ${names(unmarked)}`);
    }
  }

  const held = pending.filter((m) => {
    const mark = markOf.get(m.id);
    return mark === MilestoneMark.Later || mark === MilestoneMark.Cut;
  });
  for (const m of held.filter((h) => selected.has(h.id)))
    errors.push(
      `${m.title} is marked ${markOf.get(m.id) ?? ''} but is also selected to convert; mark it needed or take it off the selection`,
    );

  const needed = pending
    .filter((m) => markOf.get(m.id) === MilestoneMark.Needed && !selected.has(m.id))
    .map((m) => m.id);

  // Without a mark that says it is needed now, a milestone waits for those before it to merge. One
  // converting in this same call, or cut, is not waited for: the builder chose them together.
  if (!required && milestones.length > MILESTONES_BEFORE_CUT) {
    const converting = new Set([...selected, ...needed]);
    for (const m of wanted.filter((w) => markOf.get(w.id) !== MilestoneMark.Needed)) {
      const before = milestones.slice(0, milestones.indexOf(m));
      const waiting = before.filter(
        (b) =>
          (b.state === ShapeProposalState.Pending &&
            !converting.has(b.id) &&
            markOf.get(b.id) !== MilestoneMark.Cut) ||
          (b.state === ShapeProposalState.Accepted && !b.merged),
      );
      if (waiting.length > 0)
        errors.push(
          `${m.title} is a later milestone and waits for the ones before it to merge: ${names(waiting)}`,
        );
    }
  }

  return {
    errors,
    needed,
    cut: held.filter((m) => markOf.get(m.id) === MilestoneMark.Cut).map((m) => m.id),
  };
}

import {
  MILESTONES_BEFORE_CUT,
  MilestoneMark,
  mintId,
  PlanDraft,
  ShapeProposalState,
  ShapeState,
  TaskStatus,
  type MilestoneCut,
} from '@10db/contracts';
import {
  getShape,
  listShapeLinks,
  listShapeProposals,
  listTasks,
  setTaskStatus,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertProposals, type ConvertOutcome } from './convert';
import { seedConversation, type ConversationFixture } from './conversation-fixture';
import { reconcileDraft } from './rounds';

// A Plan with more than five milestones is cut by the builder before Convert makes a task: each
// milestone is needed for the goal, later or cut, and only the needed ones become tasks. A later one
// converts once the milestones before it have merged.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;

/** A Plan of `count` milestones, `m1` first, each with one task `m<n>-t`. */
function proposeMilestones(count: number): void {
  const m = c.say();
  const goals = Array.from({ length: count }, (_, i) => ({
    key: `m${String(i + 1)}`,
    title: `Milestone ${String(i + 1)}`,
    objective: 'Do the thing.',
    ceremony: 'direct',
    sourceMessageIds: [m],
    tasks: [
      { key: `m${String(i + 1)}-t`, title: `Task m${String(i + 1)}`, areas: ['api'], size: 'S' },
    ],
  }));
  const out = write((ctx) => reconcileDraft(ctx, c.shape.id, PlanDraft.parse({ goals })));
  if (!out.ok) throw new Error(out.errors.join('; '));
}

const rowOf = (key: string) => {
  const found = listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};
const stateOf = (key: string) => rowOf(key).state;
const taskTitles = () =>
  listTasks(c.store.db, c.project.id)
    .map((t) => t.title)
    .sort();

/** Marks by milestone key, e.g. `{ m1: 'needed' }`. */
const cutOf = (marks: Record<string, MilestoneMark>): MilestoneCut[] =>
  Object.entries(marks).map(([key, mark]) => ({ proposalId: rowOf(key).id, mark }));

const convert = (keys: string[], marks?: Record<string, MilestoneMark>): ConvertOutcome =>
  write((ctx) =>
    convertProposals(
      ctx,
      c.shape.id,
      keys.map((k) => rowOf(k).id),
      undefined,
      marks === undefined ? undefined : cutOf(marks),
    ),
  );

const needAll = (count: number): Record<string, MilestoneMark> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`m${String(i + 1)}`, MilestoneMark.Needed]),
  );

const refusal = (out: ConvertOutcome): string => {
  if (out.ok) throw new Error('expected a refusal');
  return out.errors.join('\n');
};

/** Finishes (merges) every task of a converted milestone. */
function merge(key: string): void {
  const links = listShapeLinks(c.store.db, c.shape.id).filter(
    (l) => l.proposalId === rowOf(key).id && l.taskId !== null,
  );
  write((ctx) => {
    for (const l of links) if (l.taskId !== null) setTaskStatus(ctx, l.taskId, TaskStatus.Done);
  });
}

describe('the builder’s cut', () => {
  it('refuses a Plan of more than five milestones with no cut, and creates nothing', () => {
    expect(MILESTONES_BEFORE_CUT).toBe(5);
    proposeMilestones(6);
    const out = convert(['m1', 'm2']);
    expect(refusal(out)).toContain('6 milestones');
    expect(refusal(out)).toContain('Milestone 3');
    expect(taskTitles()).toEqual([]);
    expect(stateOf('m1')).toBe(ShapeProposalState.Pending);
  });

  it('refuses a cut that leaves a milestone unmarked', () => {
    proposeMilestones(6);
    const marks = needAll(6);
    delete marks['m4'];
    expect(refusal(convert(['m1'], marks))).toContain('Milestone 4');
    expect(taskTitles()).toEqual([]);
  });

  it('converts only the needed milestones; later stays pending, cut is dropped, both keep their outline', () => {
    proposeMilestones(6);
    const out = convert(['m1', 'm2'], {
      m1: MilestoneMark.Needed,
      m2: MilestoneMark.Needed,
      m3: MilestoneMark.Later,
      m4: MilestoneMark.Later,
      m5: MilestoneMark.Cut,
      m6: MilestoneMark.Cut,
    });
    expect(out.ok).toBe(true);
    expect(taskTitles()).toEqual(['Task m1', 'Task m2']);
    expect(stateOf('m1')).toBe(ShapeProposalState.Accepted);
    expect(stateOf('m3')).toBe(ShapeProposalState.Pending);
    expect(stateOf('m5')).toBe(ShapeProposalState.Rejected);
    // The outline stays on the Plan: the row and its tasks' text are still there.
    expect(rowOf('m5').body).toMatchObject({ title: 'Milestone 5', tasks: [{ key: 'm5-t' }] });
    expect(getShape(c.store.db, c.shape.id).state).not.toBe(ShapeState.Converted);
  });

  it('adds a milestone marked needed to the selection', () => {
    proposeMilestones(6);
    const marks = needAll(6);
    for (const key of ['m2', 'm3', 'm4', 'm5', 'm6']) marks[key] = MilestoneMark.Later;
    expect(convert(['m1'], marks).ok).toBe(true);
    expect(taskTitles()).toEqual(['Task m1']);
  });

  it('refuses a milestone that is both selected and marked later or cut, and a mark of no milestone', () => {
    proposeMilestones(6);
    const marks = needAll(6);
    marks['m2'] = MilestoneMark.Later;
    expect(refusal(convert(['m1', 'm2'], marks))).toContain('Milestone 2');
    marks['m2'] = MilestoneMark.Needed;
    const stray = write((ctx) =>
      convertProposals(ctx, c.shape.id, [rowOf('m1').id], undefined, [
        ...cutOf(marks),
        { proposalId: mintId('ShapeProposal'), mark: MilestoneMark.Cut },
      ]),
    );
    expect(refusal(stray)).toContain('is not a milestone');
    expect(taskTitles()).toEqual([]);
  });

  it('asks for no cut at five milestones', () => {
    proposeMilestones(MILESTONES_BEFORE_CUT);
    expect(convert(['m1', 'm2', 'm3', 'm4', 'm5']).ok).toBe(true);
    expect(taskTitles()).toHaveLength(5);
  });
});

describe('a later milestone', () => {
  /** m1 and m2 needed now, m3 to m6 later. */
  function cutAfterTwo(): void {
    proposeMilestones(6);
    const marks = needAll(6);
    for (const key of ['m3', 'm4', 'm5', 'm6']) marks[key] = MilestoneMark.Later;
    marks['m2'] = MilestoneMark.Needed;
    expect(convert(['m1', 'm2'], marks).ok).toBe(true);
  }

  it('is refused while a milestone before it has not merged', () => {
    cutAfterTwo();
    const out = convert(['m3']);
    expect(refusal(out)).toContain('Milestone 3');
    expect(refusal(out)).toContain('Milestone 1');
    expect(taskTitles()).toEqual(['Task m1', 'Task m2']);
    merge('m1');
    expect(refusal(convert(['m3']))).toContain('Milestone 2');
  });

  it('converts once the milestones before it have merged, one milestone ahead at a time', () => {
    cutAfterTwo();
    merge('m1');
    merge('m2');
    expect(refusal(convert(['m3', 'm4']))).toContain('Milestone 4');
    expect(convert(['m3']).ok).toBe(true);
    expect(taskTitles()).toEqual(['Task m1', 'Task m2', 'Task m3']);
    expect(refusal(convert(['m4']))).toContain('Milestone 3');
    merge('m3');
    expect(convert(['m4']).ok).toBe(true);
  });

  it('is not held up by a milestone that was cut', () => {
    proposeMilestones(6);
    const marks = needAll(6);
    for (const key of ['m3', 'm4', 'm5', 'm6']) marks[key] = MilestoneMark.Later;
    marks['m2'] = MilestoneMark.Cut;
    expect(convert(['m1'], marks).ok).toBe(true);
    expect(stateOf('m2')).toBe(ShapeProposalState.Rejected);
    merge('m1');
    expect(convert(['m3']).ok).toBe(true);
  });
});

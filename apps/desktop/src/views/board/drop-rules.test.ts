import { mintId, type TaskDto, type WorkstreamState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { boardColumnDto, taskDto, workstreamDto } from '../../test/fixtures';
import { boardLayout, type ColumnKey } from './board-layout';
import { dropTarget, menuMoves, placeLocally, resolveDrop, startedDependents } from './drop-rules';

const icebox = boardColumnDto({ name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ name: 'Exploring', position: 1 });
const ICEBOX: ColumnKey = { kind: 'human', id: icebox.id };
const EXPLORING: ColumnKey = { kind: 'human', id: exploring.id };
const system = (
  status: 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'blocked' | 'done',
): ColumnKey => ({
  kind: 'system',
  status,
});

const idea1 = taskDto({
  title: 'idea1',
  boardStatus: 'ready',
  boardOrder: 1,
  boardColumnId: icebox.id,
});
const idea2 = taskDto({
  title: 'idea2',
  boardStatus: 'backlog',
  boardOrder: 2,
  boardColumnId: icebox.id,
});
const ready1 = taskDto({ title: 'ready1', boardStatus: 'ready', boardOrder: 3 });
const ready2 = taskDto({ title: 'ready2', boardStatus: 'ready', boardOrder: 4 });
const waiting = taskDto({ title: 'waiting', boardStatus: 'backlog', boardOrder: 5 });
const running = taskDto({ title: 'running', boardStatus: 'in_progress', boardOrder: 6 });
const shipped = taskDto({ title: 'shipped', boardStatus: 'done', status: 'done', boardOrder: 7 });
const reviewing = taskDto({
  title: 'reviewing',
  boardStatus: 'in_review',
  status: 'done',
  boardOrder: 8,
});
const tasks: TaskDto[] = [idea1, idea2, ready1, ready2, waiting, running, shipped, reviewing];
const layout = boardLayout([icebox, exploring], tasks);
/** `running` has started and waits on `waiting`. */
const STARTED = new Map([[waiting.id, running.title]]);
const HELD = 'running has started and waits on waiting; park it once running finishes';

describe('resolveDrop', () => {
  it.each([
    {
      name: 'a human card down its own column',
      task: idea1,
      to: { key: ICEBOX, index: 1 },
      expected: {
        kind: 'move',
        move: { to: icebox.id, after: idea2.id, before: null },
        note: null,
      },
    },
    {
      name: 'a ready card up its own column',
      task: ready2,
      to: { key: system('ready'), index: 0 },
      expected: { kind: 'move', move: { to: null, after: null, before: ready1.id }, note: null },
    },
    {
      name: 'a card onto its own place',
      task: ready1,
      to: { key: system('ready'), index: 0 },
      expected: { kind: 'none' },
    },
    {
      name: 'a human card to another human column',
      task: idea1,
      to: { key: EXPLORING, index: 0 },
      expected: {
        kind: 'move',
        move: { to: exploring.id, after: null, before: null },
        note: null,
      },
    },
    {
      name: 'a parked card with done dependencies to Ready',
      task: idea1,
      to: { key: system('ready'), index: 1 },
      expected: {
        kind: 'move',
        move: { to: null, after: ready1.id, before: ready2.id },
        note: null,
      },
    },
    {
      name: 'a parked card with unfinished dependencies to Ready',
      task: idea2,
      to: { key: system('ready'), index: 2 },
      expected: {
        kind: 'move',
        move: { to: null, after: ready2.id, before: null },
        note: 'idea2 waits on its dependencies, so it is in Backlog',
      },
    },
    {
      name: 'a ready card to a human column',
      task: ready1,
      to: { key: ICEBOX, index: 2 },
      expected: {
        kind: 'move',
        move: { to: icebox.id, after: idea2.id, before: null },
        note: null,
      },
    },
    {
      name: 'a backlog card to Ready',
      task: waiting,
      to: { key: system('ready'), index: 0 },
      expected: {
        kind: 'move',
        move: { to: null, after: null, before: ready1.id },
        note: 'waiting waits on its dependencies, so it is in Backlog',
      },
    },
    {
      name: 'a ready card to In progress',
      task: ready1,
      to: { key: system('in_progress'), index: 0 },
      expected: { kind: 'start', taskId: ready1.id },
    },
    {
      name: 'a card a started dependent waits on to a human column',
      task: waiting,
      to: { key: ICEBOX, index: 0 },
      expected: { kind: 'refuse', reason: HELD },
    },
    {
      name: 'a backlog card to In progress',
      task: waiting,
      to: { key: system('in_progress'), index: 0 },
      expected: {
        kind: 'refuse',
        reason:
          'Only a Ready card starts by dragging; use Start in its menu to queue it until its dependencies finish',
      },
    },
    {
      name: 'a parked card to In progress',
      task: idea1,
      to: { key: system('in_progress'), index: 0 },
      expected: { kind: 'refuse', reason: 'Move idea1 to Backlog or Ready before starting it' },
    },
    {
      name: 'a ready card to Blocked',
      task: ready1,
      to: { key: system('blocked'), index: 0 },
      expected: {
        kind: 'refuse',
        reason: 'Blocked, In review and Done follow the task’s state; cards can’t be dropped there',
      },
    },
    {
      name: 'a ready card to In review',
      task: ready1,
      to: { key: system('in_review'), index: 0 },
      expected: {
        kind: 'refuse',
        reason: 'Blocked, In review and Done follow the task’s state; cards can’t be dropped there',
      },
    },
    {
      name: 'a ready card to Done',
      task: ready1,
      to: { key: system('done'), index: 0 },
      expected: {
        kind: 'refuse',
        reason: 'Blocked, In review and Done follow the task’s state; cards can’t be dropped there',
      },
    },
    {
      name: 'an in-review card anywhere',
      task: reviewing,
      to: { key: system('ready'), index: 0 },
      expected: {
        kind: 'refuse',
        reason: 'In review cards follow their pull request; they can’t be dragged',
      },
    },
    {
      name: 'a running card anywhere',
      task: running,
      to: { key: ICEBOX, index: 0 },
      expected: {
        kind: 'refuse',
        reason: 'In progress cards follow their workstream; they can’t be dragged',
      },
    },
    {
      name: 'a done card anywhere',
      task: shipped,
      to: { key: system('ready'), index: 0 },
      expected: {
        kind: 'refuse',
        reason: 'Done cards stay where they finished; they can’t be dragged',
      },
    },
    {
      name: 'an unknown card',
      task: taskDto({ title: 'ghost' }),
      to: { key: system('ready'), index: 0 },
      expected: { kind: 'none' },
    },
  ])('resolves $name', ({ task, to, expected }) => {
    const action = resolveDrop(layout, task.id, to, STARTED);
    expect(action).toMatchObject(expected);
  });

  it('estimates an order between the neighbours for the optimistic placement', () => {
    const action = resolveDrop(layout, idea1.id, { key: system('ready'), index: 1 }, STARTED);
    expect(action).toMatchObject({ kind: 'move', order: 3.5 });
  });
});

describe('dropTarget', () => {
  it.each([
    { name: 'a card', over: ready2.id, expected: { key: system('ready'), index: 1 } },
    {
      name: "a column's empty space",
      over: `column:human:${exploring.id}`,
      expected: { key: EXPLORING, index: 0 },
    },
    { name: 'nothing', over: null, expected: null },
    { name: 'an unknown id', over: mintId('Task'), expected: null },
  ])('maps $name', ({ over, expected }) => {
    expect(dropTarget(layout, over)).toEqual(expected);
  });
});

describe('menuMoves', () => {
  /** Each move's label and whether it is enabled. */
  const labels = (task: TaskDto) =>
    menuMoves(layout, task.id, STARTED).map((m) => [
      m.label,
      m.target !== null && m.refusal === null,
    ]);
  it.each([
    {
      name: 'the first parked card: no move up, the other column, and planning it',
      task: idea1,
      expected: [
        ['Move to top', false],
        ['Move up', false],
        ['Move down', true],
        ['Move to bottom', true],
        ['Move to Exploring', true],
        ['Move to Ready', true],
      ],
    },
    {
      name: 'a parked card with unfinished dependencies plans to Backlog',
      task: idea2,
      expected: [
        ['Move to top', true],
        ['Move up', true],
        ['Move down', false],
        ['Move to bottom', false],
        ['Move to Exploring', true],
        ['Move to Backlog', true],
      ],
    },
    {
      name: 'a planned card parks in each human column',
      task: ready2,
      expected: [
        ['Move to top', true],
        ['Move up', true],
        ['Move down', false],
        ['Move to bottom', false],
        ['Move to Icebox', true],
        ['Move to Exploring', true],
      ],
    },
    {
      name: 'a card a started dependent waits on can’t park',
      task: waiting,
      expected: [
        ['Move to top', false],
        ['Move up', false],
        ['Move down', false],
        ['Move to bottom', false],
        ['Move to Icebox', false],
        ['Move to Exploring', false],
      ],
    },
    { name: 'a running card has none', task: running, expected: [] },
    { name: 'a done card has none', task: shipped, expected: [] },
  ])('offers $name', ({ task, expected }) => {
    expect(labels(task)).toEqual(expected);
  });
});

describe('menuMoves refusals', () => {
  it('says why each park is refused', () => {
    expect(
      menuMoves(layout, waiting.id, STARTED)
        .filter((m) => m.refusal !== null)
        .map((m) => [m.label, m.refusal]),
    ).toEqual([
      ['Move to Icebox', HELD],
      ['Move to Exploring', HELD],
    ]);
  });
});

describe('startedDependents', () => {
  const base = taskDto({ title: 'base' });
  it.each([
    { name: 'a queued dependent holds it', state: 'QUEUED', held: 'next' },
    { name: 'a running dependent holds it', state: 'RUNNING', held: 'next' },
    { name: 'a dependent waiting on a human holds it', state: 'WAITING_HUMAN', held: 'next' },
    { name: 'a finished dependent does not', state: 'DONE', held: undefined },
    { name: 'a cancelled dependent does not', state: 'CANCELLED', held: undefined },
    { name: 'a failed dependent does not', state: 'FAILED', held: undefined },
    { name: 'a dependent never started does not', state: null, held: undefined },
  ] as const)(
    '$name',
    ({ state, held }: { state: WorkstreamState | null; held: string | undefined }) => {
      const ws = state === null ? null : workstreamDto({ state });
      const next = taskDto({ title: 'next', dependsOn: [base.id], workstreamId: ws?.id ?? null });
      const map = startedDependents([base, next], new Map(ws ? [[ws.id, ws]] : []));
      expect(map.get(base.id)).toBe(held);
    },
  );
});

describe('placeLocally', () => {
  it('gives the task its new order and column, and sorts by board order', () => {
    const placed = placeLocally([ready1, ready2], ready1.id, 5, icebox.id);
    expect(placed.map((t) => [t.title, t.boardColumnId])).toEqual([
      ['ready2', null],
      ['ready1', icebox.id],
    ]);
  });
});

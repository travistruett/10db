import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHECK_IDLE,
  step,
  type CheckQueueEvent,
  type CheckQueueState,
  type CheckStep,
  type TurnAsk,
} from './turn-check-queue';

// Workbench spec §8.1, plan §3.1: a pass has at most one turn check running and one waiting. A turn
// that ends while one waits joins it, since the check reads the folder as it is.

const ask = (): TurnAsk => ({ taskId: mintId('Task'), turnId: mintId('PassTurn') });
const a = ask();
const b = ask();
const c = ask();

const idle = (run: number): CheckQueueState => ({ kind: 'idle', run });
const running = (run: number, turns: TurnAsk[], waiting: TurnAsk[] | null): CheckQueueState => ({
  kind: 'running',
  run,
  turns,
  waiting,
});

describe('the turn check queue of one pass', () => {
  it.each<{
    name: string;
    state: CheckQueueState;
    event: CheckQueueEvent;
    then: CheckStep;
  }>([
    {
      name: 'a Ready turn on an idle pass starts a check of that turn',
      state: CHECK_IDLE,
      event: { kind: 'ready', turn: a, checks: true },
      then: {
        state: running(1, [a], null),
        effects: [{ kind: 'start', run: 1, turns: [a] }],
      },
    },
    {
      name: 'a Ready turn while one runs waits',
      state: running(1, [a], null),
      event: { kind: 'ready', turn: b, checks: true },
      then: { state: running(1, [a], [b]), effects: [] },
    },
    {
      name: 'a Ready turn while one runs and one waits joins the waiting one',
      state: running(1, [a], [b]),
      event: { kind: 'ready', turn: c, checks: true },
      then: { state: running(1, [a], [b, c]), effects: [] },
    },
    {
      name: 'the same turn asked twice waits once',
      state: running(1, [a], [b]),
      event: { kind: 'ready', turn: b, checks: true },
      then: { state: running(1, [a], [b]), effects: [] },
    },
    {
      name: 'a Ready turn of a project with no changed-files check on an idle pass does nothing',
      state: CHECK_IDLE,
      event: { kind: 'ready', turn: a, checks: false },
      then: { state: CHECK_IDLE, effects: [] },
    },
    {
      name: 'a Ready turn of a project with no changed-files check while one runs does nothing',
      state: running(1, [a], null),
      event: { kind: 'ready', turn: b, checks: false },
      then: { state: running(1, [a], null), effects: [] },
    },
    {
      name: 'a Ready turn of a project with no changed-files check while one waits does nothing',
      state: running(1, [a], [b]),
      event: { kind: 'ready', turn: c, checks: false },
      then: { state: running(1, [a], [b]), effects: [] },
    },
    {
      name: 'the run ending, a thrown run too, with none waiting leaves the pass idle',
      state: running(1, [a], null),
      event: { kind: 'ended', run: 1 },
      then: { state: idle(1), effects: [] },
    },
    {
      name: 'the run ending, a thrown run too, with one waiting starts the waiting one',
      state: running(1, [a], [b, c]),
      event: { kind: 'ended', run: 1 },
      then: {
        state: running(2, [b, c], null),
        effects: [{ kind: 'start', run: 2, turns: [b, c] }],
      },
    },
    {
      name: 'a stopped run that ends after a new one started changes nothing',
      state: running(2, [b], null),
      event: { kind: 'ended', run: 1 },
      then: { state: running(2, [b], null), effects: [] },
    },
    {
      name: 'a stopped run that ends on an idle pass changes nothing',
      state: idle(1),
      event: { kind: 'ended', run: 1 },
      then: { state: idle(1), effects: [] },
    },
    {
      name: 'the next Ready turn after a stop starts a run numbered past the stopped one',
      state: idle(1),
      event: { kind: 'ready', turn: b, checks: true },
      then: { state: running(2, [b], null), effects: [{ kind: 'start', run: 2, turns: [b] }] },
    },
    {
      name: 'a stop on an idle pass does nothing',
      state: CHECK_IDLE,
      event: { kind: 'stop' },
      then: { state: CHECK_IDLE, effects: [] },
    },
    {
      name: 'a stop aborts the running check',
      state: running(1, [a], null),
      event: { kind: 'stop' },
      then: { state: idle(1), effects: [{ kind: 'abort', run: 1 }] },
    },
    {
      name: 'a stop aborts the running check and drops the waiting one',
      state: running(1, [a], [b]),
      event: { kind: 'stop' },
      then: { state: idle(1), effects: [{ kind: 'abort', run: 1 }] },
    },
  ])('$name', ({ state, event, then }) => {
    expect(step(state, event)).toEqual(then);
  });

  it('never runs two checks at once and runs every Ready turn, however many end together', () => {
    let state: CheckQueueState = CHECK_IDLE;
    const started: TurnAsk[][] = [];
    const apply = (event: CheckQueueEvent): void => {
      const next = step(state, event);
      state = next.state;
      for (const effect of next.effects) if (effect.kind === 'start') started.push(effect.turns);
    };
    const four = [ask(), ask(), ask(), ask()];
    for (const turn of four) apply({ kind: 'ready', turn, checks: true });
    expect(started).toHaveLength(1);
    apply({ kind: 'ended', run: 1 });
    apply({ kind: 'ended', run: 2 });

    expect(started).toEqual([[four[0]], four.slice(1)]);
    expect(state).toEqual(idle(2));
  });
});

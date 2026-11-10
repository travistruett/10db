import { mintId, ScreenKind, type PassId, type ProjectId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_IDLE,
  captureStep,
  type CaptureEvent,
  type CaptureQueue,
  type CaptureRequest,
} from './capture-queue';

// Workbench spec §10, §12; plan §3.2: one capture at a time per daemon, raced by turns, sign-off,
// take-out, close, Abandon, the app address and the browser's download. Each row is one cell the
// queue decides; the before rule and the write are decided elsewhere.

const project: ProjectId = mintId('Project');
const other: ProjectId = mintId('Project');
const pass: PassId = mintId('Pass');
const a: TaskId = mintId('Task');
const b: TaskId = mintId('Task');
const turn1 = mintId('PassTurn');
const turn2 = mintId('PassTurn');

const req = (
  kind: ScreenKind,
  taskId: TaskId,
  more: Partial<CaptureRequest> = {},
): CaptureRequest => ({
  kind,
  projectId: project,
  passId: pass,
  taskId,
  turnId: kind === ScreenKind.Turn ? turn1 : null,
  ...more,
});

const beforeA = req(ScreenKind.Before, a);
const turnA1 = req(ScreenKind.Turn, a);
const turnA2 = req(ScreenKind.Turn, a, { turnId: turn2 });
const afterA = req(ScreenKind.After, a);
const turnB = req(ScreenKind.Turn, b);
const afterB = req(ScreenKind.After, b);
const folderAfter = req(ScreenKind.After, b, { passId: null, projectId: other });

const ready: CaptureQueue = { ...CAPTURE_IDLE, browser: 'ready' };

function run(start: CaptureQueue, events: readonly CaptureEvent[]) {
  let queue = start;
  const aborted: boolean[] = [];
  const started: (CaptureRequest | null)[] = [];
  for (const event of events) {
    const step = captureStep(queue, event);
    queue = step.queue;
    aborted.push(step.abort);
    started.push(step.started);
  }
  return { queue, aborted: aborted.some(Boolean), started: started.filter((s) => s !== null) };
}

const ask = (request: CaptureRequest): CaptureEvent => ({ kind: 'ask', request });
const START: CaptureEvent = { kind: 'start' };

describe('the capture queue', () => {
  it.each<{
    name: string;
    from?: CaptureQueue;
    events: CaptureEvent[];
    waiting: CaptureRequest[];
    loading?: CaptureRequest | null;
    deferred?: CaptureRequest[];
    aborted?: boolean;
  }>([
    {
      name: 'a newer turn of the same task replaces the waiting one',
      events: [ask(turnA1), ask(turnB), ask(turnA2)],
      waiting: [turnB, turnA2],
    },
    {
      name: 'a newer turn waits while the older one loads',
      events: [ask(turnA1), START, ask(turnA2)],
      waiting: [turnA2],
      loading: turnA1,
    },
    {
      name: 'a second before or after of a task is the same request',
      events: [ask(beforeA), ask(afterA), ask(beforeA), ask(afterA)],
      waiting: [beforeA, afterA],
    },
    {
      name: 'a before or after asked again while it loads is the same request',
      events: [ask(beforeA), START, ask(beforeA)],
      waiting: [],
      loading: beforeA,
    },
    {
      name: 'a before asked again while an aborted load of it ends is a new request',
      events: [ask(beforeA), START, { kind: 'app_changed', projectId: project }, ask(beforeA)],
      waiting: [beforeA],
      loading: beforeA,
      aborted: true,
    },
    {
      name: "the task's next turn drops its waiting turn picture",
      events: [ask(turnA1), ask(turnB), { kind: 'turn_started', taskId: a }],
      waiting: [turnB],
    },
    {
      name: "the task's next turn drops the turn picture it is loading",
      events: [ask(turnA1), START, { kind: 'turn_started', taskId: a }],
      waiting: [],
      loading: turnA1,
      aborted: true,
    },
    {
      name: "the task's next turn leaves a before that loads to the before rule",
      events: [ask(beforeA), START, { kind: 'turn_started', taskId: a }],
      waiting: [],
      loading: beforeA,
      aborted: false,
    },
    {
      name: 'sign-off drops a waiting turn picture and lets a loading one run on',
      events: [ask(turnB), START, ask(turnA1), { kind: 'signing_off', taskId: b }],
      waiting: [turnA1],
      loading: turnB,
      aborted: false,
    },
    {
      name: "a take-out drops the task's requests and aborts its load",
      events: [ask(turnA1), START, ask(afterA), ask(turnB), { kind: 'taken_out', taskId: a }],
      waiting: [turnB],
      loading: turnA1,
      aborted: true,
    },
    {
      name: 'a closing pass drops turns and befores and defers afters',
      events: [
        ask(beforeA),
        ask(afterA),
        ask(turnB),
        ask(folderAfter),
        { kind: 'pass_holding', passId: pass },
      ],
      waiting: [folderAfter],
      deferred: [afterA],
    },
    {
      name: "a closing pass aborts its turn picture's load",
      events: [ask(turnA1), START, { kind: 'pass_holding', passId: pass }],
      waiting: [],
      loading: turnA1,
      aborted: true,
    },
    {
      name: "a closing pass lets an after's load run on",
      events: [ask(afterA), START, { kind: 'pass_holding', passId: pass }],
      waiting: [],
      loading: afterA,
      aborted: false,
    },
    {
      name: 'an after asked while the pass closes waits for the close',
      events: [{ kind: 'pass_holding', passId: pass }, ask(afterB), ask(turnA1), ask(beforeA)],
      waiting: [],
      deferred: [afterB],
    },
    {
      name: 'the pass leaving CLOSING or ABANDONED queues its afters',
      events: [
        { kind: 'pass_holding', passId: pass },
        ask(afterB),
        ask(afterA),
        { kind: 'pass_released', passId: pass },
        ask(turnA1),
      ],
      waiting: [afterB, afterA, turnA1],
      deferred: [],
    },
    {
      name: "a changed app address drops the project's requests and aborts its load",
      events: [
        ask(turnA1),
        START,
        ask(afterA),
        ask(folderAfter),
        { kind: 'app_changed', projectId: project },
      ],
      waiting: [folderAfter],
      loading: turnA1,
      aborted: true,
    },
    {
      name: "a changed app address leaves another project's load",
      events: [ask(folderAfter), START, { kind: 'app_changed', projectId: project }],
      waiting: [],
      loading: folderAfter,
      aborted: false,
    },
    {
      name: 'while the browser downloads, befores wait and turns and afters are dropped',
      from: { ...CAPTURE_IDLE, browser: 'fetching' },
      events: [ask(beforeA), ask(turnB), ask(afterA), START],
      waiting: [beforeA],
      loading: null,
    },
    {
      name: 'a download that starts drops what waits but befores',
      events: [ask(turnB), ask(beforeA), { kind: 'browser', state: 'fetching' }],
      waiting: [beforeA],
    },
    {
      name: 'the befores held for the download start once it is ready',
      from: { ...CAPTURE_IDLE, browser: 'fetching' },
      events: [ask(beforeA), { kind: 'browser', state: 'ready' }, START],
      waiting: [],
      loading: beforeA,
    },
    {
      name: 'a refused browser takes nothing',
      from: { ...CAPTURE_IDLE, browser: 'refused' },
      events: [ask(beforeA), ask(turnA1), START],
      waiting: [],
      loading: null,
    },
    {
      name: 'a browser that is refused drops what waits',
      events: [ask(beforeA), ask(turnB), { kind: 'browser', state: 'refused' }],
      waiting: [],
    },
    {
      name: 'one capture at a time',
      events: [ask(turnA1), ask(turnB), START, START],
      waiting: [turnB],
      loading: turnA1,
    },
    {
      name: 'the next one starts once the load is done',
      events: [ask(turnA1), ask(turnB), START, { kind: 'done' }, START],
      waiting: [],
      loading: turnB,
    },
    {
      name: 'shutdown drops everything and aborts the load',
      events: [
        ask(turnA1),
        START,
        ask(turnB),
        { kind: 'pass_holding', passId: pass },
        ask(afterA),
        { kind: 'shutdown' },
      ],
      waiting: [],
      deferred: [],
      loading: turnA1,
      aborted: true,
    },
  ])('$name', ({ from, events, waiting, loading, deferred, aborted }) => {
    const result = run(from ?? ready, events);
    expect(result.queue.waiting).toEqual(waiting);
    if (loading !== undefined) expect(result.queue.loading).toEqual(loading);
    if (deferred !== undefined) expect(result.queue.deferred).toEqual(deferred);
    if (aborted !== undefined) expect(result.aborted).toBe(aborted);
  });

  it('starts nothing after shutdown', () => {
    const { queue } = run(ready, [{ kind: 'shutdown' }, ask(beforeA), START]);
    expect(queue.loading).toBeNull();
    expect(queue.waiting).toEqual([]);
  });
});

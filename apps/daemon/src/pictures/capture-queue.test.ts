import { PassTurnId, ProjectId, ScreenKind, TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { CAPTURE_IDLE, captureStep, type CaptureEvent, type CaptureQueue } from './capture-queue';

const PROJECT = ProjectId.parse('prj_01a1bcfc-6760-72bb-9bb9-307bec92f4b2');
const DONE = TaskId.parse('tsk_01a211e7-b525-77f9-b4df-15807de63915');
const WAITING = TaskId.parse('tsk_01a211e7-b527-75b7-8105-27cf5cdf4d61');
const TURN = PassTurnId.parse('ptn_01a211e7-b528-7363-8ca4-d77edb3309d8');

const after = (taskId: TaskId) =>
  ({ kind: ScreenKind.After, projectId: PROJECT, passId: null, taskId, turnId: null }) as const;

const run = (queue: CaptureQueue, events: readonly CaptureEvent[]): CaptureQueue =>
  events.reduce((q, event) => captureStep(q, event).queue, queue);

describe('the capture queue while the browser is being fetched', () => {
  it("keeps the afters start-up's catch-up asks and starts them once the browser is ready", () => {
    // A queued after outlives a fetch that begins; start-up asks its catch-up while the fetch runs.
    const queue = run(CAPTURE_IDLE, [
      { kind: 'browser', state: 'ready' },
      { kind: 'ask', request: after(WAITING) },
      { kind: 'browser', state: 'fetching' },
      { kind: 'ask', request: after(DONE) },
      {
        kind: 'ask',
        request: {
          kind: ScreenKind.Turn,
          projectId: PROJECT,
          passId: null,
          taskId: DONE,
          turnId: TURN,
        },
      },
    ]);
    expect(captureStep(queue, { kind: 'start' }).started).toBeNull();
    const ready = run(queue, [{ kind: 'browser', state: 'ready' }]);
    expect(ready.waiting.map((r) => [r.kind, r.taskId])).toEqual([
      [ScreenKind.After, WAITING],
      [ScreenKind.After, DONE],
    ]);
    expect(captureStep(ready, { kind: 'start' }).started).toEqual(after(WAITING));
  });
});

import { TaskStatus } from '@10db/contracts';
import { getTask, insertGoal, insertWorkstream, listShapeQuestions } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { storeQuestionAbout } from '../../test/shape-question';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** Only the task removal runs here, and it reads the state store, so that is the real one. */
function removalServices() {
  // A cast at a test boundary: removing a task touches nothing else of the deps.
  return createServices({ state: h.state } as unknown as Parameters<typeof createServices>[0]);
}

/** A task with a question stored about it, as Convert leaves one. */
function taskWithQuestion() {
  const taskId = h.state.write((ctx) => {
    const made = insertGoal(ctx, h.project.id, {
      brief: {
        title: 'Seats',
        objective: 'Seats.',
        tasks: [
          { key: 'a', title: 'Add seats', areas: h.project.areas.slice(0, 1).map((a) => a.name) },
        ],
      },
    });
    const id = made.taskIds.get('a');
    if (!id) throw new Error('the brief makes one task');
    return id;
  });
  return { taskId, shapeId: storeQuestionAbout(h.state, h.project.id, taskId) };
}

describe('the single-task Remove service', () => {
  it('leaves no question attached to the cancelled task, and keeps it stored', () => {
    const { taskId, shapeId } = taskWithQuestion();
    expect(listShapeQuestions(h.state.db, shapeId)[0]?.taskId).toBe(taskId);

    removalServices().removeTask(taskId);

    expect(getTask(h.state.db, taskId).status).toBe(TaskStatus.Cancelled);
    expect(listShapeQuestions(h.state.db, shapeId)).toMatchObject([
      { key: 'who-pays', taskId: null },
    ]);
  });
});

describe('the Close service', () => {
  it('leaves no question attached to the closed task, and keeps it stored', () => {
    const task = h.addTask('Alpha', { areas: ['api'] });
    const run = h.state.write((ctx) => insertWorkstream(ctx, task.id));
    h.settle(run.id, 'FAILED');
    const shapeId = storeQuestionAbout(h.state, h.project.id, task.id);
    expect(listShapeQuestions(h.state.db, shapeId)[0]?.taskId).toBe(task.id);

    removalServices().closeTask(task.id);

    expect(getTask(h.state.db, task.id).status).toBe(TaskStatus.Cancelled);
    expect(listShapeQuestions(h.state.db, shapeId)).toMatchObject([
      { key: 'who-pays', taskId: null },
    ]);
  });
});

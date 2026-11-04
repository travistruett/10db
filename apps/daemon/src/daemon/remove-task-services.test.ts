import { ShapeOrigin, ShapeProposalKind, ShapeProposalState, TaskStatus } from '@10db/contracts';
import {
  getTask,
  insertGoal,
  insertShape,
  insertShapeProposal,
  insertShapeQuestion,
  listShapeQuestions,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
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
  return h.state.write((ctx) => {
    const made = insertGoal(ctx, h.project.id, {
      brief: {
        title: 'Seats',
        objective: 'Seats.',
        tasks: [
          { key: 'a', title: 'Add seats', areas: h.project.areas.slice(0, 1).map((a) => a.name) },
        ],
      },
    });
    const taskId = made.taskIds.get('a');
    if (!taskId) throw new Error('the brief makes one task');
    const shape = insertShape(ctx, h.project.id, { title: 'Seats', origin: ShapeOrigin.App });
    const proposal = insertShapeProposal(ctx, {
      shapeId: shape.id,
      key: 'who-pays',
      kind: ShapeProposalKind.Question,
      state: ShapeProposalState.Accepted,
      round: 1,
      createdRound: 1,
      pinned: [],
      body: {},
      taskHashes: {},
      sourceMessageIds: [],
    });
    insertShapeQuestion(ctx, {
      shapeId: shape.id,
      proposalId: proposal.id,
      key: 'who-pays',
      text: 'Who pays for the extra seats?',
      forWho: 'finance',
      sourceMessageIds: [],
      taskId,
    });
    return { taskId, shapeId: shape.id };
  });
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

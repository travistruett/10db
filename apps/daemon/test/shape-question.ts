import {
  ShapeOrigin,
  ShapeProposalKind,
  ShapeProposalState,
  type ProjectId,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import { insertShape, insertShapeProposal, insertShapeQuestion } from '@10db/db';
import type { StateStore } from '../src/events';

/** Stores a question about `taskId` in a new shape, as Convert does; returns the shape's id. */
export function storeQuestionAbout(
  state: StateStore,
  projectId: ProjectId,
  taskId: TaskId,
): ShapeId {
  return state.write((ctx) => {
    const shape = insertShape(ctx, projectId, { title: 'Seats', origin: ShapeOrigin.App });
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
    return shape.id;
  });
}

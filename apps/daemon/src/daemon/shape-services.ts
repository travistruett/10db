import { ShapeOrigin, type ShapeConvertedRow } from '@10db/contracts';
import type { ApiServices } from '../api';
import { DEFAULT_SHAPE_TITLE, type ShapeService } from '../shape';

/** Shape's side of the HTTP API: conversations, their messages, Propose, Convert and the two undos. */
export type ShapeApiServices = Pick<
  ApiServices,
  | 'listShapes'
  | 'createShape'
  | 'getShapeView'
  | 'sendShapeMessage'
  | 'proposeShape'
  | 'stopShape'
  | 'convertShape'
  | 'removeDraftGoal'
  | 'withdrawShapeDecision'
>;

export function createShapeServices(deps: { readonly shape: ShapeService }): ShapeApiServices {
  const { shape } = deps;
  return {
    listShapes: (projectId) => shape.list(projectId),
    // A conversation with no title is named by its first message once there is one.
    createShape: (projectId, input) =>
      shape.create(projectId, {
        title: input.title ?? DEFAULT_SHAPE_TITLE,
        origin: ShapeOrigin.App,
      }),
    getShapeView: (id) => shape.view(id),
    sendShapeMessage: (id, text) => shape.send(id, text),
    proposeShape: (id) => shape.propose(id),
    stopShape: (id) => shape.stop(id),
    async convertShape(id, input) {
      const outcome = await shape.convert(
        id,
        input.proposalIds,
        input.interrupt === undefined ? undefined : { interrupt: input.interrupt },
      );
      if (!outcome.ok) return { kind: 'refused', errors: [...outcome.errors] };
      return {
        kind: 'converted',
        result: {
          createdNow: outcome.createdNow,
          results: outcome.results.map((r): ShapeConvertedRow => ({
            ...r,
            taskIds: [...r.taskIds],
          })),
        },
      };
    },
    removeDraftGoal: (goalId) => {
      shape.removeDraftGoal(goalId);
    },
    withdrawShapeDecision: (shapeId, decisionId, reason) => {
      shape.withdrawDecision(shapeId, decisionId, reason);
    },
  };
}

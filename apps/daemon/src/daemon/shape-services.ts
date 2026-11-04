import { ShapeOrigin, type ShapeConvertedRow } from '@10db/contracts';
import {
  findShapeLinkOfGoal,
  findShapeLinkOfTask,
  getProject,
  getShapeJevOptIn,
  questionCardRates,
  setShapeJevOptIn,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { DEFAULT_SHAPE_TITLE, shadowAgreement, sizingMeasure, type ShapeService } from '../shape';

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
  | 'withdrawShapePrinciple'
  | 'resumeShape'
  | 'getGoalShape'
  | 'getTaskShape'
  | 'editShapeProposal'
  | 'unpinShapeProposal'
  | 'restoreShapeProposal'
  | 'dropShapeProposal'
  | 'addShapeFile'
  | 'startShape'
  | 'shapeMeasures'
  | 'getShapeJev'
  | 'setShapeJev'
  | 'getOneWayPaths'
  | 'setOneWayPaths'
  | 'rehearseShape'
  | 'dismissShapeFinding'
>;

export function createShapeServices(deps: {
  readonly shape: ShapeService;
  readonly state: StateStore;
  readonly clock: Clock;
}): ShapeApiServices {
  const { shape, state } = deps;
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
    resumeShape: (id, event) => shape.resume(id, event),
    getGoalShape: (goalId) => ({
      shapeId: findShapeLinkOfGoal(state.db, goalId)?.shapeId ?? null,
    }),
    getTaskShape: (taskId) => ({
      shapeId: findShapeLinkOfTask(state.db, taskId)?.shapeId ?? null,
    }),
    withdrawShapeDecision: (shapeId, decisionId, reason) => {
      shape.withdrawDecision(shapeId, decisionId, reason);
    },
    withdrawShapePrinciple: (shapeId, principleId, reason) => {
      shape.withdrawPrinciple(shapeId, principleId, reason);
    },
    editShapeProposal: (shapeId, id, fields) => {
      shape.editProposal(shapeId, id, fields);
    },
    unpinShapeProposal: (shapeId, id, field) => {
      shape.unpinProposal(shapeId, id, field);
    },
    restoreShapeProposal: (shapeId, id) => {
      shape.restoreProposal(shapeId, id);
    },
    dropShapeProposal: (shapeId, id) => {
      shape.dropProposal(shapeId, id);
    },
    addShapeFile: (shapeId, file) => shape.addFile(shapeId, file),
    startShape: (input) => shape.startFromTerminal(input),
    getOneWayPaths: (projectId) => ({ paths: shape.oneWayPaths(projectId) }),
    setOneWayPaths: (projectId, input) => ({
      paths: shape.setOneWayPaths(projectId, input.paths),
    }),
    rehearseShape: (shapeId, input) => shape.rehearse(shapeId, input.proposalIds),
    dismissShapeFinding: (shapeId, findingId, input) => {
      shape.dismissFinding(shapeId, findingId, input.how);
    },
    shapeMeasures: () => ({
      sizing: sizingMeasure(state.db),
      questions: questionCardRates(state.db),
      shadow: shadowAgreement(state.db, deps.clock.now()),
    }),
    getShapeJev: (projectId) => {
      getProject(state.db, projectId);
      return { enabled: getShapeJevOptIn(state.db, projectId) };
    },
    setShapeJev: (projectId, input) => {
      state.write((ctx) => {
        getProject(ctx.tx, projectId);
        setShapeJevOptIn(ctx, projectId, input.enabled);
      });
      return { enabled: input.enabled };
    },
  };
}

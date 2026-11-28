import {
  DomainError,
  ShapeProposalKind,
  Delivery,
  type ProjectId,
  type ShapeAcceptId,
  type ShapeConvertedRow,
  type ShapeId,
  type ShapeOfDto,
  type ShapeStartOutcome,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  findShapeLinkOfGoal,
  findShapeLinkOfTask,
  getProject,
  getShape,
  chatOfShape,
  getShapeJevOptIn,
  getTask,
  latestWorkstreamOf,
  listAcceptedProposals,
  listShapeLinks,
  questionCardRates,
  setShapeJevOptIn,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { Clock } from '../clock';
import { unfinishedDependencies } from '../delivery';
import type { Logger } from '../log';
import type { StateStore } from '../events';
import {
  shadowAgreement,
  sizingMeasure,
  START_CAP,
  startCounts,
  type ShapeService,
} from '../shape';
import { watchpointReadRow } from '../watchpoints';

/** Shape's side of the HTTP API: conversations, their messages, Propose, Convert and the two undos. */
export type ShapeApiServices = Pick<
  ApiServices,
  | 'listShapes'
  | 'getShapeView'
  | 'chooseShapeModel'
  | 'convertShape'
  | 'shapeStartCounts'
  | 'removeDraftGoal'
  | 'undoShapeAccept'
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
  | 'reviewShape'
  | 'designReviewShape'
  | 'approveShapeAttachment'
  | 'figmaShapeAttachment'
  | 'openFigmaFrame'
  | 'dismissShapeFinding'
>;

export function createShapeServices(deps: {
  readonly shape: ShapeService;
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  /** Starts the tasks through the starter Start Ready Tasks uses, after sizing settles. */
  readonly startTasks: (
    projectId: ProjectId,
    title: string,
    taskIds: readonly TaskId[],
  ) => Promise<void>;
}): ShapeApiServices {
  const { shape, state, log } = deps;

  /**
   * Starts what the Accept made and is ready: the same rule as the confirm's counts, over the made
   * tasks as they stand. Every error after the Accept committed becomes `refused`, since the Accept stands.
   */
  const startAccepted = async (
    shapeId: ShapeId,
    acceptId: ShapeAcceptId | null,
  ): Promise<ShapeStartOutcome> => {
    if (acceptId === null) return { started: [], left: [], refused: null };
    try {
      const proposals = listAcceptedProposals(state.db, acceptId).filter(
        (p) => p.kind === ShapeProposalKind.Goal || p.kind === ShapeProposalKind.Task,
      );
      const ofAccept = new Set(proposals.map((p) => p.id));
      const madeIds = [
        ...new Set(
          listShapeLinks(state.db, shapeId).flatMap((l) =>
            l.taskId !== null && ofAccept.has(l.proposalId) ? [l.taskId] : [],
          ),
        ),
      ];
      const made: TaskDto[] = madeIds.map((id) => getTask(state.db, id));
      const byId = new Map<string, TaskDto>(made.map((t) => [t.id, t]));
      const outside = new Map(
        unfinishedDependencies(state.db, made, new Set(madeIds)).map((b) => [
          b.task.id,
          b.deps.map((d) => d.title),
        ]),
      );
      const counts = startCounts({
        tasks: made.map((t) => ({
          key: t.id,
          title: t.title,
          place: t.workspaceMode,
          waitsOnStart: t.dependsOn.filter((id) => byId.has(id)),
          waitsOutside: outside.get(t.id) ?? [],
        })),
        startsAtOnce: new Set(),
        local:
          getProject(state.db, getShape(state.db, shapeId).projectId).delivery !==
          Delivery.PullRequest,
        cap: START_CAP,
      });
      const startIds = counts.startKeys.flatMap((key) => {
        const task = byId.get(key);
        return task === undefined ? [] : [task.id];
      });
      const left = counts.leftKeys.flatMap(({ key, why }) => {
        const task = byId.get(key);
        return task === undefined ? [] : [{ taskId: task.id, title: task.title, why }];
      });
      let refused: string | null = null;
      if (startIds.length > 0) {
        const shapeRow = getShape(state.db, shapeId);
        try {
          await deps.startTasks(shapeRow.projectId, shapeRow.title, startIds);
        } catch (error) {
          refused =
            error instanceof DomainError
              ? error.message
              : "The start failed; the daemon's log says why";
          log.warn({ err: error, shapeId, taskIds: startIds }, 'Accept and Start could not start');
        }
      }
      return {
        started: startIds.filter((id) => latestWorkstreamOf(state.db, id) !== undefined),
        left,
        refused,
      };
    } catch (error) {
      log.warn({ err: error, shapeId, acceptId }, 'Accept and Start could not start');
      return {
        started: [],
        left: [],
        refused:
          error instanceof DomainError
            ? error.message
            : "The start failed; the daemon's log says why",
      };
    }
  };
  const shapeOf = (shapeId: ShapeId | undefined): ShapeOfDto =>
    shapeId === undefined
      ? { shapeId: null, title: null, chatId: null }
      : {
          shapeId,
          title: getShape(state.db, shapeId).title,
          chatId: chatOfShape(state.db, shapeId),
        };
  return {
    listShapes: (projectId) => shape.list(projectId),
    getShapeView: (id) => shape.view(id),
    chooseShapeModel: (id, model, effort) => shape.chooseModel(id, model, effort),
    async convertShape(id, input) {
      const outcome = await shape.convert(id, input.proposalIds, {
        ...(input.cut === undefined ? {} : { cut: input.cut }),
      });
      if (!outcome.ok) return { kind: 'refused', errors: [...outcome.errors] };
      const start = input.start === true ? await startAccepted(id, outcome.acceptId) : undefined;
      return {
        kind: 'converted',
        result: {
          createdNow: outcome.createdNow,
          results: outcome.results.map((r): ShapeConvertedRow => ({
            ...r,
            taskIds: [...r.taskIds],
          })),
          ...(start === undefined ? {} : { start }),
        },
      };
    },
    removeDraftGoal: (goalId) => {
      shape.removeDraftGoal(goalId);
    },
    shapeStartCounts: (shapeId, proposalIds) => shape.startCounts(shapeId, proposalIds),
    undoShapeAccept: (shapeId, acceptId) => shape.undoAccept(shapeId, acceptId),
    resumeShape: (id, event) => shape.resume(id, event),
    getGoalShape: (goalId) => shapeOf(findShapeLinkOfGoal(state.db, goalId)?.shapeId),
    getTaskShape: (taskId) => shapeOf(findShapeLinkOfTask(state.db, taskId)?.shapeId),
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
    reviewShape: (shapeId, input) => shape.review(shapeId, input.proposalIds),
    designReviewShape: (shapeId, input) => shape.designReview(shapeId, input.proposalIds),
    approveShapeAttachment: (shapeId, attachmentId, input) => {
      shape.approveAttachment(shapeId, attachmentId, input.approved);
    },
    figmaShapeAttachment: (shapeId, attachmentId, input) =>
      shape.figma(shapeId, attachmentId, input),
    openFigmaFrame: (shapeId, attachmentId) => shape.openFigmaFrame(shapeId, attachmentId),
    dismissShapeFinding: (shapeId, findingId, input) => {
      shape.dismissFinding(shapeId, findingId, input.how);
    },
    shapeMeasures: () => ({
      sizing: sizingMeasure(state.db),
      questions: questionCardRates(state.db),
      shadow: [
        ...shadowAgreement(state.db, deps.clock.now()),
        watchpointReadRow(state.db, deps.clock.now()),
      ],
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

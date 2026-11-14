import {
  BoardStatus,
  BUILDER_MCP_VIA,
  BuilderToolInputs,
  BuilderToolName,
  DecisionEdit,
  DecisionId,
  DecisionWrite,
  DomainError,
  InboxState,
  KnowledgeListQuery,
  KnowledgeReason,
  KnowledgeSource,
  NEW_TASK_NO_CRITERIA,
  newTaskRefusal,
  normaliseCriteria,
  PrincipleEdit,
  PrincipleId,
  PrincipleWrite,
  ProposalListQuery,
  SearchMatch,
  TaskInput,
  TaskKindSource,
  TaskMove,
  TaskPatch,
  TaskStatus,
  WorkstreamState,
  type TaskDto,
} from '@10db/contracts';
import type { ApiServices, TaskLookupServices, TaskRemovalServices } from '../api';

/** What the builder's tools need from the daemon: the pieces of the API they drive. */
export type BuilderServices = Pick<
  ApiServices,
  | 'listProjects'
  | 'listKinds'
  | 'listTasks'
  | 'createTask'
  | 'patchTask'
  | 'startTask'
  | 'settleSizing'
  | 'moveTask'
  | 'runNext'
  | 'listBoardColumns'
  | 'listInbox'
  | 'startShape'
  | 'importPlan'
  | 'listKnowledge'
  | 'recordDecision'
  | 'supersedeDecision'
  | 'withdrawDecision'
  | 'createPrinciple'
  | 'supersedePrinciple'
  | 'retirePrinciple'
  | 'withdrawPrinciple'
  | 'listProposals'
> &
  TaskRemovalServices &
  TaskLookupServices;

function taskSummary(task: TaskDto) {
  return { id: task.id, title: task.title, boardStatus: task.boardStatus };
}

/**
 * The builder source every knowledge write here carries. The server is stateless and sees no
 * client session, so the tool and the builder's own words are all it can say.
 */
function builderSource(quote: string | undefined): KnowledgeSource {
  return KnowledgeSource.parse({ via: BUILDER_MCP_VIA, ...(quote === undefined ? {} : { quote }) });
}

/** Whether an id names a decision; the input schema has already refused any other than a principle's. */
const isDecision = (id: string): boolean => DecisionId.safeParse(id).success;

/** The fields given, with the absent ones left out rather than undefined, as the API's schemas expect. */
function defined(args: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** Every handler takes a tool's raw arguments, parses them and answers the JSON the client reads. */
export function createBuilderTools(
  services: BuilderServices,
): Record<BuilderToolName, (args: unknown) => unknown> {
  /** The state of an open task's latest run, read as that one row; null when it has no run. */
  const latestRunState = (task: TaskDto): WorkstreamState | null =>
    task.workstreamId !== null && task.status === TaskStatus.Open
      ? services.getWorkstream(task.workstreamId).state
      : null;
  /** Whether the task is open, on the Board and not parked, and its latest run is set aside. */
  const isHeld = (task: TaskDto): boolean =>
    task.boardColumnId === null && latestRunState(task) === WorkstreamState.Held;
  /** Whether the task is open and on the Board, and its latest run failed. */
  const hasFailedRun = (task: TaskDto): boolean =>
    task.boardColumnId === null && latestRunState(task) === WorkstreamState.Failed;
  return {
    [BuilderToolName.ListProjects]: (args) => {
      BuilderToolInputs.list_projects.parse(args);
      return services.listProjects().map((project) => ({
        id: project.id,
        name: project.name,
        areas: project.areas.map((area) => ({
          name: area.name,
          globs: area.globs,
          ...(area.catchAll === true ? { catchAll: true } : {}),
          ...(area.role === undefined ? {} : { role: area.role }),
          ...(area.route === undefined ? {} : { route: area.route }),
        })),
        hazards: project.hazards.map((hazard) => ({ name: hazard.name, globs: hazard.globs })),
        isolate: project.isolate,
        columns: services
          .listBoardColumns(project.id)
          .map((column) => ({ id: column.id, name: column.name })),
        defaultRigor: project.defaultRigor,
        delivery: project.delivery,
      }));
    },
    [BuilderToolName.ListKinds]: (args) => {
      BuilderToolInputs.list_kinds.parse(args);
      return services.listKinds().map((kind) => ({
        key: kind.key,
        label: kind.label,
        description: kind.description,
        minimumRigor: kind.minimumRigor,
        alwaysReviewed: kind.alwaysReviewed,
        failsAtLimit: kind.failsAtLimit,
        ownCopy: kind.ownCopy,
        toInbox: kind.toInbox,
      }));
    },
    // Finished tasks keep their full text; after a few days of filing they would flood the client.
    [BuilderToolName.ListTasks]: (args) =>
      services
        .listTasks(BuilderToolInputs.list_tasks.parse(args).projectId)
        .filter((task) => task.status === TaskStatus.Open)
        .map((task) => ({
          id: task.id,
          title: task.title,
          headline: task.headline,
          why: task.why,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          areas: task.areas,
          rigor: task.rigor,
          effectiveRigor: task.effectiveRigor,
          kinds: task.kinds.map((kind) => kind.key),
          dependsOn: task.dependsOn,
          boardStatus: task.boardStatus,
          boardColumnId: task.boardColumnId,
        })),
    [BuilderToolName.CreateTask]: async (args) => {
      const { projectId, kinds: named, ...loose } = BuilderToolInputs.create_task.parse(args);
      const trimmed = {
        ...loose,
        // The agent names kinds by key; who set them is 10db's to record. Keys no kind has are refused.
        kinds: named.map(({ key }) => ({ key, source: TaskKindSource.Builder })),
        title: loose.title.trim(),
        headline: loose.headline.trim(),
        why: loose.why.trim(),
        description: loose.description.trim(),
        acceptanceCriteria: normaliseCriteria(loose.acceptanceCriteria),
      };
      const refusal = newTaskRefusal(trimmed);
      if (refusal !== null) throw new DomainError('invalid', refusal);
      return taskSummary(await services.createTask(projectId, TaskInput.parse(trimmed)));
    },
    [BuilderToolName.EditTask]: async (args) => {
      const { taskId, kinds: named, ...changes } = BuilderToolInputs.edit_task.parse(args);
      const patch: Record<string, unknown> = { ...changes };
      if (named !== undefined) {
        // A kind the task already had keeps who set it, so an agent's edit never takes a pin from the builder.
        const held = services.getTask(taskId).kinds;
        patch['kinds'] = named.map(
          ({ key }) =>
            held.find((kind) => kind.key === key) ?? { key, source: TaskKindSource.Builder },
        );
      }
      if (changes.title !== undefined) patch['title'] = changes.title.trim();
      if (changes.headline !== undefined) patch['headline'] = changes.headline.trim();
      if (changes.why !== undefined) patch['why'] = changes.why.trim();
      if (changes.description !== undefined) patch['description'] = changes.description.trim();
      if (changes.acceptanceCriteria !== undefined) {
        const criteria = normaliseCriteria(changes.acceptanceCriteria);
        if (criteria.length === 0) throw new DomainError('invalid', NEW_TASK_NO_CRITERIA);
        patch['acceptanceCriteria'] = criteria;
      }
      return taskSummary(await services.patchTask(taskId, TaskPatch.parse(patch)));
    },
    [BuilderToolName.RemoveTask]: (args) =>
      taskSummary(services.removeTask(BuilderToolInputs.remove_task.parse(args).taskId)),
    [BuilderToolName.StartTask]: async (args) => {
      const { taskId, fresh } = BuilderToolInputs.start_task.parse(args);
      // Before any read, so two quick starts of one task run their checks one after the other.
      await services.settleSizing([taskId]);
      // The API starts any open task; an agent filing tasks must not jump one past its dependencies.
      const task = services.getTask(taskId);
      // A held task already started once: the Board's Start queues its run again, so this does too.
      const held = isHeld(task);
      // Starting over is the one start a failed task gets here. Its dependencies are checked below,
      // before anything is abandoned: local delivery starts the task with no checks of its own.
      const startingOver = fresh === true && hasFailedRun(task);
      if (!held && !startingOver && task.boardStatus !== BoardStatus.Ready) {
        // A parked task is Blocked too, whatever its run: say so rather than call it not ready.
        if (task.boardColumnId !== null && latestRunState(task) === WorkstreamState.Held) {
          throw new DomainError(
            'conflict',
            `Task ${task.title} is parked and its run is held, so it can't be started until it is moved back to the Board`,
          );
        }
        throw new DomainError(
          'conflict',
          `Task ${task.title} is ${task.boardStatus.replace('_', ' ')}, not ready, so it can't be started`,
        );
      }
      if (held || startingOver) {
        // A held or failed task is Blocked whatever it waits on, so its dependencies are checked here.
        const waitingOn = task.dependsOn
          .map((id) => services.getTask(id))
          .filter(
            (dep) =>
              dep.status !== TaskStatus.Done &&
              (dep.status === TaskStatus.Cancelled || dep.boardStatus !== BoardStatus.Done),
          );
        if (waitingOn.length > 0) {
          throw new DomainError(
            'conflict',
            `Task ${task.title} waits on ${waitingOn.map((dep) => dep.title).join(', ')}, so it can't be started`,
          );
        }
      }
      const started = services.startTask(taskId, fresh === undefined ? {} : { fresh });
      return started.kind === 'workstream'
        ? { taskId, workstreamId: started.workstream.id }
        : { taskId, batchId: started.batch.id };
    },
    [BuilderToolName.MoveTask]: (args) => {
      const { taskId, to, after, before } = BuilderToolInputs.move_task.parse(args);
      const moved = services.moveTask(taskId, TaskMove.parse({ to, after, before }));
      return { ...taskSummary(moved), boardColumnId: moved.boardColumnId };
    },
    // The Board's Run Next, through the same service as POST /tasks/:taskId/run-next.
    [BuilderToolName.RunNext]: (args) => {
      const { taskId } = BuilderToolInputs.run_next.parse(args);
      const { workstream, waitingOn } = services.runNext(taskId);
      return { taskId, workstreamId: workstream.id, state: workstream.state, waitingOn };
    },
    // A brainstorm from a terminal session moves into Shape (spec §5.6): the summary is the builder's
    // first message and the files are inline text. It starts no turn; the app lists the conversation.
    [BuilderToolName.StartShape]: (args) => {
      const shape = services.startShape(BuilderToolInputs.start_shape.parse(args));
      return { id: shape.id, title: shape.title };
    },
    // A planning effort hands over through the same service as POST /projects/:id/plans/import,
    // and answers what the route answers.
    [BuilderToolName.ImportPlan]: async (args) => {
      const { projectId, bundlePath, dryRun } = BuilderToolInputs.import_plan.parse(args);
      const outcome = await services.importPlan(projectId, { bundlePath, dryRun });
      switch (outcome.kind) {
        case 'imported':
          return outcome.result;
        case 'previewed':
          return outcome.preview;
        case 'refused':
          return { errors: outcome.errors };
      }
    },
    // Card text is written by managed sessions (an ask_human question becomes the title), so the
    // builder's clients get the title alone: no body, options or detail to act on.
    [BuilderToolName.ListInbox]: (args) => {
      BuilderToolInputs.list_inbox.parse(args);
      return services.listInbox({ states: [InboxState.Open], recent: null }).map((card) => ({
        id: card.id,
        kind: card.kind,
        projectId: card.projectId,
        title: card.title,
        createdAt: card.createdAt,
      }));
    },
    // Knowledge: the same services as the knowledge routes, parsed by the same schemas, so a
    // refusal is the API's. The builder's MCP server and the quote are the source of every write.
    [BuilderToolName.SearchKnowledge]: (args) => {
      const { projectId, ...query } = BuilderToolInputs.search_knowledge.parse(args);
      return services.listKnowledge(
        projectId,
        // Its text comes from Claude, often a whole question, not from someone typing in the view.
        KnowledgeListQuery.parse({ ...defined(query), match: SearchMatch.AnyWord }),
      );
    },
    [BuilderToolName.SaveDecision]: (args) => {
      const { projectId, quote, ...fields } = BuilderToolInputs.save_decision.parse(args);
      return services.recordDecision(
        projectId,
        DecisionWrite.parse({ ...fields, source: builderSource(quote) }),
      );
    },
    [BuilderToolName.SavePrinciple]: (args) => {
      const { projectId, quote, ...fields } = BuilderToolInputs.save_principle.parse(args);
      return services.createPrinciple(
        projectId,
        PrincipleWrite.parse({ ...fields, source: builderSource(quote) }),
      );
    },
    [BuilderToolName.SupersedeKnowledge]: (args) => {
      const { id, quote, ...fields } = BuilderToolInputs.supersede_knowledge.parse(args);
      const edit = { ...defined(fields), source: builderSource(quote) };
      return isDecision(id)
        ? services.supersedeDecision(DecisionId.parse(id), DecisionEdit.parse(edit))
        : services.supersedePrinciple(PrincipleId.parse(id), PrincipleEdit.parse(edit));
    },
    [BuilderToolName.RetireKnowledge]: (args) => {
      const { id, reason, quote } = BuilderToolInputs.retire_knowledge.parse(args);
      if (isDecision(id)) {
        throw new DomainError(
          'invalid',
          'id: Only a principle can be retired; supersede a decision to change it, or withdraw it if it was a mistake',
        );
      }
      return services.retirePrinciple(
        PrincipleId.parse(id),
        KnowledgeReason.parse({ reason, source: builderSource(quote) }),
      );
    },
    [BuilderToolName.WithdrawKnowledge]: (args) => {
      const { id, reason, quote } = BuilderToolInputs.withdraw_knowledge.parse(args);
      const body = KnowledgeReason.parse({ reason, source: builderSource(quote) });
      return isDecision(id)
        ? services.withdrawDecision(DecisionId.parse(id), body)
        : services.withdrawPrinciple(PrincipleId.parse(id), body);
    },
    // A proposal's text is written by a managed session, so the builder's clients get the proposed
    // rule and its title, not the card body.
    [BuilderToolName.ListProposals]: (args) => {
      const { projectId, status } = BuilderToolInputs.list_proposals.parse(args);
      return services
        .listProposals(projectId, ProposalListQuery.parse(status === undefined ? {} : { status }))
        .map((proposal) => ({
          id: proposal.id,
          status: proposal.status,
          title: proposal.title,
          rationale: proposal.rationale,
          principle:
            proposal.principle === null
              ? null
              : {
                  id: proposal.principle.id,
                  scope: proposal.principle.scope,
                  area: proposal.principle.area,
                  statement: proposal.principle.statement,
                  kind: proposal.principle.kind,
                  topicKey: proposal.principle.topicKey,
                },
          createdAt: proposal.createdAt,
        }));
    },
  };
}

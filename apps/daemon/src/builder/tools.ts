import {
  BoardStatus,
  BuilderToolInputs,
  BuilderToolName,
  DomainError,
  InboxState,
  NEW_TASK_NO_CRITERIA,
  newTaskRefusal,
  normaliseCriteria,
  TaskInput,
  TaskMove,
  TaskPatch,
  TaskStatus,
  type TaskDto,
} from '@10db/contracts';
import type { ApiServices, TaskLookupServices, TaskRemovalServices } from '../api';

/** What the builder's tools need from the daemon: the pieces of the API they drive. */
export type BuilderServices = Pick<
  ApiServices,
  | 'listProjects'
  | 'listFlows'
  | 'listTasks'
  | 'createTask'
  | 'patchTask'
  | 'startTask'
  | 'moveTask'
  | 'listBoardColumns'
  | 'listInbox'
> &
  TaskRemovalServices &
  TaskLookupServices;

function taskSummary(task: TaskDto) {
  return { id: task.id, title: task.title, boardStatus: task.boardStatus };
}

/** Every handler takes a tool's raw arguments, parses them and answers the JSON the client reads. */
export function createBuilderTools(
  services: BuilderServices,
): Record<BuilderToolName, (args: unknown) => unknown> {
  return {
    [BuilderToolName.ListProjects]: (args) => {
      BuilderToolInputs.list_projects.parse(args);
      return services.listProjects().map((project) => ({
        id: project.id,
        name: project.name,
        areas: project.areas.map((area) => ({ name: area.name, globs: area.globs })),
        hazards: project.hazards.map((hazard) => ({ name: hazard.name, globs: hazard.globs })),
        columns: services
          .listBoardColumns(project.id)
          .map((column) => ({ id: column.id, name: column.name })),
        flowId: project.flowId,
        delivery: project.delivery,
      }));
    },
    [BuilderToolName.ListFlows]: (args) => {
      BuilderToolInputs.list_flows.parse(args);
      return services.listFlows().map((flow) => ({
        id: flow.id,
        name: flow.name,
        steps: flow.steps.map((step) => step.role),
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
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          areas: task.areas,
          riskTags: task.riskTags,
          flowId: task.flowId,
          dependsOn: task.dependsOn,
          boardStatus: task.boardStatus,
          boardColumnId: task.boardColumnId,
        })),
    [BuilderToolName.CreateTask]: (args) => {
      const { projectId, ...loose } = BuilderToolInputs.create_task.parse(args);
      const trimmed = {
        ...loose,
        title: loose.title.trim(),
        description: loose.description.trim(),
        acceptanceCriteria: normaliseCriteria(loose.acceptanceCriteria),
      };
      const refusal = newTaskRefusal(trimmed);
      if (refusal !== null) throw new DomainError('invalid', refusal);
      return taskSummary(services.createTask(projectId, TaskInput.parse(trimmed)));
    },
    [BuilderToolName.EditTask]: (args) => {
      const { taskId, ...changes } = BuilderToolInputs.edit_task.parse(args);
      const patch: Record<string, unknown> = { ...changes };
      if (changes.title !== undefined) patch['title'] = changes.title.trim();
      if (changes.description !== undefined) patch['description'] = changes.description.trim();
      if (changes.acceptanceCriteria !== undefined) {
        const criteria = normaliseCriteria(changes.acceptanceCriteria);
        if (criteria.length === 0) throw new DomainError('invalid', NEW_TASK_NO_CRITERIA);
        patch['acceptanceCriteria'] = criteria;
      }
      return taskSummary(services.patchTask(taskId, TaskPatch.parse(patch)));
    },
    [BuilderToolName.RemoveTask]: (args) =>
      taskSummary(services.removeTask(BuilderToolInputs.remove_task.parse(args).taskId)),
    [BuilderToolName.StartTask]: (args) => {
      const { taskId } = BuilderToolInputs.start_task.parse(args);
      // The API starts any open task; an agent filing tasks must not jump one past its dependencies.
      const task = services.getTask(taskId);
      if (task.boardStatus !== BoardStatus.Ready) {
        throw new DomainError(
          'conflict',
          `Task ${task.title} is ${task.boardStatus.replace('_', ' ')}, not ready, so it can't be started`,
        );
      }
      const started = services.startTask(taskId);
      return started.kind === 'workstream'
        ? { taskId, workstreamId: started.workstream.id }
        : { taskId, batchId: started.batch.id };
    },
    [BuilderToolName.MoveTask]: (args) => {
      const { taskId, to, after, before } = BuilderToolInputs.move_task.parse(args);
      const moved = services.moveTask(taskId, TaskMove.parse({ to, after, before }));
      return { ...taskSummary(moved), boardColumnId: moved.boardColumnId };
    },
    // Card text is written by managed sessions (an ask_human question becomes the title), so the
    // builder's clients get the title alone: no body, options or detail to act on.
    [BuilderToolName.ListInbox]: (args) => {
      BuilderToolInputs.list_inbox.parse(args);
      return services.listInbox({ states: [InboxState.Open] }).map((card) => ({
        id: card.id,
        kind: card.kind,
        projectId: card.projectId,
        title: card.title,
        createdAt: card.createdAt,
      }));
    },
  };
}

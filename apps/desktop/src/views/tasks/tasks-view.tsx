import { BoardStatus, ProjectId, TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import { useProjects, useStartTask, useTasks, useWorkstreams } from '../../daemon/queries';
import { StateBadge } from '../factory/state-badge';
import { formatAreas } from './areas-text';
import { BoardStatusBadge } from './board-status-badge';
import { NewProjectForm } from './new-project-form';
import { NewTaskForm } from './new-task-form';
import { ProjectPicker } from './project-picker';

const STARTABLE: readonly BoardStatus[] = [BoardStatus.Ready, BoardStatus.Backlog];

/** A task whose latest workstream ended without finishing can run again. */
const RESTARTABLE: readonly WorkstreamState[] = [WorkstreamState.Failed, WorkstreamState.Cancelled];

function canStart(task: TaskDto, latest: WorkstreamState | undefined): boolean {
  if (task.status !== TaskStatus.Open || !STARTABLE.includes(task.boardStatus)) return false;
  return task.workstreamId === null || (latest !== undefined && RESTARTABLE.includes(latest));
}

/** The remembered project id comes from storage, so it is validated before it is trusted. */
function deserializeProjectId(value: string | undefined): ProjectId | null {
  try {
    if (value === undefined) return null;
    const parsed = ProjectId.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function TasksView() {
  const projects = useProjects();
  const [storedId, setStoredId] = useLocalStorage<ProjectId | null>({
    key: 'tendb.project',
    defaultValue: null,
    getInitialValueInEffect: false,
    deserialize: deserializeProjectId,
  });
  const list = projects.data ?? [];
  // A remembered project that no longer exists falls back to the first one.
  const project = list.find((p) => p.id === storedId) ?? list[0] ?? null;
  const tasks = useTasks(project?.id ?? null);
  const workstreams = useWorkstreams({ active: false });
  const start = useStartTask();
  const [projectOpen, projectModal] = useDisclosure(false);
  const [taskOpen, taskModal] = useDisclosure(false);

  const stateOf = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws.state]));
  const taskList = tasks.data ?? [];

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Tasks</Title>
        <Group align="flex-end">
          {project ? (
            <ProjectPicker
              value={project.id}
              onChange={(id) => {
                setStoredId(id);
              }}
            />
          ) : null}
          <Button variant="default" size="sm" onClick={projectModal.open}>
            New project
          </Button>
          {project ? (
            <Button size="sm" onClick={taskModal.open}>
              New task
            </Button>
          ) : null}
        </Group>
      </Group>

      {projects.isError ? (
        <Alert color="red" title="Couldn't load the projects">
          {projects.error.message}
        </Alert>
      ) : null}
      {tasks.isError ? (
        <Alert color="red" title="Couldn't load the tasks">
          {tasks.error.message}
        </Alert>
      ) : null}
      {workstreams.isError ? (
        <Alert color="red" title="Couldn't load the workstreams">
          {workstreams.error.message}
        </Alert>
      ) : null}
      {projects.isPending ? <Loader size="sm" aria-label="Loading projects" /> : null}
      {projects.isSuccess && !project ? (
        <Text c="dimmed">No projects yet. Create one to start.</Text>
      ) : null}
      {project ? (
        <Text size="sm" c="dimmed" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
          {project.repoPath} · gate: {project.gateCommand}
          {'\n'}
          {formatAreas(project.areas)}
        </Text>
      ) : null}
      {start.error ? (
        <Alert color="red" title="Couldn't start the task">
          {start.error.message}
        </Alert>
      ) : null}

      {project && tasks.isSuccess && taskList.length === 0 ? (
        <Text c="dimmed">No tasks yet.</Text>
      ) : null}
      {taskList.length > 0 ? (
        <Table highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Areas</Table.Th>
              <Table.Th>Workstream</Table.Th>
              <Table.Th>
                <VisuallyHidden>Actions</VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {taskList.map((task) => {
              const state = task.workstreamId ? stateOf.get(task.workstreamId) : undefined;
              return (
                <Table.Tr key={task.id}>
                  <Table.Td>{task.title}</Table.Td>
                  <Table.Td>
                    <BoardStatusBadge status={task.boardStatus} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {task.areas.join(', ')}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {state ? <StateBadge state={state} /> : <Text size="sm">—</Text>}
                  </Table.Td>
                  <Table.Td>
                    {canStart(task, state) ? (
                      <Button
                        size="xs"
                        variant="light"
                        loading={start.isPending && start.variables === task.id}
                        onClick={() => {
                          start.mutate(task.id);
                        }}
                      >
                        Start
                      </Button>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      ) : null}

      <Modal opened={projectOpen} onClose={projectModal.close} title="New project" size="lg">
        <NewProjectForm
          onCreated={(created) => {
            setStoredId(created.id);
            projectModal.close();
          }}
        />
      </Modal>
      {project ? (
        <Modal opened={taskOpen} onClose={taskModal.close} title="New task" size="lg">
          <NewTaskForm
            key={project.id}
            project={project}
            tasks={taskList}
            onCreated={taskModal.close}
          />
        </Modal>
      ) : null}
    </Stack>
  );
}

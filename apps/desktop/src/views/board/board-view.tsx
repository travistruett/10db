import { BoardStatus, WorkstreamState } from '@10db/contracts';
import { Alert, Button, Group, Loader, Modal, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import { useBoardColumns, useStartTask, useTasks, useWorkstreams } from '../../daemon/queries';
import { ProjectPicker } from '../../shell/project-picker';
import { useSelectedProject } from '../../shell/selected-project';
import { formatAreas } from './areas-text';
import { BoardColumn } from './board-column';
import { boardLayout, columnKeyId, DONE_LIMIT } from './board-layout';
import { NewProjectForm } from './new-project-form';
import { NewTaskForm } from './new-task-form';
import { TaskCard } from './task-card';
import { TaskCardMenu } from './task-card-menu';

/** A finished workstream isn't repeated on its card; the task's column already says so. */
const SHOWN_STATES: readonly WorkstreamState[] = Object.values(WorkstreamState).filter(
  (s) => s !== WorkstreamState.Done && s !== WorkstreamState.Cancelled,
);

export function BoardView() {
  const { projects, project, select } = useSelectedProject();
  const tasks = useTasks(project?.id ?? null);
  const columns = useBoardColumns(project?.id ?? null);
  const workstreams = useWorkstreams({ active: false });
  const start = useStartTask();
  const [projectOpen, projectModal] = useDisclosure(false);
  const [taskOpen, taskModal] = useDisclosure(false);
  const [showAllDone, setShowAllDone] = useState(false);

  const taskList = tasks.data ?? [];
  const layout = boardLayout(columns.data ?? [], taskList);
  const workstreamById = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws]));
  const peers = new Map(taskList.map((t) => [t.id, t]));

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Board</Title>
        <Group align="flex-end">
          {project ? (
            <ProjectPicker
              value={project.id}
              onChange={(id) => {
                select(id);
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
      {columns.isError ? (
        <Alert color="red" title="Couldn't load the board columns">
          {columns.error.message}
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
      {project && tasks.isSuccess ? (
        <ScrollArea type="auto" offsetScrollbars>
          <Group align="flex-start" wrap="nowrap" gap="sm">
            {layout.map((column) => {
              const isDone = column.key.kind === 'system' && column.key.status === BoardStatus.Done;
              const shown =
                isDone && !showAllDone ? column.tasks.slice(0, DONE_LIMIT) : column.tasks;
              return (
                <BoardColumn
                  key={columnKeyId(column.key)}
                  label={column.label}
                  count={column.tasks.length}
                  locked={column.key.kind === 'system'}
                  footer={
                    shown.length < column.tasks.length ? (
                      <Button
                        variant="subtle"
                        size="xs"
                        onClick={() => {
                          setShowAllDone(true);
                        }}
                      >
                        {`Show all ${String(column.tasks.length)}`}
                      </Button>
                    ) : null
                  }
                >
                  {shown.map((task) => {
                    const ws = task.workstreamId
                      ? workstreamById.get(task.workstreamId)
                      : undefined;
                    return (
                      <li key={task.id} aria-label={task.title}>
                        <TaskCard
                          task={task}
                          workstream={ws && SHOWN_STATES.includes(ws.state) ? ws : undefined}
                          peers={peers}
                          menu={
                            <TaskCardMenu
                              task={task}
                              latest={ws?.state}
                              onStart={() => {
                                start.mutate(task.id);
                              }}
                            />
                          }
                        />
                      </li>
                    );
                  })}
                </BoardColumn>
              );
            })}
          </Group>
        </ScrollArea>
      ) : null}

      <Modal opened={projectOpen} onClose={projectModal.close} title="New project" size="lg">
        <NewProjectForm
          onCreated={(created) => {
            select(created.id);
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

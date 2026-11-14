import {
  BoardStatus,
  BuilderToolName,
  mintId,
  RigorSource,
  TaskStatus,
  WorkstreamState,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createBuilderTools, type BuilderServices } from './tools';

const taskId = mintId('Task');
const runId = mintId('Workstream');

const asTask = (fields: Partial<TaskDto>): TaskDto =>
  ({
    id: taskId,
    title: 'the task',
    status: TaskStatus.Open,
    boardStatus: BoardStatus.Blocked,
    boardColumnId: null,
    workstreamId: runId,
    dependsOn: [],
    ...fields,
  }) as TaskDto;

/** Services that fail on the list of every run: a start may read only the task's own latest run. */
function servicesFor(task: TaskDto, run: WorkstreamState) {
  const getWorkstream = vi.fn(() => ({ id: runId, state: run }) as WorkstreamDto);
  const startTask = vi.fn(() => ({ kind: 'workstream', workstream: { id: runId } }));
  const listWorkstreams = vi.fn(() => {
    throw new Error('start_task listed every workstream');
  });
  const settleSizing = vi.fn(() => Promise.resolve());
  const services = {
    getTask: () => task,
    settleSizing,
    getWorkstream,
    startTask,
    listWorkstreams,
  } as unknown as BuilderServices;
  return {
    start: createBuilderTools(services)[BuilderToolName.StartTask],
    ...{ getWorkstream, startTask, listWorkstreams, settleSizing },
  };
}

describe('start_task', () => {
  it('waits for sizing before it reads the task, then starts it', async () => {
    const order: string[] = [];
    const services = {
      settleSizing: () => {
        order.push('settle');
        return Promise.resolve();
      },
      getTask: () => {
        order.push('read');
        return asTask({ boardStatus: BoardStatus.Ready, workstreamId: null });
      },
      startTask: () => {
        order.push('start');
        return { kind: 'workstream', workstream: { id: runId } };
      },
    } as unknown as BuilderServices;
    await createBuilderTools(services)[BuilderToolName.StartTask]({ taskId });
    expect(order).toEqual(['settle', 'read', 'start']);
  });

  it('finds a held task by reading only its latest run', async () => {
    const { start, getWorkstream, startTask, listWorkstreams } = servicesFor(
      asTask({}),
      WorkstreamState.Held,
    );
    expect(await start({ taskId })).toEqual({ taskId, workstreamId: runId });
    expect(getWorkstream).toHaveBeenCalledWith(runId);
    expect(startTask).toHaveBeenCalledOnce();
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  it('reads no run for a task that never started', async () => {
    const { start, getWorkstream } = servicesFor(
      asTask({ workstreamId: null, boardStatus: BoardStatus.Ready }),
      WorkstreamState.Held,
    );
    await start({ taskId });
    expect(getWorkstream).not.toHaveBeenCalled();
  });

  it('refuses a blocked task whose run is not held', async () => {
    const { start, startTask, listWorkstreams } = servicesFor(asTask({}), WorkstreamState.Running);
    await expect(start({ taskId })).rejects.toThrow('not ready');
    expect(startTask).not.toHaveBeenCalled();
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  it('starts a failed task over by reading only its latest run', async () => {
    const { start, startTask, listWorkstreams } = servicesFor(asTask({}), WorkstreamState.Failed);
    await start({ taskId, fresh: true });
    expect(startTask).toHaveBeenCalledWith(taskId, { fresh: true });
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  it('says a held task is parked, rather than that it is not ready', async () => {
    const { start, startTask } = servicesFor(
      asTask({ boardColumnId: mintId('BoardColumn') }),
      WorkstreamState.Held,
    );
    await expect(start({ taskId })).rejects.toThrow('parked');
    expect(startTask).not.toHaveBeenCalled();
  });
});

describe('import_plan', () => {
  const projectId = mintId('Project');
  const result = {
    kind: 'previewed',
    preview: { dryRun: true, shapeId: null, title: 'Remote host', changes: {} },
  } as const;

  it('import_plan reads a bundle path and answers the import', async () => {
    const importPlan = vi.fn(() => Promise.resolve(result));
    const tools = createBuilderTools({ importPlan } as unknown as BuilderServices);
    const answer = await tools[BuilderToolName.ImportPlan]({
      projectId,
      bundlePath: '/tmp/effort/bundle.json',
      dryRun: true,
    });
    expect(importPlan).toHaveBeenCalledWith(projectId, {
      bundlePath: '/tmp/effort/bundle.json',
      dryRun: true,
    });
    expect(answer).toEqual(result.preview);
  });

  it('import_plan answers a refusal as the route does, every issue listed', async () => {
    const errors = [{ path: 'Task t1, areas: docs', message: 'is not an area of the project' }];
    const importPlan = vi.fn(() => Promise.resolve({ kind: 'refused', errors }));
    const tools = createBuilderTools({ importPlan } as unknown as BuilderServices);
    expect(await tools[BuilderToolName.ImportPlan]({ projectId, bundlePath: '/b.json' })).toEqual({
      errors,
    });
  });

  it('import_plan refuses an inline bundle field', async () => {
    const importPlan = vi.fn();
    const tools = createBuilderTools({ importPlan } as unknown as BuilderServices);
    await expect(
      Promise.resolve(
        tools[BuilderToolName.ImportPlan]({ projectId, bundlePath: '/b.json', bundle: {} }),
      ),
    ).rejects.toThrow(/bundle/);
    expect(importPlan).not.toHaveBeenCalled();
  });
});

describe('create_task and edit_task', () => {
  const projectId = mintId('Project');
  const created = { id: taskId, title: 'the task', status: TaskStatus.Open } as TaskDto;

  it('give the task service the agent as the source of a rigor they set', async () => {
    const createTask = vi.fn(() => created);
    const patchTask = vi.fn(() => created);
    const tools = createBuilderTools({
      getTask: () => asTask({ kinds: [] }),
      createTask,
      patchTask,
    } as unknown as BuilderServices);
    await tools[BuilderToolName.CreateTask]({
      projectId,
      title: 'Add a thing',
      acceptanceCriteria: ['It works'],
      areas: ['api'],
      rigor: 'careful',
    });
    await tools[BuilderToolName.EditTask]({ taskId, rigor: 'light' });
    expect(createTask).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ rigor: 'careful' }),
      RigorSource.Agent,
    );
    expect(patchTask).toHaveBeenCalledWith(taskId, { rigor: 'light' }, RigorSource.Agent);
  });
});

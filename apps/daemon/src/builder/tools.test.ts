import {
  BoardStatus,
  BuilderToolName,
  mintId,
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
  const services = {
    getTask: () => task,
    getWorkstream,
    startTask,
    listWorkstreams,
  } as unknown as BuilderServices;
  return {
    start: createBuilderTools(services)[BuilderToolName.StartTask],
    ...{ getWorkstream, startTask, listWorkstreams },
  };
}

describe('start_task', () => {
  it('finds a held task by reading only its latest run', () => {
    const { start, getWorkstream, startTask, listWorkstreams } = servicesFor(
      asTask({}),
      WorkstreamState.Held,
    );
    expect(start({ taskId })).toEqual({ taskId, workstreamId: runId });
    expect(getWorkstream).toHaveBeenCalledWith(runId);
    expect(startTask).toHaveBeenCalledOnce();
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  it('reads no run for a task that never started', () => {
    const { start, getWorkstream } = servicesFor(
      asTask({ workstreamId: null, boardStatus: BoardStatus.Ready }),
      WorkstreamState.Held,
    );
    start({ taskId });
    expect(getWorkstream).not.toHaveBeenCalled();
  });

  it('refuses a blocked task whose run is not held', () => {
    const { start, startTask, listWorkstreams } = servicesFor(asTask({}), WorkstreamState.Running);
    expect(() => start({ taskId })).toThrow('not ready');
    expect(startTask).not.toHaveBeenCalled();
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  it('starts a failed task over by reading only its latest run', () => {
    const { start, startTask, listWorkstreams } = servicesFor(asTask({}), WorkstreamState.Failed);
    start({ taskId, fresh: true });
    expect(startTask).toHaveBeenCalledWith(taskId, { fresh: true });
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  it('says a held task is parked, rather than that it is not ready', () => {
    const { start, startTask } = servicesFor(
      asTask({ boardColumnId: mintId('BoardColumn') }),
      WorkstreamState.Held,
    );
    expect(() => start({ taskId })).toThrow('parked');
    expect(startTask).not.toHaveBeenCalled();
  });
});

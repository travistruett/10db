import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TaskMessageAuthor,
  WorkspaceMode,
  WorkstreamState,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import {
  getBatch,
  getTask,
  getTaskKeptWork,
  getWorkstream,
  listTaskThread,
  setTaskKeptWork,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { startTaskWithPlan } from '../team';
import { createKeptWorkGate, subscribeKeptWorkLanding } from './index';

// Workbench spec §5.4, call 33: an ordinary start of a task taken out of a pass puts its saved work
// back in the checkout it runs in before any lane can launch, names a file that did not go back on
// its thread, and the saved work's ref goes once the work lands.

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const keptRef = (task: TaskDto) => `refs/10db/kept/${task.id}`;

/**
 * A task with saved work, as a take-out leaves it: a commit on the base holding its edit to
 * `src/api/a.ts` and a file it added, at its kept ref.
 */
function taskWithSavedWork(opts: { readonly workspaceMode?: WorkspaceMode } = {}): TaskDto {
  h.commit('src/api/a.ts', 'a\n');
  h.git$('push', '-q', 'origin', 'main');
  const base = h.git$('rev-parse', 'HEAD');
  const task = h.addTask('Settings page', { areas: ['api'], ...opts });
  h.git$('switch', '-q', '-c', 'saved');
  h.commit('src/api/a.ts', 'kept\n');
  const kept = h.commit('src/api/new.ts', 'new\n');
  h.git$('switch', '-q', 'main');
  h.git$('branch', '-q', '-D', 'saved');
  h.git$('update-ref', keptRef(task), kept);
  h.state.write((ctx) => {
    setTaskKeptWork(ctx, task.id, { keptSha: kept, keptBaseSha: base });
  });
  return task;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const notices = (task: TaskDto) =>
  listTaskThread(h.store.db, task.id)
    .filter((m) => m.author === TaskMessageAuthor.System)
    .map((m) => m.body);

describe('an ordinary start of a task with saved Workbench work', () => {
  /** The task's run, once its start has cut its batch. */
  const runOf = (task: TaskDto) => {
    const id = getTask(h.store.db, task.id).workstreamId;
    if (id === null) throw new Error('the task has no run');
    return getWorkstream(h.store.db, id);
  };

  /** What the scheduler does before a launch: asks the gate, and on no, waits for the put-back. */
  async function launchable(task: TaskDto): Promise<void> {
    const gate = createKeptWorkGate(h.ctx);
    expect(gate.ready(runOf(task))).toBe(false);
    await h.jobs.idle();
    expect(gate.ready(runOf(task))).toBe(true);
  }

  it('puts the work back in Your folder before its run can launch, and changes nothing before', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const task = taskWithSavedWork();

    const batch = h.starter.startTask(task.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    // The cut wrote nothing of the saved work: a start refused there would leave it as it was.
    expect(read(h.repo, 'src/api/a.ts')).toBe('a\n');
    expect(getTaskKeptWork(h.store.db, task.id)).not.toBeNull();

    await launchable(task);

    expect(read(h.repo, 'src/api/a.ts')).toBe('kept\n');
    expect(read(h.repo, 'src/api/new.ts')).toBe('new\n');
    expect(getTaskKeptWork(h.store.db, task.id)).toBeNull();
    expect(notices(task)).toEqual(['Put back its saved Workbench work: 2 files.']);
  });

  it('names a file that does not go back on the thread, keeps it saved, and still lets the run launch', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const task = taskWithSavedWork();
    // The base moved on the same line since the work was kept: it does not merge.
    h.teammatePush('main', 'src/api/a.ts', 'moved on\n');

    h.starter.startTask(task.id);
    await h.jobs.idle();
    await launchable(task);

    expect(read(h.repo, 'src/api/a.ts')).toBe('moved on\n');
    expect(read(h.repo, 'src/api/new.ts')).toBe('new\n');
    expect(notices(task)).toEqual([
      'Put back its saved Workbench work: 1 file.\nLeft as they are, because the saved work does not merge with them:\n- src/api/a.ts',
    ]);
    expect(getTaskKeptWork(h.store.db, task.id)).not.toBeNull();
  });

  it('puts the work back in a separate copy before its run can launch', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const task = taskWithSavedWork({ workspaceMode: WorkspaceMode.Worktree });

    const batch = h.starter.startTask(task.id);
    await h.jobs.idle();
    await launchable(task);

    const path = getBatch(h.store.db, batch.id).worktreePath ?? '';
    expect(read(path, 'src/api/a.ts')).toBe('kept\n');
    expect(existsSync(join(h.repo, 'src/api/new.ts'))).toBe(false);
  });

  it('launches a local run only once its saved work is back in Your folder, after a restart too', async () => {
    h = createDeliveryHarness({ delivery: 'local' } satisfies Partial<ProjectInput>);
    const task = taskWithSavedWork();
    const run = startTaskWithPlan(h.state, task.id);
    const gate = createKeptWorkGate(h.ctx);

    expect(gate.ready(run)).toBe(false);
    // Asked again before the put-back has run, it queues no second one.
    expect(gate.ready(run)).toBe(false);
    expect(read(h.repo, 'src/api/a.ts')).toBe('a\n');
    await h.jobs.idle();

    expect(gate.ready(run)).toBe(true);
    expect(read(h.repo, 'src/api/a.ts')).toBe('kept\n');
    expect(notices(task)).toEqual(['Put back its saved Workbench work: 2 files.']);
    // A restart's gate knows nothing of the put-back: it finds the work already back.
    expect(createKeptWorkGate(h.ctx).ready(run)).toBe(true);
    expect(getWorkstream(h.store.db, run.id).state).toBe(WorkstreamState.Queued);
  });

  it("deletes the saved work's ref once the batch holding the work ships", async () => {
    h = createDeliveryHarness();
    const unsubscribe = subscribeKeptWorkLanding(h.bus, h.ctx);
    const task = taskWithSavedWork();
    const batch = h.starter.startTask(task.id);
    await h.jobs.idle();
    await launchable(task);
    expect(h.git$('for-each-ref', keptRef(task))).not.toBe('');

    // The run commits the work that went back, as its commit tool would.
    h.commit('src/api/a.ts', 'kept\n');
    h.commit('src/api/new.ts', 'new\n');
    const run = getTask(h.store.db, task.id).workstreamId;
    if (run !== null) h.settle(run, 'DONE');
    await h.jobs.idle();
    unsubscribe();

    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
    expect(h.git$('for-each-ref', keptRef(task))).toBe('');
  });
});

describe('a local run of a task with saved Workbench work', () => {
  it("deletes the saved work's ref once the run is done", async () => {
    h = createDeliveryHarness({ delivery: 'local' } satisfies Partial<ProjectInput>);
    const unsubscribe = subscribeKeptWorkLanding(h.bus, h.ctx);
    const task = taskWithSavedWork();
    const run = startTaskWithPlan(h.state, task.id);
    const gate = createKeptWorkGate(h.ctx);
    gate.ready(run);
    await h.jobs.idle();
    expect(h.git$('for-each-ref', keptRef(task))).not.toBe('');

    h.settle(run.id, 'DONE');
    await h.jobs.idle();
    unsubscribe();

    expect(h.git$('for-each-ref', keptRef(task))).toBe('');
  });
});

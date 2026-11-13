import { RigorBelowKindError, Rigor, type TaskInput } from '@10db/contracts';
import { getTask, listTasks } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** The task service the HTTP routes and the builder's tools both call; it reads only the state store and the scheduler. */
function taskService() {
  const wiring = {
    state: h.state,
    starter: h.starter,
    scheduler: { requestTick: () => undefined },
  };
  // A cast at a test boundary: createTask and patchTask touch nothing else of the deps.
  return createServices(wiring as unknown as Parameters<typeof createServices>[0]);
}

const brief: TaskInput = { title: 'Add a thing', acceptanceCriteria: ['It works'], areas: ['api'] };
const security = { key: 'security', source: 'builder' } as const;

describe('a rigor below the kinds’ minimum, through the task service', () => {
  const projectId = () => h.project.id;

  it.each([
    { name: 'a rigor at the minimum', rigor: Rigor.Careful, kinds: [security], refused: false },
    { name: 'a rigor above the minimum', rigor: Rigor.Critical, kinds: [security], refused: false },
    { name: 'a rigor below the minimum', rigor: Rigor.Light, kinds: [security], refused: true },
    { name: 'no rigor of its own', rigor: null, kinds: [security], refused: false },
    {
      name: 'a low rigor on a kind with no minimum',
      rigor: Rigor.Light,
      kinds: [{ key: 'docs', source: 'agent' } as const],
      refused: false,
    },
  ])('create: $name', async ({ rigor, kinds, refused }) => {
    const create = taskService().createTask(projectId(), { ...brief, rigor, kinds });
    if (refused) await expect(create).rejects.toThrow(RigorBelowKindError);
    else await expect(create).resolves.toMatchObject({ rigor });
    expect(listTasks(h.store.db, projectId())).toHaveLength(refused ? 0 : 1);
  });

  it('names the kind that holds the floor', async () => {
    await expect(
      taskService().createTask(projectId(), { ...brief, rigor: Rigor.Light, kinds: [security] }),
    ).rejects.toThrow(/Security/);
  });

  it('patch: refuses a rigor below the task’s kinds and leaves the task as it was', async () => {
    const task = await taskService().createTask(projectId(), { ...brief, kinds: [security] });
    await expect(taskService().patchTask(task.id, { rigor: Rigor.Standard })).rejects.toThrow(
      RigorBelowKindError,
    );
    expect(getTask(h.store.db, task.id).rigor).toBeNull();
  });

  it('patch: refuses a kind whose minimum is above the rigor the task already has', async () => {
    const task = await taskService().createTask(projectId(), { ...brief, rigor: Rigor.Light });
    await expect(taskService().patchTask(task.id, { kinds: [security] })).rejects.toThrow(
      RigorBelowKindError,
    );
    expect(getTask(h.store.db, task.id).kinds).toEqual([]);
  });

  it('patch: takes the pair together, so a stronger rigor and the kind in one edit pass', async () => {
    const task = await taskService().createTask(projectId(), { ...brief, rigor: Rigor.Light });
    const patched = await taskService().patchTask(task.id, {
      rigor: Rigor.Careful,
      kinds: [security],
    });
    expect(patched).toMatchObject({ rigor: 'careful', effectiveRigor: 'careful' });
  });

  it('patch: handing the rigor back to the default is never refused', async () => {
    const task = await taskService().createTask(projectId(), {
      ...brief,
      rigor: Rigor.Careful,
      kinds: [security],
    });
    const patched = await taskService().patchTask(task.id, { rigor: null });
    expect(patched).toMatchObject({ rigor: null, effectiveRigor: 'careful' });
  });
});

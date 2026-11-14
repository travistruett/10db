import { JudgeDecision, RigorSource, type TaskId, type TaskInput } from '@10db/contracts';
import { getTask, listJudgeCalls, patchJudgeConfig, readTaskSizing, seedAccount } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { scriptedJudge, type ScriptedAnswer } from '../../test/scripted-judge';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createSizingService, type SizingService } from '../sizing';
import { createServices } from './services';

let h: DeliveryHarness;
let sizer: SizingService;
/** The rigor the judge answers next; `docs` is touched, `ui` is not. */
let rigor: ScriptedAnswer;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
  rigor = { choice: 'careful', confidence: 0.9 };
  const account = seedAccount(h.store, { kind: 'openrouter', label: 'OpenRouter' });
  h.state.write((ctx) => patchJudgeConfig(ctx, { accountId: account.id }));
  sizer = createSizingService({
    state: h.state,
    bus: h.bus,
    judge: scriptedJudge(h.state, (req) =>
      req.decision === JudgeDecision.TaskRigor
        ? rigor
        : { choice: req.question.includes('(docs)') ? 'yes' : 'no', confidence: 0.9 },
    ),
    clock: new ManualClock(),
    log: silentLogger,
    joiningProblem: () => null,
  });
});
afterEach(() => {
  sizer.stop();
  h.close();
});

/** The task service the Board and the API call; it reads only the state store and the scheduler. */
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

/** A task the judge has sized: a Careful rigor and the `docs` kind. */
async function judgedTask(): Promise<TaskId> {
  const task = await taskService().createTask(h.project.id, brief);
  await sizer.settled([task.id]);
  expect(getTask(h.store.db, task.id)).toMatchObject({
    rigor: 'careful',
    rigorSource: 'judge',
    kinds: [{ key: 'docs', source: 'judge' }],
  });
  return task.id;
}

const outcomes = (decision: JudgeDecision, containing = '') =>
  listJudgeCalls(h.store.db, 100)
    .filter((c) => c.decision === decision && c.question.includes(containing))
    .map((c) => c.outcome);

describe('the builder changing a rigor the judge set', () => {
  it('records the rigor call overridden, and pins the new rigor as the builder’s', async () => {
    const id = await judgedTask();
    const edited = await taskService().patchTask(id, { rigor: 'light' });
    expect(edited).toMatchObject({ rigor: 'light', rigorSource: 'builder' });
    expect(outcomes(JudgeDecision.TaskRigor)).toEqual(['overridden']);
    // The kinds' calls are not the rigor's.
    expect(outcomes(JudgeDecision.TaskKinds, '(docs)')).toEqual(['acted']);
  });

  it('records nothing when the builder picks the rigor the judge chose', async () => {
    const id = await judgedTask();
    await taskService().patchTask(id, { rigor: 'careful' });
    expect(outcomes(JudgeDecision.TaskRigor)).toEqual(['acted']);
  });

  it('records the call overridden when the builder clears it, and the task is sized again', async () => {
    const id = await judgedTask();
    rigor = { choice: 'standard', confidence: 0.9 };
    const cleared = await taskService().patchTask(id, { rigor: null });
    expect(cleared).toMatchObject({ rigor: null, rigorSource: null });
    await sizer.settled([id]);
    expect(getTask(h.store.db, id)).toMatchObject({
      rigor: 'standard',
      rigorSource: 'judge',
      rigorReason: 'judged Standard (0.90)',
    });
    expect(outcomes(JudgeDecision.TaskRigor).sort()).toEqual(['acted', 'overridden']);
  });

  it('records nothing for a rigor an agent sets, as the builder’s MCP does', async () => {
    const id = await judgedTask();
    const edited = await taskService().patchTask(id, { rigor: 'light' }, RigorSource.Agent);
    expect(edited).toMatchObject({ rigor: 'light', rigorSource: 'agent' });
    expect(outcomes(JudgeDecision.TaskRigor)).toEqual(['acted']);
  });

  it('records nothing for a rigor the builder had set themselves', async () => {
    const task = await taskService().createTask(h.project.id, { ...brief, rigor: 'standard' });
    await sizer.settled([task.id]);
    await taskService().patchTask(task.id, { rigor: 'light' });
    expect(outcomes(JudgeDecision.TaskRigor)).toEqual([]);
  });
});

describe('the builder changing the kinds of a task', () => {
  const docs = { key: 'docs', source: 'judge' } as const;
  const ui = { key: 'ui', source: 'builder' } as const;

  it('puts a kind the builder removed in kindsOff and records a judged one overridden', async () => {
    const id = await judgedTask();
    const edited = await taskService().patchTask(id, { kinds: [] });
    expect(edited).toMatchObject({ kinds: [], kindsOff: ['docs'] });
    expect(outcomes(JudgeDecision.TaskKinds, '(docs)')).toEqual(['overridden']);
  });

  it('takes a re-added kind out of kindsOff, as the builder’s', async () => {
    const id = await judgedTask();
    await taskService().patchTask(id, { kinds: [] });
    const edited = await taskService().patchTask(id, { kinds: [docs] });
    expect(edited).toMatchObject({ kinds: [{ key: 'docs', source: 'builder' }], kindsOff: [] });
  });

  it('records the call overridden when the builder adds a kind the judge said no to', async () => {
    const id = await judgedTask();
    const edited = await taskService().patchTask(id, { kinds: [docs, ui] });
    expect(edited.kinds).toEqual([docs, { key: 'ui', source: 'builder' }]);
    expect(outcomes(JudgeDecision.TaskKinds, '(ui)')).toEqual(['overridden']);
    expect(outcomes(JudgeDecision.TaskKinds, '(docs)')).toEqual(['acted']);
  });

  it('gives every addition the builder as its source, whatever the form said', async () => {
    const id = await judgedTask();
    const edited = await taskService().patchTask(id, {
      kinds: [docs, { key: 'ui', source: 'rules' }],
    });
    expect(edited.kinds).toEqual([docs, { key: 'ui', source: 'builder' }]);
  });

  it('records nothing for kinds an agent sets, and puts none in kindsOff', async () => {
    const id = await judgedTask();
    const edited = await taskService().patchTask(id, { kinds: [] }, RigorSource.Agent);
    expect(edited).toMatchObject({ kinds: [], kindsOff: [] });
    expect(outcomes(JudgeDecision.TaskKinds, '(docs)')).toEqual(['acted']);
  });

  it('keeps a removed kind off through a later edit of the text, and does not ask about it', async () => {
    const id = await judgedTask();
    await taskService().patchTask(id, { kinds: [] });
    const before = listJudgeCalls(h.store.db, 100).length;
    await taskService().patchTask(id, { title: 'Add another thing' });
    await sizer.settled([id]);
    expect(getTask(h.store.db, id)).toMatchObject({ kinds: [], kindsOff: ['docs'] });
    const asked = listJudgeCalls(h.store.db, 100).slice(
      0,
      listJudgeCalls(h.store.db, 100).length - before,
    );
    expect(asked.some((c) => c.question.includes('(docs)'))).toBe(false);
    expect(readTaskSizing(h.store.db, id)?.kindsOff).toEqual(['docs']);
  });
});

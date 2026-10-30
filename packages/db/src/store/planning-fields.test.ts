import {
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type ProjectDto,
  type WorkstreamStep,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertFlow } from './flows';
import { insertHandoff, latestHandoffForStep } from './handoffs';
import { getProject, patchProject } from './projects';
import { insertSession } from './sessions';
import type { Store, WriteContext } from './store';
import { getTask, insertTask, patchTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { getWorkstream, getWorkstreamRow, insertWorkstream, patchWorkstream } from './workstreams';

let store: Store;
let close: () => void;
let nowMs: number;
beforeEach(() => {
  nowMs = Date.parse('2026-10-17T12:00:00.000Z');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

const task = { title: 'T', acceptanceCriteria: ['works'], areas: ['api'] };
const step = (role: WorkstreamStep['role'], sessionFloor = 0): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'opus',
  effort: 'high',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor,
  result: null,
  earlier: [],
  sentBack: 0,
});

describe('planning fields', () => {
  it('defaults a project to no flow and no ceiling, and patches both with an event', () => {
    const project = seedProject(store);
    expect(project).toMatchObject({ flowId: null, budgetCeiling: null });
    const flow = store.write((ctx) =>
      insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] }),
    ).value;
    const { events } = store.write((ctx) =>
      patchProject(ctx, project.id, { flowId: flow.id, budgetCeiling: 2.5 }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.ProjectChanged]);
    expect(getProject(store.db, project.id)).toMatchObject({ flowId: flow.id, budgetCeiling: 2.5 });
  });

  it.each([
    { name: 'a nudge at or below the handoff', patch: { nudgePct: 40 } },
    { name: 'a handoff at or above the nudge', patch: { handoffPct: 50 } },
  ])('refuses $name, checked against the stored values', ({ patch }) => {
    const project = seedProject(store); // handoff 40, nudge 50
    expect(() => store.write((ctx) => patchProject(ctx, project.id, patch))).toThrow(InvalidError);
  });

  it.each([
    {
      name: 'a project patch',
      write: (ctx: WriteContext, project: ProjectDto) =>
        patchProject(ctx, project.id, { flowId: mintId('Flow') }),
    },
    {
      name: 'a new task',
      write: (ctx: WriteContext, project: ProjectDto) =>
        insertTask(ctx, project.id, { ...task, flowId: mintId('Flow') }),
    },
  ])('answers not found for a flow that does not exist, in $name', ({ write }) => {
    const project = seedProject(store);
    expect(() => store.write((ctx) => write(ctx, project))).toThrow(NotFoundError);
  });

  it('stores a task’s risk tags and flow from the input, and patches them', () => {
    const project = seedProject(store);
    const flow = store.write((ctx) =>
      insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] }),
    ).value;
    const created = store.write((ctx) =>
      insertTask(ctx, project.id, { ...task, riskTags: ['auth'], flowId: flow.id }),
    ).value;
    expect(created).toMatchObject({ riskTags: ['auth'], flowId: flow.id });
    const { events } = store.write((ctx) => patchTask(ctx, created.id, { riskTags: ['security'] }));
    expect(events.map((e) => e.type)).toEqual([EventType.TaskChanged]);
    expect(getTask(store.db, created.id).riskTags).toEqual(['security']);
  });

  it('starts a workstream with no steps at index 0, and stores a patched step plan', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, created.id)).value;
    expect(ws).toMatchObject({ steps: [], stepIndex: 0 });
    const plan = [step('implement')];
    store.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, {
        steps: plan,
        stepIndex: 0,
        model: 'opus',
        effort: 'high',
      });
    });
    expect(getWorkstream(store.db, ws.id)).toMatchObject({
      steps: plan,
      model: 'opus',
      effort: 'high',
    });
  });

  it('reads a step stored before it kept earlier rounds and send-backs with neither yet', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, created.id)).value;
    // The JSON a step had before `earlier` and `sentBack` were added.
    const older = JSON.parse(JSON.stringify(step('review'))) as Record<string, unknown>;
    delete older['earlier'];
    delete older['sentBack'];
    store.db.$client
      .prepare('UPDATE workstreams SET steps = ? WHERE id = ?')
      .run(JSON.stringify([older]), ws.id);
    expect(getWorkstreamRow(store.db, ws.id).steps).toEqual([step('review')]);
    expect(getWorkstream(store.db, ws.id).steps).toEqual([step('review')]);
  });
});

describe('latestHandoffForStep', () => {
  it('sees only handoffs written by sessions after the current step started', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, created.id)).value;
    const session = (hash: string) =>
      store.write((ctx) =>
        insertSession(ctx, {
          workstreamId: ws.id,
          provider: 'claude',
          model: 'opus',
          effort: 'high',
          mode: 'managed',
          mcpTokenHash: hash,
        }),
      ).value;
    const handoff = (sessionId: ReturnType<typeof session>['id'], nextAction: string) =>
      store.write((ctx) =>
        insertHandoff(ctx, {
          workstreamId: ws.id,
          sessionId,
          content: {
            objective: { task: 'T', acceptanceCriteria: ['works'], nonGoals: [] },
            progress: { done: [], notDone: [], nextAction },
            codeState: { uncommittedSummary: '' },
            reasoning: { decisions: [], tradeOffs: [], rejected: [] },
            validation: { checks: [], environmentProblems: [] },
            continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
          },
          gitHead: 'abc1234',
          gitChangedFiles: [],
          gitCommits: [],
        }),
      ).value;
    const early = handoff(session('h1').id, 'implement more'); // session 1
    expect(latestHandoffForStep(store.db, getWorkstreamRow(store.db, ws.id))?.id).toBe(early.id); // no stored steps

    // The review step starts after session 1, at the same instant: time can't tell them apart, sessions can.
    store.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, {
        steps: [step('implement'), step('review', 1)],
        stepIndex: 1,
      });
    });
    expect(latestHandoffForStep(store.db, getWorkstreamRow(store.db, ws.id))).toBeNull();

    const late = handoff(session('h2').id, 'keep reviewing'); // session 2
    expect(latestHandoffForStep(store.db, getWorkstreamRow(store.db, ws.id))?.id).toBe(late.id);
  });
});

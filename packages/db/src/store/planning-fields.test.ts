import { EventType, InvalidError, type WorkstreamStep } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertHandoff, latestHandoffForStep } from './handoffs';
import { getProject, patchProject } from './projects';
import { insertSession } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
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
  setting: null,
});

describe('planning fields', () => {
  it('defaults a project to no ceiling, and patches it with an event', () => {
    const project = seedProject(store);
    expect(project).toMatchObject({ budgetCeiling: null });
    const { events } = store.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 2.5 }));
    expect(events.map((e) => e.type)).toEqual([EventType.ProjectChanged]);
    expect(getProject(store.db, project.id)).toMatchObject({ budgetCeiling: 2.5 });
  });

  it.each([
    { name: 'a nudge at or below the handoff', patch: { nudgePct: 40 } },
    { name: 'a handoff at or above the nudge', patch: { handoffPct: 50 } },
  ])('refuses $name, checked against the stored values', ({ patch }) => {
    const project = seedProject(store); // handoff 40, nudge 50
    expect(() => store.write((ctx) => patchProject(ctx, project.id, patch))).toThrow(InvalidError);
  });

  it('starts a workstream with no steps at index 0, and stores a patched step plan', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, created.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value;
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

  it('reads a step stored before it kept earlier rounds, send-backs or a setting with none yet', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, created.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value;
    // The JSON a step had before `earlier`, `sentBack` and `setting` were added.
    const older = JSON.parse(JSON.stringify(step('review'))) as Record<string, unknown>;
    delete older['earlier'];
    delete older['sentBack'];
    delete older['setting'];
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
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, created.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value;
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

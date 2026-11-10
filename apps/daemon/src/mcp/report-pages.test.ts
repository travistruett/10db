import {
  WorkspaceMode,
  type TaskDto,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  insertSession,
  insertWorkstream,
  listTaskPageReports,
  patchProject,
  patchWorkstream,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { PASS_PROJECT, openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { ClaimWaits } from './claim-wait';
import { createToolHandlers } from './tools';

// Workbench spec §10 "Which pages": an agent names routes its pictures should load with
// report_pages. The browser loads them signed in as the builder, so a route is kept only when it is
// a page area's route, a parameter segment standing for one concrete segment; at most four a turn
// (a pass page) or a run (a task outside a pass); the rest are refused, each with why.

const APP = 'http://localhost:8800';

let w: PassWorld;

/** The lane tools of `workstreamId`'s session, as its MCP server builds them. */
function toolsOf(world: PassWorld, workstreamId: WorkstreamId) {
  const session = world.h.state.write((ctx) =>
    insertSession(ctx, {
      workstreamId,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: `hash-${workstreamId}`,
    }),
  );
  return createToolHandlers(
    {
      protectedPaths: [],
      state: world.h.state,
      inbox: world.h.inbox,
      git: world.h.git,
      log: silentLogger,
      waitObserverFor: () => undefined,
      sessionSignal: () => undefined,
      askedToHandOff: () => undefined,
    },
    session.id,
    workstreamId,
    new ClaimWaits(),
  );
}

/** The pass world, with a page whose route takes a parameter. */
async function world(appUrl: string | null = APP): Promise<void> {
  w = await openPassWorld({
    project: {
      areas: [
        ...(PASS_PROJECT.areas ?? []),
        { name: 'person', globs: ['src/person/**'], role: 'page', route: '/people/[id]' },
      ],
    },
  });
  w.h.state.write((ctx) => patchProject(ctx, w.h.project.id, { appUrl }));
}

/** An ordinary task's run in Your folder, or in a copy. */
function ordinaryRun(mode: WorkspaceMode): { task: TaskDto; run: WorkstreamId } {
  const task = w.h.addTask('Reports', { areas: ['src'], workspaceMode: mode });
  const run = w.h.state.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).id;
  return { task, run };
}

const step = (role: 'implement' | 'review'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
  setting: null,
});

describe('report_pages', () => {
  afterEach(() => {
    w.close();
  });

  it("keeps a page area's routes for the turn, and refuses the rest, each with why", async () => {
    await world();
    const turn = w.startTurn(w.people);
    const tools = toolsOf(w, w.runOf(w.people));
    const out = await tools.report_pages({
      opId: 'op-pages-01',
      routes: ['/people/42', 'people', '/people/[id]', '/api/people/42/delete'],
    });
    expect(out.accepted).toEqual(['/people/42']);
    expect(out.refused.map((r) => r.route)).toEqual([
      'people',
      '/people/[id]',
      '/api/people/42/delete',
    ]);
    const reasons = out.refused.map((r) => r.reason);
    expect(reasons[0]).toMatch(/path on the app/);
    expect(reasons[1]).toMatch(/parameter filled in/);
    expect(reasons[2]).toMatch(/not a page area's route/);
    expect(
      listTaskPageReports(w.h.store.db, { taskId: w.people.id, turnId: turn.id }).map(
        (r) => r.route,
      ),
    ).toEqual(['/people/42']);

    // The same call again answers the same and keeps nothing more.
    expect(await tools.report_pages({ opId: 'op-pages-01', routes: ['/people/7'] })).toEqual(out);
    expect(
      listTaskPageReports(w.h.store.db, { taskId: w.people.id, turnId: turn.id }),
    ).toHaveLength(1);
  });

  it('takes at most four routes a turn, counting a route named again once', async () => {
    await world();
    const turn = w.startTurn(w.people);
    const tools = toolsOf(w, w.runOf(w.people));
    await tools.report_pages({
      opId: 'op-pages-01',
      routes: ['/people/1', '/people/2', '/people/3'],
    });
    const out = await tools.report_pages({
      opId: 'op-pages-02',
      routes: ['/people/1', '/people/4', '/people/5'],
    });
    expect(out.accepted).toEqual(['/people/1', '/people/4']);
    expect(out.refused.map((r) => r.route)).toEqual(['/people/5']);
    expect(out.refused[0]?.reason).toMatch(/four routes/);
    expect(
      listTaskPageReports(w.h.store.db, { taskId: w.people.id, turnId: turn.id }).map(
        (r) => r.route,
      ),
    ).toEqual(['/people/1', '/people/2', '/people/3', '/people/4']);
  });

  it("counts an ordinary task's routes over its run", async () => {
    await world();
    const { task, run } = ordinaryRun(WorkspaceMode.Shared);
    const tools = toolsOf(w, run);
    await tools.report_pages({
      opId: 'op-pages-01',
      routes: ['/people/1', '/people/2', '/people/3', '/people/4'],
    });
    const out = await tools.report_pages({ opId: 'op-pages-02', routes: ['/people/5'] });
    expect(out.refused.map((r) => r.route)).toEqual(['/people/5']);
    expect(out.refused[0]?.reason).toMatch(/four routes/);
    expect(listTaskPageReports(w.h.store.db, { taskId: task.id, workstreamId: run })).toHaveLength(
      4,
    );
  });

  it.each([
    { name: 'a project with no app address', appUrl: null, mode: null, why: /no app address/ },
    {
      name: 'a task in a separate copy',
      appUrl: APP,
      mode: WorkspaceMode.Worktree,
      why: /Your folder/,
    },
  ])('refuses every route of $name', async ({ appUrl, mode, why }) => {
    await world(appUrl);
    const run = mode === null ? w.runOf(w.people) : ordinaryRun(mode).run;
    if (mode === null) w.startTurn(w.people);
    const out = await toolsOf(w, run).report_pages({ opId: 'op-pages-01', routes: ['/people'] });
    expect(out.accepted).toEqual([]);
    expect(out.refused.map((r) => r.route)).toEqual(['/people']);
    expect(out.refused[0]?.reason).toMatch(why);
  });

  it('refuses every route in a read-only step, and keeps none', async () => {
    await world();
    const { task, run } = ordinaryRun(WorkspaceMode.Shared);
    w.h.state.write((ctx) => {
      patchWorkstream(ctx, run, null, { steps: [step('implement'), step('review')], stepIndex: 1 });
    });
    const out = await toolsOf(w, run).report_pages({ opId: 'op-pages-01', routes: ['/people'] });
    expect(out.accepted).toEqual([]);
    expect(out.refused[0]?.reason).toMatch(/read-only/);
    expect(listTaskPageReports(w.h.store.db, { taskId: task.id, workstreamId: run })).toEqual([]);
  });
});

import { WorkspaceMode, type TaskDto, type WorkstreamId } from '@10db/contracts';
import { insertSession, insertWorkstream, listTaskPageReports, patchProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { ClaimWaits } from './claim-wait';
import { createToolHandlers } from './tools';

// Workbench spec §10 "Which pages": an agent names routes its pictures should load with
// report_pages, a path on the app's address each, at most four a turn (a pass page) or a run (a task
// outside a pass); the rest are refused, each with why. Real pass, folder and database.

const APP = 'http://localhost:8800';

let w: PassWorld;
afterEach(() => {
  w.close();
});

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

async function world(appUrl: string | null = APP): Promise<void> {
  w = await openPassWorld();
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

describe('report_pages', () => {
  it('keeps routes on the app for the turn, and refuses the rest, each with why', async () => {
    await world();
    const turn = w.startTurn(w.people);
    const tools = toolsOf(w, w.runOf(w.people));
    const out = await tools.report_pages({
      opId: 'op-pages-01',
      routes: ['/people/42', 'people', '/people/[id]', `${APP}/people`],
    });
    expect(out.accepted).toEqual(['/people/42']);
    expect(out.refused.map((r) => r.route)).toEqual(['people', '/people/[id]', `${APP}/people`]);
    expect(out.refused.map((r) => r.reason)).toEqual([
      expect.stringMatching(/path on the app/),
      expect.stringMatching(/parameter filled in/),
      expect.stringMatching(/path on the app/),
    ]);
    expect(
      listTaskPageReports(w.h.store.db, { taskId: w.people.id, turnId: turn.id }).map(
        (r) => r.route,
      ),
    ).toEqual(['/people/42']);

    // The same call again answers the same and keeps nothing more.
    expect(await tools.report_pages({ opId: 'op-pages-01', routes: ['/x'] })).toEqual(out);
    expect(
      listTaskPageReports(w.h.store.db, { taskId: w.people.id, turnId: turn.id }),
    ).toHaveLength(1);
  });

  it('takes at most four routes a turn, counting a route named again once', async () => {
    await world();
    const turn = w.startTurn(w.people);
    const tools = toolsOf(w, w.runOf(w.people));
    await tools.report_pages({ opId: 'op-pages-01', routes: ['/a', '/b', '/c'] });
    const out = await tools.report_pages({ opId: 'op-pages-02', routes: ['/a', '/d', '/e'] });
    expect(out.accepted).toEqual(['/a', '/d']);
    expect(out.refused.map((r) => r.route)).toEqual(['/e']);
    expect(out.refused[0]?.reason).toMatch(/four routes/);
    expect(
      listTaskPageReports(w.h.store.db, { taskId: w.people.id, turnId: turn.id }).map(
        (r) => r.route,
      ),
    ).toEqual(['/a', '/b', '/c', '/d']);
  });

  it("counts an ordinary task's routes over its run", async () => {
    await world();
    const { task, run } = ordinaryRun(WorkspaceMode.Shared);
    const tools = toolsOf(w, run);
    await tools.report_pages({ opId: 'op-pages-01', routes: ['/a', '/b', '/c', '/d'] });
    const out = await tools.report_pages({ opId: 'op-pages-02', routes: ['/e'] });
    expect(out.refused.map((r) => r.route)).toEqual(['/e']);
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
    const out = await toolsOf(w, run).report_pages({ opId: 'op-pages-01', routes: ['/a'] });
    expect(out.accepted).toEqual([]);
    expect(out.refused.map((r) => r.route)).toEqual(['/a']);
    expect(out.refused[0]?.reason).toMatch(why);
  });
});

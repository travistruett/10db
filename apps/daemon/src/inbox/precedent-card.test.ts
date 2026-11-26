import {
  createTestStore,
  findOpenByFoldKey,
  getInboxItem,
  insertTask,
  insertWorkstream,
  listPrecedents,
  listTrustGrants,
  recordSkip,
  seedProject,
  type Store,
} from '@10db/db';
import { SkipKind, SkipSource, type ProjectId, type WorkstreamId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { precedentCandidates, precedentFor } from '../trust';
import { precedentFoldKey, refreshPrecedentCard } from './precedent-card';
import { createPrecedentService } from './precedent-service';

let close: () => void;
let store: Store;
let clock: ManualClock;
beforeEach(() => {
  clock = new ManualClock(new Date());
  ({ store, close } = createTestStore(() => clock.now()));
});
afterEach(() => {
  close();
});

function setup() {
  const project = seedProject(store);
  const runs: WorkstreamId[] = [];
  for (const title of ['Alpha', 'Beta']) {
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title,
        description: '',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      }),
    ).value;
    runs.push(
      store.write((ctx) =>
        insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
      ).value.id,
    );
  }
  const state = createStateStore(store, createEventBus());
  const service = createPrecedentService({
    state,
    clock,
    log: silentLogger,
    readerFor: () => null,
  });
  return { project, runs, state, clock, service };
}

let toolUse = 0;
function skip(
  run: WorkstreamId,
  programKey: string,
  summary: string,
  over: { source?: SkipSource } = {},
): void {
  toolUse += 1;
  store.write((ctx) =>
    recordSkip(ctx, {
      workstreamId: run,
      sessionId: null,
      toolName: 'Bash',
      toolUseId: `tu-${String(toolUse)}`,
      callKey: `ck-${String(toolUse)}`,
      summary,
      kind: SkipKind.Classifier,
      limit: null,
      reason: 'the judge was not sure',
      source: over.source ?? SkipSource.TendbJudge,
      programKey,
    }),
  );
}

/** Three keys of 10db's judge's doubt over two runs, and an auto mode key that has as many skips. */
function seed(runs: readonly WorkstreamId[]): void {
  const [a, b] = runs;
  if (a === undefined || b === undefined) throw new Error('two runs');
  for (const key of ['make t', 'pnpm test', 'node scripts/x.js']) {
    skip(a, key, `${key} one`);
    skip(a, key, `${key} two`);
    skip(b, key, `${key} three`);
  }
  for (const n of ['one', 'two', 'three'])
    skip(n === 'three' ? b : a, 'curl', `curl ${n}`, { source: SkipSource.AutoMode });
}

const openCard = (projectId: ProjectId) =>
  findOpenByFoldKey(store.db, projectId, precedentFoldKey(projectId));

describe('standing approvals proposed on one card', () => {
  it('exist only by the answer, never from an auto mode denial, and a declined kind can be approved again', async () => {
    const { project, runs, state, clock, service } = setup();
    seed(runs);
    const first = await precedentCandidates(store.db, project.id, clock.now(), null);
    expect(first.map((c) => c.programKey).sort()).toEqual([
      'make t',
      'node scripts/x.js',
      'pnpm test',
    ]);
    expect(first.find((c) => c.programKey === 'make t')).toMatchObject({
      scope: 'project',
      skips: 3,
      runCount: 2,
      taskCount: 2,
    });

    state.write((ctx) => {
      refreshPrecedentCard(ctx, project.id, first);
    });
    const card = openCard(project.id);
    if (card === undefined) throw new Error('the card is raised');
    expect(card.title).toBe('Make 3 kinds of command routine in demo?');
    expect(card.body).not.toContain('curl');
    expect(listPrecedents(store.db, project.id)).toEqual([]);

    const answered = await service.answer(project.id, {
      kinds: [
        { programKey: 'make t', scope: 'project', choice: 'approve', kind: 'Run `make t`' },
        { programKey: 'pnpm test', scope: 'project', choice: 'keep_skipping' },
        { programKey: 'node scripts/x.js', scope: 'project', choice: 'report' },
      ],
    });
    const rows = listPrecedents(store.db, project.id);
    expect(rows.map((r) => [r.programKey, r.state, r.kind])).toEqual([
      ['make t', 'active', 'Run `make t`'],
      ['pnpm test', 'declined', expect.stringContaining('pnpm test')],
    ]);
    expect(listTrustGrants(store.db, project.id)).toEqual([]);
    expect(answered.candidates.map((c) => c.programKey)).toEqual(['node scripts/x.js']);
    const reworded = getInboxItem(store.db, card.id);
    expect(reworded.state).toBe('OPEN');
    expect(reworded.title).toBe('Make 1 kind of command routine in demo?');
    expect(reworded.body).toContain('node scripts/x.js');
    expect(reworded.body).not.toContain('pnpm test');

    // A refresh computed before the answer writes after it: the answered kinds stay off.
    state.write((ctx) => {
      refreshPrecedentCard(ctx, project.id, first);
    });
    const afterStale = getInboxItem(store.db, card.id);
    expect(afterStale.title).toBe('Make 1 kind of command routine in demo?');
    expect(afterStale.body).toBe(reworded.body);

    // The same answer again changes nothing.
    const before = listPrecedents(store.db, project.id);
    await service.answer(project.id, {
      kinds: [
        { programKey: 'make t', scope: 'project', choice: 'approve', kind: 'Something else' },
        { programKey: 'pnpm test', scope: 'project', choice: 'approve' },
      ],
    });
    expect(listPrecedents(store.db, project.id)).toEqual(before);

    // A declined kind is approved again from Settings, days later: the judge is shown that day.
    const declined = before.find((r) => r.state === 'declined');
    if (declined === undefined) throw new Error('the declined row exists');
    expect(declined.approvedAt).toBeNull();
    clock.advance(19 * 86_400_000);
    const approved = await service.patch(project.id, declined.id, { state: 'active' });
    expect(approved).toMatchObject({ id: declined.id, state: 'active', conflicts: 0 });
    expect(approved.createdAt).toBe(declined.createdAt);
    expect(approved.approvedAt).toBe(clock.now().toISOString());
    expect(precedentFor([approved], approved.programKey, false, null, false)?.approved).toBe(
      clock.now().toISOString().slice(0, 10),
    );
    expect(listPrecedents(store.db, project.id).map((r) => r.state)).toEqual(['active', 'active']);
    expect(listTrustGrants(store.db, project.id)).toEqual([]);
  });
});

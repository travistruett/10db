import { ClaimKind, type ProjectDto, type WorkstreamId } from '@10db/contracts';
import {
  createTestStore,
  iceboxColumnId,
  listTasks,
  listWorkstreams,
  seedProject,
  setAppSetting,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { projectPinKey } from '../git';
import { recordBreak, reportClaimDeadlock } from '../mcp';
import { fileDefect } from './file-defect';

const contested = [
  { kind: ClaimKind.Area, name: 'ui' },
  { kind: ClaimKind.Area, name: 'api' },
];

describe('a repeated claim deadlock filed as a 10db defect', () => {
  let store: Store;
  let close: () => void;
  let other: ProjectDto;
  beforeEach(() => {
    ({ store, close } = createTestStore());
    other = seedProject(store, { name: 'shop' });
  });
  afterEach(() => {
    close();
  });

  const pinTenDb = (): ProjectDto => {
    const project = seedProject(store, { name: '10db' });
    store.write((ctx) => {
      setAppSetting(ctx, projectPinKey(project.id), {
        gitDir: '/x',
        commonDir: '/x',
        id: '1:1/1:1',
        fetchUrl: null,
        pushUrl: 'git@github.com:travistruett/10db.git',
      });
    });
    return project;
  };

  const run = (title: string): WorkstreamId =>
    seedWorkstream(store, { project: other, title }).workstream.id;

  /** `times` breaks between the pair, then the report the last one makes. */
  const breakAndReport = (
    yielder: WorkstreamId,
    holder: WorkstreamId,
    times: number,
  ): string | null =>
    store.write((ctx) => {
      let pair = recordBreak(ctx, { yielder, other: holder, contested, queue: true });
      for (let i = 1; i < times; i++)
        pair = recordBreak(ctx, { yielder, other: holder, contested, queue: true });
      return reportClaimDeadlock(ctx, pair, `"${yielder}" gave up area api`);
    }).value;

  it('files one Icebox task per pair of claims, and nothing on a fourth break or a second pair', () => {
    const tenDb = pinTenDb();
    const w1 = run('Checkout page');
    const w2 = run('Cart totals');
    expect(breakAndReport(w1, w2, 3)).toBeNull();

    const filed = listTasks(store.db, tenDb.id);
    expect(filed).toHaveLength(1);
    const task = filed[0];
    expect(task?.description.split('\n')[0]).toBe(
      'Defect signature: claim-deadlock:area api,area ui',
    );
    expect(task?.description).toContain('Checkout page');
    expect(task?.boardColumnId).toBe(iceboxColumnId(store.db, tenDb.id));
    expect(listWorkstreams(store.db, { projectId: tenDb.id })).toHaveLength(0);

    expect(breakAndReport(w1, w2, 1)).toBeNull();
    const w3 = run('Search box');
    const w4 = run('Search results');
    breakAndReport(w3, w4, 3);
    expect(listTasks(store.db, tenDb.id)).toHaveLength(1);
  });

  it('files nothing without 10db on this Mac, and the report goes to the notice body instead', () => {
    expect(
      store.write((ctx) =>
        fileDefect(ctx, {
          signature: 'claim-deadlock:area api',
          title: 'A defect',
          description: '',
        }),
      ).value,
    ).toBeNull();
    const report = breakAndReport(run('Checkout page'), run('Cart totals'), 3);
    expect(report).toContain('claim-deadlock:area api,area ui');
    expect(
      listTasks(store.db, other.id)
        .map((t) => t.title)
        .sort(),
    ).toEqual(['Cart totals', 'Checkout page']);
  });
});

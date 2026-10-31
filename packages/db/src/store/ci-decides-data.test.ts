import { BatchDto, BatchState, type BatchId, type ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBatch, insertBatch, patchBatch, transitionBatch } from './batches';
import { getProject, patchProject } from './projects';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('the pre-check command', () => {
  it('is null by default and stores one beside a gate command', () => {
    const project = seedProject(store);
    expect(project.precheckCommand).toBeNull();
    const made = seedProject(store, { precheckCommand: 'make precheck' });
    expect(getProject(store.db, made.id).precheckCommand).toBe('make precheck');
    store.write((ctx) => patchProject(ctx, project.id, { precheckCommand: 'make lint' }));
    expect(getProject(store.db, project.id).precheckCommand).toBe('make lint');
    store.write((ctx) => patchProject(ctx, project.id, { precheckCommand: null }));
    expect(getProject(store.db, project.id).precheckCommand).toBeNull();
  });

  it('is refused on a new project with no gate command', () => {
    expect(() => seedProject(store, { gateCommand: null, precheckCommand: 'make precheck' })).toThrow(
      /set a gate command first/i,
    );
  });

  it('is refused on a project with no gate command, and the gate command stays while one is set', () => {
    const bare = seedProject(store, { gateCommand: null });
    expect(() =>
      store.write((ctx) => patchProject(ctx, bare.id, { precheckCommand: 'make precheck' })),
    ).toThrow(/set a gate command first/i);
    expect(getProject(store.db, bare.id).precheckCommand).toBeNull();
    store.write((ctx) =>
      patchProject(ctx, bare.id, { gateCommand: 'make gate', precheckCommand: 'make precheck' }),
    );
    expect(() => store.write((ctx) => patchProject(ctx, bare.id, { gateCommand: null }))).toThrow(
      /set a gate command first/i,
    );
    expect(getProject(store.db, bare.id).gateCommand).toBe('make gate');
  });
});

/** A worktree batch (so one project can hold several) taken to SHIPPED with a pull request. */
function shipped(projectId: ProjectId, title: string): BatchId {
  const id = store.write((ctx) =>
    insertBatch(ctx, { projectId, title, baseBranch: 'main', worktreePath: `/tmp/wt/${title}` }),
  ).value.id;
  for (const to of [BatchState.Open, BatchState.Shipping])
    store.write((ctx) => transitionBatch(ctx, id, { to }));
  store.write((ctx) =>
    transitionBatch(ctx, id, {
      to: BatchState.Shipped,
      patch: { prUrl: `https://github.com/o/r/pull/${title}` },
    }),
  );
  return id;
}

describe('a batch’s required checks, merge block and CI fix', () => {
  it('reads null for each until written', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    expect(getBatch(store.db, shipped(project.id, 'one'))).toMatchObject({
      prRequired: null,
      prMergeBlocked: null,
      ciFixOf: null,
      ciFixHead: null,
      ciStopped: null,
    });
  });

  it('round-trips required checks, merge block and stop reason through the BatchDto', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id = shipped(project.id, 'one');
    const prRequired = {
      state: 'failing' as const,
      failing: [
        {
          name: 'test',
          link: 'https://github.com/o/r/actions/runs/11/job/22',
          jobId: '22',
          runId: '11',
          description: 'exit 1',
        },
      ],
      pending: [{ name: 'e2e', link: null, jobId: null, runId: null, description: null }],
    };
    store.write((ctx) =>
      patchBatch(ctx, id, { prRequired, prMergeBlocked: 'behind', ciStopped: 'no_change' }),
    );
    const batch = getBatch(store.db, id);
    expect(batch).toMatchObject({ prRequired, prMergeBlocked: 'behind', ciStopped: 'no_change' });
    expect(BatchDto.parse(batch)).toEqual(batch);
  });

  it('stores a fix batch’s parent and head, and refuses a second fix of the same head', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const root = shipped(project.id, 'root');
    const fix = (title: string, head: string) =>
      store.write((ctx) =>
        insertBatch(ctx, {
          projectId: project.id,
          title,
          baseBranch: 'main',
          worktreePath: `/tmp/wt/${title}`,
          ciFix: { of: root, head },
        }),
      ).value;
    const first = fix('fix-1', 'abc123');
    expect(getBatch(store.db, first.id)).toMatchObject({ ciFixOf: root, ciFixHead: 'abc123' });
    expect(() => fix('fix-2', 'abc123')).toThrow(/UNIQUE/);
    expect(fix('fix-3', 'def456').ciFixHead).toBe('def456');
  });
});

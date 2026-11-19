import type { DaemonEvent } from '@10db/contracts';
import { createTestStore, insertProject, seedDefaultAccount } from '@10db/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from './index';

const { store, close } = createTestStore();
// On the raw store, so no listener sees the seed.
store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: null }));
afterAll(() => {
  close();
});

const projectInput = (name: string) => ({
  name,
  repoPath: `/tmp/${name}`,
  gateCommand: 'true',
  areas: [{ name: 'src', globs: ['src/**'] }],
});

describe('StateStore', () => {
  it('publishes events only after the transaction commits', () => {
    const bus = createEventBus();
    const seen: DaemonEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const state = createStateStore(store, bus);
    state.write((ctx) => insertProject(ctx, projectInput('one')));
    expect(seen.map((e) => e.type)).toEqual(['project.created', 'board_column.saved']);
    expect(() =>
      state.write((ctx) => {
        insertProject(ctx, projectInput('two'));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(seen).toHaveLength(2);
  });
});

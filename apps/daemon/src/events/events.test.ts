import type { DaemonEvent } from '@10db/contracts';
import { createTestStore, insertProject } from '@10db/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from './index';

const { store, close } = createTestStore();
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

  it('keeps delivering to other listeners when one throws, and reports the error', () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error('bad listener');
    });
    const unsubscribe = bus.subscribe((e) => seen.push(e.seq));
    const state = createStateStore(store, bus);
    state.write((ctx) => insertProject(ctx, projectInput('three')));
    unsubscribe();
    state.write((ctx) => insertProject(ctx, projectInput('four')));
    // Each project announces itself and its Icebox column.
    expect(seen).toHaveLength(2);
    expect(errors).toHaveLength(4);
  });
});

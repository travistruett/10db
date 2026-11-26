import { createTestStore, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createSignInReporter, signInRecordOf } from './sign-in-record';

let store: Store;
let closeStore: () => void;
let state: StateStore;

beforeEach(() => {
  ({ store, close: closeStore } = createTestStore());
  state = createStateStore(store, createEventBus());
});

afterEach(() => {
  closeStore();
});

describe('a picture sign-in that fails', () => {
  it('leaves a record naming the command, its exit code and its last lines, cleared when a sign-in succeeds', () => {
    const project = seedProject(store, { name: 'ampsio' });
    const reporter = createSignInReporter({ state });

    reporter.failed(
      project.id,
      'pnpm e2e:login',
      {
        problem: 'The dev login command failed (exit 1)',
        exitCode: 1,
        output: 'no such user e2e@example.com',
      },
      't1',
    );

    expect(signInRecordOf(store.db, project.id)).toMatchObject({
      problem: 'The dev login command failed (exit 1)',
      command: 'pnpm e2e:login',
      exitCode: 1,
      tail: 'no such user e2e@example.com',
    });

    reporter.succeeded(project.id);

    expect(signInRecordOf(store.db, project.id)).toBeNull();
  });
});

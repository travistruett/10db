import { AppUrl } from '@10db/contracts';
import {
  createTestStore,
  findOpenByFoldKey,
  listOpenByFoldKeyPrefix,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService } from '../inbox';
import { loginOutputTail } from './sign-in';
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

const APP = AppUrl.parse('http://localhost:3000');

describe('a picture sign-in that fails', () => {
  it('raises one card per project naming the command, its exit code and its last lines, and withdraws it when a sign-in succeeds', () => {
    const project = seedProject(store, { name: 'ampsio' });
    const reporter = createSignInReporter({
      state,
      inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    });
    const failure = {
      command: 'pnpm e2e:login',
      exitCode: 1,
      tail: loginOutputTail(
        APP,
        'no such user e2e@example.com\nopen http://localhost:3000/auth?token=abc\nexit',
      ),
    };

    reporter.failed(project.id, 'The dev login command failed (exit 1)', failure, 't1');
    reporter.failed(project.id, 'The dev login command failed (exit 1)', failure, 't2');

    expect(listOpenByFoldKeyPrefix(store.db, 'pictures-sign-in:')).toHaveLength(1);
    const body = findOpenByFoldKey(store.db, project.id, `pictures-sign-in:${project.id}`)?.body;
    expect(body).toContain('Command: pnpm e2e:login');
    expect(body).toContain('Exit code: 1');
    expect(body).toContain('no such user e2e@example.com');
    // The address the login printed holds its token.
    expect(body).not.toContain('token=abc');
    expect(signInRecordOf(store.db, project.id)?.problem).toBe(
      'The dev login command failed (exit 1)',
    );

    reporter.succeeded(project.id);

    expect(listOpenByFoldKeyPrefix(store.db, 'pictures-sign-in:')).toHaveLength(0);
    expect(signInRecordOf(store.db, project.id)).toBeNull();
  });
});

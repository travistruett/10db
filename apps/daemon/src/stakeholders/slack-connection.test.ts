import { createTestStore } from '@10db/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { createSlackConnection } from './slack-connection';

let close: () => void;
let connection: ReturnType<typeof createSlackConnection>;
beforeEach(() => {
  const made = createTestStore();
  close = made.close;
  connection = createSlackConnection({ state: createStateStore(made.store, createEventBus()) });
});
afterEach(() => {
  close();
});

it('is not connected until a tick or a token check says so', () => {
  expect(connection.get().state).toBe('none');
  connection.set('connected');
  expect(connection.get().state).toBe('connected');
});

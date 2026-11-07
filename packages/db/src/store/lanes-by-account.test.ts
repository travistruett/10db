import { WorkstreamState as S, type AccountId, type ProjectDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { endSession, insertSession } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedAccount, seedProject } from './test-support';
import {
  countLanes,
  insertWorkstream,
  lanesByAccount,
  patchWorkstream,
  transitionWorkstream,
} from './workstreams';

let store: Store;
let close: () => void;
let a: AccountId;
let b: AccountId;
let onA: ProjectDto;
let onB: ProjectDto;
let hashes = 0;

beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date('2026-11-06T12:00:00.000Z')));
  a = seedAccount(store, { kind: 'claude_subscription', label: 'A' }).id;
  b = seedAccount(store, { kind: 'claude_subscription', label: 'B' }).id;
  onA = seedProject(store, { accountId: a });
  onB = seedProject(store, { accountId: b });
});
afterEach(() => {
  close();
});

/** A workstream of `project` in `state`, with a session on each of `sessions` (ended or live). */
function lane(
  project: ProjectDto,
  state: 'QUEUED' | 'STARTING' | 'RUNNING' | 'WAITING_HUMAN',
  sessions: readonly { on: AccountId; ended: boolean }[] = [],
  current = false,
) {
  return store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 't',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    if (state !== S.Queued) transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
    if (state === S.Running || state === S.WaitingHuman)
      transitionWorkstream(ctx, ws.id, { to: S.Running, fence: null });
    if (state === S.WaitingHuman)
      transitionWorkstream(ctx, ws.id, { to: S.WaitingHuman, fence: null });
    for (const s of sessions) {
      hashes += 1;
      const row = insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: `hash-${String(hashes)}`,
        accountId: s.on,
      });
      if (s.ended) endSession(ctx, row.id, 'done');
      else if (current) patchWorkstream(ctx, ws.id, null, { currentSessionId: row.id });
    }
    return ws;
  }).value;
}

describe('lanesByAccount', () => {
  it.each<{
    name: string;
    build: () => void;
    expected: () => [AccountId, number][];
  }>([
    {
      name: 'a running lane with a live session counts on the session’s account, not the project’s',
      build: () => lane(onA, S.Running, [{ on: b, ended: false }]),
      expected: () => [[b, 1]],
    },
    {
      name: 'a session that ended on A leaves a running lane with a live session on B counted on B',
      build: () =>
        lane(onA, S.Running, [
          { on: a, ended: true },
          { on: b, ended: false },
        ]),
      expected: () => [[b, 1]],
    },
    {
      name: 'an ended session on A and a starting lane of a project on B count on B',
      build: () => lane(onB, S.Starting, [{ on: a, ended: true }]),
      expected: () => [[b, 1]],
    },
    {
      name: 'a starting lane with no session yet counts on its project’s account',
      build: () => lane(onA, S.Starting),
      expected: () => [[a, 1]],
    },
    {
      name: 'a lane waiting on the builder with a current session counts',
      build: () => lane(onA, S.WaitingHuman, [{ on: a, ended: false }], true),
      expected: () => [[a, 1]],
    },
    {
      name: 'a lane waiting on the builder with no current session does not',
      build: () => lane(onA, S.WaitingHuman, [{ on: a, ended: true }]),
      expected: () => [],
    },
    {
      name: 'a queued lane does not count, whatever session rows it has',
      build: () => lane(onA, S.Queued, [{ on: a, ended: false }]),
      expected: () => [],
    },
  ])('$name', ({ build, expected }) => {
    build();
    const counted = lanesByAccount(store.db);
    expect([...counted.entries()]).toEqual(expected());
    // The same lanes `countLanes` holds, so the two cannot disagree on which work is a lane.
    expect([...counted.values()].reduce((sum, n) => sum + n, 0)).toBe(countLanes(store.db).global);
  });
});

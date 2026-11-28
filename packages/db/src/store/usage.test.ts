import {
  AccountKind,
  SessionMode,
  type AccountId,
  type ProjectId,
  type SessionId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertSession, setSessionLimitShare } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedAccount, seedProject } from './test-support';
import { selfStartedToday } from './usage';
import { insertWorkstream } from './workstreams';

let now = new Date('2026-11-28T10:00:00.000Z');
let store: Store;
let close: () => void;
beforeEach(() => {
  now = new Date('2026-11-28T10:00:00.000Z');
  ({ store, close } = createTestStore(() => now));
});
afterEach(() => {
  close();
});

const DAY = { start: '2026-11-28T00:00:00.000Z', end: '2026-11-29T00:00:00.000Z' };

/** A session of a new run in the project, started at `at`; its dollars and share are written after. */
function session(
  projectId: ProjectId,
  at: string,
  opts: { selfStarted: boolean; accountId?: AccountId; costUsd?: number; share?: number },
): SessionId {
  now = new Date(at);
  const task = store.write((ctx) =>
    insertTask(ctx, projectId, { title: 't', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  const run = store.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value;
  const row = store.write((ctx) =>
    insertSession(ctx, {
      workstreamId: run.id,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      mode: SessionMode.Managed,
      mcpTokenHash: `hash-${at}-${String(Math.random())}`,
      selfStarted: opts.selfStarted,
      ...(opts.accountId === undefined ? {} : { accountId: opts.accountId }),
    }),
  ).value;
  // The cost is written straight onto the row, as a priced listing would: whether it is summed
  // must depend on the account's kind, not on whether a cost happens to be there.
  if (opts.costUsd !== undefined)
    store.write((ctx) => {
      ctx.tx
        .update(schema.sessions)
        .set({ costUsd: opts.costUsd })
        .where(eq(schema.sessions.id, row.id))
        .run();
    });
  if (opts.share !== undefined)
    store.write((ctx) => {
      setSessionLimitShare(ctx, row.id, opts.share ?? null);
    });
  return row.id;
}

describe('selfStartedToday', () => {
  it("sums a project's counted sessions of the day by what its account measures", () => {
    const metered = seedAccount(store, { kind: AccountKind.AnthropicApiKey, label: 'Keyed' });
    const plan = seedAccount(store, { kind: AccountKind.CodexSignin, label: 'ChatGPT plan' });
    const project = seedProject(store, { accountId: metered.id });
    const planProject = seedProject(store, { accountId: plan.id });

    session(project.id, '2026-11-28T09:00:00.000Z', { selfStarted: true, costUsd: 1.5 });
    session(project.id, '2026-11-28T09:30:00.000Z', { selfStarted: true, costUsd: 0.5 });
    // The builder's own work in the same project and day is not counted.
    session(project.id, '2026-11-28T09:45:00.000Z', { selfStarted: false, costUsd: 7 });
    // Yesterday's counted session is left out, and so is the day's end boundary.
    session(project.id, '2026-11-27T23:59:00.000Z', { selfStarted: true, costUsd: 4 });
    session(project.id, '2026-11-29T00:00:00.000Z', { selfStarted: true, costUsd: 4 });

    session(planProject.id, '2026-11-28T08:00:00.000Z', {
      selfStarted: true,
      costUsd: 9,
      share: 0.04,
    });
    session(planProject.id, '2026-11-28T08:30:00.000Z', { selfStarted: true, share: 0.01 });
    // A plan session that reported no share is unmeasured, and its dollars are never summed.
    session(planProject.id, '2026-11-28T08:45:00.000Z', { selfStarted: true });

    expect(selfStartedToday(store.db, project.id, DAY)).toEqual({
      usd: 2,
      share: 0,
      unmeasured: 0,
    });
    const planned = selfStartedToday(store.db, planProject.id, DAY);
    expect(planned.usd).toBe(0);
    expect(planned.share).toBeCloseTo(0.05, 10);
    expect(planned.unmeasured).toBe(1);
  });
});

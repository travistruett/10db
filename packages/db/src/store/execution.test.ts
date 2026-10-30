import { ConflictError, mintId, WorkstreamState as S, type BatchId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireClaims,
  activeClaims,
  claimRequestsForTask,
  copyHazardNames,
  releaseClaims,
  renewClaimLeases,
  type ClaimRequest,
} from './claims';
import { findToolOp, insertToolOp } from './tool-ops';
import { getSession, getSessionByProviderId, insertSession, markSessionStarted } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import {
  acquireLease,
  countLanes,
  getWorkstreamRow,
  insertWorkstream,
  listWorkstreams,
  patchWorkstream,
  StaleFenceError,
  transitionWorkstream,
} from './workstreams';

let store: Store;
let close: () => void;
let nowMs: number;
beforeEach(() => {
  nowMs = Date.parse('2026-10-13T12:00:00.000Z');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

function seedWorkstream(title = 'A', areas: string[] = ['api'], project = seedProject(store)) {
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas }),
  ).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { project, task, ws };
}

describe('workstreams', () => {
  it('refuses a second active workstream for the same task', () => {
    const { task } = seedWorkstream();
    expect(() => store.write((ctx) => insertWorkstream(ctx, task.id))).toThrow(ConflictError);
  });

  it('moves along allowed transitions and records each as an event', () => {
    const { ws } = seedWorkstream();
    const { events } = store.write((ctx) => {
      transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
      return transitionWorkstream(ctx, ws.id, { to: S.Running, fence: null });
    });
    expect(events.map((e) => e.data)).toEqual([
      { from: 'QUEUED', to: 'STARTING', reason: null },
      { from: 'STARTING', to: 'RUNNING', reason: null },
    ]);
  });

  it('rejects a forbidden transition', () => {
    const { ws } = seedWorkstream();
    expect(() =>
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Done, fence: null })),
    ).toThrow(ConflictError);
  });

  it('fences off a runner holding an old lease', () => {
    const { ws } = seedWorkstream();
    const first = store.write((ctx) =>
      acquireLease(ctx, ws.id, 'daemon-a', '2026-10-13T12:01:00.000Z'),
    ).value;
    const second = store.write((ctx) =>
      acquireLease(ctx, ws.id, 'daemon-b', '2026-10-13T12:01:00.000Z'),
    ).value;
    expect(second).toBe(first + 1);
    expect(() =>
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: first })),
    ).toThrow(StaleFenceError);
    expect(() =>
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: second })),
    ).not.toThrow();
  });

  it('counts lanes for lane states and for a waiting workstream with a live session only', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['api']);
    store.write((ctx) => {
      transitionWorkstream(ctx, a.ws.id, { to: S.Starting, fence: null });
      transitionWorkstream(ctx, a.ws.id, { to: S.Running, fence: null });
      transitionWorkstream(ctx, b.ws.id, { to: S.Starting, fence: null });
      transitionWorkstream(ctx, b.ws.id, { to: S.Running, fence: null });
      transitionWorkstream(ctx, b.ws.id, { to: S.WaitingHuman, fence: null });
    });
    expect(countLanes(store.db).global).toBe(1);

    const session = store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: b.ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'h1',
      }),
    ).value;
    store.write((ctx) => {
      patchWorkstream(ctx, b.ws.id, null, { currentSessionId: session.id });
    });
    const lanes = countLanes(store.db);
    expect(lanes.global).toBe(2);
    expect(lanes.byAccount.get(a.project.accountId)).toBe(2);
    expect(lanes.byProject.get(a.project.id)).toBe(1);
  });
});

describe('fencing on patch', () => {
  it.each([
    { name: 'stale fence', fenceOffset: -1, throws: true },
    { name: 'current fence', fenceOffset: 0, throws: false },
  ])('patchWorkstream with $name', ({ fenceOffset, throws }) => {
    const { ws } = seedWorkstream();
    const fence = store.write((ctx) =>
      acquireLease(ctx, ws.id, 'daemon-a', '2026-10-13T12:01:00.000Z'),
    ).value;
    const run = () =>
      store.write((ctx) => {
        patchWorkstream(ctx, ws.id, fence + fenceOffset, { attempt: 2 });
      });
    if (throws) expect(run).toThrow(StaleFenceError);
    else expect(run).not.toThrow();
    expect(getWorkstreamRow(store.db, ws.id).attempt).toBe(throws ? 0 : 2);
  });
});

describe('sessions', () => {
  it('numbers sessions within a workstream and records the provider session on start', () => {
    const { ws } = seedWorkstream();
    const mk = (hash: string) =>
      store.write((ctx) =>
        insertSession(ctx, {
          workstreamId: ws.id,
          provider: 'claude',
          model: 'sonnet',
          effort: 'medium',
          mode: 'managed',
          mcpTokenHash: hash,
        }),
      ).value;
    expect(mk('h1').sequence).toBe(1);
    const second = mk('h2');
    expect(second.sequence).toBe(2);
    const { events } = store.write((ctx) => {
      markSessionStarted(ctx, second.id, 'provider-123', null);
    });
    expect(events[0]).toMatchObject({
      type: 'session.started',
      entityId: second.id,
      data: { providerSessionId: 'provider-123' },
    });
  });

  it('records the process start time beside the pid', () => {
    const { ws } = seedWorkstream();
    const s = store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'h1',
      }),
    ).value;
    store.write((ctx) => {
      markSessionStarted(ctx, s.id, 'provider-1', 4242, 'Tue Oct 13 12:00:00 2026');
    });
    expect(getSession(store.db, s.id)).toMatchObject({
      pid: 4242,
      pidStart: 'Tue Oct 13 12:00:00 2026',
    });
  });

  it("finds the workstream's latest session for a provider conversation, with its briefing", () => {
    const project = seedProject(store);
    const a = seedWorkstream('A', ['api'], project).ws;
    const b = seedWorkstream('B', ['ui'], project).ws;
    const started = (
      workstreamId: typeof a.id,
      hash: string,
      providerSessionId: string,
      briefing: { briefed?: boolean; briefingBaselinePct?: number | null } = {},
    ) =>
      store.write((ctx) => {
        const s = insertSession(ctx, {
          workstreamId,
          provider: 'claude',
          model: 'sonnet',
          effort: 'medium',
          mode: 'managed',
          mcpTokenHash: hash,
          ...briefing,
        });
        markSessionStarted(ctx, s.id, providerSessionId, null);
        return s;
      }).value;
    started(a.id, 'h1', 'conv-1', { briefed: true, briefingBaselinePct: 30 });
    const resumed = started(a.id, 'h2', 'conv-1', { briefed: true, briefingBaselinePct: 30 });
    started(a.id, 'h3', 'conv-2');
    const other = started(b.id, 'h4', 'conv-1');

    expect(getSessionByProviderId(store.db, a.id, 'conv-1')).toMatchObject({
      id: resumed.id,
      briefed: true,
      briefingBaselinePct: 30,
    });
    expect(getSessionByProviderId(store.db, b.id, 'conv-1')).toMatchObject({
      id: other.id,
      briefed: false,
      briefingBaselinePct: null,
    });
    expect(getSessionByProviderId(store.db, a.id, 'conv-3')).toBeUndefined();
  });
});

describe('claims', () => {
  it('is all-or-nothing and reports who holds a conflicting claim', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['api', 'ui'], a.project);
    const lease = '2026-10-13T12:01:00.000Z';
    const sameProject = a.project.id;
    const first = store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: sameProject,
        workstreamId: a.ws.id,
        requests: [{ kind: 'area', name: 'api' }],
        leaseExpiresAt: lease,
      }),
    ).value;
    expect(first.ok).toBe(true);

    const second = store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: sameProject,
        workstreamId: b.ws.id,
        requests: [
          { kind: 'area', name: 'ui' },
          { kind: 'area', name: 'api' },
        ],
        leaseExpiresAt: lease,
      }),
    ).value;
    expect(second).toEqual({ ok: false, conflict: { kind: 'area', name: 'api', heldBy: a.ws.id } });
    expect(activeClaims(store.db, b.ws.id)).toEqual([]);

    const again = store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: sameProject,
        workstreamId: a.ws.id,
        requests: [{ kind: 'area', name: 'api' }],
        leaseExpiresAt: lease,
      }),
    ).value;
    expect(again.ok).toBe(true);
    expect(activeClaims(store.db, a.ws.id)).toHaveLength(1);

    store.write((ctx) => releaseClaims(ctx, a.ws.id));
    const third = store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: sameProject,
        workstreamId: b.ws.id,
        requests: [{ kind: 'area', name: 'api' }],
        leaseExpiresAt: lease,
      }),
    ).value;
    expect(third.ok).toBe(true);
  });
});

describe('per-copy hazards', () => {
  const lease = '2026-10-13T12:01:00.000Z';
  const b1 = mintId('Batch');
  const b2 = mintId('Batch');
  const copyHazards = new Set(['harness']);
  const take = (who: ReturnType<typeof seedWorkstream>, name: string, areaScope?: BatchId) =>
    store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: who.project.id,
        workstreamId: who.ws.id,
        requests: [{ kind: 'hazard', name }],
        leaseExpiresAt: lease,
        copyHazards,
        ...(areaScope ? { areaScope } : {}),
      }),
    ).value;

  it.each([
    { name: 'two batches', first: b1, second: b2, ok: true },
    { name: 'one batch', first: b1, second: b1, ok: false },
    { name: 'a shared checkout, where every task shares the copy', ok: false },
  ])('a per-copy hazard in $name', ({ first, second, ok }) => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['ui'], a.project);
    expect(take(a, 'harness', first).ok).toBe(true);
    expect(take(b, 'harness', second).ok).toBe(ok);
  });

  it('keeps a hazard that is not per copy exclusive across batches', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['ui'], a.project);
    expect(take(a, 'migrations', b1).ok).toBe(true);
    const refused = take(b, 'migrations', b2);
    expect(refused).toMatchObject({ ok: false, conflict: { name: 'migrations', heldBy: a.ws.id } });
  });

  it('marks the stock hazards with their scope, from the project', () => {
    const project = seedProject(store);
    expect([...copyHazardNames(project)].sort()).toEqual(['deps', 'harness']);
  });
});

describe('claims by scope', () => {
  const lease = '2026-10-13T12:01:00.000Z';
  const b1 = mintId('Batch');
  const b2 = mintId('Batch');
  interface Held {
    kind: 'area' | 'hazard';
    name: string;
    areaScope?: BatchId;
    otherProject?: boolean;
  }
  it.each<{ name: string; first: Held; second: Held; ok: boolean }>([
    {
      name: 'the same area in two batches of one project',
      first: { kind: 'area', name: 'ui', areaScope: b1 },
      second: { kind: 'area', name: 'ui', areaScope: b2 },
      ok: true,
    },
    {
      name: 'the same area in one batch',
      first: { kind: 'area', name: 'ui', areaScope: b1 },
      second: { kind: 'area', name: 'ui', areaScope: b1 },
      ok: false,
    },
    {
      name: 'the same hazard in two batches',
      first: { kind: 'hazard', name: 'docker', areaScope: b1 },
      second: { kind: 'hazard', name: 'docker', areaScope: b2 },
      ok: false,
    },
    {
      name: 'the same area with no scope (shared mode, as today)',
      first: { kind: 'area', name: 'ui' },
      second: { kind: 'area', name: 'ui' },
      ok: false,
    },
    {
      name: 'the same area in two projects',
      first: { kind: 'area', name: 'ui' },
      second: { kind: 'area', name: 'ui', otherProject: true },
      ok: true,
    },
  ])('$name', ({ first, second, ok }) => {
    const a = seedWorkstream('A', ['ui']);
    const b = second.otherProject
      ? seedWorkstream('B', ['ui'])
      : seedWorkstream('B', ['ui'], a.project);
    const take = (held: Held, who: typeof a) =>
      store.write((ctx) =>
        acquireClaims(ctx, {
          projectId: who.project.id,
          workstreamId: who.ws.id,
          requests: [{ kind: held.kind, name: held.name }],
          leaseExpiresAt: lease,
          ...(held.areaScope ? { areaScope: held.areaScope } : {}),
        }),
      ).value;
    expect(take(first, a).ok).toBe(true);
    expect(take(second, b).ok).toBe(ok);
  });
});

describe('claim cases', () => {
  const lease = '2026-10-13T12:01:00.000Z';
  const area = (name: string): ClaimRequest => ({ kind: 'area', name });
  const hazard = (name: string): ClaimRequest => ({ kind: 'hazard', name });
  const acquire = (
    projectId: ReturnType<typeof seedProject>['id'],
    workstreamId: ReturnType<typeof seedWorkstream>['ws']['id'],
    requests: ClaimRequest[],
  ) =>
    store.write((ctx) =>
      acquireClaims(ctx, { projectId, workstreamId, requests, leaseExpiresAt: lease }),
    );
  const names = (events: { type: string }[], type: string) =>
    events.filter((e) => e.type === type).length;

  it.each([
    {
      name: 'hazard against the same hazard',
      first: [hazard('migrations')],
      second: [hazard('migrations')],
      free: false,
    },
    {
      name: 'two different hazards at once',
      first: [hazard('migrations')],
      second: [hazard('deps')],
      free: true,
    },
    {
      name: 'area and hazard of one name are different claims',
      first: [area('x')],
      second: [hazard('x')],
      free: true,
    },
  ])('$name', ({ first, second, free }) => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['ui'], a.project);
    expect(acquire(a.project.id, a.ws.id, first).value.ok).toBe(true);
    const result = acquire(b.project.id, b.ws.id, second);
    expect(result.value.ok).toBe(free);
    expect(activeClaims(store.db, b.ws.id)).toHaveLength(free ? second.length : 0);
    expect(names(result.events, 'claim.acquired')).toBe(free ? second.length : 0);
  });

  it('treats the same name in another project as free', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['api']);
    expect(acquire(a.project.id, a.ws.id, [area('api')]).value.ok).toBe(true);
    expect(acquire(b.project.id, b.ws.id, [area('api')]).value.ok).toBe(true);
  });

  it('collapses duplicate requests in one call into one claim', () => {
    const a = seedWorkstream('A', ['api']);
    const result = acquire(a.project.id, a.ws.id, [area('api'), area('api')]);
    expect(result.value.ok).toBe(true);
    expect(activeClaims(store.db, a.ws.id)).toHaveLength(1);
    expect(names(result.events, 'claim.acquired')).toBe(1);
  });

  it('emits no event when re-acquiring a claim already held', () => {
    const a = seedWorkstream('A', ['api']);
    acquire(a.project.id, a.ws.id, [area('api')]);
    const again = acquire(a.project.id, a.ws.id, [area('api')]);
    expect(again.events).toEqual([]);
    expect(activeClaims(store.db, a.ws.id)).toHaveLength(1);
  });

  it('releases every active claim, returns the count, and leaves released ones alone', () => {
    const a = seedWorkstream('A', ['api']);
    acquire(a.project.id, a.ws.id, [area('api'), hazard('migrations')]);
    const first = store.write((ctx) => releaseClaims(ctx, a.ws.id));
    expect(first.value).toBe(2);
    expect(names(first.events, 'claim.released')).toBe(2);
    expect(activeClaims(store.db, a.ws.id)).toEqual([]);
    const second = store.write((ctx) => releaseClaims(ctx, a.ws.id));
    expect(second.value).toBe(0);
    expect(second.events).toEqual([]);
  });

  it('renews only active claims of the listed workstreams and stamps updatedAt', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['ui'], a.project);
    const c = seedWorkstream('C', ['api'], a.project);
    acquire(a.project.id, a.ws.id, [area('api')]);
    acquire(a.project.id, b.ws.id, [area('ui')]);
    acquire(a.project.id, c.ws.id, [area('data')]);
    store.write((ctx) => releaseClaims(ctx, c.ws.id));
    const renewed = '2026-10-13T13:00:00.000Z';
    nowMs = Date.parse('2026-10-13T12:30:00.000Z');
    store.write((ctx) => {
      renewClaimLeases(ctx, [a.ws.id, c.ws.id], renewed);
    });
    const [ca] = activeClaims(store.db, a.ws.id);
    expect(ca).toMatchObject({ leaseExpiresAt: renewed, updatedAt: '2026-10-13T12:30:00.000Z' });
    const [cb] = activeClaims(store.db, b.ws.id);
    expect(cb).toMatchObject({ leaseExpiresAt: lease, updatedAt: '2026-10-13T12:00:00.000Z' });
    expect(activeClaims(store.db, c.ws.id)).toEqual([]);
  });

  it('treats an empty renewal list as a no-op', () => {
    const a = seedWorkstream('A', ['api']);
    acquire(a.project.id, a.ws.id, [area('api')]);
    nowMs += 60_000;
    store.write((ctx) => {
      renewClaimLeases(ctx, [], '2026-10-13T13:00:00.000Z');
    });
    expect(activeClaims(store.db, a.ws.id)[0]).toMatchObject({ leaseExpiresAt: lease });
  });
});

describe('claim requests', () => {
  const hz = (name: string) => ({ name, globs: [], commands: [] });
  it.each([
    { name: 'no hazards', areas: ['api', 'ui'], hazards: [], kinds: ['area', 'area'] },
    {
      name: 'all hazards',
      areas: ['migrations', 'deps'],
      hazards: ['migrations', 'deps'],
      kinds: ['hazard', 'hazard'],
    },
    {
      name: 'a mix',
      areas: ['api', 'migrations'],
      hazards: ['migrations'],
      kinds: ['area', 'hazard'],
    },
  ])('$name', ({ areas, hazards, kinds }) => {
    const out = claimRequestsForTask({ areas }, { hazards: hazards.map(hz) });
    expect(out).toEqual(areas.map((name, i) => ({ kind: kinds[i], name })));
  });
});

describe('tool ops', () => {
  it('keeps the first result for an operation ID', () => {
    const { ws } = seedWorkstream();
    const sessionId = mintId('Session');
    store.write((ctx) => {
      insertToolOp(ctx, {
        workstreamId: ws.id,
        sessionId,
        opId: 'op-00000001',
        tool: 'commit',
        result: { sha: 'a' },
      });
    });
    expect(() =>
      store.write((ctx) => {
        insertToolOp(ctx, {
          workstreamId: ws.id,
          sessionId,
          opId: 'op-00000001',
          tool: 'commit',
          result: { sha: 'b' },
        });
      }),
    ).toThrow(/UNIQUE/);
    expect(findToolOp(store.db, ws.id, 'op-00000001')).toEqual({
      tool: 'commit',
      result: { sha: 'a' },
    });
  });
});

describe('listWorkstreams ordering', () => {
  it('orders equal created_at by id, not by storage order', () => {
    const project = seedProject(store);
    const made = ['A', 'B', 'C'].map((title) => seedWorkstream(title, ['api'], project).ws.id);
    // Push the smallest id to the end of the table's scan order.
    store.db.$client
      .prepare('UPDATE workstreams SET rowid = rowid + 1000 WHERE id = ?')
      .run(made[0]);
    expect(listWorkstreams(store.db, {}).map((w) => w.id)).toEqual(made);
  });
});

describe('getWorkstreamRow', () => {
  it('exposes the fence for runners', () => {
    const { ws } = seedWorkstream();
    expect(getWorkstreamRow(store.db, ws.id).fence).toBe(0);
  });
});

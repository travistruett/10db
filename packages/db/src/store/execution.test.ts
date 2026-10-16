import { ConflictError, mintId, WorkstreamState as S } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireClaims, activeClaims, claimRequestsForTask, releaseClaims } from './claims';
import { findToolOp, insertToolOp } from './tool-ops';
import { getSession, insertSession, markSessionStarted } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import {
  acquireLease,
  countLanes,
  getWorkstreamRow,
  insertWorkstream,
  patchWorkstream,
  StaleFenceError,
  transitionWorkstream,
} from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
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
    expect(lanes.byProvider.get('claude')).toBe(2);
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

describe('claim requests', () => {
  it('turns a hazard-named area into a hazard claim', () => {
    expect(
      claimRequestsForTask(
        { areas: ['api', 'migrations'] },
        { hazards: [{ name: 'migrations', globs: [], commands: [] }] },
      ),
    ).toEqual([
      { kind: 'area', name: 'api' },
      { kind: 'hazard', name: 'migrations' },
    ]);
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

describe('getWorkstreamRow', () => {
  it('exposes the fence for runners', () => {
    const { ws } = seedWorkstream();
    expect(getWorkstreamRow(store.db, ws.id).fence).toBe(0);
  });
});

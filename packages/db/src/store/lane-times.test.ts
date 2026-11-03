import { EventType, WorkstreamState as S, TaskStatus } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertEvidence } from './evidence';
import { laneTimesOf, similarTasks } from './lane-times';
import { endSession, insertSession } from './sessions';
import type { Store } from './store';
import { insertTask, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream, transitionWorkstream } from './workstreams';

// Shape spec §8: lane time against a recorded workstream with a gate that waited for its slot.

let store: Store;
let close: () => void;
let nowMs: number;
const at = (hm: string): void => {
  nowMs = Date.parse(`2026-11-01T${hm}:00.000Z`);
};

beforeEach(() => {
  at('09:00');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

function finishedTask(
  title: string,
  opts: { description?: string; gate?: 'events' | 'evidence only' | 'none' } = {},
) {
  const project = seedProject(store);
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title,
      description: opts.description ?? '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  store.write((ctx) => {
    transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
    transitionWorkstream(ctx, ws.id, { to: S.Running, fence: null });
  });
  // One 30-minute session, a 20-minute wait, a second 15-minute session.
  const session = (from: string, to: string): void => {
    at(from);
    const s = store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: `hash-${from}-${title}`,
      }),
    ).value;
    at(to);
    store.write((ctx) => {
      endSession(ctx, s.id, 'done');
    });
  };
  session('09:00', '09:30');
  session('09:50', '10:05');
  store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Verifying, fence: null }));
  const gate = opts.gate ?? 'events';
  // The gate waited from 10:05 to 10:35 for its slot, then ran 10 minutes.
  if (gate === 'events') {
    at('10:35');
    store.write((ctx) => {
      ctx.emit({ type: EventType.GateStarted, entityType: 'workstream', entityId: ws.id });
    });
    at('10:45');
    store.write((ctx) => {
      ctx.emit({ type: EventType.GateFinished, entityType: 'workstream', entityId: ws.id });
    });
  }
  if (gate !== 'none')
    store.write((ctx) =>
      insertEvidence(ctx, {
        workstreamId: ws.id,
        kind: 'gate',
        command: 'make gate',
        exitCode: 0,
        summary: 'pass',
        logPath: null,
        commitShas: [],
      }),
    );
  at('11:00');
  store.write((ctx) => {
    transitionWorkstream(ctx, ws.id, { to: S.Done, fence: null });
    setTaskStatus(ctx, task.id, TaskStatus.Done);
  });
  return { project, task, ws: ws.id };
}

describe('lane time', () => {
  it.each([
    ['sessions and the gate run, not the slot wait', 'events', 55, false],
    ['sessions alone, marked, when the gate ran with no span recorded', 'evidence only', 45, true],
    ['sessions alone, unmarked, when no gate ran', 'none', 45, false],
  ] as const)('counts %s', (_name, gate, minutes, sessionsOnly) => {
    const { task } = finishedTask('Thin scrollbars', { gate });
    expect(laneTimesOf(store.db, [task.id]).get(task.id)).toEqual({
      taskId: task.id,
      minutes,
      sessionsOnly,
    });
  });

  it('finds finished tasks like a query, with lane time, wall time and tokens', () => {
    const { project, task } = finishedTask('Compact density for the board', {
      description: 'Rows shrink',
    });
    expect(similarTasks(store.db, project.id, 'board density', 5)).toEqual([
      {
        taskId: task.id,
        title: 'Compact density for the board',
        laneMinutes: 55,
        sessionsOnly: false,
        wallMinutes: 120,
        tokens: 0,
      },
    ]);
    expect(similarTasks(store.db, project.id, 'unrelated words', 5)).toEqual([]);
  });
});

import {
  mintId,
  ShapeMessageKind,
  ShapeToolInputs,
  type ShapeProposalId,
  type ShapeViewDto,
} from '@10db/contracts';
import { listRehearsals, listShapeFindings, listShapeMessages, patchShape } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeShapeBehaviour, FakeShapeTurn } from '../sessions';
import { must } from './conversation-fixture';
import { SHAPE_AGENTS } from './policy';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §7: opening Convert with an unrehearsed task runs a rehearsal turn, questions appear
// under tasks, and Convert Anyway stops it. The fake adapter is the session boundary.

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture({
    trackedFiles: () => ['src/api/routes.ts', 'src/ui/app.tsx'],
  });
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;
const view = (): ShapeViewDto => f.service.view(shapeId());
const tools = () => f.service.toolsFor({ sessionId: mintId('Session'), shapeId: shapeId() });
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** A goal of two tasks and a loose task, proposed in round 1. */
async function plan(over: { loose?: Record<string, unknown> } = {}): Promise<void> {
  f.state.write((ctx) => {
    patchShape(ctx, shapeId(), { proposeUnlocked: true });
  });
  const m = f.c.say();
  await must(
    tools().propose_plan,
    'propose_plan',
  )(
    ShapeToolInputs.propose_plan.parse({
      draft: {
        goals: [
          {
            key: 'density',
            title: 'Density',
            objective: 'The board is denser.',
            ceremony: 'direct',
            sourceMessageIds: [m],
            tasks: [
              { key: 'cards', title: 'Cards', areas: ['ui'], size: 'S' },
              { key: 'bars', title: 'Scrollbars', areas: ['ui'], size: 'S' },
            ],
          },
        ],
        looseTasks: [
          {
            key: 'abandon',
            title: 'Drop the Abandon strip',
            criteria: ['It is gone'],
            areas: ['ui'],
            size: 'S',
            ceremony: 'direct',
            sourceMessageIds: [m],
            ...over.loose,
          },
        ],
      },
    }),
  );
}

const proposalId = (key: string): ShapeProposalId =>
  must(
    view().proposals.find((p) => p.key === key),
    key,
  ).id;
const hashOf = (taskKey: string): string =>
  must(
    view().rehearsals.find((r) => r.key === taskKey),
    taskKey,
  ).hash;

/** What a reviewer subagent does: goes through the hook, which stamps it, then calls the tool. */
async function reportAs(
  turn: FakeShapeTurn,
  reviewer: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const verdict = turn.guard({
    toolName: 'mcp__10db__report_finding',
    input,
    agentId: 'agent-1',
    agentType: reviewer,
  });
  if (verdict.decision !== 'allow' || !('updatedInput' in verdict))
    throw new Error('the hook did not allow the report');
  return must(
    tools().report_finding,
    'report_finding',
  )(ShapeToolInputs.report_finding.parse(verdict.updatedInput));
}

/** A rehearsal that reads every task it was listed and finds nothing to ask. */
const readsEverything: FakeShapeBehaviour = async (turn) => {
  for (const [, effortKey, taskKey, taskHash] of turn.message.matchAll(
    /effortKey (\S+) · taskKey (\S+) · taskHash (\S+)/g,
  ))
    await reportAs(turn, 'rehearsal', {
      effortKey,
      taskKey,
      taskHash,
      finding: { kind: 'none' },
    });
  return { text: 'No questions.' };
};

describe('Rehearse', () => {
  it('queues a turn listing each unrehearsed task at its hash, with the three reviewers as agents', async () => {
    await plan();
    f.adapter.shapeBehaviour = () => new Promise(() => undefined);
    expect(f.service.rehearse(shapeId())).toEqual({ status: 'started', tasks: 3 });
    await tick();
    const session = must(f.adapter.shapeSessions[0], 'a session').spec;
    for (const key of ['cards', 'bars', 'abandon'])
      expect(session.prompt).toContain(`taskKey ${key} · taskHash ${hashOf(key)}`);
    expect(session.prompt).toContain('Title: Cards');
    expect(Object.keys(session.agents).sort()).toEqual([
      'engineering',
      'rehearsal',
      'researcher',
      'scope',
    ]);
    expect(session.agents).toEqual(SHAPE_AGENTS);
    expect(session.agents['rehearsal']?.tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'mcp__10db__report_finding',
    ]);
    const note = listShapeMessages(f.c.store.db, shapeId()).find(
      (m) => m.kind === ShapeMessageKind.Rehearse,
    );
    expect(note?.body).toBe('Rehearsing 3 tasks');
    expect(view().turn).toMatchObject({ running: true, rehearsing: true });
  });

  it('says running while one is queued or running, and does not queue a second', async () => {
    await plan();
    f.adapter.shapeBehaviour = () => new Promise(() => undefined);
    f.service.rehearse(shapeId());
    expect(f.service.rehearse(shapeId())).toEqual({ status: 'running', tasks: 3 });
    await tick();
    expect(f.adapter.shapeSessions).toHaveLength(1);
  });

  it('marks every task read, and a second Rehearse finds nothing to do', async () => {
    await plan();
    f.adapter.shapeBehaviour = readsEverything;
    f.service.rehearse(shapeId());
    await f.service.settled(shapeId());
    expect(view().rehearsals.map((r) => r.rehearsed)).toEqual([true, true, true]);
    expect(listRehearsals(f.c.store.db, shapeId())).toHaveLength(3);
    expect(f.service.rehearse(shapeId())).toEqual({ status: 'nothing', tasks: 0 });
    expect(view().turn.rehearsing).toBe(false);
  });

  it('can be narrowed to the proposals the builder is converting', async () => {
    await plan();
    f.adapter.shapeBehaviour = readsEverything;
    expect(f.service.rehearse(shapeId(), [proposalId('abandon')])).toEqual({
      status: 'started',
      tasks: 1,
    });
    await f.service.settled(shapeId());
    expect(view().rehearsals.map((r) => [r.key, r.rehearsed])).toEqual([
      ['cards', false],
      ['bars', false],
      ['abandon', true],
    ]);
  });

  it('leaves a task the turn skipped as "Not rehearsed", and says so in the conversation', async () => {
    await plan();
    f.adapter.shapeBehaviour = async (turn) => {
      await reportAs(turn, 'rehearsal', {
        effortKey: 'abandon',
        taskKey: 'abandon',
        taskHash: hashOf('abandon'),
        finding: { kind: 'none' },
      });
      return { text: 'Done.' };
    };
    f.service.rehearse(shapeId());
    await f.service.settled(shapeId());
    expect(view().rehearsals.map((r) => [r.key, r.rehearsed])).toEqual([
      ['cards', false],
      ['bars', false],
      ['abandon', true],
    ]);
    const notices = listShapeMessages(f.c.store.db, shapeId())
      .filter((m) => m.kind === ShapeMessageKind.Notice)
      .map((m) => m.body);
    expect(notices).toEqual([
      "The rehearsal didn't read 2 of 3 tasks; they show as Not rehearsed.",
    ]);
  });

  it('shows a question under its task, and the same task read again after an edit is asked afresh', async () => {
    await plan();
    f.adapter.shapeBehaviour = async (turn) => {
      await reportAs(turn, 'rehearsal', {
        effortKey: 'density',
        taskKey: 'cards',
        taskHash: hashOf('cards'),
        final: true,
        finding: { kind: 'question', text: 'Card padding, or rows per column?' },
      });
      return { text: '1 question.' };
    };
    f.service.rehearse(shapeId(), [proposalId('density')]);
    await f.service.settled(shapeId());
    expect(view().findings).toMatchObject([
      {
        effortKey: 'density',
        taskKey: 'cards',
        reviewer: 'rehearsal',
        kind: 'question',
        text: 'Card padding, or rows per column?',
        state: 'open',
      },
    ]);
    expect(view().rehearsals.find((r) => r.key === 'cards')?.rehearsed).toBe(true);
  });
});

describe('Convert Anyway', () => {
  it('stops the rehearsal turn and converts, with a message queued behind it, leaving no mark', async () => {
    await plan();
    f.adapter.shapeBehaviour = (turn) =>
      new Promise((_resolve, reject) => {
        turn.signal.addEventListener('abort', () => {
          reject(new Error('interrupted'));
        });
      });
    f.service.rehearse(shapeId());
    await tick();
    f.service.send(shapeId(), 'and one more thing');
    expect(view().turn).toMatchObject({ running: true, rehearsing: true, queued: 1 });
    const ids = view()
      .proposals.filter((p) => p.state === 'pending')
      .map((p) => p.id);
    const outcome = await f.service.convert(shapeId(), ids, { interrupt: true });
    expect(outcome).toMatchObject({ ok: true, createdNow: 2 });
    expect(listRehearsals(f.c.store.db, shapeId())).toEqual([]);
    expect(view().proposals.every((p) => p.state === 'accepted')).toBe(true);
  });

  it('drops a rehearsal queued behind a message turn, so none runs after the convert', async () => {
    await plan();
    const seen: string[] = [];
    f.adapter.shapeBehaviour = (turn) => {
      seen.push(turn.message);
      return new Promise((_resolve, reject) => {
        turn.signal.addEventListener('abort', () => {
          reject(new Error('interrupted'));
        });
      });
    };
    f.service.send(shapeId(), 'one more thing');
    await tick();
    expect(f.service.rehearse(shapeId())).toEqual({ status: 'started', tasks: 3 });
    expect(view().turn).toMatchObject({ running: true, rehearsing: true, queued: 1 });
    const ids = view()
      .proposals.filter((p) => p.state === 'pending')
      .map((p) => p.id);
    const outcome = await f.service.convert(shapeId(), ids, { interrupt: true });
    expect(outcome).toMatchObject({ ok: true, createdNow: 2 });
    await f.service.settled(shapeId());
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen.some((m) => m.includes('Rehearse:'))).toBe(false);
    expect(view().turn).toMatchObject({ running: false, rehearsing: false, queued: 0 });
    const notices = listShapeMessages(f.c.store.db, shapeId())
      .filter((m) => m.kind === ShapeMessageKind.Notice)
      .map((m) => m.body);
    expect(notices.some((b) => b.includes('Not rehearsed'))).toBe(false);
  });
});

describe('a builder’s edit', () => {
  async function twoQuestions(): Promise<void> {
    await plan();
    f.adapter.shapeBehaviour = async (turn) => {
      for (const taskKey of ['cards', 'bars'])
        await reportAs(turn, 'rehearsal', {
          effortKey: 'density',
          taskKey,
          taskHash: hashOf(taskKey),
          final: true,
          finding: { kind: 'question', text: `Which ${taskKey}?` },
        });
      return { text: '2 questions.' };
    };
    f.service.rehearse(shapeId());
    await f.service.settled(shapeId());
  }

  it('answers the questions of the task it touched, and leaves its sibling’s alone', async () => {
    await twoQuestions();
    f.service.editProposal(shapeId(), proposalId('density'), {
      'tasks.cards.title': 'Compact cards',
    });
    expect(view().findings.map((x) => [x.taskKey, x.state, x.how])).toEqual([
      ['cards', 'resolved', 'answered by your edit'],
      ['bars', 'open', null],
    ]);
    expect(view().rehearsals.map((r) => [r.key, r.rehearsed])).toEqual([
      ['cards', false],
      ['bars', true],
      ['abandon', false],
    ]);
  });

  it('pinning a task’s ceremony answers nothing and does not make it unrehearsed', async () => {
    await twoQuestions();
    f.service.editProposal(shapeId(), proposalId('abandon'), { ceremony: 'spec' });
    expect(view().findings.every((x) => x.state === 'open')).toBe(true);
    expect(view().rehearsals.find((r) => r.key === 'bars')?.rehearsed).toBe(true);
  });

  it('dismissing a finding settles it and tells the session on its next turn', async () => {
    await plan();
    f.adapter.shapeBehaviour = async (turn) => {
      if (turn.number === 1)
        await reportAs(turn, 'scope', {
          effortKey: 'density',
          finding: { kind: 'finding', severity: 'medium', text: 'Names no owner' },
        });
      return { text: 'ok' };
    };
    f.service.send(shapeId(), 'review it');
    await f.service.settled(shapeId());
    const id = must(listShapeFindings(f.c.store.db, shapeId())[0], 'a finding').id;
    f.service.dismissFinding(shapeId(), id, 'out of scope for now');
    expect(view().findings[0]).toMatchObject({ state: 'dismissed', how: 'out of scope for now' });
    f.service.send(shapeId(), 'anything else?');
    await f.service.settled(shapeId());
    const second = must(f.adapter.shapeSessions[0], 'a session').sent.at(-1);
    expect(second).toContain('The builder dismissed the scope finding on density: Names no owner');
  });
});

describe('the ceremony in the view', () => {
  it('forces spec for an effort in an area that shares a file with the one-way paths', async () => {
    await plan();
    expect(view().ceremony.map((c) => [c.key, c.ceremony, c.reasons])).toEqual([
      ['density', 'direct', []],
      ['abandon', 'direct', []],
    ]);
    f.service.setOneWayPaths(f.c.project.id, ['src/ui/**']);
    expect(view().ceremony.map((c) => [c.key, c.ceremony, c.reasons])).toEqual([
      ['density', 'spec', ['one_way_path']],
      ['abandon', 'spec', ['one_way_path']],
    ]);
  });

  it('reads "spec skipped by you" once the builder pins direct, and a spec once written', async () => {
    await plan();
    f.service.setOneWayPaths(f.c.project.id, ['src/ui/**']);
    f.service.editProposal(shapeId(), proposalId('abandon'), { ceremony: 'direct' });
    await must(tools().write_spec, 'write_spec')({ effortKey: 'density', markdown: '# Density' });
    expect(
      view().ceremony.map((c) => [c.key, c.ceremony, c.skippedByYou, c.specWritten, c.spec]),
    ).toEqual([
      ['density', 'spec', false, true, '# Density'],
      ['abandon', 'direct', true, false, null],
    ]);
  });

  it('tells the session which efforts still need a spec when it proposes', async () => {
    f.service.setOneWayPaths(f.c.project.id, ['src/ui/**']);
    f.state.write((ctx) => {
      patchShape(ctx, shapeId(), { proposeUnlocked: true });
    });
    const m = f.c.say();
    const result = await must(
      tools().propose_plan,
      'propose_plan',
    )(
      ShapeToolInputs.propose_plan.parse({
        draft: {
          looseTasks: [
            {
              key: 'a',
              title: 'A',
              criteria: ['x'],
              areas: ['ui'],
              size: 'S',
              ceremony: 'direct',
              sourceMessageIds: [m],
            },
          ],
        },
      }),
    );
    expect(result).toMatchObject({ needSpec: ['a'] });
  });

  it('defaults to no one-way path in a project that is not 10db', () => {
    expect(f.service.oneWayPaths(f.c.project.id)).toEqual([]);
    expect(f.service.setOneWayPaths(f.c.project.id, ['x/**'])).toEqual(['x/**']);
  });
});

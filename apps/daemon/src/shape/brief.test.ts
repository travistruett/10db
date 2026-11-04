import {
  PrincipleKind,
  type KnowledgeTarget,
  type PrincipleKind as PrincipleKindValue,
} from '@10db/contracts';
import { insertPrinciple, insertSource, retirePrinciple, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §9, §14 slice 3: a Plan conversation starts briefed with the builder-wide and project
// policies and heuristics, as a lane is, and a session that moved on at 70% of its context is told
// them again. Area principles stay reachable through find_records.

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture();
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;

function principle(
  target: KnowledgeTarget,
  statement: string,
  kind: PrincipleKindValue,
  topicKey: string,
) {
  return f.c.store.write((ctx) =>
    insertPrinciple(ctx, {
      target,
      statement,
      kind,
      topicKey,
      status: 'confirmed',
      sourceId: insertSource(ctx, 'builder', {}),
      sourceQuote: null,
      speaker: 'me',
      confirmedBy: 'me',
    }),
  ).value;
}

const project = () => ({ scope: 'project' as const, projectId: f.c.project.id });

function seedRules(): void {
  principle(project(), 'Never sleep in tests', PrincipleKind.Policy, 'tests.no-sleeps');
  principle({ scope: 'you' }, 'Always write the test first', PrincipleKind.Policy, 'tests.first');
  principle(project(), 'Prefer small tasks', PrincipleKind.Heuristic, 'tasks.small');
  principle(project(), 'The board is the product', PrincipleKind.Belief, 'board.product');
  principle(
    { scope: 'area', projectId: f.c.project.id, area: 'api' },
    'Never break the API contract',
    PrincipleKind.Policy,
    'api.contract',
  );
  const other = seedProject(f.c.store, { name: 'beta' });
  principle(
    { scope: 'project', projectId: other.id },
    'Never ship beta on Fridays',
    PrincipleKind.Policy,
    'beta.fridays',
  );
  const retired = principle(project(), 'Always use tabs', PrincipleKind.Policy, 'style.tabs');
  f.c.store.write((ctx) => retirePrinciple(ctx, retired.id, 'me', 'No longer true'));
}

describe('a new conversation’s first turn', () => {
  it('carries the builder-wide and project policies and heuristics, as a lane gets them', async () => {
    seedRules();
    f.service.send(shapeId(), 'Make the board denser.');
    await f.service.settled(shapeId());
    const prompt = must(f.adapter.shapeSessions[0], 'the first session').spec.prompt;
    expect(prompt).toContain('Policies (you must follow these):');
    expect(prompt).toContain('[tests.no-sleeps] Never sleep in tests');
    expect(prompt).toContain('[tests.first] Always write the test first');
    expect(prompt).toContain('Heuristics (prefer these):');
    expect(prompt).toContain('[tasks.small] Prefer small tasks');
    // Beliefs are context, not rules; area principles are found with find_records; another
    // project's and a retired rule never apply.
    expect(prompt).not.toContain('The board is the product');
    expect(prompt).not.toContain('Never break the API contract');
    expect(prompt).not.toContain('Never ship beta on Fridays');
    expect(prompt).not.toContain('Always use tabs');
    expect(prompt.indexOf('Policies')).toBeLessThan(prompt.indexOf('Make the board denser.'));
  });

  it('says nothing about rules when there are none', async () => {
    f.service.send(shapeId(), 'Make the board denser.');
    await f.service.settled(shapeId());
    expect(must(f.adapter.shapeSessions[0], 'the first session').spec.prompt).not.toMatch(
      /Policies|Heuristics/,
    );
  });
});

describe('a session past 70% of its context', () => {
  it('is told the rules again when the fresh session starts from the digest', async () => {
    seedRules();
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'first', contextPercent: 71 });
    f.service.send(shapeId(), 'first thing');
    await f.service.settled(shapeId());
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'fresh', contextPercent: 5 });
    f.service.send(shapeId(), 'second thing');
    await f.service.settled(shapeId());
    const fresh = must(f.adapter.shapeSessions[1], 'the fresh session').spec.prompt;
    expect(fresh).toContain('continues in a fresh session');
    expect(fresh).toContain('[tests.no-sleeps] Never sleep in tests');
    expect(fresh).toContain('[tasks.small] Prefer small tasks');
  });

  it('sees a rule recorded after the first session started', async () => {
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'first', contextPercent: 71 });
    f.service.send(shapeId(), 'first thing');
    await f.service.settled(shapeId());
    principle(project(), 'Never sleep in tests', PrincipleKind.Policy, 'tests.no-sleeps');
    f.service.send(shapeId(), 'second thing');
    await f.service.settled(shapeId());
    expect(must(f.adapter.shapeSessions[1], 'the fresh session').spec.prompt).toContain(
      '[tests.no-sleeps] Never sleep in tests',
    );
  });
});

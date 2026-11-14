import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { LegacyRoutingError, readLegacyRouting } from './legacy-routing';
import {
  seedLegacyBinding,
  seedLegacyFlow,
  seedLegacyPatterns,
  seedLegacyPersonaPin,
  seedLegacyProjectFlow,
  seedLegacyRoleSetting,
  seedLegacyTaskRouting,
} from './legacy-routing-fixtures';
import type { Store } from './store';
import { insertPersona } from './team';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('readLegacyRouting', () => {
  it('reads every table the playbook replaces, and nothing is written by reading', () => {
    const project = seedProject(store);
    const persona = store.write((ctx) => {
      const made = insertPersona(ctx, {
        key: 'deep-reviewer',
        name: 'Deep reviewer',
        role: 'review',
        tools: 'read_only',
        instructions: 'Review.',
      });
      seedLegacyPersonaPin(ctx, made.id, {
        minimumScore: 50,
        modelPin: { model: 'test-model', effort: 'high' },
      });
      seedLegacyBinding(ctx, { projectId: project.id, role: 'review', personaId: made.id });
      return made;
    }).value;
    const flow = store.write((ctx) =>
      seedLegacyFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] }),
    ).value;
    store.write((ctx) => {
      seedLegacyProjectFlow(ctx, project.id, flow.id);
      seedLegacyRoleSetting(ctx, {
        role: 'review',
        projectId: null,
        setting: { kind: 'automatic' },
      });
      seedLegacyPatterns(ctx, project.id, [
        { name: 'Risky', match: { riskTags: ['auth'] }, setting: { kind: 'top_of_tier' } },
      ]);
    });
    const task = store.write((ctx) => {
      const made = insertTask(ctx, project.id, {
        title: 'Fix login',
        acceptanceCriteria: ['Works'],
        areas: ['api'],
      });
      seedLegacyTaskRouting(ctx, made.id, { riskTags: ['auth'], flowId: flow.id });
      return made;
    }).value;

    const legacy = readLegacyRouting(store.db);
    expect(legacy.flows).toEqual([
      {
        id: flow.id,
        name: 'quick',
        steps: [{ role: 'implement', need: 40, skip: [], persona: null }],
      },
    ]);
    expect(legacy.roleSettings).toEqual([
      { role: 'review', projectId: null, setting: { kind: 'automatic' } },
    ]);
    expect(legacy.patterns.map((p) => [p.name, p.projectId])).toEqual([['Risky', project.id]]);
    expect(legacy.bindings).toEqual([
      { projectId: project.id, role: 'review', personaId: persona.id },
    ]);
    expect(legacy.personas).toContainEqual({
      id: persona.id,
      key: 'deep-reviewer',
      role: 'review',
      minimumScore: 50,
      modelPin: { model: 'test-model', effort: 'high' },
      archived: false,
    });
    expect(legacy.tasks).toEqual([
      { id: task.id, projectId: project.id, status: 'open', riskTags: ['auth'], flowId: flow.id },
    ]);
    expect(legacy.projects).toEqual([{ id: project.id, flowId: flow.id }]);
  });

  it('names the table and row of one that does not parse, and still reads the rest', () => {
    const [good, bad] = store.write((ctx) => [
      seedLegacyFlow(ctx, { name: 'good', steps: [{ role: 'implement', need: 40 }] }),
      seedLegacyFlow(ctx, { name: 'bad', steps: [{ role: 'implement', need: 40 }] }),
    ]).value;
    if (!good || !bad) throw new Error('flows were not seeded');
    store.write((ctx) => {
      ctx.tx.run(sql`UPDATE flows SET steps = '"not steps"' WHERE id = ${bad.id}`);
    });

    const legacy = readLegacyRouting(store.db);
    expect(legacy.flows.map((f) => f.id)).toEqual([good.id]);
    expect(legacy.unreadable).toHaveLength(1);
    const [error] = legacy.unreadable;
    expect(error).toBeInstanceOf(LegacyRoutingError);
    expect(error).toMatchObject({ table: 'flows', rowId: bad.id });
  });
});

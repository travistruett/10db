import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertFlow } from './flows';
import { readLegacyRouting } from './legacy-routing';
import { setPatterns, setRoleSetting } from './model-settings';
import { patchProject } from './projects';
import type { Store } from './store';
import { insertPersona, setTeam } from './team';
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
    const persona = store.write((ctx) =>
      insertPersona(ctx, {
        key: 'deep-reviewer',
        name: 'Deep reviewer',
        role: 'review',
        tools: 'read_only',
        instructions: 'Review.',
        minimumScore: 50,
        modelPin: { model: 'test-model', effort: 'high' },
      }),
    ).value;
    store.write((ctx) => {
      setTeam(ctx, project.id, {
        bindings: [{ role: 'review', personaId: persona.id }],
        members: [],
      });
    });
    const flow = store.write((ctx) =>
      insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] }),
    ).value;
    store.write((ctx) => {
      patchProject(ctx, project.id, { flowId: flow.id });
    });
    store.write((ctx) => {
      setRoleSetting(ctx, { role: 'review', projectId: null, setting: { kind: 'automatic' } });
    });
    store.write((ctx) => {
      setPatterns(ctx, project.id, [
        {
          name: 'Risky',
          match: { roles: [], riskTags: ['auth'], areas: [], retryOnly: false },
          setting: { kind: 'top_of_tier' },
        },
      ]);
    });
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Fix login',
        acceptanceCriteria: ['Works'],
        areas: ['api'],
        riskTags: ['auth'],
        flowId: flow.id,
      }),
    ).value;

    const legacy = readLegacyRouting(store.db);
    expect(legacy.flows.map((f) => f.name)).toEqual(['quick']);
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
});

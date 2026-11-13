import { NotFoundError, mintId, type PlaybookInput } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { getPlaybook, setPlaybook } from './playbook';
import type { Store } from './store';
import { insertPersona } from './team';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const set = (projectId: Parameters<typeof getPlaybook>[1], input: PlaybookInput) =>
  store.write((ctx) => setPlaybook(ctx, projectId, input));

const reviewer = {
  key: 'strict-reviewer',
  name: 'Strict reviewer',
  role: 'review',
  tools: 'read_only',
  instructions: 'Review the diff.',
} as const;

describe('playbook overrides', () => {
  it('keeps the global scope and a project scope apart, and clears only the scope written', () => {
    const project = seedProject(store);
    set(null, {
      rows: [{ rigor: 'standard', steps: ['implement', 'review', 'qa'] }],
      cells: [{ rigor: 'standard', role: 'review', effort: 'low' }],
    });
    set(project.id, {
      rows: [{ rigor: 'standard', steps: ['implement'] }],
      cells: [
        { rigor: 'standard', role: 'review', model: { kind: 'automatic', minimum: 60 } },
        { rigor: 'standard', role: 'implement', effort: 'high' },
      ],
    });

    const global = getPlaybook(store.db, null);
    expect(global.rows).toEqual([{ rigor: 'standard', steps: ['implement', 'review', 'qa'] }]);
    expect(global.cells).toEqual([
      { rigor: 'standard', role: 'review', personaId: null, model: null, effort: 'low' },
    ]);
    const own = getPlaybook(store.db, project.id);
    expect(own.rows).toEqual([{ rigor: 'standard', steps: ['implement'] }]);
    expect(own.cells.map((c) => [c.role, c.effort, c.model])).toEqual([
      ['implement', 'high', null],
      ['review', null, { kind: 'automatic', minimum: 60 }],
    ]);

    set(project.id, {
      rows: [{ rigor: 'standard', steps: null }],
      cells: [{ rigor: 'standard', role: 'review' }],
    });
    expect(getPlaybook(store.db, project.id).rows).toEqual([]);
    expect(getPlaybook(store.db, project.id).cells.map((c) => c.role)).toEqual(['implement']);
    expect(getPlaybook(store.db, null)).toEqual(global);
  });

  it('rewrites a cell in place instead of adding a second one', () => {
    set(null, { cells: [{ rigor: 'careful', role: 'plan', effort: 'low' }] });
    set(null, { cells: [{ rigor: 'careful', role: 'plan', effort: 'high' }] });
    expect(getPlaybook(store.db, null).cells).toEqual([
      { rigor: 'careful', role: 'plan', personaId: null, model: null, effort: 'high' },
    ]);
  });

  it('refuses a second global cell for one rigor and role at the table', () => {
    const insert = () =>
      store.write((ctx) =>
        ctx.tx
          .insert(schema.playbookCells)
          .values({ rigor: 'light', role: 'implement', projectId: null, updatedAt: ctx.now })
          .run(),
      );
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it('keeps a cell persona and refuses one that does not exist', () => {
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    set(null, { cells: [{ rigor: 'careful', role: 'review', personaId: persona.id }] });
    expect(getPlaybook(store.db, null).cells[0]?.personaId).toBe(persona.id);
    expect(() =>
      set(null, { cells: [{ rigor: 'careful', role: 'qa', personaId: mintId('Persona') }] }),
    ).toThrow(NotFoundError);
  });

  it('refuses a project scope for a project that does not exist', () => {
    expect(() =>
      set(mintId('Project'), { rows: [{ rigor: 'light', steps: ['implement'] }] }),
    ).toThrow(NotFoundError);
  });
});

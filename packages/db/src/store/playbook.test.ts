import {
  NotFoundError,
  mintId,
  type PlaybookInput,
  type Rigor,
  type StepRole,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { getPlaybook, setPlaybook, type PlaybookRowOverride } from './playbook';
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

const row = (
  rigor: Rigor,
  steps: StepRole[] | null,
  process: Partial<Omit<PlaybookRowOverride, 'rigor' | 'steps'>> = {},
): PlaybookRowOverride => ({
  rigor,
  steps,
  reviewRounds: null,
  fixBy: null,
  approvesPlan: null,
  ships: null,
  ...process,
});

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
    expect(global.rows).toEqual([row('standard', ['implement', 'review', 'qa'])]);
    expect(global.cells).toEqual([
      { rigor: 'standard', role: 'review', personaId: null, model: null, effort: 'low' },
    ]);
    const own = getPlaybook(store.db, project.id);
    expect(own.rows).toEqual([row('standard', ['implement'])]);
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

  it('keeps the steps when only a process field is set, per scope', () => {
    const project = seedProject(store);
    set(null, { rows: [{ rigor: 'standard', steps: ['implement', 'review', 'qa'] }] });
    set(null, { rows: [{ rigor: 'standard', reviewRounds: 2 }] });
    set(null, { rows: [{ rigor: 'standard', fixBy: 'fresh', approvesPlan: false }] });
    set(null, { rows: [{ rigor: 'standard', ships: 'alone' }] });
    expect(getPlaybook(store.db, null).rows).toEqual([
      row('standard', ['implement', 'review', 'qa'], {
        reviewRounds: 2,
        fixBy: 'fresh',
        approvesPlan: false,
        ships: 'alone',
      }),
    ]);

    set(project.id, { rows: [{ rigor: 'standard', reviewRounds: 0 }] });
    expect(getPlaybook(store.db, project.id).rows).toEqual([
      row('standard', null, { reviewRounds: 0 }),
    ]);
    expect(getPlaybook(store.db, null).rows[0]?.reviewRounds).toBe(2);
  });

  it('keeps the process fields when only the steps change', () => {
    set(null, { rows: [{ rigor: 'careful', reviewRounds: 3, approvesPlan: true }] });
    set(null, { rows: [{ rigor: 'careful', steps: ['plan', 'implement'] }] });
    expect(getPlaybook(store.db, null).rows).toEqual([
      row('careful', ['plan', 'implement'], { reviewRounds: 3, approvesPlan: true }),
    ]);
  });

  it('deletes a row once every field is cleared, and not before', () => {
    set(null, { rows: [{ rigor: 'light', steps: ['implement'], reviewRounds: 1 }] });
    set(null, { rows: [{ rigor: 'light', steps: null }] });
    expect(getPlaybook(store.db, null).rows).toEqual([row('light', null, { reviewRounds: 1 })]);
    set(null, { rows: [{ rigor: 'light', reviewRounds: null }] });
    expect(getPlaybook(store.db, null).rows).toEqual([]);
    expect(store.db.select().from(schema.playbookRows).all()).toEqual([]);
  });

  it('reads a row stored with steps only, from before the process fields', () => {
    store.write((ctx) =>
      ctx.tx
        .insert(schema.playbookRows)
        .values({ rigor: 'light', projectId: null, steps: ['implement'], updatedAt: ctx.now })
        .run(),
    );
    expect(getPlaybook(store.db, null).rows).toEqual([row('light', ['implement'])]);
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

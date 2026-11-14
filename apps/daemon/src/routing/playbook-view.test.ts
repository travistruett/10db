import { Rigor, StepRole, type CellSetting } from '@10db/contracts';
import type { PlaybookCellOverride, PlaybookOverrides } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CELLS, DEFAULT_ROWS } from './playbook-defaults';
import { playbookView } from './playbook-view';
import type { PlaybookScopes } from './playbook';

const NONE: PlaybookOverrides = { rows: [], cells: [] };

const cell = (
  rigor: Rigor,
  role: StepRole,
  fields: Partial<CellSetting>,
): PlaybookCellOverride => ({ rigor, role, personaId: null, model: null, effort: null, ...fields });

const scopes = (
  global: Partial<PlaybookOverrides> = {},
  project: Partial<PlaybookOverrides> | null = null,
): PlaybookScopes => ({
  global: { ...NONE, ...global },
  project: project === null ? null : { ...NONE, ...project },
});

const standardReview = (view: ReturnType<typeof playbookView>) => {
  const found = view.cells.find((c) => c.rigor === Rigor.Standard && c.role === StepRole.Review);
  if (found === undefined) throw new Error('no Standard review cell');
  return found;
};
const stepsOf = (view: ReturnType<typeof playbookView>, rigor: Rigor) =>
  view.rows.find((r) => r.rigor === rigor)?.steps;

describe('playbookView: what a scope sees, and where each value comes from', () => {
  it('is 10db’s defaults, sourced as default, when nothing is overridden', () => {
    const view = playbookView(scopes());
    expect(view.rows.map((r) => r.rigor)).toEqual(['light', 'standard', 'careful', 'critical']);
    for (const row of view.rows)
      expect(row.steps).toEqual({ value: DEFAULT_ROWS[row.rigor], source: 'default' });
    expect(standardReview(view)).toMatchObject({
      personaId: { value: null, source: 'default' },
      model: { value: DEFAULT_CELLS[Rigor.Standard][StepRole.Review]?.model, source: 'default' },
      effort: { value: null, source: 'default' },
    });
  });

  it('has a cell for every rigor and role, empty where no default names one', () => {
    const view = playbookView(scopes());
    expect(view.cells).toHaveLength(Object.values(Rigor).length * Object.values(StepRole).length);
    const qaOnLight = view.cells.find((c) => c.rigor === Rigor.Light && c.role === StepRole.Qa);
    expect(qaOnLight).toMatchObject({ model: { value: null, source: 'default' } });
  });

  it('takes a global row and cell over the default, field by field', () => {
    const view = playbookView(
      scopes({
        rows: [{ rigor: Rigor.Standard, steps: [StepRole.Implement] }],
        cells: [cell(Rigor.Standard, StepRole.Review, { effort: 'high' })],
      }),
    );
    expect(stepsOf(view, Rigor.Standard)).toEqual({ value: ['implement'], source: 'global' });
    expect(standardReview(view)).toMatchObject({
      effort: { value: 'high', source: 'global' },
      model: { source: 'default' },
    });
  });

  it('takes the project’s field over the global one and leaves a field it does not set to the global', () => {
    const view = playbookView(
      scopes(
        {
          cells: [
            cell(Rigor.Standard, StepRole.Review, {
              effort: 'low',
              model: { kind: 'tier', tier: 'capable' },
            }),
          ],
        },
        {
          rows: [{ rigor: Rigor.Standard, steps: [StepRole.Implement, StepRole.Qa] }],
          cells: [cell(Rigor.Standard, StepRole.Review, { effort: 'max' })],
        },
      ),
    );
    expect(stepsOf(view, Rigor.Standard)).toEqual({
      value: ['implement', 'qa'],
      source: 'project',
    });
    expect(standardReview(view)).toMatchObject({
      effort: { value: 'max', source: 'project' },
      model: { value: { kind: 'tier', tier: 'capable' }, source: 'global' },
    });
  });

  it('ignores the project scope when there is none, so a global view never says project', () => {
    const view = playbookView(
      scopes({ rows: [{ rigor: Rigor.Light, steps: [StepRole.Implement, StepRole.Review] }] }),
    );
    expect(stepsOf(view, Rigor.Light)?.source).toBe('global');
  });
});

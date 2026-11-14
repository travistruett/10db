import {
  RIGORS,
  StepRole,
  type CellSetting,
  type PlaybookCellDto,
  type PlaybookDto,
  type PlaybookRowDto,
  type PlaybookSource,
  type Rigor,
} from '@10db/contracts';
import { DEFAULT_CELLS, DEFAULT_ROWS } from './playbook-defaults';
import type { PlaybookScopes } from './playbook';

const ROLES: readonly StepRole[] = Object.values(StepRole);

/** The scopes that can set a value, strongest first, each with the name the builder sees it under. */
function layers(playbook: PlaybookScopes) {
  return [
    ...(playbook.project === null ? [] : [{ source: 'project' as const, scope: playbook.project }]),
    { source: 'global' as const, scope: playbook.global },
  ];
}

/** The first non-null field a layer sets, else the default's, with who set it. */
function pick<K extends keyof CellSetting>(
  field: K,
  found: readonly { readonly source: PlaybookSource; readonly cell: CellSetting }[],
  fallback: CellSetting | undefined,
): { value: CellSetting[K]; source: PlaybookSource } {
  const set = found.find((f) => f.cell[field] !== null);
  if (set !== undefined) return { value: set.cell[field], source: set.source };
  return { value: fallback?.[field] ?? null, source: 'default' };
}

/**
 * The playbook as one scope sees it: for each rigor the steps it runs, and for each rigor and role its
 * cell, every value with the scope that set it (a project's own, else the global one, else 10db's default).
 * A cell is given for every role, empty where nothing names one, so a form can show a row's added step.
 */
export function playbookView(playbook: PlaybookScopes): PlaybookDto {
  const sources = layers(playbook);
  const rows = RIGORS.map((rigor: Rigor): PlaybookRowDto => {
    for (const { source, scope } of sources) {
      const row = scope.rows.find((r) => r.rigor === rigor);
      if (row !== undefined) return { rigor, steps: { value: [...row.steps], source } };
    }
    return { rigor, steps: { value: [...DEFAULT_ROWS[rigor]], source: 'default' } };
  });
  const cells = RIGORS.flatMap((rigor) =>
    ROLES.map((role): PlaybookCellDto => {
      const found = sources.flatMap(({ source, scope }) =>
        scope.cells
          .filter((c) => c.rigor === rigor && c.role === role)
          .map((cell) => ({ source, cell })),
      );
      const fallback = DEFAULT_CELLS[rigor][role];
      return {
        rigor,
        role,
        personaId: pick('personaId', found, fallback),
        model: pick('model', found, fallback),
        effort: pick('effort', found, fallback),
      };
    }),
  );
  return { rows, cells };
}

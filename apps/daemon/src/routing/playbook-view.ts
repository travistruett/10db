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
import { DEFAULT_CELLS, DEFAULT_PROCESS, DEFAULT_ROWS } from './playbook-defaults';
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
 * The playbook as one scope sees it: for each rigor the steps it runs and its process, and for each rigor and role its
 * cell, every value with the scope that set it (a project's own, else the global one, else 10db's default).
 * A cell is given for every role, empty where nothing names one, so a form can show a row's added step.
 */
export function playbookView(playbook: PlaybookScopes): PlaybookDto {
  const sources = layers(playbook);
  const rows = RIGORS.map((rigor: Rigor): PlaybookRowDto => {
    const found = sources.flatMap(({ source, scope }) =>
      scope.rows.filter((r) => r.rigor === rigor).map((row) => ({ source, row })),
    );
    const fallback = DEFAULT_PROCESS[rigor];
    const steps = found.find((f) => f.row.steps !== null);
    const rounds = found.find((f) => f.row.reviewRounds !== null);
    const fix = found.find((f) => f.row.fixBy !== null);
    const approves = found.find((f) => f.row.approvesPlan !== null);
    return {
      rigor,
      steps: {
        value: [...(steps?.row.steps ?? DEFAULT_ROWS[rigor])],
        source: steps?.source ?? 'default',
      },
      reviewRounds: {
        value: rounds?.row.reviewRounds ?? fallback.reviewRounds,
        source: rounds?.source ?? 'default',
      },
      fixBy: { value: fix?.row.fixBy ?? fallback.fixBy, source: fix?.source ?? 'default' },
      approvesPlan: {
        value: approves?.row.approvesPlan ?? fallback.approvesPlan,
        source: approves?.source ?? 'default',
      },
    };
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

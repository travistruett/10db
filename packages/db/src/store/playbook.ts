import {
  EventType,
  NotFoundError,
  PlaybookInput,
  RIGORS,
  StepRole,
  type CellSetting,
  type Effort,
  type ModelSetting,
  type PersonaId,
  type ProjectId,
  type Rigor,
} from '@10db/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

/** What one scope overrides of a rigor's steps. */
export interface PlaybookRowOverride {
  readonly rigor: Rigor;
  readonly steps: readonly StepRole[];
}

/** What one scope overrides of a cell; a null field is left to the scope above. */
export interface PlaybookCellOverride extends CellSetting {
  readonly rigor: Rigor;
  readonly role: StepRole;
}

/** The overrides one scope holds, without 10db's defaults or any other scope. */
export interface PlaybookOverrides {
  readonly rows: readonly PlaybookRowOverride[];
  readonly cells: readonly PlaybookCellOverride[];
}

const projectIs = (column: AnySQLiteColumn, projectId: ProjectId | null) =>
  projectId === null ? isNull(column) : eq(column, projectId);

const ROLE_ORDER: readonly StepRole[] = Object.values(StepRole);

/** The rows and cells one scope overrides: a project's own, or the global ones for null. */
export function getPlaybook(db: DbReader, projectId: ProjectId | null): PlaybookOverrides {
  const rows = db
    .select({ rigor: schema.playbookRows.rigor, steps: schema.playbookRows.steps })
    .from(schema.playbookRows)
    .where(projectIs(schema.playbookRows.projectId, projectId))
    .orderBy(asc(schema.playbookRows.rigor))
    .all();
  const cells = db
    .select({
      rigor: schema.playbookCells.rigor,
      role: schema.playbookCells.role,
      personaId: schema.playbookCells.personaId,
      model: schema.playbookCells.model,
      effort: schema.playbookCells.effort,
    })
    .from(schema.playbookCells)
    .where(projectIs(schema.playbookCells.projectId, projectId))
    .all();
  return {
    rows: rows.sort((a, b) => RIGORS.indexOf(a.rigor) - RIGORS.indexOf(b.rigor)),
    cells: cells.sort(
      (a, b) =>
        RIGORS.indexOf(a.rigor) - RIGORS.indexOf(b.rigor) ||
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
    ),
  };
}

/**
 * Applies a form to one scope's playbook. A row with null steps, and a cell with every field null,
 * is cleared; a row or cell left out is untouched, and the other scope is never written.
 */
export function setPlaybook(
  ctx: WriteContext,
  projectId: ProjectId | null,
  input: PlaybookInput,
): PlaybookOverrides {
  const changes = PlaybookInput.parse(input);
  if (projectId !== null) getProject(ctx.tx, projectId);
  for (const cell of changes.cells) checkPersona(ctx.tx, cell.personaId);
  for (const row of changes.rows) {
    const where = and(
      eq(schema.playbookRows.rigor, row.rigor),
      projectIs(schema.playbookRows.projectId, projectId),
    );
    if (row.steps === null) {
      ctx.tx.delete(schema.playbookRows).where(where).run();
      continue;
    }
    const updated = ctx.tx
      .update(schema.playbookRows)
      .set({ steps: row.steps, updatedAt: ctx.now })
      .where(where)
      .run();
    if (updated.changes === 0)
      ctx.tx
        .insert(schema.playbookRows)
        .values({ rigor: row.rigor, projectId, steps: row.steps, updatedAt: ctx.now })
        .run();
  }
  for (const cell of changes.cells) {
    const where = and(
      eq(schema.playbookCells.rigor, cell.rigor),
      eq(schema.playbookCells.role, cell.role),
      projectIs(schema.playbookCells.projectId, projectId),
    );
    if (cell.personaId === null && cell.model === null && cell.effort === null) {
      ctx.tx.delete(schema.playbookCells).where(where).run();
      continue;
    }
    const fields: {
      personaId: PersonaId | null;
      model: ModelSetting | null;
      effort: Effort | null;
    } = { personaId: cell.personaId, model: cell.model, effort: cell.effort };
    const updated = ctx.tx
      .update(schema.playbookCells)
      .set({ ...fields, updatedAt: ctx.now })
      .where(where)
      .run();
    if (updated.changes === 0)
      ctx.tx
        .insert(schema.playbookCells)
        .values({ rigor: cell.rigor, role: cell.role, projectId, ...fields, updatedAt: ctx.now })
        .run();
  }
  ctx.emit({
    type: EventType.SettingsChanged,
    entityType: 'playbook',
    entityId: projectId ?? 'all',
  });
  return getPlaybook(ctx.tx, projectId);
}

function checkPersona(db: DbReader, personaId: PersonaId | null): void {
  if (personaId === null) return;
  const found = db
    .select({ id: schema.personas.id })
    .from(schema.personas)
    .where(eq(schema.personas.id, personaId))
    .get();
  if (!found) throw new NotFoundError('persona', personaId);
}

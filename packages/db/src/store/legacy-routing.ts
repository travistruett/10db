import { asc } from 'drizzle-orm';
import type { z } from 'zod';
import {
  LegacyBinding,
  LegacyFlow,
  LegacyPattern,
  LegacyPersona,
  LegacyProject,
  LegacyRoleSetting,
  LegacyTask,
} from '../legacy-types';
import * as schema from '../schema';
import type { DbReader } from './store';

/**
 * Everything the routing tables held before rigor, kinds and the playbook: flows, patterns, role
 * settings, team bindings, persona pins, and each task's and project's risk tags and flow. The move
 * to the playbook reads this and nothing else reads it; the tables stay, unwritten. A row that does
 * not parse is left out of its list and named in `unreadable`.
 */
export interface LegacyRouting {
  readonly flows: readonly LegacyFlow[];
  readonly patterns: readonly LegacyPattern[];
  readonly roleSettings: readonly LegacyRoleSetting[];
  readonly bindings: readonly LegacyBinding[];
  readonly personas: readonly LegacyPersona[];
  readonly tasks: readonly LegacyTask[];
  readonly projects: readonly LegacyProject[];
  readonly unreadable: readonly LegacyRoutingError[];
}

/** A row of a table the playbook replaced does not have the shape it was written with. */
export class LegacyRoutingError extends Error {
  override readonly name = 'LegacyRoutingError';
  readonly table: string;
  readonly rowId: string;

  constructor(table: string, rowId: string, cause: unknown) {
    super(`row ${rowId} of ${table} could not be read`, { cause });
    this.table = table;
    this.rowId = rowId;
  }
}

/** Parses each row on its own, so one bad row costs only itself; `idOf` names a row that fails. */
function parseRows<R, S extends z.ZodType>(
  table: string,
  rowSchema: S,
  rows: readonly R[],
  idOf: (row: R) => string,
  unreadable: LegacyRoutingError[],
): z.infer<S>[] {
  const parsed: z.infer<S>[] = [];
  for (const row of rows) {
    const result = rowSchema.safeParse(row);
    if (result.success) parsed.push(result.data);
    else unreadable.push(new LegacyRoutingError(table, idOf(row), result.error));
  }
  return parsed;
}

/** Rows read from the old tables are parsed, so the move meets only the shapes it was written for. */
export function readLegacyRouting(db: DbReader): LegacyRouting {
  const unreadable: LegacyRoutingError[] = [];
  const flows = parseRows(
    'flows',
    LegacyFlow,
    db
      .select({ id: schema.flows.id, name: schema.flows.name, steps: schema.flows.steps })
      .from(schema.flows)
      .orderBy(asc(schema.flows.name))
      .all(),
    (f) => f.id,
    unreadable,
  );
  const patterns = parseRows(
    'patterns',
    LegacyPattern,
    db
      .select({
        id: schema.patterns.id,
        projectId: schema.patterns.projectId,
        name: schema.patterns.name,
        match: schema.patterns.match,
        setting: schema.patterns.setting,
        position: schema.patterns.position,
      })
      .from(schema.patterns)
      .orderBy(asc(schema.patterns.projectId), asc(schema.patterns.position))
      .all(),
    (p) => p.id,
    unreadable,
  );
  const roleSettings = parseRows(
    'role_settings',
    LegacyRoleSetting,
    db
      .select({
        role: schema.roleSettings.role,
        projectId: schema.roleSettings.projectId,
        setting: schema.roleSettings.setting,
      })
      .from(schema.roleSettings)
      .orderBy(asc(schema.roleSettings.role), asc(schema.roleSettings.projectId))
      .all(),
    (r) => `${r.role} for ${r.projectId ?? 'everywhere'}`,
    unreadable,
  );
  const bindings = parseRows(
    'team_bindings',
    LegacyBinding,
    db
      .select({
        projectId: schema.teamBindings.projectId,
        role: schema.teamBindings.role,
        personaId: schema.teamBindings.personaId,
      })
      .from(schema.teamBindings)
      .orderBy(asc(schema.teamBindings.projectId), asc(schema.teamBindings.role))
      .all(),
    (b) => `${b.role} in ${b.projectId}`,
    unreadable,
  );
  const personas = parseRows(
    'personas',
    LegacyPersona,
    db
      .select({
        id: schema.personas.id,
        key: schema.personas.key,
        role: schema.personas.role,
        minimumScore: schema.personas.minimumScore,
        modelPin: schema.personas.modelPin,
        archived: schema.personas.archived,
      })
      .from(schema.personas)
      .orderBy(asc(schema.personas.key))
      .all(),
    (p) => p.id,
    unreadable,
  );
  const tasks = parseRows(
    'tasks',
    LegacyTask,
    db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        status: schema.tasks.status,
        riskTags: schema.tasks.riskTags,
        flowId: schema.tasks.flowId,
      })
      .from(schema.tasks)
      .orderBy(asc(schema.tasks.id))
      .all(),
    (t) => t.id,
    unreadable,
  );
  const projects = parseRows(
    'projects',
    LegacyProject,
    db
      .select({ id: schema.projects.id, flowId: schema.projects.flowId })
      .from(schema.projects)
      .orderBy(asc(schema.projects.id))
      .all(),
    (p) => p.id,
    unreadable,
  );
  return { flows, patterns, roleSettings, bindings, personas, tasks, projects, unreadable };
}

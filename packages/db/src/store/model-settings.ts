import {
  EventType,
  mintId,
  type ModelSetting,
  type PatternDto,
  type PatternMatch,
  type ProjectId,
  type RoleSettingDto,
} from '@10db/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** A pattern as written; the store gives it an id and its position in the list. */
export interface NewPattern {
  readonly name: string;
  readonly match: PatternMatch;
  readonly setting: ModelSetting;
}

const projectIs = (column: AnySQLiteColumn, projectId: ProjectId | null) =>
  projectId === null ? isNull(column) : eq(column, projectId);

export function listRoleSettings(db: DbReader): RoleSettingDto[] {
  return db
    .select({
      role: schema.roleSettings.role,
      projectId: schema.roleSettings.projectId,
      setting: schema.roleSettings.setting,
    })
    .from(schema.roleSettings)
    .orderBy(asc(schema.roleSettings.role), asc(schema.roleSettings.projectId))
    .all();
}

/** Sets the role's model setting for one project, or everywhere when the input has no project. */
export function setRoleSetting(ctx: WriteContext, input: RoleSettingDto): void {
  const where = and(
    eq(schema.roleSettings.role, input.role),
    projectIs(schema.roleSettings.projectId, input.projectId),
  );
  const updated = ctx.tx
    .update(schema.roleSettings)
    .set({ setting: input.setting, updatedAt: ctx.now })
    .where(where)
    .run();
  if (updated.changes === 0) {
    ctx.tx
      .insert(schema.roleSettings)
      .values({ ...input, updatedAt: ctx.now })
      .run();
  }
  ctx.emit({
    type: EventType.SettingsChanged,
    entityType: 'role_setting',
    entityId: `${input.role}/${input.projectId ?? 'all'}`,
  });
}

/** Every pattern, global first, each scope in position order. */
export function listPatterns(db: DbReader): PatternDto[] {
  return db
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
    .all();
}

/** Replaces the patterns of one scope (a project, or everywhere for null); the list's order is the position. */
export function setPatterns(
  ctx: WriteContext,
  projectId: ProjectId | null,
  patterns: readonly NewPattern[],
): void {
  ctx.tx.delete(schema.patterns).where(projectIs(schema.patterns.projectId, projectId)).run();
  if (patterns.length > 0) {
    ctx.tx
      .insert(schema.patterns)
      .values(
        patterns.map((pattern, position) => ({
          ...pattern,
          id: mintId('Pattern'),
          projectId,
          position,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })),
      )
      .run();
  }
  ctx.emit({
    type: EventType.SettingsChanged,
    entityType: 'pattern',
    entityId: projectId ?? 'all',
  });
}

import { asc } from 'drizzle-orm';
import { z } from 'zod';
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
 * to the playbook reads this and nothing else reads it; the tables stay, unwritten.
 */
export interface LegacyRouting {
  readonly flows: readonly LegacyFlow[];
  readonly patterns: readonly LegacyPattern[];
  readonly roleSettings: readonly LegacyRoleSetting[];
  readonly bindings: readonly LegacyBinding[];
  readonly personas: readonly LegacyPersona[];
  readonly tasks: readonly LegacyTask[];
  readonly projects: readonly LegacyProject[];
}

/** Rows read from the old tables are parsed, so the move meets only the shapes it was written for. */
export function readLegacyRouting(db: DbReader): LegacyRouting {
  return {
    flows: z
      .array(LegacyFlow)
      .parse(
        db
          .select({ id: schema.flows.id, name: schema.flows.name, steps: schema.flows.steps })
          .from(schema.flows)
          .orderBy(asc(schema.flows.name))
          .all(),
      ),
    patterns: z.array(LegacyPattern).parse(
      db
        .select({
          projectId: schema.patterns.projectId,
          name: schema.patterns.name,
          match: schema.patterns.match,
          setting: schema.patterns.setting,
          position: schema.patterns.position,
        })
        .from(schema.patterns)
        .orderBy(asc(schema.patterns.projectId), asc(schema.patterns.position))
        .all(),
    ),
    roleSettings: z.array(LegacyRoleSetting).parse(
      db
        .select({
          role: schema.roleSettings.role,
          projectId: schema.roleSettings.projectId,
          setting: schema.roleSettings.setting,
        })
        .from(schema.roleSettings)
        .orderBy(asc(schema.roleSettings.role), asc(schema.roleSettings.projectId))
        .all(),
    ),
    bindings: z.array(LegacyBinding).parse(
      db
        .select({
          projectId: schema.teamBindings.projectId,
          role: schema.teamBindings.role,
          personaId: schema.teamBindings.personaId,
        })
        .from(schema.teamBindings)
        .orderBy(asc(schema.teamBindings.projectId), asc(schema.teamBindings.role))
        .all(),
    ),
    personas: z.array(LegacyPersona).parse(
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
    ),
    tasks: z.array(LegacyTask).parse(
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
    ),
    projects: z
      .array(LegacyProject)
      .parse(
        db
          .select({ id: schema.projects.id, flowId: schema.projects.flowId })
          .from(schema.projects)
          .orderBy(asc(schema.projects.id))
          .all(),
      ),
  };
}

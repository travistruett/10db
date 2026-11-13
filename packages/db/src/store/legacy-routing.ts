import type {
  FlowDto,
  FlowId,
  ModelPin,
  PatternDto,
  PersonaId,
  ProjectId,
  RiskTag,
  RoleSettingDto,
  StepRole,
  TaskId,
  TaskStatus,
} from '@10db/contracts';
import { asc } from 'drizzle-orm';
import * as schema from '../schema';
import { listFlows } from './flows';
import { listPatterns, listRoleSettings } from './model-settings';
import type { DbReader } from './store';

/** A persona's own pin and floor, as the tables before the playbook hold them. */
export interface LegacyPersona {
  readonly id: PersonaId;
  readonly key: string;
  readonly role: StepRole;
  readonly minimumScore: number | null;
  readonly modelPin: ModelPin | null;
  readonly archived: boolean;
}

/** The persona a project binds to a role. */
export interface LegacyBinding {
  readonly projectId: ProjectId;
  readonly role: StepRole;
  readonly personaId: PersonaId;
}

/** The routing fields a task carried before rigor and kinds. */
export interface LegacyTask {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly status: TaskStatus;
  readonly riskTags: readonly RiskTag[];
  readonly flowId: FlowId | null;
}

/** The flow a project named as its default. */
export interface LegacyProject {
  readonly id: ProjectId;
  readonly flowId: FlowId | null;
}

/**
 * Everything the routing tables held before rigor, kinds and the playbook: flows, patterns, role
 * settings, team bindings, persona pins, and each task's and project's risk tags and flow. The move
 * to the playbook reads this and nothing else reads it; the tables stay, unwritten.
 */
export interface LegacyRouting {
  readonly flows: readonly FlowDto[];
  readonly patterns: readonly PatternDto[];
  readonly roleSettings: readonly RoleSettingDto[];
  readonly bindings: readonly LegacyBinding[];
  readonly personas: readonly LegacyPersona[];
  readonly tasks: readonly LegacyTask[];
  readonly projects: readonly LegacyProject[];
}

export function readLegacyRouting(db: DbReader): LegacyRouting {
  return {
    flows: listFlows(db),
    patterns: listPatterns(db),
    roleSettings: listRoleSettings(db),
    bindings: db
      .select({
        projectId: schema.teamBindings.projectId,
        role: schema.teamBindings.role,
        personaId: schema.teamBindings.personaId,
      })
      .from(schema.teamBindings)
      .orderBy(asc(schema.teamBindings.projectId), asc(schema.teamBindings.role))
      .all(),
    personas: db
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
    tasks: db
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
    projects: db
      .select({ id: schema.projects.id, flowId: schema.projects.flowId })
      .from(schema.projects)
      .orderBy(asc(schema.projects.id))
      .all(),
  };
}

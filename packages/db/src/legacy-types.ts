import {
  Effort,
  FlowId,
  ModelSetting,
  PersonaId,
  ProjectId,
  StepRole,
  TaskId,
  TaskStatus,
} from '@10db/contracts';
import { z } from 'zod';

/*
 * The shapes the routing tables held before rigor, kinds and the playbook. The tables stay, written by
 * nothing, so the move to the playbook can read them once; these schemas are what the legacy store
 * parses their rows with, and the types `schema.ts` gives their JSON columns.
 */

/** A risk tag a task or a pattern carried; each is the key of the kind seeded in its place. */
export const LegacyRiskTag = z.enum(['security', 'auth', 'migration', 'dependency']);
export type LegacyRiskTag = z.infer<typeof LegacyRiskTag>;

/** A model and effort a persona pinned its steps to. */
export const LegacyModelPin = z.object({ model: z.string().min(1), effort: z.enum(Effort) });
export type LegacyModelPin = z.infer<typeof LegacyModelPin>;

/** A condition under which a flow step was skipped. */
export const LegacySkipRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unless_risk'), tags: z.array(LegacyRiskTag) }),
  z.object({ kind: z.literal('unless_criteria_over'), count: z.int().min(0) }),
]);
export type LegacySkipRule = z.infer<typeof LegacySkipRule>;

export const LegacyFlowStep = z.object({
  role: z.enum(StepRole),
  need: z.number(),
  skip: z.array(LegacySkipRule).default([]),
  /** The key of a persona for this step only, over the project's binding for the role. */
  persona: z.string().nullable().default(null),
});
export type LegacyFlowStep = z.infer<typeof LegacyFlowStep>;

export const LegacyFlow = z.object({
  id: FlowId,
  name: z.string(),
  steps: z.array(LegacyFlowStep),
});
export type LegacyFlow = z.infer<typeof LegacyFlow>;

/** What a pattern applied to; an empty list, or false, meant any. */
export const LegacyPatternMatch = z.object({
  roles: z.array(z.enum(StepRole)).default([]),
  riskTags: z.array(LegacyRiskTag).default([]),
  areas: z.array(z.string()).default([]),
  retryOnly: z.boolean().default(false),
});
export type LegacyPatternMatch = z.infer<typeof LegacyPatternMatch>;

export const LegacyPattern = z.object({
  projectId: ProjectId.nullable(),
  name: z.string(),
  match: LegacyPatternMatch,
  setting: ModelSetting,
  position: z.int(),
});
export type LegacyPattern = z.infer<typeof LegacyPattern>;

/** The setting for a role, for one project or, with no project, everywhere. */
export const LegacyRoleSetting = z.object({
  role: z.enum(StepRole),
  projectId: ProjectId.nullable(),
  setting: ModelSetting,
});
export type LegacyRoleSetting = z.infer<typeof LegacyRoleSetting>;

/** A persona's own pin and floor. */
export const LegacyPersona = z.object({
  id: PersonaId,
  key: z.string(),
  role: z.enum(StepRole),
  minimumScore: z.number().nullable(),
  modelPin: LegacyModelPin.nullable(),
  archived: z.boolean(),
});
export type LegacyPersona = z.infer<typeof LegacyPersona>;

/** The persona a project bound to a role. */
export const LegacyBinding = z.object({
  projectId: ProjectId,
  role: z.enum(StepRole),
  personaId: PersonaId,
});
export type LegacyBinding = z.infer<typeof LegacyBinding>;

/** The routing fields a task carried before rigor and kinds. */
export const LegacyTask = z.object({
  id: TaskId,
  projectId: ProjectId,
  status: z.enum(TaskStatus),
  riskTags: z.array(LegacyRiskTag),
  flowId: FlowId.nullable(),
});
export type LegacyTask = z.infer<typeof LegacyTask>;

/** The flow a project named as its default. */
export const LegacyProject = z.object({ id: ProjectId, flowId: FlowId.nullable() });
export type LegacyProject = z.infer<typeof LegacyProject>;

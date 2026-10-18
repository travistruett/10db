import { z } from 'zod';
import { PersonaId, PersonId, ProjectId, RoutingRuleId } from './ids';
import { HyphenatedKey } from './keys';
import { Effort, QuestionCategory, StepRole, ToolAccess } from './states';

export const ModelPin = z.object({ model: z.string().min(1), effort: z.enum(Effort) });
export type ModelPin = z.infer<typeof ModelPin>;

/** Implementers edit; every other role is read-only, so a reviewer never changes what it judges. */
const roleMatchesTools = (p: { role: StepRole; tools: ToolAccess }) =>
  (p.role === StepRole.Implement) === (p.tools === ToolAccess.Edit);
const ROLE_TOOLS = {
  message: 'Only an implement persona edits; every other role is read-only',
  path: ['tools'],
};

export const PersonaInput = z
  .object({
    key: HyphenatedKey,
    name: z.string().min(1).max(80),
    role: z.enum(StepRole),
    tools: z.enum(ToolAccess),
    /** The persona prompt: how this persona works, sent with every session it runs. */
    instructions: z.string().min(1).max(8000),
    skills: z.array(HyphenatedKey).max(10).default([]),
    /** A floor, in its role's index points, for any step this persona runs. */
    minimumScore: z.number().min(0).max(100).nullable().default(null),
    modelPin: ModelPin.nullable().default(null),
  })
  .refine(roleMatchesTools, ROLE_TOOLS);
export type PersonaInput = z.input<typeof PersonaInput>;

export const PersonaPatch = z
  .object({
    name: z.string().min(1).max(80),
    instructions: z.string().min(1).max(8000),
    skills: z.array(HyphenatedKey).max(10),
    minimumScore: z.number().min(0).max(100).nullable(),
    modelPin: ModelPin.nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type PersonaPatch = z.infer<typeof PersonaPatch>;

export const PersonaDto = z.object({
  id: PersonaId,
  key: HyphenatedKey,
  name: z.string(),
  role: z.enum(StepRole),
  tools: z.enum(ToolAccess),
  instructions: z.string(),
  skills: z.array(z.string()),
  minimumScore: z.number().nullable(),
  modelPin: ModelPin.nullable(),
  /** An archived persona stays so workstreams that ran on it still name it; no new plan, binding or flow step uses it. */
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PersonaDto = z.infer<typeof PersonaDto>;

export const PersonInput = z.object({ handle: HyphenatedKey, name: z.string().min(1).max(80) });
export type PersonInput = z.infer<typeof PersonInput>;

export const PersonDto = z.object({
  id: PersonId,
  handle: HyphenatedKey,
  name: z.string(),
  /** The person running this app; cards nobody else owns go to them. */
  isBuilder: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PersonDto = z.infer<typeof PersonDto>;

export const TeamBinding = z.object({ role: z.enum(StepRole), personaId: PersonaId });
export type TeamBinding = z.infer<typeof TeamBinding>;

export const TeamInput = z.object({
  bindings: z
    .array(TeamBinding)
    .refine((b) => new Set(b.map((x) => x.role)).size === b.length, 'One persona per role'),
  members: z
    .array(PersonId)
    .refine((m) => new Set(m).size === m.length, 'A member is listed twice'),
});
export type TeamInput = z.infer<typeof TeamInput>;

export const TeamDto = TeamInput.extend({ projectId: ProjectId });
export type TeamDto = z.infer<typeof TeamDto>;

export const RoutingRuleInput = z.object({
  category: z.enum(QuestionCategory),
  /** Narrows the rule to work that claims this area; null matches any area. */
  area: z.string().min(1).nullable(),
  personId: PersonId,
});
export type RoutingRuleInput = z.infer<typeof RoutingRuleInput>;

/** The project's whole rule list, replaced at once. */
export const RoutingRulesInput = z.object({
  rules: z
    .array(RoutingRuleInput)
    .refine(
      (rules) =>
        new Set(rules.map((r) => `${r.category}\u0000${r.area ?? ''}`)).size === rules.length,
      'Two rules have the same category and area',
    ),
});
export type RoutingRulesInput = z.infer<typeof RoutingRulesInput>;

export const RoutingRuleDto = RoutingRuleInput.extend({
  id: RoutingRuleId,
  projectId: ProjectId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RoutingRuleDto = z.infer<typeof RoutingRuleDto>;

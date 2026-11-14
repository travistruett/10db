import { z } from 'zod';
import { GoalId, PersonaId, PersonId, ProjectId, RoutingRuleId, TaskId } from './ids';
import { HyphenatedKey } from './keys';
import { Effort, QuestionCategory, SendMode, StepRole, ToolAccess } from './states';

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

const DailyLimit = z.int().min(1).max(100);

/** How to reach a person in Slack; the DM channel is learned on the first send. */
export const SlackContactDto = z.object({
  teamId: z.string().min(1),
  userId: z.string().min(1),
  dmChannelId: z.string().min(1).nullable(),
  sendMode: z.enum(SendMode).default(SendMode.Review),
  /** New questions a day to this person; null is no limit. */
  dailyLimit: DailyLimit.nullable().default(10),
});
export type SlackContactDto = z.infer<typeof SlackContactDto>;

export const SlackContactInput = SlackContactDto.omit({ dmChannelId: true });
export type SlackContactInput = z.infer<typeof SlackContactInput>;

export const PersonInput = z.object({
  handle: HyphenatedKey,
  name: z.string().min(1).max(80),
  slack: SlackContactInput.nullable().default(null),
});
export type PersonInput = z.input<typeof PersonInput>;

export const PersonDto = z.object({
  id: PersonId,
  handle: HyphenatedKey,
  name: z.string(),
  /** The person running this app; cards nobody else owns go to them. */
  isBuilder: z.boolean(),
  slack: SlackContactDto.nullable().default(null),
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

/**
 * A rule names one category or one topic, and the scope it holds in: the project, a goal or a task.
 * The refinement lives on the list (`RoutingRulesInput`), so this object stays extendable.
 */
export const RoutingRuleInput = z.object({
  category: z.enum(QuestionCategory).nullable(),
  /** A topic route: a name from the project's topics, free of any goal, task or area. */
  topic: z.string().min(1).max(120).nullable().default(null),
  goalId: GoalId.nullable().default(null),
  taskId: TaskId.nullable().default(null),
  /** Narrows the rule to work that claims this area; null matches any area. */
  area: z.string().min(1).nullable(),
  personId: PersonId,
});
export type RoutingRuleInput = z.input<typeof RoutingRuleInput>;

type RuleFields = z.output<typeof RoutingRuleInput>;

/** What is wrong with one rule alone, or null. */
function ruleProblem(r: RuleFields): string | null {
  if ((r.category === null) === (r.topic === null)) return 'A rule names a category or a topic';
  if (r.topic !== null && (r.goalId !== null || r.taskId !== null || r.area !== null)) {
    return 'A topic rule has no goal, task or area';
  }
  if (r.goalId !== null && r.taskId !== null) return 'A rule has a goal or a task, not both';
  if (r.taskId !== null && r.area !== null) return 'A task rule has no area';
  return null;
}

const ruleKey = (r: RuleFields): string =>
  [r.goalId, r.taskId, r.category, r.topic, r.area, r.personId].map((v) => v ?? '').join('\u0000');

/** The project's whole rule list, replaced at once. The same category at one scope for two people is a tie. */
export const RoutingRulesInput = z.object({
  rules: z.array(RoutingRuleInput).superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      const parsed = RoutingRuleInput.safeParse(rule);
      if (!parsed.success) return;
      const problem = ruleProblem(parsed.data);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: [index] });
      const key = ruleKey(parsed.data);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', message: 'Two rules are the same', path: [index] });
      }
      seen.add(key);
    });
  }),
});
export type RoutingRulesInput = z.input<typeof RoutingRulesInput>;

export const RoutingRuleDto = RoutingRuleInput.extend({
  id: RoutingRuleId,
  projectId: ProjectId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RoutingRuleDto = z.infer<typeof RoutingRuleDto>;

/** Hours before 10db reminds the recipient and before it returns the question to the builder. */
export const StakeholderTimersDto = z
  .object({
    remindAfterHours: z.int().min(1).max(72).nullable().default(4),
    returnAfterHours: z.int().min(1).max(168).default(8),
  })
  .refine((t) => t.remindAfterHours === null || t.remindAfterHours < t.returnAfterHours, {
    message: 'Remind before the question goes back to you',
    path: ['remindAfterHours'],
  });
export type StakeholderTimersDto = z.infer<typeof StakeholderTimersDto>;

import { z } from 'zod';
import { Title } from './entities';
import {
  DecisionId,
  DeviationId,
  GoalCriterionId,
  GoalId,
  InboxItemId,
  PersonId,
  ProjectId,
  TaskId,
  WorkstreamId,
} from './ids';
import { CriterionCheck, CriterionState, Effort, GoalState, GoalStatus } from './states';

// Goals spec: docs/superpowers/specs/2026-10-29-10db-goals-design.md. Contracts only; the tables,
// routes and screens that use these come in later tasks.

const Timestamp = z.iso.datetime();

/** A key a brief gives a task, so criteria and `depends_on` can name it before it has an id. */
export const BriefKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens, starting with a letter');

/** A goal's budget: tokens and, on metered accounts, dollars. Unset means no spend check (§6). */
export const GoalBudget = z.object({
  tokens: z.int().positive().optional(),
  dollars: z.number().positive().optional(),
});
export type GoalBudget = z.infer<typeof GoalBudget>;

// --- The brief (§11) ----------------------------------------------------------------------------

const BriefCriterionText = z.string().min(1);

/** A criterion of a brief. `task` and `merged` name a task by its key; the daemon checks the key exists. */
export const GoalBriefCriterion = z.discriminatedUnion('check', [
  z.object({
    text: BriefCriterionText,
    check: z.literal(CriterionCheck.Task),
    task: BriefKey,
  }),
  z.object({
    text: BriefCriterionText,
    check: z.literal(CriterionCheck.Merged),
    task: BriefKey,
  }),
  z.object({
    text: BriefCriterionText,
    check: z.literal(CriterionCheck.Command),
    /** Absent means the project's gate command; any other command is approved by the owner at adoption. */
    command: z.string().min(1).optional(),
  }),
  z.object({
    text: BriefCriterionText,
    check: z.literal(CriterionCheck.Accept),
    /** The name of the person who accepts; absent means the owner. */
    person: z.string().min(1).optional(),
  }),
]);
export type GoalBriefCriterion = z.infer<typeof GoalBriefCriterion>;

export const GoalBriefTask = z.object({
  key: BriefKey,
  title: Title,
  description: z.string().default(''),
  /** The task's acceptance criteria (the front matter's `criteria`). */
  criteria: z.array(z.string().min(1)).default([]),
  areas: z.array(z.string().min(1)).min(1),
  depends_on: z.array(BriefKey).default([]),
});
export type GoalBriefTask = z.infer<typeof GoalBriefTask>;

export const GOAL_PERSON_ROLES = ['owner', 'stakeholder'] as const;
export const GOAL_PERSON_CHANNELS = ['in_app', 'slack'] as const;
export const GOAL_PERSON_RECEIVES = ['digest', 'questions', 'screenshots'] as const;

/** A person a brief proposes for the goal; the owner confirms (§10). */
export const GoalBriefPerson = z.object({
  name: z.string().min(1),
  role: z.enum(GOAL_PERSON_ROLES).default('stakeholder'),
  channel: z.enum(GOAL_PERSON_CHANNELS).optional(),
  receives: z.array(z.enum(GOAL_PERSON_RECEIVES)).optional(),
});
export type GoalBriefPerson = z.infer<typeof GoalBriefPerson>;

/**
 * A goal brief's YAML front matter. Parsing here checks its shape only; the daemon then checks the
 * rules that need the project: unique keys, keys that exist, no dependency cycle, known areas.
 */
export const GoalBrief = z.object({
  title: Title,
  objective: z.string().min(1),
  cares_most: z.string().min(1).optional(),
  budget: GoalBudget.optional(),
  criteria: z.array(GoalBriefCriterion).default([]),
  tasks: z.array(GoalBriefTask).min(1),
  people: z.array(GoalBriefPerson).default([]),
});
export type GoalBrief = z.infer<typeof GoalBrief>;

// --- Adopting a brief (§11) ---------------------------------------------------------------------

/** `POST /projects/:projectId/goals/adopt`: the brief's file path or its text, never both. */
export const GoalAdoptInput = z
  .object({
    path: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    /** Validate and answer without writing anything. */
    dryRun: z.boolean().default(false),
  })
  .refine((i) => (i.path === undefined) !== (i.text === undefined), {
    message: 'Send either path or text',
  });
export type GoalAdoptInput = z.infer<typeof GoalAdoptInput>;

/** One reason a brief can't be adopted; `path` says where in plain words ("Task 3, depends on"). */
export const GoalAdoptIssue = z.object({ path: z.string(), message: z.string() });
export type GoalAdoptIssue = z.infer<typeof GoalAdoptIssue>;

/** The 400 body of the adopt route: every error at once, so the builder fixes the brief in one go. */
export const GoalAdoptError = z.object({ errors: z.array(GoalAdoptIssue) });
export type GoalAdoptError = z.infer<typeof GoalAdoptError>;

// --- The goal (§4, §5) --------------------------------------------------------------------------

export const GoalCriterionDto = z.object({
  id: GoalCriterionId,
  goalId: GoalId,
  text: z.string(),
  check: z.enum(CriterionCheck),
  /** The task a `task` or `merged` criterion names; null for the others. */
  taskId: TaskId.nullable(),
  /** A `command` criterion's own command; null means the project's gate command. */
  command: z.string().nullable(),
  /** Whether the owner approved the command; stored false at adoption. */
  commandApproved: z.boolean(),
  /** Who accepts an `accept` criterion; null means the owner. */
  personId: PersonId.nullable(),
  state: z.enum(CriterionState),
  /** Evidence ids, pull request URLs or file paths. */
  proof: z.array(z.string()),
  provenAt: Timestamp.nullable(),
  /** The person who ticked it, or `daemon`; null while unproven. */
  provenBy: z.string().nullable(),
});
export type GoalCriterionDto = z.infer<typeof GoalCriterionDto>;

export const GoalDto = z.object({
  id: GoalId,
  projectId: ProjectId,
  title: z.string(),
  objective: z.string(),
  caresMost: z.string().nullable(),
  /** The notes below the brief's front matter. */
  description: z.string(),
  ownerId: PersonId,
  state: z.enum(GoalState),
  budget: GoalBudget.nullable(),
  criteria: z.array(GoalCriterionDto),
  taskIds: z.array(TaskId),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type GoalDto = z.infer<typeof GoalDto>;

// --- The digest (§8) ----------------------------------------------------------------------------

/** A Δ row: what changed in the window, and the rest behind Show Earlier. Both empty reads "None". */
function deltaRow<T extends z.ZodType>(item: T) {
  return z.object({ recent: z.array(item), earlier: z.array(item) });
}

export const GoalProgress = z.object({
  /** Tasks with status `done`, their pull requests possibly still open. */
  done: z.int().min(0),
  /** Tasks that are not cancelled. */
  total: z.int().min(0),
  /** Cancelled tasks, listed in the goal's drawer. */
  cancelled: z.array(z.object({ taskId: TaskId, title: z.string() })),
});
export type GoalProgress = z.infer<typeof GoalProgress>;

export const DigestWorkingNow = z.object({
  workstreamId: WorkstreamId,
  taskId: TaskId,
  taskTitle: z.string(),
  persona: z.string(),
  model: z.string(),
  effort: z.enum(Effort),
  stepNumber: z.int().min(1),
  stepCount: z.int().min(1),
});
export type DigestWorkingNow = z.infer<typeof DigestWorkingNow>;

/** A persona and the model its steps are routed to. */
export const DigestTeamMember = z.object({
  persona: z.string(),
  model: z.string(),
  effort: z.enum(Effort),
});
export type DigestTeamMember = z.infer<typeof DigestTeamMember>;

export const DigestWaitingOn = z.object({
  inboxItemId: InboxItemId,
  taskId: TaskId,
  title: z.string(),
  /** Null when the card has no assignee of its own: it is the owner's. */
  assigneeId: PersonId.nullable(),
  assigneeName: z.string(),
  at: Timestamp,
});
export type DigestWaitingOn = z.infer<typeof DigestWaitingOn>;

/** The next ready task, or the one it waits on. */
export const DigestNext = z.object({
  taskId: TaskId,
  title: z.string(),
  /** The open tasks it waits on; empty when it is ready now. */
  waitsOn: z.array(z.object({ taskId: TaskId, title: z.string() })),
});
export type DigestNext = z.infer<typeof DigestNext>;

export const DigestDeviation = z.object({
  id: DeviationId,
  taskId: TaskId.nullable(),
  summary: z.string(),
  at: Timestamp,
});
export type DigestDeviation = z.infer<typeof DigestDeviation>;

export const DigestDecision = z.object({
  id: DecisionId,
  question: z.string(),
  choice: z.string(),
  at: Timestamp,
});
export type DigestDecision = z.infer<typeof DigestDecision>;

export const DigestCost = z.object({
  tokens: z.int().min(0),
  /** Null where no session has a `cost_usd`. */
  dollars: z.number().min(0).nullable(),
  sessions: z.int().min(0),
});
export type DigestCost = z.infer<typeof DigestCost>;

/** The workstream of a task with no goal that is running or failed. */
export const UngroupedWorkstream = z.object({
  workstreamId: WorkstreamId,
  taskId: TaskId,
  taskTitle: z.string(),
  state: z.string(),
});
export type UngroupedWorkstream = z.infer<typeof UngroupedWorkstream>;

/** Tasks with no goal that are running or failed ("2 running · 1 failed"). `goalId` is always null. */
export const UngroupedDigestDto = z.object({
  goalId: z.null(),
  status: z.enum(GoalStatus),
  running: z.int().min(0),
  failed: z.int().min(0),
  workstreams: z.array(UngroupedWorkstream),
});
export type UngroupedDigestDto = z.infer<typeof UngroupedDigestDto>;

/**
 * `GET /goals/:goalId/digest`: the status, progress and every row of the digest table, in one
 * response, and the Ungrouped group beside it (null when no task without a goal is running or
 * failed). Δ rows hold what changed since `since`, the previous time the owner opened the goal;
 * `since` is null on the first visit, and then every item counts as recent.
 */
export const GoalDigestDto = z.object({
  goalId: GoalId,
  status: z.enum(GoalStatus),
  since: Timestamp.nullable(),
  progress: GoalProgress,
  /** Pull requests of the goal's tasks that are still open; the "Shipping" line counts them. */
  openPullRequests: z.int().min(0),
  workingNow: z.array(DigestWorkingNow),
  team: z.array(DigestTeamMember),
  waitingOn: deltaRow(DigestWaitingOn),
  next: DigestNext.nullable(),
  deviations: deltaRow(DigestDeviation),
  decisions: deltaRow(DigestDecision),
  cost: DigestCost,
  ungrouped: UngroupedDigestDto.nullable(),
});
export type GoalDigestDto = z.infer<typeof GoalDigestDto>;

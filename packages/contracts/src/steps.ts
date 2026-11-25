import { z } from 'zod';
import { ModelSetting } from './catalogue';
import { ModelProfileId, PersonaId, SessionId, TaskId } from './ids';
import { Rigor } from './rigor';
import { Effort, StepRole, StepStatus, ToolAccess, Verdict } from './states';

/** Longest result a step may record: a plan or a review's notes. */
export const MAX_STEP_SUMMARY = 8000;

/**
 * The line 10db puts after a review's notes before the follow-up tasks that review filed, one per
 * line, so the builder reads them in the step's result.
 */
export const FOLLOW_UPS_HEADING = 'Follow-up tasks filed:';

export const StepResult = z.object({
  summary: z.string().min(1).max(MAX_STEP_SUMMARY),
  verdict: z.enum(Verdict).nullable(),
  /** The session that recorded it, so a nudge knows whether this session has finished its step. */
  sessionId: SessionId,
  at: z.iso.datetime(),
});
export type StepResult = z.infer<typeof StepResult>;

/**
 * What an implement step's last session wrote as its final message: the build's own account of what it
 * did, found and skipped. An implement step ends by ending its turn, so this is not a `result`; a build
 * that plans first keeps its plan there, and a review's verdict is a separate result on its own step.
 */
export const StepReport = z.object({
  summary: z.string().min(1).max(MAX_STEP_SUMMARY),
  /** The session that wrote it. */
  sessionId: SessionId,
  at: z.iso.datetime(),
  /** The step's attempt that wrote it, 1 for the first: one more than its `attempts` then. Absent on an older row. */
  attempt: z.int().min(1).optional(),
});
export type StepReport = z.infer<typeof StepReport>;

/**
 * The build's report as a later step is handed it: the implementer's own account, which that step
 * weighs as evidence. `current` is false when the build ran again after writing it and wrote nothing.
 */
export const ImplementationReport = z.object({
  personaName: z.string(),
  summary: z.string().min(1).max(MAX_STEP_SUMMARY),
  sessionId: SessionId,
  at: z.iso.datetime(),
  /** Null on a report stored before attempts were kept. */
  attempt: z.int().min(1).nullable(),
  current: z.boolean(),
});
export type ImplementationReport = z.infer<typeof ImplementationReport>;

/** The follow-up task filed for the findings a task shipped with at the retry limit. */
export const ShippedAtLimit = z.object({
  followUpTaskId: TaskId,
  followUpTitle: z.string().min(1),
});
export type ShippedAtLimit = z.infer<typeof ShippedAtLimit>;

/**
 * Whether the fresh session a send-back falls back to still has to step up a model rung: `pending` when the
 * send-back meant to resume the step's own session, `done` once the step was escalated for it.
 */
export const FixFresh = { Pending: 'pending', Done: 'done' } as const;
export type FixFresh = (typeof FixFresh)[keyof typeof FixFresh];

/** One step of a workstream's resolved plan, fixed when the task starts. */
export const WorkstreamStep = z.object({
  role: z.enum(StepRole),
  personaId: PersonaId.nullable(),
  personaName: z.string(),
  tools: z.enum(ToolAccess),
  profileId: ModelProfileId.nullable(),
  model: z.string().min(1),
  effort: z.enum(Effort),
  need: z.number().min(0).max(100),
  /** What the router was asked for this step; null when nothing asked, so a stored step parses. */
  setting: ModelSetting.nullable().default(null),
  /** Why this profile: the router's reason, a pin, a fallback or an escalation. */
  reason: z.string(),
  overBudget: z.boolean(),
  pinned: z.boolean(),
  status: z.enum(StepStatus),
  /** Times this step was sent back by a reviewer or failed its gate; 0 means it passed first time. */
  attempts: z.int().min(0),
  /** When the step last started, for display. */
  startedAt: z.iso.datetime().nullable(),
  /** Sessions the workstream had run when this step started; a handoff from one of them belongs to an earlier step. */
  sessionFloor: z.int().min(0),
  /**
   * Sessions the workstream had run when the builder last retried this step: a review's endings without
   * a verdict before it don't count against the rerun it gets by itself. Absent, the step was never retried.
   */
  retryFloor: z.int().min(0).optional(),
  result: StepResult.nullable(),
  /** An implement step's latest report (see `StepReport`); absent on any other step and until a session of it has ended. */
  report: StepReport.optional(),
  /** Results this step kept when it ran again (a rejection it was sent back for), oldest first. */
  earlier: z.array(StepResult).default([]),
  /** Times this step's rejection sent the work back since the attempts last started over; a retry sets it to 0. */
  sentBack: z.int().min(0).default(0),
  /**
   * The review rounds the task's rigor allowed when this reviewing step was last written, for the card's
   * "sent back N of R". The limit itself is read live at each rejection. Absent on a step stored without it.
   */
  reviewRounds: z.int().min(0).max(3).optional(),
  /**
   * Set on every step of a run no rigor planned (a merge resolution, a pass page): its steps are never planned
   * again and no review is added to it.
   */
  fixedPlan: z.literal(true).optional(),
  /**
   * Set on a build step that writes its own plan before it builds, because its rigor plans in the Build
   * session: the plan it records is the step's result. Absent otherwise.
   */
  plansFirst: z.literal(true).optional(),
  /**
   * The provider session that last ran this step, so a send-back can resume it. Absent until a session of
   * the step has started.
   */
  providerSessionId: z.string().min(1).optional(),
  /** Set when a reviewer's send-back targets this step; see `FixFresh`. Absent otherwise. */
  fixFresh: z.enum(FixFresh).optional(),
  /**
   * Set on a review or QA step whose rejection used up the retry limit and shipped the work anyway:
   * the follow-up task 10db filed for the findings that stayed open. Absent otherwise.
   */
  shippedAtLimit: ShippedAtLimit.optional(),
  /** Times the acceptance check sent this build step's work back; absent until it has. */
  acceptanceSentBack: z.int().min(0).optional(),
});
export type WorkstreamStep = z.infer<typeof WorkstreamStep>;

/** What starting a task would run, before it runs (the M2b approval sheet edits this). */
export const StepPlanDto = z.object({
  /** The rigor the steps came from; null for a plan no rigor made, such as a merge fix. */
  rigor: z.enum(Rigor).nullable(),
  steps: z.array(WorkstreamStep),
  /** Steps whose need no profile within the budget ceiling meets; starting is refused while any remain. */
  overBudget: z.array(z.int().min(0)),
});
export type StepPlanDto = z.infer<typeof StepPlanDto>;

/** How a step with no persona is named. */
export const ROLE_LABEL: Readonly<Record<StepRole, string>> = {
  plan: 'Planner',
  plan_review: 'Plan reviewer',
  implement: 'Implementer',
  review: 'Reviewer',
  qa: 'QA',
};

/** A task's plan as the builder reads it, and the step that wrote it. */
export interface TaskPlan {
  readonly role: StepRole;
  readonly personaName: string;
  readonly summary: string;
  /** When the plan was recorded. */
  readonly at: string;
}

/** The latest plan a run recorded: a Plan step's result, or the one a build step that plans first wrote. */
export function planOf(steps: readonly WorkstreamStep[]): TaskPlan | null {
  const step = steps.findLast(
    (s) =>
      s.result !== null &&
      (s.role === StepRole.Plan || (s.role === StepRole.Implement && s.plansFirst === true)),
  );
  if (!step?.result) return null;
  return {
    role: step.role,
    personaName: step.personaName,
    summary: step.result.summary,
    at: step.result.at,
  };
}

/** The build's account of its work, and the step that wrote it. */
export interface TaskReport {
  readonly personaName: string;
  readonly summary: string;
  /** When the build session ended. */
  readonly at: string;
}

/** The latest report an implement step kept; null when no build session has ended with one. */
export function reportOf(steps: readonly WorkstreamStep[]): TaskReport | null {
  const step = steps.findLast((s) => s.role === StepRole.Implement && s.report !== undefined);
  if (!step?.report) return null;
  return {
    personaName: step.personaName || ROLE_LABEL.implement,
    summary: step.report.summary,
    at: step.report.at,
  };
}

/**
 * The report of the latest implement step before `stepIndex`, for the step there to read; null when none
 * has one. A send-back that reran the build and got no report leaves the older one, marked not current.
 */
export function implementationReportFor(
  steps: readonly WorkstreamStep[],
  stepIndex: number,
): ImplementationReport | null {
  const step = steps
    .slice(0, stepIndex)
    .findLast((s) => s.role === StepRole.Implement && s.report !== undefined);
  if (!step?.report) return null;
  const { summary, sessionId, at, attempt } = step.report;
  return {
    personaName: step.personaName || ROLE_LABEL.implement,
    summary,
    sessionId,
    at,
    attempt: attempt ?? null,
    // The step's attempt now, and its latest start, both say whether a later run wrote nothing.
    current:
      (attempt === undefined || attempt === step.attempts + 1) &&
      (step.startedAt === null || at >= step.startedAt),
  };
}

/** A stored plan has no step at the index; falling back would hand a read-only step edit access. */
export class StepIndexError extends Error {
  override readonly name = 'StepIndexError';
  constructor(stepIndex: number, planLength: number) {
    super(`No step at index ${String(stepIndex)} in a plan of ${String(planLength)} steps`);
  }
}

export interface StepPosition {
  readonly steps: readonly WorkstreamStep[];
  readonly stepIndex: number;
  readonly model: string;
  readonly effort: Effort;
}

/** The step a workstream is on. One started before flows has none stored: it runs as one implement step. */
export function currentStep(ws: StepPosition): WorkstreamStep {
  if (ws.steps.length > 0) {
    const stored = ws.steps[ws.stepIndex];
    if (stored) return stored;
    throw new StepIndexError(ws.stepIndex, ws.steps.length);
  }
  return {
    role: StepRole.Implement,
    personaId: null,
    personaName: ROLE_LABEL.implement,
    tools: ToolAccess.Edit,
    profileId: null,
    model: ws.model,
    effort: ws.effort,
    need: 0,
    setting: null,
    reason: 'started before flows: runs on its stored model',
    overBudget: false,
    pinned: true,
    status: StepStatus.Running,
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    earlier: [],
    sentBack: 0,
  };
}

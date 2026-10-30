import { z } from 'zod';
import { ModelProfileId, PersonaId, SessionId } from './ids';
import { Effort, ROLE_SCORE, ScoreKind, StepRole, StepStatus, ToolAccess, Verdict } from './states';

/** Longest result a step may record: a plan or a review's notes. */
export const MAX_STEP_SUMMARY = 8000;

export const StepResult = z.object({
  summary: z.string().min(1).max(MAX_STEP_SUMMARY),
  verdict: z.enum(Verdict).nullable(),
  /** The session that recorded it, so a nudge knows whether this session has finished its step. */
  sessionId: SessionId,
  at: z.iso.datetime(),
});
export type StepResult = z.infer<typeof StepResult>;

/** One step of a workstream's resolved plan, fixed when the task starts. */
export const WorkstreamStep = z.object({
  role: z.enum(StepRole),
  personaId: PersonaId.nullable(),
  personaName: z.string(),
  tools: z.enum(ToolAccess),
  score: z.enum(ScoreKind),
  profileId: ModelProfileId.nullable(),
  model: z.string().min(1),
  effort: z.enum(Effort),
  need: z.number().min(0).max(100),
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
  result: StepResult.nullable(),
  /** Results this step kept when it ran again (a rejection it was sent back for), oldest first. */
  earlier: z.array(StepResult).default([]),
});
export type WorkstreamStep = z.infer<typeof WorkstreamStep>;

/** What starting a task would run, before it runs (the M2b approval sheet edits this). */
export const StepPlanDto = z.object({
  flowName: z.string(),
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
    score: ROLE_SCORE.implement,
    profileId: null,
    model: ws.model,
    effort: ws.effort,
    need: 0,
    reason: 'started before flows: runs on its stored model',
    overBudget: false,
    pinned: true,
    status: StepStatus.Running,
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    earlier: [],
  };
}

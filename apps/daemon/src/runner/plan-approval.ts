import {
  BUILDER_OWNS_LABELS,
  BuilderOwns,
  CardDecider,
  PlanChoice,
  StepRole,
  Verdict,
  WorkstreamState,
  decisionDetail,
  type BuilderCall,
  type InboxItemDto,
  type ProjectId,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  insertInboxItem,
  openItemsForWorkstream,
  updateInboxItem,
  type DbReader,
  type WorkstreamRow,
  type WriteContext,
} from '@10db/db';

/** What the builder is asked to approve before a task's Build starts. */
export interface PlanApproval {
  readonly workstreamId: WorkstreamId;
  readonly projectId: ProjectId;
  readonly taskTitle: string;
  readonly plan: string;
  /** Why the plan did not go ahead by itself: a clause after "Raised as a card because". */
  readonly reason?: string;
  /** Which of the seven the card is; product and taste when the plan named none. */
  readonly owns?: BuilderOwns;
}

/** The plan the workstream's Plan step recorded, as the builder is shown it. */
export function planOf(row: WorkstreamRow): string {
  const upTo = row.steps.slice(0, row.stepIndex + 1);
  const planStep = upTo.findLast((s) => s.role === StepRole.Plan);
  return planStep?.result?.summary ?? 'The plan step recorded no plan.';
}

/** The live `plan` card of a workstream, if the builder has not finished with it. */
export function livePlanCard(db: DbReader, workstreamId: WorkstreamId): InboxItemDto | undefined {
  return openItemsForWorkstream(db, workstreamId).find((item) => item.kind === 'plan');
}

const planBody = (approval: PlanApproval): string =>
  [
    approval.plan,
    ...(approval.reason === undefined ? [] : [`Raised as a card because ${approval.reason}.`]),
    'Approve to start the build, or send the plan back with a note.',
  ].join('\n\n');

/**
 * Asks the builder to approve a finished plan. A workstream has at most one live plan card, so a
 * restart finds the first and raises nothing new; a card that shows an older plan is brought up to
 * the plan being approved, so the builder never approves one they were not shown.
 */
export function raisePlanApproval(ctx: WriteContext, approval: PlanApproval): InboxItemDto {
  const existing = livePlanCard(ctx.tx, approval.workstreamId);
  if (existing) {
    if (existing.body === planBody(approval)) return existing;
    return updateInboxItem(ctx, existing.id, { body: planBody(approval) });
  }
  return insertInboxItem(ctx, {
    projectId: approval.projectId,
    kind: 'plan',
    title: `Plan ready for you to approve: ${approval.taskTitle}`,
    body: planBody(approval),
    options: [
      { label: PlanChoice.Approve, description: 'Build to this plan' },
      { label: PlanChoice.SendBack, description: 'Plan it again with my note' },
    ],
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail: {
      workstreamId: approval.workstreamId,
      ...decisionDetail({
        decider: CardDecider.Builder,
        owns: approval.owns ?? BuilderOwns.ProductAndTaste,
      }),
    },
    foldKey: null,
    targets: [{ workstreamId: approval.workstreamId, sessionId: null }],
  });
}

/** True while the workstream waits on its plan card: no session, no lane, only the builder can move it. */
export function waitsForPlanApproval(row: WorkstreamRow): boolean {
  return (
    row.state === WorkstreamState.WaitingHuman &&
    row.currentSessionId === null &&
    row.nextAction.kind === 'plan_approval'
  );
}

/** Whether a plan the builder would approve goes ahead by itself, or why it is the builder's card. */
export type PlanGate =
  | { readonly kind: 'ahead' }
  | { readonly kind: 'card'; readonly reason: string; readonly owns: BuilderOwns };

const callLines = (calls: readonly BuilderCall[]): string =>
  calls.map((c) => `${c.call} (${BUILDER_OWNS_LABELS[c.owns]})`).join('; ');

const cardFor = (reason: string, owns: BuilderOwns = BuilderOwns.ProductAndTaste): PlanGate => ({
  kind: 'card',
  reason,
  owns,
});

/**
 * Decides, before step `to` (Build) starts, whether a plan whose rigor asks for the builder's approval goes
 * ahead without a card (spec 2026-11-27 §3, "Plan ready"). It goes ahead only when the latest plan said its
 * brief needs nothing from the builder, a Plan Review after it approved, and that review found no call of the
 * builder's the brief left out. Anything unsaid is doubt, and doubt is the builder's. `asking` is the builder's
 * Ask Me Next Time for this rule.
 */
export function planGate(
  steps: readonly WorkstreamStep[],
  to: number,
  asking: boolean,
): PlanGate {
  if (asking) return cardFor('you asked to see plans before they are built');
  const before = steps.slice(0, to);
  const planAt = before.findLastIndex((s) => s.role === StepRole.Plan && s.result !== null);
  const plan = before[planAt]?.result;
  if (plan === undefined || plan === null) return cardFor('no plan was recorded');
  if (plan.builderCalls === undefined)
    return cardFor("the plan didn't say whether its brief needs you");
  const [first] = plan.builderCalls;
  if (first !== undefined)
    return cardFor(`its brief needs you: ${callLines(plan.builderCalls)}`, first.owns);
  const review = before
    .slice(planAt + 1)
    .findLast((s) => s.role === StepRole.PlanReview && s.result !== null)?.result;
  if (review?.verdict !== Verdict.Approve) return cardFor('no plan review approved it');
  const found = review.builderCalls ?? [];
  const [firstFound] = found;
  if (firstFound !== undefined)
    return cardFor(
      `its plan review found calls of yours the brief leaves out: ${callLines(found)}`,
      firstFound.owns,
    );
  return { kind: 'ahead' };
}

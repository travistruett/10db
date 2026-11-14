import {
  PlanChoice,
  StepRole,
  WorkstreamState,
  type InboxItemDto,
  type ProjectId,
  type WorkstreamId,
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
  `${approval.plan}\n\nApprove to start the build, or send the plan back with a note.`;

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
    detail: { workstreamId: approval.workstreamId },
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

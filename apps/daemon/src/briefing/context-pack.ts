import {
  EventType,
  type ContextPack,
  type TaskId,
  type DecisionId,
  type ProjectId,
  type SessionId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  findPersonByHandle,
  getHandoff,
  getInboxItem,
  getTask,
  latestHandoffForStep,
  listDecisions,
  listPrinciples,
  markTaskContextPacked,
  searchDecisionIds,
  type DbReader,
  type EmitInput,
  type WriteContext,
} from '@10db/db';
import {
  CONTEXT_PACK_BUDGET_TOKENS,
  decisionHit,
  PACK_SEARCH_LIMIT,
  packKnowledge,
  principleHit,
  workstreamAreas,
} from '../knowledge';
import { buildPlanContext } from '../plan-record';
import { renderPlanContext } from './plan-context-text';

/** The name of a stakeholder who answered, from the handle stored on the answer; null for the builder. */
function answerer(db: DbReader, handle: string | undefined): string | null {
  if (handle === undefined) return null;
  return findPersonByHandle(db, handle)?.name ?? handle;
}

/**
 * The task's search hits among the decisions, best first. A decision index the startup check could
 * not rebuild throws here; with no hits the pack falls back to the area and newest decisions instead
 * of failing the session's briefing, so no caller needs to know the index is broken.
 */
function rankedForTask(db: DbReader, projectId: ProjectId, query: string): DecisionId[] {
  try {
    return searchDecisionIds(db, { projectId, query, limit: PACK_SEARCH_LIMIT });
  } catch {
    return [];
  }
}

/**
 * Deterministic, budgeted context for a session (spec §9): the task, its live claims, the handoff to
 * continue from, any answer waiting to be delivered, and the knowledge that applies to the task: the
 * policies and heuristics in scope, then the decisions relevant to it, in a token budget.
 */
export function buildContextPack(
  db: DbReader,
  workstream: WorkstreamDto,
  opts: {
    readonly budgetTokens?: number;
    /** The base the session reads; a first session's row has none until its session is written. */
    readonly base?: string;
  } = {},
): ContextPack {
  const budgetTokens = opts.budgetTokens ?? CONTEXT_PACK_BUDGET_TOKENS;
  const task = getTask(db, workstream.taskId);
  const action = workstream.nextAction;
  const handoff =
    action.kind === 'continue_from_handoff'
      ? getHandoff(db, action.handoffId)
      : latestHandoffForStep(db, workstream);
  const answered = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;
  const { projectId } = workstream;
  const k = packKnowledge({
    areas: workstreamAreas(db, workstream),
    principles: listPrinciples(db, { projectId }),
    decisions: listDecisions(db, { projectId }),
    ranked: rankedForTask(db, projectId, `${task.title} ${task.description}`),
    budgetTokens,
  });
  const shown = k.policies.length + k.heuristics.length + k.decisions.length;
  return {
    task: {
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
    },
    claims: activeClaims(db, workstream.id).map((c) => ({ kind: c.kind, name: c.name })),
    handoff,
    pendingAnswer: answered?.answer
      ? {
          question: answered.title,
          answer: answered.answer.choice,
          note: answered.answer.note ?? null,
          answeredBy: answerer(db, answered.answer.answeredBy),
          via: answered.answer.via ?? 'inbox',
          words: answered.answer.words ?? null,
          conversation: answered.answer.conversation ?? [],
        }
      : null,
    knowledge: {
      policies: k.policies.map(principleHit),
      heuristics: k.heuristics.map(principleHit),
      decisions: k.decisions.map(decisionHit),
      budget: k.budgetTokens,
      budgetUsed: k.usedTokens,
      dropped: { ...k.dropped },
      droppedCount: k.dropped.policies + k.dropped.heuristics + k.dropped.decisions,
      empty: shown === 0,
    },
    plan: buildPlanContext(db, workstream, opts.base === undefined ? {} : { base: opts.base }),
  };
}

/**
 * Keeps the Plan block the brief carried, verbatim, on the task; the caller writes it with the
 * `context.packed` it rides on.
 */
export function recordPlanPacked(
  ctx: WriteContext,
  taskId: TaskId,
  workstreamId: WorkstreamId,
  pack: ContextPack,
): void {
  if (pack.plan === null) return;
  markTaskContextPacked(ctx, taskId, {
    text: renderPlanContext(pack.plan).join('\n'),
    workstreamId,
  });
}

/** Why a pack was injected: a new conversation, a resumed one, or an emergency compaction (spec §9). */
export const PackReason = { Start: 'start', Resume: 'resume', Compaction: 'compaction' } as const;
export type PackReason = (typeof PackReason)[keyof typeof PackReason];

/** The event that records what an injected pack used and left out (spec §9). */
export function contextPackedEvent(
  sessionId: SessionId,
  workstreamId: WorkstreamId,
  pack: ContextPack,
  reason: PackReason,
): EmitInput {
  const k = pack.knowledge;
  return {
    type: EventType.ContextPacked,
    entityType: 'session',
    entityId: sessionId,
    data: {
      workstreamId,
      reason,
      budget: k.budget,
      budgetUsed: k.budgetUsed,
      dropped: { ...k.dropped },
      principles: [...k.policies, ...k.heuristics].map((p) => p.id),
      decisions: k.decisions.map((d) => d.id),
      plan:
        pack.plan === null
          ? null
          : {
              shapeId: pack.plan.shapeId,
              revisionId: pack.plan.revisionId,
              section: pack.plan.section.ref,
              included: [
                ...pack.plan.decisions.map((d) => ({ key: d.key, version: null })),
                ...pack.plan.names.map((n) => ({ key: n.key, version: n.version })),
                ...pack.plan.facts.map((f) => ({ key: f.key, version: f.version })),
                ...pack.plan.intent.map((i) => ({ key: i.key, version: i.version })),
              ],
              findings: pack.plan.findings.map((f) => ({ key: f.key, state: 'open' })),
              notIncluded: [...pack.plan.notIncluded],
              budget: pack.plan.budget,
              used: pack.plan.used,
            },
    },
  };
}

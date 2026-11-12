import {
  EventType,
  type ContextPack,
  type DecisionId,
  type ProjectId,
  type SessionId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  getHandoff,
  getInboxItem,
  getTask,
  latestHandoffForStep,
  listDecisions,
  listPrinciples,
  searchDecisionIds,
  type DbReader,
  type EmitInput,
} from '@10db/db';
import {
  CONTEXT_PACK_BUDGET_TOKENS,
  decisionHit,
  PACK_SEARCH_LIMIT,
  packKnowledge,
  principleHit,
  workstreamAreas,
} from '../knowledge';

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
  budgetTokens: number = CONTEXT_PACK_BUDGET_TOKENS,
): ContextPack {
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
          answeredBy: answered.answer.answeredBy ?? null,
          via: answered.answer.via ?? 'inbox',
          words: answered.answer.words ?? null,
          conversation: [],
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
  };
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
    },
  };
}

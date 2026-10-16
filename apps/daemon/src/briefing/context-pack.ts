import type { ContextPack, KnowledgeHit, WorkstreamDto } from '@10db/contracts';
import {
  activeClaims,
  getHandoff,
  getInboxItem,
  getTask,
  latestHandoff,
  listRecentDecisions,
  searchDecisions,
  type DbReader,
} from '@10db/db';

const DEFAULT_BUDGET_CHARS = 4000;
const SEARCH_LIMIT = 20;
const RECENT_LIMIT = 5;

const sizeOf = (hit: KnowledgeHit) =>
  hit.question.length + hit.choice.length + hit.rationale.length + 16;

/**
 * Deterministic, budgeted context for a session: the task, its live claims, the handoff to continue
 * from, any answer waiting to be delivered, and the recorded decisions most relevant to the task
 * (the most recent ones when none match), packed greedily into a character budget.
 */
export function buildContextPack(
  db: DbReader,
  workstream: WorkstreamDto,
  budgetChars: number = DEFAULT_BUDGET_CHARS,
): ContextPack {
  const task = getTask(db, workstream.taskId);
  const action = workstream.nextAction;
  const handoff =
    action.kind === 'continue_from_handoff'
      ? getHandoff(db, action.handoffId)
      : latestHandoff(db, workstream.id);
  const answered = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;

  const relevant = searchDecisions(
    db,
    workstream.projectId,
    `${task.title} ${task.description}`,
    SEARCH_LIMIT,
  );
  const candidates =
    relevant.length > 0 ? relevant : listRecentDecisions(db, workstream.projectId, RECENT_LIMIT);
  const decisions: KnowledgeHit[] = [];
  let used = 0;
  for (const hit of candidates) {
    if (used + sizeOf(hit) > budgetChars) continue;
    decisions.push(hit);
    used += sizeOf(hit);
  }

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
        }
      : null,
    knowledge: {
      decisions,
      budgetUsed: Math.ceil(used / 4),
      droppedCount: candidates.length - decisions.length,
      empty: decisions.length === 0,
    },
  };
}

import {
  DECISION_CATEGORIES,
  InboxKind,
  InvalidError,
  KnowledgeScope,
  PrincipleKind,
  SourceKind,
  targetColumns,
  topicKeyFrom,
  type DecisionId,
  type DecisionRecording,
  type InboxAnswer,
  type InboxItemDto,
  type KnowledgeTarget,
  type ProjectDto,
  type ProjectId,
  type ProposalId,
} from '@10db/contracts';
import { BUILDER_HANDLE, insertDecision, insertSource, type WriteContext } from '@10db/db';
import { proposePrinciple } from './proposals';
import { standingRules } from './standing-rules';

const PROJECT_RECORDING: DecisionRecording = { scope: KnowledgeScope.Project, area: null };

function recordingTarget(r: DecisionRecording, projectId: ProjectId): KnowledgeTarget {
  switch (r.scope) {
    case KnowledgeScope.You:
      return { scope: KnowledgeScope.You };
    case KnowledgeScope.Project:
      return { scope: KnowledgeScope.Project, projectId };
    case KnowledgeScope.Area:
      // DecisionRecording refuses an area scope without an area; the fallback only satisfies the type.
      return r.area === null
        ? { scope: KnowledgeScope.Project, projectId }
        : { scope: KnowledgeScope.Area, projectId, area: r.area };
  }
}

/**
 * Whether and where an answered question becomes a decision (spec §9 "Inbox answers become decisions"):
 * where the answer says, else at project scope for a product, design or engineering question.
 */
export function answerRecording(item: InboxItemDto, answer: InboxAnswer): DecisionRecording | null {
  if (item.kind !== InboxKind.Question) return null;
  if (answer.record !== undefined) return answer.record;
  return DECISION_CATEGORIES.includes(item.category) ? PROJECT_RECORDING : null;
}

/** Records the answer as a decision where it says (or its category implies), with the card as its source. */
export function recordAnswerDecision(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
  project: ProjectDto,
): DecisionId | null {
  const recording = answerRecording(item, answer);
  if (recording === null) return null;
  if (recording.area !== null && !project.areas.some((a) => a.name === recording.area))
    throw new InvalidError(`${project.name} has no area named ${recording.area}`);
  const sourceId = insertSource(ctx, SourceKind.InboxAnswer, { inboxId: item.id });
  return insertDecision(ctx, {
    ...targetColumns(recordingTarget(recording, item.projectId)),
    question: item.title,
    choice: answer.choice,
    rationale: answer.note ?? 'Answered in the inbox',
    decidedBy: BUILDER_HANDLE,
    sourceId,
  });
}

/** Each always/never sentence in an answer's note becomes a principle proposal for the builder (spec §9). */
export function proposeStandingRules(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): ProposalId[] {
  if (item.kind !== InboxKind.Question || answer.note === undefined) return [];
  const rules = standingRules(answer.note);
  if (rules.length === 0) return [];
  const sourceId = insertSource(ctx, SourceKind.InboxAnswer, { inboxId: item.id });
  return rules.map(
    (statement) =>
      proposePrinciple(ctx, {
        projectId: item.projectId,
        title: `Make this a principle? ${statement}`,
        body: `You wrote this answering "${item.title}".`,
        draft: {
          statement,
          kind: PrincipleKind.Policy,
          topicKey: topicKeyFrom(statement),
          scope: KnowledgeScope.Project,
          quote: statement,
        },
        sourceId,
        speaker: BUILDER_HANDLE,
      }).proposalId,
  );
}

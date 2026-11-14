import {
  InboxKind,
  SkipKind,
  SkipSource,
  type ProjectId,
  type QuestionCategory,
  type TaskId,
} from '@10db/contracts';
import { assigneesFor, BUILDER_HANDLE, type DbReader } from '@10db/db';
import { AWAY_ANSWER } from './skip';
import type { SkipRecorder } from './skip-recorder';

// T4 call 21: a lane nobody watches asks no question of the builder. It is answered at once with
// AWAY_ANSWER, and kept for the builder's list. A question the project routes to a named person
// still goes to them: the builder chose who answers it.

/** A lane nobody watches, as its question tools see it. */
export interface AwayLane {
  readonly skips: SkipRecorder;
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
}

/**
 * Whether the inbox would send a question of this category and topic, asked by this task, to
 * someone other than the builder: the same routing a question card gets, triage's choices included.
 */
export function routedToPerson(
  db: DbReader,
  task: { readonly id: TaskId; readonly projectId: ProjectId },
  question: { readonly category: QuestionCategory; readonly topic: string | null },
): boolean {
  return assigneesFor(db, {
    projectId: task.projectId,
    kind: InboxKind.Question,
    category: question.category,
    topic: question.topic,
    taskIds: [task.id],
    passPage: false,
  }).handles.some((handle) => handle !== BUILDER_HANDLE);
}

/** Records the question a lane nobody watches would have asked, and answers it. */
export function answerAway(away: AwayLane, toolName: string, question: string): string {
  away.skips.record({
    toolName,
    toolUseId: null,
    callKey: null,
    summary: question,
    kind: SkipKind.Question,
    limit: null,
    reason: 'The builder was away.',
    source: SkipSource.Question,
  });
  return AWAY_ANSWER;
}

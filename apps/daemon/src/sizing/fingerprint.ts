import { createHash } from 'node:crypto';
import type { GoalId } from '@10db/contracts';

/** What a task is sized from: the text that says what the work is, and the goal it belongs to. */
export interface SizedText {
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly areas: readonly string[];
  readonly goalId?: GoalId | null | undefined;
}

/**
 * A hash of what a task is sized from. A task is sized again only when this changes, so a thread message
 * or a move, which touch none of it, never costs a call.
 */
export function sizingFingerprint(text: SizedText): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        text.title,
        text.description,
        text.acceptanceCriteria,
        text.areas,
        text.goalId ?? null,
      ]),
    )
    .digest('hex');
}

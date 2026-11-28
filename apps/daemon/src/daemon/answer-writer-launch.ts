import { getInboxItem } from '@10db/db';
import {
  acceptWritten,
  answerPrompt,
  questionContext,
  type AnswerWriter,
  type WrittenAnswer,
} from '../stakeholders';
import { prepareProjectQuestion, type ProjectQuestionDeps } from './project-question';

/** How long the model has to answer before the question goes to the builder instead. */
const ANSWER_TIMEOUT_MS = 60_000;

export type AnswerWriterDeps = ProjectQuestionDeps;

const declined = (
  reason: Extract<WrittenAnswer, { kind: 'declined' }>['reason'],
): WrittenAnswer => ({
  kind: 'declined',
  reason,
});

/**
 * Writes an answer to a stakeholder's question with a model of the card's project's account
 * (`prepareProjectQuestion`). The model starts in a new empty folder and gets the card's context as text, so no
 * project file is read or run. Every failure is a decline; it never throws.
 */
export function createAnswerWriter(deps: AnswerWriterDeps): AnswerWriter {
  return async ({ cardId, question, askerName, signal }) => {
    try {
      const card = getInboxItem(deps.db, cardId);
      const prepared = prepareProjectQuestion(deps, card.projectId);
      if (prepared.kind === 'declined') return declined(prepared.reason);
      const raw = await prepared.ask(
        answerPrompt(questionContext(deps.db, cardId), question, askerName),
        { timeoutMs: ANSWER_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      return acceptWritten(raw);
    } catch {
      return declined('failed');
    }
  };
}

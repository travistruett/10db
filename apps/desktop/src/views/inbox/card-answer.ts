import {
  InboxKind,
  isParkChoice,
  type DecisionRecording,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';

/** A recommendation preselects only when it names one of the options. */
export function recommended(item: InboxItemDto): string | null {
  return item.options.some((o) => o.label === item.recommendation) ? item.recommendation : null;
}

/**
 * What a card's answer sends: the choice, the note when one was typed, and for a question how it is
 * recorded, so the daemon never guesses from the category. Parking the task is 10db's control over
 * the run, not an answer: nothing is recorded, so nothing is sent.
 */
export function cardAnswer(
  item: InboxItemDto,
  choice: string,
  note: string,
  recording: DecisionRecording | null,
): InboxAnswer {
  const trimmed = note.trim();
  const base: InboxAnswer = trimmed === '' ? { choice } : { choice, note: trimmed };
  return item.kind === InboxKind.Question && !isParkChoice(choice)
    ? { ...base, record: recording }
    : base;
}

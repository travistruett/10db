import { escapeMrkdwn } from './escape';

export type ClosingReason = 'builder' | 'taken_back' | 'cancelled';

/**
 * What 10db says in a thread when the builder settles the question instead of the stakeholder: his
 * answer, his taking it back (or parking the task), or the question no longer being needed. `choice` is
 * the letter of the option he picked, or null for words that match none.
 */
export function closingLine(
  reason: ClosingReason,
  builderName: string,
  choice: string | null,
): string {
  const name = escapeMrkdwn(builderName);
  switch (reason) {
    case 'builder':
      return choice === null
        ? `${name} answered this one. Thanks!`
        : `${name} answered this one: ${escapeMrkdwn(choice)}. Thanks!`;
    case 'taken_back':
      return `Never mind this one, ${name} has it. Thanks!`;
    case 'cancelled':
      return 'This one is no longer needed. Thanks!';
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

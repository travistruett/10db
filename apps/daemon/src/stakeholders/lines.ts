import { escapeMrkdwn } from './escape';

/** A Slack user id, the only thing a mention is ever built from. */
const USER_ID = /^[UW][A-Z0-9]{2,}$/;

function mentions(userIds: readonly string[]): string {
  return userIds
    .filter((id) => USER_ID.test(id))
    .map((id) => `<@${id}>`)
    .join(' ');
}

/** "Mark", "Mark and Ana", "Mark, Ana and Lee", each name escaped. */
export function joinNames(names: readonly string[]): string {
  const safe = names.map(escapeMrkdwn);
  const last = safe.at(-1);
  if (last === undefined) return '';
  return safe.length === 1 ? last : `${safe.slice(0, -1).join(', ')} and ${last}`;
}

/** "A or B", "A, B or C". */
function orList(letters: readonly string[]): string {
  const last = letters.at(-1);
  if (last === undefined) return '';
  return letters.length === 1 ? last : `${letters.slice(0, -1).join(', ')} or ${last}`;
}

/** The last line of every question message. */
export function replyWithLine(letters: readonly string[]): string {
  return letters.length === 0
    ? 'Reply with your own words.'
    : `Reply with ${letters.join(', ')}, or your own words.`;
}

export function broughtInLine(broughtBy: string, names: readonly string[]): string {
  return `${escapeMrkdwn(broughtBy)} brought in ${joinNames(names)}. Here's the question:`;
}

export function movedLine(names: readonly string[]): string {
  return `Moved to a group DM with ${joinNames(names)}.`;
}

export function couldntAddLine(name: string): string {
  return `10db couldn't add ${escapeMrkdwn(name)} to this conversation.`;
}

export function fullLine(): string {
  return "This conversation is full; 10db can't add anyone else.";
}

/** The proposal a settled conversation landed on, for the recipients to approve with a ✅ or change. */
export function proposalLine(
  choiceLetter: string,
  label: string,
  favouredNames: readonly string[],
  recipientUserIds: readonly string[],
): string {
  const favoured = favouredNames.length > 0 ? ` (${joinNames(favouredNames)})` : '';
  return `Sounds like *${escapeMrkdwn(choiceLetter)}*: ${escapeMrkdwn(label)}${favoured}. ${mentions(recipientUserIds)}, ✅ to approve or reply to change.`;
}

export function whichWayLine(
  letters: readonly string[],
  recipientUserIds: readonly string[],
): string {
  return `${mentions(recipientUserIds)}, which way should this go? Reply with ${orList(letters)}, or in your own words.`;
}

export function reminderLine(): string {
  return 'Bumping this: the work is still waiting on your answer.';
}

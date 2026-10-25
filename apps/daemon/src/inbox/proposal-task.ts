import { InvalidError } from '@10db/contracts';

/** The longest task title the contract accepts (the Title rule in @10db/contracts). */
const TITLE_MAX = 200;

interface TaskFields {
  readonly title: string;
  readonly description: string;
}

/**
 * The task an accepted proposal files. A task title is one line, so line breaks and control characters
 * become spaces. A title longer than the limit is cut, and its full text leads the description so the
 * cut loses nothing.
 */
export function taskFieldsFromProposal(proposal: {
  readonly title: string;
  readonly body: string;
}): TaskFields {
  const line = proposal.title.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (line === '') throw new InvalidError('A proposal needs a title before it can become a task');
  if (line.length <= TITLE_MAX) return { title: line, description: proposal.body };
  return {
    title: line.slice(0, TITLE_MAX).trimEnd(),
    description: `${proposal.title.trim()}\n\n${proposal.body}`,
  };
}

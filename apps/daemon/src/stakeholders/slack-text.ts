import type { SlackBlock } from '../slack';

/** A message's text as the sections 10db posts: one verbatim section per paragraph, so nothing is linked or mentioned. */
export function blocksOf(text: string): SlackBlock[] {
  return text
    .split(/\n{2,}/)
    .filter((section) => section.trim() !== '')
    .map((section) => ({
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: section, verbatim: true as const },
    }));
}

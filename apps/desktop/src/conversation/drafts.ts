import { mentionText } from './mention-text';

/** What the builder has typed, mentioned and pasted into a conversation's composer and not sent yet. */
export interface Draft {
  readonly text: string;
  /** The paths the text's `@` mentions name. */
  readonly mentions: readonly string[];
  readonly pictures: readonly File[];
}

export const EMPTY_DRAFT: Draft = { text: '', mentions: [], pictures: [] };

/** Whether the draft holds anything to send: words or a picture. */
export function hasContent(draft: Draft): boolean {
  return draft.text.trim() !== '' || draft.pictures.length > 0;
}

/**
 * What the input holds once the send of `sent` succeeds: nothing when it is just that text, and
 * otherwise the text with the sent part taken off the end, where Plan's late outcome puts a
 * failed text restored during the send. An input edited into something else stays as it stands.
 */
export function withoutSent(typed: string, sent: string): string {
  const text = typed.trim();
  if (text === sent) return '';
  const tail = `\n\n${sent}`;
  return text.endsWith(tail) ? text.slice(0, -tail.length) : typed;
}

/** What the composer holds once `sent` has gone: whatever was added to it while the send was on its way. */
export function afterSend(now: Draft, sent: Draft): Draft {
  const text = withoutSent(now.text, sent.text.trim());
  const pictures = now.pictures.filter((picture) => !sent.pictures.includes(picture));
  if (text.trim() === '' && pictures.length === 0) return EMPTY_DRAFT;
  return { text, mentions: mentionText(text).mentions, pictures };
}

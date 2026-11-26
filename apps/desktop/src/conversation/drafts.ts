import type { PagePick } from '@10db/contracts';
import { mentionText } from './mention-text';

/** A pick from a page's Preview waiting in its draft (Pick on Page spec §4), with its crop. */
export interface DraftPick {
  readonly pick: PagePick;
  readonly crop: File | null;
}

/** What the builder has typed, mentioned and pasted into a conversation's composer and not sent yet. */
export interface Draft {
  readonly text: string;
  /** The paths the text's `@` mentions name. */
  readonly mentions: readonly string[];
  readonly pictures: readonly File[];
  /** Picks from the page's Preview; only a Workbench page's draft holds any. */
  readonly picks?: readonly DraftPick[];
}

export const EMPTY_DRAFT: Draft = { text: '', mentions: [], pictures: [] };

/**
 * A change to a draft: the new draft, or how to make it from the draft as it stands when the change
 * lands, for a change that finishes after the screen may have moved on (a send that fails late).
 */
export type DraftChange = Draft | ((now: Draft) => Draft);

/** The draft `change` makes of `now`. */
export function applyDraftChange(now: Draft, change: DraftChange): Draft {
  return typeof change === 'function' ? change(now) : change;
}

/** Whether the draft holds anything the builder typed or pasted: words or a picture. */
export function hasTyped(draft: Draft): boolean {
  return draft.text.trim() !== '' || draft.pictures.length > 0;
}

/** Whether the draft holds anything to send: words, a picture or a pick. */
export function hasContent(draft: Draft): boolean {
  return hasTyped(draft) || (draft.picks?.length ?? 0) > 0;
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

/** What the composer holds once `sent` has gone: whatever was added to it since. */
export function afterSend(now: Draft, sent: Draft): Draft {
  const text = withoutSent(now.text, sent.text.trim());
  const pictures = now.pictures.filter((picture) => !sent.pictures.includes(picture));
  const sentPicks = new Set((sent.picks ?? []).map((p) => p.pick.id));
  const picks = (now.picks ?? []).filter((p) => !sentPicks.has(p.pick.id));
  if (text.trim() === '' && pictures.length === 0 && picks.length === 0) return EMPTY_DRAFT;
  return {
    text,
    mentions: mentionText(text).mentions,
    pictures,
    ...(picks.length === 0 ? {} : { picks }),
  };
}

/**
 * What the composer holds once the send of `sent` fails: its words and pictures back where they were,
 * ahead of whatever was typed or added while the send was on its way, since the input emptied as Send
 * was pressed.
 */
export function afterFailedSend(now: Draft, sent: Draft): Draft {
  const typed = now.text.trim();
  const words = sent.text.trim();
  const text =
    words === ''
      ? now.text
      : typed === '' || typed === words
        ? sent.text
        : `${sent.text.trimEnd()}\n\n${now.text}`;
  const pictures = [
    ...sent.pictures,
    ...now.pictures.filter((picture) => !sent.pictures.includes(picture)),
  ];
  const sentPicks = sent.picks ?? [];
  const sentIds = new Set(sentPicks.map((p) => p.pick.id));
  const picks = [...sentPicks, ...(now.picks ?? []).filter((p) => !sentIds.has(p.pick.id))];
  return {
    text,
    mentions: mentionText(text).mentions,
    pictures,
    ...(picks.length === 0 ? {} : { picks }),
  };
}

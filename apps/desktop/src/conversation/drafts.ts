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

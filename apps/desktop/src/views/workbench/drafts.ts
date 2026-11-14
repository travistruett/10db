/** What the builder has typed and pasted into a page's composer and not sent yet. */
export interface Draft {
  readonly text: string;
  readonly pictures: readonly File[];
}

export const EMPTY_DRAFT: Draft = { text: '', pictures: [] };

/** Whether the draft holds anything to send: words or a picture. */
export function hasContent(draft: Draft): boolean {
  return draft.text.trim() !== '' || draft.pictures.length > 0;
}

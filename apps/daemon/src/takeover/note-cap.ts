/** A note's longest length: a list of left-out skills can run to hundreds of lines. */
export const NOTE_MAX = 800;

/** Cuts a note to `NOTE_MAX` characters, never between the two halves of a surrogate pair. */
export function capNote(note: string): string {
  if (note.length <= NOTE_MAX) return note;
  const last = note.charCodeAt(NOTE_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? NOTE_MAX - 1 : NOTE_MAX;
  return `${note.slice(0, end)}…`;
}

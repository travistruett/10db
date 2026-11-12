/** Something of the builder's or the project's setup that a session starts without, and why. */
export interface LeftOut {
  readonly what: string;
  readonly why: string;
}

/** The note a session's prompt ends with, one line per item in order; null when nothing was left out. */
export function leftOutNote(items: readonly LeftOut[]): string | null {
  if (items.length === 0) return null;
  return [
    'Note from 10db: left out of this session:',
    ...items.map((i) => `- ${i.what}: ${i.why}`),
  ].join('\n');
}

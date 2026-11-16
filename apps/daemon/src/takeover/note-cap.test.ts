import { describe, expect, it } from 'vitest';
import { capNote, NOTE_MAX } from './note-cap';

describe('capNote', () => {
  const rows = [
    { name: 'a short note is kept', note: 'short', out: 'short' },
    { name: 'a note at the limit is kept', note: 'x'.repeat(NOTE_MAX), out: 'x'.repeat(NOTE_MAX) },
    { name: 'a long note is cut', note: 'x'.repeat(NOTE_MAX + 5), out: `${'x'.repeat(NOTE_MAX)}…` },
    {
      name: 'a cut between a pair drops the pair',
      note: `${'x'.repeat(NOTE_MAX - 1)}😀tail`,
      out: `${'x'.repeat(NOTE_MAX - 1)}…`,
    },
  ];
  it.each(rows)('$name', ({ note, out }) => {
    expect(capNote(note)).toBe(out);
  });
});

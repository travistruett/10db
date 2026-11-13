import { describe, expect, it } from 'vitest';
import { GUTTER_ROWS } from '../test/hunks';
import { hunkGutter } from './hunk-gutter';

describe('hunkGutter', () => {
  it.each(GUTTER_ROWS)('%s', (_name, input, expected) => {
    expect(hunkGutter(input).map((l) => [l.kind, l.number, l.text])).toEqual(expected);
  });
});

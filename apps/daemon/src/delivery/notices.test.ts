import { describe, expect, it } from 'vitest';
import { migrationNotices, uncarriedIn } from './notices';

describe('the renumbered migrations notice', () => {
  const lines = (notice: { readonly record?: string | undefined }): unknown =>
    JSON.parse(notice.record ?? '[]');

  it('replaces the line of a migration renumbered again from the same tag', () => {
    const first = migrationNotices.renumbered(undefined, [{ from: '0042_x', to: '0043_x' }]);
    const again = migrationNotices.renumbered(first, [{ from: '0042_x', to: '0044_x' }]);

    expect(lines(again)).toEqual([{ from: '0042_x', to: '0044_x' }]);
    expect(again.line).toContain('1 of this batch');
    expect(again.body).toContain('0042_x → 0044_x');
    expect(again.body).not.toContain('0043_x');
  });

  it('keeps one line when the same renumbering is told twice', () => {
    const first = migrationNotices.renumbered(undefined, [{ from: '0042_x', to: '0043_x' }]);
    const again = migrationNotices.renumbered(first, [{ from: '0042_x', to: '0043_x' }]);

    expect(lines(again)).toEqual([{ from: '0042_x', to: '0043_x' }]);
  });

  it('still follows a migration moved on from the tag it holds now', () => {
    const first = migrationNotices.renumbered(undefined, [{ from: '0042_x', to: '0043_x' }]);
    const again = migrationNotices.renumbered(first, [{ from: '0043_x', to: '0044_x' }]);

    expect(lines(again)).toEqual([{ from: '0042_x', to: '0044_x' }]);
  });
});

describe('reading the lost-migrations notice', () => {
  const stored = migrationNotices.uncarried([{ tag: '0001_x', at: 'abc' }]);

  it('reads the list, and an empty one when there is no notice', () => {
    expect(uncarriedIn(stored)).toEqual([{ tag: '0001_x', at: 'abc' }]);
    expect(uncarriedIn(undefined)).toEqual([]);
  });

  it('answers null, not an empty list, when the notice has no list it can read', () => {
    expect(
      uncarriedIn({ key: stored.key, tone: stored.tone, line: stored.line, body: stored.body }),
    ).toBeNull();
    expect(uncarriedIn({ ...stored, record: 'not json' })).toBeNull();
    expect(uncarriedIn({ ...stored, record: '{"tag":"0001_x"}' })).toBeNull();
  });
});

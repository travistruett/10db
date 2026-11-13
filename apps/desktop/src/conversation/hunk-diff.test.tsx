import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GUTTER_ROWS, hunk } from '../test/hunks';
import { renderWithTheme } from '../test/theme';
import { HunkDiff } from './hunk-diff';

/** The kind of each row Mantine's Diff draws, read from its line classes. */
function diffKinds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tr.mantine-Diff-row')].map((row) =>
    row.querySelector('.mantine-Diff-addedLine')
      ? 'added'
      : row.querySelector('.mantine-Diff-removedLine')
        ? 'removed'
        : 'context',
  );
}

/** The gutter's rows, as `kind number`. */
function gutter(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-gutter-line]')].map(
    (line) => `${line.getAttribute('data-kind') ?? ''} ${line.getAttribute('data-number') ?? ''}`,
  );
}

describe('HunkDiff', () => {
  it.each(GUTTER_ROWS)('%s: the gutter has one row per drawn line, of its kind', (_n, h, rows) => {
    const { container } = renderWithTheme(<HunkDiff hunk={h} first />);
    expect(diffKinds(container)).toEqual(rows.map(([kind]) => kind));
    expect(gutter(container)).toEqual(rows.map(([kind, number]) => `${kind} ${String(number)}`));
  });

  it('heads every hunk but the first with its ranges', () => {
    const h = hunk(1200, 1203, ['x'], ['x', 'y']);
    const { unmount } = renderWithTheme(<HunkDiff hunk={h} first />);
    expect(screen.queryByText(/^@@/)).toBeNull();
    unmount();
    renderWithTheme(<HunkDiff hunk={h} first={false} />);
    expect(screen.getByText('@@ −1200,1 +1203,2 @@')).toBeTruthy();
  });

  it('cuts to maxLines rows', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`);
    const { container } = renderWithTheme(
      <HunkDiff hunk={hunk(1, 1, [], lines)} first maxLines={8} />,
    );
    expect(diffKinds(container)).toHaveLength(8);
    expect(gutter(container)).toHaveLength(8);
  });

  it('labels each line for a screen reader, and hides the drawing', () => {
    const [, h] = GUTTER_ROWS[0] ?? [];
    if (h === undefined) throw new Error('no row');
    const { container } = renderWithTheme(<HunkDiff hunk={h} first />);
    const list = screen.getByRole('list', { name: 'Changed lines' });
    const items = within(list)
      .getAllByRole('listitem')
      .map((i) => i.textContent);
    expect(items).toContain('added line 44: b');
    expect(items).toContain('removed line 44: a');
    expect(items).toContain('line 41: c1');
    expect(container.querySelector('table')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

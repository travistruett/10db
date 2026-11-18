import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithTheme } from '../../test/theme';
import { InboxRowList, ROW_HEIGHT_PX } from './inbox-row-list';

// Spec §4.1 "Performance": rows are a fixed height, so a list of any length mounts only the rows near
// the viewport, and the next page loads near the end. jsdom does no layout; the viewport is 600 px
// (test/setup.ts).
interface Row {
  readonly key: string;
  readonly title: string;
}

const rowsOf = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ key: `r${String(i)}`, title: `Row ${String(i)}` }));

interface Options {
  readonly rows: readonly Row[];
  readonly selected?: string | null;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly moreError?: Error | null;
  readonly onNearEnd?: () => void;
}

function draw({
  rows,
  selected = null,
  hasMore = false,
  loadingMore = false,
  moreError = null,
  onNearEnd = () => undefined,
}: Options) {
  return (
    <InboxRowList
      label="Open"
      rows={rows}
      selected={selected}
      hasMore={hasMore}
      loadingMore={loadingMore}
      moreError={moreError}
      onNearEnd={onNearEnd}
      renderRow={(row) => <span>{row.title}</span>}
    />
  );
}

const list = (): HTMLElement => screen.getByRole('listbox', { name: 'Open' });
const viewport = (): HTMLElement => {
  const el = list().closest('[data-scrollarea-viewport]');
  if (!(el instanceof HTMLElement)) throw new Error('no viewport');
  return el;
};
const mounted = (): number => list().querySelectorAll('[data-inbox-row]').length;
const scrollTo = (top: number): void => {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
};

describe('InboxRowList', () => {
  it('mounts under 100 of 10,000 rows, and the rows at a scrolled offset', () => {
    renderWithTheme(draw({ rows: rowsOf(10_000) }));
    expect(mounted()).toBeGreaterThan(0);
    expect(mounted()).toBeLessThan(100);
    scrollTo(5000 * ROW_HEIGHT_PX);
    expect(screen.getByText('Row 5000')).toBeTruthy();
    expect(mounted()).toBeLessThan(100);
  });

  it('marks the selected row and names the list', () => {
    renderWithTheme(draw({ rows: rowsOf(3), selected: 'r1' }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('lets Tab into the list on the selected row only', () => {
    renderWithTheme(draw({ rows: rowsOf(3), selected: 'r1' }));
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
  });

  it('lets Tab into the list on the first row when none is selected', () => {
    renderWithTheme(draw({ rows: rowsOf(3) }));
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ]);
  });

  it('asks for the next page only near the end', () => {
    const onNearEnd = vi.fn();
    renderWithTheme(draw({ rows: rowsOf(30), hasMore: true, onNearEnd }));
    expect(onNearEnd).not.toHaveBeenCalled();
    scrollTo(30 * ROW_HEIGHT_PX);
    expect(onNearEnd).toHaveBeenCalled();
  });

  it('asks for no page when there is no more', () => {
    const onNearEnd = vi.fn();
    renderWithTheme(draw({ rows: rowsOf(30), hasMore: false, onNearEnd }));
    scrollTo(30 * ROW_HEIGHT_PX);
    expect(onNearEnd).not.toHaveBeenCalled();
  });

  it('draws one placeholder after the rows while a page loads', () => {
    renderWithTheme(draw({ rows: rowsOf(2), hasMore: true, loadingMore: true }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getAllByText('Loading more')).toHaveLength(1);
  });

  it('says so when a page failed, and retries on the next scroll', () => {
    const onNearEnd = vi.fn();
    renderWithTheme(
      draw({ rows: rowsOf(30), hasMore: true, moreError: new Error('offline'), onNearEnd }),
    );
    expect(onNearEnd).not.toHaveBeenCalled();
    scrollTo(30 * ROW_HEIGHT_PX);
    expect(screen.getByText("Couldn't load more")).toBeTruthy();
    expect(onNearEnd).toHaveBeenCalled();
  });
});

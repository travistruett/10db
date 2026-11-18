import { Box, ScrollArea, Skeleton } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { LIST_ATTRIBUTE } from './use-inbox-keys';
import classes from './inbox-row-list.module.css';

/** Rows are a fixed height, so the list never measures one (spec §4.1 "Performance"). */
export const ROW_HEIGHT_PX = 52;
/** Rows mounted past each edge of the viewport. */
const OVERSCAN_ROWS = 10;
/** The next page loads when the last visible row is this close to the end of what is loaded. */
const NEAR_END_ROWS = 10;

export interface InboxRowListProps<T extends { readonly key: string }> {
  /** The list's accessible name. */
  readonly label: string;
  readonly rows: readonly T[];
  /** The selected row's key. */
  readonly selected: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** The last page's failure; the next near-end retries it. */
  readonly moreError: Error | null;
  readonly onNearEnd: () => void;
  /** Where the list starts scrolled, in pixels. */
  readonly initialScroll?: number;
  /** The list's scroll position after the builder scrolls it. */
  readonly onScrollTop?: (scrollTop: number) => void;
  /**
   * Whether the selected row takes focus when the list is first drawn and focus is not in the page's content, so
   * `j` and `k` work at once. Focus already on a row follows the selection either way.
   */
  readonly focusOnArrival?: boolean;
  /** A click on a row. */
  readonly onPick?: (row: T) => void;
  /** The row's two lines; the list draws the row around them. */
  readonly renderRow: (row: T, selected: boolean) => ReactNode;
}

/**
 * The panel's rows as a windowed listbox: only the rows in view and an overscan are mounted, and the
 * next page is asked for within 10 rows of the end. Written by hand, as `conversation-list.tsx` is,
 * because the compiler skips a component that calls `useVirtualizer`.
 */
export function InboxRowList<T extends { readonly key: string }>({
  label,
  rows,
  selected,
  hasMore,
  loadingMore,
  moreError,
  onNearEnd,
  initialScroll = 0,
  onScrollTop,
  focusOnArrival = false,
  onPick,
  renderRow,
}: InboxRowListProps<T>) {
  const viewport = useRef<HTMLDivElement>(null);
  const footer = loadingMore || moreError !== null;
  const count = rows.length + (footer ? 1 : 0);
  // eslint-disable-next-line react-hooks/incompatible-library -- the skip is why this is its own component.
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => viewport.current,
    estimateSize: () => ROW_HEIGHT_PX,
    getItemKey: (index) => rows[index]?.key ?? 'more',
    overscan: OVERSCAN_ROWS,
  });

  // Where the builder left the list.
  useLayoutEffect(() => {
    if (initialScroll > 0 && viewport.current !== null) viewport.current.scrollTop = initialScroll;
    // Only the first draw restores the scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A row chosen with the keys stays in view, and keeps focus when the list had it.
  const selectedIndex = selected === null ? -1 : rows.findIndex((row) => row.key === selected);
  const arrived = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    // The restored scroll is the position to keep on the first draw.
    if (selectedIndex >= 0 && !(first && initialScroll > 0))
      virtualizer.scrollToIndex(selectedIndex);
    // The virtualizer is stable; only the selection moving scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  // Focus moves with the selection only while it is on a row or not yet anywhere in the page's content: a
  // click or a Tab elsewhere is left alone.
  useEffect(() => {
    const el = viewport.current;
    if (el === null || selectedIndex < 0) return;
    const active = document.activeElement;
    const inList = active !== null && el.contains(active);
    const unplaced =
      active === null || active === document.body || active.closest('[data-rail-item]') !== null;
    if (!inList && !(focusOnArrival && !arrived.current && unplaced)) return;
    const option = el.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (option === null) return;
    arrived.current = true;
    option.focus({ preventScroll: true });
  }, [selectedIndex, selected, focusOnArrival, rows.length]);

  const nearEnd = (lastVisible: number): boolean =>
    hasMore && !loadingMore && lastVisible >= rows.length - NEAR_END_ROWS;

  // A page that arrives short of the viewport, or a first page that is already near its end, asks for
  // the next; a failed page waits for a scroll instead of looping.
  const lastVisible = virtualizer.range?.endIndex ?? 0;
  useEffect(() => {
    if (moreError === null && nearEnd(lastVisible)) onNearEnd();
    // The callback and the predicate follow the props listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastVisible, rows.length, hasMore, loadingMore, moreError]);

  const onScroll = (): void => {
    const el = viewport.current;
    if (el === null) return;
    onScrollTop?.(el.scrollTop);
    if (moreError === null) return;
    if (nearEnd(Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT_PX))) onNearEnd();
  };

  return (
    <ScrollArea
      style={{ flex: 1, minHeight: 0 }}
      viewportRef={viewport}
      viewportProps={{ onScroll }}
      {...{ [LIST_ATTRIBUTE]: true }}
    >
      <Box
        role="listbox"
        aria-label={label}
        style={{ position: 'relative', height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          const style = { height: item.size, transform: `translateY(${String(item.start)}px)` };
          if (row === undefined) {
            return (
              <div
                key={item.key}
                role="presentation"
                className={[classes['row'], classes['placeholder']].join(' ')}
                style={style}
              >
                {moreError === null ? <Skeleton height={12} width="60%" /> : null}
                {moreError === null ? 'Loading more' : "Couldn't load more"}
              </div>
            );
          }
          const isSelected = row.key === selected;
          return (
            <div
              key={item.key}
              role="option"
              aria-selected={isSelected}
              data-inbox-row
              className={classes['row']}
              style={style}
              // Focusable so the keys can be given from the list; j, k and Enter are the Inbox's, Space picks.
              tabIndex={-1}
              onClick={() => {
                onPick?.(row);
              }}
              onKeyDown={(event) => {
                if (event.key !== ' ' || event.target !== event.currentTarget) return;
                event.preventDefault();
                onPick?.(row);
              }}
            >
              {renderRow(row, isSelected)}
            </div>
          );
        })}
      </Box>
    </ScrollArea>
  );
}

import { useLayoutEffect, useState, type RefObject } from 'react';

/** Where a project header's bar runs, in px from the header's left edge. */
export interface BarColumn {
  readonly left: number;
  readonly width: number;
}

/** The shared columns' bar column is the fourth, after the chevron, the dot and the title. */
const BAR_TRACK = 3;
/** A goal row's status starts at the sixth, after the flexible middle. */
const STATUS_TRACK = 5;

/**
 * The card's bar column, read from the first row drawn on its shared columns (`colsClass`), so the header's bar
 * starts where every goal bar starts and runs to where the goal rows' status begins. The header sits outside
 * that grid (the accordion's control), so the grid's resolved tracks are measured, again whenever the card
 * changes size. Null while no row is drawn, as in a folded card.
 */
export function useBarColumn(
  card: RefObject<HTMLElement | null>,
  header: RefObject<HTMLElement | null>,
  colsClass: string | undefined,
): BarColumn | null {
  const [column, setColumn] = useState<BarColumn | null>(null);
  useLayoutEffect(() => {
    const cardEl = card.current;
    const headerEl = header.current;
    if (cardEl === null || headerEl === null || colsClass === undefined) return;
    const measure = (): void => {
      const grid = cardEl.querySelector<HTMLElement>(`.${CSS.escape(colsClass)}`);
      if (grid === null) {
        setColumn(null);
        return;
      }
      const style = getComputedStyle(grid);
      const tracks = style.gridTemplateColumns.split(' ').map((t) => parseFloat(t) || 0);
      const gap = parseFloat(style.columnGap) || 0;
      const origin =
        grid.getBoundingClientRect().left +
        (parseFloat(style.paddingLeft) || 0) -
        headerEl.getBoundingClientRect().left;
      const startOf = (track: number): number =>
        origin + tracks.slice(0, track).reduce((sum, w) => sum + w, 0) + track * gap;
      const left = startOf(BAR_TRACK);
      const width = Math.max(0, startOf(STATUS_TRACK) - gap - left);
      setColumn((prev) =>
        prev !== null && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.width - width) < 0.5
          ? prev
          : { left, width },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cardEl);
    return () => {
      observer.disconnect();
    };
  }, [card, header, colsClass]);
  return column;
}

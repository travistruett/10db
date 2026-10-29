import { useEffect, useState } from 'react';

export interface HiddenEdges {
  readonly top: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

const NONE: HiddenEdges = { top: false, bottom: false, left: false, right: false };

/** Which ends have content scrolled out of view; a pixel of slack absorbs subpixel sizes. */
function measure(el: HTMLElement): HiddenEdges {
  return {
    top: el.scrollTop > 1,
    bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    left: el.scrollLeft > 1,
    right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  };
}

function same(a: HiddenEdges, b: HiddenEdges): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/**
 * Tracks which edges of a scroll container have content hidden past them. Attach `ref` to the
 * container and `onScroll` to its scroll event. The container and its first child are observed, so
 * content that appears or grows updates the edges without any scrolling.
 */
export function useHiddenEdges(): {
  ref: (el: HTMLElement | null) => void;
  edges: HiddenEdges;
  onScroll: () => void;
} {
  // Held as state, not a ref object: a container mounted after this hook (a portal) is measured
  // when it attaches.
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<HiddenEdges>(NONE);

  const update = () => {
    if (!element) return;
    const next = measure(element);
    setEdges((prev) => (same(prev, next) ? prev : next));
  };

  useEffect(() => {
    if (!element) return;
    const refresh = () => {
      const next = measure(element);
      setEdges((prev) => (same(prev, next) ? prev : next));
    };
    refresh();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refresh);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [element]);

  return { ref: setElement, edges, onScroll: update };
}

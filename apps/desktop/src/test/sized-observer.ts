// jsdom does no layout, so a ResizeObserver never fires. This one reports a width a test chooses for every
// element it observes, on observing and again when `resizeObservedTo` changes it. A view that measures its
// own container (`useElementSize`) can then be drawn at a width the window's own width doesn't set.

let contentWidth = 900;
const watching = new Set<SizedObserver>();
const realObserver = window.ResizeObserver;

class SizedObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.targets.add(target);
    watching.add(this);
    this.report();
  }
  report(): void {
    const width = contentWidth;
    const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 600, right: width, width, height: 600 };
    const box = [{ inlineSize: width, blockSize: 600 }];
    const entries = [...this.targets].map((target) => ({
      target,
      contentRect: { ...rect, toJSON: () => rect },
      borderBoxSize: box,
      contentBoxSize: box,
      devicePixelContentBoxSize: box,
    }));
    this.callback(entries, this);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    watching.delete(this);
  }
}

/** Every element observed from now on is `width` px wide. Call `resetObservedWidth` after the test. */
export function observeWidthsOf(width: number): void {
  contentWidth = width;
  watching.clear();
  window.ResizeObserver = SizedObserver;
}

/** The width elements are reported at now. */
export function observedWidth(): number {
  return contentWidth;
}

/** Resizes everything already observed, as a window or a panel moving would. */
export function resizeObservedTo(width: number): void {
  contentWidth = width;
  for (const observer of watching) observer.report();
}

export function resetObservedWidth(): void {
  watching.clear();
  window.ResizeObserver = realObserver;
}

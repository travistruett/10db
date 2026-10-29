import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHiddenEdges } from './use-hidden-edges';

interface Metrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
}

const FITS: Metrics = {
  scrollTop: 0,
  clientHeight: 100,
  scrollHeight: 100,
  scrollLeft: 0,
  clientWidth: 100,
  scrollWidth: 100,
};

function Probe({ metrics }: { readonly metrics: Metrics }) {
  const { ref, edges } = useHiddenEdges();
  return (
    <div
      data-testid="scroller"
      ref={(el) => {
        if (el) {
          for (const [key, value] of Object.entries(metrics)) {
            Object.defineProperty(el, key, { configurable: true, value });
          }
        }
        ref(el);
      }}
    >
      <span data-testid="edges">{JSON.stringify(edges)}</span>
      <div />
    </div>
  );
}

const ROWS: readonly {
  readonly name: string;
  readonly metrics: Partial<Metrics>;
  readonly expected: Record<'top' | 'bottom' | 'left' | 'right', boolean>;
}[] = [
  {
    name: 'nothing hidden',
    metrics: {},
    expected: { top: false, bottom: false, left: false, right: false },
  },
  {
    name: 'bottom hidden',
    metrics: { scrollHeight: 300 },
    expected: { top: false, bottom: true, left: false, right: false },
  },
  {
    name: 'top hidden',
    metrics: { scrollTop: 200, scrollHeight: 300 },
    expected: { top: true, bottom: false, left: false, right: false },
  },
  {
    name: 'both',
    metrics: { scrollTop: 50, scrollHeight: 300 },
    expected: { top: true, bottom: true, left: false, right: false },
  },
  {
    name: 'one pixel short counts as none',
    metrics: { scrollTop: 1, scrollHeight: 101, scrollWidth: 101 },
    expected: { top: false, bottom: false, left: false, right: false },
  },
  {
    name: 'right hidden',
    metrics: { scrollWidth: 300 },
    expected: { top: false, bottom: false, left: false, right: true },
  },
];

describe('useHiddenEdges', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ROWS)('$name', ({ metrics, expected }) => {
    // A real observer would call back on layout; jsdom has none, so the stub calls back on observe.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          this.callback();
        }
        unobserve() {
          return undefined;
        }
        disconnect() {
          return undefined;
        }
      },
    );
    render(<Probe metrics={{ ...FITS, ...metrics }} />);
    expect(JSON.parse(screen.getByTestId('edges').textContent)).toEqual(expected);
  });
});

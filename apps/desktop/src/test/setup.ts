import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './daemon';

// findBy* and waitFor give up after 1 s by default, which a busy Mac misses: the gate runs beside
// other lanes and Docker. A passing query returns as soon as it matches, so a long deadline costs
// an idle run nothing; only a real failure waits it out.
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  // MSW 3 renamed onUnhandledRequest to onUnhandledFrame; it covers requests and WebSocket connections.
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  // Unmount first, so nothing still polling hits a handler that was just removed.
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// jsdom has no matchMedia or ResizeObserver; Mantine reads both. Mantine never calls the deprecated
// addListener and removeListener, so the stub leaves them out.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): Omit<MediaQueryList, 'addListener' | 'removeListener'> => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // jsdom does no layout, so nothing ever resizes.
  }
  unobserve(): void {
    // See observe.
  }
  disconnect(): void {
    // See observe.
  }
}
window.ResizeObserver = ResizeObserverStub;

// jsdom has no document.fonts (the CSS Font Loading API). Mantine's Textarea `autosize` subscribes to
// its `loadingdone` event and crashes the view without it. jsdom loads no fonts, so nothing ever fires.
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { addEventListener: () => undefined, removeEventListener: () => undefined },
});

// jsdom does no layout and has no scrollIntoView; Mantine's Select scrolls the active option into view.
Element.prototype.scrollIntoView = () => undefined;

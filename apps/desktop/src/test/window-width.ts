const setupMatchMedia = window.matchMedia.bind(window);

/** A window `width` px wide: min- and max-width queries in px answer as a browser of that width would. */
export function windowWidth(width: number): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): Omit<MediaQueryList, 'addListener' | 'removeListener'> => {
      const bound = /\((min|max)-width:\s*([\d.]+)px\)/.exec(query);
      const px = Number(bound?.[2]);
      return {
        matches:
          bound === null
            ? setupMatchMedia(query).matches
            : bound[1] === 'min'
              ? width >= px
              : width <= px,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

/** Puts the setup's matchMedia back; call it after each test that set a width. */
export function resetWindowWidth(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: setupMatchMedia });
}

/** The window's own width, which the shell's frame reads (`innerWidth`), unlike a view's media queries. */
export function viewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

/** Puts the jsdom window's default width back; call it after each test that set one. */
export function resetViewportWidth(): void {
  viewportWidth(1024);
}

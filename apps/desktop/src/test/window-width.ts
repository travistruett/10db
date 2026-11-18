/** The window's own width, which the shell's frame reads (`innerWidth`), unlike a view's media queries. */
export function viewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

/** Puts the jsdom window's default width back; call it after each test that set one. */
export function resetViewportWidth(): void {
  viewportWidth(1024);
}

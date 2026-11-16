import { describe, expect, it } from 'vitest';
import { guardFileDrops } from './file-drop-guard';

/** A drag event of the given type carrying the given data types. */
function drag(type: 'dragover' | 'drop', types: string[]): DragEvent {
  const event = new Event(type, { cancelable: true }) as DragEvent;
  // jsdom has no DataTransfer; the guard reads only its `types`.
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event;
}

describe('guardFileDrops', () => {
  it.each(['dragover', 'drop'] as const)(
    'cancels a %s that carries files, so the window never opens the file',
    (type) => {
      const stop = guardFileDrops(window);
      const event = drag(type, ['Files']);
      window.dispatchEvent(event);
      stop();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('leaves a drag of text alone, and does nothing once removed', () => {
    const stop = guardFileDrops(window);
    const text = drag('drop', ['text/plain']);
    window.dispatchEvent(text);
    stop();
    const after = drag('drop', ['Files']);
    window.dispatchEvent(after);
    expect(text.defaultPrevented).toBe(false);
    expect(after.defaultPrevented).toBe(false);
  });
});

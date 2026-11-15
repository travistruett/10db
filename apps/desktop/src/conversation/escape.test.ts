import { afterEach, describe, expect, it } from 'vitest';
import { escapeHasOwner, escapeIsTaken, isComposing, isSendKey } from './escape';

const esc = (target?: Element): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (target !== undefined) Object.defineProperty(event, 'target', { value: target });
  return event;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('escapeIsTaken', () => {
  it('is false with nothing open', () => {
    expect(escapeIsTaken(esc())).toBe(false);
  });

  it('is true while a dialog or a menu is open', () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(escapeIsTaken(esc())).toBe(true);
    document.body.innerHTML = '<div role="menu"></div>';
    expect(escapeIsTaken(esc())).toBe(true);
  });

  it('is true while focus is inside a waiting card', () => {
    document.body.innerHTML = '<div data-waiting-card><textarea id="note"></textarea></div>';
    document.getElementById('note')?.focus();
    expect(escapeIsTaken(esc())).toBe(true);
  });
});

describe('escapeHasOwner', () => {
  it('is true for a key that landed inside a form that owns Esc', () => {
    document.body.innerHTML = '<form data-owns-escape><input id="x"></form>';
    const input = document.getElementById('x');
    expect(input !== null && escapeHasOwner(esc(input))).toBe(true);
  });
});

describe('isSendKey', () => {
  it.each([
    { name: '⌘↩', key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, want: true },
    { name: 'Ctrl↩', key: 'Enter', metaKey: false, ctrlKey: true, shiftKey: false, want: true },
    { name: '↩', key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, want: true },
    { name: '⇧↩', key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: true, want: false },
    { name: '⌘⇧↩', key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: true, want: false },
  ])('$name', ({ want, ...key }) => {
    expect(isSendKey(key)).toBe(want);
  });
});

describe('isComposing', () => {
  it.each([
    { name: 'a plain key', keyCode: 13, isComposing: false, want: false },
    { name: 'a keydown inside a composition', keyCode: 13, isComposing: true, want: true },
    {
      name: 'the Enter that ends a WebKit composition',
      keyCode: 229,
      isComposing: false,
      want: true,
    },
  ])('$name', ({ want, keyCode, isComposing: composing }) => {
    expect(isComposing({ keyCode, nativeEvent: { isComposing: composing } })).toBe(want);
  });
});

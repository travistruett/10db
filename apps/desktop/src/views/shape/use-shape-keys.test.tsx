import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useShapeKeys } from './use-shape-keys';

const PROPOSE = { key: 'Enter', metaKey: true, shiftKey: true } as const;

function mount(): { onPropose: ReturnType<typeof vi.fn>; onStop: ReturnType<typeof vi.fn> } {
  const onPropose = vi.fn();
  const onStop = vi.fn();
  renderHook(() => {
    useShapeKeys({ onPropose, onStop, answering: false });
  });
  return { onPropose, onStop };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('useShapeKeys', () => {
  it('proposes on ⌘⇧↩', () => {
    const { onPropose } = mount();
    fireEvent.keyDown(document.body, PROPOSE);
    expect(onPropose).toHaveBeenCalledTimes(1);
  });

  it('does not propose on ⌘⇧↩ while a modal is open', () => {
    const { onPropose } = mount();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.append(modal);

    expect(fireEvent.keyDown(document.body, PROPOSE)).toBe(true);
    expect(onPropose).not.toHaveBeenCalled();

    modal.remove();
    fireEvent.keyDown(document.body, PROPOSE);
    expect(onPropose).toHaveBeenCalledTimes(1);
  });
});

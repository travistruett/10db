import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameSlots } from '../test/frame';
import { observeWidthsOf, resetObservedWidth } from '../test/sized-observer';
import { renderWithTheme } from '../test/theme';
import { SurfaceDrawer } from './surface-drawer';

afterEach(() => {
  resetObservedWidth();
});

function draw(onClose = vi.fn()) {
  renderWithTheme(
    <FrameSlots>
      <button type="button">Beside</button>
      <SurfaceDrawer opened onClose={onClose} label="Task">
        <input aria-label="Inside" />
      </SurfaceDrawer>
    </FrameSlots>,
  );
  return onClose;
}

describe('SurfaceDrawer', () => {
  it('draws on the surface layer, not modal, with focus inside', async () => {
    draw();
    const dialog = await screen.findByRole('dialog', { name: 'Task' });
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(screen.getByTestId('drawer-layer').contains(dialog)).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(dialog);
    });
    // The view beside it stays reachable.
    expect(screen.getByRole('button', { name: 'Beside' })).toBeTruthy();
  });

  it('closes on Esc inside it and on its ×, and not on Esc elsewhere or a click outside', async () => {
    const onClose = draw();
    const inside = await screen.findByRole('textbox', { name: 'Inside' });
    fireEvent.keyDown(inside, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Beside' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Beside' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('draws nothing while closed', () => {
    renderWithTheme(
      <FrameSlots>
        <SurfaceDrawer opened={false} onClose={() => undefined} label="Task">
          x
        </SurfaceDrawer>
      </FrameSlots>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    {
      name: 'a surface of 1000 px takes half, within 480 and 760',
      surface: 1000,
      width: 'clamp(480px, 50%, 760px)',
    },
    { name: 'a surface of 639 px is all of it', surface: 639, width: '100%' },
    {
      name: 'a surface of 640 px takes half again',
      surface: 640,
      width: 'clamp(480px, 50%, 760px)',
    },
  ])('$name', async ({ surface, width }) => {
    observeWidthsOf(surface);
    draw();
    const dialog = await screen.findByRole('dialog', { name: 'Task' });
    await waitFor(() => {
      expect(dialog.style.width).toBe(width);
    });
  });
});

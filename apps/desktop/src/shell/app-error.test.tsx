import { MantineProvider } from '@mantine/core';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router';
import { AppError } from './app-error';

const TITLE = "10db hit an error it couldn't recover from";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderError(reset = vi.fn()) {
  const view = render(
    <MantineProvider>
      <AppError error={new Error('boom')} reset={reset} />
    </MantineProvider>,
  );
  return { reset, ...view };
}

describe('AppError', () => {
  it('shows the message with Try Again and Reload Window', () => {
    renderError();
    expect(screen.getByText(TITLE)).toBeTruthy();
    const message = screen.getByText('boom');
    expect(message.tagName).toBe('PRE');
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload Window' })).toBeTruthy();
  });

  it('Try Again calls reset', () => {
    const { reset } = renderError();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('keeps a drag strip clear of the traffic lights', () => {
    const { container } = renderError();
    const strip = container.querySelector<HTMLElement>('[data-tauri-drag-region]');
    expect(strip).not.toBeNull();
    // Mantine's h={48} renders as 3rem (48 px at the default root size).
    expect(strip?.style.height).toContain('3rem');
  });

  it('a crash outside every view renders it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/board'] }));
    render(
      <MantineProvider>
        <RouterProvider router={router} />
      </MantineProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(TITLE)).toBeTruthy();
    });
    // The real layout throws here: it has no DaemonProvider above it.
    expect(screen.getByText(/useDaemon must be used inside/)).toBeTruthy();
  });
});

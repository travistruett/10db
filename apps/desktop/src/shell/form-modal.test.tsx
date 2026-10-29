import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FormModal } from './form-modal';

function renderModal(props: { readonly error?: string | null; readonly onClose?: () => void }) {
  return render(
    <MantineProvider>
      <FormModal
        opened
        onClose={props.onClose ?? (() => undefined)}
        title="Edit Project"
        error={props.error ?? null}
        actions={<button type="button">Save</button>}
      >
        <p>Body text</p>
      </FormModal>
    </MantineProvider>,
  );
}

describe('FormModal', () => {
  it('renders the title, children and actions', async () => {
    renderModal({});
    expect(await screen.findByText('Edit Project')).toBeTruthy();
    expect(screen.getByText('Body text')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('shows the error beside the actions', async () => {
    renderModal({ error: 'Could not save' });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not save')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(alert.parentElement?.contains(save)).toBe(true);
    expect(alert.contains(save)).toBe(false);
  });

  it('has no error text when error is null', async () => {
    renderModal({ error: null });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('');
  });

  it('closes on the close button', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(await screen.findByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('FormModal scroll shadow', () => {
  it('paints the shadow from a theme color, not a literal one', async () => {
    const stub = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          stub.mockImplementation(callback);
        }
        observe() {
          stub();
        }
        unobserve() {
          return undefined;
        }
        disconnect() {
          return undefined;
        }
      },
    );
    // Content taller than the panel hides the bottom edge, which shades the footer.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 500,
    });
    try {
      renderModal({});
      const footer = (await screen.findByRole('alert')).parentElement;
      await waitFor(() => {
        expect(footer?.style.boxShadow).not.toBe('');
      });
      expect(footer?.style.boxShadow).toContain('var(--mantine-color-');
      expect(footer?.style.boxShadow).not.toContain('rgb(');
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      vi.unstubAllGlobals();
    }
  });
});

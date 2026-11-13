import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { PASS_NOW, pagesByStatus, passViewDto } from '../../test/pass-fixtures';
import { AbandonModal } from './abandon-modal';

function draw(
  abandon = vi.fn<() => Promise<void>>(() => Promise.resolve()),
  view = passViewDto({ pages: Object.values(pagesByStatus()).slice(0, 3) }),
) {
  server.use(...baseHandlers());
  const onClose = vi.fn();
  renderWithDaemon(
    <AbandonModal
      view={view}
      inbox={[]}
      now={Date.parse(PASS_NOW)}
      onClose={onClose}
      abandon={abandon}
    />,
  );
  return { abandon, onClose };
}

const dialog = () => screen.findByRole('dialog', { name: 'Abandon' });

describe('AbandonModal', () => {
  it('names every page that goes back to how it was, then abandons', async () => {
    const { abandon, onClose } = draw();
    const d = await dialog();
    const reverts = within(d).getByRole('list', { name: 'Pages that go back' });
    expect(
      within(reverts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Home', 'Billing', 'Settings']);
    expect(within(d).queryByRole('list', { name: 'Pages that stay' })).toBeNull();
    fireEvent.click(within(d).getByRole('button', { name: 'Abandon' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("says the daemon's refusal beside Abandon Pass and stays open", async () => {
    const { onClose } = draw(vi.fn(() => Promise.reject(new Error('The pass has settled'))));
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Abandon' }));
    expect(await within(d).findByText('The pass has settled')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'before it lands', step: 2 as const, offered: true },
    { name: 'once it lands', step: 7 as const, offered: false },
  ])(
    'while the pass closes, says the close stops, and offers Abandon only $name',
    async ({ step, offered }) => {
      const { ready, working } = pagesByStatus();
      // Sign Off Now has landed Settings already: it stays.
      const view = passViewDto({
        pass: { state: 'CLOSING' },
        pages: [{ ...ready, signOff: 'done' }, working],
        rest: { closeStep: step },
      });
      const { abandon } = draw(undefined, view);
      const d = await dialog();
      expect(
        within(within(d).getByRole('list', { name: 'Pages that stay' })).getByText('Settings'),
      ).toBeTruthy();
      expect(
        within(within(d).getByRole('list', { name: 'Pages that go back' })).getByText('Billing'),
      ).toBeTruthy();
      const button = within(d).getByRole('button', { name: 'Abandon' });
      expect(button).toHaveProperty('disabled', !offered);
      expect(
        within(d).queryByText(
          offered
            ? 'Finishing stops where it is; what has landed stays.'
            : 'It is landing now, so it can no longer be abandoned.',
        ),
      ).toBeTruthy();
      fireEvent.click(button);
      await waitFor(() => {
        expect(abandon).toHaveBeenCalledTimes(offered ? 1 : 0);
      });
    },
  );
});

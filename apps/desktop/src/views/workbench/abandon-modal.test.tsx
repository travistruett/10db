import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { PASS_NOW, pagesByStatus, passViewDto } from '../../test/pass-fixtures';
import { AbandonModal } from './abandon-modal';

function draw(abandon = vi.fn<() => Promise<void>>(() => Promise.resolve())) {
  server.use(...baseHandlers());
  const onClose = vi.fn();
  const { ready, working, notStarted } = pagesByStatus();
  renderWithDaemon(
    <AbandonModal
      view={passViewDto({ pages: [ready, working, notStarted] })}
      inbox={[]}
      now={Date.parse(PASS_NOW)}
      onClose={onClose}
      abandon={abandon}
    />,
  );
  return { abandon, onClose };
}

const dialog = () => screen.findByRole('dialog', { name: 'Abandon Pass' });

describe('AbandonModal', () => {
  it('names every page that goes back to how it was, then abandons', async () => {
    const { abandon, onClose } = draw();
    const d = await dialog();
    const reverts = within(d).getByRole('list', { name: 'Pages that go back' });
    expect(
      within(reverts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Settings', 'Billing', 'Home']);
    expect(within(d).queryByRole('list', { name: 'Pages that stay' })).toBeNull();
    fireEvent.click(within(d).getByRole('button', { name: 'Abandon Pass' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("says the daemon's refusal beside Abandon Pass and stays open", async () => {
    const { onClose } = draw(vi.fn(() => Promise.reject(new Error('The pass has settled'))));
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Abandon Pass' }));
    expect(await within(d).findByText('The pass has settled')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

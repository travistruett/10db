import type { PassRename } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { passDto } from '../../test/pass-fixtures';
import { RenameModal } from './rename-modal';

function draw(rename = vi.fn<(body: PassRename) => Promise<void>>(() => Promise.resolve())) {
  server.use(...baseHandlers());
  const onClose = vi.fn();
  renderWithDaemon(<RenameModal pass={passDto()} onClose={onClose} rename={rename} />);
  return { rename, onClose };
}

const dialog = () => screen.findByRole('dialog', { name: 'Rename' });

describe('RenameModal', () => {
  it('renames the pass, trimmed, and closes', async () => {
    const { rename, onClose } = draw();
    const d = await dialog();
    const name = within(d).getByLabelText('Name');
    expect(name).toHaveProperty('value', 'Settings pass');
    fireEvent.change(name, { target: { value: '  Density pass ' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(rename).toHaveBeenCalledWith({ name: 'Density pass' });
  });

  it('says on the field why an empty name is refused, and sends nothing', async () => {
    const { rename } = draw();
    const d = await dialog();
    fireEvent.change(within(d).getByLabelText('Name'), { target: { value: ' ' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Rename' }));
    expect(await within(d).findByText('Enter a name')).toBeTruthy();
    expect(rename).not.toHaveBeenCalled();
  });

  it("says the daemon's refusal beside Rename", async () => {
    draw(vi.fn(() => Promise.reject(new Error('The pass has closed'))));
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Rename' }));
    expect(await within(d).findByText('The pass has closed')).toBeTruthy();
  });
});

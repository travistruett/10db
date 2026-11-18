import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { useProjectSetup } from './project-setup';

function Harness() {
  const setup = useProjectSetup(() => undefined, {});
  return (
    <>
      {setup.fields}
      <button disabled={!setup.canSubmit} onClick={setup.submit}>
        Create Project
      </button>
    </>
  );
}

it('shows only the folder control at first', async () => {
  server.use(...baseHandlers());
  renderWithDaemon(<Harness />);
  await screen.findByRole('textbox', { name: 'Folder path' });
  expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Gate command' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Create Project' }).hasAttribute('disabled')).toBe(
    true,
  );
});

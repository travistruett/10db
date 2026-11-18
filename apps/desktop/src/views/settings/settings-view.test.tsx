import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { baseHandlers, renderApp, server } from '../../test/daemon';

it('opens General from /settings with no page title and no project picker', async () => {
  server.use(...baseHandlers());
  const { router } = renderApp('/settings');
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/settings/general');
  });
  expect(
    (await screen.findByRole('heading', { name: 'General', level: 1 })).closest('[data-title-row]'),
  ).not.toBeNull();
  expect(screen.queryByRole('heading', { name: 'Settings', level: 2 })).toBeNull();
  // The one project switcher is the rail's tile.
  expect(screen.getAllByRole('button', { name: /Switch project/ })).toHaveLength(1);
});

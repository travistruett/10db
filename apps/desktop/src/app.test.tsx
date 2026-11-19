import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderApp, server } from './test/daemon';

describe('App shell', () => {
  it('redirects / to the Factory view and navigates to Inbox', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));
    expect(await screen.findByRole('heading', { name: 'Open' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/inbox');
  });
});

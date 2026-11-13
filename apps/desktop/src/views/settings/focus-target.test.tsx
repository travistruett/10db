import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderApp, server } from '../../test/daemon';
import { settingsSearch } from './focus-target';

describe('settingsSearch', () => {
  it.each([
    { name: 'a name', search: { focus: 'github' }, expected: { focus: 'github' } },
    { name: 'no name', search: {}, expected: {} },
    { name: 'an empty name', search: { focus: '' }, expected: {} },
    { name: 'a number', search: { focus: 5 }, expected: {} },
    { name: 'a list', search: { focus: ['a', 'b'] }, expected: {} },
  ])('keeps $name as $expected', ({ search, expected }) => {
    expect(settingsSearch(search)).toEqual(expected);
  });
});

describe('Settings › ?focus', () => {
  it('focuses the first control of the card the address names', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/keep-awake?focus=keep-awake');
    const first = await screen.findByRole('radio', { name: 'Never' });
    await waitFor(() => {
      expect(document.activeElement).toBe(first);
    });
  });

  it('does nothing for a name no card has', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/keep-awake?focus=nope');
    await screen.findByRole('radio', { name: 'Never' });
    expect(document.activeElement).toBe(document.body);
  });
});

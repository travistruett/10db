import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, renderApp, server } from '../test/daemon';

beforeEach(() => {
  window.localStorage.clear();
});

describe('the rail', () => {
  it('names each section, in order, and marks the open one', async () => {
    server.use(...baseHandlers());
    renderApp('/factory');
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    await within(rail).findByRole('button', { name: /Switch project/ });
    const names = [...rail.querySelectorAll('a[href], button')].map((element) => {
      const name = element.getAttribute('aria-label') ?? element.textContent.trim();
      return name.endsWith('Switch project') ? 'project tile' : name;
    });
    expect(names).toEqual([
      'Inbox',
      'Factory',
      'Sessions',
      'project tile',
      'Board',
      'Plan',
      'UI Workbench',
      'Knowledge',
      'Settings',
    ]);
    const current = rail.querySelectorAll('[aria-current="page"]');
    expect([...current].map((element) => element.textContent.trim())).toEqual(['Factory']);
  });
});

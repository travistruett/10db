import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderApp, server } from '../../test/daemon';

const PROJECT_LINKS = [
  'General',
  'Board columns',
  'Planning',
  'Areas and hazards',
  'Who Answers',
  'Billing',
  'Models by role',
  'Trust',
  'Network hosts',
];
const APP_LINKS = [
  'Overview',
  'Accounts',
  'Models',
  'Decisions',
  'Lane permissions',
  'Trust',
  'Sessions',
  'Integrations',
  'People',
  'Updates',
  'Keep-awake',
  'Agent skill',
];

function linkNames(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole('link')
    .map((l) => l.textContent);
}

describe('SettingsNav', () => {
  it.each([
    {
      path: '/settings/billing',
      selected: 'This project',
      links: PROJECT_LINKS,
      groups: ['Project', 'Planning', 'Agents'],
    },
    {
      path: '/settings/accounts',
      selected: 'All projects',
      links: APP_LINKS,
      groups: ['AI', 'Agents', 'Connections', 'This Mac'],
    },
  ])(
    'at $path selects $selected and lists only that scope, one group per subhead',
    async ({ path, selected, links, groups }) => {
      server.use(...baseHandlers());
      renderApp(path);
      const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
      expect(within(nav).getByRole<HTMLInputElement>('radio', { name: selected }).checked).toBe(
        true,
      );
      expect(linkNames(nav)).toEqual(links);
      for (const group of groups)
        expect(within(nav).getByRole('group', { name: group })).toBeTruthy();
    },
  );

  it.each([
    { path: '/settings/billing', choose: 'All projects', lands: '/settings/overview' },
    { path: '/settings/accounts', choose: 'This project', lands: '/settings/general' },
  ])('choosing $choose from $path opens $lands', async ({ path, choose, lands }) => {
    server.use(...baseHandlers());
    const { router } = renderApp(path);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByRole('radio', { name: choose }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(lands);
    });
  });
});

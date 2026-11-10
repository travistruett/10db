import { mintId, PROTOCOL_VERSION } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from './test/daemon';
import { inboxItemDto } from './test/fixtures';

const healthy = () =>
  http.get(daemonUrl('/health'), () =>
    HttpResponse.json({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: '2026-10-13T12:00:00.000Z',
    }),
  );

/** The setup's matchMedia, which each width test puts back. */
const setupMatchMedia = window.matchMedia.bind(window);

/** A window `width` px wide: min- and max-width queries in px answer as a browser of that width would. */
function windowWidth(width: number): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): Omit<MediaQueryList, 'addListener' | 'removeListener'> => {
      const bound = /\((min|max)-width:\s*([\d.]+)px\)/.exec(query);
      const px = Number(bound?.[2]);
      return {
        matches:
          bound === null
            ? setupMatchMedia(query).matches
            : bound[1] === 'min'
              ? width >= px
              : width <= px,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: setupMatchMedia });
});

describe('App shell', () => {
  it('orders the sidebar global views first, then the project and its views, then app-wide Settings', async () => {
    server.use(...baseHandlers());
    renderApp('/factory');
    const nav = await screen.findByRole('navigation');
    await screen.findByRole('button', { name: /Switch project/ });
    // In document order: the sidebar's links and buttons, each by its accessible name.
    const order = [...nav.querySelectorAll('a, button')].map((element) => {
      const name = element.getAttribute('aria-label') ?? element.textContent.trim();
      return name.endsWith('Switch project') ? 'switcher' : name;
    });
    expect(order).toEqual([
      'Inbox',
      'Factory',
      'switcher',
      'Board',
      'Plan',
      'Workbench',
      'Knowledge',
      'Project Settings',
      'Settings',
    ]);
  });

  it.each([
    ['Project Settings', '/settings/general'],
    ['Settings', '/settings/keep-awake'],
  ])('opens %s at %s', async (link, path) => {
    server.use(...baseHandlers());
    const { router } = renderApp('/factory');
    fireEvent.click(await screen.findByRole('link', { name: link }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(path);
    });
  });

  it('shows no daemon status in the header while connected', async () => {
    server.use(...baseHandlers());
    renderApp('/factory');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    expect(screen.queryByText(/daemon/i)).toBeNull();
    expect(screen.queryByRole('img', { name: /daemon/i })).toBeNull();
  });

  it('weights only the current route’s sidebar label at 600', async () => {
    server.use(...baseHandlers());
    renderApp('/factory');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    const label = (name: string) =>
      screen.getByRole('link', { name }).querySelector('.mantine-NavLink-label');
    expect(label('Factory')).toHaveProperty('style.fontWeight', '600');
    expect(label('Inbox')).toHaveProperty('style.fontWeight', '');
  });

  it('waits on a connecting screen while the daemon is unreachable', async () => {
    server.use(http.get(daemonUrl('/health'), () => HttpResponse.error()));
    renderApp();
    expect(await screen.findByText('Connecting to the 10db daemon…')).toBeTruthy();
  });

  it('redirects / to the Factory view and navigates to Inbox', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/inbox');
  });

  it('keeps the view and shows a banner while reconnecting, then clears it', async () => {
    server.use(...baseHandlers());
    renderApp('/factory', { intervals: { healthy: 40, disconnected: 40 } });
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    server.use(http.get(daemonUrl('/health'), () => HttpResponse.error()));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Reconnecting to the daemon…',
    );
    expect(screen.getByRole('img', { name: 'Reconnecting to the daemon' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Factory' })).toBeTruthy();
    server.use(healthy());
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.queryByRole('img', { name: /daemon/i })).toBeNull();
  });

  it('counts a missing tool and an unreadable login shell on the Inbox link, with nothing above the view', async () => {
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json({
          loginEnv: {
            source: 'inherited',
            warning:
              'The login shell timed out after 10 s; using the environment 10db was started with',
          },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          codex: { verifiedOn: '0.154.0', warning: null },
          tools: [
            { name: 'claude', path: null, version: null, required: true },
            { name: 'git', path: '/usr/bin/git', version: 'git version 2.50.0', required: true },
            { name: 'docker', path: null, version: null, required: false },
          ],
        }),
      ),
      ...baseHandlers(),
    );
    renderApp('/factory');
    // docker is optional, so its absence is not counted.
    expect(await screen.findByRole('link', { name: /Inbox.*2 open cards/ })).toBeTruthy();
    expect(screen.queryByText('claude was not found where 10db looks for it')).toBeNull();
    expect(screen.queryByText(/The login shell timed out after 10 s/)).toBeNull();
  });

  it('shows the open-card count on the Inbox link', async () => {
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([inboxItemDto()])),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(await screen.findByRole('link', { name: /Inbox.*1 open card/ })).toBeTruthy();
  });

  it('counts the Inbox rows, not the cards folded into them', async () => {
    const project = mintId('Project');
    const twins = [1, 2].map(() =>
      inboxItemDto({
        kind: 'flag',
        title: 'Batch not started',
        body: 'The batch did not start',
        options: [],
        projectId: project,
      }),
    );
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json(twins)),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(await screen.findByRole('link', { name: /Inbox.*1 open card/ })).toBeTruthy();
  });

  it('draws the color scheme toggle icon at the 20px size DESIGN.md sets', async () => {
    server.use(...baseHandlers());
    renderApp();
    const toggle = await screen.findByRole('button', { name: /^Switch to (dark|light) mode$/ });
    expect(toggle.querySelector('svg')?.getAttribute('width')).toBe('20');
  });

  it.each([
    { width: 480, path: '/workbench', folded: true },
    { width: 1280, path: '/workbench', folded: false },
    { width: 480, path: '/board', folded: false },
  ])('at $width px on $path the sidebar folds: $folded', async ({ width, path, folded }) => {
    windowWidth(width);
    server.use(...baseHandlers());
    renderApp(path);
    const nav = await screen.findByRole('navigation', { hidden: true });
    await waitFor(() => {
      expect(nav.hasAttribute('inert')).toBe(folded);
    });
    const burger = screen.queryByRole('button', { name: 'Show navigation' });
    expect(burger !== null).toBe(folded);
    if (burger === null) return;
    fireEvent.click(burger);
    await waitFor(() => {
      expect(nav.hasAttribute('inert')).toBe(false);
    });
    expect(screen.getByRole('button', { name: 'Hide navigation' })).toBeTruthy();
  });

  it('opens the Workbench from the sidebar, between Plan and Knowledge', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/factory');
    fireEvent.click(await screen.findByRole('link', { name: 'Workbench' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workbench');
    });
    expect(await screen.findByRole('heading', { name: 'Workbench' })).toBeTruthy();
  });
});

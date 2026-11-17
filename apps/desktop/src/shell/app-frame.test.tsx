import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../test/daemon';
import { inboxItemDto, projectViewDto } from '../test/fixtures';
import { resetViewportWidth, viewportWidth } from '../test/window-width';

const PANEL_KEY = 'tendb.shell.panel.settings';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  resetViewportWidth();
});

/** The panel's box, which is a column, a sheet over the content, or folded away. */
async function findPanel(): Promise<HTMLElement> {
  await screen.findByRole('navigation', { name: 'Settings sections', hidden: true });
  const panel = document.querySelector<HTMLElement>('[data-panel]');
  if (panel === null) throw new Error('the frame drew no panel box');
  return panel;
}

const pressSidebarKey = (): void => {
  fireEvent.keyDown(document, { key: '\\', metaKey: true });
};

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
      'Keep-awake: Not keeping the Mac awake',
      'Switch to light mode',
      'Settings',
    ]);
    const current = rail.querySelectorAll('[aria-current="page"]');
    expect([...current].map((element) => element.textContent.trim())).toEqual(['Factory']);
  });

  it('keeps a count apart from its name', async () => {
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([inboxItemDto()])),
      ...baseHandlers(),
    );
    renderApp('/factory');
    const link = await screen.findByRole('link', { name: /Inbox.*1 open card/ });
    expect(link.textContent).toContain('Inbox');
  });

  it("moves between items with the arrow keys and opens one with Enter's own link behaviour", async () => {
    server.use(...baseHandlers());
    renderApp('/factory');
    const inbox = await screen.findByRole('link', { name: 'Inbox' });
    inbox.focus();
    fireEvent.keyDown(inbox, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Factory' }));
    fireEvent.keyDown(document.activeElement ?? inbox, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(inbox);
  });

  it("opens the project tile's menu with Project Settings, which leads to the project's General", async () => {
    const project = projectViewDto({ name: 'alpha' });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...baseHandlers(),
    );
    const { router } = renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Project: alpha. Switch project' }));
    const link = await screen.findByRole('link', { name: 'Project Settings', hidden: true });
    fireEvent.click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
  });
});

describe('the panel and ⌘\\', () => {
  it('hides the panel at 1280 px and remembers it for the section', async () => {
    viewportWidth(1280);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('column');
    });
    pressSidebarKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(window.localStorage.getItem(PANEL_KEY)).toBe('hidden');
    pressSidebarKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('column');
    });
    expect(window.localStorage.getItem(PANEL_KEY)).toBeNull();
  });

  it('starts hidden when the section was left hidden', async () => {
    viewportWidth(1280);
    window.localStorage.setItem(PANEL_KEY, 'hidden');
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    expect(screen.getByRole('button', { name: 'Show the panel' })).toBeTruthy();
  });

  it('opens the panel over the content at 800 px, and Esc, a click outside or moving on closes it', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    expect(panel.dataset['panel']).toBe('hidden');
    expect(panel.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show the panel' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('overlay');
    });
    expect(panel.hasAttribute('inert')).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    pressSidebarKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('overlay');
    });
    const backdrop = document.querySelector<HTMLElement>('[data-frame-backdrop]');
    if (backdrop === null) throw new Error('an open overlay has a backdrop');
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    pressSidebarKey();
    fireEvent.click(await screen.findByRole('link', { name: 'Planning', hidden: true }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
  });

  it('folds the rail too under 640 px, and the button opens both', async () => {
    viewportWidth(480);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    const rail = await screen.findByRole('navigation', { name: 'Sections', hidden: true });
    const railBox = rail.parentElement?.parentElement;
    expect(railBox?.hasAttribute('inert')).toBe(true);
    expect(panel.dataset['panel']).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Show the panel' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('overlay');
    });
    expect(railBox?.hasAttribute('inert')).toBe(false);
  });

  it('has nothing to open where a section has no panel at 800 px', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/board');
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(screen.queryByRole('button', { name: /the panel$/ })).toBeNull();
  });
});

describe('the frame', () => {
  it('puts a drag region on its empty boxes and on none of its controls', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/general');
    await findPanel();
    const dragging = [...document.querySelectorAll('[data-tauri-drag-region]')];
    expect(dragging.length).toBeGreaterThan(0);
    const controls = dragging.filter((element) =>
      element.matches('a, button, input, select, textarea, [role="button"], [role="link"]'),
    );
    expect(controls).toEqual([]);
    const row = document.querySelector('[data-title-row]');
    expect(row?.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('keeps the reconnecting banner at the top of the content surface', async () => {
    server.use(...baseHandlers());
    renderApp('/factory', { intervals: { healthy: 40, disconnected: 40 } });
    await screen.findByRole('heading', { name: 'Factory' });
    server.use(http.get(daemonUrl('/health'), () => HttpResponse.error()));
    const banner = await screen.findByRole('status');
    const surface = banner.parentElement;
    expect(surface?.firstElementChild).toBe(banner);
    // The view stays: its title is still in the title row.
    expect(screen.getByRole('heading', { name: 'Factory' })).toBeTruthy();
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../test/daemon';
import { inboxItemDto, projectViewDto } from '../test/fixtures';
import { resetViewportWidth, viewportWidth } from '../test/window-width';

const PANEL_KEY = 'tendb.shell.panel.settings';
const LABELS_KEY = 'tendb.shell.labels';

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

/** ⌘\: the section's panel. */
const pressPanelKey = (): void => {
  fireEvent.keyDown(document, { key: '\\', metaKey: true });
};
/** ⇧⌘S: the sidebar. */
const pressSidebarKey = (): void => {
  fireEvent.keyDown(document, { key: 'S', metaKey: true, shiftKey: true });
};

/** The rail's own box (the grid cell), which is a column, a sheet over the content, or folded away. */
async function findRailBox(): Promise<HTMLElement> {
  const rail = await screen.findByRole('navigation', { name: 'Sections', hidden: true });
  const box = rail.parentElement?.parentElement;
  if (!box) throw new Error('the rail has no box');
  return box;
}

const isLabelled = (): boolean =>
  document.querySelector('nav[aria-label="Sections"]')?.hasAttribute('data-labelled') ?? false;

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
      'Keep-awake: Not keeping the Mac awake',
      'Switch to light mode',
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

  it('draws a count as a compact corner badge when icons only and the normal pill when labelled', async () => {
    viewportWidth(1280);
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([inboxItemDto()])),
      ...baseHandlers(),
    );
    renderApp('/factory');
    const labelled = await screen.findByRole('link', { name: /Inbox.*1 open card/ });
    expect(labelled.querySelector('[data-compact]')).toBeNull();
    pressSidebarKey();
    await waitFor(() => {
      expect(isLabelled()).toBe(false);
    });
    const icons = await screen.findByRole('link', { name: /Inbox.*1 open card/ });
    expect(icons.querySelector('[data-compact]')).not.toBeNull();
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

describe('the sidebar and ⇧⌘S', () => {
  it('is labelled by default, and ⇧⌘S at 1280 px switches it to icons only and remembers it', async () => {
    viewportWidth(1280);
    server.use(...baseHandlers());
    renderApp('/board');
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(isLabelled()).toBe(true);
    expect(screen.getByRole('link', { name: 'Factory' }).textContent).toContain('Factory');
    pressSidebarKey();
    await waitFor(() => {
      expect(isLabelled()).toBe(false);
    });
    expect(screen.getByRole('link', { name: 'Factory' }).textContent).toBe('Factory');
    expect(window.localStorage.getItem(LABELS_KEY)).toBe('icons');
    pressSidebarKey();
    await waitFor(() => {
      expect(isLabelled()).toBe(true);
    });
    expect(window.localStorage.getItem(LABELS_KEY)).toBeNull();
  });

  it('starts icons only when it was left so, and the toggle button does the same as the key', async () => {
    viewportWidth(1280);
    window.localStorage.setItem(LABELS_KEY, 'icons');
    server.use(...baseHandlers());
    renderApp('/board');
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(isLabelled()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    await waitFor(() => {
      expect(isLabelled()).toBe(true);
    });
  });

  it('closes the toggle button tooltip on a click, so it never stays over what the click changed', async () => {
    viewportWidth(1280);
    server.use(...baseHandlers());
    renderApp('/board');
    const button = await screen.findByRole('button', { name: 'Toggle sidebar' });
    fireEvent.mouseEnter(button);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Toggle sidebar');
    fireEvent.click(button);
    // At once: a tip that fades out on its own timer would also pass a wait.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('takes the Esc that closes a sheet, so a view behind it does not act on the same key', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/board');
    const railBox = await findRailBox();
    pressSidebarKey();
    await waitFor(() => {
      expect(railBox.getAttribute('data-sheet')).toBe('');
    });
    // fireEvent returns false when a listener called preventDefault.
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
    await waitFor(() => {
      expect(railBox.hasAttribute('data-sheet')).toBe(false);
    });
    // With no sheet open the key is left alone.
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
  });

  it('stays closed when you come back to a page whose sheet a row pick closed', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    const { router } = renderApp('/board');
    const railBox = await findRailBox();
    pressSidebarKey();
    await waitFor(() => {
      expect(railBox.getAttribute('data-sheet')).toBe('');
    });
    fireEvent.click(screen.getByRole('link', { name: 'Factory' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/factory');
    });
    fireEvent.click(screen.getByRole('link', { name: 'Board' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
    expect(railBox.hasAttribute('data-sheet')).toBe(false);
    expect(document.querySelector('[data-frame-backdrop]')).toBeNull();
    // Growing to a wide window and back does not bring a sheet back either.
    pressSidebarKey();
    await waitFor(() => {
      expect(railBox.getAttribute('data-sheet')).toBe('');
    });
    viewportWidth(1280);
    await waitFor(() => {
      expect(railBox.hasAttribute('data-sheet')).toBe(false);
    });
    viewportWidth(800);
    await waitFor(() => {
      expect(railBox.hasAttribute('inert')).toBe(false);
    });
    expect(railBox.hasAttribute('data-sheet')).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Toggle sidebar' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('opens the labelled sidebar over the content at 800 px, with the panel beside it', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    const railBox = await findRailBox();
    // Icons only in its column, whatever the preference.
    expect(isLabelled()).toBe(false);
    expect(panel.dataset['panel']).toBe('hidden');
    pressSidebarKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('sheet');
    });
    expect(isLabelled()).toBe(true);
    expect(railBox.getAttribute('data-sheet')).toBe('joined');
    // 200 px and its hairline: the panel stands against the labelled rail.
    expect(panel.style.left).toBe('201px');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    expect(isLabelled()).toBe(false);
  });

  it('opens a labelled sidebar alone at 800 px where a section has no panel, and moving on closes it', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    const { router } = renderApp('/board');
    const railBox = await findRailBox();
    pressSidebarKey();
    await waitFor(() => {
      expect(railBox.getAttribute('data-sheet')).toBe('');
    });
    expect(isLabelled()).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Factory' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/factory');
    });
    expect(railBox.hasAttribute('data-sheet')).toBe(false);
  });

  it('opens the icons rail and the panel together under 640 px, and the toggle closes them', async () => {
    viewportWidth(480);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    const railBox = await findRailBox();
    expect(railBox.hasAttribute('inert')).toBe(true);
    expect(panel.dataset['panel']).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('sheet');
    });
    expect(railBox.hasAttribute('inert')).toBe(false);
    expect(railBox.getAttribute('data-sheet')).toBe('joined');
    expect(panel.style.left).toBe('77px');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    expect(railBox.hasAttribute('inert')).toBe(true);
  });

  it('opens the labelled rail alone under 640 px where a section has no panel', async () => {
    viewportWidth(480);
    server.use(...baseHandlers());
    renderApp('/board');
    const railBox = await findRailBox();
    expect(railBox.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    await waitFor(() => {
      expect(railBox.hasAttribute('inert')).toBe(false);
    });
    expect(isLabelled()).toBe(true);
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
    pressPanelKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(window.localStorage.getItem(PANEL_KEY)).toBe('hidden');
    pressPanelKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('column');
    });
    expect(window.localStorage.getItem(PANEL_KEY)).toBeNull();
  });

  it("hides the panel from its head's button and from a click on the open section's own row", async () => {
    viewportWidth(1280);
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/general');
    const panel = await findPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Hide the panel' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    // The same row, clicked, brings it back without leaving the page.
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('column');
    });
    expect(router.state.location.pathname).toBe('/settings/general');
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
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
    expect(screen.queryByRole('button', { name: 'Hide the panel' })).toBeNull();
  });

  it('opens the panel beside the icons rail at 800 px, and Esc, a click outside or moving on closes it', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    expect(panel.dataset['panel']).toBe('hidden');
    expect(panel.hasAttribute('inert')).toBe(true);
    pressPanelKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('sheet');
    });
    expect(panel.hasAttribute('inert')).toBe(false);
    // A sheet stands against the whole frame, flush with the icons rail: 76 px and its hairline.
    expect(panel.hasAttribute('data-sheet')).toBe(true);
    expect(panel.style.left).toBe('77px');
    expect(isLabelled()).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    pressPanelKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('sheet');
    });
    const backdrop = document.querySelector<HTMLElement>('[data-frame-backdrop]');
    if (backdrop === null) throw new Error('an open sheet has a backdrop');
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
    pressPanelKey();
    fireEvent.click(await screen.findByRole('link', { name: 'Planning', hidden: true }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
  });

  it('opens the panel from a click on the open section’s row at 800 px', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('sheet');
    });
  });

  it("closes the sheet on the first Esc while the toggle button's tooltip shows", async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const panel = await findPanel();
    const button = screen.getByRole('button', { name: 'Toggle sidebar' });
    pressPanelKey();
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('sheet');
    });
    // The pointer rests on the button, so its tooltip opens; the tooltip swallows Esc for itself.
    fireEvent.mouseEnter(button);
    await screen.findByRole('tooltip');
    fireEvent.keyDown(button, { key: 'Escape' });
    await waitFor(() => {
      expect(panel.dataset['panel']).toBe('hidden');
    });
  });

  it('has nothing to open where a section has no panel at 800 px', async () => {
    viewportWidth(800);
    server.use(...baseHandlers());
    renderApp('/board');
    const railBox = await findRailBox();
    pressPanelKey();
    expect(railBox.hasAttribute('data-sheet')).toBe(false);
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
    // The panel's head is the sidebar's top row, so it drags like the traffic lights' row above the rail.
    expect(document.querySelector('[data-panel] [data-tauri-drag-region]')).not.toBeNull();
    const row = document.querySelector('[data-title-row]');
    expect(row?.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('keeps the reconnecting banner at the top of the content column', async () => {
    server.use(...baseHandlers());
    renderApp('/factory', { intervals: { healthy: 40, disconnected: 40 } });
    await screen.findByRole('heading', { name: 'Factory' });
    server.use(http.get(daemonUrl('/health'), () => HttpResponse.error()));
    const banner = await screen.findByRole('status');
    const column = banner.parentElement;
    expect(column?.firstElementChild).toBe(banner);
    // The view stays: its title is still in the title row.
    expect(screen.getByRole('heading', { name: 'Factory' })).toBeTruthy();
  });
});

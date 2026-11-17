import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import { resetWindowWidth, windowWidth } from '../../test/window-width';

// Sessions at narrow widths (UI spec §13.2) and what its live region says (§13.1).

const ampsio = projectViewDto({ name: 'ampsio' });

afterEach(() => {
  localStorage.clear();
  resetWindowWidth();
});

function open(path: string, chats: ReturnType<typeof chatDto>[], inbox: unknown[] = []) {
  const served = chatServer({ chats });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(inbox)),
    ...served.handlers,
    ...baseHandlers(),
  );
  return { served, ...renderApp(path) };
}

describe('Sessions at narrow widths', () => {
  it('at 600 px shows one switcher with the selected title and the count of other tabs that need you', async () => {
    windowWidth(600);
    const a = chatDto({ projectId: ampsio.id, title: 'Login fails', tabPosition: 0 });
    const b = chatDto({
      projectId: ampsio.id,
      title: 'Refund flow',
      tabPosition: 1,
      conversation: { state: 'ended_error' },
    });
    open(`/sessions?chat=${a.id}`, [a, b]);
    const switcher = await screen.findByRole('button', { name: /^Login fails, ampsio\. All Tabs/ });
    expect(switcher.textContent).toContain('Login fails');
    expect(switcher.textContent).toContain('1');
    expect(switcher.getAttribute('aria-label')).toContain('1 others need you');
    expect(screen.queryByRole('tab')).toBeNull();
    const panel = await screen.findByRole('tabpanel');
    expect(document.getElementById(panel.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Login fails, ampsio',
    );
  });

  it('opens All Tabs from the switcher and selects another tab', async () => {
    windowWidth(600);
    const a = chatDto({ projectId: ampsio.id, title: 'Login fails', tabPosition: 0 });
    const b = chatDto({ projectId: ampsio.id, title: 'Refund flow', tabPosition: 1 });
    const { router } = open(`/sessions?chat=${a.id}`, [a, b]);
    fireEvent.click(await screen.findByRole('button', { name: /All Tabs/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Refund flow/ }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: b.id });
    });
  });

  it('at 800 px the strip keeps its tabs', async () => {
    windowWidth(800);
    const a = chatDto({ projectId: ampsio.id, title: 'Login fails', tabPosition: 0 });
    open(`/sessions?chat=${a.id}`, [a]);
    expect((await screen.findAllByRole('tab')).length).toBeGreaterThan(0);
  });

  it('says another tab that begins to need you, once, in the polite region', async () => {
    const a = chatDto({ projectId: ampsio.id, title: 'Login fails', tabPosition: 0 });
    const b = chatDto({
      projectId: ampsio.id,
      title: 'Refund flow',
      tabPosition: 1,
      conversation: { state: 'waiting_card' },
    });
    let cards: unknown[] = [];
    const { queryClient } = open(`/sessions?chat=${a.id}`, [a, b]);
    server.use(http.get(daemonUrl('/inbox'), () => HttpResponse.json(cards)));
    await screen.findAllByRole('tab');
    cards = [
      inboxItemDto({
        kind: 'permission',
        projectId: ampsio.id,
        title: 'Run a command',
        detail: { conversationId: b.conversationId },
        options: [{ label: 'allow_once', description: '' }],
      }),
    ];
    await queryClient.invalidateQueries({ queryKey: ['inbox'] });
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Sessions announcements' }).textContent).toBe(
        'Refund flow in ampsio needs you',
      );
    });
  });
});

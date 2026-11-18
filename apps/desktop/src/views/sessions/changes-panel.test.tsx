import { mintId, TaskId, type ChatDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chatChangesDto,
  chatDto,
  chatServer,
  type ChatServerOptions,
} from '../../test/chat-fixtures';
import { chatWorkStateDto } from '../../test/chat-work-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { observeWidthsOf, resetObservedWidth } from '../../test/sized-observer';
import { changesChoice } from './changes-choice';

// A session's Changes: the title row says how much changed, the drawer opens beside the conversation, and a
// line number quotes its line into the composer.

const project = projectViewDto({ name: 'ampsio' });

const DIFF = [
  'diff --git a/src/api/client.ts b/src/api/client.ts',
  '--- a/src/api/client.ts',
  '+++ b/src/api/client.ts',
  '@@ -42,2 +42,2 @@',
  ' keep',
  '-if (res.status === 401) {',
  '+if (res.status === 401 && req.retried) {',
  '',
].join('\n');

const changed = chatChangesDto({
  commits: ['c'.repeat(40)],
  diff: DIFF,
  files: [{ path: 'src/api/client.ts', added: 41, removed: 6 }],
});

const toggle = () => fireEvent.keyDown(document.body, { key: 'D', metaKey: true, shiftKey: true });
const drawer = () => screen.queryByRole('dialog', { name: 'Changes' });

beforeEach(() => {
  observeWidthsOf(900);
});
afterEach(() => {
  resetObservedWidth();
  localStorage.clear();
});

function open(
  options: Omit<ChatServerOptions, 'chats'> = { changes: changed },
  chatCount = 1,
  path?: string,
  conversation?: Partial<ChatDto['conversation']>,
  work?: ChatDto['work'],
) {
  const chats = ['Login fails', 'Billing page'].slice(0, chatCount).map((title, tabPosition) =>
    chatDto({
      projectId: project.id,
      title,
      tabPosition,
      // A session reads its changes once it works somewhere.
      work:
        work === undefined
          ? { place: 'branch', branch: 'chat-work', base: null, worktree: null, askedAt: null }
          : work,
      ...(conversation === undefined ? {} : { conversation }),
    }),
  );
  const served = chatServer({
    chats,
    work: Object.fromEntries(chats.map((c) => [c.id, chatWorkStateDto()])),
    ...options,
  });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...served.handlers,
    ...baseHandlers(),
  );
  const app = renderApp(path ?? `/sessions?chat=${chats[0]?.id ?? ''}`);
  for (const chat of chats) changesChoice.forget(chat.id);
  return { chats, served, ...app };
}

describe('a session’s Changes', () => {
  it('says how much changed in the title row, and opens the drawer on a click', async () => {
    open();
    const button = await screen.findByRole('button', { name: /^Changes\s*\+41\s*−6/ });
    expect(drawer()).toBeNull();
    fireEvent.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Changes' });
    expect((await within(panel).findAllByText('src/api/client.ts')).length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(drawer()).toBeNull();
    });
  });

  it('Esc closes the drawer from the composer, and sends no stop to a running turn', async () => {
    const stops: string[] = [];
    server.use(
      http.post(daemonUrl('/conversations/:conversationId/stop'), ({ params }) => {
        stops.push(String(params['conversationId']));
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    open({ changes: changed }, 1, undefined, { state: 'running' });
    await screen.findByRole('button', { name: /^Changes/ });
    toggle();
    await screen.findByRole('dialog', { name: 'Changes' });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => {
      expect(drawer()).toBeNull();
    });
    expect(stops).toEqual([]);
  });

  it('does not read the changes of a session that has no place to work yet', async () => {
    let reads = 0;
    const { chats } = open({ changes: changed }, 1, undefined, undefined, null);
    server.use(
      http.get(daemonUrl('/chats/:chatId/changes'), () => {
        reads += 1;
        return HttpResponse.json({ error: 'conflict', message: 'No worktree.' }, { status: 409 });
      }),
    );
    await screen.findByRole('textbox', { name: 'Message' });
    expect(chats[0]?.work).toBeNull();
    expect(reads).toBe(0);
  });

  it('offers no Changes button while nothing changed', async () => {
    open({ changes: chatChangesDto() });
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByRole('button', { name: /^Changes/ })).toBeNull();
  });

  it('toggles with ⌘⇧D', async () => {
    open();
    await screen.findByRole('button', { name: /^Changes/ });
    toggle();
    expect(await screen.findByRole('dialog', { name: 'Changes' })).toBeTruthy();
    toggle();
    await waitFor(() => {
      expect(drawer()).toBeNull();
    });
  });

  it('keeps the builder’s choice for each session across a switch', async () => {
    open({ changes: changed }, 2);
    await screen.findByRole('button', { name: /^Changes/ });
    toggle();
    await screen.findByRole('dialog', { name: 'Changes' });
    fireEvent.click(screen.getByRole('option', { name: /Billing page/ }));
    await screen.findByRole('button', { name: /^Changes/ });
    expect(drawer()).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Login fails/ }));
    expect(await screen.findByRole('dialog', { name: 'Changes' })).toBeTruthy();
  });

  it('keeps the drawer and its diff while a newer read is under way', async () => {
    let release: () => void = () => undefined;
    let held = false;
    const { queryClient } = open();
    server.use(
      http.get(daemonUrl('/chats/:chatId/changes'), () => {
        if (!held) return HttpResponse.json(changed);
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(HttpResponse.json(changed));
          };
        });
      }),
    );
    await screen.findByRole('button', { name: /^Changes/ });
    toggle();
    const panel = await screen.findByRole('dialog', { name: 'Changes' });
    await within(panel).findByRole('button', { name: 'Quote line 42 of src/api/client.ts' });
    held = true;
    void queryClient.invalidateQueries({ queryKey: ['chat-work'] });
    await waitFor(() => {
      expect(queryClient.isFetching({ queryKey: ['chat-work'] })).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Reading the changes…')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Changes\s*\+41\s*−6/ })).toBeTruthy();
    release();
  });

  it.each([
    {
      name: 'a line is the new file’s',
      label: 'Quote line 42 of src/api/client.ts',
      quote: '@src/api/client.ts:42\n> keep',
    },
    {
      name: 'a removed line is named as the old file’s',
      label: 'Quote removed line 43 of src/api/client.ts',
      quote: '@src/api/client.ts (line 43 before the change, removed)\n> if (res.status === 401) {',
    },
    {
      name: 'an added line is the new file’s',
      label: 'Quote added line 43 of src/api/client.ts',
      quote: '@src/api/client.ts:43\n> if (res.status === 401 && req.retried) {',
    },
  ])('quotes $name into the composer', async ({ label, quote }) => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^Changes/ }));
    fireEvent.click(await screen.findByRole('button', { name: label }));
    const box = await screen.findByRole('textbox', { name: 'Message' });
    expect(box).toHaveProperty('value', expect.stringContaining(quote));
  });

  it('says a finished worktree is gone and points at the pull request', async () => {
    const chat = chatDto({
      projectId: project.id,
      work: { place: 'branch', branch: 'chat-done', base: null, worktree: null, askedAt: null },
    });
    const served = chatServer({
      chats: [chat],
      work: {
        [chat.id]: chatWorkStateDto({
          pullRequest: {
            number: 5,
            url: 'https://github.com/o/r/pull/5',
            checks: { passed: 1, total: 1, failing: 0 },
            mergeable: true,
            merged: true,
          },
        }),
      },
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/chats/:chatId/changes'), () =>
        HttpResponse.json({ error: 'not_found', message: 'No checkout' }, { status: 404 }),
      ),
      ...served.handlers,
      ...baseHandlers(),
    );
    renderApp(`/sessions?chat=${chat.id}`);
    await screen.findByRole('button', { name: 'Changes' });
    toggle();
    const panel = await screen.findByRole('dialog', { name: 'Changes' });
    expect(
      await within(panel).findByText(
        'This session’s worktree is gone. Its pull request has the changes.',
      ),
    ).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open Pull Request' })).toBeTruthy();
  });

  it.each([
    { name: 'moves left of the drawer at 1200 px', width: 1200, moved: true },
    { name: 'stays put under 1200 px', width: 900, moved: false },
  ])('the conversation column $name', async ({ width, moved }) => {
    observeWidthsOf(width);
    open();
    await screen.findByRole('button', { name: /^Changes/ });
    toggle();
    await screen.findByRole('dialog', { name: 'Changes' });
    const column = (await screen.findByRole('textbox', { name: 'Message' })).closest(
      '[style*="padding-right"]',
    );
    await waitFor(() => {
      expect(column?.getAttribute('style')?.includes('clamp(480px, 50%, 760px)') ?? false).toBe(
        moved,
      );
    });
  });
});

describe('a task’s old tab', () => {
  it('lands on the task in the Board', async () => {
    const taskId = mintId('Task');
    server.use(
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    const { router } = open({}, 1, `/sessions?task=${taskId}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
    expect(router.state.location.search).toEqual({ task: TaskId.parse(taskId) });
  });
});

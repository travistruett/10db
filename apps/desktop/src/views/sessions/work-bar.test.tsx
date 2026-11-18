import type { ChatDto, ChatWork, ChatWorkStateDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { chatKeys } from '../../daemon/chat-queries';
import { chatWorkKeys } from '../../daemon/chat-work-queries';
import { chatDto, chatServer, type ChatServerOptions } from '../../test/chat-fixtures';
import { chatWorkStateDto } from '../../test/chat-work-fixtures';
import { CLAUDE_CAPABILITIES } from '../../test/conversation-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';

// The bar above the composer (sessions spec §3): the first change asks where the work happens, and the
// builder answers in place.

const project = projectViewDto({ name: 'ampsio' });
const CLAUDE = { ...CLAUDE_CAPABILITIES, label: 'Claude Code' };

afterEach(() => {
  localStorage.clear();
});

const choosing = (askedAt: string | null = '2026-11-17T09:00:00.000Z'): ChatWork => ({
  place: 'choosing',
  branch: null,
  base: null,
  worktree: null,
  askedAt,
});

function openChoosing(
  options: {
    readonly work?: ChatWork | null;
    readonly state?: Partial<ChatWorkStateDto>;
    readonly served?: ChatServerOptions;
    readonly extra?: Parameters<typeof server.use>;
  } = {},
) {
  const chat: ChatDto = chatDto({
    projectId: project.id,
    work: options.work === undefined ? choosing() : options.work,
    conversation: { capabilities: CLAUDE, model: 'claude-opus-5' },
  });
  let state = chatWorkStateDto({ place: chat.work?.place ?? null, ...options.state });
  const served = chatServer({ chats: [chat], ...options.served });
  server.use(
    http.get(daemonUrl('/chats/:chatId/work'), () => HttpResponse.json(state)),
    ...(options.extra ?? []),
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...served.handlers,
    ...baseHandlers(),
  );
  const app = renderApp(`/sessions?chat=${chat.id}`);
  return {
    chat,
    served,
    setState: (next: Partial<ChatWorkStateDto>) => {
      state = chatWorkStateDto({ ...state, ...next });
    },
    ...app,
  };
}

const bar = () => screen.findByRole('group', { name: 'Where this work happens' });

describe('the bar that asks where the work happens', () => {
  it('names the agent and offers Here on the checkout’s branch and On a New Branch, with nothing else to say', async () => {
    openChoosing();
    const group = await bar();
    expect(group.textContent).toContain('Claude Code is about to start changing files.');
    expect(within(group).getByRole('button', { name: 'Here, on main' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'On a New Branch' })).toBeTruthy();
    expect(within(group).queryByText(/uncommitted/)).toBeNull();
    expect(within(group).queryByText(/will wait for it/)).toBeNull();
    expect(within(group).queryByRole('alert')).toBeNull();
  });

  it('says how many uncommitted files a new branch leaves in the checkout', async () => {
    openChoosing({ state: { uncommittedInCheckout: 2 } });
    expect(
      await screen.findByText(
        'A new branch starts from your last commit. Your 2 uncommitted files stay in your checkout.',
      ),
    ).toBeTruthy();
  });

  it('says a Board task holds the checkout and follows the holder as it changes', async () => {
    const { setState, queryClient } = openChoosing({
      state: { holder: 'A Board task is changing files on main' },
    });
    expect(
      await screen.findByText(
        'A Board task is changing files on main; this session will wait for it.',
      ),
    ).toBeTruthy();
    setState({ holder: null });
    await queryClient.invalidateQueries({ queryKey: chatWorkKeys.all });
    await waitFor(() => {
      expect(screen.queryByText(/will wait for it/)).toBeNull();
    });
  });

  it('shows a failed move’s words and still offers Here', async () => {
    openChoosing({ state: { refusal: 'The install failed, so the branch was removed.' } });
    const group = await bar();
    expect((await within(group).findByRole('alert')).textContent).toBe(
      'The install failed, so the branch was removed.',
    );
    expect(
      within(group).getByRole<HTMLButtonElement>('button', { name: 'Here, on main' }).disabled,
    ).toBe(false);
  });

  it.each([
    { key: '1', place: 'here' },
    { key: '2', place: 'branch' },
  ])('the key $key sends $place', async ({ key, place }) => {
    const { served, chat } = openChoosing();
    const group = await bar();
    fireEvent.keyDown(group, { key });
    await waitFor(() => {
      expect(served.chosen).toEqual([{ chatId: chat.id, place }]);
    });
  });

  it('a button sends its choice, and the bar goes once the session has moved', async () => {
    const { served, chat } = openChoosing();
    fireEvent.click(await screen.findByRole('button', { name: 'On a New Branch' }));
    await waitFor(() => {
      expect(served.chosen).toEqual([{ chatId: chat.id, place: 'branch' }]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Where this work happens' })).toBeNull();
    });
  });

  it('Esc hides the bar, and it comes back when a refused change asks again', async () => {
    const { served, chat, queryClient } = openChoosing();
    const group = await bar();
    fireEvent.keyDown(group, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Where this work happens' })).toBeNull();
    });
    // A refetch with nothing new keeps it hidden.
    await queryClient.invalidateQueries({ queryKey: chatKeys.all });
    expect(screen.queryByRole('group', { name: 'Where this work happens' })).toBeNull();
    // The next refused change bumps askedAt.
    served.chats.splice(0, 1, chatDto({ ...chat, work: choosing('2026-11-17T10:00:00.000Z') }));
    await queryClient.invalidateQueries({ queryKey: chatKeys.all });
    expect(await bar()).toBeTruthy();
  });

  it('takes the focus when it appears, unless the builder is typing in the composer', async () => {
    openChoosing();
    const group = await bar();
    await waitFor(() => {
      expect(document.activeElement).toBe(group);
    });
  });

  it('leaves the focus in a composer that has words in it', async () => {
    const { chat, served, queryClient } = openChoosing({ work: null });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'half a thought' } });
    box.focus();
    served.chats.splice(0, 1, chatDto({ ...chat, work: choosing() }));
    await queryClient.invalidateQueries({ queryKey: chatKeys.all });
    await bar();
    expect(document.activeElement).toBe(box);
  });

  it('a choice that lost to another says where the session works now', async () => {
    openChoosing({
      served: {
        settled: { place: 'here', branch: null, base: null, worktree: null, askedAt: null },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'On a New Branch' }));
    expect(
      await screen.findByText('This session already works here, in your checkout.'),
    ).toBeTruthy();
  });

  it('a 409 that is not a settled place shows the daemon’s words', async () => {
    openChoosing({
      extra: [
        http.post(daemonUrl('/chats/:chatId/work'), () =>
          HttpResponse.json(
            { error: 'conflict', message: 'Ask again once the turn has ended.' },
            { status: 409 },
          ),
        ),
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'On a New Branch' }));
    expect(await screen.findByText('Ask again once the turn has ended.')).toBeTruthy();
  });

  it('while moving, the composer says where, and no bar asks', async () => {
    openChoosing({
      work: { place: 'moving', branch: 'fix-login', base: 'main', worktree: null, askedAt: null },
    });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    expect(box.getAttribute('placeholder')).toBe('Moving to fix-login…');
    expect(screen.queryByRole('group', { name: 'Where this work happens' })).toBeNull();
  });
});

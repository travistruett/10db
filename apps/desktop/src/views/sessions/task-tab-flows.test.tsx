import { mintId, type ChatDto, type TaskSessionDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { CLAUDE_CAPABILITIES, systemItem } from '../../test/conversation-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { doItPreviewDto, doItServer } from '../../test/do-it-fixtures';
import { inboxItemDto, projectViewDto, taskDto, workstreamDto } from '../../test/fixtures';
import { taskSessionDto, taskSessionHandlers } from '../../test/task-session-fixtures';
import { taskTabs, TASK_TABS_KEY } from './task-tabs';
import { closedTabs } from './closed-tabs';

// A task Do It made has a tab: it takes the chat's place, the sealed chat reads only, and the task stays
// reachable from the chat's row, the Inbox, the Board and ⌘⇧T.

const project = projectViewDto({ name: 'ampsio' });
const CLAUDE = { ...CLAUDE_CAPABILITIES, label: 'Claude Code' };

afterEach(() => {
  localStorage.clear();
  taskTabs.reset();
  closedTabs.reset();
});

const strip = (): HTMLElement => screen.getByRole('tablist', { name: 'Sessions' });
const tabNames = (): string[] =>
  within(strip())
    .getAllByRole('tab')
    // A running task's tab says so after its project.
    .map((tab) => (tab.getAttribute('aria-label') ?? '').replace(', working', ''));

function chatIn(position: number, title: string, overrides: Parameters<typeof chatDto>[0] = {}) {
  return chatDto({
    projectId: project.id,
    title,
    tabPosition: position,
    ...overrides,
    conversation: { capabilities: CLAUDE, model: 'claude-opus-5', ...overrides.conversation },
  });
}

describe('a hand-off to a separate copy', () => {
  it('puts the task’s tab where the chat’s was, and the chat leaves the strip', async () => {
    const [a, b, c] = [chatIn(0, 'First'), chatIn(1, 'Login fails'), chatIn(2, 'Last')] as [
      ChatDto,
      ChatDto,
      ChatDto,
    ];
    const served = chatServer({ chats: [a, b, c] });
    const sessions: TaskSessionDto[] = [];
    const doIt = doItServer({
      preview: doItPreviewDto(),
      onDoIt: (request, taskId) => {
        sessions.push(
          taskSessionDto({
            taskId,
            title: request.title,
            fromChat: { chatId: b.id, title: b.title },
          }),
        );
        served.chats.splice(1, 1, chatDto({ ...b, tabPosition: null, taskId }));
      },
    });
    server.use(
      ...doIt.handlers,
      ...taskSessionHandlers(() => sessions),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...served.handlers,
      ...baseHandlers(),
    );
    renderApp(`/sessions?chat=${b.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Do It…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Do It' });
    await within(sheet).findByDisplayValue('Retry login once on a 401');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Do It' }));
    await waitFor(() => {
      expect(tabNames()).toEqual([
        'First, ampsio',
        'Retry login once on a 401, ampsio',
        'Last, ampsio',
      ]);
    });
    expect(
      within(strip())
        .getByRole('tab', { name: /Retry login once on a 401/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      within(strip())
        .getByRole('tab', { name: /Retry login once/ })
        .querySelector('[data-glyph="git-branch"]'),
    ).not.toBeNull();
  });
});

describe('a hand-off whose chat leaves the strip before the daemon answers', () => {
  it('still opens the task’s tab', async () => {
    const [a, b] = [chatIn(0, 'First'), chatIn(1, 'Login fails')] as [ChatDto, ChatDto];
    const served = chatServer({ chats: [a, b] });
    const sessions: TaskSessionDto[] = [];
    let release: () => void = () => undefined;
    const holdDoIt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const doIt = doItServer({
      preview: doItPreviewDto(),
      holdDoIt,
      onDoIt: (request, taskId) => {
        sessions.push(taskSessionDto({ taskId, title: request.title }));
        // The seal reaches the window as a chat event before the POST is answered.
        served.chats.splice(1, 1, chatDto({ ...b, tabPosition: null, taskId }));
      },
    });
    server.use(
      ...doIt.handlers,
      ...taskSessionHandlers(() => sessions),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...served.handlers,
      ...baseHandlers(),
    );
    const { queryClient } = renderApp(`/sessions?chat=${b.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Do It…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Do It' });
    await within(sheet).findByDisplayValue('Retry login once on a 401');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Do It' }));
    await waitFor(() => {
      expect(doIt.requests).toHaveLength(1);
    });
    await queryClient.invalidateQueries({ queryKey: ['chats'] });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Do It' })).toBeNull();
    });
    release();
    expect(
      (await screen.findByRole('tab', { name: /Retry login once on a 401/ })).getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
  });
});

describe('the sealed chat', () => {
  it('reads only, says where its work went, and Open Task opens the task’s tab', async () => {
    const taskId = mintId('Task');
    const task = taskSessionDto({ taskId, title: 'Retry login once on a 401' });
    const chat = chatIn(0, 'Login fails', { taskId, conversation: { state: 'sealed' } });
    const served = chatServer({ chats: [chat] });
    server.use(
      ...taskSessionHandlers([task]),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...served.handlers,
      ...baseHandlers(),
    );
    renderApp(`/sessions?chat=${chat.id}`);
    expect(await screen.findByText(/This chat handed its work to/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Do It…' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Task' }));
    expect(
      (await screen.findByRole('tab', { name: /Retry login once on a 401/ })).getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
  });

  it('its row opens the task even when the window’s tabs were cleared', async () => {
    const taskId = mintId('Task');
    const task = taskSessionDto({ taskId, title: 'Retry login once on a 401' });
    const chat = chatIn(0, 'Login fails', { taskId, conversation: { state: 'sealed' } });
    const served = chatServer({
      chats: [chat],
      items: {
        [chat.conversationId]: [
          systemItem(chat.conversationId, {
            kind: 'notice',
            text: 'Handed to the task ‘Retry login once on a 401’ in its own copy',
            handedTo: { taskId, title: 'Retry login once on a 401', place: 'worktree' },
          }),
        ],
      },
    });
    server.use(
      ...taskSessionHandlers([task]),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...served.handlers,
      ...baseHandlers(),
    );
    expect(localStorage.getItem(TASK_TABS_KEY)).toBeNull();
    renderApp(`/sessions?chat=${chat.id}`);
    expect(
      await screen.findByText('Started a task: Retry login once on a 401 · Separate copy'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      (await screen.findByRole('tab', { name: /Retry login once on a 401/ })).getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
  });
});

describe('a separate copy’s tab', () => {
  const taskId = mintId('Task');
  const openCopy = (
    session: Partial<TaskSessionDto>,
    extra: Parameters<typeof server.use> = [],
  ) => {
    const chat = chatIn(0, 'Login fails');
    const served = chatServer({ chats: [chat] });
    const full = taskSessionDto({
      taskId,
      fromChat: { chatId: chat.id, title: chat.title },
      ...session,
    });
    taskTabs.open({
      taskId,
      projectId: project.id,
      title: full.title,
      place: 'copy',
      position: 1,
    });
    server.use(
      ...extra,
      ...taskSessionHandlers([full]),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([
          taskDto({ id: taskId, projectId: project.id, description: 'The brief text' }),
        ]),
      ),
      ...served.handlers,
      ...baseHandlers(),
    );
    return renderApp(`/sessions?task=${taskId}`);
  };

  it('opens with the chat it came from, the brief, and the run’s bar', async () => {
    openCopy({});
    expect(await screen.findByText('From chat: Login fails')).toBeTruthy();
    expect(await screen.findByText('The brief text')).toBeTruthy();
    expect(screen.getByText('Task · Separate copy ·')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty(
      'placeholder',
      'Messages reach this task while it runs.',
    );
  });

  it('finished, it says so with the pull request and no composer', async () => {
    openCopy({
      board: 'in_review',
      pullRequest: { url: 'https://github.com/a/b/pull/212', state: 'CI running' },
    });
    expect(
      await screen.findByText('Finished · in review: pull request #212 · CI running'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Pull Request' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('merged, it is done', async () => {
    openCopy({ board: 'done' });
    expect(await screen.findByText('Done · merged.')).toBeTruthy();
  });

  it('failed, it says what happened and offers the Board', async () => {
    const workstreamId = mintId('Workstream');
    openCopy({ board: 'blocked', workstreamId }, [
      http.get(daemonUrl('/workstreams'), () =>
        HttpResponse.json([
          workstreamDto({
            id: workstreamId,
            taskId,
            projectId: project.id,
            state: 'FAILED',
            failureKind: 'session_failed',
            failureReason: 'it stopped',
          }),
        ]),
      ),
    ]);
    await screen.findByText('From chat: Login fails');
    expect(
      await screen.findByText(/stopped|failed|session/i, { selector: '[role=status] *' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open on Board' })).toHaveLength(2);
  });

  it('⌘W closes the tab and ⌘⇧T brings it back where it was', async () => {
    openCopy({});
    await screen.findByText('From chat: Login fails');
    fireEvent.keyDown(document, { key: 'w', metaKey: true });
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Retry login once/ })).toBeNull();
    });
    fireEvent.keyDown(document, { key: 't', metaKey: true, shiftKey: true });
    expect(
      (await screen.findByRole('tab', { name: /Retry login once/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });
});

describe('Open Session for a task Do It made', () => {
  it('the Inbox card of its run opens the task’s tab', async () => {
    const taskId = mintId('Task');
    const workstreamId = mintId('Workstream');
    const card = inboxItemDto({
      projectId: project.id,
      title: 'Which greeting?',
      targets: [{ workstreamId, sessionId: null }],
    });
    server.use(
      ...taskSessionHandlers([
        taskSessionDto({ taskId, fromChat: { chatId: mintId('Chat'), title: 'Login fails' } }),
      ]),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([card])),
      http.get(daemonUrl('/workstreams'), () =>
        HttpResponse.json([workstreamDto({ id: workstreamId, taskId, projectId: project.id })]),
      ),
      ...baseHandlers(),
    );
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Session' }));
    await waitFor(() => {
      expect(taskTabs.list().map((t) => t.taskId)).toEqual([taskId]);
    });
  });
});

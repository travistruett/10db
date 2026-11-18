import { ChatGitStep, type ChatWorkStateDto, type ConversationDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatChangesDto,
  chatDto,
  chatServer,
  type ChatServerOptions,
} from '../../test/chat-fixtures';
import { chatWorkKeys } from '../../daemon/chat-work-queries';
import { chatWorkStateDto } from '../../test/chat-work-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';

// The title row's git step: one button, whichever step the daemon says is next, and the Commit form behind it.

const project = projectViewDto({ name: 'ampsio' });

afterEach(() => {
  localStorage.clear();
});

function open(
  work: Partial<ChatWorkStateDto>,
  options: Omit<ChatServerOptions, 'chats' | 'work'> = {},
  state: ConversationDto['state'] = 'idle_warm',
) {
  const chat = chatDto({
    projectId: project.id,
    title: 'Add the QA notes',
    work: {
      place: 'branch',
      branch: 'chat-add-the-qa-notes',
      base: null,
      worktree: null,
      askedAt: null,
    },
    conversation: { state },
  });
  const served = chatServer({
    chats: [chat],
    work: {
      [chat.id]: chatWorkStateDto({ place: 'branch', branch: 'chat-add-the-qa-notes', ...work }),
    },
    ...options,
  });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...served.handlers,
    ...baseHandlers(),
  );
  const app = renderApp(`/sessions?chat=${chat.id}`);
  return { chat, served, ...app };
}

const pullRequest = (checks: { passed: number; total: number; failing: number }) => ({
  number: 652,
  url: 'https://github.com/o/r/pull/652',
  checks,
  mergeable: true,
  merged: false,
});

describe('the git step button', () => {
  it('opens a pull request in one click when that is the next step', async () => {
    const { chat, served } = open({ next: ChatGitStep.OpenPullRequest, ahead: 2 });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pull Request' }));
    await waitFor(() => {
      expect(served.pullRequests).toEqual([chat.id]);
    });
  });

  it('reads Push, and still posts the same step, when a pull request is open and commits are not pushed', async () => {
    const { chat, served } = open({
      next: ChatGitStep.OpenPullRequest,
      ahead: 2,
      pullRequest: pullRequest({ passed: 3, total: 9, failing: 0 }),
    });
    expect(screen.queryByRole('button', { name: 'Open Pull Request' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }));
    await waitFor(() => {
      expect(served.pullRequests).toEqual([chat.id]);
    });
  });

  it('merges when the checks pass', async () => {
    const { chat, served } = open({
      next: ChatGitStep.Merge,
      pullRequest: pullRequest({ passed: 9, total: 9, failing: 0 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    await waitFor(() => {
      expect(served.merges).toEqual([chat.id]);
    });
  });

  it('shows Merge disabled, with the checks, while they run', async () => {
    const { served } = open({
      next: ChatGitStep.Merge,
      pullRequest: pullRequest({ passed: 3, total: 9, failing: 0 }),
    });
    const button = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Checks running · 3/9',
    });
    expect(button.disabled).toBe(true);
    expect(served.merges).toEqual([]);
  });

  it('names the base branch on a local merge', async () => {
    open({ next: ChatGitStep.MergeLocal, baseBranch: 'main' });
    expect(await screen.findByRole('button', { name: 'Merge into main' })).toBeTruthy();
  });

  it('shows no button when nothing is next', async () => {
    open({ next: null });
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByRole('button', { name: /^(Commit…|Merge|Open Pull Request)/ })).toBeNull();
  });

  it('says it waits for the turn to end while a step waits on the session’s own turn', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { served } = open({ next: ChatGitStep.OpenPullRequest }, {}, 'running');
    server.use(
      http.post(daemonUrl('/chats/:chatId/pull-request'), async () => {
        await gate;
        return HttpResponse.json(chatWorkStateDto());
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pull Request' }));
    expect(await screen.findByRole('button', { name: 'Waits for the turn to end' })).toBeTruthy();
    release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Waits for the turn to end' })).toBeNull();
    });
    expect(served.pullRequests).toEqual([]);
  });

  it('shows a step the daemon refused as a notice that can be dismissed', async () => {
    open({ next: ChatGitStep.OpenPullRequest });
    server.use(
      http.post(daemonUrl('/chats/:chatId/pull-request'), () =>
        HttpResponse.json(
          { error: 'refused', message: 'GitHub refused the push.' },
          { status: 409 },
        ),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pull Request' }));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('GitHub refused the push.');
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('Commit…', () => {
  const changes = chatChangesDto({
    files: [
      { path: '.env', added: 1, removed: 0 },
      { path: 'src/a.ts', added: 4, removed: 1 },
      { path: 'src/b.ts', added: 2, removed: 0 },
    ],
  });

  it('starts with the title as the message and the files the session touched checked, and sends those', async () => {
    const { chat, served } = open(
      { next: ChatGitStep.Commit, dirtyFiles: 3, touched: ['src/a.ts', 'src/b.ts'] },
      { changes },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Commit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commit' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Message').value).toBe(
      'Add the QA notes',
    );
    const box = (name: string) => within(dialog).findByRole<HTMLInputElement>('checkbox', { name });
    expect((await box('.env')).checked).toBe(false);
    expect((await box('src/a.ts')).checked).toBe(true);
    fireEvent.click(await box('src/b.ts'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    await waitFor(() => {
      expect(served.commits).toEqual([
        { chatId: chat.id, body: { message: 'Add the QA notes', paths: ['src/a.ts'] } },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Commit' })).toBeNull();
    });
  });

  it('says in the form that the commit waits while the session’s own turn runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    open({ next: ChatGitStep.Commit, touched: ['src/a.ts'] }, { changes }, 'running');
    server.use(
      http.post(daemonUrl('/chats/:chatId/commit'), async () => {
        await gate;
        return HttpResponse.json(chatWorkStateDto());
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Commit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commit' });
    await within(dialog).findByRole('checkbox', { name: 'src/a.ts' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    expect(
      await within(dialog).findByRole('button', { name: 'Waits for the turn to end' }),
    ).toBeTruthy();
    release();
  });

  it('keeps the form and its edits when the next step stops being Commit under it', async () => {
    const { queryClient } = open({ next: ChatGitStep.Commit, touched: ['src/a.ts'] }, { changes });
    fireEvent.click(await screen.findByRole('button', { name: 'Commit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commit' });
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'My words' } });
    server.use(
      http.get(daemonUrl('/chats/:chatId/work'), () =>
        HttpResponse.json(chatWorkStateDto({ place: 'branch', next: ChatGitStep.OpenPullRequest })),
      ),
    );
    await queryClient.invalidateQueries({ queryKey: chatWorkKeys.all });
    await screen.findByRole('button', { name: 'Open Pull Request' });
    expect(
      within(screen.getByRole('dialog', { name: 'Commit' })).getByLabelText<HTMLInputElement>(
        'Message',
      ).value,
    ).toBe('My words');
  });

  it('keeps the form open with the daemon’s words when the commit is refused', async () => {
    open(
      { next: ChatGitStep.Commit, touched: ['src/a.ts'] },
      { changes, commitRefusal: 'A hook rejected the commit.' },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Commit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commit' });
    await within(dialog).findByRole('checkbox', { name: 'src/a.ts' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'A hook rejected the commit.',
    );
  });
});

describe('the title row’s meta line', () => {
  it('says what changed, in git’s words, and updates when the daemon’s read does', async () => {
    open({ next: ChatGitStep.Commit, dirtyFiles: 2 });
    expect(
      await screen.findByText('on chat-add-the-qa-notes · 2 files changed, not committed'),
    ).toBeTruthy();
  });

  it('names the pull request and its checks', async () => {
    open({
      next: ChatGitStep.Merge,
      ahead: 1,
      pullRequest: pullRequest({ passed: 3, total: 9, failing: 0 }),
    });
    expect(
      await screen.findByText('on chat-add-the-qa-notes · pull request #652, checks running · 3/9'),
    ).toBeTruthy();
  });
});

describe('Make a Board Task…', () => {
  it('opens the Board’s New Task form with the session’s title and leaves the session open', async () => {
    const { served, router } = open({ next: null });
    server.use(
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.click(await screen.findByRole('button', { name: 'More session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make a Board Task…' }));
    const form = await screen.findByRole('dialog', { name: 'New Task' });
    expect(within(form).getByLabelText<HTMLInputElement>('Title').value).toBe('Add the QA notes');
    expect(router.state.location.pathname).toBe('/board');
    expect(served.patches).toEqual([]);
    expect(served.archived).toEqual([]);
  });
});

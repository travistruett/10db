import {
  mintId,
  WorkstreamChangesDto,
  type InboxItemDto,
  type WorkstreamId,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../daemon/queries';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto, taskDto, workstreamDto } from '../../test/fixtures';

const projectId = mintId('Project');
const workstreamId: WorkstreamId = mintId('Workstream');
const taskId = mintId('Task');
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const card: InboxItemDto = inboxItemDto({
  kind: 'check',
  projectId,
  title: 'Ready for you to check: Write the greeting',
  body: '2 commits are ready. Approve to finish the task, or send it back with a note.',
  options: [
    { label: 'approve', description: 'The work is right' },
    { label: 'send_back', description: 'It needs more work' },
  ],
  detail: { workstreamId, baseHead: BASE, head: HEAD, commits: ['1111111aaaa', '2222222bbbb'] },
  targets: [{ workstreamId, sessionId: null }],
});

function changes(overrides: Partial<WorkstreamChangesDto> = {}): WorkstreamChangesDto {
  return WorkstreamChangesDto.parse({
    baseHead: BASE,
    head: HEAD,
    commits: ['1111111aaaa', '2222222bbbb'],
    diff: 'diff --git a/hello.txt b/hello.txt\n+hello world\n',
    truncated: false,
    files: [
      { path: 'hello.txt', added: 3, removed: 1 },
      { path: 'logo.png', added: null, removed: null },
    ],
    ...overrides,
  });
}

const other: InboxItemDto = inboxItemDto({
  kind: 'question',
  title: 'Which badge color?',
  body: 'Color',
  options: [
    { label: 'Teal', description: '' },
    { label: 'Red', description: '' },
  ],
});

interface Served {
  readonly answers: unknown[];
  readonly inboxReads: () => number;
  /** Replaces the open inbox, as the daemon does when the cards change. */
  readonly setItems: (next: InboxItemDto[]) => void;
}

function serve(
  diff: () => WorkstreamChangesDto,
  options: {
    items?: InboxItemDto[];
    answerStatus?: number;
    keepAfterAnswer?: boolean;
    holdChanges?: PromiseWithResolvers<undefined>;
  } = {},
): Served {
  const answers: unknown[] = [];
  let items = options.items ?? [card];
  let reads = 0;
  server.use(
    http.get(daemonUrl('/inbox'), () => {
      reads += 1;
      return HttpResponse.json(
        answers.length === 0 || options.keepAfterAnswer === true ? items : [],
      );
    }),
    http.get(daemonUrl(`/workstreams/${workstreamId}/changes`), async () => {
      await options.holdChanges?.promise;
      return HttpResponse.json(diff());
    }),
    http.get(daemonUrl('/workstreams'), () =>
      HttpResponse.json([workstreamDto({ id: workstreamId, taskId, projectId })]),
    ),
    http.get(daemonUrl(`/projects/${projectId}/tasks`), () =>
      HttpResponse.json([
        taskDto({
          id: taskId,
          projectId,
          acceptanceCriteria: ['hello.txt says hello', 'The tests pass'],
        }),
      ]),
    ),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
      answers.push(await request.json());
      if (options.answerStatus !== undefined)
        return HttpResponse.json(
          { error: 'failed', message: 'The daemon said no' },
          { status: options.answerStatus },
        );
      return HttpResponse.json({ ...card, state: 'ANSWERED' });
    }),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return {
    answers,
    inboxReads: () => reads,
    setItems: (next) => {
      items = next;
    },
  };
}

/** The Approve button once the card's changes have loaded, which is when it turns on. */
async function loadedApprove(): Promise<HTMLElement> {
  await screen.findByRole('region', { name: 'Diff' });
  return screen.getByRole('button', { name: 'Approve' });
}

function htmlElement(node: Node | null): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error('expected an element');
  return node;
}

describe('CheckCard', () => {
  it('shows criteria, commits, files with counts and the diff', async () => {
    serve(() => changes());
    renderApp('/inbox');
    expect(await screen.findByText('hello.txt says hello')).toBeTruthy();
    expect(screen.getByText('The tests pass')).toBeTruthy();
    expect(screen.getByText('1111111')).toBeTruthy();
    expect(screen.getByText('2222222')).toBeTruthy();
    const file = (await screen.findByText('hello.txt')).closest('li');
    expect(within(htmlElement(file)).getByText('+3')).toBeTruthy();
    expect(within(htmlElement(file)).getByText('-1')).toBeTruthy();
    const binary = screen.getByText('logo.png').closest('li');
    expect(within(htmlElement(binary)).queryByText(/^[+-]\d/)).toBeNull();
    expect(screen.getByText(/\+hello world/)).toBeTruthy();
    expect(screen.queryByText(/The diff is longer than we show/)).toBeNull();
  });

  it('gives the diff and the commit chips a surface of their own, so they show in the light scheme', async () => {
    serve(() => changes());
    renderApp('/inbox');
    for (const node of [
      await screen.findByText('1111111'),
      await screen.findByText(/\+hello world/),
    ]) {
      expect(htmlElement(node).style.background).toContain('--mantine-color-default-hover');
    }
  });

  it('a truncated diff says so', async () => {
    serve(() => changes({ truncated: true }));
    renderApp('/inbox');
    expect(
      await screen.findByText('The diff is longer than we show. The file list above is complete.'),
    ).toBeTruthy();
  });

  it('Approve sends approve', async () => {
    const { answers } = serve(() => changes());
    renderApp('/inbox');
    fireEvent.click(await loadedApprove());
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'approve' }]);
    });
  });

  it('Send Back needs a note, then sends it', async () => {
    const { answers } = serve(() => changes());
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    const send = screen.getByRole('button', { name: 'Send It Back' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'What needs to change' }), {
      target: { value: '  Say hello twice  ' },
    });
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'send_back', note: 'Say hello twice' }]);
    });
  });

  it('Enter on the focused Approve button activates the button and never reaches the Inbox keys', async () => {
    const { answers } = serve(() => changes());
    renderApp('/inbox');
    const approve = await loadedApprove();
    approve.focus();
    expect(fireEvent.keyDown(approve, { key: 'Enter' })).toBe(true);
    fireEvent.click(approve);
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'approve' }]);
    });
  });

  it('digits and Enter on the page never answer a check card', async () => {
    const { answers } = serve(() => changes());
    renderApp('/inbox');
    const approve = await loadedApprove();
    fireEvent.keyDown(document.body, { key: '2' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'approve' }]);
    });
  });

  it('Enter in the Send Back note does not submit the Inbox draft', async () => {
    const { answers } = serve(() => changes());
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    const note = screen.getByRole('textbox', { name: 'What needs to change' });
    expect(fireEvent.keyDown(note, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(note, { key: 'Enter', metaKey: true })).toBe(true);
    expect(answers).toEqual([]);
  });

  it('arrow keys in the diff scroll it instead of moving to the next card', async () => {
    serve(() => changes(), { items: [card, other] });
    renderApp('/inbox');
    const diff = await screen.findByRole('region', { name: 'Diff' });
    expect(diff.getAttribute('tabindex')).toBe('0');
    expect(fireEvent.keyDown(diff, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(diff, { key: 'j' })).toBe(true);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Teal/ })).toBeNull();
  });

  it('opening Send Back focuses the note, and Cancel returns focus to Send Back', async () => {
    serve(() => changes());
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    const note = screen.getByRole('textbox', { name: 'What needs to change' });
    expect(document.activeElement).toBe(note);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send Back' }));
  });

  it('keeps the typed note when the card is deselected and selected again', async () => {
    serve(() => changes(), { items: [card, other] });
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What needs to change' }), {
      target: { value: 'Say hello twice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Which badge color/ }));
    expect(await screen.findByRole('radio', { name: /Teal/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ready for you to check/ }));
    const note = await screen.findByRole('textbox', { name: 'What needs to change' });
    expect(note instanceof HTMLTextAreaElement && note.value).toBe('Say hello twice');
  });

  it('a new round shows its own diff and keeps Approve off until it loads', async () => {
    const next = 'c'.repeat(40);
    let current = changes();
    const served = serve(() => current);
    const { queryClient } = renderApp('/inbox');
    expect(await screen.findByText(/\+hello world/)).toBeTruthy();
    current = changes({ head: next, diff: '+second round\n' });
    served.setItems([
      { ...card, detail: { workstreamId, baseHead: BASE, head: next, commits: [] } },
    ]);
    await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    await waitFor(() => {
      expect(screen.queryByText(/\+hello world/)).toBeNull();
    });
    expect(await screen.findByText(/\+second round/)).toBeTruthy();
  });

  it('the note is capped and a whitespace-only note leaves Send It Back off', async () => {
    serve(() => changes());
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    const note = screen.getByRole('textbox', { name: 'What needs to change' });
    expect(note.getAttribute('maxlength')).toBe('4000');
    fireEvent.change(note, { target: { value: '   \n ' } });
    expect(screen.getByRole('button', { name: 'Send It Back' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows an answer error beside the buttons', async () => {
    serve(() => changes(), { answerStatus: 500 });
    renderApp('/inbox');
    fireEvent.click(await loadedApprove());
    const alert = await screen.findByText('The daemon said no');
    expect(alert.closest('[role="alert"]')).toBeTruthy();
  });

  it('refreshes the inbox when the card was already answered', async () => {
    const served = serve(() => changes(), { answerStatus: 409 });
    renderApp('/inbox');
    fireEvent.click(await loadedApprove());
    const before = served.inboxReads();
    await screen.findByText('This card was already answered.');
    await waitFor(() => {
      expect(served.inboxReads()).toBeGreaterThan(before);
    });
  });

  it('keeps Approve off while the changes load', async () => {
    const hold = Promise.withResolvers<undefined>();
    serve(() => changes(), { holdChanges: hold });
    renderApp('/inbox');
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve.hasAttribute('disabled')).toBe(true);
    hold.resolve(undefined);
    await screen.findByRole('region', { name: 'Diff' });
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false);
  });

  it('says so beside Approve when the changes failed to load, and keeps Approve on', async () => {
    const { answers } = serve(() => changes());
    server.use(
      http.get(daemonUrl(`/workstreams/${workstreamId}/changes`), () =>
        HttpResponse.json({ error: 'failed', message: 'No worktree' }, { status: 409 }),
      ),
    );
    renderApp('/inbox');
    await screen.findByText("Couldn't load the changes");
    expect(await screen.findByText(/did not load/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    await waitFor(() => {
      expect(approve.hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'approve' }]);
    });
  });

  it('shows the daemon reason for a 409 when the card is still open', async () => {
    serve(() => changes(), { answerStatus: 409, keepAfterAnswer: true });
    renderApp('/inbox');
    fireEvent.click(await loadedApprove());
    expect(await screen.findByText('The daemon said no')).toBeTruthy();
    expect(screen.queryByText('This card was already answered.')).toBeNull();
  });

  it('does not take focus when the card mounts with a kept note', async () => {
    serve(() => changes(), { items: [card, other] });
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What needs to change' }), {
      target: { value: 'Say hello twice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Which badge color/ }));
    await screen.findByRole('radio', { name: /Teal/ });
    fireEvent.click(screen.getByRole('button', { name: /Ready for you to check/ }));
    const note = await screen.findByRole('textbox', { name: 'What needs to change' });
    expect(document.activeElement).not.toBe(note);
  });

  it('Cancel drops the note so selecting the card again does not reopen the panel', async () => {
    serve(() => changes(), { items: [card, other] });
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What needs to change' }), {
      target: { value: 'Say hello twice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Which badge color/ }));
    await screen.findByRole('radio', { name: /Teal/ });
    fireEvent.click(screen.getByRole('button', { name: /Ready for you to check/ }));
    await screen.findByRole('button', { name: 'Send Back' });
    expect(screen.queryByRole('textbox', { name: 'What needs to change' })).toBeNull();
  });
});

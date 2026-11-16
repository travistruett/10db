import {
  FolderHolderKind,
  mintId,
  type ChatDto,
  type ChatToolResult,
  type ConversationItemDto,
} from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { FILE_AS_TASKS_MESSAGE } from './chat-tab';
import {
  builderItem,
  CLAUDE_CAPABILITIES,
  systemItem,
  toolItem,
} from '../../test/conversation-fixtures';
import { FOLDER_REFRESH_MS, folderKeys } from '../../daemon/project-folder-queries';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { folderDto, folderHolder } from '../../test/folder-fixtures';
import { inboxItemDto, projectViewDto, taskDto } from '../../test/fixtures';
import { modelEffortDto, modelRowDto } from '../../test/model-fixtures';
import { commandCall, mcpCall } from '../../test/tool-call-fixtures';

// A chat's tab over the daemon: its bar, its builder-tool rows, its cards and its states.

const project = projectViewDto({ name: 'ampsio' });
const CLAUDE = { ...CLAUDE_CAPABILITIES, label: 'Claude Code', plan: true };

afterEach(() => {
  localStorage.clear();
});

type Chat = Parameters<typeof chatDto>[0];

function openChat(
  overrides: Chat = {},
  items: (chat: ChatDto) => ConversationItemDto[] = () => [],
  extra: Parameters<typeof server.use> = [],
  projects = [project],
) {
  const chat = chatDto({
    projectId: project.id,
    ...overrides,
    conversation: { capabilities: CLAUDE, model: 'claude-opus-5', ...overrides.conversation },
  });
  const served = chatServer({ chats: [chat], items: { [chat.conversationId]: items(chat) } });
  server.use(
    ...extra,
    http.get(daemonUrl('/projects'), () => HttpResponse.json(projects)),
    ...served.handlers,
    ...baseHandlers(),
  );
  const app = renderApp(`/sessions?chat=${chat.id}`);
  return { chat, served, ...app };
}

const taskResult = (r: ChatToolResult) => JSON.stringify(r);
const taskId = mintId('Task');

const createRow = (chat: ChatDto) =>
  toolItem(
    chat.conversationId,
    mcpCall({
      id: 'create',
      harnessTool: 'mcp__10db__create_task',
      server: '10db',
      tool: 'create_task',
      title: '10db.create_task',
      resultTail: taskResult({
        kind: 'task',
        taskId,
        title: 'Retry export on timeout',
        column: 'Ready',
      }),
    }),
  );

describe('ChatTab: the session bar', () => {
  it('shows the title, what the session is, the agent, and the composer’s model chip and context ring', async () => {
    openChat({ title: 'Login fails after sleep', conversation: { contextPct: 41 } });
    expect((await screen.findByTitle('Double-click to rename')).textContent).toBe(
      'Login fails after sleep',
    );
    expect(await screen.findByText('Chat · Your folder · on main')).toBeTruthy();
    expect(await screen.findByText('Claude Code')).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Model and effort' })).textContent).toContain(
      'claude-opus-5',
    );
    expect(screen.getByRole('img', { name: /41% of the context used/ })).toBeTruthy();
  });

  it('renames on a double-click and Enter, sending the new title', async () => {
    const { served } = openChat({ title: 'Login fails after sleep' });
    fireEvent.doubleClick(await screen.findByTitle('Double-click to rename'));
    const field = screen.getByRole('textbox', { name: 'Session name' });
    fireEvent.change(field, { target: { value: 'Sleep bug' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(served.patches).toEqual([
        { chatId: served.chats[0]?.id, body: { title: 'Sleep bug' } },
      ]);
    });
  });

  it('File as Tasks sends the fixed message as the builder’s turn', async () => {
    const { served } = openChat();
    fireEvent.click(await screen.findByRole('button', { name: 'File as Tasks' }));
    await waitFor(() => {
      expect(served.messages).toHaveLength(1);
    });
    expect(served.messages[0]?.body).toEqual({
      text: 'File the work we agreed on as tasks on the Board.',
    });
  });

  it.each([
    { name: 'a metered account adds the cost', costUsd: 0.42, tip: /\$0\.42 so far/ },
    { name: 'an account without cost says none', costUsd: null, tip: null },
  ])('the meter’s tooltip: $name', async ({ costUsd, tip }) => {
    openChat({ conversation: { contextPct: 41, costUsd } });
    const meter = await screen.findByRole('img', { name: /41% of the context used/ });
    expect(meter.getAttribute('aria-label')).toContain(
      'Past 70%, the next turn continues in a fresh session with a summary.',
    );
    if (tip === null) expect(meter.getAttribute('aria-label')).not.toContain('so far');
    else expect(meter.getAttribute('aria-label')).toMatch(tip);
  });

  it('with no capabilities beyond the floor: plain-text model, no Attach, no slash hint, no cost', async () => {
    openChat(
      {
        conversation: {
          capabilities: {
            ...CLAUDE,
            modelSwitch: 'none',
            images: [],
            slashCommands: false,
            costUsd: false,
          },
          contextPct: 41,
          costUsd: null,
        },
      },
      () => [],
      [
        http.get(daemonUrl('/models'), () =>
          HttpResponse.json([modelRowDto({ model: 'claude-opus-5', name: 'Opus 5' })]),
        ),
      ],
    );
    expect(await screen.findByText('Opus 5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Model and effort' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
    expect(screen.queryByText(/\/ commands/)).toBeNull();
    expect(screen.getByRole('img', { name: /41%/ }).getAttribute('aria-label')).not.toContain('$');
  });

  it('says how a session is judged only on the rules floor', async () => {
    openChat({ conversation: { capabilities: { ...CLAUDE, judge: 'rules' } } });
    expect(await screen.findByText(/Judged by 10db’s rules\./)).toBeTruthy();
  });
});

describe('ChatTab: the chat’s builder-tool rows', () => {
  it('Undo removes the task through the daemon, and its refusal is said in the row', async () => {
    const removed: string[] = [];
    openChat({}, (chat) => [createRow(chat)], [
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([
          taskDto({ id: taskId, title: 'Retry export on timeout', boardStatus: 'ready' }),
        ]),
      ),
      http.post(daemonUrl('/tasks/:taskId/remove'), ({ params }) => {
        removed.push(String(params['taskId']));
        return HttpResponse.json(
          { error: 'conflict', message: 'This task has started, so it can’t be removed.' },
          { status: 409 },
        );
      }),
    ]);
    expect(await screen.findByText('Retry export on timeout')).toBeTruthy();
    expect(screen.getByText('Added to Ready')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open on Board' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('This task has started, so it can’t be removed.')).toBeTruthy();
    expect(removed).toEqual([taskId]);
  });

  it('Undo on a task removes it and the row says so', async () => {
    openChat({}, (chat) => [createRow(chat)], [
      http.post(daemonUrl('/tasks/:taskId/remove'), () =>
        HttpResponse.json(taskDto({ id: taskId })),
      ),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Removed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('an edit reads "Changed the title", and its Undo puts the old title back, never removing', async () => {
    const patches: unknown[] = [];
    let removes = 0;
    openChat(
      {},
      (chat) => [
        toolItem(
          chat.conversationId,
          mcpCall({
            id: 'edit',
            harnessTool: 'mcp__10db__edit_task',
            server: '10db',
            tool: 'edit_task',
            resultTail: taskResult({
              kind: 'task_edit',
              taskId,
              title: 'Retry export',
              previous: { title: 'Retry export on timeout' },
            }),
          }),
        ),
      ],
      [
        http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
          patches.push(await request.json());
          return HttpResponse.json(taskDto({ id: taskId }));
        }),
        http.post(daemonUrl('/tasks/:taskId/remove'), () => {
          removes += 1;
          return HttpResponse.json(taskDto({ id: taskId }));
        }),
      ],
    );
    expect(await screen.findByText('Changed the title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(patches).toEqual([{ title: 'Retry export on timeout' }]);
    });
    expect(removes).toBe(0);
  });

  it('a start row links the board and has no Undo; a rename row undoes by patching the title back', async () => {
    const { served } = openChat({ title: 'Sleep bug' }, (chat) => [
      toolItem(
        chat.conversationId,
        mcpCall({
          id: 'start',
          harnessTool: 'mcp__10db__start_task',
          server: '10db',
          tool: 'start_task',
          resultTail: taskResult({ kind: 'start', taskId, started: true }),
        }),
      ),
      toolItem(
        chat.conversationId,
        mcpCall({
          id: 'title',
          harnessTool: 'mcp__10db__set_title',
          server: '10db',
          tool: 'set_title',
          resultTail: taskResult({
            kind: 'title',
            title: 'Sleep bug',
            previousTitle: 'Login fails',
          }),
        }),
      ),
    ]);
    expect(await screen.findByText('Renamed this session to ‘Sleep bug’')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open on Board' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(served.patches.at(-1)?.body).toEqual({ title: 'Login fails' });
    });
  });
});

describe('ChatTab: cards, held-back calls and states', () => {
  it('shows a waiting card above the composer and answers it through the Inbox', async () => {
    const answers: unknown[] = [];
    const { chat } = openChat();
    const card = inboxItemDto({
      kind: 'permission',
      projectId: project.id,
      title: 'Run a command',
      body: 'pnpm vitest run',
      category: 'access',
      options: [
        { label: 'allow_once', description: 'Allow this call once' },
        { label: 'deny', description: 'Deny' },
      ],
      detail: { conversationId: chat.conversationId },
    });
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([card])),
      http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
        answers.push(await request.json());
        return HttpResponse.json({ ...card, state: 'ANSWERED' });
      }),
    );
    const region = await screen.findByRole('region', { name: 'Waiting for your answer' });
    expect(within(region).getByText('Also in your Inbox.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('radio', { name: /Allow once/ }));
    fireEvent.click(within(region).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'allow_once' }]);
    });
  });

  it('a call the judge held back shows its limit and Allow This, which sends "Go ahead"', async () => {
    const { served } = openChat({}, (chat) => [
      builderItem(chat.conversationId, 'Fetch it'),
      toolItem(
        chat.conversationId,
        commandCall({
          id: 'held',
          title: 'curl example.com',
          command: 'curl example.com',
          status: 'denied',
          deniedBy: 'judge',
          limit: 'sends_data_out',
          soft: true,
          refusal: null,
        }),
      ),
    ]);
    expect(await screen.findByText(/Held back: this would send data out/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow This' }));
    await waitFor(() => {
      expect(served.messages).toHaveLength(1);
    });
    expect(served.messages[0]?.body).toEqual({ text: 'Go ahead: curl example.com' });
  });

  it('a chat whose project was removed keeps its transcript and has no composer', async () => {
    openChat(
      {},
      (chat) => [builderItem(chat.conversationId, 'Why does it fail?')],
      [],
      [projectViewDto({ name: 'other' })],
    );
    expect(await screen.findByText('This project was removed from 10db.')).toBeTruthy();
    expect(await screen.findByText('Why does it fail?')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('a session that ended in error says so, in words, after the transcript', async () => {
    openChat({ conversation: { state: 'ended_error' } }, (chat) => [
      builderItem(chat.conversationId, 'Hi'),
    ]);
    expect(
      await screen.findByText('The session stopped. Send a message to start it again.'),
    ).toBeTruthy();
  });

  it('a refused model says so beside the chip and keeps the draft', async () => {
    openChat({}, () => [], [
      http.patch(daemonUrl('/chats/:chatId'), () =>
        HttpResponse.json(
          { error: 'refused', message: 'That model is not on this account.' },
          { status: 409 },
        ),
      ),
    ]);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), {
      target: { value: 'half a thought' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Model and effort' }));
    fireEvent.click(
      await screen.findByRole('menuitemradio', { name: /claude-sonnet-5-5/, hidden: true }),
    );
    expect(await screen.findByText('That model is not on this account.')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value).toBe(
      'half a thought',
    );
  });

  it('a model picked in the composer is sent to the chat, to apply from its next turn', async () => {
    const { served } = openChat();
    fireEvent.click(await screen.findByRole('button', { name: 'Model and effort' }));
    fireEvent.click(
      await screen.findByRole('menuitemradio', { name: /claude-sonnet-5-5/, hidden: true }),
    );
    await waitFor(() => {
      expect(served.patches).toEqual([
        { chatId: served.chats[0]?.id, body: { model: 'claude-sonnet-5-5', effort: null } },
      ]);
    });
  });

  it('an effort picked on a chat with no warm session shows on the chip at once', async () => {
    openChat({ conversation: { state: 'idle_cold' } }, () => [], [
      http.get(daemonUrl('/models'), () =>
        HttpResponse.json([
          modelRowDto({
            model: 'claude-opus-5',
            name: 'Opus 5',
            efforts: [modelEffortDto({ effort: 'high' }), modelEffortDto({ effort: 'low' })],
          }),
        ]),
      ),
    ]);
    const chip = await screen.findByRole('button', { name: 'Model and effort' });
    await waitFor(() => {
      expect(chip.textContent).toContain('Opus 5');
    });
    fireEvent.click(chip);
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Effort/, hidden: true }), {
      key: 'ArrowRight',
    });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Low', hidden: true }));
    await waitFor(() => {
      expect(chip.textContent).toBe('Opus 5 Low');
    });
  });
});

describe('ChatTab: the session bar and Your folder', () => {
  it('says what holds Your folder and follows it when a task starts or ends', async () => {
    let folder = folderDto({ projectId: project.id });
    const { queryClient } = openChat({}, () => [], [
      http.get(daemonUrl('/projects/:projectId/folder'), () => HttpResponse.json(folder)),
    ]);
    expect(await screen.findByText('Chat · Your folder · on main')).toBeTruthy();

    folder = folderDto({
      projectId: project.id,
      holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')],
    });
    await queryClient.invalidateQueries({ queryKey: folderKeys.all });
    expect(
      await screen.findByText('Chat · reads only: Your folder is in use by the task ‘Bump vite’'),
    ).toBeTruthy();

    folder = folderDto({ projectId: project.id, branch: 'fix/login' });
    await queryClient.invalidateQueries({ queryKey: folderKeys.all });
    expect(await screen.findByText('Chat · Your folder · on fix/login')).toBeTruthy();
  });
});

describe('ChatTab: the branch on the bar', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a branch switched in a terminal without an event', async () => {
    let branch = 'main';
    // Only the interval is faked, so the poll is stepped by hand and everything else runs for real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    openChat({}, () => [], [
      http.get(daemonUrl('/projects/:projectId/folder'), () =>
        HttpResponse.json(folderDto({ projectId: project.id, branch })),
      ),
    ]);
    expect(await screen.findByText('Chat · Your folder · on main')).toBeTruthy();
    branch = 'fix/login';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOLDER_REFRESH_MS);
    });
    expect(await screen.findByText('Chat · Your folder · on fix/login')).toBeTruthy();
  });
});

describe('ChatTab: the composer and Your folder', () => {
  const lane = () =>
    folderDto({
      projectId: project.id,
      holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')],
    });
  const typeAndSend = async (text: string) => {
    const field = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(field, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  };
  const bodies = (served: ReturnType<typeof chatServer>) => served.messages.map((m) => m.body);

  it('sends at once when nothing holds the folder', async () => {
    const { served } = openChat();
    await screen.findByText('Chat · Your folder · on main');
    await typeAndSend('fix the typo');
    await waitFor(() => {
      expect(bodies(served)).toEqual([{ text: 'fix the typo' }]);
    });
  });

  it.each([
    { button: 'Wait for It', folder: 'wait' },
    { button: 'Send Reading Only', folder: 'read_only' },
  ])(
    'asks while a task holds the folder, and $button sends folder $folder',
    async ({ button, folder }) => {
      const { served } = openChat({}, () => [], [
        http.get(daemonUrl('/projects/:projectId/folder'), () => HttpResponse.json(lane())),
      ]);
      await screen.findByText('Chat · reads only: Your folder is in use by the task ‘Bump vite’');
      await typeAndSend('fix the typo');
      expect(
        await screen.findByText('Your folder is in use by the task ‘Bump vite’.'),
      ).toBeTruthy();
      expect(served.messages).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() => {
        expect(bodies(served)).toEqual([{ text: 'fix the typo', folder }]);
      });
    },
  );

  it('Allow This with the folder held puts "Go ahead" in the composer, so it asks before it runs', async () => {
    const { served } = openChat(
      {},
      (chat) => [
        builderItem(chat.conversationId, 'Fetch it'),
        toolItem(
          chat.conversationId,
          commandCall({
            id: 'held',
            title: 'curl example.com',
            command: 'curl example.com',
            status: 'denied',
            deniedBy: 'judge',
            limit: 'sends_data_out',
            soft: true,
            refusal: null,
          }),
        ),
      ],
      [http.get(daemonUrl('/projects/:projectId/folder'), () => HttpResponse.json(lane()))],
    );
    await screen.findByText('Chat · reads only: Your folder is in use by the task ‘Bump vite’');
    fireEvent.click(await screen.findByRole('button', { name: 'Allow This' }));
    const field = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    expect(field.value).toBe('Go ahead: curl example.com');
    expect(served.messages).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Wait for It' }));
    await waitFor(() => {
      expect(bodies(served)).toEqual([{ text: 'Go ahead: curl example.com', folder: 'wait' }]);
    });
  });

  it('shows the waiting row for a message that waits, and Send Now Reading Only runs it', async () => {
    const chat = chatDto({ projectId: project.id });
    const waiting = folderDto({
      projectId: project.id,
      holders: [
        folderHolder(FolderHolderKind.Lane, 'Bump vite'),
        folderHolder(FolderHolderKind.WaitingChat, chat.title, { chatId: chat.id }),
      ],
    });
    const { served } = openChat({ id: chat.id, conversationId: chat.conversationId }, () => [], [
      http.get(daemonUrl('/projects/:projectId/folder'), () => HttpResponse.json(waiting)),
    ]);
    expect(
      await screen.findByText('Waits for Your folder: in use by the task ‘Bump vite’'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send Now Reading Only' }));
    await waitFor(() => {
      expect(served.stoppedWaiting).toEqual([chat.id]);
    });
  });

  describe('a message parked for Your folder with nothing keeping the chat out', () => {
    const parked = (chat: ChatDto) =>
      folderDto({
        projectId: project.id,
        holders: [folderHolder(FolderHolderKind.WaitingChat, chat.title, { chatId: chat.id })],
      });
    const openParked = () => {
      const chat = chatDto({ projectId: project.id });
      const { served } = openChat({ id: chat.id, conversationId: chat.conversationId }, () => [], [
        http.get(daemonUrl('/projects/:projectId/folder'), () => HttpResponse.json(parked(chat))),
      ]);
      return { chat, served };
    };

    it('keeps the waiting row and its Stop', async () => {
      openParked();
      expect(await screen.findByText(/^Waits for Your folder/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    });

    it('shows why Send Now Reading Only failed and keeps the row', async () => {
      const chat = chatDto({ projectId: project.id });
      openChat({ id: chat.id, conversationId: chat.conversationId }, () => [], [
        http.post(daemonUrl('/chats/:chatId/stop-waiting'), () =>
          HttpResponse.json({ error: 'conflict', message: 'The daemon is busy.' }, { status: 409 }),
        ),
        http.get(daemonUrl('/projects/:projectId/folder'), () => HttpResponse.json(parked(chat))),
      ]);
      fireEvent.click(await screen.findByRole('button', { name: 'Send Now Reading Only' }));
      expect(await screen.findByText('The daemon is busy.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      // The next thing the builder types is a new attempt: the old refusal does not stick.
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'again' },
      });
      expect(screen.queryByText('The daemon is busy.')).toBeNull();
    });

    it('sends File as Tasks with wait, so it does not cancel the wait', async () => {
      const { served } = openParked();
      await screen.findByText(/^Waits for Your folder/);
      fireEvent.click(screen.getByRole('button', { name: 'File as Tasks' }));
      await waitFor(() => {
        expect(bodies(served)).toEqual([{ text: FILE_AS_TASKS_MESSAGE, folder: 'wait' }]);
      });
    });
  });
});

describe('ChatTab: the todo list', () => {
  const planItems = (chat: ChatDto) => [
    systemItem(chat.conversationId, {
      kind: 'plan',
      steps: [{ text: 'Old step', status: 'pending' }],
    }),
    systemItem(chat.conversationId, {
      kind: 'plan',
      steps: [
        { text: 'Read the login code', status: 'completed' },
        { text: 'Write the fix', status: 'in_progress' },
        { text: 'Run the tests', status: 'pending' },
      ],
    }),
  ];

  it('shows the latest list open while a turn runs, with the step it is on', async () => {
    openChat({ conversation: { state: 'running' } }, planItems);
    expect(await screen.findByText('Plan · 1 of 3 done · Now: Write the fix')).toBeTruthy();
    expect(screen.getByLabelText('Read the login code, completed')).toBeTruthy();
    expect(screen.getByLabelText('Write the fix, in progress')).toBeTruthy();
    expect(screen.getByLabelText('Run the tests, pending')).toBeTruthy();
    expect(screen.queryByText('Old step')).toBeNull();
  });

  it('shows a list the turn left unfinished as interrupted, not in progress', async () => {
    openChat({}, planItems);
    expect(await screen.findByText('Plan · 1 of 3 done')).toBeTruthy();
    expect(screen.getByLabelText('Write the fix, interrupted')).toBeTruthy();
    expect(screen.queryByLabelText('Write the fix, in progress')).toBeNull();
  });

  it('keeps a finished list folded to its heading', async () => {
    openChat({}, (chat) => [
      systemItem(chat.conversationId, {
        kind: 'plan',
        steps: [{ text: 'Ship it', status: 'completed' }],
      }),
    ]);
    const heading = await screen.findByText('Plan · 1 of 1 done');
    expect(heading.closest('button')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('draws no list for an agent without a plan', async () => {
    openChat({ conversation: { capabilities: { ...CLAUDE, plan: false } } }, planItems);
    await screen.findByText('Claude Code');
    expect(document.querySelector('[data-todo-list]')).toBeNull();
  });
});

describe('ChatTab: background tasks', () => {
  it('lists what the session runs in the background', async () => {
    openChat({
      conversation: {
        backgroundTasks: [
          { id: 'a', description: 'npm run build', kind: 'shell', agent: null },
          { id: 'b', description: 'Find the failing test', kind: 'agent', agent: 'Explore' },
          { id: 'c', description: 'tail the server log', kind: 'monitor', agent: null },
        ],
      },
    });
    expect(await screen.findByText('Running in the background · 3')).toBeTruthy();
    expect(screen.getByText('npm run build')).toBeTruthy();
    expect(screen.getByText('Command')).toBeTruthy();
    expect(screen.getByText('Subagent · Explore')).toBeTruthy();
    expect(screen.getByText('Find the failing test')).toBeTruthy();
    expect(screen.getByText('Monitor')).toBeTruthy();
  });

  it('draws no panel for an agent that reports tasks and has none running', async () => {
    openChat();
    await screen.findByText('Claude Code');
    expect(document.querySelector('[data-background-tasks]')).toBeNull();
  });

  it('says what an agent that reports no background tasks lacks', async () => {
    openChat({
      conversation: { capabilities: { ...CLAUDE, backgroundTasks: false, label: 'Codex' } },
    });
    expect(await screen.findByText('Codex doesn’t report background tasks.')).toBeTruthy();
  });
});

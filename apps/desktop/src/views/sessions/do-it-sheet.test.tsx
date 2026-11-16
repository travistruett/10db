import { FolderHolderKind, type ChatDto, type DoItPreviewDto } from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { CLAUDE_CAPABILITIES } from '../../test/conversation-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { doItBriefDto, doItPreviewDto, doItServer } from '../../test/do-it-fixtures';
import { folderDto, folderHolder } from '../../test/folder-fixtures';
import { projectViewDto } from '../../test/fixtures';

// The Do It sheet over the daemon's preview: what it says before the builder presses it, and what it sends.

const project = projectViewDto({ name: 'ampsio', delivery: 'pull_request', baseBranch: 'main' });
const CLAUDE = { ...CLAUDE_CAPABILITIES, label: 'Claude Code' };

afterEach(() => {
  localStorage.clear();
});

interface Opened {
  readonly chat: ChatDto;
  readonly doIt: ReturnType<typeof doItServer>;
  readonly queryClient: ReturnType<typeof renderApp>['queryClient'];
}

function openChat(
  preview: Parameters<typeof doItServer>[0]['preview'],
  extra: {
    readonly chat?: Parameters<typeof chatDto>[0];
    readonly project?: typeof project;
    readonly handlers?: Parameters<typeof server.use>;
    readonly refusal?: string;
  } = {},
): Opened {
  const chat = chatDto({
    projectId: project.id,
    ...extra.chat,
    conversation: { capabilities: CLAUDE, model: 'claude-opus-5', ...extra.chat?.conversation },
  });
  const served = chatServer({ chats: [chat] });
  const doIt = doItServer({
    preview,
    ...(extra.refusal === undefined ? {} : { refusal: extra.refusal }),
  });
  server.use(
    ...(extra.handlers ?? []),
    ...doIt.handlers,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([extra.project ?? project])),
    ...served.handlers,
    ...baseHandlers(),
  );
  const { queryClient } = renderApp(`/sessions?chat=${chat.id}`);
  return { chat, doIt, queryClient };
}

const openSheet = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Do It…' }));
  return screen.findByRole('dialog', { name: 'Do It' });
};

describe('the Do It sheet', () => {
  it('opens on Separate copy with the agent’s brief, its lines, and the chat’s fate', async () => {
    const { doIt } = openChat(
      doItPreviewDto({ leftOut: { branch: 'feature', count: 2 }, runningTurn: true }),
    );
    const sheet = await openSheet();
    expect(await within(sheet).findByDisplayValue('Retry login once on a 401')).toBeTruthy();
    expect(within(sheet).getByRole('textbox', { name: 'Brief' })).toHaveProperty(
      'value',
      'When the laptop wakes, the first API call returns 401. Retry once after a refresh.',
    );
    expect(within(sheet).getByText(/Brief · written by Claude Code from this chat/)).toBeTruthy();
    expect(
      within(sheet).getByText(/An ordinary task in its own copy, on a new branch/),
    ).toBeTruthy();
    expect(within(sheet).getByText(/It lands by ampsio's delivery/)).toBeTruthy();
    expect(sheet.textContent).toContain(
      'Starts from main. The 2 commits on feature that main lack stay out of it.',
    );
    expect(within(sheet).getByText("The turn that's running stops first.")).toBeTruthy();
    expect(
      within(sheet).getByText("The task takes this chat's place. The chat becomes read-only."),
    ).toBeTruthy();
    expect(within(sheet).getByText('Claude Code · claude-opus-5')).toBeTruthy();
    expect(doIt.briefAsks).toEqual([{}]);
  });

  it('lists the uncommitted files with their fate, and folds past five behind Show N More', async () => {
    const changed = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'].map((path, i) => ({
      path,
      status: i === 6 ? ('?' as const) : ('M' as const),
    }));
    openChat(doItPreviewDto({ changed }));
    const sheet = await openSheet();
    expect(await within(sheet).findByText('7 files already changed in your folder:')).toBeTruthy();
    expect(within(sheet).getByText('M e.ts')).toBeTruthy();
    expect(within(sheet).queryByText('M f.ts')).toBeNull();
    expect(
      within(sheet).getByText('These stay in your folder. The task starts without them.'),
    ).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 2 More' }));
    expect(within(sheet).getByText('? g.ts')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('radio', { name: /Your folder, as a pass/ }));
    expect(within(sheet).getByText("These will be part of this task's work.")).toBeTruthy();
  });

  it('says how a pass of one lands, and that it stacks on a closed pass', async () => {
    openChat(doItPreviewDto({ stacksOn: 'Settings pass' }));
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('radio', { name: /Your folder, as a pass/ }));
    expect(sheet.textContent).toContain(
      "A pass of one on its own branch from main. Sign Off lands each turn's work; Close Pass… opens one pull request, and main fast-forwards to it when it merges. Your folder is held until then.",
    );
    expect(within(sheet).getByText(/waits on the pass ‘Settings pass’/)).toBeTruthy();
    expect(
      within(sheet).getByText(
        'The pass opens in its own tab. This chat stays open, and changes nothing while the pass holds your folder.',
      ),
    ).toBeTruthy();
  });

  it('a refused Your folder stays in the list, disabled, with its reason and a link', async () => {
    openChat(
      doItPreviewDto({
        here: {
          offered: false,
          refusal: {
            code: 'pass',
            message: 'Your folder is in use by the UI Workbench pass ‘Settings pass’.',
            link: `workbench:${project.id}`,
          },
          whenBusy: false,
        },
      }),
    );
    const sheet = await openSheet();
    expect(
      await within(sheet).findByText(
        'Your folder is in use by the UI Workbench pass ‘Settings pass’.',
      ),
    ).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Open UI Workbench' })).toBeTruthy();
    const here = within(sheet).getByRole('radio', { name: /Your folder, as a pass/ });
    expect(here).toHaveProperty('disabled', true);
    expect(within(sheet).getByRole('radio', { name: 'Separate copy' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('a refusal that names a chat offers Open Session, which opens that chat’s tab', async () => {
    const other = chatDto({
      projectId: project.id,
      title: 'Docs',
      tabPosition: 1,
      conversation: { capabilities: CLAUDE },
    });
    const chat = chatDto({
      projectId: project.id,
      tabPosition: 0,
      conversation: { capabilities: CLAUDE, model: 'claude-opus-5' },
    });
    const served = chatServer({ chats: [chat, other] });
    const doIt = doItServer({
      preview: doItPreviewDto({
        here: {
          offered: false,
          refusal: {
            code: 'folder_in_use',
            message: 'Your folder is in use by the chat ‘Docs’.',
            link: `session:${other.id}`,
          },
          whenBusy: false,
        },
      }),
    });
    server.use(
      ...doIt.handlers,
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...served.handlers,
      ...baseHandlers(),
    );
    renderApp(`/sessions?chat=${chat.id}`);
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Open Session' }));
    expect((await screen.findByRole('tab', { name: /Docs/ })).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('on a project with no separate copies, Your folder is the one picked and the reason is said', async () => {
    openChat(
      doItPreviewDto({
        worktree: {
          offered: false,
          refusal: {
            code: 'local',
            message:
              'This project lands locally, so it has no separate copies. Do It goes to Your folder.',
            link: null,
          },
          whenBusy: false,
        },
        base: null,
      }),
    );
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/has no separate copies/)).toBeTruthy();
    expect(within(sheet).getByRole('radio', { name: /Your folder, as a pass/ })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('keeps the place the builder picked when it stops being offered, and Do It stays off', async () => {
    let here: DoItPreviewDto['here'] = { offered: true, refusal: null, whenBusy: false };
    const { queryClient, doIt } = openChat(() => doItPreviewDto({ here }));
    const sheet = await openSheet();
    await within(sheet).findByDisplayValue('Retry login once on a 401');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Your folder, as a pass/ }));
    here = {
      offered: false,
      refusal: { code: 'pass', message: 'Your folder is in use by a pass.', link: null },
      whenBusy: false,
    };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
    });
    expect(await within(sheet).findByText('Your folder is in use by a pass.')).toBeTruthy();
    expect(within(sheet).getByRole('radio', { name: /Your folder, as a pass/ })).toHaveProperty(
      'checked',
      true,
    );
    const button = within(sheet).getByRole('button', { name: 'Do It' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.keyDown(within(sheet).getByRole('textbox', { name: 'Title' }), {
      key: 'Enter',
      metaKey: true,
    });
    expect(doIt.requests).toEqual([]);
  });

  it.each([
    {
      name: 'mid-turn',
      brief: doItBriefDto({ source: 'chat', reason: 'mid_turn' }),
      line: 'The chat is mid-turn, so this brief is the chat so far.',
    },
    {
      name: 'a brief that was too late',
      brief: doItBriefDto({ source: 'chat', reason: 'timeout' }),
      line: /didn't write a brief in time/,
    },
  ])('says why the brief is the chat’s: $name', async ({ brief, line }) => {
    openChat(doItPreviewDto({ brief }));
    const sheet = await openSheet();
    expect(await within(sheet).findByText(line)).toBeTruthy();
  });

  it('shows Writing the brief… until it fills, and a late brief never replaces typed text', async () => {
    let brief = doItBriefDto({ title: '', text: '', source: null, writing: true });
    const { queryClient } = openChat(() => doItPreviewDto({ brief }));
    const sheet = await openSheet();
    expect(await within(sheet).findByText('Writing the brief…')).toBeTruthy();
    const field = within(sheet).getByRole('textbox', { name: 'Brief' });
    fireEvent.change(field, { target: { value: 'My own words' } });
    brief = doItBriefDto({ title: 'Agent title', text: 'The agent’s words' });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
    });
    expect(await within(sheet).findByDisplayValue('Agent title')).toBeTruthy();
    expect(within(sheet).getByRole('textbox', { name: 'Brief' })).toHaveProperty(
      'value',
      'My own words',
    );
  });

  it('Cancel drops a brief still being written', async () => {
    const { doIt, chat } = openChat(
      doItPreviewDto({ brief: doItBriefDto({ title: '', text: '', source: null, writing: true }) }),
    );
    const sheet = await openSheet();
    await within(sheet).findByText('Writing the brief…');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(doIt.briefCancels).toEqual([chat.id]);
    });
    expect(screen.queryByRole('dialog', { name: 'Do It' })).toBeNull();
  });

  it('is off until the brief has text', async () => {
    openChat(
      doItPreviewDto({ brief: doItBriefDto({ title: '', text: '', source: null, writing: true }) }),
    );
    const sheet = await openSheet();
    await within(sheet).findByText('Writing the brief…');
    expect(within(sheet).getByRole('button', { name: 'Do It' })).toHaveProperty('disabled', true);
  });

  it('⌘↩ submits the place, the edited title and brief, and the brief’s areas and criteria', async () => {
    const { doIt } = openChat(
      doItPreviewDto({
        brief: doItBriefDto({ areas: ['api'], criteria: ['Retries once'] }),
      }),
    );
    const sheet = await openSheet();
    const title = await within(sheet).findByRole('textbox', { name: 'Title' });
    await waitFor(() => {
      expect(title).toHaveProperty('value', 'Retry login once on a 401');
    });
    fireEvent.change(title, { target: { value: 'Retry login' } });
    fireEvent.keyDown(title, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(doIt.requests).toHaveLength(1);
    });
    expect(doIt.requests[0]).toEqual({
      place: 'worktree',
      title: 'Retry login',
      brief: 'When the laptop wakes, the first API call returns 401. Retry once after a refresh.',
      areas: ['api'],
      acceptanceCriteria: ['Retries once'],
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Do It' })).toBeNull();
    });
  });

  it('⌘⇧↩ in the sheet does not submit', async () => {
    const { doIt } = openChat(doItPreviewDto());
    const sheet = await openSheet();
    const title = await within(sheet).findByDisplayValue('Retry login once on a 401');
    fireEvent.keyDown(title, { key: 'Enter', metaKey: true, shiftKey: true });
    // A submit puts the sheet in its pending state at once, which turns Cancel off.
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', false);
    expect(doIt.requests).toEqual([]);
  });

  it.each([
    { name: 'the preview can’t be read', method: 'get', path: '/chats/:chatId/do-it' },
    { name: 'the brief can’t be asked for', method: 'post', path: '/chats/:chatId/brief' },
  ] as const)('says so when $name, instead of staying blank', async ({ method, path }) => {
    openChat(doItPreviewDto(), {
      handlers: [
        http[method](daemonUrl(path), () =>
          HttpResponse.json({ error: 'internal', message: 'The daemon is down.' }, { status: 500 }),
        ),
      ],
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByText('The daemon is down.')).toBeTruthy();
  });

  it('a refusal at submit is said beside Do It, and the sheet keeps the brief', async () => {
    openChat(doItPreviewDto(), { refusal: 'Your folder changed since the sheet opened.' });
    const sheet = await openSheet();
    await within(sheet).findByDisplayValue('Retry login once on a 401');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Do It' }));
    expect(
      await within(sheet).findByText('Your folder changed since the sheet opened.'),
    ).toBeTruthy();
    expect(within(sheet).getByRole('textbox', { name: 'Brief' })).toHaveProperty(
      'value',
      'When the laptop wakes, the first API call returns 401. Retry once after a refresh.',
    );
  });

  it('Do It… is off with Hand back first while the chat is in the terminal', async () => {
    openChat(doItPreviewDto(), { chat: { conversation: { state: 'taken_over' } } });
    const button = await screen.findByRole('button', { name: 'Do It…' });
    expect(button).toHaveProperty('disabled', true);
  });

  it('a sealed chat has no Do It…', async () => {
    openChat(doItPreviewDto(), { chat: { conversation: { state: 'sealed' } } });
    await screen.findByText('Claude Code');
    expect(screen.queryByRole('button', { name: 'Do It…' })).toBeNull();
  });

  it('⌘⇧↩ opens the sheet', async () => {
    openChat(doItPreviewDto());
    await screen.findByRole('button', { name: 'Do It…' });
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(await screen.findByRole('dialog', { name: 'Do It' })).toBeTruthy();
  });

  it('File as Tasks stays in the split button’s menu', async () => {
    openChat(doItPreviewDto());
    fireEvent.click(await screen.findByRole('button', { name: 'More ways to hand off' }));
    expect(await screen.findByRole('menuitem', { name: 'File as Tasks' })).toBeTruthy();
  });
});

describe('Do It Here when only chats’ turns hold the folder', () => {
  const busy = {
    offered: false,
    refusal: {
      code: 'folder_in_use',
      message: 'Your folder is in use by the chat ‘Docs’.',
      link: null,
    },
    whenBusy: true,
  };

  it.each([
    { button: 'Stop the Turn and Open', whenBusy: 'stop_turns' },
    { button: 'Open When It Ends', whenBusy: 'wait' },
  ])('$button sends whenBusy $whenBusy', async ({ button, whenBusy }) => {
    const { doIt } = openChat(doItPreviewDto({ here: busy }), {
      chat: { conversation: { state: 'idle_warm' } },
    });
    const sheet = await openSheet();
    await within(sheet).findByDisplayValue('Retry login once on a 401');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Your folder, as a pass/ }));
    expect(within(sheet).queryByRole('button', { name: 'Do It' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: button }));
    await waitFor(() => {
      expect(doIt.requests.map((r) => [r.place, r.whenBusy])).toEqual([['here', whenBusy]]);
    });
  });
});

describe('the fourth choice', () => {
  it('is not offered on a project that lands locally, which has no separate copies', async () => {
    openChat(doItPreviewDto(), {
      project: projectViewDto({ id: project.id, name: 'ampsio', delivery: 'local' }),
      handlers: [
        http.get(daemonUrl('/projects/:projectId/folder'), () =>
          HttpResponse.json(
            folderDto({ holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')] }),
          ),
        ),
      ],
    });
    const field = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(field, { target: { value: 'knock out the retry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Send Reading Only' });
    expect(screen.queryByRole('button', { name: 'Do It in a Separate Copy' })).toBeNull();
  });

  it('a message sent while the folder is held offers Do It in a Separate Copy, which opens the sheet with the draft', async () => {
    const { doIt } = openChat(doItPreviewDto(), {
      handlers: [
        http.get(daemonUrl('/projects/:projectId/folder'), () =>
          HttpResponse.json(
            folderDto({ holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')] }),
          ),
        ),
      ],
    });
    const field = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(field, { target: { value: 'knock out the retry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Do It in a Separate Copy' }));
    const sheet = await screen.findByRole('dialog', { name: 'Do It' });
    expect(within(sheet).getByRole('radio', { name: 'Separate copy' })).toHaveProperty(
      'checked',
      true,
    );
    await waitFor(() => {
      expect(doIt.briefAsks).toEqual([{ draft: 'knock out the retry' }]);
    });
  });
});

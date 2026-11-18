import {
  mintId,
  PARK_TASK_OPTION,
  PASS_SIGN_OFF_CHOICE,
  SHARED_ASK_ALLOW_CHOICE,
  SHARED_ASK_KEEP_CHOICE,
  SHARED_ASK_REPLY_CHOICE,
  SystemCheckDto,
  type InboxItemDto,
  type ProvenanceDto,
} from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastInboxSearch, rememberScroll, rememberSelected } from './inbox-search';
import { queryKeys } from '../../daemon/queries';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { batchDto, daemonEvent, inboxItemDto, projectViewDto } from '../../test/fixtures';
import { chatDto } from '../../test/chat-fixtures';
import { resetViewportWidth, viewportWidth } from '../../test/window-width';
import {
  findText,
  getText,
  chooseFilter,
  findPanelRow,
  panelRows,
  panelRowTexts,
  queryText,
  serveInboxRows,
} from '../../test/inbox-page-fixtures';
import { sendDto, slackConnection } from '../../test/people-fixtures';
import { knowledgeList, proposalDto, provenanceDto } from '../../test/knowledge-fixtures';

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  server.use(...overrides);
}

/**
 * Serves `items` as the open inbox, for the panel's rows and every other reader, and records every answer
 * posted. An answered card leaves what is served, as it does in the daemon.
 */
function inbox(
  items: InboxItemDto[],
  hold?: Parameters<typeof serveInboxRows>[1],
): {
  answers: { id: string; body: unknown }[];
  served: { open: InboxItemDto[] };
} {
  const answers: { id: string; body: unknown }[] = [];
  const served = { open: [...items] };
  serve(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(served.open)),
    http.get(daemonUrl('/inbox/:id/context'), () => HttpResponse.json({ messages: [] })),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      const id = String(params['id']);
      answers.push({ id, body: await request.json() });
      const item = served.open.find((i) => i.id === id);
      served.open = served.open.filter((i) => i.id !== id);
      return HttpResponse.json({ ...item, state: 'ANSWERED' });
    }),
  );
  serveInboxRows(served, hold);
  return { answers, served };
}

/** The panel's rows. */
const rows = (): HTMLElement[] =>
  within(screen.getByRole('listbox', { name: 'Inbox' })).queryAllByRole('option');
/** The row whose text holds `title`. */
function rowOf(title: string): HTMLElement {
  const row = rows().find((candidate) => candidate.textContent.includes(title));
  if (row === undefined) throw new Error(`no row holds ${title}`);
  return row;
}
const findRow = (title: string): Promise<HTMLElement> => waitFor(() => rowOf(title));

const key = (k: string, init: { shiftKey?: boolean } = {}): void => {
  fireEvent.keyDown(document.body, { key: k, ...init });
};

/** The option groups of the cards. */
function optionGroups(): HTMLElement[] {
  return screen
    .getAllByRole('radiogroup')
    .filter((group) => group.closest('[aria-label="Inbox panel"]') === null);
}

/** The expanded card. */
function selectedCard(): HTMLElement {
  const card = document.querySelector('[data-inbox-selected]');
  if (!(card instanceof HTMLElement)) throw new Error('no card is expanded');
  return card;
}

const project = mintId('Project');
const flag = (title: string, body: string): InboxItemDto =>
  inboxItemDto({ kind: 'flag', title, body, options: [], projectId: project });

const color = inboxItemDto({
  kind: 'question',
  title: 'Which badge color?',
  body: 'Color',
  options: [
    { label: 'Teal', description: 'Matches the theme' },
    { label: 'Red', description: 'Stands out' },
  ],
});
const corners = inboxItemDto({
  kind: 'question',
  title: 'Round or square corners?',
  body: '',
  options: [
    { label: 'Round', description: '' },
    { label: 'Square', description: '' },
  ],
});

const FULL_REVIEW =
  '1. BLOCKING apps/daemon/src/runner/runner.ts:673 the card hides the findings.\n   Trigger: the retry limit.\n2. NOTE the empty state has no test.';
const rejectedCard = inboxItemDto({
  kind: 'flag',
  title: 'Workstream failed: Track each shipped pull request',
  body: 'The review step rejected the work and the retry limit (3) is used up',
  options: [
    { label: 'Retry', description: 'Run this workstream again in its batch' },
    { label: 'Ship anyway', description: 'Ship the batch without it' },
    { label: 'Later', description: 'Decide later' },
  ],
  detail: {
    reviewRejection: {
      role: 'review',
      personaName: 'Reviewer',
      at: '2026-10-29T12:00:00.000Z',
      findings: [
        {
          severity: 'BLOCKING',
          location: 'apps/daemon/src/runner/runner.ts:673',
          text: 'BLOCKING apps/daemon/src/runner/runner.ts:673 the card hides the findings.',
        },
        { severity: 'NOTE', location: null, text: 'NOTE the empty state has no test.' },
      ],
      summary: FULL_REVIEW,
    },
  },
});

// What the Inbox remembers of a visit (its search, each state's row and scroll) outlives a render, so one
// test's selection would otherwise open the next test on a row its list may not hold.
beforeEach(() => {
  lastInboxSearch.set({});
  for (const state of ['open', 'waiting', 'resolved'] as const) {
    rememberSelected(state, null);
    rememberScroll(state, 0);
  }
});

describe('InboxView review findings', () => {
  it('shows each finding with its severity and file:line on a failed card', async () => {
    inbox([rejectedCard]);
    renderApp('/inbox');
    await findText(rejectedCard.title);
    const card = selectedCard();
    expect(within(card).getByText('BLOCKING')).toBeTruthy();
    expect(within(card).getByText('apps/daemon/src/runner/runner.ts:673')).toBeTruthy();
    expect(within(card).getByText('NOTE')).toBeTruthy();
  });

  it('keeps the full review one click away', async () => {
    inbox([rejectedCard]);
    renderApp('/inbox');
    await findText(rejectedCard.title);
    const card = selectedCard();
    expect(within(card).queryByText(/Trigger: the retry limit\./)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Show the full review' }));
    expect(
      within(card).getByText((text) => text.includes('Trigger: the retry limit.')),
    ).toBeTruthy();
  });

  it('sends the note with Retry', async () => {
    const { answers } = inbox([rejectedCard]);
    renderApp('/inbox');
    await findText(rejectedCard.title);
    const card = selectedCard();
    fireEvent.click(within(card).getByRole('radio', { name: /Retry/ }));
    fireEvent.change(within(card).getByLabelText('Note for the agent (optional)'), {
      target: { value: 'Reuse the card component.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: /Send answer/ }));
    await waitFor(() => {
      expect(answers).toEqual([
        { id: rejectedCard.id, body: { choice: 'Retry', note: 'Reuse the card component.' } },
      ]);
    });
  });
});

describe('InboxView', () => {
  it('says so when the inbox is empty', async () => {
    inbox([]);
    renderApp('/inbox');
    expect(await findText('Nothing needs you')).toBeTruthy();
  });

  it('moves with j/k, chooses with a digit and sends with Enter', async () => {
    const { answers } = inbox([color, corners]);
    renderApp('/inbox');
    expect(await findText('Which badge color?')).toBeTruthy();

    key('j');
    expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
    key('k');
    const red = await screen.findByRole('radio', { name: /Red/ });
    key('2');
    await waitFor(() => {
      expect(red.getAttribute('aria-checked')).toBe('true');
    });
    key('Enter');

    await waitFor(() => {
      expect(answers).toEqual([{ id: color.id, body: { choice: 'Red', record: null } }]);
    });
    expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
  });

  it('focuses the note with n and sends it with ⌘Enter', async () => {
    const { answers } = inbox([color]);
    renderApp('/inbox');
    await findText('Which badge color?');

    key('1');
    key('n');
    const note = screen.getByLabelText('Note for the agent (optional)');
    await waitFor(() => {
      expect(document.activeElement).toBe(note);
    });
    if (!(note instanceof HTMLTextAreaElement)) throw new Error('the note is not a textarea');
    expect(note.value).toBe('');
    fireEvent.change(note, { target: { value: 'Teal matches the logo' } });
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(answers).toEqual([
        { id: color.id, body: { choice: 'Teal', note: 'Teal matches the logo', record: null } },
      ]);
    });
  });

  it('asks for a choice before sending', async () => {
    const { answers } = inbox([color]);
    renderApp('/inbox');
    await findText('Which badge color?');
    key('Enter');
    expect(await findText('Choose an option first (1–5).')).toBeTruthy();
    expect(answers).toEqual([]);
  });

  it('a limit card reads Allow once, Always in this project and Deny', async () => {
    const permission = inboxItemDto({
      kind: 'permission',
      title: 'Allow this? It may write to a live system',
      body: 'vercel deploy --prod',
      category: 'access',
      options: [
        { label: 'allow_once', description: 'Allow this call once' },
        {
          label: 'always_in_project',
          description: 'Allow calls like this in this project from now on.',
        },
        { label: 'deny', description: 'Deny; your note is passed to the agent' },
      ],
    });
    inbox([permission]);
    renderApp('/inbox');
    expect(await findText('vercel deploy --prod')).toBeTruthy();
    for (const name of ['Allow once', 'Always in this project', 'Deny']) {
      expect(screen.getByRole('radio', { name: new RegExp(`^\\d?\\s*${name}`) })).toBeTruthy();
    }
    expect(queryText('always_in_project')).toBeNull();
  });

  it('shows the four permission choices in words and sends the chosen value', async () => {
    const permission = inboxItemDto({
      kind: 'permission',
      title: 'Allow Bash?',
      body: 'curl -s https://example.com',
      category: 'access',
      options: [
        { label: 'allow_once', description: 'Allow this call once' },
        { label: 'allow_workstream', description: 'Allow for the rest of this workstream' },
        {
          label: 'allow_project',
          description: 'Always allow in this project (records a decision)',
        },
        { label: 'deny', description: 'Deny; your note is passed to the agent' },
      ],
    });
    const { answers } = inbox([permission]);
    renderApp('/inbox');

    expect(await findText('curl -s https://example.com')).toBeTruthy();
    for (const name of [
      'Allow once',
      'Allow for this workstream',
      'Always allow in this project',
      'Deny',
    ]) {
      expect(screen.getByRole('radio', { name: new RegExp(`^\\d?\\s*${name}`) })).toBeTruthy();
    }
    expect(getText('Always allow in this project (records a decision)')).toBeTruthy();
    expect(queryText('allow_workstream')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Allow for this workstream/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: permission.id, body: { choice: 'allow_workstream' } }]);
    });
  });

  it('names the server on the project MCP tool card’s extra choice and sends its value', async () => {
    const GRANT = {
      name: 'aws-billing',
      configHash: 'a'.repeat(64),
      tools: ['mcp__aws-billing__credits'],
    };
    const permission = inboxItemDto({
      kind: 'permission',
      title: 'Allow mcp__aws-billing__credits?',
      body: '{}',
      category: 'access',
      options: [
        { label: 'allow_once', description: 'Allow this call once' },
        { label: 'allow_project', description: 'Always allow in this project' },
        { label: 'allow_mcp_server', description: 'Always allow every aws-billing tool' },
        { label: 'deny', description: 'Deny' },
      ],
      detail: { toolName: 'mcp__aws-billing__credits', summary: '{}', mcpToolGrant: GRANT },
    });
    const { answers } = inbox([permission]);
    renderApp('/inbox');
    await findText('Allow mcp__aws-billing__credits?');
    fireEvent.click(
      screen.getByRole('radio', { name: /Always allow every aws-billing tool in this project/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: permission.id, body: { choice: 'allow_mcp_server' } }]);
    });
  });

  it('renders markup in a card as literal text', async () => {
    const hostile = inboxItemDto({
      kind: 'question',
      title: '<b>Bold</b> question',
      body: '<img src=x onerror=alert(1)>',
      options: [
        { label: '<script>x</script>', description: '<i>desc</i>' },
        { label: 'Plain', description: '' },
      ],
    });
    inbox([hostile]);
    renderApp('/inbox');

    expect(await findText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(getText('<b>Bold</b> question')).toBeTruthy();
    expect(getText('<script>x</script>')).toBeTruthy();
    expect(getText('<i>desc</i>')).toBeTruthy();
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('main b, main i, main script')).toBeNull();
  });

  it('dismisses a flag card, which has no options', async () => {
    const flag = inboxItemDto({
      kind: 'flag',
      title: 'Write outside every claim',
      body: 'docs/notes.md',
      options: [],
    });
    const { answers } = inbox([flag]);
    renderApp('/inbox');

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: flag.id, body: { choice: 'dismissed' } }]);
    });
  });

  it.each([
    {
      name: 'links a flag card to the failing check on GitHub',
      link: 'https://github.com/acme/widgets/actions/runs/1',
      shown: true,
    },
    { name: 'offers no link when the detail has none', link: undefined, shown: false },
    { name: 'offers no link that is not https', link: 'javascript:alert(1)', shown: false },
    {
      name: 'offers no button for a check off github.com, which the app cannot open',
      link: 'https://ci.example.com/job/1',
      shown: false,
    },
    {
      name: 'offers no button for a host that only starts like github.com',
      link: 'https://github.com.example.net/acme/widgets',
      shown: false,
    },
  ])('$name', async ({ link, shown }) => {
    const card = inboxItemDto({
      kind: 'flag',
      title: 'Pull request checks failed for "Alpha": build',
      body: 'https://github.com/acme/widgets/actions/runs/1\n\nFailing:\n- build',
      options: [],
      detail: link === undefined ? { batchId: 'bat_x' } : { batchId: 'bat_x', link },
    });
    inbox([card]);
    renderApp('/inbox');

    fireEvent.click(await findText(card.title));
    await findText('Failing:', { exact: false });
    const anchor = screen.queryByRole('link', { name: 'Open on GitHub' });
    if (shown) expect(anchor?.getAttribute('href')).toBe(link);
    else expect(anchor).toBeNull();
  });

  it.each([
    {
      name: 'links a card that says an account has no usable model to Settings › Accounts',
      problem: 'no_usable_model',
      shown: true,
    },
    { name: 'offers no such link on another account card', problem: 'signed_out', shown: false },
  ])('$name', async ({ problem, shown }) => {
    const card = inboxItemDto({
      kind: 'flag',
      title: 'Claude plan: sessions refused',
      body: 'Choose a model for each tier under Settings › Accounts › Claude plan.',
      options: [],
      detail: {
        accountCard: {
          accountId: mintId('Account'),
          reason: 'refused',
          problem,
          seenIdentity: null,
        },
      },
    });
    inbox([card]);
    renderApp('/inbox');

    fireEvent.click(await findText(card.title));
    await findText('Choose a model for each tier', { exact: false });
    const anchor = screen.queryByRole('link', { name: 'Open Accounts in Settings' });
    if (shown) expect(anchor?.getAttribute('href')).toBe('/settings/accounts');
    else expect(anchor).toBeNull();
  });

  it.each([
    {
      name: 'links a card that says to sign in to GitHub to Settings › Integrations',
      detail: { batchId: 'bat_x', openIntegrations: 'github' },
      href: '/settings/integrations?focus=github',
    },
    { name: 'offers no such link on a card without it', detail: { batchId: 'bat_x' }, href: null },
    {
      name: 'ignores a focus name that is not a name',
      detail: { batchId: 'bat_x', openIntegrations: 7 },
      href: null,
    },
  ])('$name', async ({ detail, href }) => {
    const card = inboxItemDto({
      kind: 'flag',
      title: 'Batch not started: gh is signed out',
      body: 'Sign in to GitHub in Settings › Integrations. Then start again.',
      options: [],
      detail,
    });
    inbox([card]);
    renderApp('/inbox');

    fireEvent.click(await findText(card.title));
    await findText('Sign in to GitHub in Settings', { exact: false });
    const anchor = screen.queryByRole('link', { name: 'Open Integrations' });
    if (href === null) expect(anchor).toBeNull();
    else expect(anchor?.getAttribute('href')).toBe(href);
  });

  it.each([
    {
      name: 'links a gate card to its failing step log',
      logPath: '/wt/.gate/test.log',
      shown: true,
    },
    {
      name: 'offers no log link for a path that is not absolute',
      logPath: '../x.log',
      shown: false,
    },
  ])('$name', async ({ logPath, shown }) => {
    const card = inboxItemDto({
      kind: 'flag',
      title: 'Batch "Alpha" not shipped: the gate failed (exit 1) in test',
      body: 'Failed steps:\n- test: pnpm test',
      options: [],
      detail: { batchId: 'bat_x', logPath },
    });
    inbox([card]);
    renderApp('/inbox');

    fireEvent.click(await findText(card.title));
    await findText('Failed steps:', { exact: false });
    const anchor = screen.queryByRole('link', { name: 'Open the step log' });
    if (shown) {
      expect(anchor?.getAttribute('href')).toBe(`file://${logPath}`);
      expect(anchor?.getAttribute('title')).toBe(logPath);
    } else expect(anchor).toBeNull();
  });

  it.each([
    { button: 'Retry', route: 'ship' },
    { button: 'Abandon', route: 'abandon' },
  ])(
    "$button on a gate card that offers it acts on the card's batch, then dismisses the card",
    async ({ button, route }) => {
      const batch = batchDto();
      const card = inboxItemDto({
        kind: 'flag',
        title:
          'Batch "Alpha" not shipped: the gate failed twice, in tests the batch didn\'t change',
        body: "This failure looks unrelated to the batch's work.",
        options: [],
        detail: { batchId: batch.id, actions: ['retry', 'abandon'] },
      });
      const { answers } = inbox([card]);
      const posted: string[] = [];
      server.use(
        http.post(daemonUrl(`/batches/:batchId/${route}`), ({ params }) => {
          posted.push(String(params['batchId']));
          return HttpResponse.json(batch);
        }),
      );
      renderApp('/inbox');

      fireEvent.click(await findText(card.title));
      fireEvent.click(await screen.findByRole('button', { name: button }));
      await waitFor(() => {
        expect(answers).toEqual([{ id: card.id, body: { choice: 'dismissed' } }]);
      });
      expect(posted).toEqual([batch.id]);
    },
  );

  it('offers no Retry or Abandon on a card that does not ask for them', async () => {
    const card = flag('Batch "Alpha" not shipped: the gate failed (exit 1)', 'Last output:');
    inbox([card]);
    renderApp('/inbox');
    fireEvent.click(await findText(card.title));
    await findText('Last output:');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abandon' })).toBeNull();
  });

  it('explains a card answered elsewhere, and its row leaves and the next is selected', async () => {
    const font = inboxItemDto({
      kind: 'question',
      title: 'Which font?',
      body: '',
      options: [
        { label: 'Serif', description: '' },
        { label: 'Sans', description: '' },
      ],
    });
    const { served } = inbox([color, corners, font]);
    server.use(
      http.post(daemonUrl('/inbox/:id/answer'), () => {
        // Answered elsewhere: the card is gone from the daemon's list by the time the answer lands.
        served.open = served.open.filter((item) => item.id !== color.id);
        return HttpResponse.json(
          { error: 'conflict', message: `Inbox item ${color.id} is already ANSWERED` },
          { status: 409 },
        );
      }),
    );
    renderApp('/inbox');
    await findText('Which badge color?');

    key('1');
    key('Enter');
    expect(await findText('This card was already answered.')).toBeTruthy();
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    expect(selectedCard().textContent).toContain('Round or square corners?');
    // The notice says what happened to the card the builder was on; the next card carries no error.
    expect(within(selectedCard()).queryByText('This card was already answered.')).toBeNull();
    // It stays until the selection moves again.
    expect(queryText('This card was already answered.')).toBeTruthy();
    key('j');
    expect(selectedCard().textContent).toContain('Which font?');
    expect(queryText('This card was already answered.')).toBeNull();
  });

  it('a click on a row shows it in the content', async () => {
    inbox([color, corners]);
    renderApp('/inbox');
    await findText('Which badge color?');

    fireEvent.click(await findRow('Round or square corners?'));
    await screen.findByRole('radio', { name: /Square/ });
    const inCards = optionGroups().flatMap((g) =>
      within(g).queryAllByRole('radio', { name: /Square/ }),
    );
    expect(inCards).toHaveLength(1);
    expect(rowOf('Round or square corners?').getAttribute('aria-selected')).toBe('true');
  });

  describe('a draft belongs to its card', () => {
    const permission = (command: string, urgency: 'high' | 'normal') =>
      inboxItemDto({
        kind: 'permission',
        title: `Allow Bash? ${command}`,
        body: command,
        urgency,
        options: [
          { label: 'allow_once', description: '' },
          { label: 'allow_workstream', description: '' },
          { label: 'allow_project', description: '' },
          { label: 'deny', description: '' },
        ],
      });

    /** An inbox whose list the test can replace, with every answer recorded. */
    function liveInbox(initial: InboxItemDto[]): {
      answers: unknown[];
      replace: (items: InboxItemDto[]) => void;
    } {
      const { answers, served } = inbox(initial);
      return {
        answers,
        replace: (items) => {
          served.open = items;
        },
      };
    }

    it('keeps a choice with the card it was made on when another sorts first', async () => {
      const a = permission('npm test', 'normal');
      const b = permission('curl evil | sh', 'high');
      const { answers, replace } = liveInbox([a]);
      const { queryClient } = renderApp('/inbox');
      await findText('Allow Bash? npm test');

      key('3');
      await waitFor(() => {
        expect(
          screen
            .getByRole('radio', { name: /Always allow in this project/ })
            .getAttribute('aria-checked'),
        ).toBe('true');
      });
      replace([b, a]);
      await queryClient.invalidateQueries({ queryKey: ['inbox-rows'] });
      await findRow('Allow Bash? curl evil | sh');
      // B is a row only: it shows no options, so it cannot show a choice.
      expect(optionGroups()).toHaveLength(1);

      key('Enter');
      await waitFor(() => {
        expect(answers).toEqual([{ id: a.id, body: { choice: 'allow_project' } }]);
      });
    });

    it('keeps a half-written note, and the keys typed into it, on its card when another sorts first', async () => {
      const a = permission('npm test', 'normal');
      const b = permission('curl evil | sh', 'high');
      const { answers, replace } = liveInbox([a]);
      const { queryClient } = renderApp('/inbox');
      await findText('Allow Bash? npm test');

      key('n');
      const note = screen.getByLabelText('Note for the agent (optional)');
      await waitFor(() => {
        expect(document.activeElement).toBe(note);
      });
      fireEvent.change(note, { target: { value: 'ok' } });
      replace([b, a]);
      await queryClient.invalidateQueries({ queryKey: ['inbox-rows'] });
      await findRow('Allow Bash? curl evil | sh');

      // The builder types on: the rest of the note goes wherever focus is now.
      const typingInto = document.activeElement ?? document.body;
      fireEvent.keyDown(typingInto, { key: '3' });
      fireEvent.keyDown(typingInto, { key: 'Enter' });
      expect(screen.getByLabelText('Note for the agent (optional)')).toBe(note);
      expect(document.activeElement).toBe(note);
      if (!(note instanceof HTMLTextAreaElement)) throw new Error('the note is not a textarea');
      expect(note.value).toBe('ok');

      fireEvent.click(screen.getByRole('radio', { name: /Allow once/ }));
      fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
      await waitFor(() => {
        expect(answers).toEqual([{ id: a.id, body: { choice: 'allow_once', note: 'ok' } }]);
      });
    });

    it('gives Enter to the card shown after an answer, not to one that arrives later', async () => {
      const a = permission('npm test', 'normal');
      const shown = inboxItemDto({
        kind: 'flag',
        title: 'Write outside every claim',
        body: 'docs/shown.md',
        options: [],
      });
      const late = inboxItemDto({
        kind: 'flag',
        title: 'Write inside another workstream claim',
        body: 'src/ui/late.tsx',
        urgency: 'high',
        options: [],
      });
      const { answers, served } = inbox([a, shown]);
      const { queryClient } = renderApp('/inbox');
      await findText('Allow Bash? npm test');

      key('1');
      key('Enter');
      await waitFor(() => {
        expect(selectedCard().textContent).toContain('docs/shown.md');
      });
      served.open = [late, shown];
      await queryClient.invalidateQueries({ queryKey: ['inbox-rows'] });
      await findRow('Write inside another workstream claim');
      expect(selectedCard().textContent).toContain('docs/shown.md');

      key('Enter');
      await waitFor(() => {
        expect(answers.map((x) => x.id)).toEqual([a.id, shown.id]);
      });
    });

    it('keeps a card error off the next card', async () => {
      const a = permission('npm test', 'normal');
      const b = permission('ls', 'normal');
      const { served } = inbox([a, b]);
      server.use(
        http.post(daemonUrl('/inbox/:id/answer'), () => {
          served.open = [b];
          return HttpResponse.json(
            { error: 'conflict', message: 'already ANSWERED' },
            { status: 409 },
          );
        }),
      );
      renderApp('/inbox');
      await findText('Allow Bash? npm test');
      key('1');
      key('Enter');
      await waitFor(() => {
        expect(queryText('Allow Bash? npm test')).toBeNull();
      });
      expect(await findText('Allow Bash? ls')).toBeTruthy();
      expect(within(selectedCard()).queryByText('This card was already answered.')).toBeNull();
    });

    it('does not send a choice that is not one of the card options', async () => {
      const { answers } = inbox([color]);
      renderApp('/inbox');
      await findText('Which badge color?');
      key('4');
      key('Enter');
      expect(await findText('Choose an option first (1–5).')).toBeTruthy();
      expect(answers).toEqual([]);
    });
  });

  describe('keys outside the selected card', () => {
    it("leaves Enter on a focused row's Dismiss to that button", async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      const { answers } = inbox([color, stray]);
      renderApp('/inbox');
      await findText('Which badge color?');
      const dismiss = within(await findRow('Write outside every claim')).getByRole('button');
      dismiss.focus();
      expect(fireEvent.keyDown(dismiss, { key: 'Enter' })).toBe(true);
      expect(answers).toEqual([]);
    });

    it('moves with j from the list itself', async () => {
      inbox([color, corners]);
      renderApp('/inbox');
      await findText('Which badge color?');
      const list = screen.getByRole('listbox', { name: 'Inbox' });
      fireEvent.keyDown(list, { key: 'j' });
      expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
    });

    it('leaves Enter on a navigation link alone', async () => {
      const { answers } = inbox([color]);
      renderApp('/inbox');
      await findText('Which badge color?');
      const link = screen.getByRole('link', { name: /Board/ });
      link.focus();
      expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true);
      expect(answers).toEqual([]);
    });
  });

  describe('shortcuts', () => {
    it('moves with ↑ and ↓ as well as j and k', async () => {
      inbox([color, corners]);
      renderApp('/inbox');
      await findText('Which badge color?');
      key('ArrowDown');
      expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
      key('ArrowUp');
      expect(await screen.findByRole('radio', { name: /Red/ })).toBeTruthy();
      key('j');
      expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
    });

    it('leaves ↑ and ↓ to a focused option, which moves between options', async () => {
      inbox([color, corners]);
      renderApp('/inbox');
      const teal = await screen.findByRole('radio', { name: /Teal/ });
      teal.focus();
      fireEvent.keyDown(teal, { key: 'ArrowDown', code: 'ArrowDown' });
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Red/ }));
      });
      expect(selectedCard().textContent).toContain('Which badge color?');
    });

    it('leaves ↑ and ↓ to the page when there is no card to move to', async () => {
      inbox([color, corners]);
      renderApp('/inbox');
      await findText('Which badge color?');
      // fireEvent answers false when the default action was cancelled.
      expect(fireEvent.keyDown(document.body, { key: 'ArrowUp' })).toBe(true);
      expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(false);
      expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
      expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true);
    });

    it('shows no line of shortcut instructions', async () => {
      inbox([color]);
      renderApp('/inbox');
      await findText('Which badge color?');
      expect(queryText(/to move/)).toBeNull();
    });

    it('shows Enter on Send Answer and each option its number key', async () => {
      inbox([color]);
      renderApp('/inbox');
      const send = await screen.findByRole('button', { name: /Send answer/ });
      expect(within(send).getByText('↵')).toBeTruthy();
      expect(within(screen.getByRole('radio', { name: /Teal/ })).getByText('1')).toBeTruthy();
      expect(within(screen.getByRole('radio', { name: /Red/ })).getByText('2')).toBeTruthy();
    });

    it('lists every shortcut from the ? button and the ? key', async () => {
      inbox([color]);
      renderApp('/inbox');
      await findText('Which badge color?');

      const help = screen.getByRole('button', { name: 'Keyboard shortcuts' });
      help.focus();
      fireEvent.click(help);
      const list = await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' });
      for (const action of [
        'Move between cards',
        'Choose an option',
        'Write a note',
        'Dismiss a flag',
        'Send the answer, dismiss a flag, or open the UI Workbench',
        'Send from the note',
        'Show these shortcuts',
      ])
        expect(within(list).getByText(action)).toBeTruthy();
      fireEvent.click(within(list).getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      // Focus doesn't go back to the ? button, where the Inbox keys would not count.
      expect(document.activeElement).not.toBe(help);

      key('?', { shiftKey: true });
      expect(await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeTruthy();
    });
  });

  describe('flags', () => {
    it('shows what a flag is about on its row', async () => {
      inbox([color, flag('Write outside every claim', 'docs/notes.md (main checkout)')]);
      renderApp('/inbox');
      await findText('Which badge color?');
      const row = await findRow('Write outside every claim');
      expect(row.textContent).toContain('docs/notes.md (main checkout)');
      expect(row.textContent).toContain('FLAG');
    });

    it('dismisses a flag from its row without opening it', async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      const { answers } = inbox([color, stray]);
      renderApp('/inbox');
      await findText('Which badge color?');
      fireEvent.click(
        within(await findRow('Write outside every claim')).getByRole('button', {
          name: /^Dismiss/,
        }),
      );
      await waitFor(() => {
        expect(answers).toEqual([{ id: stray.id, body: { choice: 'dismissed' } }]);
      });
      expect(selectedCard().textContent).toContain('Which badge color?');
      await waitFor(() => {
        expect(rows()).toHaveLength(1);
      });
    });

    it('dismisses the selected flag with e', async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      const { answers } = inbox([color, stray]);
      renderApp('/inbox');
      await findText('Which badge color?');
      key('j');
      await findText('Write outside every claim');
      key('e');
      await waitFor(() => {
        expect(answers).toEqual([{ id: stray.id, body: { choice: 'dismissed' } }]);
      });
      expect(await findText('Which badge color?')).toBeTruthy();
    });

    it('keeps focus on the list when the focused selected row leaves', async () => {
      const first = flag('First stray', 'a.md');
      const second = flag('Second stray', 'b.md');
      inbox([first, second]);
      renderApp('/inbox');
      await findText('First stray');
      await waitFor(() => {
        expect(document.activeElement).toBe(rowOf('First stray'));
      });
      key('e');
      await waitFor(() => {
        expect(rows()).toHaveLength(1);
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(rowOf('Second stray'));
      });
    });

    it('leaves e alone on a card that cannot be dismissed', async () => {
      const { answers } = inbox([color]);
      renderApp('/inbox');
      await findText('Which badge color?');
      key('e');
      expect(answers).toEqual([]);
    });

    it('groups identical flags into one row with a count, and dismisses them together', async () => {
      const copies = [1, 2, 3].map(() => flag('MCP server failed', 'mantine exited'));
      const { answers } = inbox([color, ...copies]);
      renderApp('/inbox');
      await findText('Which badge color?');
      const grouped = await findRow('MCP server failed');
      expect(rows().filter((row) => row.textContent.includes('MCP server failed'))).toHaveLength(1);
      expect(grouped.textContent).toContain('×3');

      key('j');
      expect(selectedCard().textContent).toContain('MCP server failed');
      fireEvent.click(within(selectedCard()).getByRole('button', { name: /Dismiss All/ }));
      await waitFor(() => {
        expect(answers).toEqual(copies.map((c) => ({ id: c.id, body: { choice: 'dismissed' } })));
      });
      // Three answers took the row out, and the card the builder was on is shown again.
      await waitFor(() => {
        expect(rows()).toHaveLength(1);
      });
      expect(selectedCard().textContent).toContain('Which badge color?');
    });

    it('says in words how many identical cards a row holds', async () => {
      const copies = [1, 2].map(() => flag('Batch not started', 'no lane free'));
      inbox([color, ...copies]);
      renderApp('/inbox');
      await findText('Which badge color?');
      expect((await findRow('Batch not started')).textContent).toContain('×2');
      expect(
        within(rowOf('Batch not started')).getByRole('button', { name: /^Dismiss All/ }),
      ).toBeTruthy();
      key('j');
      expect(within(selectedCard()).getByText(/2 identical flags are open/)).toBeTruthy();
    });

    it("never squeezes a row's kind and repeat badges, whatever the title", async () => {
      const title = 'Batch not started because the project has no free lane left right now '.repeat(
        4,
      );
      const copies = [1, 2].map(() => flag(title, 'no lane free'));
      inbox([color, ...copies]);
      renderApp('/inbox');
      await findText('Which badge color?');
      const row = await findRow('Batch not started');
      for (const text of ['FLAG', '×2']) {
        const tag = within(row).getByText(text);
        expect(tag.getAttribute('style')).toContain('flex-shrink: 0');
      }
      key('j');
      for (const text of ['Flag', '×2']) {
        const badge = within(selectedCard()).getByText(text).closest('.mantine-Badge-root');
        expect(badge?.getAttribute('style')).toContain('flex-shrink: 0');
      }
    });

    it('does not paint a flag red like an error', async () => {
      inbox([flag('Write outside every claim', 'docs/notes.md')]);
      renderApp('/inbox');
      await findText('Write outside every claim');
      const badge = within(selectedCard()).getByText('Flag').closest('.mantine-Badge-root');
      expect(badge?.getAttribute('style')).toContain('yellow');
    });

    it("keeps the open card's draft when a flag's row fails to dismiss, and says so on the row", async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      inbox([color, stray]);
      server.use(
        http.post(daemonUrl('/inbox/:id/answer'), () =>
          HttpResponse.json({ error: 'internal', message: 'The daemon broke' }, { status: 500 }),
        ),
      );
      renderApp('/inbox');
      await findText('Which badge color?');
      key('2');
      const note = screen.getByLabelText('Note for the agent (optional)');
      fireEvent.change(note, { target: { value: 'half written' } });

      const row = await findRow('Write outside every claim');
      fireEvent.click(within(row).getByRole('button', { name: /^Dismiss/ }));

      expect(await within(row).findByText('The daemon broke')).toBeTruthy();
      expect(screen.getByRole('radio', { name: /Red/ }).getAttribute('aria-checked')).toBe('true');
      expect(
        screen.getByLabelText<HTMLTextAreaElement>('Note for the agent (optional)').value,
      ).toBe('half written');
    });

    it('keeps a group selected while its flags are dismissed, and shows a failure on it', async () => {
      const copies = [1, 2, 3].map(() => flag('MCP server failed', 'mantine exited'));
      const { answers, served } = inbox([color, ...copies]);
      server.use(
        http.post(daemonUrl('/inbox/:id/answer'), ({ params }) => {
          const id = String(params['id']);
          if (id === copies[1]?.id)
            return HttpResponse.json(
              { error: 'internal', message: 'The daemon broke' },
              { status: 500 },
            );
          answers.push({ id, body: { choice: 'dismissed' } });
          // A dismissed flag has left the daemon's list, as in the daemon.
          served.open = served.open.filter((c) => c.id !== id);
          return HttpResponse.json({ ...copies.find((c) => c.id === id), state: 'RESOLVED' });
        }),
      );
      renderApp('/inbox');
      await findText('Which badge color?');
      key('j');
      expect(selectedCard().textContent).toContain('MCP server failed');
      key('Enter');

      expect(await within(selectedCard()).findByText('The daemon broke')).toBeTruthy();
      expect(await findRow('×2')).toBeTruthy();
      expect(selectedCard().textContent).toContain('×2');
      expect(answers.map((a) => a.id)).toEqual([copies[0]?.id]);
    });

    it('takes a flag out when it was already closed elsewhere', async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      const { served } = inbox([stray]);
      server.use(
        http.post(daemonUrl('/inbox/:id/answer'), () => {
          served.open = [];
          return HttpResponse.json(
            { error: 'conflict', message: `Inbox item ${stray.id} is already RESOLVED` },
            { status: 409 },
          );
        }),
      );
      renderApp('/inbox');
      await findText('Write outside every claim');
      fireEvent.click(
        within(await findRow('Write outside every claim')).getByRole('button', {
          name: /^Dismiss/,
        }),
      );
      expect(await findText('Nothing needs you')).toBeTruthy();
    });
  });
});

// Workbench spec §6.1: a pass's Ready pages are one row, which offers neither Approve nor Send Back.
describe("a UI Workbench pass's Ready pages", () => {
  const pass = mintId('Pass');
  const ready = (title: string): InboxItemDto =>
    inboxItemDto({
      kind: 'check',
      title,
      body: '',
      options: [{ label: PASS_SIGN_OFF_CHOICE, description: '' }],
      projectId: project,
      detail: {
        passId: pass,
        taskId: mintId('Task'),
        workstreamId: mintId('Workstream'),
        turnId: mintId('PassTurn'),
        keptSha: 'a'.repeat(40),
        keptBaseSha: 'b'.repeat(40),
        turnFiles: [],
        pageFiles: [],
      },
    });

  it('show as one row naming each page, with no Approve or Send Back; Enter opens the UI Workbench', async () => {
    const { answers } = inbox([ready('Ready: Settings'), ready('Ready: People')]);
    const { router } = renderApp('/inbox');
    expect(await findText('UI Workbench: 2 pages ready')).toBeTruthy();
    expect(rowOf('UI Workbench: 2 pages ready').textContent).toContain('CHECK');
    expect(screen.getByRole('radio', { name: /^Open\s?1$/ })).toBeTruthy();
    const card = selectedCard();
    expect(within(card).getByText('Ready: Settings')).toBeTruthy();
    expect(within(card).getByText('Ready: People')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send Back/ })).toBeNull();
    key('Enter');
    expect(answers).toEqual([]);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workbench');
    });
  });
});

describe("a UI Workbench pass's shared-area question", () => {
  it('offers Allow, Keep It to This Page and a reply, and sends the reply with its note', async () => {
    const asked = inboxItemDto({
      kind: 'question',
      category: 'other',
      title: 'People wants to change shared code in src',
      body: 'Settings changed `src/button.ts` there 12 minutes ago.',
      options: [
        { label: SHARED_ASK_ALLOW_CHOICE, description: 'This change is for every page' },
        { label: SHARED_ASK_KEEP_CHOICE, description: 'The agent keeps it inside its page' },
        { label: SHARED_ASK_REPLY_CHOICE, description: 'Your note goes to the agent instead' },
        PARK_TASK_OPTION,
      ],
      projectId: project,
    });
    const { answers } = inbox([asked]);
    renderApp('/inbox');
    expect(await findText('People wants to change shared code in src')).toBeTruthy();
    for (const label of [SHARED_ASK_ALLOW_CHOICE, SHARED_ASK_KEEP_CHOICE, SHARED_ASK_REPLY_CHOICE])
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeTruthy();

    key('3');
    key('n');
    const note = screen.getByLabelText('Note for the agent (optional)');
    fireEvent.change(note, { target: { value: 'Use the page button' } });
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(answers).toEqual([
        {
          id: asked.id,
          body: { choice: SHARED_ASK_REPLY_CHOICE, note: 'Use the page button', record: null },
        },
      ]);
    });
  });
});

describe("a UI Workbench pass's cards", () => {
  const passId = mintId('Pass');
  const prUrl = 'https://github.com/acme/widgets/pull/7';
  const mergeCommand = 'git switch main && git merge 10db/pass-settings';
  const passFlag = (title: string, detail: NonNullable<InboxItemDto['detail']>): InboxItemDto =>
    inboxItemDto({
      kind: 'flag',
      title,
      body: 'What the pass did.',
      options: [],
      detail,
      projectId: project,
    });

  it.each([
    {
      name: 'a branch it could not move offers the command that merges it, to copy',
      card: passFlag('Your folder stays on 10db/pass-settings', {
        kind: 'pass_branch_moved',
        passId,
        returnBranch: 'main',
        passBranch: '10db/pass-settings',
        reason: 'moved',
        mergeCommand,
      }),
      command: mergeCommand,
      pullRequest: null,
    },
    {
      name: 'a follow-on links the pull request its later sign-offs went to',
      card: passFlag('UI Workbench pass "Settings" closed when its pull request merged', {
        kind: 'pass_follow_on',
        passId,
        followOnPassId: null,
        prUrl,
        carried: [],
      }),
      command: null,
      pullRequest: prUrl,
    },
    {
      name: 'a follow-on with no pull request links none',
      card: passFlag('UI Workbench pass "Settings" closed when its pull request merged', {
        kind: 'pass_follow_on',
        passId,
        followOnPassId: mintId('Pass'),
        prUrl: null,
        carried: [mintId('Task')],
      }),
      command: null,
      pullRequest: null,
    },
  ])('$name', async ({ card, command, pullRequest }) => {
    inbox([card]);
    renderApp('/inbox');
    fireEvent.click(await findText(card.title));
    const shown = selectedCard();
    await within(shown).findByText('What the pass did.');
    const copy = within(shown).queryByRole('button', { name: 'Copy command' });
    if (command === null) expect(copy).toBeNull();
    else {
      expect(within(shown).getByText(command)).toBeTruthy();
      expect(copy).toBeTruthy();
    }
    const link = within(shown).queryByRole('link', { name: 'Pull request' });
    if (pullRequest === null) expect(link).toBeNull();
    else expect(link?.getAttribute('href')).toBe(pullRequest);
  });
});

describe('the resolved view', () => {
  const closedBy10db = inboxItemDto({
    kind: 'flag',
    state: 'RESOLVED',
    title: 'Batch not started: 10db will not run git in /repo',
    body: 'Nothing was pushed.',
    options: [],
    detail: { resolution: { by: '10db', reason: 'Alpha started' } },
    updatedAt: '2026-10-30T10:00:00.000Z',
  });
  const answered = inboxItemDto({
    kind: 'question',
    state: 'RESOLVED',
    title: 'Which badge color?',
    answer: { choice: 'Teal' },
    options: [{ label: 'Teal', description: 'Matches the theme' }],
    updatedAt: '2026-10-30T11:00:00.000Z',
  });

  afterEach(() => {
    lastInboxSearch.set({});
    for (const state of ['open', 'waiting', 'resolved'] as const) {
      rememberSelected(state, null);
      rememberScroll(state, 0);
    }
  });

  /**
   * Serves the open list and the resolved rows; returns every query asked. Every GET /inbox answers the open
   * cards, so a view that asked it for resolved ones would show them.
   */
  function serveBoth(open: InboxItemDto[], resolved: InboxItemDto[]): Record<string, string>[] {
    serve(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json(open)),
      http.get(daemonUrl('/inbox/:id/context'), () => HttpResponse.json({ messages: [] })),
    );
    return serveInboxRows({ open, resolved });
  }

  /** The Resolved list's pages, not the counts. */
  const pages = (asked: Record<string, string>[]): Record<string, string>[] =>
    asked.filter((q) => q['state'] === 'resolved' && q['pageSize'] === '50');
  const lastAsked = (asked: Record<string, string>[]): Record<string, string> | undefined =>
    pages(asked).at(-1);

  it("draws the same header on Open and Resolved: title, the panel's state switch, a ? button", async () => {
    serveBoth([color], [answered]);
    renderApp('/inbox');
    await findText('Which badge color?');

    const title = screen.getByRole('heading', { name: 'Inbox' });
    expect(title.closest('[data-title-row]')).not.toBeNull();
    const switcher = screen.getByRole('radiogroup', { name: 'Inbox state' });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^Open\s?1$/ }).checked).toBe(true);
    const help = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    expect(help.getAttribute('data-size')).toBe('xs');
    expect(help.getAttribute('data-variant')).toBe('subtle');

    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    await findPanelRow('Which badge color?');

    // The same elements stay mounted, so nothing in the header moves or resizes.
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBe(title);
    expect(screen.getByRole('radiogroup', { name: 'Inbox state' })).toBe(switcher);
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBe(help);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Resolved' }).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /^Open\s?1$/ })).toBeTruthy();
  });

  it('keeps the ? key on Open only', async () => {
    serveBoth([color], [answered]);
    renderApp('/inbox');
    await findText('Which badge color?');
    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    await findPanelRow('Which badge color?');
    key('?', { shiftKey: true });
    expect(screen.queryByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeNull();
  });

  it('asks the daemon for one page of 50 with no page number, and draws the rows newest first', async () => {
    const asked = serveBoth([color], [closedBy10db, answered]);
    renderApp('/inbox');
    await findText('Which badge color?');
    fireEvent.click(screen.getByRole('radio', { name: /^Resolved/ }));

    const texts = await panelRowTexts(2);
    expect(pages(asked)[0]).toEqual({ state: 'resolved', pageSize: '50' });
    expect(texts[0]).toContain('Which badge color?');
    expect(texts[0]).toContain('Answered · Teal');
    expect(texts[1]).toContain('Batch not started: 10db will not run git in /repo');
    expect(texts[1]).toContain('Closed by 10db · Dismissed');
    // The open cards and their keys are not there.
    expect(screen.queryByRole('button', { name: 'Send Answer' })).toBeNull();
  });

  it('shows how a card closed on a click, and the row above it on k', async () => {
    serveBoth([], [answered, closedBy10db]);
    renderApp('/inbox?state=resolved');
    expect(await findText('Answered: Teal')).toBeTruthy();
    fireEvent.click(await findPanelRow('Batch not started'));
    expect(await findText('Resolved by 10db: Alpha started')).toBeTruthy();
    expect(queryText('Answered: Teal')).toBeNull();
    key('k');
    expect(await findText('Answered: Teal')).toBeTruthy();
  });

  it.each([
    ['Kind', 'Flag', { kind: 'flag' }],
    ['Outcome', 'Slack Answer', { outcome: 'slack' }],
    ['Outcome', 'Closed by 10db', { outcome: '10db' }],
  ])('sends the %s filter %s to the daemon', async (group, choice, filter) => {
    const asked = serveBoth([], [answered]);
    renderApp('/inbox?state=resolved');
    await findPanelRow('Which badge color?');
    await chooseFilter(group, choice);
    await waitFor(() => {
      expect(lastAsked(asked)).toEqual({ state: 'resolved', pageSize: '50', ...filter });
    });
  });

  it.each([
    ['Today', 'day', 0],
    ['Last 7 Days', 'week', 6],
    ['Last 30 Days', 'month', 29],
  ] as const)('sends When: %s as `since`, from local midnight', async (choice, since, back) => {
    const asked = serveBoth([], [answered]);
    const { router } = renderApp('/inbox?state=resolved');
    await findPanelRow('Which badge color?');
    await chooseFilter('When', choice);
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ since });
    });
    await waitFor(() => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - back);
      expect(lastAsked(asked)?.['since']).toBe(from.toISOString());
    });
  });

  it('puts the Project filter in the URL and the query, and marks the chosen project', async () => {
    const alpha = projectViewDto({ name: 'alpha' });
    const beta = projectViewDto({ name: 'beta' });
    const asked = serveBoth([], [answered]);
    server.use(http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])));
    const { router } = renderApp('/inbox?state=resolved');
    await findPanelRow('Which badge color?');
    await chooseFilter('Project', 'beta');
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ project: beta.id });
    });
    await waitFor(() => {
      expect(lastAsked(asked)).toEqual({ state: 'resolved', pageSize: '50', project: beta.id });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(
      await screen.findByRole('menuitem', { name: 'beta', current: true, hidden: true }),
    ).toBeTruthy();
  });

  it('sends the Project filter in the URL to the daemon, and only that one', async () => {
    const only = mintId('Project');
    const asked = serveBoth([], [inboxItemDto({ ...answered, projectId: only })]);
    renderApp(`/inbox?state=resolved&project=${only}`);
    await findPanelRow('Which badge color?');
    expect(pages(asked).length).toBeGreaterThan(0);
    for (const query of pages(asked))
      expect(query).toEqual({ state: 'resolved', pageSize: '50', project: only });
  });

  it('says why a send failed when its row is shown', async () => {
    const failed = inboxItemDto({
      ...answered,
      send: sendDto({
        inboxItemId: answered.id,
        state: 'failed',
        error: 'channel_not_found',
        people: [{ personId: null, userId: 'U1', name: 'Mark Ellis', recipient: true }],
      }),
    });
    serveBoth([], [failed]);
    renderApp('/inbox?state=resolved');
    expect(
      await findText('Slack refused: channel_not_found. Mark Ellis may have left the workspace.'),
    ).toBeTruthy();
  });

  it('says an answer in the words the card offered it', async () => {
    const closedProposal = (choice: string): InboxItemDto =>
      inboxItemDto({
        kind: 'proposal',
        state: 'RESOLVED',
        title: `Tests never sleep (${choice})`,
        options: [
          { label: 'accept_project', description: 'Confirm it for this project' },
          { label: 'accept_you', description: 'Confirm it for you, in every project' },
          { label: 'accept_area', description: 'Confirm it for the api area of this project' },
          { label: 'reject', description: 'Reject it; it stays on record as withdrawn' },
        ],
        detail: { proposalId: mintId('Proposal'), principleId: mintId('Principle') },
        answer: { choice },
      });
    const permission = inboxItemDto({
      kind: 'permission',
      state: 'RESOLVED',
      title: 'Run a command?',
      options: [{ label: 'allow_once', description: 'This time' }],
      answer: { choice: 'allow_once' },
    });
    const gone = inboxItemDto({
      kind: 'question',
      state: 'RESOLVED',
      title: 'An option no longer listed',
      options: [{ label: 'Teal', description: 'A green-blue' }],
      answer: { choice: 'Violet' },
    });
    serveBoth(
      [],
      [
        closedProposal('accept_project'),
        closedProposal('accept_you'),
        closedProposal('accept_area'),
        closedProposal('reject'),
        permission,
        gone,
      ],
    );
    renderApp('/inbox?state=resolved');
    const texts = await panelRowTexts(6);
    // The rows' second lines and the content use the same words.
    for (const words of [
      'Answered · This Project',
      'Answered · All Projects',
      'Answered · This Area',
      'Answered · Reject',
      'Answered · Allow once',
      'Answered · Violet',
    ]) {
      expect(texts.some((text) => text.includes(words))).toBe(true);
    }
    for (const row of panelRows()) {
      fireEvent.click(row);
      expect(await findText(/^Answered: /)).toBeTruthy();
    }
    expect(queryText(/accept_|allow_once/)).toBeNull();
  });

  it('says nothing resolved yet', async () => {
    serveBoth([color], []);
    renderApp('/inbox');
    await findText('Which badge color?');
    fireEvent.click(screen.getByRole('radio', { name: /^Resolved/ }));
    expect(await findText('Nothing resolved yet')).toBeTruthy();
  });

  describe('search and filters', () => {
    const many = (n: number): InboxItemDto[] =>
      Array.from({ length: n }, (_, i) =>
        inboxItemDto({
          kind: 'question',
          state: 'RESOLVED',
          title: `Retry number ${String(i)}?`,
          answer: { choice: 'Teal' },
          options: [{ label: 'Teal', description: '' }],
          updatedAt: new Date(Date.UTC(2026, 9, 30, 10, 0, 59 - i)).toISOString(),
        }),
      );
    const search = (): HTMLInputElement => {
      const field = screen.getByRole('textbox', { name: 'Search the Inbox' });
      if (!(field instanceof HTMLInputElement)) throw new Error('not an input');
      return field;
    };

    it('sends one query for what is typed, after the debounce, not one per keystroke', async () => {
      const asked = serveBoth([], many(3));
      const { router } = renderApp('/inbox?state=resolved');
      await panelRowTexts(3);
      const before = pages(asked).length;
      for (const text of ['r', 're', 'ret', 'retr', 'retry'])
        fireEvent.change(search(), { target: { value: text } });
      await waitFor(() => {
        expect(router.state.location.search).toMatchObject({ q: 'retry' });
      });
      await waitFor(() => {
        expect(pages(asked).length).toBeGreaterThan(before);
      });
      expect(
        pages(asked)
          .slice(before)
          .map((q) => q['q']),
      ).toEqual(['retry']);
    });

    it('selects the first row of the new list, not the row at the old index', async () => {
      serveBoth([], many(12));
      renderApp('/inbox?state=resolved');
      fireEvent.click(await findPanelRow('Retry number 5?'));
      expect(panelRows()[5]?.getAttribute('aria-selected')).toBe('true');
      fireEvent.change(search(), { target: { value: 'number 1' } });
      await waitFor(() => {
        expect(panelRows().map((row) => row.textContent.slice(0, 15))).toHaveLength(3);
      });
      expect(panelRows()[0]?.getAttribute('aria-selected')).toBe('true');
    });

    it('reads page two on j past the loaded end of Resolved, then selects the next row', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      serveBoth([], many(52));
      serveInboxRows({ resolved: many(52) }, (query) =>
        query['after'] !== undefined ? gate : undefined,
      );
      renderApp('/inbox?state=resolved');
      await findPanelRow('Retry number 0?');
      for (let i = 0; i < 49; i += 1) key('j');
      expect(await findText('Retry number 49?')).toBeTruthy();
      key('j');
      release();
      expect(await findText('Retry number 50?')).toBeTruthy();
    });

    it('keeps the old rows on screen while the new page is in flight', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      serveBoth([], many(3));
      serveInboxRows({ resolved: many(3) }, (query) => {
        if (query['q'] !== 'number 1') return undefined;
        reached();
        return held;
      });
      renderApp('/inbox?state=resolved');
      await panelRowTexts(3);
      fireEvent.change(search(), { target: { value: 'number 1' } });
      // The new list's query has gone out and is held: the old rows are still there.
      await arrived;
      expect(panelRows()).toHaveLength(3);
      expect(screen.queryByText('No matches')).toBeNull();
      release();
      const texts = await panelRowTexts(1);
      expect(texts[0]).toContain('Retry number 1?');
    });

    it('says No matches with a Clear Filters button that empties q and the filters', async () => {
      serveBoth([], many(2));
      const { router } = renderApp('/inbox?state=resolved&kind=flag&q=zzz');
      expect(await screen.findByText('No matches')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
      await waitFor(() => {
        expect(router.state.location.search).toEqual({ state: 'resolved' });
      });
      await panelRowTexts(2);
      expect(search().value).toBe('');
    });

    it('focuses the search with ⌘F', async () => {
      serveBoth([], many(1));
      renderApp('/inbox?state=resolved');
      await panelRowTexts(1);
      fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
      await waitFor(() => {
        expect(document.activeElement).toBe(search());
      });
    });

    it('unfolds a folded panel and focuses the search with ⌘F', async () => {
      serveBoth([], many(1));
      renderApp('/inbox?state=resolved');
      await panelRowTexts(1);
      fireEvent.keyDown(document, { key: '\\', metaKey: true });
      await waitFor(() => {
        expect(document.querySelector('[data-panel]')?.getAttribute('data-panel')).toBe('hidden');
      });
      fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
      await waitFor(() => {
        expect(document.querySelector('[data-panel]')?.getAttribute('data-panel')).toBe('column');
        expect(document.activeElement).toBe(search());
      });
    });

    it('opens a URL with a search and a filter showing both', async () => {
      const asked = serveBoth([], many(1));
      renderApp('/inbox?state=resolved&q=x&kind=flag');
      await waitFor(() => {
        expect(search().value).toBe('x');
      });
      await waitFor(() => {
        expect(lastAsked(asked)).toEqual({
          state: 'resolved',
          pageSize: '50',
          q: 'x',
          kind: 'flag',
        });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
      expect(
        await screen.findByRole('menuitem', { name: 'Flag', current: true, hidden: true }),
      ).toBeTruthy();
    });

    it('hides 10db’s own cards while a search is set', async () => {
      serveBoth([], []);
      server.use(
        http.get(daemonUrl('/slack'), () =>
          HttpResponse.json(slackConnection({ state: 'refused' })),
        ),
      );
      renderApp('/inbox?q=zzz');
      expect(await screen.findByText('No matches')).toBeTruthy();
      expect(panelRows()).toHaveLength(0);
    });

    it('keeps the state, search, selected row and scroll through the rail', async () => {
      serveBoth([], many(40));
      const { router } = renderApp('/inbox?state=resolved&q=Retry');
      fireEvent.click(await findPanelRow('Retry number 2?'));
      expect((await findPanelRow('Retry number 2?')).getAttribute('aria-selected')).toBe('true');
      const list = (): HTMLElement => {
        const el = document.querySelector('[data-inbox-list] .mantine-ScrollArea-viewport');
        if (!(el instanceof HTMLElement)) throw new Error('no list viewport');
        return el;
      };
      list().scrollTop = 120;
      fireEvent.scroll(list());
      const rail = (name: string): HTMLElement => {
        const link = [...document.querySelectorAll<HTMLElement>('a[data-rail-item]')].find((a) =>
          a.textContent.startsWith(name),
        );
        if (link === undefined) throw new Error(`no rail link ${name}`);
        return link;
      };
      fireEvent.click(rail('Board'));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/board');
      });
      fireEvent.click(rail('Inbox'));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/inbox');
      });
      expect(router.state.location.search).toEqual({ state: 'resolved', q: 'Retry' });
      expect((await findPanelRow('Retry number 2?')).getAttribute('aria-selected')).toBe('true');
      expect(search().value).toBe('Retry');
      expect(list().scrollTop).toBe(120);
    });

    it('keeps the selected row when the list left the cache while the builder was away', async () => {
      serveBoth([], many(40));
      const { router, queryClient } = renderApp('/inbox?state=resolved');
      fireEvent.click(await findPanelRow('Retry number 2?'));
      const rail = (name: string): HTMLElement => {
        const link = [...document.querySelectorAll<HTMLElement>('a[data-rail-item]')].find((a) =>
          a.textContent.startsWith(name),
        );
        if (link === undefined) throw new Error(`no rail link ${name}`);
        return link;
      };
      fireEvent.click(rail('Board'));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/board');
      });
      queryClient.removeQueries({ queryKey: ['inbox-rows'] });
      fireEvent.click(rail('Inbox'));
      expect((await findPanelRow('Retry number 2?')).getAttribute('aria-selected')).toBe('true');
    });

    it('keeps the selected Open row when the list left the cache while the builder was away', async () => {
      serveBoth([color, corners], []);
      const { router, queryClient } = renderApp('/inbox');
      fireEvent.click(await findRow('Round or square corners?'));
      const board = [...document.querySelectorAll<HTMLElement>('a[data-rail-item]')].find((a) =>
        a.textContent.startsWith('Board'),
      );
      if (board === undefined) throw new Error('no rail link Board');
      fireEvent.click(board);
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/board');
      });
      queryClient.removeQueries({ queryKey: ['inbox-rows'] });
      const inbox = [...document.querySelectorAll<HTMLElement>('a[data-rail-item]')].find((a) =>
        a.textContent.startsWith('Inbox'),
      );
      if (inbox === undefined) throw new Error('no rail link Inbox');
      fireEvent.click(inbox);
      expect((await findRow('Round or square corners?')).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
  });
});

describe('knowledge on cards', () => {
  const project = projectViewDto({ areas: [{ name: 'api', globs: ['src/api/**'] }] });
  const base = proposalDto();
  const proposal = proposalDto({
    projectId: project.id,
    principle: base.principle
      ? {
          ...base.principle,
          statement: 'Never sleep in tests',
          kind: 'policy',
          scope: 'project',
          area: 'api',
        }
      : null,
  });
  const principleCard = inboxItemDto({
    kind: 'proposal',
    projectId: project.id,
    title: 'No sleeps in tests',
    body: 'Never sleep in tests\n\nKind: policy. Key: testing.no-sleeps. Proposed for this project.',
    options: [
      { label: 'accept_project', description: 'Confirm it for this project' },
      { label: 'accept_you', description: 'Confirm it for you, in every project' },
      { label: 'accept_area', description: 'Confirm it for the api area of this project' },
      { label: 'reject', description: 'Reject it; it stays on record as withdrawn' },
    ],
    recommendation: 'accept_project',
    detail: { proposalId: proposal.id, principleId: proposal.principle?.id ?? null },
  });

  const serveProject = (proposals = [proposal]): void => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/proposals'), () => HttpResponse.json(proposals)),
    );
  };

  it('shows a principle proposal with its statement, kind and choices in words', async () => {
    inbox([principleCard]);
    serveProject();
    renderApp('/inbox');
    await findText('No sleeps in tests');
    const card = selectedCard();
    expect(within(card).getByText(/Never sleep in tests/)).toBeTruthy();
    expect(await within(card).findByText('Rule')).toBeTruthy();
    expect(await within(card).findByRole('radio', { name: /This Area \(api\)/ })).toBeTruthy();
    const names = ['This Project', 'All Projects', 'This Area (api)', 'Reject'];
    for (const name of names) {
      expect(within(card).getByText(name)).toBeTruthy();
    }
    // The stable verdict values never show.
    expect(card.textContent).not.toContain('accept_');
  });

  it('sends the stable verdict, with no record, for the words chosen', async () => {
    const { answers } = inbox([principleCard]);
    serveProject();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('radio', { name: /All Projects/ }));
    expect(screen.queryByRole('checkbox', { name: 'Record as a decision' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: principleCard.id, body: { choice: 'accept_you' } }]);
    });
  });

  it('words the area choice without a name while the proposal is not known', async () => {
    inbox([principleCard]);
    serveProject([]);
    renderApp('/inbox');
    expect(await screen.findByRole('radio', { name: /This Area/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /This Area \(/ })).toBeNull();
  });

  const queue = (category: InboxItemDto['category']): InboxItemDto =>
    inboxItemDto({
      projectId: project.id,
      category,
      title: 'Which queue?',
      options: [
        { label: 'BullMQ', description: '' },
        { label: 'pg-boss', description: '' },
        PARK_TASK_OPTION,
      ],
    });

  it.each([
    {
      name: 'a design question records for the project by default',
      category: 'design',
      act: 'none',
      record: { scope: 'project', area: null },
    },
    {
      name: 'an other question records nothing by default',
      category: 'other',
      act: 'none',
      record: null,
    },
    { name: 'unchecking skips the record', category: 'design', act: 'uncheck', record: null },
    {
      name: 'checking an other question records it for the project',
      category: 'other',
      act: 'check',
      record: { scope: 'project', area: null },
    },
    {
      name: 'choosing all my projects records it for the builder everywhere',
      category: 'product',
      act: 'you',
      record: { scope: 'you', area: null },
    },
    {
      name: 'choosing an area records it there',
      category: 'other',
      act: 'area',
      record: { scope: 'area', area: 'api' },
    },
  ] as const)('$name', async ({ category, act, record }) => {
    const card = queue(category);
    const { answers } = inbox([card]);
    serveProject();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('radio', { name: /pg-boss/ }));
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Record as a decision' });
    expect(box.checked).toBe(category !== 'other');
    if (act === 'uncheck') fireEvent.click(box);
    if ((act === 'check' || act === 'you' || act === 'area') && !box.checked) fireEvent.click(box);
    if (act === 'you' || act === 'area') {
      fireEvent.click(screen.getByRole('combobox', { name: 'Decision applies to' }));
      const name = act === 'you' ? 'All Projects' : 'Only in api';
      fireEvent.click(await screen.findByRole('option', { name, hidden: true }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: card.id, body: { choice: 'pg-boss', record } }]);
    });
  });

  it.each([
    ['product', true],
    ['design', true],
    ['engineering', true],
    ['business', true],
    ['access', false],
    ['other', false],
  ] as const)('checks Record as a decision for a %s question: %s', async (category, checked) => {
    inbox([queue(category)]);
    serveProject();
    renderApp('/inbox');
    const box = await screen.findByRole<HTMLInputElement>('checkbox', {
      name: 'Record as a decision',
    });
    expect(box.checked).toBe(checked);
  });

  it('sends a note beside the record', async () => {
    const card = queue('engineering');
    const { answers } = inbox([card]);
    serveProject();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('radio', { name: /BullMQ/ }));
    fireEvent.change(screen.getByLabelText('Note for the agent (optional)'), {
      target: { value: 'Redis is already deployed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    await waitFor(() => {
      expect(answers).toEqual([
        {
          id: card.id,
          body: {
            choice: 'BullMQ',
            note: 'Redis is already deployed',
            record: { scope: 'project', area: null },
          },
        },
      ]);
    });
  });

  it('keeps the keys working: a digit chooses and Enter sends with the record', async () => {
    const card = queue('design');
    const { answers } = inbox([card]);
    serveProject();
    renderApp('/inbox');
    await screen.findByRole('checkbox', { name: 'Record as a decision' });
    key('2');
    key('Enter');
    await waitFor(() => {
      expect(answers).toEqual([
        { id: card.id, body: { choice: 'pg-boss', record: { scope: 'project', area: null } } },
      ]);
    });
  });

  it('records nothing, and offers no record, when the answer is Park the task', async () => {
    const card = queue('design');
    const { answers } = inbox([card]);
    serveProject();
    renderApp('/inbox');
    expect(await screen.findByRole('checkbox', { name: 'Record as a decision' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Park the task/ }));
    expect(screen.queryByRole('checkbox', { name: 'Record as a decision' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: card.id, body: { choice: 'Park the task' } }]);
    });
  });

  it('keeps a record choice for its own card only', async () => {
    const first = queue('design');
    const second = inboxItemDto({ ...queue('product'), title: 'Which cache?' });
    inbox([first, second]);
    serveProject();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Record as a decision' }));
    key('j');
    await findText('Which cache?');
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Record as a decision' }).checked,
    ).toBe(true);
  });

  it('offers no decision control on a permission card', async () => {
    inbox([
      inboxItemDto({
        kind: 'permission',
        title: 'Run curl?',
        options: [
          { label: 'allow_once', description: '' },
          { label: 'deny', description: '' },
        ],
      }),
    ]);
    renderApp('/inbox');
    expect(await findText('Run curl?')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Record as a decision' })).toBeNull();
  });
});

describe('a resolved answer that proposed a principle', () => {
  const principleId = mintId('Principle');
  const proposed = [{ proposalId: mintId('Proposal'), principleId }];
  const answered = inboxItemDto({
    kind: 'question',
    state: 'RESOLVED',
    title: 'Which queue?',
    answer: { choice: 'pg-boss', note: 'Never add Redis for queues.' },
    detail: { proposedPrinciples: proposed },
    updatedAt: '2026-10-30T11:00:00.000Z',
  });
  const plain = inboxItemDto({
    kind: 'question',
    state: 'RESOLVED',
    title: 'Which badge color?',
    answer: { choice: 'Teal', note: 'Sounds good.' },
    updatedAt: '2026-10-30T10:00:00.000Z',
  });

  function serveResolved(resolved: InboxItemDto[]): void {
    serve(http.get(daemonUrl('/inbox'), () => HttpResponse.json([])));
    serveInboxRows({ resolved });
  }

  /** Opens Resolved and picks each row in turn; returns the details of the last row shown. */
  async function openResolved(count = 1): Promise<HTMLElement[]> {
    fireEvent.click(await screen.findByRole('radio', { name: 'Resolved' }));
    await panelRowTexts(count);
    for (const row of panelRows()) fireEvent.click(row);
    return screen.findAllByTestId('resolved-detail');
  }

  /** The principle as the daemon reports it, whatever became of its proposal. */
  function serveProvenance(...records: ProvenanceDto[]): void {
    server.use(
      http.get(daemonUrl('/projects/:projectId/knowledge'), () =>
        HttpResponse.json(knowledgeList()),
      ),
      http.get(daemonUrl('/principles/:id/provenance'), ({ params }) => {
        const record = records.find((r) => r.id === params['id']);
        return record
          ? HttpResponse.json(record)
          : HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }),
    );
  }

  const openDrawer = async (): Promise<HTMLElement> =>
    screen.findByRole('dialog', { name: 'Where it came from' });

  const selectedTab = (): string | null => screen.getByRole('tab', { selected: true }).textContent;

  async function clickOpenInKnowledge(): Promise<void> {
    renderApp('/inbox');
    await openResolved();
    fireEvent.click(await screen.findByRole('link', { name: 'Open in Knowledge' }));
  }

  it('says a principle was proposed, on the card that proposed it only', async () => {
    serveResolved([answered, plain]);
    renderApp('/inbox?state=resolved');
    fireEvent.click(await findPanelRow('Which queue?'));
    expect((await screen.findByTestId('resolved-detail')).textContent).toContain(
      'A principle was proposed',
    );
    fireEvent.click(await findPanelRow('Which badge color?'));
    expect(await findText('Answered: Teal')).toBeTruthy();
    expect(screen.getByTestId('resolved-detail').textContent).not.toContain('principle');
  });

  it('opens a principle still waiting for a verdict, under Pending', async () => {
    serveResolved([answered]);
    serveProvenance(
      provenanceDto({ id: principleId, state: 'proposed', text: 'Never add Redis for queues.' }),
    );
    await clickOpenInKnowledge();
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Never add Redis for queues.')).toBeTruthy();
    await waitFor(() => {
      expect(getText(/^Showing proposed principles/)).toBeTruthy();
    });
  });

  it('opens a principle accepted since the answer, over the Principles tab', async () => {
    serveResolved([answered]);
    serveProvenance(
      provenanceDto({ id: principleId, state: 'current', text: 'Never add Redis for queues.' }),
    );
    await clickOpenInKnowledge();
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Never add Redis for queues.')).toBeTruthy();
    expect(selectedTab()).toContain('Principles');
  });

  it('opens a principle rejected since the answer, saying it was withdrawn', async () => {
    serveResolved([answered]);
    serveProvenance(
      provenanceDto({
        id: principleId,
        state: 'withdrawn',
        text: 'Never add Redis for queues.',
        withdrawn: {
          at: '2026-10-30T12:00:00.000Z',
          by: 'me',
          reason: 'Rejected in the inbox',
          source: null,
        },
      }),
    );
    await clickOpenInKnowledge();
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Never add Redis for queues.')).toBeTruthy();
    expect(within(drawer).getByText('Rejected in the inbox')).toBeTruthy();
  });

  it('lands on the project of the card, not the selected one', async () => {
    const selected = projectViewDto({ name: 'Selected' });
    const other = projectViewDto({ name: 'Other' });
    const asked: string[] = [];
    serveResolved([inboxItemDto({ ...answered, projectId: other.id })]);
    serveProvenance(provenanceDto({ id: principleId, state: 'proposed' }));
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([selected, other])),
      http.get(daemonUrl('/projects/:projectId/proposals'), ({ params }) => {
        asked.push(String(params['projectId']));
        return HttpResponse.json([]);
      }),
    );
    await clickOpenInKnowledge();
    await openDrawer();
    await waitFor(() => {
      expect(asked).toContain(other.id);
    });
    expect(asked).not.toContain(selected.id);
  });

  it('forgets the link once the drawer closes, and keeps the shelf it opened on', async () => {
    serveResolved([answered]);
    serveProvenance(provenanceDto({ id: principleId, state: 'proposed' }));
    const { router } = renderApp('/inbox');
    await openResolved();
    fireEvent.click(await screen.findByRole('link', { name: 'Open in Knowledge' }));
    const drawer = await openDrawer();
    await waitFor(() => {
      expect(getText(/^Showing proposed principles/)).toBeTruthy();
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(getText(/^Showing proposed principles/)).toBeTruthy();
  });

  it('gives each principle its own link when an answer proposed several', async () => {
    const second = mintId('Principle');
    const two = inboxItemDto({
      ...answered,
      detail: {
        proposedPrinciples: [...proposed, { proposalId: mintId('Proposal'), principleId: second }],
      },
    });
    serveResolved([two]);
    serveProvenance(
      provenanceDto({ id: principleId, text: 'Never add Redis for queues.' }),
      provenanceDto({ id: second, text: 'Always keep queues in Postgres.' }),
    );
    renderApp('/inbox');
    const [row] = await openResolved();
    expect(row?.textContent).toContain('2 principles were proposed');
    expect(await screen.findByRole('link', { name: 'Open principle 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Open principle 2' }));
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Always keep queues in Postgres.')).toBeTruthy();
  });

  it('ignores a detail that is not a list of proposals', async () => {
    serveResolved([inboxItemDto({ ...answered, detail: { proposedPrinciples: 'nope' } })]);
    renderApp('/inbox');
    const [row] = await openResolved();
    expect(row?.textContent).not.toContain('principle');
  });
});

describe('Inbox across projects', () => {
  const alpha = projectViewDto({ name: 'alpha' });
  const beta = projectViewDto({ name: 'beta' });
  const cards = [
    inboxItemDto({ projectId: alpha.id, title: 'Alpha question?' }),
    inboxItemDto({ projectId: beta.id, title: 'Beta question?' }),
  ];

  function twoProjects(): void {
    inbox(cards);
    server.use(http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])));
  }

  it('shows every project’s cards, each naming its project', async () => {
    twoProjects();
    renderApp('/inbox');
    // A row's second line holds its project. The cards can arrive before the projects that name them,
    // so each row is waited on until it names its project.
    await waitFor(() => {
      expect(rowOf('Alpha question?').textContent).toContain('alpha');
    });
    await waitFor(() => {
      expect(rowOf('Beta question?').textContent).toContain('beta');
    });
    expect(screen.getByRole('radio', { name: /^Open\s?2$/ })).toBeTruthy();
  });

  it('narrows the rows by its own project filter', async () => {
    twoProjects();
    renderApp(`/inbox?project=${beta.id}`);
    expect(await findRow('Beta question?')).toBeTruthy();
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(
      await screen.findByRole('menuitem', { name: 'beta', current: true, hidden: true }),
    ).toBeTruthy();
  });
});

describe('the Inbox panel', () => {
  const question = (title: string, at = 0): InboxItemDto =>
    inboxItemDto({
      kind: 'question',
      title,
      body: '',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      createdAt: new Date(Date.UTC(2026, 9, 13, 12, 0, at)).toISOString(),
    });
  const numbered = (count: number): InboxItemDto[] =>
    Array.from({ length: count }, (_, i) => question(`Card ${String(i)}`, i));

  afterEach(resetViewportWidth);

  it('selects the row after an answered one', async () => {
    const [a, b, c] = [
      question('First?', 0),
      question('Second?', 1),
      question('Third?', 2),
    ] as const;
    const { answers } = inbox([a, b, c]);
    renderApp('/inbox');
    await findText('First?');
    key('j');
    await findText('Second?');
    key('1');
    key('Enter');
    await waitFor(() => {
      expect(selectedCard().textContent).toContain('Third?');
    });
    expect(answers).toEqual([{ id: b.id, body: { choice: 'A', record: null } }]);
    expect(rows()).toHaveLength(2);
  });

  it('selects the next row, and drops the draft, when an event resolves the selected card', async () => {
    const [a, b] = [question('First?', 0), question('Second?', 1)] as const;
    const { answers, served } = inbox([a, b]);
    const sockets: { send: (data: string) => void }[] = [];
    server.use(
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    renderApp('/inbox');
    await findText('First?');
    key('1');
    fireEvent.change(screen.getByLabelText('Note for the agent (optional)'), {
      target: { value: 'half written' },
    });
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    served.open = [b];
    act(() => {
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({ seq: 1, type: 'inbox.changed', entityType: 'inbox', entityId: a.id }),
        ),
      );
    });
    await waitFor(() => {
      expect(selectedCard().textContent).toContain('Second?');
    });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Note for the agent (optional)').value).toBe(
      '',
    );
    expect(within(selectedCard()).queryByRole('radio', { checked: true })).toBeNull();
    expect(answers).toEqual([]);
  });

  describe('paging with the keys', () => {
    const pageTwo = (query: Record<string, string>): boolean => query['after'] !== undefined;
    const pageTwoReads = (asked: Record<string, string>[]): number => asked.filter(pageTwo).length;
    const viewport = (): HTMLElement => {
      const el = screen
        .getByRole('listbox', { name: 'Inbox' })
        .closest('[data-scrollarea-viewport]');
      if (!(el instanceof HTMLElement)) throw new Error('no viewport');
      return el;
    };
    const toEnd = (): void => {
      viewport().scrollTop = 60 * 52;
      fireEvent.scroll(viewport());
    };
    /** Moves to the last of the 50 loaded rows. */
    const toLastLoaded = (): void => {
      for (let i = 0; i < 49; i += 1) key('j');
    };

    it('reads page two on j past the loaded end, shows a placeholder, then selects the next row', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const all = numbered(52);
      const asked: Record<string, string>[] = [];
      inbox(all, (query) => {
        asked.push(query);
        return pageTwo(query) ? gate : undefined;
      });
      renderApp('/inbox');
      await findText('Card 0');
      toLastLoaded();
      expect(selectedCard().textContent).toContain('Card 49');
      expect(pageTwoReads(asked)).toBe(0);

      key('j');
      await waitFor(() => {
        expect(pageTwoReads(asked)).toBe(1);
      });
      // Another j while the page is on its way asks for nothing and moves once when it lands.
      key('j');
      toEnd();
      expect(await screen.findByText('Loading more')).toBeTruthy();
      expect(selectedCard().textContent).toContain('Card 49');
      expect(pageTwoReads(asked)).toBe(1);

      release();
      await waitFor(() => {
        expect(selectedCard().textContent).toContain('Card 50');
      });
      expect(selectedCard().textContent).not.toContain('Card 51');
      expect(pageTwoReads(asked)).toBe(1);
    });

    it('drops the pending move when the builder picks another row before the page lands', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const asked: Record<string, string>[] = [];
      inbox(numbered(52), (query) => {
        asked.push(query);
        return pageTwo(query) ? gate : undefined;
      });
      const { queryClient } = renderApp('/inbox');
      await findText('Card 0');
      toLastLoaded();
      key('j');
      await waitFor(() => {
        expect(pageTwoReads(asked)).toBe(1);
      });
      key('k');
      expect(selectedCard().textContent).toContain('Card 48');
      release();
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });
      expect(selectedCard().textContent).toContain('Card 48');
    });

    it('does nothing at the true end, and leaves the arrow its default', async () => {
      const asked: Record<string, string>[] = [];
      inbox(numbered(2), (query) => {
        asked.push(query);
        return undefined;
      });
      renderApp('/inbox');
      await findText('Card 0');
      key('j');
      expect(selectedCard().textContent).toContain('Card 1');
      key('j');
      expect(selectedCard().textContent).toContain('Card 1');
      expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true);
      expect(pageTwoReads(asked)).toBe(0);
    });

    it('says a page failed, keeps the selection, and drops the move', async () => {
      const asked: Record<string, string>[] = [];
      inbox(numbered(52), (query) => {
        asked.push(query);
        return pageTwo(query) ? Promise.reject(new Error('offline')) : undefined;
      });
      renderApp('/inbox');
      await findText('Card 0');
      toLastLoaded();
      key('j');
      await waitFor(() => {
        expect(pageTwoReads(asked)).toBe(1);
      });
      toEnd();
      expect(await screen.findByText("Couldn't load more")).toBeTruthy();
      expect(selectedCard().textContent).toContain('Card 49');
      // The move was dropped with the page: nothing moves later, and the next j asks again.
      expect(selectedCard().textContent).not.toContain('Card 50');
      key('j');
      await waitFor(() => {
        expect(pageTwoReads(asked)).toBe(2);
      });
    });
  });

  it('selects the next row when a 10db card leaves', async () => {
    const check = (tools: unknown[]): void => {
      server.use(
        http.get(daemonUrl('/system'), () =>
          HttpResponse.json(
            SystemCheckDto.parse({
              loginEnv: { source: 'login_shell', warning: null },
              claudeCode: { verifiedOn: '2.1.302', warning: null },
              codex: { verifiedOn: '0.167.0', warning: null },
              tools,
            }),
          ),
        ),
      );
    };
    inbox([color, corners]);
    check([{ name: 'git', path: null, version: null, required: true, signedIn: null }]);
    const { queryClient } = renderApp('/inbox');
    expect(await findText('git was not found where 10db looks for it')).toBeTruthy();
    expect(rows()).toHaveLength(3);

    check([]);
    await queryClient.invalidateQueries({ queryKey: queryKeys.system });
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    expect(selectedCard().textContent).toContain('Which badge color?');
  });

  describe("a question's last messages", () => {
    const at = '2026-10-13T12:00:00.000Z';

    it('shows up to three lines as text, and none for a flag', async () => {
      const asked: string[] = [];
      inbox([color, flag('Write outside every claim', 'docs/notes.md')]);
      server.use(
        http.get(daemonUrl('/inbox/:id/context'), ({ params }) => {
          asked.push(String(params['id']));
          return HttpResponse.json({
            messages: [
              { author: 'builder', text: 'Use teal', at },
              { author: 'agent', text: '<b>Teal</b> it is', at },
            ],
          });
        }),
      );
      renderApp('/inbox');
      await findText('Last messages');
      expect(getText('You: Use teal')).toBeTruthy();
      expect(getText('Agent: <b>Teal</b> it is')).toBeTruthy();
      expect(selectedCard().querySelector('b')).toBeNull();

      key('j');
      await findText('docs/notes.md');
      expect(queryText('Last messages')).toBeNull();
      expect(asked).toEqual([color.id]);
    });

    it('shows nothing while it loads, and nothing when it is empty', async () => {
      inbox([color]);
      renderApp('/inbox');
      await findText('Which badge color?');
      await waitFor(() => {
        expect(screen.queryByRole('progressbar')).toBeNull();
      });
      expect(queryText('Last messages')).toBeNull();
    });
  });

  it("shows the session's title on line 2 of a chat's card", async () => {
    const chat = chatDto({ projectId: project, title: 'Login fails after sleep' });
    const card = inboxItemDto({
      kind: 'question',
      title: 'Which fix?',
      body: 'Pick one.',
      projectId: project,
      detail: { conversationId: chat.conversationId },
    });
    inbox([card]);
    server.use(http.get(daemonUrl('/chats'), () => HttpResponse.json([chat])));
    renderApp('/inbox');
    const row = await findRow('Which fix?');
    await waitFor(() => {
      expect(row.textContent).toContain('Login fails after sleep');
    });
    expect(row.textContent).toContain('Chat');
    expect(row.textContent).not.toContain('Pick one.');
  });

  it('closes the panel sheet when a row is picked, though the page stays', async () => {
    viewportWidth(800);
    inbox([color, corners]);
    const { router } = renderApp('/inbox');
    await findText('Which badge color?');
    const panel = (): string | null =>
      document.querySelector('[data-panel]')?.getAttribute('data-panel') ?? null;
    fireEvent.keyDown(document, { key: '\\', metaKey: true });
    await waitFor(() => {
      expect(panel()).toBe('sheet');
    });

    fireEvent.click(await findRow('Round or square corners?'));
    await waitFor(() => {
      expect(panel()).toBe('hidden');
    });
    expect(router.state.location.pathname).toBe('/inbox');
    expect(selectedCard().textContent).toContain('Round or square corners?');
  });

  describe("the head's state switch", () => {
    const sent = inboxItemDto({
      title: 'Which tone?',
      send: sendDto({ state: 'sent', sentAt: '2026-10-13T12:00:00.000Z' }),
    });

    it('counts Open in attention and Waiting only while Slack is connected', async () => {
      serve();
      serveInboxRows({ open: [color, corners], waiting: [sent] });
      server.use(
        http.get(daemonUrl('/slack'), () =>
          HttpResponse.json(slackConnection({ state: 'connected', teamName: 'Acme' })),
        ),
      );
      renderApp('/inbox');
      expect(await screen.findByRole('radio', { name: /^Open\s?2$/ })).toBeTruthy();
      expect(await screen.findByRole('radio', { name: /^Waiting\s?1$/ })).toBeTruthy();
      expect(screen.getByRole('radio', { name: 'Resolved' })).toBeTruthy();
    });

    it('shows no Waiting count while Slack is off', async () => {
      serve();
      serveInboxRows({ open: [color], waiting: [sent] });
      renderApp('/inbox');
      await screen.findByRole('radio', { name: /^Open\s?1$/ });
      expect(screen.getByRole('radio', { name: 'Waiting' })).toBeTruthy();
    });

    it('changes the state in the URL', async () => {
      inbox([color]);
      const { router } = renderApp('/inbox');
      fireEvent.click(await screen.findByRole('radio', { name: 'Waiting' }));
      await waitFor(() => {
        expect(router.state.location.search).toEqual({ state: 'waiting' });
      });
      fireEvent.click(screen.getByRole('radio', { name: /^Open/ }));
      await waitFor(() => {
        expect(router.state.location.search).toEqual({});
      });
    });
  });
});

describe('leaving the Inbox and coming back', () => {
  const question = (title: string, at: number): InboxItemDto =>
    inboxItemDto({
      kind: 'question',
      title,
      body: '',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      projectId: project,
      createdAt: new Date(Date.UTC(2026, 9, 13, 12, 0, at)).toISOString(),
    });
  const four = [
    question('One?', 0),
    question('Two?', 1),
    question('Three?', 2),
    question('Four?', 3),
  ];
  const viewport = (): HTMLElement => {
    const el = document.querySelector('[data-inbox-list] .mantine-ScrollArea-viewport');
    if (!(el instanceof HTMLElement)) throw new Error('no list viewport');
    return el;
  };
  const railLink = (name: string): HTMLElement => {
    const link = [...document.querySelectorAll<HTMLElement>('a[data-rail-item]')].find((a) =>
      a.textContent.startsWith(name),
    );
    if (link === undefined) throw new Error(`no rail link ${name}`);
    return link;
  };

  afterEach(() => {
    lastInboxSearch.set({});
    for (const state of ['open', 'waiting', 'resolved'] as const) {
      rememberSelected(state, null);
      rememberScroll(state, 0);
    }
  });

  it('keeps the filter, the selected row and the scroll through the rail', async () => {
    const { served } = inbox(four);
    const asked = serveInboxRows(served);
    const { router } = renderApp(`/inbox?project=${project}`);
    await findText('One?');
    fireEvent.click(await findRow('Three?'));
    await waitFor(() => {
      expect(selectedCard().textContent).toContain('Three?');
    });
    viewport().scrollTop = 80;
    fireEvent.scroll(viewport());

    fireEvent.click(railLink('Board'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
    fireEvent.click(railLink('Inbox'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/inbox');
    });
    expect(router.state.location.search).toEqual({ project });
    await findRow('Three?');
    await waitFor(() => {
      expect(selectedCard().textContent).toContain('Three?');
    });
    expect(viewport().scrollTop).toBe(80);
    expect(asked.length).toBeGreaterThan(0);
  });

  it('shows the list without a card resolved while away, and asks for nothing while away', async () => {
    const { served } = inbox(four);
    const sockets: { send: (data: string) => void }[] = [];
    server.use(
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    const asked = serveInboxRows(served);
    const { router } = renderApp('/inbox');
    await findText('One?');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    fireEvent.click(railLink('Board'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
    const before = asked.length;
    const gone = four[1];
    if (gone === undefined) throw new Error('no card');
    served.open = four.filter((card) => card.id !== gone.id);
    act(() => {
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({ seq: 1, type: 'inbox.changed', entityType: 'inbox', entityId: gone.id }),
        ),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked.slice(before).filter((q) => q['card'] !== undefined)).toEqual([]);

    fireEvent.click(railLink('Inbox'));
    await findRow('One?');
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(rows().some((row) => row.textContent.includes('Two?'))).toBe(false);
  });

  it('puts focus on the selected row when arriving, so j moves at once', async () => {
    inbox(four);
    const { router } = renderApp('/board');
    await waitFor(() => {
      expect(railLink('Inbox')).toBeTruthy();
    });
    fireEvent.click(railLink('Inbox'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/inbox');
    });
    await findRow('One?');
    await waitFor(() => {
      expect(document.activeElement).toBe(rowOf('One?'));
    });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'j' });
    await waitFor(() => {
      expect(selectedCard().textContent).toContain('Two?');
    });
    expect(document.activeElement).toBe(rowOf('Two?'));
  });

  it('leaves focus alone when the builder is somewhere else', async () => {
    inbox(four);
    renderApp('/inbox');
    await findText('One?');
    const field = screen.getByLabelText('Note for the agent (optional)');
    field.focus();
    key('j');
    await findText('Two?');
    // The next card is a new card with its own fields, so the old one goes; focus is not pulled onto a row.
    expect(document.activeElement).not.toBe(rowOf('Two?'));
  });

  it('asks for the next question row context before that row is selected', async () => {
    const contexts: string[] = [];
    inbox(four);
    server.use(
      http.get(daemonUrl('/inbox/:id/context'), ({ params }) => {
        contexts.push(String(params['id']));
        return HttpResponse.json({ messages: [] });
      }),
    );
    renderApp('/inbox');
    await findText('One?');
    const [one, two, three] = four;
    await waitFor(() => {
      expect(contexts).toContain(two?.id);
    });
    expect(contexts).not.toContain(three?.id);
    expect(contexts).toContain(one?.id);
  });
});

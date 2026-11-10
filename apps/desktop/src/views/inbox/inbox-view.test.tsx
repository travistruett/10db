import {
  mintId,
  PARK_TASK_OPTION,
  PASS_SIGN_OFF_CHOICE,
  SHARED_ASK_ALLOW_CHOICE,
  SHARED_ASK_KEEP_CHOICE,
  SHARED_ASK_REPLY_CHOICE,
  type InboxItemDto,
  type ProvenanceDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../daemon/queries';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { batchDto, inboxItemDto, projectViewDto } from '../../test/fixtures';
import { knowledgeList, proposalDto, provenanceDto } from '../../test/knowledge-fixtures';

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  server.use(...overrides);
}

/** Serves `items` as the open inbox and records every answer posted. */
function inbox(items: InboxItemDto[]): { answers: { id: string; body: unknown }[] } {
  const answers: { id: string; body: unknown }[] = [];
  serve(
    http.get(daemonUrl('/inbox'), () =>
      HttpResponse.json(items.filter((item) => !answers.some((a) => a.id === item.id))),
    ),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      const id = String(params['id']);
      answers.push({ id, body: await request.json() });
      const item = items.find((i) => i.id === id);
      return HttpResponse.json({ ...item, state: 'ANSWERED' });
    }),
  );
  return { answers };
}

const key = (k: string, init: { shiftKey?: boolean } = {}): void => {
  fireEvent.keyDown(document.body, { key: k, ...init });
};

/** The option groups of the cards, not the header's Open/Resolved switch. */
function optionGroups(): HTMLElement[] {
  return screen
    .getAllByRole('radiogroup')
    .filter((g) => g.getAttribute('aria-label') !== 'Inbox view');
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

describe('InboxView review findings', () => {
  it('shows each finding with its severity and file:line on a failed card', async () => {
    inbox([rejectedCard]);
    renderApp('/inbox');
    await screen.findByText(rejectedCard.title);
    const card = selectedCard();
    expect(within(card).getByText('BLOCKING')).toBeTruthy();
    expect(within(card).getByText('apps/daemon/src/runner/runner.ts:673')).toBeTruthy();
    expect(within(card).getByText('NOTE')).toBeTruthy();
  });

  it('keeps the full review one click away', async () => {
    inbox([rejectedCard]);
    renderApp('/inbox');
    await screen.findByText(rejectedCard.title);
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
    await screen.findByText(rejectedCard.title);
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
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('moves with j/k, chooses with a digit and sends with Enter', async () => {
    const { answers } = inbox([color, corners]);
    renderApp('/inbox');
    expect(await screen.findByText('Which badge color?')).toBeTruthy();

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
    await screen.findByText('Which badge color?');

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
    await screen.findByText('Which badge color?');
    key('Enter');
    expect(await screen.findByText('Choose an option first (1–5).')).toBeTruthy();
    expect(answers).toEqual([]);
  });

  it('shows the four permission choices in words and sends the chosen value', async () => {
    const permission = inboxItemDto({
      kind: 'permission',
      title: 'Allow Bash?',
      body: 'curl -s https://example.com',
      category: 'environment',
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

    expect(await screen.findByText('curl -s https://example.com')).toBeTruthy();
    for (const name of [
      'Allow once',
      'Allow for this workstream',
      'Always allow in this project',
      'Deny',
    ]) {
      expect(screen.getByRole('radio', { name: new RegExp(`^\\d?\\s*${name}`) })).toBeTruthy();
    }
    expect(screen.getByText('Always allow in this project (records a decision)')).toBeTruthy();
    expect(screen.queryByText('allow_workstream')).toBeNull();

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
      category: 'environment',
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
    await screen.findByText('Allow mcp__aws-billing__credits?');
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

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<b>Bold</b> question')).toBeTruthy();
    expect(screen.getByText('<script>x</script>')).toBeTruthy();
    expect(screen.getByText('<i>desc</i>')).toBeTruthy();
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

    fireEvent.click(await screen.findByText(card.title));
    await screen.findByText('Failing:', { exact: false });
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

    fireEvent.click(await screen.findByText(card.title));
    await screen.findByText('Choose a model for each tier', { exact: false });
    const anchor = screen.queryByRole('link', { name: 'Open Accounts in Settings' });
    if (shown) expect(anchor?.getAttribute('href')).toBe('/settings/accounts');
    else expect(anchor).toBeNull();
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

    fireEvent.click(await screen.findByText(card.title));
    await screen.findByText('Failed steps:', { exact: false });
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

      fireEvent.click(await screen.findByText(card.title));
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
    fireEvent.click(await screen.findByText(card.title));
    await screen.findByText('Last output:');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abandon' })).toBeNull();
  });

  it('explains a card answered elsewhere and refreshes the list', async () => {
    let gets = 0;
    serve(
      http.get(daemonUrl('/inbox'), () => {
        gets += 1;
        return HttpResponse.json([color]);
      }),
      http.post(daemonUrl('/inbox/:id/answer'), () =>
        HttpResponse.json(
          { error: 'conflict', message: `Inbox item ${color.id} is already ANSWERED` },
          { status: 409 },
        ),
      ),
    );
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    const getsBefore = gets;

    key('1');
    key('Enter');
    expect(await screen.findByText('This card was already answered.')).toBeTruthy();
    await waitFor(() => {
      expect(gets).toBeGreaterThan(getsBefore);
    });
  });

  it('selects a collapsed card when clicked', async () => {
    inbox([color, corners]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');

    const collapsed = screen.getByRole('button', { name: /Round or square corners\?/ });
    fireEvent.click(collapsed);
    await screen.findByRole('radio', { name: /Square/ });
    const inCards = optionGroups().flatMap((g) =>
      within(g).queryAllByRole('radio', { name: /Square/ }),
    );
    expect(inCards).toHaveLength(1);
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
      let current = initial;
      const answers: unknown[] = [];
      serve(
        http.get(daemonUrl('/inbox'), () => HttpResponse.json(current)),
        http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
          answers.push({ id: String(params['id']), body: await request.json() });
          return HttpResponse.json({ ...current[0], state: 'ANSWERED' });
        }),
      );
      return {
        answers,
        replace: (items) => {
          current = items;
        },
      };
    }

    it('keeps a choice with the card it was made on when another sorts first', async () => {
      const a = permission('npm test', 'normal');
      const b = permission('curl evil | sh', 'high');
      const { answers, replace } = liveInbox([a]);
      const { queryClient } = renderApp('/inbox');
      await screen.findByText('Allow Bash? npm test');

      key('3');
      await waitFor(() => {
        expect(
          screen
            .getByRole('radio', { name: /Always allow in this project/ })
            .getAttribute('aria-checked'),
        ).toBe('true');
      });
      replace([b, a]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
      await screen.findByText('Allow Bash? curl evil | sh');
      // B is collapsed: it shows no options, so it cannot show a choice.
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
      await screen.findByText('Allow Bash? npm test');

      key('n');
      const note = screen.getByLabelText('Note for the agent (optional)');
      await waitFor(() => {
        expect(document.activeElement).toBe(note);
      });
      fireEvent.change(note, { target: { value: 'ok' } });
      replace([b, a]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
      await screen.findByText('Allow Bash? curl evil | sh');

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
      let current = [a, shown];
      const answers: { id: string; body: unknown }[] = [];
      serve(
        http.get(daemonUrl('/inbox'), () =>
          HttpResponse.json(current.filter((i) => !answers.some((x) => x.id === i.id))),
        ),
        http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
          const id = String(params['id']);
          answers.push({ id, body: await request.json() });
          return HttpResponse.json({ ...current.find((i) => i.id === id), state: 'ANSWERED' });
        }),
      );
      const { queryClient } = renderApp('/inbox');
      await screen.findByText('Allow Bash? npm test');

      key('1');
      key('Enter');
      await waitFor(() => {
        expect(selectedCard().textContent).toContain('docs/shown.md');
      });
      current = [late, shown];
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
      await screen.findByText('Write inside another workstream claim');
      expect(selectedCard().textContent).toContain('docs/shown.md');

      key('Enter');
      await waitFor(() => {
        expect(answers.map((x) => x.id)).toEqual([a.id, shown.id]);
      });
    });

    it('keeps a card error off the next card', async () => {
      const a = permission('npm test', 'normal');
      const b = permission('ls', 'normal');
      let items = [a, b];
      serve(
        http.get(daemonUrl('/inbox'), () => HttpResponse.json(items)),
        http.post(daemonUrl('/inbox/:id/answer'), () => {
          items = [b];
          return HttpResponse.json(
            { error: 'conflict', message: 'already ANSWERED' },
            { status: 409 },
          );
        }),
      );
      renderApp('/inbox');
      await screen.findByText('Allow Bash? npm test');
      key('1');
      key('Enter');
      await waitFor(() => {
        expect(screen.queryByText('Allow Bash? npm test')).toBeNull();
      });
      expect(await screen.findByText('Allow Bash? ls')).toBeTruthy();
      expect(screen.queryByText('This card was already answered.')).toBeNull();
    });

    it('does not send a choice that is not one of the card options', async () => {
      const { answers } = inbox([color]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      key('4');
      key('Enter');
      expect(await screen.findByText('Choose an option first (1–5).')).toBeTruthy();
      expect(answers).toEqual([]);
    });
  });

  describe('keys outside the selected card', () => {
    it('leaves Enter on a focused collapsed card to select it', async () => {
      const { answers } = inbox([color, corners]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      const collapsed = screen.getByRole('button', { name: /Round or square corners\?/ });
      collapsed.focus();
      expect(fireEvent.keyDown(collapsed, { key: 'Enter' })).toBe(true);
      expect(answers).toEqual([]);
    });

    it('leaves Enter on a navigation link alone', async () => {
      const { answers } = inbox([color]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
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
      await screen.findByText('Which badge color?');
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
      await screen.findByText('Which badge color?');
      // fireEvent answers false when the default action was cancelled.
      expect(fireEvent.keyDown(document.body, { key: 'ArrowUp' })).toBe(true);
      expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(false);
      expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
      expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true);
    });

    it('shows no line of shortcut instructions', async () => {
      inbox([color]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      expect(screen.queryByText(/to move/)).toBeNull();
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
      await screen.findByText('Which badge color?');

      const help = screen.getByRole('button', { name: 'Keyboard shortcuts' });
      help.focus();
      fireEvent.click(help);
      const list = await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' });
      for (const action of [
        'Move between cards',
        'Choose an option',
        'Write a note',
        'Send the answer, or dismiss a flag',
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
    it('shows what a collapsed flag is about', async () => {
      inbox([color, flag('Write outside every claim', 'docs/notes.md (main checkout)')]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      const row = screen.getByRole('button', { name: /Write outside every claim/ });
      expect(row.textContent).toContain('docs/notes.md (main checkout)');
    });

    it('dismisses a collapsed flag from its row without opening it', async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      const { answers } = inbox([color, stray]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => {
        expect(answers).toEqual([{ id: stray.id, body: { choice: 'dismissed' } }]);
      });
      expect(selectedCard().textContent).toContain('Which badge color?');
    });

    it('groups identical flags into one row with a count, and dismisses them together', async () => {
      const copies = [1, 2, 3].map(() => flag('MCP server failed', 'mantine exited'));
      const { answers } = inbox([color, ...copies]);
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      const rows = screen.getAllByRole('button', { name: /MCP server failed/ });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain('×3');

      key('j');
      expect(selectedCard().textContent).toContain('MCP server failed');
      fireEvent.click(within(selectedCard()).getByRole('button', { name: /Dismiss All/ }));
      await waitFor(() => {
        expect(answers).toEqual(copies.map((c) => ({ id: c.id, body: { choice: 'dismissed' } })));
      });
    });

    it('says in words how many identical cards a folded row holds', async () => {
      const copies = [1, 2].map(() => flag('Batch not started', 'no lane free'));
      inbox([color, ...copies]);
      renderApp('/inbox');
      await screen.findByText('Batch not started');
      expect(screen.getByText('2 identical flags')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dismiss All' })).toBeTruthy();
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
      await screen.findByText('Which badge color?');
      for (const text of ['Flag', '×2']) {
        const badge = screen.getByText(text).closest('.mantine-Badge-root');
        expect(badge?.getAttribute('style')).toContain('flex-shrink: 0');
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
      await screen.findByText('Write outside every claim');
      const badge = within(selectedCard()).getByText('Flag').closest('.mantine-Badge-root');
      expect(badge?.getAttribute('style')).toContain('yellow');
    });

    it("keeps the open card's draft when a collapsed flag fails to dismiss, and says so beside it", async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      serve(
        http.get(daemonUrl('/inbox'), () => HttpResponse.json([color, stray])),
        http.post(daemonUrl('/inbox/:id/answer'), () =>
          HttpResponse.json({ error: 'internal', message: 'The daemon broke' }, { status: 500 }),
        ),
      );
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      key('2');
      const note = screen.getByLabelText('Note for the agent (optional)');
      fireEvent.change(note, { target: { value: 'half written' } });

      const row = screen.getByRole('button', { name: /Write outside every claim/ }).parentElement;
      if (!row) throw new Error('the flag row has no container');
      fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));

      expect(await within(row).findByText('The daemon broke')).toBeTruthy();
      expect(screen.getByRole('radio', { name: /Red/ }).getAttribute('aria-checked')).toBe('true');
      expect(
        screen.getByLabelText<HTMLTextAreaElement>('Note for the agent (optional)').value,
      ).toBe('half written');
    });

    it('keeps a group selected while its flags are dismissed, and shows a failure on it', async () => {
      const copies = [1, 2, 3].map(() => flag('MCP server failed', 'mantine exited'));
      const answered: string[] = [];
      serve(
        http.get(daemonUrl('/inbox'), () =>
          HttpResponse.json([color, ...copies].filter((i) => !answered.includes(i.id))),
        ),
        http.post(daemonUrl('/inbox/:id/answer'), ({ params }) => {
          const id = String(params['id']);
          if (id === copies[1]?.id)
            return HttpResponse.json(
              { error: 'internal', message: 'The daemon broke' },
              { status: 500 },
            );
          answered.push(id);
          return HttpResponse.json({ ...copies.find((c) => c.id === id), state: 'RESOLVED' });
        }),
      );
      renderApp('/inbox');
      await screen.findByText('Which badge color?');
      key('j');
      expect(selectedCard().textContent).toContain('MCP server failed');
      key('Enter');

      expect(await within(selectedCard()).findByText('The daemon broke')).toBeTruthy();
      expect(selectedCard().textContent).toContain('×2');
      expect(answered).toEqual([copies[0]?.id]);
    });

    it('refreshes the list when a flag was already closed elsewhere', async () => {
      const stray = flag('Write outside every claim', 'docs/notes.md');
      let closed = false;
      serve(
        http.get(daemonUrl('/inbox'), () => HttpResponse.json(closed ? [] : [stray])),
        http.post(daemonUrl('/inbox/:id/answer'), () => {
          closed = true;
          return HttpResponse.json(
            { error: 'conflict', message: `Inbox item ${stray.id} is already RESOLVED` },
            { status: 409 },
          );
        }),
      );
      renderApp('/inbox');
      await screen.findByText('Write outside every claim');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    });
  });
});

// Workbench spec §6.1: a pass's Ready pages are one row, which offers neither Approve nor Send Back.
describe("a Workbench pass's Ready pages", () => {
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

  it('show as one row naming each page, with no Approve or Send Back', async () => {
    const { answers } = inbox([ready('Ready: Settings'), ready('Ready: People')]);
    renderApp('/inbox');
    expect(await screen.findByText('Workbench: 2 pages ready')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Open 1' })).toBeTruthy();
    const card = selectedCard();
    expect(within(card).getByText('Ready: Settings')).toBeTruthy();
    expect(within(card).getByText('Ready: People')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send Back/ })).toBeNull();
    key('Enter');
    expect(answers).toEqual([]);
  });
});

describe("a Workbench pass's shared-area question", () => {
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
    expect(await screen.findByText('People wants to change shared code in src')).toBeTruthy();
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
    updatedAt: '2026-10-30T11:00:00.000Z',
  });

  /** Serves the open and resolved lists; returns the `recent` count each resolved request asked for. */
  function serveBoth(open: InboxItemDto[], resolved: InboxItemDto[]): (string | null)[] {
    const recent: (string | null)[] = [];
    serve(
      http.get(daemonUrl('/inbox'), ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.get('state') !== 'RESOLVED') return HttpResponse.json(open);
        recent.push(params.get('recent'));
        return HttpResponse.json(resolved);
      }),
    );
    return recent;
  }

  it('draws the same header on Open and Resolved: title, Open n / Resolved switch, a ? button', async () => {
    serveBoth([color], [answered]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');

    const title = screen.getByRole('heading', { name: 'Inbox' });
    const switcher = screen.getByRole('radiogroup', { name: 'Inbox view' });
    const openRadio = screen.getByRole('radio', { name: 'Open 1' });
    expect((openRadio as HTMLInputElement).checked).toBe(true);
    const help = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    expect(help.getAttribute('data-size')).toBe('xs');
    expect(help.getAttribute('data-variant')).toBe('subtle');

    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    await screen.findAllByTestId('resolved-card');

    // The same elements stay mounted, so nothing in the header moves or resizes.
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBe(title);
    expect(screen.getByRole('radiogroup', { name: 'Inbox view' })).toBe(switcher);
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBe(help);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Resolved' }).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Open 1' })).toBeTruthy();
  });

  it('keeps the ? key on Open only', async () => {
    serveBoth([color], [answered]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    await screen.findAllByTestId('resolved-card');
    key('?', { shiftKey: true });
    expect(screen.queryByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeNull();
  });

  it('lists resolved cards, newest first, saying who closed each and why', async () => {
    const recent = serveBoth([color], [closedBy10db, answered]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    fireEvent.click(screen.getByRole('radio', { name: /^Resolved/ }));

    const rows = await screen.findAllByTestId('resolved-card');
    // Only the most recent ones are fetched: the resolved list only grows.
    expect(recent).toEqual(['100']);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Which badge color?'),
      expect.stringContaining('Batch not started: 10db will not run git in /repo'),
    ]);
    expect(rows[0]?.textContent).toContain('Answered: Teal');
    expect(rows[1]?.textContent).toContain('Resolved by 10db: Alpha started');
    // The open cards and their keys are not there.
    expect(screen.queryByRole('button', { name: 'Send Answer' })).toBeNull();
  });

  it('says an answer in the words the card offered it', async () => {
    const closedProposal = (choice: string): InboxItemDto =>
      inboxItemDto({
        kind: 'proposal',
        state: 'RESOLVED',
        title: 'Tests never sleep',
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
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('radio', { name: /^Resolved/ }));
    await screen.findAllByTestId('resolved-card');
    for (const words of [
      'Answered: This Project',
      'Answered: All Projects',
      'Answered: This Area',
      'Answered: Reject',
      'Answered: Allow once',
      'Answered: Violet',
    ]) {
      expect(screen.getByText(words)).toBeTruthy();
    }
    expect(screen.queryByText(/accept_|allow_once/)).toBeNull();
  });

  it('says so when nothing has been resolved', async () => {
    serveBoth([color], []);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    fireEvent.click(screen.getByRole('radio', { name: /^Resolved/ }));
    expect(await screen.findByText('Nothing has been resolved yet.')).toBeTruthy();
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
    await screen.findByText('No sleeps in tests');
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
    ['environment', false],
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
    await screen.findByText('Which cache?');
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
    expect(await screen.findByText('Run curl?')).toBeTruthy();
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
    serve(
      http.get(daemonUrl('/inbox'), ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('state') === 'RESOLVED' ? resolved : [],
        ),
      ),
    );
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
    fireEvent.click(await screen.findByRole('radio', { name: 'Resolved' }));
    await screen.findAllByTestId('resolved-card');
    fireEvent.click(screen.getByRole('link', { name: 'Open in Knowledge' }));
  }

  it('says a principle was proposed, on the card that proposed it only', async () => {
    serveResolved([answered, plain]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('radio', { name: 'Resolved' }));
    const rows = await screen.findAllByTestId('resolved-card');
    expect(rows[0]?.textContent).toContain('A principle was proposed');
    expect(rows[1]?.textContent).not.toContain('principle');
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
      expect(screen.getByText(/^Showing proposed principles/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('radio', { name: 'Resolved' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Open in Knowledge' }));
    const drawer = await openDrawer();
    await waitFor(() => {
      expect(screen.getByText(/^Showing proposed principles/)).toBeTruthy();
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(screen.getByText(/^Showing proposed principles/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('radio', { name: 'Resolved' }));
    const [row] = await screen.findAllByTestId('resolved-card');
    expect(row?.textContent).toContain('2 principles were proposed');
    expect(screen.getByRole('link', { name: 'Open principle 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Open principle 2' }));
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Always keep queues in Postgres.')).toBeTruthy();
  });

  it('ignores a detail that is not a list of proposals', async () => {
    serveResolved([inboxItemDto({ ...answered, detail: { proposedPrinciples: 'nope' } })]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('radio', { name: 'Resolved' }));
    const [row] = await screen.findAllByTestId('resolved-card');
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
    // A card's header row holds its kind, its project and its title.
    const header = async (title: string) => (await screen.findByText(title)).parentElement;
    expect((await header('Alpha question?'))?.textContent).toContain('alpha');
    expect((await header('Beta question?'))?.textContent).toContain('beta');
    expect(screen.getByRole('radio', { name: 'Open 2' })).toBeTruthy();
  });

  it('narrows the cards and the Open count by its own project filter', async () => {
    twoProjects();
    renderApp(`/inbox?project=${beta.id}`);
    expect(await screen.findByText('Beta question?')).toBeTruthy();
    expect(screen.queryByText('Alpha question?')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Open 1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Project' })).toBe(
      screen.getByDisplayValue('beta'),
    );
  });
});

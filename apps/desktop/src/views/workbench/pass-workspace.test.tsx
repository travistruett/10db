import {
  PASS_RETRY_TURN_CHOICE,
  PassSignOffDto,
  type PassPageDto,
  TakeOutPreviewDto,
  TakeOutResultDto,
  TaskId,
} from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import { multipartParts, useNodeMultipart } from '../../test/multipart';
import {
  askItem,
  minutesBeforeNow,
  pageTurn,
  PASS_NOW,
  passHandlers,
  pagesByStatus,
  passTurnTimingDto,
  passTurnWithFilesDto,
  passViewDto,
  taskMessageDto,
} from '../../test/pass-fixtures';
import { clockTime } from './page-status';
import { PassWorkspace } from './pass-workspace';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(PASS_NOW) });
  server.use(...passHandlers(), ...baseHandlers());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderWorkspace(selected: (pages: Pages) => TaskId | null = () => null) {
  const pages = pagesByStatus();
  const onSelect = vi.fn();
  renderWithDaemon(
    <PassWorkspace
      view={passViewDto({ pages: Object.values(pages) })}
      inbox={[askItem(pages.asks)]}
      project={projectViewDto()}
      selected={selected(pages)}
      onSelect={onSelect}
    />,
  );
  await screen.findByRole('list', { name: 'Pages in this pass' });
  return { pages, onSelect };
}

type Pages = ReturnType<typeof pagesByStatus>;

/** The queue's page rows, without each row's menu. */
function queueRows() {
  return within(screen.getByRole('list', { name: 'Pages in this pass' }))
    .getAllByRole('button')
    .filter((button) => !button.hasAttribute('aria-haspopup'));
}

describe('PassWorkspace queue', () => {
  it('lists the pages as buttons in queue order, each with its state line', async () => {
    const { pages } = await renderWorkspace();
    expect(queueRows().map((row) => row.textContent)).toEqual([
      'PeopleAsks a question',
      'ReportsThe session kept crashing or could not start. Retry Turn sends your last message again.',
      'SettingsReady · 3 min',
      'BillingWorking · 4 min · median 5',
      `TeamPaused: usage limit, resumes ${clockTime(pages.paused.pausedUntil ?? '')}`,
      'HomeNot started',
    ]);
  });

  it('marks the selected page current and selects another on a click', async () => {
    const { pages, onSelect } = await renderWorkspace();
    // Nothing selected: the queue's first row is the one shown.
    expect(queueRows().filter((row) => row.getAttribute('aria-current') === 'true')).toHaveLength(
      1,
    );
    expect(queueRows()[0]?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(onSelect).toHaveBeenCalledWith(pages.ready.taskId);
  });

  it('draws the selected page as current when the route names it', async () => {
    await renderWorkspace((pages) => pages.working.taskId);
    const current = queueRows().filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current.map((row) => row.textContent)).toEqual(['BillingWorking · 4 min · median 5']);
    const thread = screen.getByRole('region', { name: 'Billing' });
    expect(await within(thread).findByText('Billing is at')).toBeTruthy();
  });

  it('names a page that waits on the builder heavier, and dims the rest', async () => {
    await renderWorkspace();
    const name = (page: string) =>
      within(screen.getByRole('button', { name: new RegExp(`^${page}`) })).getByText(page);
    expect(['Settings', 'People', 'Billing'].map((page) => name(page).style.fontWeight)).toEqual([
      '500',
      '500',
      '400',
    ]);
    const dimmed = queueRows().map((row) =>
      row.style.color === 'var(--mantine-color-dimmed)' ? 'dimmed' : 'plain',
    );
    expect(dimmed).toEqual(['plain', 'plain', 'plain', 'dimmed', 'dimmed', 'dimmed']);
  });
});

describe('PassWorkspace working line', () => {
  it('ends a working page’s thread with what the agent does, and ticks the minutes without announcing', async () => {
    // One set of fakes, the clock's interval with the date, in place before the workspace mounts.
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      now: Date.parse(PASS_NOW),
    });
    await renderWorkspace((pages) => pages.working.taskId);
    const thread = screen.getByRole('region', { name: 'Billing' });
    expect(within(thread).getByText('Working · 4 min · editing settings/page.tsx')).toBeTruthy();
    expect(within(thread).getByText('1 file changed so far')).toBeTruthy();
    expect(within(thread).queryByRole('status')).toBeNull();
    // The clock's interval is set from an effect that may still be pending when the find resolves; the
    // async advance lets it run first, so the minute lands on the fake clock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(within(thread).getByText('Working · 5 min · editing settings/page.tsx')).toBeTruthy();
  });

  it("opens the working turn's log from Show Log, read from that turn's activity", async () => {
    const asked: string[] = [];
    server.use(
      http.get(daemonUrl('/pass-turns/:turnId/activity'), ({ params }) => {
        asked.push(String(params['turnId']));
        return HttpResponse.json([
          { at: minutesBeforeNow(3), kind: 'tool', summary: 'Read src/billing/page.tsx' },
          { at: minutesBeforeNow(1), kind: 'tool', summary: 'Edit src/billing/page.tsx' },
        ]);
      }),
    );
    const { pages } = await renderWorkspace((p) => p.working.taskId);
    const thread = screen.getByRole('region', { name: 'Billing' });
    // The log is read only once it is opened.
    expect(asked).toEqual([]);
    fireEvent.click(within(thread).getByRole('button', { name: 'Show Log' }));
    const log = await screen.findByRole('dialog', { name: 'Billing · Turn 1' });
    expect(await within(log).findByText('Read src/billing/page.tsx')).toBeTruthy();
    expect(within(log).getByText('Edit src/billing/page.tsx')).toBeTruthy();
    expect(new Set(asked)).toEqual(new Set([pages.working.turn?.id]));
  });

  it('keeps the log open when its turn ends Ready', async () => {
    const pages = pagesByStatus();
    const turn = pages.working.turn;
    if (turn === null) throw new Error('the working page has a turn');
    const workspace = (working: typeof pages.working) => (
      <PassWorkspace
        view={passViewDto({ pages: [working] })}
        inbox={[]}
        project={projectViewDto()}
        selected={working.taskId}
        onSelect={() => undefined}
      />
    );
    const { rerender } = renderWithDaemon(workspace(pages.working));
    fireEvent.click(await screen.findByRole('button', { name: 'Show Log' }));
    await screen.findByRole('dialog', { name: 'Billing · Turn 1' });
    rerender(
      workspace({
        ...pages.working,
        state: 'WAITING_HUMAN',
        turn: { ...turn, endedAt: PASS_NOW, readyAt: PASS_NOW },
      }),
    );
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Billing · Turn 1' })).toBeTruthy();
  });

  it('leaves the log closed on a page shown again after another', async () => {
    const pages = pagesByStatus();
    const workspace = (selected: TaskId) => (
      <PassWorkspace
        view={passViewDto({ pages: [pages.working, pages.ready] })}
        inbox={[]}
        project={projectViewDto()}
        selected={selected}
        onSelect={() => undefined}
      />
    );
    const { rerender } = renderWithDaemon(workspace(pages.working.taskId));
    fireEvent.click(await screen.findByRole('button', { name: 'Show Log' }));
    await screen.findByRole('dialog', { name: 'Billing · Turn 1' });
    rerender(workspace(pages.ready.taskId));
    await screen.findByRole('region', { name: 'Settings' });
    // The drawer closes with a transition before it leaves the page; its title follows the page shown.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // A drawer that opens mounts over its transition's timers: with them faked and run out, one that
    // opened on coming back would be on the page by the assertion.
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
      now: Date.parse(PASS_NOW),
    });
    rerender(workspace(pages.working.taskId));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole('region', { name: 'Billing' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws no working line on a page that is not working', async () => {
    await renderWorkspace((pages) => pages.ready.taskId);
    const thread = screen.getByRole('region', { name: 'Settings' });
    expect(within(thread).queryByText(/^Working/)).toBeNull();
  });
});

describe('PassWorkspace composer', () => {
  it('sends the shown page’s draft, words and picture, to that page’s thread', async () => {
    const NodeFile = await useNodeMultipart();
    let posted: { taskId: string; text: string | undefined; pictures: readonly string[] } | null =
      null;
    server.use(
      http.post(daemonUrl('/tasks/:taskId/thread'), async ({ params, request }) => {
        const parts = multipartParts(await request.text());
        posted = {
          taskId: String(params['taskId']),
          text: parts.text['text'],
          pictures: parts.files['picture'] ?? [],
        };
        return HttpResponse.json(
          taskMessageDto(TaskId.parse(params['taskId']), { body: 'padding too tight' }),
          { status: 201 },
        );
      }),
    );
    const { pages } = await renderWorkspace((p) => p.ready.taskId);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Settings' });
    fireEvent.change(input, { target: { value: 'padding too tight' } });
    const shot = new NodeFile([new Uint8Array([1])], 'tight.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [shot], getData: () => '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(posted).toEqual({
        taskId: pages.ready.taskId,
        text: 'padding too tight',
        pictures: ['tight.png'],
      });
    });
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('keeps each page’s draft while another page is shown', async () => {
    const pages = pagesByStatus();
    const view = passViewDto({ pages: Object.values(pages) });
    function Selecting() {
      const [selected, setSelected] = useState<TaskId>(pages.ready.taskId);
      return (
        <PassWorkspace
          view={view}
          inbox={[]}
          project={projectViewDto()}
          selected={selected}
          onSelect={setSelected}
        />
      );
    }
    renderWithDaemon(<Selecting />);
    const message = (page: string) =>
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: `Message to ${page}` });
    await screen.findByRole('textbox', { name: 'Message to Settings' });
    fireEvent.change(message('Settings'), { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    expect(message('Billing').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(message('Settings').value).toBe('half a thought');
  });
});

describe('PassWorkspace page actions', () => {
  /** What the daemon was sent, by route and task. */
  function record() {
    const sent: { route: string; taskId: string; text?: string | undefined }[] = [];
    server.use(
      http.post(daemonUrl('/tasks/:taskId/stop'), ({ params }) => {
        sent.push({ route: 'stop', taskId: String(params['taskId']) });
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(daemonUrl('/tasks/:taskId/thread/redo'), async ({ params, request }) => {
        const taskId = TaskId.parse(params['taskId']);
        sent.push({
          route: 'redo',
          taskId,
          text: multipartParts(await request.text()).text['text'],
        });
        return HttpResponse.json(taskMessageDto(taskId), { status: 201 });
      }),
      http.post(daemonUrl('/tasks/:taskId/turns/:turnId/opened'), ({ params }) => {
        sent.push({
          route: `opened ${String(params['turnId'])}`,
          taskId: String(params['taskId']),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return sent;
  }

  /** What was sent besides opened marks, which an earlier test's Ready page may still be sending. */
  const actionsSent = (sent: ReturnType<typeof record>) =>
    sent.filter((s) => !s.route.startsWith('opened'));

  it('an empty composer stops the working page plainly, sending nothing', async () => {
    const sent = record();
    const { pages } = await renderWorkspace((p) => p.working.taskId);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(actionsSent(sent)).toEqual([{ route: 'stop', taskId: pages.working.taskId }]);
    });
  });

  it('Stop and Redo sends the typed words to the working page as its next turn', async () => {
    await useNodeMultipart();
    const sent = record();
    const { pages } = await renderWorkspace((p) => p.working.taskId);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Billing' }), {
      target: { value: 'not that, the header' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop and Redo' }));
    await waitFor(() => {
      expect(actionsSent(sent)).toEqual([
        { route: 'redo', taskId: pages.working.taskId, text: 'not that, the header' },
      ]);
    });
  });

  it('marks a Ready page’s turn opened once it is shown, and never one already opened', async () => {
    const sent = record();
    const { pages } = await renderWorkspace((p) => p.ready.taskId);
    const turnId = pages.ready.turn?.id ?? '';
    await waitFor(() => {
      expect(sent).toEqual([{ route: `opened ${turnId}`, taskId: pages.ready.taskId }]);
    });
    sent.length = 0;
    const ready = pages.ready;
    renderWithDaemon(
      <PassWorkspace
        view={passViewDto({
          pages: [ready],
          turns: [
            passTurnTimingDto({
              taskId: ready.taskId,
              seq: ready.turn?.seq ?? 1,
              readyAt: ready.turn?.readyAt ?? null,
              openedAt: minutesBeforeNow(1),
            }),
          ],
        })}
        inbox={[]}
        project={projectViewDto()}
        selected={ready.taskId}
        onSelect={vi.fn()}
      />,
    );
    await screen.findAllByRole('textbox', { name: 'Message to Settings' });
    expect(sent).toEqual([]);
  });

  /** The sign-offs asked and withdrawn, by pass and task. */
  function serveSignOff() {
    const sent: { method: string; passId: string; taskId: string }[] = [];
    const path = daemonUrl('/passes/:passId/tasks/:taskId/sign-off');
    server.use(
      http.post(path, ({ params }) => {
        const taskId = TaskId.parse(params['taskId']);
        sent.push({ method: 'POST', passId: String(params['passId']), taskId });
        return HttpResponse.json(
          PassSignOffDto.parse({ taskId, state: 'signing_off', waitsFor: null }),
          { status: 202 },
        );
      }),
      http.delete(path, ({ params }) => {
        sent.push({
          method: 'DELETE',
          passId: String(params['passId']),
          taskId: String(params['taskId']),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return sent;
  }

  it("Sign Off signs off the shown Ready page, naming that page's pass and task", async () => {
    const sent = serveSignOff();
    const pages = pagesByStatus();
    const view = passViewDto({ pages: Object.values(pages) });
    renderWithDaemon(
      <PassWorkspace
        view={view}
        inbox={[]}
        project={projectViewDto()}
        selected={pages.ready.taskId}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign Off' }));
    await waitFor(() => {
      expect(sent).toEqual([{ method: 'POST', passId: view.pass.id, taskId: pages.ready.taskId }]);
    });
  });

  it.each([
    { name: 'signing off', signOff: 'signing_off', line: 'Signing off…', cancel: false },
    {
      name: 'waiting for another page',
      signOff: 'waiting',
      line: "Signing off: waiting for People's turn",
      cancel: true,
    },
  ] as const)(
    'a page $name says so, and only a waiting one offers Cancel Sign-Off',
    async ({ signOff, line, cancel }) => {
      const sent = serveSignOff();
      const pages = pagesByStatus();
      const signing = {
        ...pages.ready,
        signOff,
        waitsFor:
          signOff === 'waiting' ? { taskId: pages.asks.taskId, title: pages.asks.title } : null,
      };
      const view = passViewDto({ pages: [signing, pages.asks] });
      renderWithDaemon(
        <PassWorkspace
          view={view}
          inbox={[]}
          project={projectViewDto()}
          selected={signing.taskId}
          onSelect={vi.fn()}
        />,
      );
      const thread = await screen.findByRole('region', { name: 'Settings' });
      expect(within(thread).getByText(line)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign Off' })).toBeNull();
      const button = within(thread).queryByRole('button', { name: 'Cancel Sign-Off' });
      expect(button !== null).toBe(cancel);
      if (button === null) return;
      fireEvent.click(button);
      await waitFor(() => {
        expect(sent).toEqual([{ method: 'DELETE', passId: view.pass.id, taskId: signing.taskId }]);
      });
    },
  );

  it("lists under each reply the files its turn changed, read from the page's turns", async () => {
    const pages = pagesByStatus();
    const ready = pages.ready;
    server.use(
      ...passHandlers({
        threads: {
          [ready.taskId]: {
            taskId: ready.taskId,
            messages: [
              taskMessageDto(ready.taskId, {
                author: 'agent',
                kind: 'reply',
                body: 'Tightened the padding',
                createdAt: minutesBeforeNow(3),
              }),
            ],
          },
        },
        turns: {
          [ready.taskId]: [
            passTurnWithFilesDto({
              taskId: ready.taskId,
              startedAt: minutesBeforeNow(12),
              files: [{ path: 'src/settings/page.tsx', added: 4, removed: 1 }],
            }),
          ],
        },
      }),
    );
    renderWithDaemon(
      <PassWorkspace
        view={passViewDto({ pages: [ready] })}
        inbox={[]}
        project={projectViewDto()}
        selected={ready.taskId}
        onSelect={vi.fn()}
      />,
    );
    const files = await screen.findByRole('list', { name: 'Files this turn changed' });
    expect(files.textContent).toContain('src/settings/page.tsx');
  });
});

describe('PassWorkspace Retry Turn', () => {
  it("answers the failed page's flag with Retry Turn", async () => {
    const answered: { id: string; body: unknown }[] = [];
    server.use(
      http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
        answered.push({ id: String(params['id']), body: await request.json() });
        return HttpResponse.json(inboxItemDto({ state: 'RESOLVED' }));
      }),
    );
    const { pages } = await renderWorkspace((p) => p.failed.taskId);
    fireEvent.click(screen.getByRole('button', { name: 'Retry Turn' }));
    await waitFor(() => {
      expect(answered).toEqual([
        { id: pages.failed.failure?.retryItemId, body: { choice: PASS_RETRY_TURN_CHOICE } },
      ]);
    });
  });

  it('offers no Retry Turn on a page whose turn did not fail', async () => {
    await renderWorkspace((p) => p.ready.taskId);
    expect(screen.queryByRole('button', { name: 'Retry Turn' })).toBeNull();
  });
});

describe('PassWorkspace window focus', () => {
  it('selects the page that has waited longest when the window gains focus on a page that waits on nothing', async () => {
    const { pages, onSelect } = await renderWorkspace((p) => p.working.taskId);
    fireEvent.focus(window);
    expect(onSelect).toHaveBeenCalledWith(pages.asks.taskId);
  });

  it('never moves away from a page with a draft', async () => {
    const { onSelect } = await renderWorkspace((p) => p.working.taskId);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Billing' }), {
      target: { value: 'half a thought' },
    });
    fireEvent.focus(window);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('PassWorkspace while the pass is not open', () => {
  it.each(['ABANDONING', 'CLOSING'] as const)(
    'while %s, holds every page action: no message, no Retry Turn, no row menu',
    async (state) => {
      const pages = pagesByStatus();
      renderWithDaemon(
        <PassWorkspace
          view={passViewDto({ pass: { state }, pages: Object.values(pages) })}
          inbox={[]}
          project={projectViewDto()}
          selected={pages.failed.taskId}
          onSelect={vi.fn()}
        />,
      );
      const input = await screen.findByRole('textbox', { name: 'Message to Reports' });
      expect(input).toHaveProperty('disabled', true);
      expect(screen.queryByRole('button', { name: 'Retry Turn' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^More actions for/ })).toBeNull();
    },
  );
});

describe('PassWorkspace Take Out', () => {
  /** Answers the take-out preview with `shared` and records each take-out sent. */
  function serveTakeOut(tookOut = true, shared: TakeOutPreviewDto['shared'] = []) {
    const sent: { passId: string; taskId: string; body: unknown }[] = [];
    const previewed: { passId: string; taskId: string }[] = [];
    server.use(
      http.get(daemonUrl('/passes/:passId/tasks/:taskId/take-out'), ({ params }) => {
        previewed.push({ passId: String(params['passId']), taskId: String(params['taskId']) });
        return HttpResponse.json(TakeOutPreviewDto.parse({ shared }));
      }),
      http.post(
        daemonUrl('/passes/:passId/tasks/:taskId/take-out'),
        async ({ params, request }) => {
          const taskId = TaskId.parse(params['taskId']);
          sent.push({ passId: String(params['passId']), taskId, body: await request.json() });
          return HttpResponse.json(
            TakeOutResultDto.parse({
              taskId,
              passId: params['passId'],
              tookOut,
              keptSha: null,
              stillChanging: tookOut ? [] : ['src/billing/page.tsx'],
              left: [],
            }),
          );
        },
      ),
    );
    return { sent, previewed };
  }

  async function openTakeOut(area: string) {
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${area}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Take Out…', hidden: true }));
    return screen.findByRole('dialog', { name: `Take Out ${area}` });
  }

  /** Take Out, once the preview it waits for has answered. */
  async function confirmTakeOut(dialog: HTMLElement) {
    const button = within(dialog).getByRole('button', { name: 'Take Out' });
    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false);
    });
    fireEvent.click(button);
  }

  async function takeOut(area: string) {
    const dialog = await openTakeOut(area);
    await confirmTakeOut(dialog);
    return dialog;
  }

  it("takes out the row's page after a confirm, keeping every shared change", async () => {
    const { sent } = serveTakeOut();
    const pages = pagesByStatus();
    const view = passViewDto({ pages: Object.values(pages) });
    renderWithDaemon(
      <PassWorkspace
        view={view}
        inbox={[]}
        project={projectViewDto()}
        selected={pages.ready.taskId}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByRole('list', { name: 'Pages in this pass' });
    await takeOut('Billing');
    await waitFor(() => {
      expect(sent).toEqual([
        { passId: view.pass.id, taskId: pages.working.taskId, body: { shared: [] } },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Take Out Billing' })).toBeNull();
    });
  });

  it("offers Keep or Drop for each of the page's unlanded shared changes, and sends the choices", async () => {
    const { sent, previewed } = serveTakeOut(true, [
      { seq: 1, paths: ['src/shared/button.tsx'], dropRefusal: null, laterPages: ['People'] },
      {
        seq: 2,
        paths: ['src/shared/theme.ts'],
        dropRefusal: 'the file changed on disk since',
        laterPages: [],
      },
    ]);
    const pages = pagesByStatus();
    const view = passViewDto({ pages: Object.values(pages) });
    renderWithDaemon(
      <PassWorkspace
        view={view}
        inbox={[]}
        project={projectViewDto()}
        selected={pages.ready.taskId}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByRole('list', { name: 'Pages in this pass' });
    const dialog = await openTakeOut('Billing');
    const change = (path: string) => within(dialog).findByRole('group', { name: path });
    const button = await change('src/shared/button.tsx');
    // The pages a Drop would also take back are named before the choice.
    expect(within(button).getByText('People changed these files later.')).toBeTruthy();
    fireEvent.click(within(button).getByRole('radio', { name: 'Drop' }));
    const theme = await change('src/shared/theme.ts');
    expect(within(theme).getByRole('radio', { name: 'Drop' })).toHaveProperty('disabled', true);
    expect(within(theme).getByText('Only Keep: the file changed on disk since')).toBeTruthy();
    await confirmTakeOut(dialog);
    await waitFor(() => {
      expect(sent).toEqual([
        {
          passId: view.pass.id,
          taskId: pages.working.taskId,
          body: {
            shared: [
              { seq: 1, choice: 'drop' },
              { seq: 2, choice: 'keep' },
            ],
          },
        },
      ]);
    });
    expect(previewed).toEqual([{ passId: view.pass.id, taskId: pages.working.taskId }]);
  });

  it('never reopens the confirm when the page left the pass before its take-out answered', async () => {
    const { sent } = serveTakeOut();
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    // The take-out answers only once the test lets it, after the pass has dropped the page.
    server.use(
      http.post(daemonUrl('/passes/:passId/tasks/:taskId/take-out'), async ({ params }) => {
        sent.push({ passId: String(params['passId']), taskId: String(params['taskId']), body: {} });
        await answered;
        return HttpResponse.json(
          TakeOutResultDto.parse({
            taskId: params['taskId'],
            passId: params['passId'],
            tookOut: true,
            keptSha: null,
            stillChanging: [],
            left: [],
          }),
        );
      }),
    );
    const pages = pagesByStatus();
    const draw = (shown: PassPageDto[]) => (
      <PassWorkspace
        view={passViewDto({ pages: shown })}
        inbox={[]}
        project={projectViewDto()}
        selected={pages.ready.taskId}
        onSelect={vi.fn()}
      />
    );
    const { rerender, queryClient } = renderWithDaemon(draw(Object.values(pages)));
    await screen.findByRole('list', { name: 'Pages in this pass' });
    await takeOut('Billing');
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    rerender(draw([pages.ready]));
    answer();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'More actions for Billing' })).toBeNull();
    });
    // Once the take-out's answer has settled, the task joins the pass again.
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    rerender(draw([pages.ready, pages.working]));
    await screen.findByRole('button', { name: 'More actions for Billing' });
    expect(screen.queryByRole('dialog', { name: 'Take Out Billing' })).toBeNull();
  });

  it('reads the shared changes afresh on each Take Out…, and again after a refused take-out', async () => {
    const button = (refusal: string | null) => [
      { seq: 1, paths: ['src/shared/button.tsx'], dropRefusal: refusal, laterPages: [] },
    ];
    // The first read offers Drop; every later read refuses it, as the daemon then does.
    let reads = 0;
    let refuse = false;
    server.use(
      http.get(daemonUrl('/passes/:passId/tasks/:taskId/take-out'), () => {
        reads += 1;
        return HttpResponse.json(
          TakeOutPreviewDto.parse({ shared: button(reads === 1 ? null : 'People changed it') }),
        );
      }),
      http.post(daemonUrl('/passes/:passId/tasks/:taskId/take-out'), () =>
        refuse
          ? HttpResponse.json(
              { error: 'conflict', message: 'Drop is no longer offered for change 1' },
              { status: 409 },
            )
          : HttpResponse.json({}),
      ),
    );
    await renderWorkspace();
    const drop = (dialog: HTMLElement) =>
      within(within(dialog).getByRole('group', { name: 'src/shared/button.tsx' })).getByRole(
        'radio',
        { name: 'Drop' },
      );
    let dialog = await openTakeOut('Billing');
    await within(dialog).findByRole('group', { name: 'src/shared/button.tsx' });
    expect(drop(dialog)).toHaveProperty('disabled', false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Take Out Billing' })).toBeNull();
    });
    // Opened again, it never shows the first read while it reads again.
    dialog = await openTakeOut('Billing');
    expect(within(dialog).queryByRole('group', { name: 'src/shared/button.tsx' })).toBeNull();
    await within(dialog).findByRole('group', { name: 'src/shared/button.tsx' });
    expect(drop(dialog)).toHaveProperty('disabled', true);
    // A refused take-out reads the changes again, so what it offers next is what the daemon takes.
    refuse = true;
    const before = reads;
    await confirmTakeOut(dialog);
    expect(await within(dialog).findByText('Drop is no longer offered for change 1')).toBeTruthy();
    await waitFor(() => {
      expect(reads).toBe(before + 1);
    });
  });

  it('says which files kept changing when the page could not be taken out', async () => {
    serveTakeOut(false);
    await renderWorkspace();
    const dialog = await takeOut('Billing');
    expect(await within(dialog).findByText(/src\/billing\/page\.tsx/)).toBeTruthy();
  });
});

describe('PassWorkspace Open Page', () => {
  it('opens the shown page’s route on the project’s app address, then copies its link', async () => {
    const pages = pagesByStatus();
    renderWithDaemon(
      <PassWorkspace
        view={passViewDto({ pages: Object.values(pages) })}
        inbox={[]}
        project={projectViewDto({ appUrl: 'http://localhost:8800' })}
        selected={pages.working.taskId}
        onSelect={vi.fn()}
      />,
    );
    const composerOpen = async () =>
      (await screen.findAllByRole('button', { name: /^(Open Page|Copy Link)$/ })).at(-1);
    await composerOpen();
    const open = vi.spyOn(window, 'open').mockReturnValue(window);
    await act(async () => {
      fireEvent.click((await composerOpen()) ?? document.body);
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith('http://localhost:8800/billing', '_blank');
    expect((await composerOpen())?.textContent).toBe('Copy Link');
    open.mockRestore();
  });
});

describe('PassWorkspace keys', () => {
  it('J and K move along the queue’s rows, and a J typed into a message stays text', async () => {
    const { onSelect } = await renderWorkspace();
    const rows = queueRows();
    rows[0]?.focus();
    fireEvent.keyDown(rows[0] ?? document.body, { key: 'j' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] ?? document.body, { key: 'j' });
    fireEvent.keyDown(rows[2] ?? document.body, { key: 'k' });
    expect(document.activeElement).toBe(rows[1]);
    const input = screen.getByRole('textbox', { name: 'Message to People' });
    input.focus();
    fireEvent.keyDown(input, { key: 'j' });
    fireEvent.keyDown(input, { key: 'n' });
    expect(document.activeElement).toBe(input);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('N selects the next page that waits on the builder', async () => {
    const { pages, onSelect } = await renderWorkspace();
    fireEvent.keyDown(document.body, { key: 'n' });
    // The asks page is shown first; the failed page waits after it.
    expect(onSelect).toHaveBeenCalledWith(pages.failed.taskId);
  });

  it('puts the cursor in the composer of the page selected', async () => {
    const pages = pagesByStatus();
    function Selecting() {
      const [selected, setSelected] = useState<TaskId>(pages.ready.taskId);
      return (
        <PassWorkspace
          view={passViewDto({ pages: Object.values(pages) })}
          inbox={[]}
          project={projectViewDto()}
          selected={selected}
          onSelect={setSelected}
        />
      );
    }
    renderWithDaemon(<Selecting />);
    await screen.findByRole('textbox', { name: 'Message to Settings' });
    fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Message to Billing' }),
    );
  });

  it('⌘L copies the shown page’s link, from the composer too', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const pages = pagesByStatus();
    renderWithDaemon(
      <PassWorkspace
        view={passViewDto({ pages: Object.values(pages) })}
        inbox={[]}
        project={projectViewDto({ appUrl: 'http://localhost:8800' })}
        selected={pages.ready.taskId}
        onSelect={vi.fn()}
      />,
    );
    const input = await screen.findByRole('textbox', { name: 'Message to Settings' });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'l', metaKey: true });
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('http://localhost:8800/settings');
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});

describe('PassWorkspace announcer', () => {
  it('says nothing for the pass it opened on, then says a page becoming ready, never a tick', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      now: Date.parse(PASS_NOW),
    });
    const pages = pagesByStatus();
    const ui = (billing: typeof pages.working) => (
      <PassWorkspace
        view={passViewDto({
          pages: [...Object.values(pages).filter((p) => p !== pages.working), billing],
        })}
        inbox={[askItem(pages.asks)]}
        project={projectViewDto()}
        selected={pages.working.taskId}
        onSelect={vi.fn()}
      />
    );
    const { rerender } = renderWithDaemon(ui(pages.working));
    const region = await screen.findByRole('status', { name: 'Workbench announcements' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(region.textContent).toBe('');
    rerender(
      ui({
        ...pages.working,
        state: 'WAITING_HUMAN',
        nextActionKind: 'pass_review',
        turn: pageTurn({
          startedMinutesAgo: 5,
          endedAt: minutesBeforeNow(0),
          readyAt: minutesBeforeNow(0),
        }),
      }),
    );
    expect(region.textContent).toBe('Billing is ready');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

import { GoalAdoptInput, type GoalAdoptIssue, type GoalSummaryDto } from '@10db/contracts';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { goalDto, goalListDto, goalSummaryDto } from '../../test/goal-fixtures';

afterEach(() => {
  clearMocks();
  // `clearMocks` leaves the marker `isTauri` reads.
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

const PLAN = '/Users/me/plans/importer.md';

interface Panel {
  /** What each open of the panel was asked for. */
  readonly asked: unknown[];
  /** The next paths the panel answers, in order; null is a cancel. */
  readonly picks: (string | null)[];
}

/** The native panel is the boundary: Tauri's IPC answers the dialog plugin's `open` command. */
function panel(...picks: (string | null)[]): Panel {
  const state: Panel = { asked: [], picks };
  mockIPC((command, args) => {
    if (command !== 'plugin:dialog|open') return undefined;
    state.asked.push(args);
    return state.picks.shift() ?? null;
  });
  return state;
}

interface Daemon {
  /** The bodies the adopt route received. */
  readonly posted: unknown[];
  readonly goals: GoalSummaryDto[];
}

/** A daemon whose adopt route answers `answers` in order; an adopted goal joins the list. */
function serve(...answers: ({ errors: GoalAdoptIssue[] } | GoalSummaryDto)[]): Daemon {
  const daemon: Daemon = { posted: [], goals: [] };
  // MSW takes the first handler that matches, so these go ahead of the base daemon's.
  server.use(
    http.get(daemonUrl('/projects/:projectId/goals'), () =>
      HttpResponse.json(goalListDto(...daemon.goals)),
    ),
    http.post(daemonUrl('/projects/:projectId/goals/adopt'), async ({ request }) => {
      const body: unknown = await request.json();
      daemon.posted.push(body);
      const answer = answers.shift();
      if (!answer) return HttpResponse.json({ error: 'no answer' }, { status: 500 });
      if ('errors' in answer) return HttpResponse.json(answer, { status: 400 });
      daemon.goals.push(answer);
      return HttpResponse.json(answer.goal, { status: 201 });
    }),
    ...baseHandlers(),
  );
  return daemon;
}

const REFUSAL: GoalAdoptIssue[] = [
  { path: 'Task 3, depends on', message: 'no task has the key "migrate"' },
  { path: 'Criteria 1, task', message: 'no task has the key "ship"' },
  { path: 'Task 1, areas', message: 'the project has no area "web"' },
];

/** The dimmed line Factory shows while the project has no goals. */
const NO_GOALS = /^Goals are outcomes 10db pursues across many tasks/;

/** A goal's row: a button whose accessible name starts with the goal's title. */
function rowOf(title: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: new RegExp(`^${title}`) });
}

/** Mantine leaves `data-variant` off a button of its default, filled variant. */
function isFilled(button: HTMLElement): boolean {
  return (button.getAttribute('data-variant') ?? 'filled') === 'filled';
}

async function adopt(): Promise<void> {
  // The goal list appears once the project is selected and its goals have loaded.
  await screen.findByRole('group', { name: 'Goals' });
  fireEvent.click(await screen.findByRole('button', { name: 'Adopt a Plan…' }));
}

describe('Adopt a Plan…', () => {
  it('is the only filled button in the header', async () => {
    panel();
    serve();
    renderApp('/factory');
    const button = await screen.findByRole('button', { name: 'Adopt a Plan…' });
    await screen.findByText(NO_GOALS);
    // The shell's navigation links are buttons too, but they are not Mantine Buttons.
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.classList.contains('mantine-Button-root'));
    expect(buttons.filter(isFilled)).toEqual([button]);
  });

  it('asks the native panel for a Markdown file and posts its path', async () => {
    const native = panel(PLAN);
    const daemon = serve(goalSummaryDto({ title: 'Ship the importer' }));
    renderApp('/factory');
    await adopt();

    await waitFor(() => {
      expect(daemon.posted).toHaveLength(1);
    });
    expect(GoalAdoptInput.parse(daemon.posted[0])).toEqual({ path: PLAN, dryRun: false });
    expect(native.asked).toHaveLength(1);
    expect(native.asked[0]).toMatchObject({
      options: { directory: false, filters: [{ name: 'Plan', extensions: ['md'] }] },
    });
  });

  it('shows the adopted goal in the list', async () => {
    panel(PLAN);
    serve(
      goalSummaryDto(
        { title: 'Ship the importer' },
        { status: 'running', progress: { done: 1, total: 3, cancelled: [] } },
        2,
      ),
    );
    renderApp('/factory');
    await screen.findByText(NO_GOALS);

    await adopt();

    const row = await rowOf('Ship the importer');
    expect(row.textContent).toContain('Running · 1 of 3 tasks done · 2 new');
    expect(screen.queryByText(NO_GOALS)).toBeNull();
    expect(screen.queryByText("This plan can't be adopted yet")).toBeNull();
  });

  it('does nothing when the panel is cancelled', async () => {
    const native = panel(null);
    const daemon = serve();
    renderApp('/factory');
    await adopt();
    await waitFor(() => {
      expect(native.asked).toHaveLength(1);
    });
    expect(daemon.posted).toEqual([]);
    expect(screen.queryByText("This plan can't be adopted yet")).toBeNull();
  });

  it('lists every error the daemon found, with where it is, in the refusal modal', async () => {
    panel(PLAN);
    serve({ errors: REFUSAL });
    renderApp('/factory');
    await adopt();

    const modal = await screen.findByRole('dialog', { name: "This plan can't be adopted yet" });
    expect(within(modal).getByText(PLAN)).toBeTruthy();
    for (const issue of REFUSAL) {
      const item = within(modal).getByText(issue.message).closest('li');
      if (!item) throw new Error(`${issue.message} is not in a list item`);
      expect(within(item).getByText(issue.path)).toBeTruthy();
    }
    expect(within(modal).getAllByRole('listitem')).toHaveLength(REFUSAL.length);
    expect(isFilled(within(modal).getByRole('button', { name: 'Pick Again…' }))).toBe(true);
    expect(isFilled(within(modal).getByRole('button', { name: 'Cancel' }))).toBe(false);
  });

  it('Pick Again… reopens the panel and adopts the new pick', async () => {
    const native = panel(PLAN, '/Users/me/plans/fixed.md');
    const daemon = serve({ errors: REFUSAL }, goalSummaryDto({ title: 'Ship the importer' }));
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: "This plan can't be adopted yet" });

    fireEvent.click(within(modal).getByRole('button', { name: 'Pick Again…' }));

    expect(await rowOf('Ship the importer')).toBeTruthy();
    expect(native.asked).toHaveLength(2);
    expect(daemon.posted).toEqual([
      { path: PLAN, dryRun: false },
      { path: '/Users/me/plans/fixed.md', dryRun: false },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Pick Again… keeps the refusal up when the panel is cancelled', async () => {
    const native = panel(PLAN, null);
    serve({ errors: REFUSAL });
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: "This plan can't be adopted yet" });

    fireEvent.click(within(modal).getByRole('button', { name: 'Pick Again…' }));

    await waitFor(() => {
      expect(native.asked).toHaveLength(2);
    });
    expect(screen.getByRole('dialog', { name: "This plan can't be adopted yet" })).toBeTruthy();
  });

  it('Cancel closes the refusal and adopts nothing', async () => {
    panel(PLAN);
    const daemon = serve({ errors: REFUSAL });
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: "This plan can't be adopted yet" });

    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(daemon.posted).toHaveLength(1);
    expect(screen.getByText(NO_GOALS)).toBeTruthy();
  });

  it('Pick Again… shows a daemon failure inside the open refusal modal', async () => {
    panel(PLAN, '/Users/me/plans/fixed.md');
    // The second pick finds no answer queued, so the daemon fails with a 500.
    serve({ errors: REFUSAL });
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: "This plan can't be adopted yet" });

    fireEvent.click(within(modal).getByRole('button', { name: 'Pick Again…' }));

    expect(await within(modal).findByText("Couldn't adopt that plan")).toBeTruthy();
    expect(within(modal).getAllByRole('listitem')).toHaveLength(REFUSAL.length);
  });

  it('shows a field error for a typed path that is not absolute', async () => {
    const daemon = serve();
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: 'Adopt a plan' });

    fireEvent.change(within(modal).getByLabelText('Plan path'), {
      target: { value: 'plans/importer.md' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Adopt' }));

    expect(await within(modal).findByText(/starting with \//)).toBeTruthy();
    expect(daemon.posted).toEqual([]);
  });

  it('reopens the typed-path form empty and without a field error after Cancel', async () => {
    serve();
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: 'Adopt a plan' });
    fireEvent.change(within(modal).getByLabelText('Plan path'), {
      target: { value: 'plans/x.md' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Adopt' }));
    expect(await within(modal).findByText(/starting with \//)).toBeTruthy();

    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt a Plan…' }));

    const reopened = await screen.findByRole('dialog', { name: 'Adopt a plan' });
    const field = within(reopened).getByLabelText<HTMLInputElement>('Plan path');
    expect(field.value).toBe('');
    expect(within(reopened).queryByText(/starting with \//)).toBeNull();
  });

  it('shows a daemon failure on a typed Adopt inside the open modal', async () => {
    const daemon = serve();
    renderApp('/factory');
    await adopt();
    const modal = await screen.findByRole('dialog', { name: 'Adopt a plan' });

    fireEvent.change(within(modal).getByLabelText('Plan path'), { target: { value: PLAN } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Adopt' }));

    expect(await within(modal).findByText("Couldn't adopt that plan")).toBeTruthy();
    expect(daemon.posted).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Adopt a plan' })).toBeTruthy();
  });

  it('says so when the daemon fails for a reason other than the brief', async () => {
    panel(PLAN);
    serve();
    renderApp('/factory');
    await adopt();
    expect(await screen.findByText("Couldn't adopt that plan")).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: "This plan can't be adopted yet" })).toBeNull();
  });
});

describe('the goal list', () => {
  it('shows a goal that was already adopted, with its status', async () => {
    const daemon = serve();
    daemon.goals.push(
      goalSummaryDto(goalDto({ title: 'Older goal' }), { status: 'waiting_on_you' }),
    );
    panel();
    renderApp('/factory');
    expect((await rowOf('Older goal')).textContent).toContain('Waiting on you');
  });
});

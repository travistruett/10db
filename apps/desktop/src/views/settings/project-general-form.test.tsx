import { mintId, type ProjectDto } from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { flowDto, projectDto } from '../../test/fixtures';

const flow = flowDto({ id: mintId('Flow'), name: 'quick' });

/** Serves one project and records every PATCH body; returns the recorded bodies. */
function serve(project: ProjectDto, reply: 'ok' | 'refuse' = 'ok'): unknown[] {
  const patched: unknown[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([flow])),
    http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
      patched.push(await request.json());
      return reply === 'ok'
        ? HttpResponse.json(project)
        : HttpResponse.json({ error: 'conflict', message: 'unfinished work' }, { status: 409 });
    }),
    ...baseHandlers(),
  );
  return patched;
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const open = async (): Promise<void> => {
  await screen.findByLabelText('Name');
};

async function pick(select: HTMLElement, option: string | RegExp): Promise<void> {
  fireEvent.click(select);
  const listbox = document.getElementById(select.getAttribute('aria-controls') ?? '');
  expect(listbox).toBeDefined();
  fireEvent.click(
    await within(listbox ?? document.body).findByRole('option', { name: option, hidden: true }),
  );
}

const pullRequests = { delivery: 'pull_request', prTitlePrefix: 'feat(app)' } as const;
const worktrees = { ...pullRequests, workspaceMode: 'worktree' } as const;

interface Row {
  readonly name: string;
  readonly project?: Partial<ProjectDto>;
  /** Lives in the collapsed Advanced card. */
  readonly advanced?: true;
  readonly label: string;
  readonly line: string | null;
  readonly change: () => unknown;
  readonly sent: Record<string, unknown>;
}

const rows: readonly Row[] = [
  {
    name: 'Name',
    label: 'Name',
    line: null,
    change: () => type('Name', 'Renamed'),
    sent: { name: 'Renamed' },
  },
  {
    name: 'Gate command',
    label: 'Gate command',
    line: 'Checks the work. A task is done only when it passes.',
    change: () => type('Gate command', 'make check'),
    sent: { gateCommand: 'make check' },
  },
  {
    name: 'Delivery',
    project: pullRequests,
    label: 'Delivery',
    line: 'Work goes to GitHub as a pull request for you to review.',
    change: () => fireEvent.click(screen.getByRole('radio', { name: 'Commit directly' })),
    sent: { delivery: 'local' },
  },
  {
    name: 'Base branch',
    project: pullRequests,
    label: 'Base branch',
    line: 'Pull requests start from and merge into this branch.',
    change: () => type('Base branch', 'develop'),
    sent: { baseBranch: 'develop' },
  },
  {
    name: 'Pull request title',
    project: pullRequests,
    label: 'Pull request title',
    line: 'Starts every title, as a commit type and scope: feat(desktop).',
    change: () => type('Pull request title', 'fix(app)'),
    sent: { prTitlePrefix: 'fix(app)' },
  },
  {
    name: 'Most tasks at once',
    label: 'Most tasks at once',
    line: '10db runs fewer when tasks change the same areas or a usage limit is near.',
    change: () => type('Most tasks at once', '3'),
    sent: { maxLanes: 3 },
  },
  {
    name: 'Where tasks work',
    project: pullRequests,
    label: 'Where tasks work',
    line: 'Tasks change files in your checkout, so you can watch them land in your editor and dev server.',
    change: () => fireEvent.click(screen.getByRole('radio', { name: 'Separate copies' })),
    sent: { workspaceMode: 'worktree' },
  },
  {
    name: "Copy into each task's copy",
    project: worktrees,
    label: "Copy into each task's copy",
    line: 'Ignored folders, such as node_modules, copied from this checkout.',
    change: () => {
      const seed = screen.getByRole('combobox', { name: "Copy into each task's copy" });
      seed.focus();
      fireEvent.change(seed, { target: { value: '.venv' } });
      fireEvent.blur(seed);
    },
    sent: { worktreeSeed: ['node_modules', '.venv'] },
  },
  {
    name: 'Fresh session',
    label: 'Fresh session',
    line: "When a session's memory is this full, it writes a handoff note and a fresh one carries on.",
    change: () => type('Fresh session', '30'),
    sent: { handoffPct: 30 },
  },
  {
    name: 'Flow',
    advanced: true,
    label: 'Flow',
    line: 'The default steps a task goes through. A task can choose its own.',
    change: () => pick(field('Flow'), /^Quick/),
    sent: { flowId: flow.id },
  },
  {
    name: 'Firm reminder',
    advanced: true,
    label: 'Firm reminder',
    line: "If a session hasn't handed off by this much memory, it is told again, firmly.",
    change: () => type('Firm reminder', '60'),
    sent: { nudgePct: 60 },
  },
  {
    name: 'Wait for your answer',
    advanced: true,
    label: 'Wait for your answer',
    line: 'After this long, a waiting task pauses and frees its place; it resumes when you answer.',
    change: () => type('Wait for your answer', '30'),
    sent: { humanWaitMinutes: 30 },
  },
  {
    name: 'Spending limit per task',
    advanced: true,
    label: 'Spending limit per task',
    line: "Leave empty for no limit. Models that cost more per task aren't used.",
    change: () => type('Spending limit per task', '2.5'),
    sent: { budgetCeiling: 2.5 },
  },
  {
    name: "Commands that don't ask",
    advanced: true,
    label: "Commands that don't ask",
    line: 'One per line, such as pnpm test. Tasks run these without asking you; 10db still checks each one.',
    change: () => type("Commands that don't ask", 'pnpm test'),
    sent: { allowedCommands: ['pnpm test'] },
  },
  {
    name: 'Allow localhost',
    advanced: true,
    label: 'Allow localhost',
    line: "For tests that start a local server. Opens every local port to tasks, not just this project's.",
    change: () =>
      fireEvent.click(screen.getByRole('switch', { name: 'Allow localhost', hidden: true })),
    sent: { sandboxLoopback: true },
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('ProjectGeneralForm', () => {
  it.each(rows)('$name: names the row, explains it and saves only that field', async (row) => {
    const patched = serve(projectDto(row.project));
    renderApp('/settings/general');
    await open();
    if (row.advanced) fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getAllByText(row.label).length).toBeGreaterThan(0);
    if (row.line !== null) expect(screen.getByText(row.line)).toBeTruthy();
    await row.change();
    save();
    await waitFor(() => {
      expect(patched).toEqual([row.sent]);
    });
  });

  it.each([
    { name: 'a local project', project: {}, shown: false },
    { name: 'a pull-request project', project: pullRequests, shown: true },
  ])('Base branch and Pull request title show only for pull requests: $name', async (row) => {
    serve(projectDto(row.project));
    renderApp('/settings/general');
    await open();
    expect(screen.queryByLabelText('Base branch') !== null).toBe(row.shown);
    expect(screen.queryByLabelText('Pull request title') !== null).toBe(row.shown);
  });

  it.each([
    { name: 'Your folder', project: pullRequests, shown: false },
    { name: 'Separate copies', project: worktrees, shown: true },
  ])("Copy into each task's copy shows only for Separate copies: $name", async (row) => {
    serve(projectDto(row.project));
    renderApp('/settings/general');
    await open();
    expect(screen.queryByText("Copy into each task's copy") !== null).toBe(row.shown);
  });

  it('Advanced is collapsed with aria-expanded false, its rows hidden, and opens', async () => {
    serve(projectDto());
    renderApp('/settings/general');
    await open();
    const advanced = screen.getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    // A collapsed card's rows are hidden from the page and from assistive tech alike.
    expect(screen.queryByRole('switch', { name: 'Allow localhost', hidden: true })).toBeNull();
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(
      await screen.findByRole('switch', { name: 'Allow localhost', hidden: true }),
    ).toBeTruthy();
  });

  it.each([
    { name: 'Allow localhost', line: rows.find((r) => r.name === 'Allow localhost')?.line },
    {
      name: 'Spending limit per task',
      line: rows.find((r) => r.name === 'Spending limit per task')?.line,
    },
  ])('$name: its explaining line is the control description', async ({ name, line }) => {
    serve(projectDto());
    renderApp('/settings/general');
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const control = await screen.findByLabelText(name);
    await waitFor(() => {
      const ids = (control.getAttribute('aria-describedby') ?? '').split(' ');
      expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(line);
    });
  });

  it('a mistake in a collapsed Advanced field opens Advanced, shows the error and sends nothing', async () => {
    const patched = serve(projectDto());
    renderApp('/settings/general');
    await open();
    // Fresh session above Firm reminder is refused, and Firm reminder lives in Advanced.
    type('Fresh session', '60');
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    save();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe(
        'true',
      );
    });
    const reminder = await screen.findByLabelText('Firm reminder');
    const described = (reminder.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.some((id) => document.getElementById(id)?.textContent)).toBe(true);
    expect(patched).toEqual([]);
    // The card stays open once the mistake is fixed.
    type('Fresh session', '30');
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('Saved shows a green check and fades after 4 s, counted from the latest save', async () => {
    serve(projectDto());
    renderApp('/settings/general');
    await open();
    type('Name', 'Renamed');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    save();
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('Saved');
    expect(status.querySelector('svg')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // A second save restarts the 4 s, so the first timer must not hide this note.
    type('Name', 'Renamed again');
    save();
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Saved');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(screen.getByRole('status').textContent).toBe('Saved');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('a save error sits left of Reset and Save', async () => {
    serve(projectDto(), 'refuse');
    renderApp('/settings/general');
    await open();
    type('Name', 'Renamed');
    save();
    const error = await screen.findByText(/unfinished work/);
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(error.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      reset.compareDocumentPosition(screen.getByRole('button', { name: 'Save' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("labels aren't monospace; values of Gate command and Base branch are", async () => {
    serve(projectDto(pullRequests));
    renderApp('/settings/general');
    await open();
    for (const name of ['Gate command', 'Base branch']) {
      expect(getComputedStyle(field(name)).fontFamily).toContain('monospace');
      expect(getComputedStyle(screen.getByText(name, { selector: 'p' })).fontFamily).not.toContain(
        'monospace',
      );
    }
  });
});

import {
  INSTALL_REPAIRED_NOTICE_KEY,
  mintId,
  PASS_FOLDER_WAIT_LINE,
  PASS_FOLDER_WAIT_NOTICE_KEY,
  RiskTag,
  TaskPatch,
  type BatchDto,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { batchDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import { kindDto } from '../../test/playbook-fixtures';
import { modelRowDto } from '../../test/model-fixtures';
import { RISK_LABEL } from './risk-labels';
import { TaskDrawer } from './task-drawer';
import { failureLine } from './task-state';

const peers = new Map();

function serve(...overrides: Parameters<typeof server.use>) {
  server.use(...overrides, ...baseHandlers());
}

interface Opts {
  /** The base branch of a project that delivers by pull request. */
  readonly pullRequestBase?: string;
  readonly task?: Parameters<typeof taskDto>[0];
  readonly workstream?: ReturnType<typeof workstreamDto>;
  readonly batch?: ReturnType<typeof batchDto>;
  readonly batches?: ReturnType<typeof batchDto>[];
  readonly gateCommand?: string;
  readonly workstreams?: ReturnType<typeof workstreamDto>[];
  readonly place?: number;
  /** The project's area names, which let an unstarted task's areas change. */
  readonly areaNames?: readonly string[];
  /** The project delivers by pull request, so a separate copy can be chosen. */
  readonly placementEditable?: boolean;
  /** The column the card sits in; "Ready" unless given. */
  readonly columnName?: string;
  readonly onCancelRun?: (workstream: WorkstreamDto) => void;
  readonly onOpenWorkbench?: () => void;
  /** The project's account, whose models the task's own setting offers. */
  readonly accountId?: typeof DEFAULT_ACCOUNT.id;
}

function open(opts: Opts = {}): { closed: () => number } {
  let closes = 0;
  renderWithDaemon(
    <TaskDrawer
      task={taskDto({ workstreamId: opts.workstream?.id ?? null, ...opts.task })}
      columnName={opts.columnName ?? 'Ready'}
      peers={peers}
      {...(opts.workstream ? { workstream: opts.workstream } : {})}
      {...(opts.batch ? { batch: opts.batch } : {})}
      {...(opts.batches ? { batches: opts.batches } : {})}
      {...(opts.gateCommand ? { gateCommand: opts.gateCommand } : {})}
      {...(opts.workstreams ? { workstreams: opts.workstreams } : {})}
      {...(opts.place ? { place: opts.place } : {})}
      {...(opts.areaNames ? { areaNames: opts.areaNames } : {})}
      {...(opts.pullRequestBase ? { pullRequestBase: opts.pullRequestBase } : {})}
      {...(opts.placementEditable ? { placementEditable: true } : {})}
      {...(opts.onCancelRun ? { onCancelRun: opts.onCancelRun } : {})}
      {...(opts.onOpenWorkbench ? { onOpenWorkbench: opts.onOpenWorkbench } : {})}
      {...(opts.accountId ? { accountId: opts.accountId } : {})}
      onClose={() => {
        closes += 1;
      }}
    />,
  );
  return { closed: () => closes };
}

async function dialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Task' });
}

/** Opens a tab of the drawer by its name; "Reviews" matches the tab with or without its count. */
async function openTab(name: 'Overview' | 'Reviews' | 'Edit'): Promise<HTMLElement> {
  const d = await dialog();
  fireEvent.click(within(d).getByRole('tab', { name: new RegExp(`^${name}`) }));
  return d;
}

/** Changes a field of the form, which lives on the Edit tab. */
async function edit(label: string, value: string): Promise<void> {
  const d = await openTab('Edit');
  fireEvent.change(within(d).getByLabelText(label), { target: { value } });
}

/** The element's position relative to the other, as the document orders them. */
function follows(before: HTMLElement, after: HTMLElement): boolean {
  return (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function discardPrompt(): HTMLElement | null {
  return screen.queryByText('Discard your changes to this task?');
}

describe('TaskDrawer order', () => {
  const FIFO = 'Reject FIFOs in the worktree walk';
  const withHeadline = {
    title: FIFO,
    headline: "Odd files can't freeze 10db",
    why: 'A FIFO could hang every lane.',
    acceptanceCriteria: ['A FIFO is skipped', 'A huge file is skipped'],
  };

  it('opens on Overview: headline and why, one status line, the tabs, then what it promises and the shared branch', async () => {
    serve();
    const batch = batchDto({ prUrl: 'https://github.com/acme/widgets/pull/9' });
    const ws = workstreamDto({ batchId: batch.id, state: 'QUEUED' });
    const second = workstreamDto({ batchId: batch.id, state: 'QUEUED' });
    open({ task: withHeadline, workstream: ws, batch, workstreams: [ws, second] });
    const d = await dialog();
    const headline = within(d).getByRole('heading', { name: "Odd files can't freeze 10db" });
    const why = within(d).getByText('A FIFO could hang every lane.');
    const status = within(d).getByTestId('status-line');
    expect(within(status).getByRole('link', { name: 'Pull request' })).toBeTruthy();
    const tabs = within(d).getByRole('tablist');
    const promises = within(d).getByText('What it promises');
    const title = within(d).getByText(FIFO);
    const abandon = within(d).getByRole('button', { name: 'Abandon' });
    expect(within(status).getByText('Queued')).toBeTruthy();
    expect(
      within(d)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['A FIFO is skipped', 'A huge file is skipped']);
    const inOrder = [headline, why, status, tabs, promises, title, abandon];
    for (let i = 1; i < inOrder.length; i += 1) {
      const before = inOrder[i - 1];
      const after = inOrder[i];
      expect(
        before && after && follows(before, after),
        `element ${String(i)} follows element ${String(i - 1)}`,
      ).toBe(true);
    }
    // The pull request link is on the status line alone: not again in the shared branch.
    expect(within(d).getAllByRole('link', { name: 'Pull request' })).toHaveLength(1);
    // The form is on the Edit tab, and the tab selected is Overview.
    expect(within(d).getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(within(d).queryByLabelText('Title')).toBeNull();
  });

  it('has no Save bar on Overview or Reviews: Cancel and Save Changes are on Edit alone', async () => {
    serve();
    open({ task: withHeadline, workstream: workstreamDto({ state: 'DONE' }) });
    const d = await dialog();
    for (const name of ['Overview', 'Reviews'] as const) {
      await openTab(name);
      expect(within(d).queryByRole('button', { name: 'Save Changes' })).toBeNull();
      expect(within(d).queryByRole('button', { name: 'Cancel' })).toBeNull();
    }
    await openTab('Edit');
    expect(within(d).getByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('says the title once outside Edit: in the header without a headline, in What it promises with one', async () => {
    serve();
    renderWithDaemon(
      <TaskDrawer
        task={taskDto({ ...withHeadline, headline: '', why: '' })}
        columnName="Ready"
        peers={peers}
        onClose={() => undefined}
      />,
    );
    const d = await dialog();
    expect(within(d).getAllByText(FIFO)).toHaveLength(1);
    expect(within(d).getByRole('heading', { name: FIFO })).toBeTruthy();
    cleanup();
    open({ task: withHeadline });
    const again = await dialog();
    expect(within(again).getAllByText(FIFO)).toHaveLength(1);
  });

  it('with no headline shows the title as the header, only the criteria under What it promises, and a link to Edit', async () => {
    serve();
    open({
      task: { ...withHeadline, headline: '', why: '' },
    });
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: FIFO })).toBeTruthy();
    const promises = within(d).getByText('What it promises').parentElement;
    expect(promises?.textContent).toBe('What it promisesA FIFO is skippedA huge file is skipped');
    fireEvent.click(within(d).getByRole('button', { name: 'Add a headline' }));
    expect(within(d).getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true');
    expect(within(d).getByLabelText('Headline')).toBeTruthy();
  });

  it('with a headline offers no Add a headline, and with no why shows no why line', async () => {
    serve();
    open({ task: { ...withHeadline, why: '' } });
    const d = await dialog();
    expect(within(d).queryByRole('button', { name: 'Add a headline' })).toBeNull();
    expect(within(d).getByRole('heading', { name: "Odd files can't freeze 10db" })).toBeTruthy();
    expect(within(d).queryByText('A FIFO could hang every lane.')).toBeNull();
    expect(within(d).getByText(FIFO)).toBeTruthy();
  });

  it('is min(640px, 50vw) wide', async () => {
    serve();
    open();
    await dialog();
    // Mantine sets the width as a custom property on the drawer's root.
    const root = document.querySelector<HTMLElement>('[style*="--drawer-size"]');
    expect(root?.style.getPropertyValue('--drawer-size')).toMatch(
      /^min\(\s*(640px|40rem)\s*,\s*50vw\)$/,
    );
  });
});

describe('TaskDrawer placement', () => {
  it('shows the badge with the reason as its tooltip, and a control, while the placement is open', async () => {
    serve();
    open({
      task: { workspaceMode: 'worktree', placementReason: 'touches migrations' },
      placementEditable: true,
    });
    const d = await openTab('Edit');
    const badge = within(d).getByTestId('placement-badge');
    expect(badge.textContent).toBe('Separate copy');
    fireEvent.mouseEnter(badge);
    expect(await screen.findByText('touches migrations')).toBeTruthy();
    const group = within(d).getByRole('radiogroup', { name: 'Where Write the greeting runs' });
    expect(within(group).getByRole('radio', { name: 'Separate copy' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it.each<{
    name: string;
    editable: boolean;
    state?: WorkstreamDto['state'];
    status?: TaskDto['status'];
  }>([
    { name: 'a local project', editable: false },
    { name: 'a task with a running workstream', editable: true, state: 'RUNNING' },
    { name: 'a queued workstream', editable: true, state: 'QUEUED' },
    { name: 'a done task', editable: true, status: 'done', state: 'DONE' },
  ])('shows no control for $name', async ({ editable, state, status }) => {
    serve();
    open({
      placementEditable: editable,
      ...(status ? { task: { status } } : {}),
      ...(state ? { workstream: workstreamDto({ state }) } : {}),
    });
    const d = await openTab('Edit');
    expect(within(d).queryByRole('radiogroup')).toBeNull();
  });

  it('shows the badge in a local project but no control', async () => {
    serve();
    open({ placementEditable: false });
    const d = await openTab('Edit');
    expect(within(d).getByTestId('placement-badge').textContent).toBe('Your folder');
    expect(within(d).queryByRole('radiogroup')).toBeNull();
  });

  it('shows neither once the task has run past its placement', async () => {
    serve();
    open({
      placementEditable: true,
      workstream: workstreamDto({ state: 'RUNNING' }),
    });
    const d = await openTab('Edit');
    expect(within(d).queryByTestId('placement-badge')).toBeNull();
  });

  it('keeps both for a failed run, which can start again anywhere', async () => {
    serve();
    open({ placementEditable: true, workstream: workstreamDto({ state: 'FAILED' }) });
    const d = await openTab('Edit');
    expect(within(d).getByTestId('placement-badge')).toBeTruthy();
    expect(within(d).getByRole('radiogroup')).toBeTruthy();
  });

  it('patches only the placement when it is chosen, without closing or saving the rest', async () => {
    const patched: unknown[] = [];
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(taskDto({ workspaceMode: 'worktree' }));
      }),
    );
    const { closed } = open({ placementEditable: true });
    const d = await openTab('Edit');
    fireEvent.click(within(d).getByRole('radio', { name: 'Separate copy' }));
    await waitFor(() => {
      expect(patched).toEqual([{ workspaceMode: 'worktree' }]);
    });
    expect(closed()).toBe(0);
  });

  it("shows the daemon's refusal beside the control", async () => {
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Its start is still in progress' },
          { status: 409 },
        ),
      ),
    );
    open({ placementEditable: true });
    const d = await openTab('Edit');
    fireEvent.click(within(d).getByRole('radio', { name: 'Separate copy' }));
    expect(await within(d).findByText('Its start is still in progress')).toBeTruthy();
  });
});

describe('TaskDrawer', () => {
  it('shows the column on the status line and what the task waits on, with the areas and Title on Edit', async () => {
    const other = taskDto({ title: 'Set up the repo' });
    const another = taskDto({ title: 'Seed the database' });
    const map = new Map([
      [other.id, { title: other.title }],
      [another.id, { title: another.title }],
    ]);
    serve();
    renderWithDaemon(
      <TaskDrawer
        task={taskDto({
          title: 'Ship it',
          areas: ['api', 'ui'],
          dependsOn: [other.id, another.id],
        })}
        columnName="Ready"
        peers={map}
        onClose={() => undefined}
      />,
    );
    const d = await dialog();
    // The status line says the column; there is no separate badge for it.
    expect(within(within(d).getByTestId('status-line')).getByText('Ready')).toBeTruthy();
    expect(within(d).getAllByText('Ready')).toHaveLength(1);
    // Waits on is a labelled row of its own, one line a task, not dimmed text among badges.
    const waits = within(d).getByTestId('waits-on');
    expect(within(waits).getByText('Waits on')).toBeTruthy();
    expect(within(waits).getByText('Set up the repo')).toBeTruthy();
    expect(within(waits).getByText('Seed the database')).toBeTruthy();
    // Areas moved to Edit.
    expect(within(d).queryByText('api')).toBeNull();
    await openTab('Edit');
    expect(within(d).getByLabelText<HTMLInputElement>('Title').value).toBe('Ship it');
    expect(within(d).getByText('api')).toBeTruthy();
    expect(within(d).getByText('ui')).toBeTruthy();
  });

  it('shows no Waits on row for a task that waits on nothing', async () => {
    serve();
    open();
    expect(within(await dialog()).queryByTestId('waits-on')).toBeNull();
  });

  it('saves the title, description, criteria, kinds, rigor and effort', async () => {
    const security = kindDto({ key: 'security', label: 'Security', minimumRigor: 'careful' });
    const patched: TaskPatch[] = [];
    const task = taskDto();
    server.use(
      http.get(daemonUrl('/kinds'), () => HttpResponse.json([security])),
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push((await request.json()) as TaskPatch);
        return HttpResponse.json(task);
      }),
      ...baseHandlers(),
    );
    const { closed } = open({ task });
    await edit('Title', '  New title ');
    await edit('Description', ' Some words ');
    await edit('Acceptance criteria', ' first \n\n second ');
    const d = await dialog();
    fireEvent.click(within(d).getByLabelText('Kinds'));
    fireEvent.click(await screen.findByRole('option', { name: 'Security', hidden: true }));
    fireEvent.click(within(d).getByRole('combobox', { name: 'Rigor' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Critical', hidden: true }));
    fireEvent.click(within(d).getByRole('combobox', { name: 'Effort' }));
    fireEvent.click(await screen.findByRole('option', { name: 'high', hidden: true }));
    fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]).toEqual({
      title: 'New title',
      description: 'Some words',
      acceptanceCriteria: ['first', 'second'],
      rigor: 'critical',
      kinds: [{ key: 'security', source: 'builder' }],
      effortPin: 'high',
    });
    await waitFor(() => {
      expect(closed()).toBe(1);
    });
  });

  it('turns off the rigors below the kinds’ floor and names the kind', async () => {
    const security = kindDto({ key: 'security', label: 'Security', minimumRigor: 'careful' });
    server.use(
      http.get(daemonUrl('/kinds'), () => HttpResponse.json([security])),
      ...baseHandlers(),
    );
    open({ task: { kinds: [{ key: 'security', source: 'agent' }] } });
    const d = await openTab('Edit');
    fireEvent.click(within(d).getByRole('combobox', { name: 'Rigor' }));
    // The kinds arrive after the drawer opens; the option names the kind once they have.
    const light = await screen.findByRole('option', {
      name: /^Light.*Security needs/,
      hidden: true,
    });
    expect(light.textContent).toBe('Light (Security needs Careful or more)');
    expect(light.getAttribute('data-combobox-disabled')).toBe('true');
    const careful = await screen.findByRole('option', { name: 'Careful', hidden: true });
    expect(careful.getAttribute('data-combobox-disabled')).toBeNull();
  });

  it('shows the headline and why, and saves them trimmed when changed', async () => {
    const patched: TaskPatch[] = [];
    const task = taskDto({ headline: 'Old words', why: 'It mattered.' });
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push((await request.json()) as TaskPatch);
        return HttpResponse.json(task);
      }),
    );
    open({ task });
    const d = await openTab('Edit');
    expect(within(d).getByLabelText<HTMLInputElement>('Headline').value).toBe('Old words');
    expect(within(d).getByLabelText<HTMLInputElement>('Why').value).toBe('It mattered.');
    await edit('Headline', " Odd files can't freeze 10db ");
    await edit('Why', '  ');
    fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]).toMatchObject({ headline: "Odd files can't freeze 10db", why: '' });
  });

  describe('areas', () => {
    function serveAreaSaves(): TaskPatch[] {
      const patched: TaskPatch[] = [];
      serve(
        http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
          patched.push((await request.json()) as TaskPatch);
          return HttpResponse.json(taskDto());
        }),
      );
      return patched;
    }

    it('sets the areas of a task that has not started, from the project’s areas', async () => {
      const patched = serveAreaSaves();
      open({ task: { areas: [] }, areaNames: ['api', 'ui'] });
      const d = await openTab('Edit');
      fireEvent.click(within(d).getByLabelText('Areas'));
      fireEvent.click(await screen.findByRole('option', { name: 'ui', hidden: true }));
      fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => {
        expect(patched).toHaveLength(1);
      });
      expect(patched[0]?.areas).toEqual(['ui']);
    });

    it('leaves areas out of a save that did not change them', async () => {
      const patched = serveAreaSaves();
      open({ task: { areas: ['api'] }, areaNames: ['api', 'ui'] });
      await edit('Title', 'Other');
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => {
        expect(patched).toHaveLength(1);
      });
      expect(patched[0]).not.toHaveProperty('areas');
    });

    it('asks for an area before saving a change that leaves none', async () => {
      const patched = serveAreaSaves();
      open({ task: { areas: ['api'] }, areaNames: ['api', 'ui'] });
      const d = await openTab('Edit');
      fireEvent.click(within(d).getByLabelText('Areas'));
      fireEvent.click(await screen.findByRole('option', { name: 'api', hidden: true }));
      fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));
      expect(await within(d).findByText('Choose at least one area')).toBeTruthy();
      expect(patched).toEqual([]);
    });

    it('shows the areas of a task that has started as fixed', async () => {
      serve();
      open({
        task: { areas: ['api'], workstreamId: mintId('Workstream') },
        areaNames: ['api', 'ui'],
        workstream: workstreamDto(),
      });
      const d = await openTab('Edit');
      expect(within(d).getByText('api')).toBeTruthy();
      expect(within(d).queryByLabelText('Areas')).toBeNull();
    });
  });

  describe('where the work lands', () => {
    /** Serves the patch route and records what was sent. */
    function serveSaves(): TaskPatch[] {
      const patched: TaskPatch[] = [];
      serve(
        http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
          patched.push((await request.json()) as TaskPatch);
          return HttpResponse.json(taskDto());
        }),
      );
      return patched;
    }
    const choice = async (name: string) =>
      within(await openTab('Edit')).getByRole<HTMLInputElement>('radio', { name });
    const save = async () =>
      fireEvent.click(within(await openTab('Edit')).getByRole('button', { name: 'Save Changes' }));

    it('starts from the task and names the base branch', async () => {
      serveSaves();
      open({ pullRequestBase: 'develop', task: { landing: { kind: 'hold' } } });
      expect((await choice('Hold for my review')).checked).toBe(true);
      expect((await choice('Merge into develop')).checked).toBe(false);
    });

    it('shows the branch a task merges into', async () => {
      serveSaves();
      open({
        pullRequestBase: 'main',
        task: { landing: { kind: 'branch', branch: 'feature/x' } },
      });
      expect((await choice('Merge into another branch')).checked).toBe(true);
      expect(
        within(await dialog()).getByLabelText<HTMLInputElement>('Branch to merge into').value,
      ).toBe('feature/x');
    });

    it('sends a changed landing with the other fields', async () => {
      const patched = serveSaves();
      open({ pullRequestBase: 'main' });
      fireEvent.click(await choice('Hold for my review'));
      await save();
      await waitFor(() => {
        expect(patched).toHaveLength(1);
      });
      expect(patched[0]).toMatchObject({ landing: { kind: 'hold' } });
    });

    it('sends nothing about it when it did not change', async () => {
      const patched = serveSaves();
      open({ pullRequestBase: 'main' });
      await edit('Title', 'Another');
      await save();
      await waitFor(() => {
        expect(patched).toHaveLength(1);
      });
      expect(patched[0]).not.toHaveProperty('landing');
    });

    it('counts a changed landing as an edit to discard', async () => {
      serveSaves();
      open({ pullRequestBase: 'main' });
      fireEvent.click(await choice('Hold for my review'));
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
    });

    it('asks for a branch name before saving', async () => {
      const patched = serveSaves();
      open({ pullRequestBase: 'main' });
      fireEvent.click(await choice('Merge into another branch'));
      await save();
      expect(await screen.findByText('Name the branch this task merges into')).toBeTruthy();
      expect(patched).toEqual([]);
    });

    it('says where a started task will land, and offers no change', async () => {
      serveSaves();
      open({
        pullRequestBase: 'main',
        task: { workstreamId: workstreamDto().id },
        batch: batchDto({ baseBranch: 'release', autoMerge: true }),
        workstream: workstreamDto({ state: 'RUNNING' }),
      });
      const d = await openTab('Edit');
      expect(within(d).getByText('Merges into release when checks pass')).toBeTruthy();
      expect(within(d).queryByRole('radio')).toBeNull();
    });

    it('shows nothing for a project that commits directly', async () => {
      serveSaves();
      open();
      await openTab('Edit');
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.queryByText('Where it lands')).toBeNull();
    });
  });

  it('refuses an empty title', async () => {
    let requests = 0;
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () => {
        requests += 1;
        return HttpResponse.json(taskDto());
      }),
    );
    open();
    await edit('Title', '   ');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Give the task a title')).toBeTruthy();
    expect(requests).toBe(0);
  });

  it('refuses no criteria', async () => {
    let requests = 0;
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () => {
        requests += 1;
        return HttpResponse.json(taskDto());
      }),
    );
    open();
    await edit('Acceptance criteria', ' \n ');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Add at least one acceptance criterion')).toBeTruthy();
    expect(requests).toBe(0);
  });

  it("shows the daemon's refusal beside Save", async () => {
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () =>
        HttpResponse.json({ error: 'task is archived' }, { status: 409 }),
      ),
    );
    open();
    await edit('Title', 'Another');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText(/^Couldn't save: /)).toBeTruthy();
  });

  it('says changes apply next session while a workstream runs', async () => {
    serve();
    open({ workstream: workstreamDto({ state: 'RUNNING' }) });
    expect(screen.queryByText("Changes apply from the task's next session.")).toBeNull();
    await openTab('Edit');
    expect(await screen.findByText("Changes apply from the task's next session.")).toBeTruthy();
  });

  it('says nothing about sessions when there is no live workstream', async () => {
    serve();
    open({ workstream: workstreamDto({ state: 'DONE' }) });
    await openTab('Edit');
    expect(screen.queryByText("Changes apply from the task's next session.")).toBeNull();
  });

  describe('closing', () => {
    it('with edits asks first; Keep Editing keeps the drawer and the edit', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
      expect(closed()).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
      await waitFor(() => {
        expect(discardPrompt()).toBeNull();
      });
      expect(closed()).toBe(0);
      expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Changed');
    });

    it('Discard closes the drawer', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      await screen.findByText('Discard your changes to this task?');
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(closed()).toBe(1);
    });

    it('Escape with edits asks too', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      fireEvent.keyDown(await dialog(), { key: 'Escape' });
      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
      expect(closed()).toBe(0);
    });

    it('with no edits closes at once', async () => {
      serve();
      const { closed } = open();
      fireEvent.click(within(await openTab('Edit')).getByRole('button', { name: 'Cancel' }));
      expect(closed()).toBe(1);
      expect(discardPrompt()).toBeNull();
    });

    it('asks when it is closed from another tab with edits kept from Edit', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      await openTab('Overview');
      fireEvent.keyDown(await dialog(), { key: 'Escape' });
      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
      expect(closed()).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
      // The edit survived the tab switch.
      await openTab('Edit');
      expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Changed');
    });
  });

  it('reads risk options in plain words', () => {
    expect(RISK_LABEL).toEqual({
      [RiskTag.Security]: 'Security',
      [RiskTag.Auth]: 'Sign-in and permissions',
      [RiskTag.Migration]: 'Database migration',
      [RiskTag.Dependency]: 'Dependencies',
    });
  });

  describe('notices', () => {
    it('says what the task waits for, naming the other task, in full', async () => {
      serve();
      open({
        workstream: workstreamDto({
          state: 'RUNNING',
          notice: {
            key: 'claim-wait:hazard:migrations',
            tone: 'info',
            line: 'Waiting for hazard migrations: task "Beta" holds it',
            body: 'Task "Beta" holds hazard migrations. Task "Alpha" is waiting for it and continues when it frees.',
          },
        }),
      });
      const d = await dialog();
      expect(
        within(d).getByText('Waiting for hazard migrations: task "Beta" holds it'),
      ).toBeTruthy();
      expect(
        within(d).getByText(/Task "Beta" holds hazard migrations\. Task "Alpha"/),
      ).toBeTruthy();
    });

    it('links a task waiting for the pass that holds the folder to the UI Workbench', async () => {
      serve();
      let opened = 0;
      open({
        workstream: workstreamDto({
          state: 'QUEUED',
          notice: {
            key: PASS_FOLDER_WAIT_NOTICE_KEY,
            tone: 'info',
            line: PASS_FOLDER_WAIT_LINE,
            body: 'Your folder is in the UI Workbench pass "Settings pass".',
          },
        }),
        onOpenWorkbench: () => {
          opened += 1;
        },
      });
      const d = await dialog();
      expect(within(d).getByText(PASS_FOLDER_WAIT_LINE)).toBeTruthy();
      fireEvent.click(within(d).getByRole('button', { name: 'Open UI Workbench' }));
      expect(opened).toBe(1);
    });

    it.each([
      { name: 'holds saved UI Workbench work', keptWork: true },
      { name: 'holds none', keptWork: false },
    ])('says so when the task $name', async ({ keptWork }) => {
      serve();
      open({ task: { keptWork } });
      const d = await dialog();
      expect(
        within(d).queryByText('Has saved UI Workbench work: its next start puts it back.') !== null,
      ).toBe(keptWork);
    });

    it('discards saved UI Workbench work after a confirm, for that task only', async () => {
      const discarded: string[] = [];
      serve(
        http.delete(daemonUrl('/tasks/:taskId/kept-work'), ({ params }) => {
          discarded.push(String(params['taskId']));
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const task = taskDto({ keptWork: true });
      open({ task });
      const d = await dialog();
      fireEvent.click(within(d).getByRole('button', { name: 'Discard Saved Work' }));
      const confirm = await screen.findByRole('dialog', { name: 'Discard Saved Work' });
      expect(within(confirm).getByText(/can't be undone/)).toBeTruthy();
      fireEvent.click(within(confirm).getByRole('button', { name: 'Discard Saved Work' }));
      await waitFor(() => {
        expect(discarded).toEqual([task.id]);
      });
    });

    it("says what the task's batch stands in, with the steps to fix it", async () => {
      serve();
      const batch = batchDto({
        notices: [
          {
            key: 'base-conflict',
            tone: 'warning',
            line: 'Conflicts with main: README.md',
            body: 'main on origin changed these files:\n- README.md\n\nResolve it on GitHub.',
          },
        ],
      });
      open({ workstream: workstreamDto({ state: 'DONE', batchId: batch.id }), batch });
      const d = await dialog();
      expect(within(d).getByText('Conflicts with main: README.md')).toBeTruthy();
      expect(within(d).getByText(/Resolve it on GitHub\./)).toBeTruthy();
    });

    describe('an install that was repaired', () => {
      const repaired = {
        key: INSTALL_REPAIRED_NOTICE_KEY,
        tone: 'info' as const,
        line: 'The install in this copy was repaired at 2026-11-03 10:00 UTC',
        body: 'The first install left it broken, so it started over.',
      };

      it('still shows, with the time, on a failed run', async () => {
        serve();
        const batch = batchDto({ state: 'OPEN', notices: [repaired] });
        open({ workstream: workstreamDto({ state: 'FAILED', batchId: batch.id }), batch });
        const d = await dialog();
        expect(within(d).getByText(repaired.line)).toBeTruthy();
      });

      it('still shows on finished work in a closed batch, without what the batch stood in', async () => {
        serve();
        const batch = batchDto({
          state: 'CLOSED',
          notices: [
            {
              key: 'base-conflict',
              tone: 'warning',
              line: 'Conflicts with main: README.md',
              body: 'main on origin changed these files:\n- README.md',
            },
            repaired,
          ],
        });
        open({ workstream: workstreamDto({ state: 'DONE', batchId: batch.id }), batch });
        const d = await dialog();
        expect(within(d).getByText(repaired.line)).toBeTruthy();
        expect(within(d).queryByText('Conflicts with main: README.md')).toBeNull();
      });
    });

    it('shows no notice for a task with none', async () => {
      serve();
      open({ workstream: workstreamDto({ state: 'RUNNING' }) });
      const d = await dialog();
      expect(within(d).queryByTestId('task-notice')).toBeNull();
    });
  });

  describe('delivery', () => {
    it('shows the branch, the pull request and Abandon with what Abandon does', async () => {
      serve();
      const batch = batchDto({ prUrl: 'https://github.com/acme/widgets/pull/9' });
      const ws = workstreamDto({ batchId: batch.id, state: 'QUEUED' });
      open({ workstream: ws, batch, workstreams: [ws] });
      const d = await dialog();
      expect(within(d).getByText('10db/greetings-0a1b2c3d')).toBeTruthy();
      expect(within(d).getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(
        'https://github.com/acme/widgets/pull/9',
      );
      expect(within(d).getByRole('button', { name: 'Abandon' })).toBeTruthy();
      expect(
        within(d).getByText(
          'Abandon deletes the branch if nothing is committed on it and keeps it otherwise, and cancels its unfinished task.',
        ),
      ).toBeTruthy();
    });

    it('says why a ship failed, links the gate log and offers Retry', async () => {
      serve();
      const batch = batchDto({
        state: 'FAILED',
        failure: 'gate_failed',
        gateExitCode: 1,
        gateLogPath: '/data/logs/gate/b.log',
      });
      open({
        workstream: workstreamDto({ state: 'DONE', batchId: batch.id }),
        batch,
        gateCommand: 'make gate',
      });
      const d = await dialog();
      expect(within(d).getByText('Not shipped: the gate failed')).toBeTruthy();
      expect(within(d).getByText('make gate exited with code 1')).toBeTruthy();
      expect(within(d).getByRole('link', { name: 'Gate log' })).toBeTruthy();
      expect(within(d).getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    it('shows no delivery section for a task with no batch', async () => {
      serve();
      open({ workstream: workstreamDto() });
      const d = await dialog();
      expect(within(d).queryByRole('button', { name: 'Abandon' })).toBeNull();
    });
  });

  describe('workstream state', () => {
    it.each([
      'no_result',
      'gate_failed',
      'session_failed',
      'retry_limit',
      'rejected_at_limit',
      null,
    ] as const)(
      'a %s failure shows Failed, the plain line, the raw reason and Retry',
      async (kind) => {
        serve();
        const workstream = workstreamDto({
          state: 'FAILED',
          failureKind: kind,
          failureReason: 'The gate failed twice',
          steps: [stepDto({ status: 'failed' })],
        });
        open({ workstream });
        const d = await dialog();
        expect(within(d).getByText('Failed')).toBeTruthy();
        expect(within(d).getByText(failureLine(workstream, true))).toBeTruthy();
        expect(within(d).getByText('The gate failed twice')).toBeTruthy();
        expect(within(d).getByRole('button', { name: 'Retry' })).toBeTruthy();
      },
    );

    it('a failed task shows Failed, its reason and Retry', async () => {
      serve();
      open({
        workstream: workstreamDto({ state: 'FAILED', failureReason: 'The gate failed twice' }),
      });
      const d = await dialog();
      expect(within(d).getByText('Failed')).toBeTruthy();
      expect(within(d).getByText('The run failed. Retry runs it again.')).toBeTruthy();
      expect(within(d).getByText('The gate failed twice')).toBeTruthy();
      const retry = within(d).getByRole('button', { name: 'Retry' });
      expect((retry as HTMLButtonElement).disabled).toBe(false);
    });

    it('a failed run of a parked task says what happened and offers no Retry', async () => {
      serve();
      open({
        task: { boardColumnId: mintId('BoardColumn') },
        workstream: workstreamDto({ state: 'FAILED', failureReason: 'The gate failed twice' }),
      });
      const d = await dialog();
      expect(within(d).getByText('The run failed.')).toBeTruthy();
      expect(within(d).queryByText(/Retry runs/)).toBeNull();
      expect(within(d).queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('a queued task shows its place in line and Run Next, which says what it waits on', async () => {
      const ws = workstreamDto({ state: 'QUEUED' });
      const asked: string[] = [];
      serve(
        http.post(daemonUrl('/tasks/:taskId/run-next'), ({ params }) => {
          asked.push(String(params['taskId']));
          return HttpResponse.json({ workstream: ws, waitingOn: ['Base'] });
        }),
      );
      open({ task: { id: ws.taskId, title: 'Urgent fix' }, workstream: ws, place: 4 });
      const d = await dialog();
      expect(within(d).getByText('4th in line')).toBeTruthy();
      fireEvent.click(within(d).getByRole('button', { name: 'Run Next' }));
      // The drawer is the task's own, so the note doesn't name it again.
      expect(
        await within(d).findByText('It will run once Base is done, before the other queued tasks.'),
      ).toBeTruthy();
      expect(asked).toEqual([ws.taskId]);
    });

    it('offers no Run Next to a task that is running, or one parked in a column', async () => {
      serve();
      open({ workstream: workstreamDto({ state: 'RUNNING' }) });
      expect(within(await dialog()).queryByRole('button', { name: 'Run Next' })).toBeNull();
    });

    it('offers no Run Next to a parked task whose run is queued', async () => {
      serve();
      open({
        task: { boardColumnId: mintId('BoardColumn') },
        workstream: workstreamDto({ state: 'QUEUED' }),
      });
      expect(within(await dialog()).queryByRole('button', { name: 'Run Next' })).toBeNull();
    });

    it('Retry posts /workstreams/:id/retry', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      const retried: string[] = [];
      serve(
        http.post(daemonUrl('/workstreams/:id/retry'), ({ params }) => {
          retried.push(String(params['id']));
          return HttpResponse.json({ ...ws, state: 'QUEUED' });
        }),
      );
      open({ workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(retried).toEqual([ws.id]);
      });
    });

    it('Retry posts the note the builder wrote, and no note when the field is empty', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      const bodies: unknown[] = [];
      serve(
        http.post(daemonUrl('/workstreams/:id/retry'), async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ ...ws, state: 'QUEUED' });
        }),
      );
      open({ workstream: ws });
      const d = await dialog();
      // A gate failure, not a review: the note still reaches the next session, and says so.
      expect(
        within(d).getByText(
          'The session the retry starts gets this note, and the review’s findings too when a review sent the work back.',
        ),
      ).toBeTruthy();
      fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(bodies).toEqual([{}]);
      });
      fireEvent.change(within(d).getByLabelText('Note for the next session (optional)'), {
        target: { value: 'Use the existing card.' },
      });
      fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(bodies).toEqual([{}, { note: 'Use the existing card.' }]);
      });
    });

    it('offers Start over beside Retry for a failed run in an open batch, and posts fresh', async () => {
      const batch = batchDto();
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom', batchId: batch.id });
      const bodies: unknown[] = [];
      serve(
        http.post(daemonUrl('/tasks/:taskId/start'), async ({ request }) => {
          // The body rides along without replacing the client's headers.
          expect(request.headers.get('authorization')).toBe('Bearer test-token');
          bodies.push(await request.json());
          return HttpResponse.json({ ...ws, state: 'QUEUED' }, { status: 201 });
        }),
      );
      open({ workstream: ws, batch, workstreams: [ws] });
      const d = await dialog();
      expect(within(d).getByRole('button', { name: 'Retry' })).toBeTruthy();
      fireEvent.click(within(d).getByRole('button', { name: 'Start over' }));
      await waitFor(() => {
        expect(bodies).toEqual([{ fresh: true }]);
      });
    });

    it('offers no Start over for a failed run outside a batch, or in one that shipped', async () => {
      serve();
      open({ workstream: workstreamDto({ state: 'FAILED', failureReason: 'boom' }) });
      expect(within(await dialog()).queryByRole('button', { name: 'Start over' })).toBeNull();
    });

    it('offers no Start over to a parked task, which the daemon would refuse to start', async () => {
      serve();
      const batch = batchDto();
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom', batchId: batch.id });
      open({
        task: { boardColumnId: mintId('BoardColumn') },
        workstream: ws,
        batch,
        workstreams: [ws],
      });
      expect(within(await dialog()).queryByRole('button', { name: 'Start over' })).toBeNull();
    });

    it('a retry refusal shows beside Retry', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      serve(
        http.post(daemonUrl('/workstreams/:id/retry'), () =>
          HttpResponse.json({ error: 'nope' }, { status: 409 }),
        ),
      );
      open({ workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(/^Couldn't retry: /)).toBeTruthy();
    });

    it('a failed task offers Close with what happens to its branch and worktree', async () => {
      serve();
      const batch = batchDto({ worktreePath: '/tmp/wt' });
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom', batchId: batch.id });
      open({ workstream: ws, batch, workstreams: [ws] });
      const d = await dialog();
      expect(within(d).getByRole('button', { name: 'Close task' })).toBeTruthy();
      expect(
        within(d).getByText(
          'Close keeps the branch 10db/greetings-0a1b2c3d and its worktree as they are.',
        ),
      ).toBeTruthy();
    });

    it('Close posts /tasks/:id/close and closes the drawer', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      const task = taskDto({ workstreamId: ws.id });
      const closed: string[] = [];
      serve(
        http.post(daemonUrl('/tasks/:taskId/close'), ({ params }) => {
          closed.push(String(params['taskId']));
          return HttpResponse.json({ ...task, status: 'cancelled' });
        }),
      );
      const drawer = open({ task, workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close task' }));
      await waitFor(() => {
        expect(closed).toEqual([task.id]);
      });
      await waitFor(() => {
        expect(drawer.closed()).toBe(1);
      });
    });

    describe('when the pull request closed without merging', () => {
      const closedPr = () =>
        batchDto({
          state: 'SHIPPED',
          prUrl: 'https://github.com/acme/widgets/pull/4',
          pr: {
            state: 'closed',
            checks: 'passing',
            failingChecks: [],
            checkedAt: '2026-10-29T12:00:00.000Z',
            unknownReason: null,
          },
        });

      it('says so, and posts /reopen from Reopen task and /close from Close task', async () => {
        const batch = closedPr();
        const ws = workstreamDto({ state: 'DONE', batchId: batch.id });
        const task = taskDto({ workstreamId: ws.id, status: 'done', boardStatus: 'blocked' });
        const calls: string[] = [];
        serve(
          http.post(daemonUrl('/tasks/:taskId/reopen'), ({ params }) => {
            calls.push(`reopen ${String(params['taskId'])}`);
            return HttpResponse.json({ ...task, status: 'open' });
          }),
          http.post(daemonUrl('/tasks/:taskId/close'), ({ params }) => {
            calls.push(`close ${String(params['taskId'])}`);
            return HttpResponse.json({ ...task, status: 'cancelled' });
          }),
        );
        open({ task, workstream: ws, batch, workstreams: [ws] });
        const d = await dialog();
        expect(within(d).getByText('The pull request closed without merging.')).toBeTruthy();
        fireEvent.click(within(d).getByRole('button', { name: 'Reopen task' }));
        await waitFor(() => {
          expect(calls).toEqual([`reopen ${task.id}`]);
        });
        fireEvent.click(within(d).getByRole('button', { name: 'Close task' }));
        await waitFor(() => {
          expect(calls).toEqual([`reopen ${task.id}`, `close ${task.id}`]);
        });
      });

      it('offers neither while the pull request is open', async () => {
        const batch = batchDto({
          state: 'SHIPPED',
          prUrl: 'https://github.com/acme/widgets/pull/4',
        });
        const ws = workstreamDto({ state: 'DONE', batchId: batch.id });
        const task = taskDto({ workstreamId: ws.id, status: 'done', boardStatus: 'in_review' });
        serve();
        open({ task, workstream: ws, batch, workstreams: [ws] });
        const d = await dialog();
        expect(within(d).queryByRole('button', { name: 'Reopen task' })).toBeNull();
        expect(within(d).queryByRole('button', { name: 'Close task' })).toBeNull();
      });
    });

    describe('with required checks', () => {
      const url = 'https://github.com/acme/widgets/pull/4';
      const jobUrl = 'https://github.com/acme/widgets/actions/runs/5/job/6';
      const shippedWith = (patch: Partial<BatchDto>) =>
        batchDto({
          state: 'SHIPPED',
          prUrl: url,
          pr: {
            state: 'open',
            checks: 'pending',
            failingChecks: [],
            checkedAt: '2026-10-29T12:00:00.000Z',
            unknownReason: null,
          },
          ...patch,
        });

      it('says where CI stands on the status line, which carries the pull request and CI job links', async () => {
        const batch = shippedWith({
          prRequired: {
            state: 'failing',
            failing: [{ name: 'build', link: jobUrl, jobId: '6', runId: '5', description: null }],
            pending: [],
            cancelled: [],
          },
        });
        const ws = workstreamDto({ state: 'DONE', batchId: batch.id });
        const task = taskDto({ workstreamId: ws.id, status: 'done', boardStatus: 'in_review' });
        serve();
        open({
          task,
          workstream: ws,
          batch,
          batches: [batch],
          workstreams: [ws],
          columnName: 'In review',
        });
        const d = await dialog();
        const status = await within(d).findByTestId('status-line');
        // The column the card sits in, then where CI stands: one line, no second "Pull request open".
        expect(within(status).getByText('In review')).toBeTruthy();
        expect(within(status).getByTestId('ci-line').textContent).toBe('CI failed: build');
        expect(within(status).getByRole('link', { name: 'CI job' }).getAttribute('href')).toBe(
          jobUrl,
        );
        expect(
          within(status).getByRole('link', { name: 'Pull request' }).getAttribute('href'),
        ).toBe(url);
        // Nothing else repeats them: no separate links row, no second pull request link.
        expect(within(d).queryByTestId('drawer-links')).toBeNull();
        expect(within(d).getAllByRole('link', { name: 'Pull request' })).toHaveLength(1);
        expect(within(d).getAllByRole('link', { name: 'CI job' })).toHaveLength(1);
        expect(within(d).queryByText(/^Pull request open/)).toBeNull();
      });

      it('says nothing of CI for a pull request with no required checks', async () => {
        const batch = shippedWith({
          prRequired: { state: 'none', failing: [], pending: [], cancelled: [] },
        });
        const ws = workstreamDto({ state: 'DONE', batchId: batch.id });
        const task = taskDto({ workstreamId: ws.id, status: 'done', boardStatus: 'in_review' });
        serve();
        open({ task, workstream: ws, batch, batches: [batch], workstreams: [ws] });
        await dialog();
        expect(screen.queryByTestId('ci-line')).toBeNull();
      });
    });

    it('a refusal to close names what blocks it', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      serve(
        http.post(daemonUrl('/tasks/:taskId/close'), () =>
          HttpResponse.json(
            { error: 'conflict', message: "Task A can't be closed while Child waits on it" },
            { status: 409 },
          ),
        ),
      );
      open({ workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close task' }));
      expect(
        await screen.findByText("Couldn't close: Task A can't be closed while Child waits on it"),
      ).toBeTruthy();
    });

    it.each(['QUEUED', 'RUNNING', 'WAITING_HUMAN', 'DONE', 'CANCELLED'] as const)(
      'a %s workstream offers no Close',
      async (state) => {
        serve();
        open({ workstream: workstreamDto({ state }) });
        const d = await dialog();
        expect(within(d).queryByRole('button', { name: 'Close task' })).toBeNull();
      },
    );

    it.each(['DONE', 'CANCELLED'] as const)(
      'a %s workstream shows no state line',
      async (state) => {
        serve();
        open({ workstream: workstreamDto({ state }) });
        const d = await dialog();
        expect(within(d).queryByText(state === 'DONE' ? 'Done' : 'Cancelled')).toBeNull();
        expect(within(d).queryByRole('button', { name: 'Retry' })).toBeNull();
      },
    );

    it('an absent workstream shows no state line', async () => {
      serve();
      open();
      const d = await dialog();
      expect(within(d).queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(within(d).queryByText('Failed')).toBeNull();
    });

    it.each([
      { state: 'QUEUED', buttons: ['Run Next', 'Hold'] },
      { state: 'FAILED', buttons: ['Retry', 'Close task'] },
      { state: 'RUNNING', buttons: ['Cancel Run'] },
      { state: 'HELD', buttons: ['Start', 'Remove'] },
    ] as const)(
      'puts the run actions of a $state task on the status line',
      async ({ state, buttons }) => {
        serve();
        open({
          workstream: workstreamDto({ state, failureReason: 'boom' }),
          onCancelRun: () => undefined,
        });
        const status = within(await dialog()).getByTestId('status-line');
        for (const name of buttons) {
          expect(within(status).getByRole('button', { name }), name).toBeTruthy();
        }
      },
    );

    it('Cancel Run asks the board to cancel the run', async () => {
      serve();
      const asked: string[] = [];
      const ws = workstreamDto({ state: 'RUNNING' });
      open({
        workstream: ws,
        onCancelRun: (w) => {
          asked.push(w.id);
        },
      });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel Run' }));
      expect(asked).toEqual([ws.id]);
    });

    describe('Hold', () => {
      it('is a button for a queued run that has not run', async () => {
        serve();
        open({ workstream: workstreamDto({ state: 'QUEUED', sessionCount: 0, attempt: 0 }) });
        const hold = within(await dialog()).getByRole('button', { name: 'Hold' });
        expect((hold as HTMLButtonElement).disabled).toBe(false);
      });

      it('is disabled with its reason in a tooltip, and no sentence, for a run the daemon would refuse', async () => {
        serve();
        open({
          task: { title: 'Reject FIFOs' },
          workstream: workstreamDto({ state: 'RUNNING' }),
        });
        const d = await dialog();
        expect(within(d).getByRole<HTMLButtonElement>('button', { name: 'Hold' }).disabled).toBe(
          true,
        );
        expect(within(d).queryByText(/cancel it first/)).toBeNull();
        fireEvent.mouseEnter(within(d).getByTestId('hold-refused'));
        const reason = await screen.findByText('It is running: cancel it first.');
        expect(reason.textContent).not.toContain('Reject FIFOs');
      });
    });
  });

  describe('review rounds', () => {
    const round = (d: HTMLElement, index: number): HTMLElement => {
      const found = within(d).getAllByTestId('review-round')[index];
      if (!found) throw new Error(`no round ${String(index)}`);
      return found;
    };
    const result = (verdict: 'approve' | 'reject', at: string, summary: string) => ({
      summary,
      verdict,
      sessionId: mintId('Session'),
      at,
    });
    const reviewed = (state: 'FAILED' | 'DONE') =>
      workstreamDto({
        state,
        steps: [
          stepDto(),
          stepDto({
            role: 'review',
            personaName: 'Reviewer',
            tools: 'read_only',
            earlier: [
              result('reject', '2026-10-29T10:00:00.000Z', '1. BLOCKING src/a.ts:12 no test.'),
            ],
            result: result('approve', '2026-10-29T11:00:00.000Z', 'Looks right.'),
          }),
        ],
      });

    it('counts the rounds on the Reviews tab, and keeps them off Overview', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await dialog();
      expect(within(d).getByRole('tab', { name: /^Reviews/ }).textContent).toBe('Reviews2');
      expect(within(d).queryByTestId('review-round')).toBeNull();
    });

    it('shows the latest verdict on Overview, which opens the Reviews tab', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await dialog();
      const latest = within(d).getByTestId('latest-review');
      expect(within(latest).getByText('Latest review')).toBeTruthy();
      expect(within(latest).getByText('Approved by Reviewer')).toBeTruthy();
      fireEvent.click(within(latest).getByRole('button', { name: 'Reviews' }));
      expect(within(d).getAllByTestId('review-round')).toHaveLength(2);
      expect(within(d).queryByTestId('latest-review')).toBeNull();
    });

    it('shows a tab with no count and no latest review for a task nobody reviewed', async () => {
      serve();
      open({ workstream: workstreamDto({ steps: [stepDto()] }) });
      const d = await dialog();
      expect(within(d).getByRole('tab', { name: 'Reviews' }).textContent).toBe('Reviews');
      expect(within(d).queryByTestId('latest-review')).toBeNull();
      await openTab('Reviews');
      expect(within(d).getByText('Nobody has reviewed this task yet.')).toBeTruthy();
    });

    it('lists every round with its verdict and findings, newest first', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await openTab('Reviews');
      expect(within(d).getAllByTestId('review-round')).toHaveLength(2);
      expect(within(round(d, 0)).getByText('Approved')).toBeTruthy();
      expect(within(round(d, 1)).getByText('Sent back')).toBeTruthy();
      expect(within(round(d, 1)).getByText('BLOCKING')).toBeTruthy();
      expect(within(round(d, 1)).getByText('src/a.ts:12')).toBeTruthy();
    });

    it('keeps the full review one click away', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await openTab('Reviews');
      const sentBack = round(d, 1);
      expect(within(sentBack).queryByText('1. BLOCKING src/a.ts:12 no test.')).toBeNull();
      fireEvent.click(within(sentBack).getByRole('button', { name: 'Show the full review' }));
      expect(within(sentBack).getByText('1. BLOCKING src/a.ts:12 no test.')).toBeTruthy();
    });

    it('says a task shipped at the retry limit with open findings, and names the follow-up task', async () => {
      serve();
      const rejected = result(
        'reject',
        '2026-10-29T11:00:00.000Z',
        '1. BLOCKING src/a.ts:12 no test.',
      );
      open({
        workstream: workstreamDto({
          state: 'DONE',
          steps: [
            stepDto(),
            stepDto({
              role: 'review',
              personaName: 'Reviewer',
              tools: 'read_only',
              result: rejected,
              shippedAtLimit: {
                followUpTaskId: mintId('Task'),
                followUpTitle: 'Resolve the open findings of "Add the badge"',
              },
            }),
          ],
        }),
      });
      const d = await dialog();
      const notice = within(d).getByTestId('shipped-at-limit');
      expect(notice.textContent).toContain('Shipped at the retry limit with open findings');
      expect(notice.textContent).toContain('Resolve the open findings of "Add the badge"');
      expect(
        within(within(d).getByTestId('latest-review')).getByText(/^Open at the limit/),
      ).toBeTruthy();
      await openTab('Reviews');
      expect(within(round(d, 0)).getByText('Open at the limit')).toBeTruthy();
      expect(within(round(d, 0)).queryByText('Sent back')).toBeNull();
    });

    it('shows no limit notice for a task that was approved', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await dialog();
      expect(within(d).queryByTestId('shipped-at-limit')).toBeNull();
    });

    it('shows no rounds for a task nobody reviewed', async () => {
      serve();
      open({ workstream: workstreamDto({ steps: [stepDto()] }) });
      await openTab('Reviews');
      expect(screen.queryByTestId('review-round')).toBeNull();
    });
  });
});

describe('TaskDrawer model setting', () => {
  const offered = [
    modelRowDto({
      model: 'fast-a',
      name: 'Fast A',
      tier: 'efficient',
      availableOn: [DEFAULT_ACCOUNT.id],
    }),
  ];
  function serveModels(patched: TaskPatch[]) {
    serve(
      http.get(daemonUrl('/models'), () => HttpResponse.json(offered)),
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push(TaskPatch.parse(await request.json()));
        return HttpResponse.json(taskDto());
      }),
    );
  }

  it('is not offered when the drawer does not know the project’s account', async () => {
    serveModels([]);
    open();
    const d = await openTab('Edit');
    expect(within(d).queryByRole('combobox', { name: 'Model' })).toBeNull();
  });

  it('starts with no override, and saves the pick with the rest of the form', async () => {
    const patched: TaskPatch[] = [];
    serveModels(patched);
    open({ accountId: DEFAULT_ACCOUNT.id });
    const d = await openTab('Edit');
    const field = within(d).getByRole<HTMLInputElement>('combobox', { name: 'Model' });
    expect(field.value).toBe('No override');
    fireEvent.click(field);
    fireEvent.click(await screen.findByRole('option', { name: 'Fast A', hidden: true }));
    fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]).toMatchObject({ modelSetting: { kind: 'model', model: 'fast-a' } });
  });

  it('shows a saved override and removes it with No override', async () => {
    const patched: TaskPatch[] = [];
    serveModels(patched);
    open({ accountId: DEFAULT_ACCOUNT.id, task: { modelSetting: { kind: 'top_of_tier' } } });
    const d = await openTab('Edit');
    const field = within(d).getByRole<HTMLInputElement>('combobox', { name: 'Model' });
    expect(field.value).toBe('Top of tier');
    fireEvent.click(field);
    fireEvent.click(await screen.findByRole('option', { name: 'No override', hidden: true }));
    fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]).toMatchObject({ modelSetting: null });
  });
});

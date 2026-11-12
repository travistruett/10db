import type { AreaDef, PassViewDto, TaskId } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { findPagesInput, pickOption, pillsOf } from '../../test/combobox';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  PASS_NOW,
  pagesByStatus,
  passHandlers,
  passNotice,
  passStartDto,
  passViewDto,
} from '../../test/pass-fixtures';
import type { PassWorkspaceProps } from './pass-workspace-props';
import { WorkbenchScreen, type WorkbenchScreenProps } from './workbench-view';

const pageAreas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
];
const withPages = projectViewDto({ name: 'ampsio', areas: pageAreas });

/** Stands in for the pass's workspace: says what it was handed and selects the first page. */
function Workspace({ view, selected, onSelect }: PassWorkspaceProps) {
  const first = view.pages[0];
  return (
    <div data-testid="workspace">
      <span>{`${String(view.pages.length)} pages, selected ${selected ?? 'none'}`}</span>
      {first ? (
        <button
          type="button"
          onClick={() => {
            onSelect(first.taskId);
          }}
        >
          Select first
        </button>
      ) : null}
    </div>
  );
}

/** The screen's props, with a spy for each daemon call and for the selection. */
function screenProps(overrides: Partial<WorkbenchScreenProps> = {}) {
  const onSelect = vi.fn<(taskId: TaskId) => void>();
  const props: WorkbenchScreenProps = {
    project: withPages,
    live: null,
    start: passStartDto({
      pages: [
        { area: 'settings', route: '/settings', lastChangedAt: null, uncommitted: 0, heldBy: null },
      ],
    }),
    tasks: [],
    inbox: [],
    search: {},
    goalPages: [],
    setupCount: 0,
    now: Date.parse(PASS_NOW),
    onSelect,
    renderWorkspace: (workspace) => <Workspace {...workspace} />,
    actions: {
      start: vi.fn(() => Promise.resolve()),
      addPages: vi.fn(() => Promise.resolve()),
      rename: vi.fn(() => Promise.resolve()),
      abandon: vi.fn(() => Promise.resolve()),
    },
    ...overrides,
  };
  return { onSelect, props };
}

async function draw(overrides: Partial<WorkbenchScreenProps> = {}) {
  server.use(...baseHandlers());
  const drawn = screenProps(overrides);
  await renderWithDaemonAndRouter(<WorkbenchScreen {...drawn.props} />);
  return drawn;
}

describe('WorkbenchScreen', () => {
  it('is the setup when the project has no page area', async () => {
    server.use(...passHandlers());
    await draw({
      project: projectViewDto({ name: 'ampsio', areas: [{ name: 'src', globs: ['src/**'] }] }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Set up ampsio for the UI Workbench' }),
    ).toBeTruthy();
    expect(await screen.findByRole('checkbox', { name: /settings/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Start Pass/ })).toBeNull();
  });

  it('offers Set Up above the picker while suggestions are left, and Back to Pages returns', async () => {
    server.use(...passHandlers());
    await draw({ setupCount: 2 });
    fireEvent.click(await screen.findByRole('button', { name: /^Set Up/ }));
    expect(
      await screen.findByRole('heading', { name: 'Set up ampsio for the UI Workbench' }),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Pages' }));
    expect(await screen.findByText('Work through pages with the agents, live.')).toBeTruthy();
  });

  it('offers no Set Up when nothing is left to suggest', async () => {
    await draw();
    expect(await screen.findByText('Work through pages with the agents, live.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Set Up/ })).toBeNull();
  });

  it('is the picker while no pass is open', async () => {
    await draw();
    expect(await screen.findByText('Work through pages with the agents, live.')).toBeTruthy();
    expect(await findPagesInput()).toBeTruthy();
  });

  it('with a closed pass waiting to settle, says so in one line above the picker', async () => {
    const notice = passNotice();
    await draw({ live: passViewDto({ pass: { state: 'CLOSED' }, rest: { notices: [notice] } }) });
    expect(await screen.findByText('Settings pass closed with no pull request.')).toBeTruthy();
    expect(await findPagesInput()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More pass actions' })).toBeNull();
    // Its notices stay in sight, and it holds no page to send one to.
    expect(screen.getByText(notice.text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send to Agent' })).toBeNull();
  });

  it('waits for the picker until what Start Pass says has loaded', async () => {
    await draw({ start: undefined });
    expect(await screen.findByRole('status', { name: 'Loading the pages' })).toBeTruthy();
  });

  it('sends Start Pass and says its refusal beside the button', async () => {
    const start = vi.fn(() => Promise.reject(new Error('A lane is running in the folder')));
    await draw({
      actions: {
        start,
        addPages: () => Promise.resolve(),
        rename: () => Promise.resolve(),
        abandon: () => Promise.resolve(),
      },
    });
    await pickOption(await findPagesInput(), /^settings/);
    fireEvent.click(screen.getByRole('button', { name: 'Start Pass' }));
    expect(await screen.findByText('A lane is running in the folder')).toBeTruthy();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ pages: ['settings'] }));
  });

  it("ticks the Board's tasks and the goal's pages a link names", async () => {
    await draw({ goalPages: ['settings'] });
    expect(within(pillsOf(await findPagesInput())).getByText('settings')).toBeTruthy();
  });

  it('with a pass open, draws its header over its workspace, handing it the selection', async () => {
    const { ready, working } = pagesByStatus();
    const live: PassViewDto = passViewDto({ pages: [ready, working] });
    const { onSelect } = await draw({ live, search: { task: working.taskId } });
    expect(await screen.findByText('ampsio · Settings pass · 1 ready · 1 working')).toBeTruthy();
    expect(screen.getByText(`2 pages, selected ${working.taskId}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select first' }));
    expect(onSelect).toHaveBeenCalledWith(ready.taskId);
    expect(screen.queryByText('Work through pages with the agents, live.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Page' }));
    expect(await screen.findByRole('dialog', { name: 'Add Page' })).toBeTruthy();
  });

  it.each([
    { item: 'Rename', dialog: 'Rename Pass' },
    { item: 'Abandon Pass', dialog: 'Abandon Pass' },
  ])('opens $dialog from the pass menu', async ({ item, dialog }) => {
    await draw({ live: passViewDto({ pages: [pagesByStatus().ready] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'More pass actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: item, hidden: true }));
    expect(await screen.findByRole('dialog', { name: dialog })).toBeTruthy();
  });

  it.each<{ name: string; before: 'CLOSING' | 'ABANDONING' | 'OPEN'; said: boolean }>([
    { name: 'a close that finished says so above the picker', before: 'CLOSING', said: true },
    { name: 'an Abandon that finished says nothing of a close', before: 'ABANDONING', said: false },
    { name: 'a pass gone while open says nothing of a close', before: 'OPEN', said: false },
  ])('$name', async ({ before, said }) => {
    const view = passViewDto({
      pass: { state: before, name: 'Settings pass', returnBranch: 'main' },
    });
    server.use(...baseHandlers());
    function Settling(props: WorkbenchScreenProps) {
      const [live, setLive] = useState<PassViewDto | null>(view);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setLive(null);
            }}
          >
            Settle
          </button>
          <WorkbenchScreen {...props} live={live} />
        </>
      );
    }
    await renderWithDaemonAndRouter(<Settling {...screenProps().props} />);
    await screen.findByRole('button', { name: 'More pass actions' });
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));
    expect(await screen.findByRole('button', { name: /^Start Pass/ })).toBeTruthy();
    expect(screen.queryByText('Settings pass closed; its work is on main.') !== null).toBe(said);
  });
});

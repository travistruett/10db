import type { AreaDef, PassViewDto, TaskId } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  PASS_NOW,
  pagesByStatus,
  pagesProposalDto,
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

async function draw(overrides: Partial<WorkbenchScreenProps> = {}) {
  server.use(...baseHandlers());
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
    now: Date.parse(PASS_NOW),
    onSelect,
    renderWorkspace: (workspace) => <Workspace {...workspace} />,
    actions: {
      start: vi.fn(() => Promise.resolve()),
      propose: vi.fn(() => Promise.resolve(pagesProposalDto())),
      addPages: vi.fn(() => Promise.resolve()),
      rename: vi.fn(() => Promise.resolve()),
      abandon: vi.fn(() => Promise.resolve()),
    },
    ...overrides,
  };
  await renderWithDaemonAndRouter(<WorkbenchScreen {...props} />);
  return { onSelect, props };
}

describe('WorkbenchScreen', () => {
  it('shows why a pass needs a page area when the project has none', async () => {
    await draw({ project: projectViewDto({ areas: [{ name: 'src', globs: ['src/**'] }] }) });
    expect(await screen.findByRole('heading', { name: 'Workbench' })).toBeTruthy();
    expect(screen.getByText(/this project has no page area yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Start Pass/ })).toBeNull();
  });

  it('is the picker while no pass is open', async () => {
    await draw();
    expect(await screen.findByText('Work through pages with the agents, live.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /^settings/ })).toBeTruthy();
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
        propose: () => Promise.resolve(pagesProposalDto()),
        addPages: () => Promise.resolve(),
        rename: () => Promise.resolve(),
        abandon: () => Promise.resolve(),
      },
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: /^settings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Pass (1)' }));
    expect(await screen.findByText('A lane is running in the folder')).toBeTruthy();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ pages: ['settings'] }));
  });

  it("ticks the Board's tasks and the goal's pages a link names", async () => {
    await draw({ goalPages: ['settings'] });
    expect(await screen.findByRole('checkbox', { name: /^settings/ })).toHaveProperty(
      'checked',
      true,
    );
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
    { item: 'Abandon Pass…', dialog: 'Abandon Pass' },
  ])('opens $dialog from the pass menu', async ({ item, dialog }) => {
    await draw({ live: passViewDto({ pages: [pagesByStatus().ready] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'More pass actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: item, hidden: true }));
    expect(await screen.findByRole('dialog', { name: dialog })).toBeTruthy();
  });
});

import {
  mintId,
  PassOpenRequest,
  type AreaDef,
  type PassStartDto,
  type ProjectViewDto,
} from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { openOptions, optionIn, pickOption, pillsOf } from '../../test/combobox';
import { minutesBeforeNow, PASS_NOW, passStartDto } from '../../test/pass-fixtures';
import { projectViewDto, taskDto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/theme';
import { StartPass, type StartPassProps } from './start-pass';

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'billing', globs: ['src/billing/**'], role: 'page' },
  { name: 'forms', globs: ['src/**/form.tsx'], role: 'page', route: '/forms' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];
const project: ProjectViewDto = projectViewDto({ name: 'ampsio', areas });
const start: PassStartDto = passStartDto({
  pages: [
    {
      area: 'settings',
      route: '/settings',
      lastChangedAt: minutesBeforeNow(60 * 24),
      uncommitted: 3,
      heldBy: null,
    },
    {
      area: 'people',
      route: '/people',
      lastChangedAt: minutesBeforeNow(60),
      uncommitted: 0,
      heldBy: null,
    },
    { area: 'billing', route: null, lastChangedAt: null, uncommitted: 0, heldBy: null },
    { area: 'forms', route: '/forms', lastChangedAt: null, uncommitted: 0, heldBy: null },
  ],
});
const peopleTask = taskDto({
  projectId: project.id,
  title: 'feat: people list',
  headline: 'The people list breathes',
  areas: ['people'],
});

async function draw(overrides: Partial<StartPassProps> = {}) {
  const onStart = vi.fn<(request: PassOpenRequest) => void>();
  await renderWithRouter(
    <StartPass
      project={project}
      start={start}
      tasks={[peopleTask]}
      initial={{ pages: [], taskIds: [] }}
      goalId={null}
      now={Date.parse(PASS_NOW)}
      onStart={onStart}
      starting={false}
      error={null}
      {...overrides}
    />,
  );
  return { onStart };
}

const pagesInput = () => screen.getByLabelText('Pages', { selector: 'input' });
const pick = (name: RegExp) => pickOption(pagesInput(), name);
/** Types into the Pages search as the builder would: focused first, as Mantine reads typing. */
function search(text: string) {
  pagesInput().focus();
  fireEvent.change(pagesInput(), { target: { value: text } });
}
const startButton = () => screen.getByRole('button', { name: /^Start Pass/ });
const picked = () => pillsOf(pagesInput());

describe('StartPass', () => {
  it('offers every page with its route and last change, then the open UI tasks, in one search', async () => {
    await draw();
    expect(screen.getByText('Work through pages with the agents, live.')).toBeTruthy();
    const list = await openOptions(pagesInput());
    expect(optionIn(list, /^settings/).textContent).toContain('/settings');
    expect(optionIn(list, /^settings/).textContent).toContain('changed 1d ago');
    expect(optionIn(list, /^billing/).textContent).toContain('No route');
    expect(optionIn(list, /^billing/).textContent).toContain('no changes yet');
    expect(within(list).getByText('Open UI tasks')).toBeTruthy();
    expect(optionIn(list, /^The people list breathes/).textContent).toContain('people');
    expect(startButton()).toHaveProperty('disabled', true);
  });

  it('starts the picked page and task with the message, with no count on the button', async () => {
    const { onStart } = await draw();
    await pick(/^settings/);
    await pick(/^The people list breathes/);
    expect(within(picked()).getByText('settings')).toBeTruthy();
    expect(within(picked()).getByText('/settings')).toBeTruthy();
    expect(within(picked()).getByText('The people list breathes')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What's bothering you?"), {
      target: { value: 'these feel cramped' },
    });
    expect(startButton().textContent).toBe('Start Pass');
    fireEvent.click(startButton());
    expect(onStart).toHaveBeenCalledTimes(1);
    const sent = PassOpenRequest.parse(onStart.mock.calls[0]?.[0]);
    expect(sent).toEqual({
      name: 'settings and people pass',
      pages: ['settings'],
      taskIds: [peopleTask.id],
      pageCap: 4,
      firstMessage: 'these feel cramped',
    });
  });

  it('disables a page another picked row holds or can share a file with, saying why', async () => {
    await draw();
    await pick(/^settings/);
    let list = await openOptions(pagesInput());
    const forms = optionIn(list, /^forms/);
    expect(forms.hasAttribute('data-combobox-disabled')).toBe(true);
    expect(forms.textContent).toContain(
      'settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
    );
    fireEvent.click(optionIn(list, /^The people list breathes/));
    list = await openOptions(pagesInput());
    const people = optionIn(list, /^people/);
    expect(people.hasAttribute('data-combobox-disabled')).toBe(true);
    expect(people.textContent).toContain('The people list breathes works on people');
  });

  it('finds a page by its route and a task by the pages it works on', async () => {
    await draw();
    search('peo');
    let list = await openOptions(pagesInput());
    expect(within(list).queryByRole('option', { name: /^settings/, hidden: true })).toBeNull();
    expect(optionIn(list, /^people/)).toBeTruthy();
    expect(optionIn(list, /^The people list breathes/)).toBeTruthy();
    search('/sett');
    list = await openOptions(pagesInput());
    expect(optionIn(list, /^settings/)).toBeTruthy();
    expect(within(list).queryByRole('option', { name: /^people/, hidden: true })).toBeNull();
  });

  it('starts with the pages and tasks a link names picked, and the goal it came from', async () => {
    const goalId = mintId('Goal');
    const { onStart } = await draw({
      initial: { pages: ['billing'], taskIds: [peopleTask.id] },
      goalId,
    });
    expect(within(picked()).getByText('billing')).toBeTruthy();
    expect(within(picked()).getByText('The people list breathes')).toBeTruthy();
    fireEvent.click(startButton());
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({
      pages: ['billing'],
      taskIds: [peopleTask.id],
      goalId,
    });
  });

  it('takes a page back out from its pill', async () => {
    await draw({ initial: { pages: ['billing', 'people'], taskIds: [] } });
    fireEvent.click(within(picked()).getByLabelText('Remove billing'));
    expect(within(picked()).queryByText('billing')).toBeNull();
    expect(within(picked()).getByText('people')).toBeTruthy();
  });

  it("says the daemon's refusal beside Start Pass", async () => {
    await draw({ error: 'A lane is running in the folder: Fix login' });
    const refusal = screen.getByText('A lane is running in the folder: Fix login');
    expect(refusal.closest('[data-start-bar]')?.contains(startButton())).toBe(true);
  });

  it('says why a pass cannot open now and keeps Start Pass disabled', async () => {
    await draw({
      start: {
        ...start,
        refusal: {
          code: 'detached_head',
          message: 'The folder is on no branch: check one out first.',
        },
      },
    });
    await pick(/^settings/);
    expect(screen.getByText('The folder is on no branch: check one out first.')).toBeTruthy();
    expect(startButton()).toHaveProperty('disabled', true);
  });

  it('says what the picked pages take in beside the button, and nothing about shared areas', async () => {
    await draw();
    expect(screen.queryByText(/settings: 3 files already changed/)).toBeNull();
    await pick(/^settings/);
    const line = screen.getByText(/settings: 3 files already changed/);
    expect(line.closest('[data-start-bar]')?.contains(startButton())).toBe(true);
    expect(screen.queryByText(/count as/)).toBeNull();
  });

  it("shows Set Up's count as a badge, not in the label", async () => {
    const onOpen = vi.fn();
    await draw({ setUp: { count: 2, onOpen } });
    const setUp = screen.getByRole('button', { name: /^Set Up/ });
    expect(setUp.textContent).not.toContain('(');
    expect(within(setUp).getByText('2')).toBeTruthy();
    fireEvent.click(setUp);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

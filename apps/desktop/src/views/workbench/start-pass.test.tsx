import {
  mintId,
  PassOpenRequest,
  type AreaDef,
  type PassStartDto,
  type ProjectViewDto,
} from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
      label: 'Settings',
      route: '/settings',
      lastChangedAt: minutesBeforeNow(60 * 24),
      uncommitted: 3,
      heldBy: null,
    },
    {
      area: 'people',
      label: 'People',
      route: '/people',
      lastChangedAt: minutesBeforeNow(60),
      uncommitted: 0,
      heldBy: null,
    },
    {
      area: 'billing',
      label: 'Billing',
      route: null,
      lastChangedAt: null,
      uncommitted: 0,
      heldBy: null,
    },
    {
      area: 'forms',
      label: 'Forms',
      route: '/forms',
      lastChangedAt: null,
      uncommitted: 0,
      heldBy: null,
    },
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

const startButton = () => screen.getByRole('button', { name: 'Start Pass' });
const box = (name: RegExp | string) => screen.getByRole('checkbox', { name });
const ticked = (name: RegExp | string) => (box(name) as HTMLInputElement).checked;
const disabled = (name: RegExp | string) => (box(name) as HTMLInputElement).disabled;

describe('StartPass', () => {
  it('lists every page with its route and last change, then the open UI tasks', async () => {
    await draw();
    const pages = screen.getByRole('group', { name: 'Pages' });
    expect(within(pages).getAllByRole('checkbox')).toHaveLength(4);
    expect(pages.textContent).toContain('/settings');
    expect(pages.textContent).toContain('changed 1d ago');
    expect(pages.textContent).toContain('No route');
    expect(pages.textContent).toContain('no changes yet');
    const tasks = screen.getByRole('group', { name: 'Open UI tasks' });
    expect(within(tasks).getByRole('checkbox', { name: 'The people list breathes' })).toBeTruthy();
    expect(tasks.textContent).toContain('People');
    expect(screen.queryByLabelText("What's bothering you?")).toBeNull();
    expect(startButton()).toHaveProperty('disabled', true);
  });

  it('starts the ticked page and task, says them in words beside the button, and sends no message', async () => {
    const { onStart } = await draw();
    fireEvent.click(box('Settings'));
    expect(screen.getByText('1 page')).toBeTruthy();
    fireEvent.click(box('The people list breathes'));
    expect(screen.getByText('1 page \u00b7 1 task')).toBeTruthy();
    expect(startButton().textContent).toBe('Start Pass');
    fireEvent.click(startButton());
    expect(onStart).toHaveBeenCalledTimes(1);
    const sent = PassOpenRequest.parse(onStart.mock.calls[0]?.[0]);
    expect(sent).toEqual({
      name: 'Settings and People',
      pages: ['settings'],
      taskIds: [peopleTask.id],
      pageCap: 4,
    });
  });

  it('disables a row another ticked row holds or can share a file with, saying why', async () => {
    await draw();
    fireEvent.click(box('Settings'));
    expect(disabled('Forms')).toBe(true);
    expect(
      screen.getByText(
        'Settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
      ),
    ).toBeTruthy();
    expect(disabled('Settings')).toBe(false);
    fireEvent.click(box('The people list breathes'));
    expect(disabled('People')).toBe(true);
    expect(screen.getByText('The people list breathes works on People')).toBeTruthy();
    fireEvent.click(box('The people list breathes'));
    expect(disabled('People')).toBe(false);
  });

  it('shows a page by its label', async () => {
    const labelled = passStartDto({
      pages: start.pages.map((page) =>
        page.area === 'forms' ? { ...page, label: 'Sign-up form' } : page,
      ),
    });
    const { onStart } = await draw({
      start: labelled,
      project: {
        ...project,
        areas: areas.map((a) => (a.name === 'forms' ? { ...a, label: 'Sign-up form' } : a)),
      },
    });
    fireEvent.click(box('Sign-up form'));
    fireEvent.click(startButton());
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({ name: 'Sign-up form', pages: ['forms'] });
  });

  it('starts with the pages and tasks a link names ticked, and the goal it came from', async () => {
    const goalId = mintId('Goal');
    const { onStart } = await draw({
      initial: { pages: ['billing'], taskIds: [peopleTask.id] },
      goalId,
    });
    expect(ticked('Billing')).toBe(true);
    expect(ticked('The people list breathes')).toBe(true);
    fireEvent.click(startButton());
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({
      pages: ['billing'],
      taskIds: [peopleTask.id],
      goalId,
    });
  });

  it('takes a page back out when unticked', async () => {
    await draw({ initial: { pages: ['billing', 'people'], taskIds: [] } });
    fireEvent.click(box('Billing'));
    expect(ticked('Billing')).toBe(false);
    expect(ticked('People')).toBe(true);
    expect(screen.getByText('1 page')).toBeTruthy();
  });

  it('says which task holds a page that is held', async () => {
    await draw({
      start: passStartDto({
        pages: start.pages.map((page) =>
          page.area === 'people'
            ? { ...page, heldBy: { taskId: mintId('Task'), title: 'Fix the roster' } }
            : page,
        ),
      }),
    });
    expect(screen.getByText('Waits for Fix the roster')).toBeTruthy();
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
    fireEvent.click(box('Settings'));
    expect(screen.getByText('The folder is on no branch: check one out first.')).toBeTruthy();
    expect(startButton()).toHaveProperty('disabled', true);
  });

  it('says what the ticked pages take in beside the button, and nothing about shared areas', async () => {
    await draw();
    expect(screen.queryByText(/Settings: 3 files already changed/)).toBeNull();
    fireEvent.click(box('Settings'));
    const line = screen.getByText(/Settings: 3 files already changed/);
    expect(line.closest('[data-start-bar]')?.contains(startButton())).toBe(true);
    expect(screen.queryByText(/count as/)).toBeNull();
  });

  it('says no found page when none was found', async () => {
    await draw({ setUp: { newPages: [], onOpen: vi.fn() } });
    expect(screen.queryByText(/found in code/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it.each([
    {
      name: 'one page, by its label and route',
      pages: [{ name: 'sessions', label: 'Chats', route: '/sessions', folders: ['src/sessions/'] }],
      says: 'Chats /sessions found in code',
    },
    {
      name: 'a page with no label, by its capitalised name, and none with no route',
      pages: [{ name: 'billing', folders: ['src/billing/'] }],
      says: 'Billing found in code',
    },
    {
      name: 'several, the first few named and the rest counted',
      pages: ['a', 'b', 'c', 'd'].map((name) => ({
        name,
        route: `/${name}`,
        folders: [`${name}/`],
      })),
      says: 'A /a, B /b, C /c and 1 more found in code',
    },
  ])(
    'says the found pages as one quiet line: $name, with Review opening the setup',
    async ({ pages, says }) => {
      const onOpen = vi.fn();
      await draw({ setUp: { newPages: pages, onOpen } });
      const line = screen.getByRole('status');
      expect(line.textContent).toContain(says);
      fireEvent.click(within(line).getByRole('button', { name: 'Review' }));
      expect(onOpen).toHaveBeenCalledTimes(1);
    },
  );
});

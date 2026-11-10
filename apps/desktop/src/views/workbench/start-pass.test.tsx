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
import { renderWithTheme } from '../../test/theme';
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

function draw(overrides: Partial<StartPassProps> = {}) {
  const onStart = vi.fn<(request: PassOpenRequest) => void>();
  renderWithTheme(
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

const row = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });
const startButton = () => screen.getByRole('button', { name: /^Start Pass/ });

describe('StartPass', () => {
  it('lists the pages with route and last change, then the open UI tasks, under its purpose', () => {
    draw();
    expect(screen.getByText('Work through pages with the agents, live.')).toBeTruthy();
    const pages = screen.getByRole('group', { name: 'Pages' });
    expect(within(pages).getByText('/settings · changed 1d ago')).toBeTruthy();
    expect(within(pages).getByText('No route · no changes yet')).toBeTruthy();
    const tasks = screen.getByRole('group', { name: 'Open UI tasks' });
    expect(within(tasks).getByRole('checkbox', { name: /The people list breathes/ })).toBeTruthy();
    expect(within(tasks).getByText('people')).toBeTruthy();
    expect(startButton()).toHaveProperty('disabled', true);
  });

  it('starts the ticked page and task with the message, counting them on the button', () => {
    const { onStart } = draw();
    fireEvent.click(row('settings'));
    fireEvent.click(row('The people list breathes'));
    fireEvent.change(screen.getByLabelText("What's bothering you?"), {
      target: { value: 'these feel cramped' },
    });
    expect(startButton().textContent).toBe('Start Pass (2)');
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

  it('disables a page another ticked row holds or can share a file with, saying why', () => {
    draw();
    fireEvent.click(row('settings'));
    expect(row('forms')).toHaveProperty('disabled', true);
    expect(
      screen.getByText(
        'settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
      ),
    ).toBeTruthy();
    fireEvent.click(row('The people list breathes'));
    expect(row('people')).toHaveProperty('disabled', true);
    expect(screen.getByText('The people list breathes works on people')).toBeTruthy();
  });

  it('narrows both lists by the filter', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Filter pages and tasks'), {
      target: { value: 'peo' },
    });
    expect(screen.queryByRole('checkbox', { name: /^settings/ })).toBeNull();
    expect(row('people')).toBeTruthy();
    expect(row('The people list breathes')).toBeTruthy();
  });

  it('starts ticked with the tasks a link names, and the goal it came from', () => {
    const goalId = mintId('Goal');
    const { onStart } = draw({ initial: { pages: ['billing'], taskIds: [peopleTask.id] }, goalId });
    expect(row('billing')).toHaveProperty('checked', true);
    expect(row('The people list breathes')).toHaveProperty('checked', true);
    fireEvent.click(startButton());
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({
      pages: ['billing'],
      taskIds: [peopleTask.id],
      goalId,
    });
  });

  it("says the daemon's refusal beside Start Pass", () => {
    draw({ error: 'A lane is running in the folder: Fix login' });
    const refusal = screen.getByText('A lane is running in the folder: Fix login');
    expect(refusal.closest('[data-start-bar]')?.contains(startButton())).toBe(true);
  });
});

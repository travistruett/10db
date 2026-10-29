import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../test/daemon';
import { projectDto } from '../test/fixtures';

const alpha = projectDto({ name: 'alpha', repoPath: '/Users/x/a' });
const beta = projectDto({ name: 'beta', repoPath: '/Users/x/b' });

/** The requests for each project's tasks, by project id. */
function serveTwoProjects(): string[] {
  const taskRequests: string[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])),
    http.get(daemonUrl('/projects/:projectId/tasks'), ({ params }) => {
      taskRequests.push(String(params['projectId']));
      return HttpResponse.json([]);
    }),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return taskRequests;
}

/** jsdom never finishes the dropdown's transition, so its content stays `display: none` once open. */
const HIDDEN = { hidden: true } as const;

async function openSwitcher(): Promise<void> {
  const trigger = await screen.findByRole('button', { name: 'Project: alpha. Switch project' });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(
      screen.getByRole('textbox', { name: 'Find a project', ...HIDDEN }).dataset['expanded'],
    ).toBe('true');
  });
}

describe('ProjectSwitcher', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('names the current project', async () => {
    serveTwoProjects();
    renderApp('/board');
    expect(
      await screen.findByRole('button', { name: 'Project: alpha. Switch project' }),
    ).toBeTruthy();
  });

  it('lists projects with home-relative paths and a check on the current one', async () => {
    serveTwoProjects();
    renderApp('/board');
    await openSwitcher();

    const options = await screen.findAllByRole('option', HIDDEN);
    expect(options).toHaveLength(2);
    const [first, second] = options;
    if (!first || !second) throw new Error('expected two options');
    expect(within(first).getByText('alpha')).toBeTruthy();
    expect(within(first).getByText('~/a')).toBeTruthy();
    expect(within(second).getByText('beta')).toBeTruthy();
    expect(within(second).getByText('~/b')).toBeTruthy();
    expect(first.querySelector('.tabler-icon-check')).not.toBeNull();
    expect(second.querySelector('.tabler-icon-check')).toBeNull();
  });

  it('filters by name or path', async () => {
    serveTwoProjects();
    renderApp('/board');
    await openSwitcher();

    const search = screen.getByRole('textbox', { name: 'Find a project', ...HIDDEN });
    fireEvent.change(search, { target: { value: 'b' } });
    const options = screen.getAllByRole('option', HIDDEN);
    expect(options).toHaveLength(1);
    expect(within(options[0] ?? document.body).getByText('beta')).toBeTruthy();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option', HIDDEN)).toHaveLength(0);
    expect(screen.getByText('No project matches')).toBeTruthy();
  });

  it('switches the project', async () => {
    const taskRequests = serveTwoProjects();
    renderApp('/board');
    await openSwitcher();

    fireEvent.click(await screen.findByRole('option', { name: /beta/, ...HIDDEN }));
    expect(
      await screen.findByRole('button', { name: 'Project: beta. Switch project' }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(taskRequests).toContain(beta.id);
    });
  });

  it('opens New Project from the footer', async () => {
    serveTwoProjects();
    renderApp('/board');
    await openSwitcher();

    fireEvent.click(screen.getByRole('button', { name: 'New Project', ...HIDDEN }));
    expect(await screen.findByRole('dialog', { name: 'New Project' })).toBeTruthy();
  });
});

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

    // A fragment found only in a path selects that project; the home folder is not part of the shown path.
    fireEvent.change(search, { target: { value: '~/a' } });
    expect(screen.getAllByRole('option', HIDDEN)).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'x' } });
    expect(screen.queryAllByRole('option', HIDDEN)).toHaveLength(0);

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

  it('creates a project from the modal and switches to it', async () => {
    const gamma = projectDto({ name: 'gamma', repoPath: '/Users/x/gamma' });
    let projects = [alpha, beta];
    serveTwoProjects();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json(projects)),
      http.post(daemonUrl('/folders/inspect'), () =>
        HttpResponse.json({
          ok: true,
          inspection: {
            root: '/Users/x/gamma',
            suggestedName: 'gamma',
            branches: [],
            defaultBranch: null,
            github: null,
            gateCandidates: [{ command: 'make gate', source: 'makefile' }],
            registryHosts: [],
          },
        }),
      ),
      http.post(daemonUrl('/folders/propose-areas'), () =>
        HttpResponse.json({
          ok: true,
          proposal: {
            namedBy: 'structure',
            areas: [{ name: 'root', globs: ['*', '.*'], reason: 'The top of the repository.' }],
          },
        }),
      ),
      http.post(daemonUrl('/projects'), () => {
        projects = [alpha, beta, gamma];
        return HttpResponse.json(gamma, { status: 201 });
      }),
    );
    renderApp('/board');
    await openSwitcher();

    fireEvent.click(screen.getByRole('button', { name: 'New Project', ...HIDDEN }));
    const dialog = await screen.findByRole('dialog', { name: 'New Project' });
    const path = within(dialog).getByRole('textbox', { name: 'Folder path' });
    fireEvent.change(path, { target: { value: '/Users/x/gamma' } });
    fireEvent.blur(path);
    await within(dialog).findByRole('textbox', { name: 'Name' });
    await within(dialog).findByRole('group', { name: 'Area 1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Project' }));

    expect(
      await screen.findByRole('button', { name: 'Project: gamma. Switch project' }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New Project' })).toBeNull();
    });
  });
});

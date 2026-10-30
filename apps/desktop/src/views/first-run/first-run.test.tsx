import { SystemCheckDto, type AccountIdentityDto, type ToolCheck } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountIdentityDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

type Tool = Pick<ToolCheck, 'name' | 'path' | 'version'> & {
  readonly signedIn?: string | undefined;
};

const CLAUDE: Tool = { name: 'claude', path: '/usr/local/bin/claude', version: '2.1.299' };
const GIT: Tool = { name: 'git', path: '/usr/bin/git', version: 'git version 2.50.0' };
const GH: Tool = {
  name: 'gh',
  path: '/usr/bin/gh',
  version: 'gh 2.0.0',
  signedIn: 'octocat',
};

function system(tools: Tool[]) {
  return SystemCheckDto.parse({
    loginEnv: { source: 'login_shell', warning: null },
    claudeCode: { verifiedOn: '2.1.302', warning: null },
    tools: tools.map((t) => ({ ...t, required: t.name !== 'gh' })),
  });
}

interface Served {
  readonly identityRequests: string[];
  readonly systemRequests: (string | null)[];
  readonly patches: string[];
  readonly posted: unknown[];
}

function serve(
  opts: {
    readonly tools?: Tool[];
    readonly identity?: AccountIdentityDto;
    readonly projects?: () => unknown[];
  } = {},
  ...more: RequestHandler[]
): Served {
  const served: Served = { identityRequests: [], systemRequests: [], patches: [], posted: [] };
  let created = false;
  server.use(
    ...more,
    http.get(daemonUrl('/accounts/:accountId/identity'), ({ params }) => {
      served.identityRequests.push(String(params['accountId']));
      return HttpResponse.json(opts.identity ?? accountIdentityDto());
    }),
    http.patch(daemonUrl('/accounts/:accountId'), ({ params }) => {
      served.patches.push(String(params['accountId']));
      return HttpResponse.json(DEFAULT_ACCOUNT);
    }),
    http.get(daemonUrl('/system'), ({ request }) => {
      served.systemRequests.push(new URL(request.url).searchParams.get('recheck'));
      return HttpResponse.json(system(opts.tools ?? [CLAUDE, GIT, GH]));
    }),
    http.post(daemonUrl('/folders/inspect'), () =>
      HttpResponse.json({
        ok: true,
        inspection: {
          root: '/Users/me/widgets',
          suggestedName: 'widgets',
          branches: [{ name: 'main', remote: true }],
          defaultBranch: 'main',
          github: 'me/widgets',
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
    http.get(daemonUrl('/projects'), () =>
      HttpResponse.json(created ? [projectDto({ name: 'widgets' })] : []),
    ),
    http.post(daemonUrl('/projects'), async ({ request }) => {
      served.posted.push(await request.json());
      created = true;
      return HttpResponse.json(projectDto({ name: 'widgets' }), { status: 201 });
    }),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return served;
}

const next = (name: string) => screen.getByRole('button', { name });

async function toSetup(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Get Started' }));
  await screen.findByRole('heading', { name: 'Check your setup' });
}

function card(name: 'Agents' | 'Tools'): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('FirstRun', () => {
  it('shows the shell while projects load', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve(
      {},
      http.get(daemonUrl('/projects'), async () => {
        await gate;
        return HttpResponse.json([]);
      }),
    );
    renderApp('/board');
    expect(await screen.findByRole('link', { name: 'Board' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Welcome to 10db' })).toBeNull();
    release();
    expect(await screen.findByRole('heading', { name: 'Welcome to 10db' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
  });

  it('shows the first run only once the list loads empty', async () => {
    serve(
      {},
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
    );
    renderApp('/board');
    expect(await screen.findByRole('link', { name: 'Board' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Welcome to 10db' })).toBeNull();
  });

  it('does not probe the login before the check step', async () => {
    const served = serve();
    renderApp('/');
    await screen.findByRole('button', { name: 'Get Started' });
    await waitFor(() => {
      expect(served.systemRequests.length).toBeGreaterThan(0);
    });
    expect(served.identityRequests).toEqual([]);
  });

  it('shows a failed system check instead of waiting forever', async () => {
    serve(
      {},
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json({ error: 'internal', message: 'The check failed.' }, { status: 500 }),
      ),
    );
    renderApp('/');
    await toSetup();
    expect((await screen.findAllByText('The check failed.')).length).toBeGreaterThan(0);
  });

  it('goes from Welcome to Check your setup with Get Started', async () => {
    serve();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Welcome to 10db' })).toBeTruthy();
    expect(
      screen.getByText(
        'Run Claude Code on your repositories, from task to pull request. Setup takes about a minute.',
      ),
    ).toBeTruthy();
    await toSetup();
  });

  it('probes the identity once on entering the step and again on Recheck', async () => {
    const served = serve();
    renderApp('/');
    await toSetup();
    await within(card('Agents')).findByText(/Signed in as builder@example.com/);
    expect(served.identityRequests).toEqual([DEFAULT_ACCOUNT.id]);

    fireEvent.click(within(card('Agents')).getByRole('button', { name: 'Recheck' }));
    await waitFor(() => {
      expect(served.identityRequests).toHaveLength(2);
    });
  });

  it('does not patch the account', async () => {
    const served = serve();
    renderApp('/');
    await toSetup();
    await within(card('Agents')).findByText(/Signed in as builder@example.com/);
    expect(served.patches).toEqual([]);
  });

  it('says which login tasks will run as in the footer, with no Use button', async () => {
    serve();
    renderApp('/');
    await toSetup();
    expect(await screen.findByText('Tasks will run as builder@example.com.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('offers Add Another Login, which opens the Add Account modal, and no Switch Login', async () => {
    serve();
    renderApp('/');
    await toSetup();
    fireEvent.click(
      await within(card('Agents')).findByRole('button', { name: 'Add Another Login' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Add Account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch Login' })).toBeNull();
  });

  it('shows the refusal when Claude Code is signed out, still with Add Another Login', async () => {
    serve({
      identity: accountIdentityDto({
        email: null,
        refusal: {
          problem: 'signed_out',
          message: 'Claude Code is signed out.',
          seenIdentity: null,
        },
      }),
    });
    renderApp('/');
    await toSetup();
    expect(await within(card('Agents')).findByText('Claude Code is signed out.')).toBeTruthy();
    expect(within(card('Agents')).getByRole('button', { name: 'Add Another Login' })).toBeTruthy();
    expect(screen.queryByText(/Tasks will run as/)).toBeNull();
  });

  describe('Continue', () => {
    it('is enabled once Claude Code and git are found', async () => {
      serve();
      renderApp('/');
      await toSetup();
      await within(card('Tools')).findByText('git version 2.50.0');
      await waitFor(() => {
        expect(next('Continue').hasAttribute('disabled')).toBe(false);
      });
    });

    it.each([
      { name: 'without git', tools: [CLAUDE, { ...GIT, path: null, version: null }, GH] },
      { name: 'without Claude Code', tools: [{ ...CLAUDE, path: null, version: null }, GIT, GH] },
    ])('is disabled $name', async ({ name, tools }) => {
      const served = serve({ tools });
      renderApp('/');
      await toSetup();
      await waitFor(() => {
        expect(screen.queryByText(/^Looking for/)).toBeNull();
      });
      if (name === 'without Claude Code') expect(served.identityRequests).toEqual([]);
      expect(next('Continue').hasAttribute('disabled')).toBe(true);
    });
  });

  it('Recheck on Tools asks the daemon to probe again', async () => {
    const served = serve();
    renderApp('/');
    await toSetup();
    await within(card('Tools')).findByText('git version 2.50.0');
    expect(served.systemRequests).not.toContain('1');
    fireEvent.click(within(card('Tools')).getByRole('button', { name: 'Recheck' }));
    await waitFor(() => {
      expect(served.systemRequests).toContain('1');
    });
  });

  describe('the gh row', () => {
    it.each([
      { name: 'signed in', gh: GH, text: 'gh 2.0.0, signed in as octocat' },
      {
        name: 'signed out',
        gh: { ...GH, signedIn: undefined },
        text: 'Not signed in. Run gh auth login in a terminal, then recheck.',
      },
      {
        name: 'missing',
        gh: { ...GH, path: null, version: null, signedIn: undefined },
        text: 'Not found. Needed only for pull requests.',
      },
    ])('$name', async ({ gh, text }) => {
      serve({ tools: [CLAUDE, GIT, gh] });
      renderApp('/');
      await toSetup();
      expect(await within(card('Tools')).findByText(text)).toBeTruthy();
      await waitFor(() => {
        expect(next('Continue').hasAttribute('disabled')).toBe(false);
      });
    });
  });

  it('creates the project, lands on the board and selects it', async () => {
    const served = serve();
    const { router } = renderApp('/');
    await toSetup();
    await within(card('Tools')).findByText('git version 2.50.0');
    await waitFor(() => {
      expect(next('Continue').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(next('Continue'));
    await screen.findByRole('heading', { name: 'Add a project' });

    const path = screen.getByRole('textbox', { name: 'Folder path' });
    fireEvent.change(path, { target: { value: '/Users/me/widgets' } });
    fireEvent.blur(path);
    await screen.findByRole('textbox', { name: 'Name' });
    await screen.findByRole('group', { name: 'Area 1' });
    fireEvent.click(next('Create Project'));

    expect(
      await screen.findByRole('button', { name: 'Project: widgets. Switch project' }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/board');
    expect(served.posted).toHaveLength(1);
  });

  it('shows a refusal from the daemon in the footer', async () => {
    serve(
      {},
      http.post(daemonUrl('/projects'), () =>
        HttpResponse.json({ error: 'conflict', message: 'Already a project.' }, { status: 409 }),
      ),
    );
    renderApp('/');
    await toSetup();
    await within(card('Tools')).findByText('git version 2.50.0');
    await waitFor(() => {
      expect(next('Continue').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(next('Continue'));
    const path = await screen.findByRole('textbox', { name: 'Folder path' });
    fireEvent.change(path, { target: { value: '/Users/me/widgets' } });
    fireEvent.blur(path);
    await screen.findByRole('textbox', { name: 'Name' });
    await screen.findByRole('group', { name: 'Area 1' });
    fireEvent.click(next('Create Project'));
    expect(await screen.findByText("Couldn't create the project: Already a project.")).toBeTruthy();
  });

  it('Back returns a step', async () => {
    serve();
    renderApp('/');
    await toSetup();
    fireEvent.click(next('Back'));
    expect(await screen.findByRole('heading', { name: 'Welcome to 10db' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('a done step can be clicked to go back and a later one cannot', async () => {
    serve();
    renderApp('/');
    await toSetup();
    const later = screen.getByRole('button', { name: /Add a project/ });
    fireEvent.click(later);
    expect(screen.queryByRole('heading', { name: 'Add a project' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Welcome/ }));
    expect(await screen.findByRole('heading', { name: 'Welcome to 10db' })).toBeTruthy();
  });
});

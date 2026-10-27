import { KeepAwakeStatus } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { projectDto } from '../../test/fixtures';

/** Opens a Select and picks an option from its own list (every Select keeps its options in the document). */
async function pick(select: HTMLElement, option: string): Promise<void> {
  fireEvent.click(select);
  const labelId = select instanceof HTMLInputElement ? select.labels?.[0]?.id : undefined;
  const listbox = screen
    .getAllByRole('listbox', { hidden: true })
    .find((l) => l.getAttribute('aria-labelledby') === labelId);
  expect(listbox).toBeDefined();
  fireEvent.click(
    await within(listbox ?? document.body).findByRole('option', { name: option, hidden: true }),
  );
}

describe('SettingsView', () => {
  it('opens General from /settings and lists every section in its group', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 2 })).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const label of [
      'General',
      'Board columns',
      'Areas and hazards',
      'Billing',
      'Team',
      'Routing rules',
      'Keep-awake',
      'Accounts',
      'Models and benchmarks',
      'Personas and flows',
    ])
      expect(within(nav).getByRole('link', { name: new RegExp(label) })).toBeTruthy();
  });

  it('redirects an unknown section to General', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/nope');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
  });

  it('says what a planned section will hold and which plan fills it', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/team');
    expect(await screen.findByRole('heading', { name: 'Team', level: 3 })).toBeTruthy();
    expect(screen.getByText(/Not built yet/)).toBeTruthy();
    expect(screen.getByText(/team editor plan/)).toBeTruthy();
  });

  it('asks for a project before showing a project section', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/areas');
    expect(await screen.findByText('Create a project on the board first.')).toBeTruthy();
  });

  it("shows the selected project's areas, hazards and account, moves it, and names its fallback", async () => {
    const project = projectDto({
      areas: [{ name: 'api', globs: ['src/api/**'] }],
      hazards: [{ name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] }],
    });
    const client = accountDto({
      kind: 'anthropic_api_key',
      label: 'Client key',
      configDir: '/data/accounts/k/claude',
    });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, client])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        const body = await request.json();
        patched.push(body);
        // The daemon refuses an uncapped metered fallback; the move itself goes through.
        return typeof body === 'object' && body !== null && 'fallbackAccountId' in body
          ? HttpResponse.json(
              {
                error: 'invalid',
                message:
                  'Set a monthly cap on "Client key" before making it a fallback: 10db moves work onto it without asking',
              },
              { status: 400 },
            )
          : HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    expect(await screen.findByText('src/api/**')).toBeTruthy();
    expect(screen.getByText('pnpm add')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Billing/ }));
    const picker = await screen.findByRole('combobox', { name: 'Account' });
    // The account list loads after the section opens.
    await waitFor(() => {
      expect(picker).toHaveProperty(
        'value',
        'Claude plan · builder@example.com (Claude subscription)',
      );
    });
    await pick(picker, 'Client key (Anthropic API key)');
    await waitFor(() => {
      expect(patched).toEqual([{ accountId: client.id }]);
    });

    const fallback = screen.getByRole('combobox', { name: 'Fallback account' });
    expect(fallback).toHaveProperty('value', '');
    await pick(fallback, 'Client key (Anthropic API key)');
    await waitFor(() => {
      expect(patched).toEqual([{ accountId: client.id }, { fallbackAccountId: client.id }]);
    });
    expect(await screen.findByText(/Set a monthly cap on "Client key"/)).toBeTruthy();
  });

  it('saves the handoff threshold as a share of the limit, and refuses one outside 50–99%', async () => {
    const project = projectDto();
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('link', { name: /Billing/ }));
    const field = await screen.findByRole('textbox', { name: 'Hand off at' });
    expect(field).toHaveProperty('value', '95%');
    expect(screen.getByText(/only on a Claude subscription account/)).toBeTruthy();

    fireEvent.change(field, { target: { value: '100' } });
    fireEvent.blur(field);
    expect(await screen.findByText('Between 50% and 99%')).toBeTruthy();
    expect(patched).toEqual([]);

    fireEvent.change(field, { target: { value: '40' } });
    fireEvent.blur(field);
    expect(await screen.findByText('Between 50% and 99%')).toBeTruthy();
    expect(patched).toEqual([]);

    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.blur(field);
    await waitFor(() => {
      expect(patched).toEqual([{ usageHandoffAt: 0.9 }]);
    });
  });

  it("offers the project's other accounts as its fallback, never its own", async () => {
    const project = projectDto();
    const client = accountDto({ label: 'Client key', kind: 'anthropic_api_key' });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, client])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('link', { name: /Billing/ }));
    const fallback = await screen.findByRole('combobox', { name: 'Fallback account' });
    fireEvent.click(fallback);
    const labelId = fallback instanceof HTMLInputElement ? fallback.labels?.[0]?.id : undefined;
    const listbox = screen
      .getAllByRole('listbox', { hidden: true })
      .find((l) => l.getAttribute('aria-labelledby') === labelId);
    expect(listbox).toBeDefined();
    // The account list loads after the section opens.
    await within(listbox ?? document.body).findByRole('option', { hidden: true });
    const names = within(listbox ?? document.body)
      .getAllByRole('option', { hidden: true })
      .map((o) => o.textContent);
    expect(names).toEqual(['Client key (Anthropic API key)']);
  });

  it('shows the recorded fallback after 10db moved the project onto it', async () => {
    const client = accountDto({ label: 'Client key', kind: 'anthropic_api_key' });
    const project = projectDto({
      accountId: client.id,
      fallbackAccountId: client.id,
      movedFromAccountId: DEFAULT_ACCOUNT.id,
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, client])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('link', { name: /Billing/ }));
    const fallback = await screen.findByRole('combobox', { name: 'Fallback account' });
    await waitFor(() => {
      expect(fallback).toHaveProperty('value', 'Client key (Anthropic API key)');
    });
  });

  it("shows each project's own threshold after the project changes, and saves nothing on blur", async () => {
    const a = projectDto({ name: 'Alpha', usageHandoffAt: 0.9 });
    const b = projectDto({ name: 'Beta', usageHandoffAt: 0.95 });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([a, b])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(b);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('link', { name: /Billing/ }));
    expect(await screen.findByRole('textbox', { name: 'Hand off at' })).toHaveProperty(
      'value',
      '90%',
    );
    await pick(screen.getByRole('combobox', { name: 'Project' }), 'Beta');
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Hand off at' })).toHaveProperty('value', '95%');
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Hand off at' }));
    expect(patched).toEqual([]);
  });

  it('changes the keep-awake mode', async () => {
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/settings/keep-awake'), async ({ request }) => {
        put.push(await request.json());
        return HttpResponse.json(KeepAwakeStatus.parse({ mode: 'always', active: true }));
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/keep-awake');
    fireEvent.click(await screen.findByRole('radio', { name: 'Always keep the Mac awake' }));
    await waitFor(() => {
      expect(put).toEqual([{ mode: 'always' }]);
    });
  });

  it('saves only the changed project fields', async () => {
    let project = projectDto({ name: 'demo', gateCommand: 'make gate' });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        const body = await request.json();
        patched.push(body);
        project = { ...project, gateCommand: 'make check' };
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    const gate = await screen.findByLabelText('Gate command');
    fireEvent.change(gate, { target: { value: 'make check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patched).toEqual([{ gateCommand: 'make check' }]);
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows the localhost switch off, with its warning, and no permission mode', async () => {
    const project = projectDto();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    await screen.findByLabelText('Gate command');
    const localhost = screen.getByRole<HTMLInputElement>('switch', {
      name: /^Let lane commands use localhost/,
    });
    expect(localhost.checked).toBe(false);
    expect(screen.getByText(/opens every local port to the lane/)).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Permissions' })).toBeNull();
  });

  it('saves the localhost switch as a patch', async () => {
    const project = projectDto({ name: 'demo', gateCommand: 'make gate' });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json({ ...project, sandboxLoopback: true });
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    await screen.findByLabelText('Gate command');
    fireEvent.click(screen.getByRole('switch', { name: /^Let lane commands use localhost/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patched).toEqual([{ sandboxLoopback: true }]);
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('saves the extra allowed commands, one per line', async () => {
    const project = projectDto({ name: 'demo', gateCommand: 'make gate' });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json({
          ...project,
          allowedCommands: ['pnpm exec prettier', 'pnpm test'],
        });
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Extra allowed commands'), {
      target: { value: 'pnpm exec prettier\npnpm test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patched).toEqual([{ allowedCommands: ['pnpm exec prettier', 'pnpm test'] }]);
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows the bad line of the extra allowed commands without calling the daemon', async () => {
    const project = projectDto({ name: 'demo', gateCommand: 'make gate' });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Extra allowed commands'), {
      target: { value: 'pnpm test\npnpm --run' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/^Line 2: /)).toBeTruthy();
    expect(patched).toEqual([]);
  });

  it('blocks a nudge at the handoff without calling the daemon', async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    let calls = 0;
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Nudge at %'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The nudge must come after the handoff')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("shows the daemon's message when it refuses the change", async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), () =>
        HttpResponse.json({ error: 'not_found', message: 'flow flw_x not found' }, { status: 404 }),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('flow flw_x not found')).toBeTruthy();
  });

  it('says there is nothing to change', async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing to change.')).toBeTruthy();
  });

  it('switches a project to pull-request delivery, and shows why the daemon refuses it while work runs', async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(
          {
            error: 'conflict',
            message: 'demo has unfinished work; finish or cancel it before changing its delivery',
          },
          { status: 409 },
        );
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('radio', { name: 'One pull request per batch' }));
    fireEvent.change(screen.getByLabelText('PR title prefix'), { target: { value: 'feat(app)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patched).toEqual([{ delivery: 'pull_request', prTitlePrefix: 'feat(app)' }]);
    });
    expect(await screen.findByText(/has unfinished work/)).toBeTruthy();
  });

  it('keeps what the builder typed and picks up other fields when the project changes mid-edit', async () => {
    const first = projectDto({ name: 'demo', gateCommand: 'make gate' });
    let current = first;
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([current])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    const { queryClient } = renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'renamed' } });
    // Another window changes the gate command and the lane cap while this form is open.
    current = {
      ...first,
      gateCommand: 'make check',
      maxLanes: 7,
      updatedAt: '2026-10-13T13:00:00.000Z',
    };
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Gate command').value).toBe('make check');
    });
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('renamed');
    expect(screen.getByLabelText<HTMLInputElement>('Lanes').value).toBe('7');
  });
});

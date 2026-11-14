import { KeepAwakeStatus, LanePermissionsDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { projectDto } from '../../test/fixtures';
import { SHAPE_JEV_LABEL } from './shape-jev-setting';

/** Opens a Select and picks an option from its own list (every Select keeps its options in the document). */
async function pick(field: string, option: RegExp): Promise<void> {
  const listbox = await waitFor(() => {
    // Looked up afresh each time: a refetch can replace the field and close its list.
    const input = screen.getByRole('combobox', { name: field });
    if (input.getAttribute('aria-expanded') !== 'true') fireEvent.click(input);
    const found = screen
      .getAllByRole('listbox', { hidden: true })
      .find((l) => l.id === input.getAttribute('aria-controls'));
    expect(found).toBeDefined();
    return found ?? document.body;
  });
  fireEvent.click(await within(listbox).findByRole('option', { name: option, hidden: true }));
}

describe('SettingsView', () => {
  it('opens General from /settings with no page title and no project picker', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
    expect(await screen.findByRole('heading', { name: 'General', level: 3 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Settings', level: 2 })).toBeNull();
    // The one project switcher lives in the sidebar.
    expect(screen.getAllByRole('button', { name: /Switch project/ })).toHaveLength(1);
  });

  it("the sidebar shows Back to Board, the scope switch and the project's sections with the switcher", async () => {
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: 'Back to Board' })).toBeTruthy();
    expect(within(nav).getByText('Project')).toBeTruthy();
    expect(within(nav).getByRole('radio', { name: 'All projects' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: /Switch project/ })).toBeTruthy();
    for (const label of ['General', 'Board columns', 'Areas and hazards', 'Billing'])
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy();
    // The app nav gives way to Settings' own.
    expect(screen.queryByRole('link', { name: 'Factory' })).toBeNull();
  });

  it('lists Who Answers and Models by role at project scope, and People and Models at app scope', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/general');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    for (const label of ['Who Answers', 'Models by role'])
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('radio', { name: 'All projects' }));
    for (const label of ['People', 'Models'])
      expect(await within(nav).findByRole('link', { name: label })).toBeTruthy();
  });

  it('moves the three Plan settings from General to Planning', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    expect(await screen.findByRole('button', { name: 'Advanced' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: SHAPE_JEV_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Planning' }));
    expect(await screen.findByRole('switch', { name: SHAPE_JEV_LABEL })).toBeTruthy();
    expect(
      screen.getByText("How Plan treats this project's work before a lane starts it."),
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /One-way paths/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
  });

  it.each([
    {
      path: '/settings/project-trust',
      line: 'For Renewals only. Anything set to As app follows All projects › Trust.',
    },
    {
      path: '/settings/trust',
      line: 'For every project. A project can override this in its own Trust.',
    },
    {
      path: '/settings/team',
      line: 'For Renewals only. Use global follows All projects › Models.',
    },
  ])('says its scope under the title at $path', async ({ path, line }) => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto({ name: 'Renewals' })])),
      ...baseHandlers(),
    );
    renderApp(path);
    expect(await screen.findByText(line)).toBeTruthy();
  });

  it('Back to Board returns to /board', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('link', { name: 'Back to Board' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
  });

  it('redirects an unknown section to General', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/nope');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
  });

  it('shows the project playbook at /settings/team, with the human-members remainder as a note without "Still to come"', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
      ...baseHandlers(),
    );
    renderApp('/settings/team');
    expect(await screen.findByRole('combobox', { name: 'Default rigor' })).toBeTruthy();
    expect(screen.getByText("Not built yet: the project's human members.")).toBeTruthy();
    expect(screen.queryByText(/Still to come/)).toBeNull();
  });

  it('sends the retired Models by role address to Models', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/personas-and-flows');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/models');
    });
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
    expect(await screen.findByDisplayValue('src/api/**')).toBeTruthy();
    expect(screen.getByDisplayValue('pnpm add')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Billing/ }));
    const picker = await screen.findByRole('combobox', { name: 'Account' });
    // The account list loads after the section opens.
    await waitFor(() => {
      expect(picker).toHaveProperty('value', 'Claude plan');
    });
    await pick('Account', /Client key/);
    await waitFor(() => {
      expect(patched).toEqual([{ accountId: client.id }]);
    });

    const fallback = screen.getByRole('combobox', { name: 'Backup account' });
    expect(fallback).toHaveProperty('value', '');
    await pick('Backup account', /Client key/);
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
    const field = await screen.findByRole('textbox', { name: 'Switch at' });
    expect(field).toHaveProperty('value', '95%');
    expect(screen.getByText(/On a Claude plan/)).toBeTruthy();

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
    const fallback = await screen.findByRole('combobox', { name: 'Backup account' });
    fireEvent.click(fallback);
    const listbox = screen
      .getAllByRole('listbox', { hidden: true })
      .find((l) => l.id === fallback.getAttribute('aria-controls'));
    expect(listbox).toBeDefined();
    // The account list loads after the section opens.
    await within(listbox ?? document.body).findByRole('option', { hidden: true });
    const names = within(listbox ?? document.body)
      .getAllByRole('option', { hidden: true })
      .map((o) => o.textContent);
    expect(names).toEqual(['Client keyAnthropic API key']);
  });

  it.each(['Account', 'Backup account'])(
    'lists an OpenRouter account in %s disabled, since it can’t run agents yet',
    async (name) => {
      const project = projectDto();
      const router = accountDto({ label: 'Work key', kind: 'openrouter' });
      server.use(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
        http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, router])),
        ...baseHandlers(),
      );
      renderApp('/settings/areas');
      fireEvent.click(await screen.findByRole('link', { name: /Billing/ }));
      const picker = await screen.findByRole('combobox', { name });
      fireEvent.click(picker);
      const listbox = screen
        .getAllByRole('listbox', { hidden: true })
        .find((l) => l.id === picker.getAttribute('aria-controls'));
      const option = await within(listbox ?? document.body).findByRole('option', {
        name: /Work key/,
        hidden: true,
      });
      expect(option.getAttribute('data-combobox-disabled')).toBe('true');
      expect(option.textContent).toContain("Can't run agents yet");
    },
  );

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
    const fallback = await screen.findByRole('combobox', { name: 'Backup account' });
    await waitFor(() => {
      expect(fallback).toHaveProperty('value', 'Client key');
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
    expect(await screen.findByRole('textbox', { name: 'Switch at' })).toHaveProperty(
      'value',
      '90%',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Project: Alpha. Switch project' }));
    fireEvent.click(await screen.findByRole('option', { name: /Beta/, hidden: true }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Switch at' })).toHaveProperty('value', '95%');
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Switch at' }));
    expect(patched).toEqual([]);
  });

  it('Billing has Account, Backup account and Switch at, and no fallback model', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
      ...baseHandlers(),
    );
    renderApp('/settings/billing');
    expect(await screen.findByRole('combobox', { name: 'Account' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Backup account' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Switch at' })).toBeTruthy();
    expect(screen.queryByText(/fallback model/i)).toBeNull();
    expect(screen.queryByText('Fallback account')).toBeNull();
  });

  it('Keep awake is one row with Never, While tasks run and Always', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/keep-awake');
    const group = await screen.findByRole('radiogroup', { name: 'Keep the Mac awake' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['off', 'while_running', 'always']);
    expect(within(group).getByText('While tasks run')).toBeTruthy();
    expect(within(group).getByText('Never')).toBeTruthy();
  });

  it('shows the lane permission switch on, and turns it off', async () => {
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/settings/lane-permissions'), async ({ request }) => {
        put.push(await request.json());
        return HttpResponse.json(LanePermissionsDto.parse({ autoMode: false }));
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/lane-permissions');
    const toggle = await screen.findByRole('switch', {
      name: "Lanes decide routine permissions with Claude Code's auto mode",
    });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(true);
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(put).toEqual([{ autoMode: false }]);
    });
  });

  it('shows the other project\u2019s areas after switching projects, not the first one\u2019s', async () => {
    const a = projectDto({ name: 'Alpha', areas: [{ name: 'api', globs: ['src/api/**'] }] });
    const b = projectDto({ name: 'Beta', areas: [{ name: 'core', globs: ['src/core/**'] }] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([a, b])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    expect(await screen.findByRole('textbox', { name: 'Area 1 name' })).toHaveProperty(
      'value',
      'api',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Project: Alpha. Switch project' }));
    fireEvent.click(await screen.findByRole('option', { name: /Beta/, hidden: true }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Area 1 name' })).toHaveProperty('value', 'core');
    });
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
    fireEvent.click(await screen.findByRole('radio', { name: 'Always' }));
    await waitFor(() => {
      expect(put).toEqual([{ mode: 'always' }]);
    });
  });

  it('shows the bad line of the extra allowed commands without calling the daemon', async () => {
    const project = projectDto({ name: 'demo', gateCommand: 'make gate' });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText("Commands that don't ask"), {
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
      http.patch(daemonUrl('/projects/:projectId'), () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText('Firm reminder'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The nudge must come after the handoff')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("shows the daemon's message when it refuses the change", async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.patch(daemonUrl('/projects/:projectId'), () =>
        HttpResponse.json({ error: 'not_found', message: 'flow flw_x not found' }, { status: 404 }),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/flow flw_x not found/)).toBeTruthy();
  });

  it('says there is nothing to change', async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing to change')).toBeTruthy();
  });

  it('switches a project to pull-request delivery, and shows why the daemon refuses it while work runs', async () => {
    // One fixed project: a handler that mints a new ID per fetch would remount the form.
    const project = projectDto();
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
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
    fireEvent.click(await screen.findByRole('radio', { name: 'Pull request' }));
    fireEvent.change(screen.getByLabelText('Pull request title'), {
      target: { value: 'feat(app)' },
    });
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
    expect(screen.getByLabelText<HTMLInputElement>('Most tasks at once').value).toBe('7');
  });
});

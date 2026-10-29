import {
  FolderInspectInput,
  FolderRefusalReason,
  SystemCheckDto,
  type FolderInspection,
  type FolderInspectResult,
} from '@10db/contracts';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, eventStream, renderWithDaemon, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';
import { useProjectSetup } from './project-setup';

afterEach(() => {
  clearMocks();
  // `clearMocks` leaves the marker `isTauri` reads.
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

/** The native folder panel is the boundary: Tauri's IPC answers the dialog plugin's `open` command. */
function panel(picked: string | null): string[] {
  const asked: string[] = [];
  mockIPC((command) => {
    if (command === 'plugin:dialog|open') {
      asked.push(command);
      return picked;
    }
    return undefined;
  });
  return asked;
}

const HIDDEN = { hidden: true } as const;

function inspection(overrides: Partial<FolderInspection> = {}): FolderInspection {
  return {
    root: '/Users/me/widgets',
    suggestedName: 'widgets',
    branches: [
      { name: 'main', remote: true },
      { name: 'develop', remote: true },
      { name: 'wip', remote: false },
    ],
    defaultBranch: 'main',
    github: 'me/widgets',
    gateCandidates: [
      { command: 'make gate', source: 'makefile' },
      { command: 'npm test', source: 'package_json' },
    ],
    ...overrides,
  };
}

/** gh as the system check finds it. */
type Gh = 'missing' | 'signed_out' | { readonly login: string };

function system(gh: Gh) {
  return SystemCheckDto.parse({
    loginEnv: { source: 'login_shell', warning: null },
    claudeCode: { verifiedOn: '2.1.302', warning: null },
    tools: [
      { name: 'claude', path: '/usr/local/bin/claude', version: '2.1', required: true },
      { name: 'git', path: '/usr/bin/git', version: 'git version 2.50.0', required: true },
      gh === 'missing'
        ? { name: 'gh', path: null, version: null, required: false }
        : {
            name: 'gh',
            path: '/usr/bin/gh',
            version: 'gh 2.0.0',
            required: false,
            signedIn: gh === 'signed_out' ? null : gh.login,
          },
    ],
  });
}

interface Served {
  readonly inspected: string[];
  readonly posted: unknown[];
  readonly accountsRequested: () => boolean;
}

function serve(
  opts: {
    readonly result?: FolderInspectResult;
    readonly gh?: Gh;
    readonly accounts?: ReturnType<typeof accountDto>[];
    readonly createStatus?: number;
  } = {},
): Served {
  let accountsAsked = false; // set by the /accounts handler
  const served: Served = {
    inspected: [],
    posted: [],
    accountsRequested: () => accountsAsked,
  };
  const result = opts.result ?? { ok: true, inspection: inspection() };
  server.use(
    http.post(daemonUrl('/folders/inspect'), async ({ request }) => {
      served.inspected.push(FolderInspectInput.parse(await request.json()).path);
      return HttpResponse.json(result);
    }),
    http.get(daemonUrl('/system'), () =>
      HttpResponse.json(system(opts.gh ?? { login: 'octocat' })),
    ),
    http.get(daemonUrl('/accounts'), () => {
      accountsAsked = true;
      return HttpResponse.json(opts.accounts ?? [DEFAULT_ACCOUNT]);
    }),
    http.post(daemonUrl('/projects'), async ({ request }) => {
      served.posted.push(await request.json());
      if (opts.createStatus !== undefined && opts.createStatus >= 400) {
        return HttpResponse.json(
          { error: 'invalid', message: 'The folder changed.' },
          { status: opts.createStatus },
        );
      }
      return HttpResponse.json(projectDto(), { status: 201 });
    }),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return served;
}

function Harness({ onCreated }: { readonly onCreated: () => void }) {
  const setup = useProjectSetup(onCreated);
  return (
    <>
      {setup.fields}
      <button disabled={!setup.canSubmit} onClick={setup.submit}>
        Create Project
      </button>
      <p data-testid="error">{setup.error}</p>
    </>
  );
}

async function openForm(onCreated: () => void = () => undefined): Promise<void> {
  renderWithDaemon(<Harness onCreated={onCreated} />);
  await screen.findByRole('textbox', { name: 'Folder path' });
}

async function typePath(path: string): Promise<void> {
  const input = await screen.findByRole('textbox', { name: 'Folder path' });
  fireEvent.change(input, { target: { value: path } });
  fireEvent.blur(input);
}

async function openInspected(): Promise<void> {
  await openForm();
  await typePath('/Users/me/widgets');
  await screen.findByRole('textbox', { name: 'Name' });
}

/** A text or select input by its name. */
function field(name: string): HTMLInputElement {
  const el = screen.getByRole(
    name === 'Account' || name === 'Base branch' ? 'combobox' : 'textbox',
    {
      name,
    },
  );
  if (!(el instanceof HTMLInputElement)) throw new Error(`${name} is not an input`);
  return el;
}

function create(): HTMLElement {
  return screen.getByRole('button', { name: 'Create Project' });
}

/** Mantine marks a disabled control with the attribute or `data-disabled`, by component. */
function disabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('data-disabled') === 'true';
}

describe('useProjectSetup', () => {
  it('shows only the folder control at first', async () => {
    serve();
    await openForm();
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Gate command' })).toBeNull();
    expect(disabled(create())).toBe(true);
  });

  it('chooses a folder in the native panel, inspects it and shows the root once with Change', async () => {
    panel('/Users/me/widgets');
    const served = serve();
    renderWithDaemon(<Harness onCreated={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Choose Folder…' }));
    await screen.findByRole('textbox', { name: 'Name' });

    expect(served.inspected).toEqual(['/Users/me/widgets']);
    expect(screen.getAllByText('/Users/me/widgets')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.queryByText("The repository's top folder.")).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Folder path' })).toBeNull();
  });

  it('types a path instead of using the panel when asked', async () => {
    panel(null);
    serve();
    renderWithDaemon(<Harness onCreated={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'or type a path' }));
    expect(await screen.findByRole('textbox', { name: 'Folder path' })).toBeTruthy();
  });

  it('a cancelled panel changes nothing', async () => {
    const asked = panel(null);
    const served = serve();
    renderWithDaemon(<Harness onCreated={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Folder…' }));
    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(served.inspected).toEqual([]);
    expect(screen.getByRole('button', { name: 'Choose Folder…' })).toBeTruthy();
  });

  it('a subfolder shows the repository root and says it is the top folder', async () => {
    panel('/Users/me/widgets/packages/ui');
    serve();
    renderWithDaemon(<Harness onCreated={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Folder…' }));
    await screen.findByRole('textbox', { name: 'Name' });
    expect(screen.getByText('/Users/me/widgets')).toBeTruthy();
    expect(screen.getByText("The repository's top folder.")).toBeTruthy();
  });

  it.each(Object.values(FolderRefusalReason).map((reason) => [reason] as const))(
    'a %s refusal shows on the folder box and nothing else',
    async (reason) => {
      serve({ result: { ok: false, reason, message: `Refused: ${reason}.` } });
      await openForm();
      await typePath('/Users/me/nope');
      expect(await screen.findByText(`Refused: ${reason}.`)).toBeTruthy();
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      expect(screen.queryByRole('radio')).toBeNull();
      expect(disabled(create())).toBe(true);
    },
  );

  it('the browser types a path and inspects on blur', async () => {
    const served = serve();
    await openForm();
    const input = screen.getByRole('textbox', { name: 'Folder path' });
    fireEvent.change(input, { target: { value: '/Users/me/widgets' } });
    expect(served.inspected).toEqual([]);
    fireEvent.blur(input);
    await screen.findByRole('textbox', { name: 'Name' });
    expect(served.inspected).toEqual(['/Users/me/widgets']);
  });

  it('the browser inspects when Enter is pressed', async () => {
    const served = serve();
    await openForm();
    const input = screen.getByRole('textbox', { name: 'Folder path' });
    fireEvent.change(input, { target: { value: '/Users/me/widgets' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('textbox', { name: 'Name' });
    expect(served.inspected).toEqual(['/Users/me/widgets']);
  });

  it('prefills the name and the best gate candidate; pills fill the input', async () => {
    serve();
    await openInspected();
    const name = field('Name');
    const gate = field('Gate command');
    expect(name.value).toBe('widgets');
    expect(gate.value).toBe('make gate');
    fireEvent.click(screen.getByRole('button', { name: /^npm test/ }));
    expect(gate.value).toBe('npm test');
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^make gate/ }));
    expect(await screen.findByText('from Makefile', {}, { timeout: 2000 })).toBeTruthy();
  });

  it('an empty gate is a field error and Create Project stays disabled', async () => {
    serve({ result: { ok: true, inspection: inspection({ gateCandidates: [] }) } });
    await openInspected();
    expect(field('Gate command').value).toBe('');
    expect(screen.getByText('Enter the command that checks the work')).toBeTruthy();
    expect(disabled(create())).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Gate command' }), {
      target: { value: 'make check' },
    });
    expect(screen.queryByText('Enter the command that checks the work')).toBeNull();
    expect(disabled(create())).toBe(false);
  });

  it('asks for a full path instead of sending a relative one', async () => {
    const served = serve();
    await openForm();
    await typePath('~/Projects/app');
    expect(await screen.findByText('Enter the full path, starting with /')).toBeTruthy();
    expect(served.inspected).toEqual([]);
  });

  it('does not inspect the same path twice, so Enter keeps what was edited', async () => {
    const served = serve();
    await openInspected();
    fireEvent.change(field('Name'), { target: { value: 'renamed' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Folder path' }), { key: 'Enter' });
    expect(served.inspected).toEqual(['/Users/me/widgets']);
    expect(field('Name').value).toBe('renamed');
  });

  it('a new folder starts again from its own prefill and delivery default', async () => {
    serve();
    await openInspected();
    fireEvent.click(screen.getByRole('radio', { name: /Commit directly/ }));
    fireEvent.change(field('Name'), { target: { value: 'renamed' } });
    await typePath('/Users/me/other');
    await waitFor(() => {
      expect(field('Name').value).toBe('widgets');
    });
    expect(
      screen.getByRole('radio', { name: /Open a pull request/ }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('leaves out archived accounts: one active and one archived show no Account', async () => {
    const served = serve({
      accounts: [DEFAULT_ACCOUNT, accountDto({ label: 'Old', archived: true })],
    });
    await openInspected();
    await waitFor(() => {
      expect(served.accountsRequested()).toBe(true);
    });
    expect(screen.queryByRole('combobox', { name: 'Account' })).toBeNull();
  });

  it('hides Account with a single account', async () => {
    serve();
    await openInspected();
    expect(screen.queryByRole('combobox', { name: 'Account' })).toBeNull();
  });

  it('with two accounts, Account shows and the default is sent', async () => {
    const other = accountDto({ label: 'Company A' });
    const served = serve({ accounts: [DEFAULT_ACCOUNT, other] });
    await openInspected();
    await screen.findByRole('combobox', { name: 'Account' });
    expect(field('Account').value).toBe('Claude plan');
    fireEvent.click(create());
    await waitFor(() => {
      expect(served.posted).toHaveLength(1);
    });
    expect(served.posted[0]).toMatchObject({ accountId: DEFAULT_ACCOUNT.id });
  });

  describe('when work is finished', () => {
    const pr = () => screen.getByRole('radio', { name: /Open a pull request/ });
    const direct = () => screen.getByRole('radio', { name: /Commit directly/ });
    const checked = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true';

    it('preselects pull requests when possible', async () => {
      serve();
      await openInspected();
      expect(checked(pr())).toBe(true);
      expect(checked(direct())).toBe(false);
    });

    it.each([
      {
        name: 'without gh',
        gh: 'missing',
        result: undefined,
        reason: 'Needs the GitHub CLI, signed in.',
      },
      {
        name: 'with gh signed out',
        gh: 'signed_out',
        result: undefined,
        reason: 'Needs the GitHub CLI, signed in.',
      },
      {
        name: 'with no GitHub remote',
        gh: { login: 'octocat' },
        result: { github: null },
        reason: 'This folder has no GitHub remote.',
      },
      {
        name: 'with no commits',
        gh: { login: 'octocat' },
        result: { branches: [], defaultBranch: null },
        reason: 'This repository has no commits yet.',
      },
    ] satisfies {
      name: string;
      gh: Gh;
      result: Partial<FolderInspection> | undefined;
      reason: string;
    }[])('disables pull requests $name and picks Commit directly', async (row) => {
      serve({
        gh: row.gh,
        result: { ok: true, inspection: inspection(row.result ?? {}) },
      });
      await openInspected();
      await screen.findByText(row.reason);
      expect(disabled(pr())).toBe(true);
      expect(checked(direct())).toBe(true);
      expect(screen.queryByRole('combobox', { name: 'Base branch' })).toBeNull();
    });

    it('lists origin branches first and preselects the default', async () => {
      serve({
        result: { ok: true, inspection: inspection({ defaultBranch: 'develop' }) },
      });
      await openInspected();
      const base = field('Base branch');
      expect(base.value).toBe('develop');
      fireEvent.click(base);
      const options = await screen.findAllByRole('option', HIDDEN);
      expect(options.map((o) => o.textContent)).toEqual(['main', 'develop', 'wip']);
    });

    it('with no default branch preselects nothing and Create Project waits for a choice', async () => {
      const served = serve({
        result: { ok: true, inspection: inspection({ defaultBranch: null }) },
      });
      await openInspected();
      const base = field('Base branch');
      expect(base.value).toBe('');
      expect(disabled(create())).toBe(true);
      fireEvent.click(base);
      fireEvent.click(await screen.findByRole('option', { name: 'develop', ...HIDDEN }));
      await waitFor(() => {
        expect(disabled(create())).toBe(false);
      });
      fireEvent.click(create());
      await waitFor(() => {
        expect(served.posted).toHaveLength(1);
      });
      expect(served.posted[0]).toMatchObject({ baseBranch: 'develop' });
    });

    it('hides the base branch under Commit directly', async () => {
      serve();
      await openInspected();
      fireEvent.click(direct());
      expect(screen.queryByRole('combobox', { name: 'Base branch' })).toBeNull();
    });
  });

  it('sends the defaults for a pull-request project, with no title prefix', async () => {
    const served = serve();
    const created = vi.fn();
    await openForm(created);
    await typePath('/Users/me/widgets/sub');
    await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.click(create());
    await waitFor(() => {
      expect(served.posted).toHaveLength(1);
    });
    expect(served.posted[0]).toEqual({
      name: 'widgets',
      repoPath: '/Users/me/widgets',
      gateCommand: 'make gate',
      areas: [{ name: 'repo', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'pull_request',
      baseBranch: 'main',
    });
    await waitFor(() => {
      expect(created).toHaveBeenCalledTimes(1);
    });
  });

  it('sends a local project without a base branch or prefix', async () => {
    const served = serve();
    await openInspected();
    fireEvent.click(screen.getByRole('radio', { name: /Commit directly/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: ' app ' } });
    fireEvent.click(create());
    await waitFor(() => {
      expect(served.posted).toHaveLength(1);
    });
    expect(served.posted[0]).toEqual({
      name: 'app',
      repoPath: '/Users/me/widgets',
      gateCommand: 'make gate',
      areas: [{ name: 'repo', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'local',
    });
  });

  it('a refusal from POST /projects shows "Couldn\'t create the project: …"', async () => {
    serve({ createStatus: 400 });
    await openInspected();
    fireEvent.click(create());
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe(
        "Couldn't create the project: The folder changed.",
      );
    });
  });
});

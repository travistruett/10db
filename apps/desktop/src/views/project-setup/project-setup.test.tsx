import {
  AreaProposalInput,
  FolderInspectInput,
  FolderRefusalReason,
  SystemCheckDto,
  WHOLE_REPOSITORY_GLOBS,
  type AreaProposalResult,
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

/** What the daemon proposes for the folder unless a test says otherwise. */
const PROPOSAL: AreaProposalResult = {
  ok: true,
  proposal: {
    namedBy: 'model',
    areas: [
      { name: 'api', globs: ['apps/api/**'], reason: 'The API service.' },
      { name: 'web', globs: ['apps/web/**', 'apps/web/.*'], reason: 'The web app.' },
      { name: 'root', globs: ['*', '.*'], reason: 'Files at the top.' },
    ],
  },
};

interface Served {
  readonly inspected: string[];
  readonly proposed: string[];
  readonly posted: unknown[];
  readonly accountsRequested: () => boolean;
}

function serve(
  opts: {
    readonly result?: FolderInspectResult;
    readonly gh?: Gh;
    readonly accounts?: ReturnType<typeof accountDto>[];
    readonly createStatus?: number;
    /** The daemon's answer to the area proposal; 'fail' is a server error. A promise holds the answer back. */
    readonly proposal?: AreaProposalResult | 'fail' | Promise<AreaProposalResult>;
  } = {},
): Served {
  let accountsAsked = false; // set by the /accounts handler
  const served: Served = {
    inspected: [],
    proposed: [],
    posted: [],
    accountsRequested: () => accountsAsked,
  };
  const result = opts.result ?? { ok: true, inspection: inspection() };
  server.use(
    http.post(daemonUrl('/folders/inspect'), async ({ request }) => {
      served.inspected.push(FolderInspectInput.parse(await request.json()).path);
      return HttpResponse.json(result);
    }),
    http.post(daemonUrl('/folders/propose-areas'), async ({ request }) => {
      served.proposed.push(AreaProposalInput.parse(await request.json()).path);
      const answer = opts.proposal ?? PROPOSAL;
      if (answer === 'fail') return HttpResponse.json({ error: 'internal' }, { status: 500 });
      return HttpResponse.json(await answer);
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
  await screen.findByRole('group', { name: 'Area 1' });
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
    expect(await screen.findByText('from Makefile')).toBeTruthy();
  });

  it('an empty gate is allowed, says so, and is sent as null', async () => {
    const served = serve({ result: { ok: true, inspection: inspection({ gateCandidates: [] }) } });
    await openInspected();
    expect(field('Gate command').value).toBe('');
    expect(
      screen.getByText(
        "No check found. Leave it empty and you'll check each finished task yourself.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Enter the command that checks the work')).toBeNull();
    expect(disabled(create())).toBe(false);
    fireEvent.click(create());
    await waitFor(() => {
      expect(served.posted).toHaveLength(1);
    });
    expect(served.posted[0]).toMatchObject({ gateCommand: null });
    expect(served.posted[0]).toHaveProperty('gateCommand', null);
  });

  it('the no-check line describes the gate input', async () => {
    serve({ result: { ok: true, inspection: inspection({ gateCandidates: [] }) } });
    await openInspected();
    const input = screen.getByRole('textbox', { name: 'Gate command' });
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const line = screen.getByText(/No check found/);
    expect(ids.some((id) => id !== '' && document.getElementById(id)?.contains(line))).toBe(true);
  });

  it('emptying a prefilled gate does not claim no check was found', async () => {
    serve();
    await openInspected();
    fireEvent.change(screen.getByRole('textbox', { name: 'Gate command' }), {
      target: { value: '' },
    });
    expect(screen.queryByText(/No check found/)).toBeNull();
    expect(
      screen.getByText("Leave it empty and you'll check each finished task yourself."),
    ).toBeTruthy();
  });

  it('a gate typed into the input drops the no-check line', async () => {
    serve({ result: { ok: true, inspection: inspection({ gateCandidates: [] }) } });
    await openInspected();
    fireEvent.change(screen.getByRole('textbox', { name: 'Gate command' }), {
      target: { value: 'make check' },
    });
    expect(screen.queryByText(/No check found/)).toBeNull();
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
    await screen.findByRole('group', { name: 'Area 1' });
    fireEvent.click(create());
    await waitFor(() => {
      expect(served.posted).toHaveLength(1);
    });
    expect(served.posted[0]).toEqual({
      name: 'widgets',
      repoPath: '/Users/me/widgets',
      gateCommand: 'make gate',
      areas: [
        { name: 'api', globs: ['apps/api/**'] },
        { name: 'web', globs: ['apps/web/**', 'apps/web/.*'] },
        { name: 'root', globs: ['*', '.*'] },
      ],
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
      areas: [
        { name: 'api', globs: ['apps/api/**'] },
        { name: 'web', globs: ['apps/web/**', 'apps/web/.*'] },
        { name: 'root', globs: ['*', '.*'] },
      ],
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

describe('the areas in the new project', () => {
  const area = (n: number): HTMLElement => screen.getByRole('group', { name: `Area ${String(n)}` });
  const nameOf = (n: number): HTMLInputElement => {
    const el = screen.getByRole('textbox', { name: `Area ${String(n)} name` });
    if (!(el instanceof HTMLInputElement)) throw new Error('not an input');
    return el;
  };
  const globsOf = (n: number): HTMLTextAreaElement => {
    const el = screen.getByRole('textbox', { name: `Area ${String(n)} globs` });
    if (!(el instanceof HTMLTextAreaElement)) throw new Error('not a textarea');
    return el;
  };
  const names = () =>
    screen
      .getAllByRole('textbox', { name: /^Area \d+ name$/ })
      .map((el) => (el instanceof HTMLInputElement ? el.value : ''));

  async function createAndRead(served: Served): Promise<unknown> {
    fireEvent.click(create());
    await waitFor(() => {
      expect(served.posted).toHaveLength(1);
    });
    return served.posted[0];
  }

  it('proposes areas for the repository root, each with its globs and reason', async () => {
    const served = serve();
    await openForm();
    await typePath('/Users/me/widgets/sub');
    await screen.findByRole('group', { name: 'Area 1' });
    expect(served.proposed).toEqual(['/Users/me/widgets']);
    expect(names()).toEqual(['api', 'web', 'root']);
    expect(globsOf(2).value).toBe('apps/web/**\napps/web/.*');
    expect(screen.getByText('The API service.')).toBeTruthy();
    expect(screen.getByText('The web app.')).toBeTruthy();
  });

  it('waits for the proposal before the project can be created', async () => {
    let answer: (result: AreaProposalResult) => void = () => undefined;
    const held = new Promise<AreaProposalResult>((resolve) => {
      answer = resolve;
    });
    serve({ proposal: held });
    await openForm();
    await typePath('/Users/me/widgets');
    await screen.findByRole('textbox', { name: 'Name' });
    expect(await screen.findByText('Looking for the areas of this repository…')).toBeTruthy();
    expect(disabled(create())).toBe(true);
    answer(PROPOSAL);
    await screen.findByRole('group', { name: 'Area 1' });
    expect(disabled(create())).toBe(false);
    expect(screen.queryByText('Looking for the areas of this repository…')).toBeNull();
  });

  it('creates the project with exactly the areas the builder accepted', async () => {
    const served = serve();
    await openInspected();

    fireEvent.change(nameOf(1), { target: { value: 'backend' } });
    fireEvent.change(globsOf(1), { target: { value: 'apps/api/**\nservices/**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove root' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add area' }));
    fireEvent.change(nameOf(3), { target: { value: 'docs' } });
    fireEvent.change(globsOf(3), { target: { value: ' docs/** ' } });

    expect(names()).toEqual(['backend', 'web', 'docs']);
    expect(await createAndRead(served)).toMatchObject({
      areas: [
        { name: 'backend', globs: ['apps/api/**', 'services/**'] },
        { name: 'web', globs: ['apps/web/**', 'apps/web/.*'] },
        { name: 'docs', globs: ['docs/**'] },
      ],
    });
  });

  it('merges an area into another, which keeps its name and takes both sets of globs', async () => {
    const served = serve();
    await openInspected();
    fireEvent.click(screen.getByRole('button', { name: 'Merge web' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'api' }));
    expect(names()).toEqual(['api', 'root']);
    expect(globsOf(1).value).toBe('apps/api/**\napps/web/**\napps/web/.*');
    expect(await createAndRead(served)).toMatchObject({
      areas: [
        { name: 'api', globs: ['apps/api/**', 'apps/web/**', 'apps/web/.*'] },
        { name: 'root', globs: ['*', '.*'] },
      ],
    });
  });

  it('holds Create Project back for a bad name, a name used twice, or no glob, and says why', async () => {
    serve();
    await openInspected();
    fireEvent.change(nameOf(2), { target: { value: 'api' } });
    expect(screen.getAllByText('Another area has this name.')).toHaveLength(2);
    expect(disabled(create())).toBe(true);
    fireEvent.change(nameOf(2), { target: { value: 'Web App' } });
    expect(
      screen.getByText('Use lowercase letters, digits and hyphens, starting with a letter.'),
    ).toBeTruthy();
    fireEvent.change(nameOf(2), { target: { value: 'harness' } });
    expect(
      screen.getByText('harness is a hazard of every new project; choose another name.'),
    ).toBeTruthy();
    fireEvent.change(nameOf(2), { target: { value: 'web' } });
    fireEvent.change(globsOf(2), { target: { value: '' } });
    expect(screen.getByText('Give at least one glob.')).toBeTruthy();
    expect(disabled(create())).toBe(true);
    fireEvent.change(globsOf(2), { target: { value: 'apps/web/**' } });
    expect(disabled(create())).toBe(false);
  });

  it('will not create a project with no area', async () => {
    serve();
    await openInspected();
    for (const name of ['api', 'web', 'root'])
      fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    expect(screen.getByText('Keep at least one area.')).toBeTruthy();
    expect(disabled(create())).toBe(true);
  });

  it('starts from one area over the whole repository when the proposal fails, and says so', async () => {
    const served = serve({ proposal: 'fail' });
    await openForm();
    await typePath('/Users/me/widgets');
    await screen.findByRole('group', { name: 'Area 1' });
    expect(screen.getByText(/Couldn't propose areas/)).toBeTruthy();
    expect(names()).toEqual(['repo']);
    expect(area(1)).toBeTruthy();
    expect(await createAndRead(served)).toMatchObject({
      areas: [{ name: 'repo', globs: [...WHOLE_REPOSITORY_GLOBS] }],
    });
  });

  it('starts from one area over the whole repository when the daemon declines to propose', async () => {
    serve({ proposal: { ok: false, message: 'This is a bare repository; choose a checkout.' } });
    await openForm();
    await typePath('/Users/me/widgets');
    await screen.findByRole('group', { name: 'Area 1' });
    expect(screen.getByText(/This is a bare repository; choose a checkout\./)).toBeTruthy();
    expect(names()).toEqual(['repo']);
  });

  it('proposes again for a new folder and drops the edits made to the last one', async () => {
    const served = serve();
    await openInspected();
    fireEvent.change(nameOf(1), { target: { value: 'edited' } });
    await typePath('/Users/me/other');
    await waitFor(() => {
      expect(served.proposed).toEqual(['/Users/me/widgets', '/Users/me/widgets']);
    });
    await waitFor(() => {
      expect(names()).toEqual(['api', 'web', 'root']);
    });
  });
});

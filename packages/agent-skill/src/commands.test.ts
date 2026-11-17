import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCommand, TendbError, type CommandDeps } from './index';

const tid = (n: number): string => `tsk_${String(n).padStart(8, '0')}-0000-7000-8000-000000000000`;
const bid = (n: number): string => `bat_${String(n).padStart(8, '0')}-0000-7000-8000-000000000000`;

const project = {
  id: 'prj_1',
  name: 'Acme',
  repoPath: '/repo',
  areas: [
    { name: 'daemon', globs: ['apps/daemon/**'] },
    { name: 'docs', globs: ['docs/**'] },
  ],
  defaultRigor: 'standard',
  gateCommand: 'make gate',
  changedCheckCommand: null,
  precheckCommand: null,
  delivery: 'pull_request',
  baseBranch: 'main',
  landing: 'merge',
  landingBranch: null,
  prTitlePrefix: null,
  accountId: 'acc_1',
  fallbackAccountId: null,
  maxLanes: 2,
  workspaceMode: 'worktree',
  sandboxLoopback: false,
  sandboxDocker: false,
  hazards: [
    { name: 'lockfiles', globs: ['pnpm-lock.yaml'], commands: ['pnpm install'], scope: 'project' },
  ],
};
const kinds = [
  { key: 'docs', label: 'Docs', description: 'docs', minimumRigor: 'light' },
  { key: 'security', label: 'Security', description: 'sec', minimumRigor: 'careful' },
];
const openTask = {
  id: tid(1),
  title: 'Open one',
  status: 'open',
  boardStatus: 'ready',
  projectId: 'prj_1',
  dependsOn: [tid(2)],
  rigor: null,
  effectiveRigor: 'standard',
  kinds: [{ key: 'docs', source: 'builder' }],
};
const account = {
  id: 'acc_1',
  label: 'Main',
  kind: 'claude_plan',
  settings: { awsProfile: 'dev', region: 'us-east-1', modelMap: {} },
};

/** A route that fails with this HTTP status instead of answering. */
class Fails {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}
type Handler = unknown;
interface Call {
  method: string;
  path: string;
  body: unknown;
}

const baseRoutes: Record<string, Handler> = {
  'GET /projects': [project],
  'GET /kinds': kinds,
  'GET /accounts': [account],
  'GET /projects/prj_1/tasks': [openTask],
  'GET /agent-skill': { version: 'abc123', appCommit: 'c0ffee' },
};

function harness(routes: Record<string, Handler> = {}, files: Record<string, string> = {}) {
  const table = { ...baseRoutes, ...routes };
  const calls: Call[] = [];
  const lines: string[] = [];
  const gitCalls: string[][] = [];
  const deps: CommandDeps = {
    api: (method, path, body) => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (!(key in table))
        return Promise.reject(new TendbError(`${key} failed with 404: none`, 404));
      const handler = table[key];
      if (handler instanceof Fails) return Promise.reject(new TendbError('gone', handler.status));
      return Promise.resolve(handler);
    },
    out: (line) => lines.push(line),
    cwd: '/repo',
    git: (args) => {
      gitCalls.push([...args]);
      return args[0] === 'ls-files' ? 'pnpm-lock.yaml\0apps/daemon/a.ts\0' : '/repo/.git';
    },
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    realpath: (path) => path,
  };
  const run = (...argv: string[]) => runCommand(argv, deps);
  const posted = () => calls.filter((c) => c.method !== 'GET');
  return { run, calls, lines, posted, gitCalls };
}

const draft = {
  title: 'Keep the scrollbar off the columns',
  why: 'The scrollbar hides the last column on a narrow window.',
  acceptanceCriteria: ['The scrollbar stays inside the Board'],
  areas: ['daemon'],
};

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TendbError);
    return e instanceof Error ? e.message : '';
  }
  throw new Error('expected the command to throw');
}

describe('create', () => {
  const rows: { name: string; draft: unknown; contains: string }[] = [
    {
      name: 'a draft missing acceptanceCriteria',
      draft: { title: 'T', areas: ['daemon'] },
      contains: 'acceptanceCriteria',
    },
    {
      name: 'an unknown area names the area list',
      draft: { ...draft, areas: ['nope'] },
      contains: 'daemon, docs',
    },
    {
      name: 'a dependsOn id outside the project',
      draft: { ...draft, dependsOn: [tid(9)] },
      contains: `${tid(9)} isn't a task in this project`,
    },
    {
      name: 'an unknown field is refused by name',
      draft: { ...draft, dependOn: [] },
      contains: 'dependOn',
    },
    {
      name: 'an unknown kind names the kinds',
      draft: { ...draft, kinds: ['nope'] },
      contains: 'docs, security',
    },
    { name: 'a rigor that is not one', draft: { ...draft, rigor: 'extreme' }, contains: 'rigor' },
    { name: 'a title with a newline', draft: { ...draft, title: 'a\nb' }, contains: 'title' },
    {
      name: 'a draft with no why',
      draft: {
        title: draft.title,
        acceptanceCriteria: draft.acceptanceCriteria,
        areas: ['daemon'],
      },
      contains: 'why: say in one sentence why this task matters',
    },
    { name: 'a blank why', draft: { ...draft, why: '   ' }, contains: 'why: say in one sentence' },
  ];
  it.each(rows)('refuses $name and posts nothing', async ({ draft: d, contains }) => {
    const h = harness({}, { '/d.json': JSON.stringify(d) });
    const message = await messageOf(h.run('create', 'prj_1', '/d.json'));
    expect(message).toContain("The draft doesn't fit 10db's New Task rules");
    expect(message).toContain(contains);
    expect(h.posted()).toEqual([]);
  });

  it('prints DRY RUN and posts nothing', async () => {
    const h = harness({}, { '/d.json': JSON.stringify(draft) });
    await h.run('create', 'prj_1', '/d.json', '--dry-run');
    expect(h.lines[0]).toBe(
      'DRY RUN: valid for project Acme; would POST /projects/prj_1/tasks with:',
    );
    expect(h.posted()).toEqual([]);
  });

  it('posts kinds as builder-sourced objects and reports the task', async () => {
    const h = harness(
      { 'POST /projects/prj_1/tasks': { id: tid(3), title: draft.title, boardStatus: 'ready' } },
      { '/d.json': JSON.stringify({ ...draft, kinds: ['docs'] }) },
    );
    await h.run('create', 'prj_1', '/d.json');
    expect(h.posted()).toEqual([
      {
        method: 'POST',
        path: '/projects/prj_1/tasks',
        body: { ...draft, kinds: [{ key: 'docs', source: 'builder' }] },
      },
    ]);
    expect(h.lines).toEqual([`Created ${tid(3)} "${draft.title}" in Acme (ready).`]);
  });
});

describe('edit', () => {
  it('refuses an unknown field, an empty patch and a malformed id, posting nothing', async () => {
    const h = harness({}, { '/p.json': '{"dependOn":[]}', '/e.json': '{}' });
    expect(await messageOf(h.run('edit', tid(1), '/p.json'))).toContain('dependOn');
    expect(await messageOf(h.run('edit', tid(1), '/e.json'))).toContain(
      'The patch changes nothing',
    );
    expect(await messageOf(h.run('edit', 'nope', '/p.json'))).toContain("isn't a task id");
    expect(h.posted()).toEqual([]);
  });

  it('patches with kind objects', async () => {
    const h = harness(
      { [`PATCH /tasks/${tid(1)}`]: { id: tid(1), title: 'T', boardStatus: 'ready' } },
      { '/p.json': '{"kinds":["docs"],"title":"T"}' },
    );
    await h.run('edit', tid(1), '/p.json');
    expect(h.posted()).toEqual([
      {
        method: 'PATCH',
        path: `/tasks/${tid(1)}`,
        body: { kinds: [{ key: 'docs', source: 'builder' }], title: 'T' },
      },
    ]);
    expect(h.lines).toEqual([`Updated ${tid(1)} "T" (ready).`]);
  });
});

describe('context and project', () => {
  it('context prints the open tasks with their sizing and the versions', async () => {
    const h = harness();
    await h.run('context');
    const out = z.record(z.string(), z.unknown()).parse(JSON.parse(h.lines.join('\n')));
    expect(out).toMatchObject({
      cwd: '/repo',
      matched: 1,
      skillVersion: 'abc123',
      appVersion: 'c0ffee',
      projects: [
        {
          id: 'prj_1',
          openTasks: [
            {
              id: tid(1),
              dependsOn: [tid(2)],
              rigor: null,
              effectiveRigor: 'standard',
              kinds: ['docs'],
            },
          ],
        },
      ],
    });
  });

  it('context against an older daemon with no /agent-skill prints null versions', async () => {
    const h = harness({ 'GET /agent-skill': new Fails(404) });
    await h.run('context');
    expect(JSON.parse(h.lines.join('\n'))).toMatchObject({ skillVersion: null, appVersion: null });
  });

  const rows: {
    name: string;
    patch: Record<string, unknown>;
    expected: Record<string, unknown>;
    note: boolean;
  }[] = [
    {
      name: 'pull request delivery',
      patch: {},
      expected: {
        delivery: { mode: 'pull_request', label: 'Open a pull request' },
        landing: { label: 'Merge into main' },
      },
      note: false,
    },
    {
      name: 'local delivery',
      patch: { delivery: 'local', landing: 'hold' },
      expected: {
        delivery: { label: 'Commit directly' },
        landing: { label: 'Hold for my review' },
      },
      note: true,
    },
  ];
  it.each(rows)('project resolves by name with $name', async ({ patch, expected, note }) => {
    const h = harness({ 'GET /projects': [{ ...project, ...patch }] });
    await h.run('project', 'Acme');
    const out = z.record(z.string(), z.unknown()).parse(JSON.parse(h.lines.join('\n')));
    expect(out).toMatchObject({
      ...expected,
      account: { id: 'acc_1', label: 'Main', kind: 'claude_plan' },
      skillVersion: 'abc123',
    });
    expect('note' in out).toBe(note);
  });

  it('project resolves by id and lists the projects when none matches', async () => {
    const h = harness();
    await h.run('project', 'prj_1');
    expect(JSON.parse(h.lines.join('\n'))).toMatchObject({ id: 'prj_1' });
    expect(await messageOf(h.run('project', 'zzz'))).toBe('No project zzz. Projects: Acme (prj_1)');
  });
});

describe('hazards', () => {
  const additions = (list: unknown[]): Record<string, string> => ({
    '/a.json': JSON.stringify(list),
  });

  it('prints the list with no additions file', async () => {
    const h = harness();
    await h.run('hazards', 'prj_1');
    expect(JSON.parse(h.lines.join('\n'))).toEqual(project.hazards);
  });

  it('never sends a list shorter than it read, and counts what a glob covers', async () => {
    const h = harness(
      { 'PATCH /projects/prj_1': { hazards: [1, 2] } },
      additions([{ name: 'migrations', globs: ['apps/**'], commands: ['make migration'] }]),
    );
    await h.run('hazards', 'prj_1', '/a.json');
    const body = z
      .object({ hazards: z.array(z.object({ name: z.string() })) })
      .parse(h.posted()[0]?.body);
    expect(body.hazards.map((x) => x.name)).toEqual(['lockfiles', 'migrations']);
    expect(h.lines[0]).toContain('+ hazard migrations (scope project)');
    expect(h.lines.join('\n')).toContain('(1 tracked files)');
    expect(h.lines.at(-1)).toBe('Saved. Acme now has 2 hazards.');
  });

  const refusals: { name: string; list: unknown[]; message: string }[] = [
    {
      name: 'a scope change',
      list: [{ name: 'lockfiles', scope: 'copy' }],
      message: 'never changes a scope',
    },
    {
      name: 'a new hazard with no glob',
      list: [{ name: 'fresh' }],
      message: 'needs at least one glob',
    },
    {
      name: 'an unknown field',
      list: [{ name: 'lockfiles', glob: 'x' }],
      message: 'Unknown hazard fields: glob',
    },
    { name: 'an empty list', list: [], message: 'non-empty JSON list' },
  ];
  it.each(refusals)('refuses $name and posts nothing', async ({ list, message }) => {
    const h = harness({}, additions(list));
    expect(await messageOf(h.run('hazards', 'prj_1', '/a.json'))).toContain(message);
    expect(h.posted()).toEqual([]);
  });

  it('says nothing is left to add and posts nothing', async () => {
    const h = harness({}, additions([{ name: 'lockfiles', globs: ['pnpm-lock.yaml'] }]));
    await h.run('hazards', 'prj_1', '/a.json');
    expect(h.lines).toEqual(["Nothing to add: Acme's hazards already hold every entry."]);
    expect(h.posted()).toEqual([]);
  });
});

describe('every other command sends what it should', () => {
  const t = tid(1);
  const b = bid(1);
  const rows: {
    name: string;
    argv: string[];
    routes?: Record<string, Handler>;
    files?: Record<string, string>;
    sent: Call | null;
    out: string;
  }[] = [
    {
      name: 'remove',
      argv: ['remove', t],
      routes: { [`POST /tasks/${t}/remove`]: { id: t, title: 'T' } },
      sent: { method: 'POST', path: `/tasks/${t}/remove`, body: undefined },
      out: `Removed ${t} "T".`,
    },
    {
      name: 'start (a workstream)',
      argv: ['start', t],
      routes: { [`POST /tasks/${t}/start`]: { id: 'wks_1' } },
      sent: { method: 'POST', path: `/tasks/${t}/start`, body: undefined },
      out: `Started ${t} as workstream wks_1. A refusal after this shows on the Board and in the Inbox.`,
    },
    {
      name: 'start (a batch)',
      argv: ['start', t],
      routes: { [`POST /tasks/${t}/start`]: { id: b } },
      sent: { method: 'POST', path: `/tasks/${t}/start`, body: undefined },
      out: `Started ${t} as batch ${b}. A refusal after this shows on the Board and in the Inbox.`,
    },
    {
      name: 'move to a column',
      argv: ['move', t, 'Parked'],
      routes: {
        'GET /projects/prj_1/board-columns': [{ id: 'col_1', name: 'Parked' }],
        [`POST /tasks/${t}/move`]: { id: t, title: 'T' },
      },
      sent: {
        method: 'POST',
        path: `/tasks/${t}/move`,
        body: { to: 'col_1', after: null, before: null },
      },
      out: `Moved ${t} "T" to Parked.`,
    },
    {
      name: 'move back to state',
      argv: ['move', t, 'state'],
      routes: { [`POST /tasks/${t}/move`]: { id: t, title: 'T' } },
      sent: {
        method: 'POST',
        path: `/tasks/${t}/move`,
        body: { to: null, after: null, before: null },
      },
      out: `Moved ${t} "T" to its state column.`,
    },
    {
      name: 'close',
      argv: ['close', t],
      routes: { [`POST /tasks/${t}/close`]: { id: t, title: 'T', status: 'closed' } },
      sent: { method: 'POST', path: `/tasks/${t}/close`, body: undefined },
      out: `Closed ${t} "T" (closed).`,
    },
    {
      name: 'hold',
      argv: ['hold', t],
      routes: { [`POST /tasks/${t}/hold`]: { state: 'QUEUED' } },
      sent: { method: 'POST', path: `/tasks/${t}/hold`, body: undefined },
      out: `Held ${t} (QUEUED).`,
    },
    {
      name: 'next',
      argv: ['next', t],
      routes: { [`POST /tasks/${t}/run-next`]: { waitingOn: ['x'] } },
      sent: { method: 'POST', path: `/tasks/${t}/run-next`, body: undefined },
      out: `Put ${t} first in line. It waits on 1 unfinished task(s) first.`,
    },
    {
      name: 'join',
      argv: ['join', t, b],
      routes: { 'POST /projects/prj_1/batches': [{ id: b, state: 'OPEN' }] },
      sent: {
        method: 'POST',
        path: '/projects/prj_1/batches',
        body: { title: 'Open one', taskIds: [t], batchId: b },
      },
      out: `Started ${t} in ${b} (OPEN).`,
    },
    {
      name: 'ship',
      argv: ['ship', b],
      routes: { [`POST /batches/${b}/ship`]: { id: b, title: 'B', state: 'SHIPPING' } },
      sent: { method: 'POST', path: `/batches/${b}/ship`, body: undefined },
      out: `Shipping ${b} "B" (SHIPPING).`,
    },
    {
      name: 'abandon',
      argv: ['abandon', b],
      routes: { [`POST /batches/${b}/abandon`]: { id: b, title: 'B', state: 'ABANDONED' } },
      sent: { method: 'POST', path: `/batches/${b}/abandon`, body: undefined },
      out: `Abandoned ${b} "B" (ABANDONED).`,
    },
    {
      name: 'answer with a note',
      argv: ['answer', 'inb_1', 'merge', 'looks', 'fine'],
      routes: { 'POST /inbox/inb_1/answer': { id: 'inb_1', title: 'Card' } },
      sent: {
        method: 'POST',
        path: '/inbox/inb_1/answer',
        body: { choice: 'merge', note: 'looks fine' },
      },
      out: 'Answered inb_1 "Card" with merge.',
    },
    {
      name: 'inbox',
      argv: ['inbox'],
      routes: {
        'GET /inbox?state=OPEN': [
          {
            id: 'inb_1',
            kind: 'ship',
            title: 'Card',
            options: [{ label: 'Merge' }, { label: 'Hold' }],
          },
        ],
      },
      sent: null,
      out: 'inb_1\tship\tCard\tMerge | Hold',
    },
    {
      name: 'principle',
      argv: ['principle', 'prj_1', '/p.json', '--dry-run'],
      routes: { 'POST /projects/prj_1/principles': { ok: true } },
      files: { '/p.json': '{"text":"x"}' },
      sent: {
        method: 'POST',
        path: '/projects/prj_1/principles',
        body: { text: 'x', dryRun: true },
      },
      out: '{\n  "ok": true\n}',
    },
    {
      name: 'goal',
      argv: ['goal', 'prj_1', '/g.md'],
      routes: { 'POST /projects/prj_1/goals/adopt': { id: 'gol_1', title: 'G' } },
      files: { '/g.md': 'brief' },
      sent: {
        method: 'POST',
        path: '/projects/prj_1/goals/adopt',
        body: { text: 'brief', dryRun: false },
      },
      out: 'Adopted goal gol_1 "G" in Acme.\n{\n  "id": "gol_1",\n  "title": "G"\n}',
    },
    {
      name: 'plan-import',
      argv: ['plan-import', 'prj_1', '/b.json'],
      routes: { 'POST /projects/prj_1/plans/import': { created: true, shapeId: 'shp_1' } },
      sent: {
        method: 'POST',
        path: '/projects/prj_1/plans/import',
        body: { bundlePath: '/b.json', dryRun: false },
      },
      out: 'Imported a new Plan shp_1 into Acme.\n{\n  "created": true,\n  "shapeId": "shp_1"\n}',
    },
    {
      name: 'resave-account',
      argv: ['resave-account', 'Main'],
      routes: { 'PATCH /accounts/acc_1': {} },
      sent: { method: 'PATCH', path: '/accounts/acc_1', body: { label: 'Main' } },
      out: 'Saved acc_1 "Main" unchanged.',
    },
    {
      name: 'account-settings keeps awsProfile and region through a modelMap patch',
      argv: ['account-settings', '/s.json', 'Main'],
      routes: { 'PATCH /accounts/acc_1': {} },
      files: { '/s.json': '{"modelMap":{"opus":"x"}}' },
      sent: {
        method: 'PATCH',
        path: '/accounts/acc_1',
        body: { settings: { awsProfile: 'dev', region: 'us-east-1', modelMap: { opus: 'x' } } },
      },
      out: 'Saved acc_1 "Main" settings: {"awsProfile":"dev","region":"us-east-1","modelMap":{"opus":"x"}}',
    },
  ];
  it.each(rows)('$name', async ({ argv, routes, files, sent, out }) => {
    const h = harness({ 'GET /projects/prj_1/tasks': [openTask], ...routes }, files);
    await h.run(...argv);
    expect(h.posted()[0] ?? null).toEqual(sent);
    expect(h.lines.join('\n')).toBe(out);
  });

  it('areas reports each path and (no area)', async () => {
    const h = harness();
    await h.run('areas', 'prj_1', 'apps/daemon/x.ts', 'README.md');
    expect(h.lines).toEqual(['apps/daemon/x.ts\tdaemon', 'README.md\t(no area)']);
  });

  it('account-settings refuses a key that is not modelMap, awsProfile or region', async () => {
    const h = harness({}, { '/s.json': '{"apiKey":"x"}' });
    expect(await messageOf(h.run('account-settings', '/s.json', 'Main'))).toBe(
      'Only modelMap, awsProfile, region can change here, not apiKey.',
    );
    expect(h.posted()).toEqual([]);
  });
});

describe('an unknown command', () => {
  it.each([['nope'], []])('throws a TendbError with the usage line for %j', async (...argv) => {
    const h = harness();
    expect(await messageOf(h.run(...argv))).toMatch(/^usage: node tendb\.mjs context\|project\|/);
  });
});

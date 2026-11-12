import { describe, expect, it } from 'vitest';
import {
  AppUrl,
  isDaemonAddress,
  DEFAULT_HAZARDS,
  EvidenceDto,
  FollowUpInput,
  HandoffInput,
  hazardScope,
  HazardScope,
  McpToolInputs,
  mintId,
  NextAction,
  PassCheckDetail,
  PassTurnId,
  PassViewDto,
  passHeldAreas,
  passPagesProblem,
  ProjectInput,
  ProjectPatch,
  STOCK_HAZARD_REVISIONS,
  TaskId,
  WorkstreamId,
} from './index';

describe('ids', () => {
  const UUID_V7 = /^tsk_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('mints a prefixed UUIDv7 that parses back', () => {
    const id = mintId('Task');
    expect(id).toMatch(UUID_V7);
    expect(TaskId.parse(id)).toBe(id);
  });

  it('mints IDs that sort in creation order within one millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => mintId('Task'));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['wrong prefix', 'ws_0199f1c2-7a3b-7c4d-8e5f-0123456789ab'],
    ['a ULID', 'tsk_01JA2B3C4D5E6F7G8H9J0K1M2N'],
    ['a UUIDv4', 'tsk_0199f1c2-7a3b-4c4d-8e5f-0123456789ab'],
    ['upper case', 'tsk_0199F1C2-7A3B-7C4D-8E5F-0123456789AB'],
    ['a bad variant', 'tsk_0199f1c2-7a3b-7c4d-ce5f-0123456789ab'],
    ['no prefix', '0199f1c2-7a3b-7c4d-8e5f-0123456789ab'],
  ])('rejects %s', (_name, value) => {
    expect(TaskId.safeParse(value).success).toBe(false);
  });

  it('rejects an ID minted for another kind', () => {
    expect(WorkstreamId.safeParse(mintId('Task')).success).toBe(false);
  });
});

describe('a project with no gate command', () => {
  const base = {
    name: 'demo',
    repoPath: '/tmp/demo',
    areas: [{ name: 'src', globs: ['src/**'] }],
  };

  it('ProjectInput accepts no gate command and defaults it to null', () => {
    expect(ProjectInput.parse(base).gateCommand).toBeNull();
    expect(ProjectInput.parse({ ...base, gateCommand: null }).gateCommand).toBeNull();
    expect(ProjectInput.safeParse({ ...base, gateCommand: '' }).success).toBe(false);
  });

  it('ProjectPatch can clear the gate command', () => {
    expect(ProjectPatch.parse({ gateCommand: null })).toEqual({ gateCommand: null });
    expect(ProjectPatch.safeParse({ gateCommand: '' }).success).toBe(false);
  });
});

describe('a project with a changed-packages check command', () => {
  const base = {
    name: 'demo',
    repoPath: '/tmp/demo',
    gateCommand: 'make gate',
    areas: [{ name: 'src', globs: ['src/**'] }],
  };

  it('ProjectInput defaults it to null and rejects an empty one', () => {
    expect(ProjectInput.parse(base).changedCheckCommand).toBeNull();
    expect(
      ProjectInput.parse({ ...base, changedCheckCommand: 'make check-changed' })
        .changedCheckCommand,
    ).toBe('make check-changed');
    expect(ProjectInput.safeParse({ ...base, changedCheckCommand: '' }).success).toBe(false);
  });

  it('ProjectPatch can set and clear it', () => {
    expect(ProjectPatch.parse({ changedCheckCommand: 'make check-changed' })).toEqual({
      changedCheckCommand: 'make check-changed',
    });
    expect(ProjectPatch.parse({ changedCheckCommand: null })).toEqual({
      changedCheckCommand: null,
    });
    expect(ProjectPatch.safeParse({ changedCheckCommand: '' }).success).toBe(false);
  });
});

describe('EvidenceDto', () => {
  const common = {
    id: mintId('Evidence'),
    workstreamId: mintId('Workstream'),
    summary: 'note',
    logPath: null,
    commitShas: [],
    createdAt: '2026-10-28T12:00:00.000Z',
  };

  it.each([
    [
      'gate with a command and exit code',
      { kind: 'gate', command: 'make gate', exitCode: 0 },
      true,
    ],
    ['agent with a command and exit code', { kind: 'agent', command: 'x', exitCode: 1 }, true],
    ['builder with neither', { kind: 'builder', command: null, exitCode: null }, true],
    [
      'agent without a command or exit code',
      { kind: 'agent', command: null, exitCode: null },
      false,
    ],
    ['gate without a command', { kind: 'gate', command: null, exitCode: null }, false],
    ['gate without an exit code', { kind: 'gate', command: 'make gate', exitCode: null }, false],
    ['builder with a command', { kind: 'builder', command: 'x', exitCode: 0 }, false],
  ])('%s', (_name, fields, ok) => {
    expect(EvidenceDto.safeParse({ ...common, ...fields }).success).toBe(ok);
  });
});

describe('stock hazard revisions', () => {
  // The stock commands of the first release, which every stored list started from.
  const FIRST: Record<string, string[]> = {
    migrations: ['drizzle-kit generate', 'pnpm db:migrate'],
    deps: [
      'pnpm add',
      'pnpm remove',
      'pnpm rm',
      'pnpm install',
      'pnpm i',
      'pnpm update',
      'pnpm up',
      'npm install',
      'npm i',
      'npm uninstall',
      'cargo add',
      'cargo remove',
    ],
    harness: [],
  };

  // The stock globs of the first release.
  const FIRST_GLOBS: Record<string, string[]> = {
    migrations: ['**/migrations/**', '**/drizzle/**'],
    deps: ['**/package.json', 'pnpm-lock.yaml', '**/Cargo.toml', '**/Cargo.lock'],
    harness: ['AGENTS.md', '**/AGENTS.md', '.claude/**', '.codex/**'],
  };

  it('add up, with the first release, to exactly the stock commands of each hazard', () => {
    for (const hazard of DEFAULT_HAZARDS) {
      const added = STOCK_HAZARD_REVISIONS.flatMap((r) => r.commands?.[hazard.name] ?? []);
      expect(new Set(added).size, hazard.name).toBe(added.length);
      expect([...(FIRST[hazard.name] ?? []), ...added].sort(), hazard.name).toEqual(
        [...hazard.commands].sort(),
      );
    }
  });

  it('add up, with the first release, to exactly the stock globs of each hazard', () => {
    for (const hazard of DEFAULT_HAZARDS) {
      const added = STOCK_HAZARD_REVISIONS.flatMap((r) => r.globs?.[hazard.name] ?? []);
      expect(new Set(added).size, hazard.name).toBe(added.length);
      expect([...(FIRST_GLOBS[hazard.name] ?? []), ...added].sort(), hazard.name).toEqual(
        [...hazard.globs].sort(),
      );
    }
  });

  it('name only stock hazards', () => {
    const names = new Set(DEFAULT_HAZARDS.map((h) => h.name));
    for (const revision of STOCK_HAZARD_REVISIONS)
      for (const name of [
        ...Object.keys(revision.commands ?? {}),
        ...Object.keys(revision.globs ?? {}),
      ])
        expect(names).toContain(name);
  });
});

describe('hazard scope', () => {
  it('makes AGENTS.md and the lockfile per copy and migrations per project by default', () => {
    expect(Object.fromEntries(DEFAULT_HAZARDS.map((h) => [h.name, hazardScope(h)]))).toEqual({
      migrations: HazardScope.Project,
      deps: HazardScope.Copy,
      harness: HazardScope.Copy,
    });
  });

  it('reads a stored hazard with no scope by its name, and a custom one as per project', () => {
    const bare = { globs: ['x'], commands: [] };
    expect(hazardScope({ name: 'harness', ...bare })).toBe(HazardScope.Copy);
    expect(hazardScope({ name: 'docker', ...bare })).toBe(HazardScope.Project);
    expect(hazardScope({ name: 'harness', scope: HazardScope.Project, ...bare })).toBe(
      HazardScope.Project,
    );
  });

  it('accepts a scope in a patch and refuses an unknown one', () => {
    const hazard = { name: 'h', globs: ['a'], commands: [] };
    expect(ProjectPatch.safeParse({ hazards: [{ ...hazard, scope: 'copy' }] }).success).toBe(true);
    expect(ProjectPatch.safeParse({ hazards: [{ ...hazard, scope: 'machine' }] }).success).toBe(
      false,
    );
  });
});

describe('ProjectInput', () => {
  it('fills the starting-heuristic defaults', () => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    expect(parsed).toMatchObject({
      maxLanes: 2,
      handoffPct: 40,
      nudgePct: 50,
      humanWaitMinutes: 10,
      fallbackAccountId: null,
      usageHandoffAt: 0.95,
    });
    expect(parsed.hazards.map((h) => h.name)).toEqual(['migrations', 'deps', 'harness']);
    expect(parsed.allowedCommands).toEqual([]);
  });

  it('accepts pull request delivery with no title prefix', () => {
    const parsed = ProjectInput.safeParse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      delivery: 'pull_request',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.prTitlePrefix).toBeNull();
  });

  it('drops the project-level model and effort', () => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      model: 'opus',
      effort: 'high',
    });
    expect(parsed).not.toHaveProperty('model');
    expect(parsed).not.toHaveProperty('effort');
  });

  it('takes the extra allowed commands and rejects one that is not a plain prefix', () => {
    const base = {
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
    };
    expect(ProjectInput.parse({ ...base, allowedCommands: ['pnpm test'] }).allowedCommands).toEqual(
      ['pnpm test'],
    );
    expect(ProjectInput.safeParse({ ...base, allowedCommands: ['pnpm --run'] }).success).toBe(
      false,
    );
  });

  it.each([
    ['absent', {}, false],
    ['on', { sandboxLoopback: true }, true],
  ])('reads the localhost switch when it is %s', (_name, given, expected) => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      ...given,
    });
    expect(parsed.sandboxLoopback).toBe(expected);
  });

  it('patches the localhost switch and rejects a non-boolean one', () => {
    expect(ProjectPatch.parse({ sandboxLoopback: true })).toEqual({ sandboxLoopback: true });
    expect(ProjectPatch.safeParse({ sandboxLoopback: 'on' }).success).toBe(false);
  });

  it.each([
    ['absent', {}, false],
    ['on', { sandboxDocker: true }, true],
  ])('reads the Docker switch when it is %s', (_name, given, expected) => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      ...given,
    });
    expect(parsed.sandboxDocker).toBe(expected);
  });

  it('patches the Docker switch and rejects a non-boolean one', () => {
    expect(ProjectPatch.parse({ sandboxDocker: false })).toEqual({ sandboxDocker: false });
    expect(ProjectPatch.safeParse({ sandboxDocker: 'on' }).success).toBe(false);
  });

  it('rejects a nudge threshold at or below the handoff threshold', () => {
    const result = ProjectInput.safeParse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      handoffPct: 80,
      nudgePct: 80,
    });
    expect(result.success).toBe(false);
  });
});

describe('NextAction', () => {
  it.each([
    [{ kind: 'start' }],
    [{ kind: 'verify' }],
    [{ kind: 'resume', providerSessionId: 'abc', reason: 'daemon restarted' }],
    [{ kind: 'uncommitted', paths: ['src/api/a.ts'] }],
    [{ kind: 'merge', base: 'origin/main', paths: ['src/api/a.ts'] }],
    [{ kind: 'pass_review', inboxId: mintId('InboxItem') }],
  ])('accepts %j', (value) => {
    expect(NextAction.parse(value)).toEqual(value);
  });
});

describe('MCP tool inputs', () => {
  it('requires two to four options on ask_human', () => {
    const base = { opId: 'op-00000001', category: 'design', question: 'Which?' };
    expect(
      McpToolInputs.ask_human.safeParse({ ...base, options: [{ label: 'A', description: 'a' }] })
        .success,
    ).toBe(false);
    expect(
      McpToolInputs.ask_human.safeParse({
        ...base,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      }).success,
    ).toBe(true);
  });

  it('words the file_follow_up fields for an implementer filing a remaining section, not a reviewer finding', () => {
    const { description, title, acceptanceCriteria } = McpToolInputs.file_follow_up.shape;
    expect(description.description).toMatch(/left to do/i);
    expect(description.description).not.toMatch(/what you saw/i);
    expect(title.description).toBeDefined();
    expect(acceptanceCriteria.description).toBeDefined();
    expect(FollowUpInput.shape.description.description).toMatch(/what you saw/i);
  });

  it('takes one to four routes on report_pages, each judged by the tool', () => {
    const call = (routes: string[]) =>
      McpToolInputs.report_pages.safeParse({ opId: 'op-00000001', routes }).success;
    expect(call([])).toBe(false);
    expect(call(['/a', '/b', '/c', '/d'])).toBe(true);
    expect(call(['/a', '/b', '/c', '/d', '/e'])).toBe(false);
    expect(call(['http://elsewhere.test/'])).toBe(true);
  });

  it('requires a next action in the handoff', () => {
    const handoff = {
      objective: { task: 't', acceptanceCriteria: ['a'], nonGoals: [] },
      progress: { done: [], notDone: [], nextAction: '' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    expect(HandoffInput.safeParse(handoff).success).toBe(false);
  });
});

describe('the pages of a pass', () => {
  const areas = [
    { name: 'people', globs: ['app/people/**'], role: 'page' as const, route: '/people' },
    { name: 'settings', globs: ['app/settings/**'], role: 'page' as const },
    { name: 'wide', globs: ['app/**/*.tsx'], role: 'page' as const },
    { name: 'src', globs: ['app/**'], role: 'shared' as const },
    { name: 'api', globs: ['api/**'] },
    { name: 'api-users', globs: ['api/users/**'] },
    { name: 'people-legacy', globs: ['app/people/legacy/**'] },
  ];
  it.each<{ name: string; tasks: { title: string; areas: string[] }[]; problem: string | null }>([
    {
      name: 'two tasks on two pages',
      tasks: [
        { title: 'People', areas: ['people'] },
        { title: 'Settings', areas: ['settings', 'src'] },
      ],
      problem: null,
    },
    {
      name: 'a task naming no page area',
      tasks: [{ title: 'Shared only', areas: ['src', 'api'] }],
      problem: 'Shared only names no page area',
    },
    {
      name: 'two tasks on the same page',
      tasks: [
        { title: 'People', areas: ['people'] },
        { title: 'People again', areas: ['people'] },
      ],
      problem: '"People" and "People again" both hold people',
    },
    {
      name: 'two tasks on the same area with no role, which a pass holds as a page',
      tasks: [
        { title: 'People', areas: ['people', 'api'] },
        { title: 'Settings', areas: ['settings', 'api'] },
      ],
      problem: '"People" and "Settings" both hold api',
    },
    {
      name: 'two tasks on pages whose globs can share a file',
      tasks: [
        { title: 'People', areas: ['people'] },
        { title: 'Everything', areas: ['wide'] },
      ],
      problem: 'app/people/** and app/**/*.tsx',
    },
    {
      name: 'two tasks on areas with no role whose globs can share a file, both held for life',
      tasks: [
        { title: 'People', areas: ['people', 'api'] },
        { title: 'Settings', areas: ['settings', 'api-users'] },
      ],
      problem: 'api/** and api/users/**',
    },
    {
      name: "a page and another task's area with no role that can share a file",
      tasks: [
        { title: 'People', areas: ['people'] },
        { title: 'Settings', areas: ['settings', 'people-legacy'] },
      ],
      problem: 'app/people/** and app/people/legacy/**',
    },
    {
      name: 'two tasks on one shared area: held a turn at a time, never at open',
      tasks: [
        { title: 'People', areas: ['people', 'src'] },
        { title: 'Settings', areas: ['settings', 'src'] },
      ],
      problem: null,
    },
  ])('$name', ({ tasks, problem }) => {
    const found = passPagesProblem(areas, tasks);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
  });

  it('holds a page and an area with no role at open, and never a shared area or a hazard', () => {
    expect(passHeldAreas(areas, { areas: ['people', 'src', 'api', 'deps'] })).toEqual([
      'people',
      'api',
    ]);
  });
});

describe("a pass's turns and view", () => {
  it('mints a turn id that parses back and no other kind', () => {
    const id = mintId('PassTurn');
    expect(id).toMatch(/^ptn_/);
    expect(PassTurnId.parse(id)).toBe(id);
    expect(PassTurnId.safeParse(mintId('Task')).success).toBe(false);
  });

  it("reads a Ready page's check detail, with no kept commit while the task never changed a page file", () => {
    const detail = {
      passId: mintId('Pass'),
      taskId: mintId('Task'),
      workstreamId: mintId('Workstream'),
      turnId: mintId('PassTurn'),
      keptSha: null,
      keptBaseSha: 'a'.repeat(40),
      turnFiles: [],
      pageFiles: [{ path: 'src/settings/page.tsx', added: 4, removed: 1 }],
    };
    expect(PassCheckDetail.parse(detail)).toEqual(detail);
    expect(PassCheckDetail.safeParse({ ...detail, turnId: mintId('Task') }).success).toBe(false);
  });

  it('reads a view whose page has no run yet and whose sign-off is none', () => {
    const at = '2026-11-09T12:00:00.000Z';
    const view = {
      pass: {
        id: mintId('Pass'),
        projectId: mintId('Project'),
        name: 'Polish',
        state: 'OPEN',
        batchId: mintId('Batch'),
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        openedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      pages: [
        {
          taskId: mintId('Task'),
          title: 'Settings',
          area: 'settings',
          route: null,
          workstreamId: null,
          state: null,
          nextActionKind: null,
          spokenTo: false,
          turn: null,
          pausedUntil: null,
          failure: null,
          signOff: 'none',
          waitsFor: null,
          preview: null,
        },
      ],
      preview: null,
      turns: [],
      holds: [],
      sharedChanges: [],
      signOffWaits: [],
      pullRequest: null,
      checks: { gate: { state: 'not_run', logPath: null }, review: { reviewedSha: null } },
      closeStep: null,
      stackedOn: null,
      notices: [],
    };
    expect(PassViewDto.parse(view)).toEqual(view);
    expect(
      PassViewDto.safeParse({ ...view, pages: [{ ...view.pages[0], nextActionKind: 'nap' }] })
        .success,
    ).toBe(false);
  });

  it("reads a closing pass's view: a page waiting on another's hold, the chain, its pull request and notices", () => {
    const at = '2026-11-09T12:00:00.000Z';
    const passId = mintId('Pass');
    const people = mintId('Task');
    const claimId = mintId('Claim');
    const page = {
      taskId: mintId('Task'),
      title: 'Settings',
      area: 'settings',
      route: '/settings',
      workstreamId: null,
      state: null,
      nextActionKind: null,
      spokenTo: true,
      turn: null,
      pausedUntil: null,
      failure: null,
      signOff: 'waiting',
      waitsFor: { taskId: people, title: 'People' },
      preview: null,
    };
    const view = {
      pass: {
        id: passId,
        projectId: mintId('Project'),
        name: 'Polish',
        state: 'CLOSING',
        batchId: mintId('Batch'),
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        openedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      pages: [page],
      preview: null,
      turns: [],
      holds: [
        {
          claimId,
          passId,
          taskId: people,
          workstreamId: mintId('Workstream'),
          area: 'src',
          seq: 2,
          recordSha: 'b'.repeat(40),
          grantedAt: at,
          closedAt: null,
          empty: false,
        },
      ],
      sharedChanges: [
        {
          passId,
          seq: 1,
          taskId: page.taskId,
          sha: 'c'.repeat(40),
          paths: ['src/Button.tsx', 'src/old.ts'],
          blobs: { 'src/Button.tsx': 'd'.repeat(40), 'src/old.ts': null },
          dirtyKept: true,
          landedSha: null,
          droppedBy: null,
          dropOf: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
      signOffWaits: [
        { taskId: page.taskId, passId, waitsFor: claimId, waitsForTaskId: people, askedAt: at },
      ],
      pullRequest: {
        url: 'https://github.com/acme/widgets/pull/8',
        draft: true,
        state: 'open',
        failingChecks: [{ name: 'build', url: null }],
      },
      checks: {
        gate: { state: 'failed', logPath: '/tmp/gate.log' },
        review: { reviewedSha: 'e'.repeat(40) },
      },
      closeStep: 3,
      stackedOn: mintId('Pass'),
      notices: [
        { id: 'checks', kind: 'checks', text: 'build fails', sendable: true, cardId: null, at },
      ],
    };
    expect(PassViewDto.parse(view)).toEqual(view);
    expect(PassViewDto.safeParse({ ...view, closeStep: 9 }).success).toBe(false);
    expect(
      PassViewDto.safeParse({ ...view, pages: [{ ...page, signOff: 'signed' }] }).success,
    ).toBe(false);
    expect(PassViewDto.safeParse({ ...view, holds: [{ ...view.holds[0], seq: 0 }] }).success).toBe(
      false,
    );
  });
});

describe("a project's app address", () => {
  it.each([
    ['http://localhost:8800', true],
    ['http://localhost', true],
    ['https://127.0.0.1:3000', true],
    ['http://[::1]:5173', true],
    ['http://ampsio.localhost:8800', true],
    ['http://example.com', false],
    ['http://localhost.example.com:8800', false],
    ['http://10.0.0.1:8800', false],
    ['ftp://localhost:21', false],
    ['http://localhost:8800/people', false],
    ['http://localhost:8800/', false],
    ['http://me@localhost:8800', false],
    ['http://LOCALHOST:8800', false],
    ['localhost:8800', false],
  ])('%s is a loopback origin: %s', (url, ok) => {
    expect(AppUrl.safeParse(url).success).toBe(ok);
  });

  it.each([
    ['http://localhost:4317', 4317, true],
    ['http://127.0.0.1:4317', 4317, true],
    ['http://[::1]:4317', 4317, true],
    ['http://ampsio.localhost:4317', 4317, true],
    ['http://localhost:8800', 4317, false],
    ['http://localhost', 80, true],
    ['https://localhost', 443, true],
    ['http://localhost', 443, false],
  ])("%s on a daemon listening on %i is the daemon's own: %s", (url, port, own) => {
    expect(isDaemonAddress(AppUrl.parse(url), port)).toBe(own);
  });
});

describe("an area's role and route", () => {
  const project = { name: 'demo', repoPath: '/tmp/demo', gateCommand: 'make gate' };
  const people = { name: 'people', globs: ['app/people/**'], role: 'page', route: '/people' };
  const settings = { name: 'settings', globs: ['app/settings/**'], role: 'page' };
  const src = { name: 'src', globs: ['app/**'], role: 'shared' };
  const issues = (areas: unknown[]) => {
    const created = ProjectInput.safeParse({ ...project, areas });
    const patched = ProjectPatch.safeParse({ areas });
    return [created, patched].map((r) => r.error?.issues.map((i) => i.message).join('; ') ?? '');
  };

  it('is optional: an area without one parses as before, with neither field', () => {
    const plain = { name: 'api', globs: ['api/**'] };
    const parsed = ProjectInput.parse({ ...project, areas: [plain] }).areas[0];
    expect(parsed).toEqual(plain);
    expect(parsed).not.toHaveProperty('role');
    expect(parsed).not.toHaveProperty('route');
  });

  it('is kept when a project is made or patched with one', () => {
    const areas = [people, settings, src];
    expect(ProjectInput.parse({ ...project, areas }).areas).toEqual(areas);
    expect(ProjectPatch.parse({ areas }).areas).toEqual(areas);
  });

  it.each([
    [
      'two pages that can share a file',
      [people, { ...settings, globs: ['app/**/*.tsx'] }],
      'people',
    ],
    ['a route on a shared area', [{ ...src, route: '/' }], 'Only a page has a route'],
    [
      'a route on an area with no role',
      [{ name: 'api', globs: ['api/**'], route: '/api' }],
      'Only a page',
    ],
    ['a route that is not a path', [{ ...people, route: 'people' }], '/'],
    ['a role that is neither', [{ ...people, role: 'screen' }], ''],
  ])('refuses %s, on create and on patch', (_name, areas, message) => {
    for (const problem of issues(areas)) {
      expect(problem).not.toBe('');
      expect(problem).toContain(message);
    }
  });

  it.each([
    ['a page and a shared area over its files', [people, src]],
    ['two pages in sibling folders', [people, settings]],
    [
      'two areas with no role that overlap',
      [
        { name: 'a', globs: ['**'] },
        { name: 'b', globs: ['b/**'] },
      ],
    ],
    [
      'a page that is the catch-all, which never shares a file',
      [people, { ...settings, globs: ['**'], catchAll: true }],
    ],
  ])('allows %s', (_name, areas) => {
    expect(issues(areas)).toEqual(['', '']);
  });

  it('names both pages and the globs that meet', () => {
    const [problem] = issues([people, { ...settings, globs: ['app/**/*.tsx'] }]);
    expect(problem).toContain('"people" and "settings"');
    expect(problem).toContain('app/people/**');
    expect(problem).toContain('app/**/*.tsx');
  });
});

describe('the catch-all area', () => {
  const project = {
    name: 'demo',
    repoPath: '/tmp/demo',
    gateCommand: 'make gate',
  };
  const api = { name: 'api', globs: ['api/**'] };
  const rest = { name: 'root', globs: ['*'], catchAll: true };

  it('is optional: areas without the flag parse as before', () => {
    const parsed = ProjectInput.parse({ ...project, areas: [api] });
    expect(parsed.areas).toEqual([api]);
    expect(parsed.areas[0]).not.toHaveProperty('catchAll');
  });

  it('is kept when a project is made or patched with one', () => {
    expect(ProjectInput.parse({ ...project, areas: [api, rest] }).areas).toEqual([api, rest]);
    expect(ProjectPatch.parse({ areas: [api, rest] }).areas).toEqual([api, rest]);
  });

  it('allows at most one per project, on create and on patch', () => {
    const second = { name: 'other', globs: ['other/**'], catchAll: true };
    const created = ProjectInput.safeParse({ ...project, areas: [api, rest, second] });
    const patched = ProjectPatch.safeParse({ areas: [rest, second] });
    expect(created.success).toBe(false);
    expect(patched.success).toBe(false);
    expect(JSON.stringify(patched.error?.issues)).toContain('Only one area can be the catch-all');
  });

  it('treats catchAll: false as no catch-all, so several may say it', () => {
    const areas = [
      { ...api, catchAll: false },
      { name: 'ui', globs: ['ui/**'], catchAll: false },
    ];
    expect(ProjectInput.safeParse({ ...project, areas }).success).toBe(true);
  });

  it('is not a field of a hazard', () => {
    const hazard = { name: 'locks', globs: ['x'], commands: [], catchAll: true };
    expect(ProjectPatch.parse({ hazards: [hazard] }).hazards?.[0]).not.toHaveProperty('catchAll');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InboxItemDto,
  PermissionChoice,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import {
  checkServerEnv,
  claudeCodeVersion,
  renderAcceptanceReport,
  runAcceptanceChecks,
  sessionBaselines,
} from '../scripts/acceptance-checks';
import { apiClient, quickFlowId } from './api-client';
import { createTempRepo, handoffArgs, tempDir, waitForAsync } from './fixtures';

const write = (path: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content: `${path}\n` },
});
const commit = (opId: string, path: string) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths: [path], message: `Add ${path}` },
});
const turn = { do: 'turn_complete' as const };

const BOOK: FakeScriptBook = {
  Alpha: [
    [
      write('src/a/one.txt'),
      commit('op-a-0001', 'src/a/one.txt'),
      { do: 'context', percentage: 72 },
      { do: 'await_message', contains: 'write_handoff' },
      { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-a-hand1', 'Add src/a/two.txt') },
      turn,
    ],
    [write('src/a/two.txt'), commit('op-a-0002', 'src/a/two.txt'), turn],
  ],
  Beta: [
    [
      {
        do: 'tool',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which greeting?',
              header: 'Greeting',
              options: [
                { label: 'Hello', description: '' },
                { label: 'Howdy', description: '' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
      {
        do: 'tool',
        toolName: 'mcp__mantine__search_mantine_docs',
        input: { query: 'Button' },
      },
      write('src/b/one.txt'),
      commit('op-b-0001', 'src/b/one.txt'),
      turn,
    ],
  ],
};

let repo: { path: string; cleanup(): void };
let data: { path: string; cleanup(): void };
let daemon: RunningDaemon;

beforeAll(async () => {
  repo = createTempRepo();
  data = tempDir('acceptance-checks');
  daemon = await startDaemon({
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter(BOOK),
    logLevel: 'info',
    caffeinate: () => null,
    watch: false,
  });
  // Every call names the zod schema its response is parsed with, so a changed response fails here.
  const api = apiClient(daemon.url, daemon.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'checks',
    repoPath: repo.path,
    gateCommand: 'test -d src',
    flowId: await quickFlowId(api),
    maxLanes: 2,
    areas: [
      { name: 'a', globs: ['src/a/**'] },
      { name: 'b', globs: ['src/b/**'] },
    ],
  });
  for (const [title, area] of [
    ['Alpha', 'a'],
    ['Beta', 'b'],
  ] as const) {
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title,
      acceptanceCriteria: ['file exists'],
      areas: [area],
    });
    await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
  }
  // Beta asks a question and then calls a repo MCP tool, which becomes a permission card.
  const answered = new Set<string>();
  await waitForAsync(async () => {
    for (const card of await api.get('/inbox?state=OPEN', z.array(InboxItemDto))) {
      if (answered.has(card.id)) continue;
      if (card.kind === 'question')
        await api.post(`/inbox/${card.id}/answer`, z.unknown(), { choice: 'Howdy' });
      else if (card.kind === 'permission')
        await api.post(`/inbox/${card.id}/answer`, z.unknown(), {
          choice: PermissionChoice.AllowOnce,
        });
      else continue;
      answered.add(card.id);
    }
    return answered.size >= 2 ? answered : undefined;
  });
  await waitForAsync(async () => {
    const all = await api.get('/workstreams?active=false', z.array(WorkstreamDto));
    return all.length === 2 && all.every((w) => w.state === 'DONE') ? all : undefined;
  });
  await daemon.stop();
}, 60_000);

afterAll(() => {
  repo.cleanup();
  data.cleanup();
});

/** The files the fake run commits. */
const FAKE_OUTPUTS = ['src/a/one.txt', 'src/a/two.txt', 'src/b/one.txt'];

const byName = async (
  overrides: {
    logText?: string;
    minTasks?: number;
    envKeys?: readonly string[] | null;
    server?: string;
    outputs?: readonly string[];
  } = {},
) => {
  const checks = await runAcceptanceChecks({
    dbPath: join(data.path, '10db.sqlite'),
    repoPath: repo.path,
    logText: overrides.logText ?? readFileSync(join(data.path, 'logs', 'daemon.log'), 'utf8'),
    minTasks: overrides.minTasks ?? 2,
    mcpServer: overrides.server ?? 'mantine',
    mcpServerEnvKeys: overrides.envKeys ?? null,
    outputs: overrides.outputs ?? FAKE_OUTPUTS,
  });
  return new Map(checks.map((c) => [c.name, c]));
};

describe('runAcceptanceChecks', () => {
  it('passes every engine check on a clean fake-adapter run', async () => {
    const checks = await byName();
    for (const name of [
      'tasks done',
      'task outputs',
      'gate evidence',
      'handoff crossed',
      'question answered',
      'no duplicate commits',
      'no duplicate tool ops',
      'events replay without gaps',
    ]) {
      expect(checks.get(name), name).toMatchObject({ ok: true });
    }
  });

  describe('task outputs', () => {
    // A task's gate checks only what holds at every step, so this check is what proves each task wrote its file.
    it.each([
      { name: 'every expected file committed', outputs: FAKE_OUTPUTS, ok: true },
      {
        name: 'one expected file never committed',
        outputs: [...FAKE_OUTPUTS, 'src/b/two.txt'],
        ok: false,
      },
    ])('$name', async ({ outputs, ok }) => {
      expect((await byName({ outputs })).get('task outputs')).toMatchObject({ ok });
    });
  });

  it('fails the recovery check when the daemon was never killed', async () => {
    expect((await byName()).get('recovered after kill -9')).toMatchObject({ ok: false });
  });

  it('fails the billing check when no Claude session logged its billing', async () => {
    expect((await byName()).get('subscription billing')).toMatchObject({ ok: false });
  });

  it('passes the billing check only when every session logged a first-party login', async () => {
    const sessions = 3; // Alpha ran two sessions and Beta one.
    const line = JSON.stringify({
      level: 30,
      msg: 'claude session billing',
      apiKeySource: 'none',
      apiProvider: 'firstParty',
      subscriptionType: 'Claude Max',
    });
    expect(
      (await byName({ logText: Array.from({ length: sessions }, () => line).join('\n') })).get(
        'subscription billing',
      ),
    ).toMatchObject({ ok: true });
    const bedrock = JSON.stringify({
      level: 30,
      msg: 'claude session billing',
      apiKeySource: 'none',
      apiProvider: 'bedrock',
    });
    expect(
      (await byName({ logText: [line, line, bedrock].join('\n') })).get('subscription billing'),
    ).toMatchObject({ ok: false });
    const noPlan = JSON.stringify({
      level: 30,
      msg: 'claude session billing',
      apiKeySource: 'none',
      apiProvider: 'firstParty',
    });
    expect(
      (await byName({ logText: [line, line, noPlan].join('\n') })).get('subscription billing'),
    ).toMatchObject({ ok: false });
  });

  describe('repo MCP tool gated', () => {
    // The fake run's Beta session called mcp__mantine__search_mantine_docs, which became a permission card.
    it.each([
      { name: 'a card for a tool of the approved server', server: 'mantine', ok: true },
      { name: 'cards only for another server', server: 'docs', ok: false },
      { name: 'a server name that is only a prefix of the card tool', server: 'mant', ok: false },
    ])('$name', async ({ server, ok }) => {
      expect((await byName({ server })).get('repo MCP tool gated')).toMatchObject({ ok });
    });
  });

  it('fails the repo MCP checks on a run whose repo declared no server', async () => {
    const checks = await byName();
    for (const name of [
      'repo MCP server approved',
      'repo MCP server connected',
      'repo MCP server env',
    ])
      expect(checks.get(name), name).toMatchObject({ ok: false });
  });

  it('passes the approval check only when every session start passed the server with exactly HOME and PATH', async () => {
    const start = (passed: { name: string; envKeys: string[] }[]) =>
      JSON.stringify({
        level: 30,
        msg: 'project mcp servers',
        passed,
        pending: [],
        denied: [],
        failed: [],
      });
    const mantine = { name: 'mantine', envKeys: ['HOME', 'PATH'] };
    const check = async (...starts: string[]) =>
      (await byName({ logText: starts.join('\n') })).get('repo MCP server approved');
    // Three sessions started in the fake run: Alpha's two and Beta's one.
    expect(await check(start([mantine]), start([mantine]), start([mantine]))).toMatchObject({
      ok: true,
    });
    expect(await check(start([mantine]), start([mantine]), start([]))).toMatchObject({ ok: false });
    expect(
      await check(
        start([mantine]),
        start([mantine]),
        start([{ name: 'mantine', envKeys: ['HOME', 'PATH', 'ANTHROPIC_API_KEY'] }]),
      ),
    ).toMatchObject({ ok: false });
  });

  describe('every clause of the billing and approval checks', () => {
    const billing = JSON.stringify({
      level: 30,
      msg: 'claude session billing',
      apiKeySource: 'none',
      apiProvider: 'firstParty',
      subscriptionType: 'Claude Max',
    });
    const mantine = { name: 'mantine', envKeys: ['HOME', 'PATH'] };
    const start = JSON.stringify({
      level: 30,
      msg: 'project mcp servers',
      passed: [mantine],
      pending: [],
      denied: [],
      failed: [],
    });
    const refused = JSON.stringify({
      level: 50,
      msg: 'claude session refused',
      reason: 'Billing check failed: an API key is in use. No prompt was sent.',
    });
    // Alpha ran two sessions and Beta one, so three sessions started.
    it.each([
      [
        'fewer billing lines than started sessions',
        'subscription billing',
        [billing, billing],
        false,
      ],
      [
        'a billing failure beside good lines',
        'subscription billing',
        [billing, billing, billing, refused],
        false,
      ],
      [
        'every started session logged a first-party login',
        'subscription billing',
        [billing, billing, billing],
        true,
      ],
      [
        'fewer approved starts than started sessions',
        'repo MCP server approved',
        [start, start],
        false,
      ],
      [
        'every started session passed the server',
        'repo MCP server approved',
        [start, start, start],
        true,
      ],
    ])('%s', async (_name, check, lines, ok) => {
      expect((await byName({ logText: lines.join('\n') })).get(check)).toMatchObject({ ok });
    });
  });

  it('requires at least as many op trailers as tasks', async () => {
    expect((await byName({ minTasks: 2 })).get('no duplicate commits')).toMatchObject({ ok: true });
    expect((await byName({ minTasks: 4 })).get('no duplicate commits')).toMatchObject({
      ok: false,
    });
  });

  it('passes the connection check on a connected status after the first turn, never on pending', async () => {
    const status = (s: string) =>
      JSON.stringify({
        level: 30,
        msg: 'claude session mcp status',
        mcpServers: [
          { name: '10db', status: 'connected' },
          { name: 'mantine', status: s },
        ],
      });
    const check = async (...lines: string[]) =>
      (await byName({ logText: lines.join('\n') })).get('repo MCP server connected');
    const pending = await check(status('pending'));
    expect(pending).toMatchObject({ ok: false });
    expect(pending?.detail).toContain('pending');
    expect(await check(status('pending'), status('connected'))).toMatchObject({ ok: true });
    expect(await check(status('failed'))).toMatchObject({ ok: false });
  });

  it('fails when fewer tasks than required are done', async () => {
    expect((await byName({ minTasks: 3 })).get('tasks done')).toMatchObject({ ok: false });
  });

  it('catches a duplicated 10db-Op trailer in git history', async () => {
    mkdirSync(join(repo.path, 'src', 'a'), { recursive: true });
    writeFileSync(join(repo.path, 'src', 'a', 'dup.txt'), 'dup\n');
    execFileSync('git', ['add', 'src/a/dup.txt'], { cwd: repo.path });
    execFileSync('git', ['commit', '-q', '-m', 'Duplicate\n\n10db-Op: op-a-0001'], {
      cwd: repo.path,
    });
    const duplicates = (await byName()).get('no duplicate commits');
    expect(duplicates).toMatchObject({ ok: false });
    expect(duplicates?.detail).toContain('op-a-0001');
  });
});

describe('checkServerEnv', () => {
  // What `ps -E` showed for `env -i PATH=… HOME=… npx -y @mantine/mcp-server@9.7.2`.
  const MEASURED = [
    '_',
    '__CF_USER_TEXT_ENCODING',
    'COLOR',
    'EDITOR',
    'HOME',
    'INIT_CWD',
    'NODE',
    'npm_command',
    'npm_config_cache',
    'npm_execpath',
    'PATH',
    'PWD',
    'SHLVL',
  ];

  it('passes PATH, HOME and the keys npm and macOS add', () => {
    expect(checkServerEnv('mantine', MEASURED)).toMatchObject({ ok: true });
  });

  it.each([
    ['a billing credential', 'ANTHROPIC_API_KEY'],
    ['the subscription token', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['an AWS credential', 'AWS_SECRET_ACCESS_KEY'],
    ['any other session variable', 'GITHUB_TOKEN'],
  ])('fails when the server had %s', (_name, key) => {
    const result = checkServerEnv('mantine', [...MEASURED, key]);
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain(key);
  });

  it('fails when the process was never seen or lacks PATH', () => {
    expect(checkServerEnv('mantine', null)).toMatchObject({ ok: false });
    expect(checkServerEnv('mantine', ['HOME'])).toMatchObject({ ok: false });
  });
});

describe('claudeCodeVersion', () => {
  it('reads the version from the billing lines and never throws', () => {
    const line = (v: string) =>
      JSON.stringify({ msg: 'claude session billing', claudeCodeVersion: v });
    expect(claudeCodeVersion(['not json', line('2.1.300')].join('\n'))).toBe('2.1.300');
    expect(claudeCodeVersion('')).toBe('unknown');
  });
});

describe('sessionBaselines', () => {
  it("reports each session's first context reading", () => {
    // Only Alpha's first session reads context in this book (72%).
    expect(sessionBaselines(join(data.path, '10db.sqlite'))).toEqual({
      min: 72,
      max: 72,
      sessions: 1,
    });
  });
});

describe('renderAcceptanceReport', () => {
  it('renders a pass/fail table with the overall status first', () => {
    const text = renderAcceptanceReport({
      checks: [{ name: 'tasks done', ok: true, detail: '3 of 3' }],
      manual: [{ name: 'window close and reopen', ok: false, detail: 'builder said no' }],
      meta: { Date: '2026-10-20', Model: 'sonnet' },
    });
    expect(text).toContain('- **Status:** FAILED');
    expect(text).toContain('| tasks done | PASS | 3 of 3 |');
    expect(text).toContain('| window close and reopen | FAIL | builder said no |');
    expect(text).toContain('- **Model:** sonnet');
  });
});

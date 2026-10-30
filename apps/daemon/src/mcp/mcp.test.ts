import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  acquireClaims,
  createTestStore,
  endSession,
  getWorkstream,
  insertBatch,
  insertSession,
  insertTask,
  insertWorkstream,
  listInbox,
  patchWorkstream,
  schema,
  seedProject,
  transitionBatch,
  type Store,
} from '@10db/db';
import type { ProjectDto, WorkstreamStep } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempRepo, isolatedGitEnv, seedWorkstream, tempDir } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { protectedPaths } from '../guard';
import { createInboxService, type InboxService } from '../inbox';
import type { Logger } from '../log';
import { createMcpHandler, mintSessionToken } from './index';

const GUARDED = protectedPaths({
  dataDir: join(tmpdir(), 'mcp-test-data'),
  home: homedir(),
  loginConfigDir: null,
});

let repo: { path: string; cleanup(): void };
let close: () => void;
let base: Store;
let state: StateStore;
let inbox: InboxService;
let server: ReturnType<typeof serve>;
let url: string;
const git = createGit();
/** The branch each test's workstream was pinned to at its first session, as the runner records it. */
let workstreamBranch: string | null = 'main';

interface LogEntry {
  readonly obj: object;
  readonly msg: string | undefined;
}
const logged: LogEntry[] = [];
const capturingLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (obj, msg) => {
    logged.push({ obj, msg });
  },
  child: () => capturingLogger,
};

const ToolContent = z.array(z.object({ type: z.string(), text: z.string() }));
const JsonObject = z.record(z.string(), z.unknown());

beforeEach(async () => {
  logged.length = 0;
  workstreamBranch = 'main';
  repo = createTempRepo();
  const test = createTestStore();
  close = test.close;
  base = test.store;
  state = createStateStore(test.store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const handler = createMcpHandler({
    protectedPaths: GUARDED,
    state,
    inbox,
    git,
    log: capturingLogger,
    waitObserverFor: () => undefined,
    sessionSignal: () => undefined,
  });
  server = serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  // `serve` returns a generic server; a bound TCP server's address is an AddressInfo.
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});
afterEach(() => {
  server.close();
  close();
  repo.cleanup();
});

/** A workstream in a batch whose worktree is `worktree`, on the branch git made it with. */
function seedWorktreeWorkstream(
  worktree: string,
  branch: string,
  areas: string[],
  existing?: ProjectDto,
) {
  const project = existing ?? seedProject(base, { repoPath: repo.path });
  const batch = state.write((ctx) => {
    const inserted = insertBatch(ctx, {
      projectId: project.id,
      title: 'Greetings',
      baseBranch: 'main',
      worktreePath: worktree,
    });
    return transitionBatch(ctx, inserted.id, { to: 'OPEN', patch: { branch, baseSha: 'x' } });
  });
  const task = state.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Alpha', acceptanceCriteria: ['it works'], areas }),
  );
  const workstream = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
  return { project, task, workstream, areaScope: batch.id };
}

async function seedSession(
  areas = ['api'],
  worktree?: { path: string; branch: string; project?: ProjectDto },
) {
  const seeded = worktree
    ? seedWorktreeWorkstream(worktree.path, worktree.branch, areas, worktree.project)
    : { ...seedWorkstream(base, { repoPath: repo.path, areas }), areaScope: undefined };
  const { token, hash } = mintSessionToken();
  const head = execFileSync('git', ['-C', worktree?.path ?? repo.path, 'rev-parse', 'HEAD'], {
    env: isolatedGitEnv(),
  })
    .toString()
    .trim();
  const session = state.write((ctx) => {
    acquireClaims(ctx, {
      projectId: seeded.project.id,
      workstreamId: seeded.workstream.id,
      requests: areas.map((name) => ({ kind: 'area' as const, name })),
      leaseExpiresAt: ctx.now,
      ...(seeded.areaScope ? { areaScope: seeded.areaScope } : {}),
    });
    patchWorkstream(ctx, seeded.workstream.id, null, {
      baseHead: head,
      ...(workstreamBranch === null || worktree ? {} : { branch: workstreamBranch }),
    });
    return insertSession(ctx, {
      workstreamId: seeded.workstream.id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: hash,
    });
  });
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = ToolContent.parse(result.content)
      .map((c) => c.text)
      .join('');
    return {
      isError: result.isError === true,
      text,
      json: result.isError === true ? null : JsonObject.parse(JSON.parse(text)),
    };
  };
  return { ...seeded, session, token, client, call };
}

const writeRepoFile = (rel: string, text: string) => {
  mkdirSync(join(repo.path, rel, '..'), { recursive: true });
  writeFileSync(join(repo.path, rel), text);
};
const commitCount = () =>
  Number(
    execFileSync('git', ['-C', repo.path, 'rev-list', '--count', 'HEAD'], {
      env: isolatedGitEnv(),
    })
      .toString()
      .trim(),
  );

describe('MCP auth', () => {
  it('rejects a missing token and an ended session', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const s = await seedSession();
    state.write((ctx) => {
      endSession(ctx, s.session.id, 'test');
    });
    const after = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(after.status).toBe(401);
  });
});

describe('MCP tools in a worktree batch', () => {
  let outside: { path: string; cleanup(): void };
  let worktree: string;
  beforeEach(() => {
    outside = tempDir('mcp-worktree');
    worktree = join(outside.path, 'wt');
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', 'batch/one', worktree], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    worktree = realpathSync(worktree);
  });
  afterEach(() => {
    outside.cleanup();
  });
  const worktreeCount = () =>
    Number(
      execFileSync('git', ['-C', worktree, 'rev-list', '--count', 'HEAD'], {
        env: isolatedGitEnv(),
      })
        .toString()
        .trim(),
    );

  it('commit commits on its branch in the worktree and leaves the main checkout alone', async () => {
    const s = await seedSession(['api'], { path: worktree, branch: 'batch/one' });
    const mainState = () => ({
      head: execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], { env: isolatedGitEnv() })
        .toString()
        .trim(),
      status: execFileSync('git', ['-C', repo.path, 'status', '--porcelain'], {
        env: isolatedGitEnv(),
      }).toString(),
    });
    const before = mainState();
    mkdirSync(join(worktree, 'src/api'), { recursive: true });
    writeFileSync(join(worktree, 'src/api/a.ts'), 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-wt-commit-1',
      paths: ['src/api/a.ts'],
      message: 'Add a',
    });
    expect(result.isError).toBe(false);
    expect(worktreeCount()).toBe(2);
    expect(commitCount()).toBe(1);
    expect(mainState()).toEqual(before);
    const branches = execFileSync('git', ['-C', repo.path, 'branch', '--list', 'batch/one'], {
      env: isolatedGitEnv(),
    }).toString();
    expect(branches).toContain('batch/one');
  });

  it('write_handoff reads changes from the worktree', async () => {
    const s = await seedSession(['api'], { path: worktree, branch: 'batch/one' });
    mkdirSync(join(worktree, 'src/api'), { recursive: true });
    writeFileSync(join(worktree, 'src/api/c.ts'), 'export {}\n');
    await s.call('commit', { opId: 'op-wt-commit-2', paths: ['src/api/c.ts'], message: 'Add c' });
    const handoff = {
      objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
      progress: { done: ['c'], notDone: ['d'], nextAction: 'Write d' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    await s.call('write_handoff', { opId: 'op-wt-handoff-1', ...handoff });
    const ctx = await s.call('get_context', {});
    expect(ctx.json).toMatchObject({ handoff: { gitChangedFiles: ['src/api/c.ts'] } });
  });

  const claimRows: { name: string; claim: string; secondGranted: boolean }[] = [
    { name: 'an area is exclusive only within its batch', claim: 'ui', secondGranted: true },
    { name: 'a hazard stays exclusive across batches', claim: 'migrations', secondGranted: false },
  ];

  it.each(claimRows)('request_claim: $name', async ({ claim, secondGranted }) => {
    const other = join(outside.path, 'wt2');
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', 'batch/two', other], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const a = await seedSession(['api'], { path: worktree, branch: 'batch/one' });
    const b = await seedSession(['api'], {
      path: realpathSync(other),
      branch: 'batch/two',
      project: a.project,
    });
    const first = await a.call('request_claim', {
      opId: 'op-wt-claim-a',
      kind: 'area',
      name: claim,
      reason: 'shared badge',
    });
    expect(first.json).toMatchObject({ granted: true });
    const second = await b.call('request_claim', {
      opId: 'op-wt-claim-b',
      kind: 'area',
      name: claim,
      reason: 'shared badge',
    });
    expect(second.json).toMatchObject(
      secondGranted ? { granted: true } : { granted: false, heldBy: a.workstream.id },
    );
  });
});

describe('MCP tools', () => {
  it('lists exactly the eleven tools', async () => {
    const s = await seedSession();
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_human',
      'commit',
      'complete_step',
      'find_knowledge',
      'get_context',
      'propose',
      'record_decision',
      'record_evidence',
      'report_deviation',
      'request_claim',
      'write_handoff',
    ]);
  });

  it('returns the context pack for the calling session', async () => {
    const s = await seedSession();
    const { json } = await s.call('get_context', {});
    expect(json).toMatchObject({
      task: { title: 'Alpha' },
      claims: [{ kind: 'area', name: 'api' }],
    });
  });

  it('reads a recorded decision back through find_knowledge', async () => {
    const s = await seedSession();
    await s.call('record_decision', {
      opId: 'op-decision-01',
      question: 'Which date library?',
      choice: 'dayjs',
      rationale: 'small',
      scope: 'project',
    });
    const { json } = await s.call('find_knowledge', { query: 'date library' });
    expect(json).toMatchObject({ empty: false, results: [{ choice: 'dayjs' }] });
  });

  it.each([
    { name: 'area scope without an area', scope: 'area', area: undefined, error: 'area' },
    { name: 'project scope with an area', scope: 'project', area: 'api', error: 'area' },
  ])('rejects record_decision with $name', async ({ scope, area, error }) => {
    const s = await seedSession();
    const result = await s.call('record_decision', {
      opId: 'op-decision-bad',
      question: 'q?',
      choice: 'c',
      rationale: 'r',
      scope,
      ...(area ? { area } : {}),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(error);
  });

  it('records an area-scoped decision with its area', async () => {
    const s = await seedSession();
    const result = await s.call('record_decision', {
      opId: 'op-decision-ar',
      question: 'Which router?',
      choice: 'hono',
      rationale: 'small',
      scope: 'area',
      area: 'api',
    });
    expect(result.isError).toBe(false);
    const found = await s.call('find_knowledge', { query: 'router' });
    expect(found.json).toMatchObject({ results: [{ choice: 'hono' }] });
  });

  it('commits inside claims once per opId', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/a.ts', 'export {}\n');
    const first = await s.call('commit', {
      opId: 'op-commit-001',
      paths: ['src/api/a.ts'],
      message: 'Add a',
    });
    const retry = await s.call('commit', {
      opId: 'op-commit-001',
      paths: ['src/api/a.ts'],
      message: 'Add a',
    });
    expect(first.json).toMatchObject({ alreadyCommitted: false });
    expect(retry.json).toEqual(first.json);
    expect(commitCount()).toBe(2);
  });

  it('recovers a commit made before a crash that never recorded its op', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/b.ts', 'export {}\n');
    const direct = await git.commit({
      repo: repo.path,
      paths: ['src/api/b.ts'],
      message: 'Add b',
      opId: 'op-crashed-01',
      branch: 'main',
    });
    const viaTool = await s.call('commit', {
      opId: 'op-crashed-01',
      paths: ['src/api/b.ts'],
      message: 'Add b',
    });
    expect(viaTool.json).toEqual({ sha: direct.sha, alreadyCommitted: true });
    expect(commitCount()).toBe(2);
  });

  it("refuses a commit once the checkout left the session's branch, and tells the lane why", async () => {
    const s = await seedSession();
    execFileSync('git', ['-C', repo.path, 'switch', '-q', '-c', 'elsewhere'], {
      env: isolatedGitEnv(),
    });
    writeRepoFile('src/api/e.ts', 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-commit-moved',
      paths: ['src/api/e.ts'],
      message: 'e',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the checkout is on elsewhere, the lane's branch is main");
    expect(commitCount()).toBe(1);
  });

  it('refuses a commit for work pinned to no branch, its first session having found HEAD detached', async () => {
    workstreamBranch = null;
    const s = await seedSession();
    writeRepoFile('src/api/f.ts', 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-commit-nobr',
      paths: ['src/api/f.ts'],
      message: 'f',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('detached');
    expect(commitCount()).toBe(1);
  });

  it('refuses to commit a path outside the claims', async () => {
    const s = await seedSession();
    writeRepoFile('src/ui/x.ts', 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-commit-ui1',
      paths: ['src/ui/x.ts'],
      message: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('request_claim');
    expect(commitCount()).toBe(1);
  });

  it('records a handoff with git-derived facts', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/c.ts', 'export {}\n');
    await s.call('commit', { opId: 'op-commit-c01', paths: ['src/api/c.ts'], message: 'Add c' });
    const handoff = {
      objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
      progress: { done: ['c'], notDone: ['d'], nextAction: 'Write d' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    const { json } = await s.call('write_handoff', { opId: 'op-handoff-01', ...handoff });
    expect(String(json?.['instruction'])).toContain('End your turn');
    const ctx = await s.call('get_context', {});
    expect(ctx.json).toMatchObject({
      handoff: {
        gitChangedFiles: ['src/api/c.ts'],
        content: { progress: { nextAction: 'Write d' } },
      },
    });
  });

  it('grants a free claim', async () => {
    const a = await seedSession(['api']);
    const granted = await a.call('request_claim', {
      opId: 'op-claim-ui-1',
      kind: 'area',
      name: 'ui',
      reason: 'shared badge',
    });
    expect(granted.json).toMatchObject({ granted: true });
  });

  it('raises a flag card when another workstream holds the claim', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    state.write((ctx) =>
      acquireClaims(ctx, {
        projectId: a.project.id,
        workstreamId: other.workstream.id,
        requests: [{ kind: 'area', name: 'ui' }],
        leaseExpiresAt: ctx.now,
      }),
    );
    const refused = await a.call('request_claim', {
      opId: 'op-claim-ui-3',
      kind: 'area',
      name: 'ui',
      reason: 'need the badge',
    });
    expect(refused.json).toMatchObject({ granted: false, heldBy: other.workstream.id });
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('treats a project hazard name as a hazard claim whatever kind the agent sends', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, {
      project: a.project,
      title: 'Beta',
      areas: ['migrations'],
    });
    state.write((ctx) =>
      acquireClaims(ctx, {
        projectId: a.project.id,
        workstreamId: other.workstream.id,
        requests: [{ kind: 'hazard', name: 'migrations' }],
        leaseExpiresAt: ctx.now,
      }),
    );
    const refused = await a.call('request_claim', {
      opId: 'op-claim-haz-1',
      kind: 'area',
      name: 'migrations',
      reason: 'need a table',
    });
    expect(refused.json).toMatchObject({ granted: false, heldBy: other.workstream.id });
    const free = await a.call('request_claim', {
      opId: 'op-claim-haz-2',
      kind: 'area',
      name: 'deps',
      reason: 'need a package',
    });
    expect(free.json).toMatchObject({ granted: true });
    const pack = await a.call('get_context', {});
    const claims = z
      .array(z.object({ kind: z.string(), name: z.string() }))
      .parse(pack.json?.['claims']);
    expect(claims).toContainEqual({ kind: 'hazard', name: 'deps' });
  });

  it('rejects a claim for a name that is neither an area nor a hazard', async () => {
    const a = await seedSession(['api']);
    const result = await a.call('request_claim', {
      opId: 'op-claim-bad-1',
      kind: 'area',
      name: 'nowhere',
      reason: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('nowhere');
  });

  it('names a nonexistent path when commit cannot stage it', async () => {
    const s = await seedSession();
    const result = await s.call('commit', {
      opId: 'op-commit-typo',
      paths: ['src/api/typo.ts'],
      message: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('src/api/typo.ts');
    expect(result.text).not.toContain('Internal error');
    expect(commitCount()).toBe(1);
  });

  it('reports malformed input from the schema as a readable tool error', async () => {
    const s = await seedSession();
    const result = await s.call('record_evidence', {
      opId: 'x',
      command: 'pnpm test',
      exitCode: 0,
      summary: 'ok',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('opId');
  });

  it('logs an unexpected error and does not promise a retry will work', async () => {
    const failing = createMcpHandler({
      protectedPaths: GUARDED,
      state,
      inbox,
      git: { ...git, commit: () => Promise.reject(new Error('disk exploded')) },
      log: capturingLogger,
      waitObserverFor: () => undefined,
      sessionSignal: () => undefined,
    });
    const failingServer = serve({ fetch: failing, hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => failingServer.once('listening', r));
    try {
      // See the beforeEach cast.
      url = `http://127.0.0.1:${String((failingServer.address() as AddressInfo).port)}/mcp`;
      const s = await seedSession();
      writeRepoFile('src/api/d.ts', 'export {}\n');
      const result = await s.call('commit', {
        opId: 'op-commit-boom',
        paths: ['src/api/d.ts'],
        message: 'd',
      });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('retry the call with the same opId');
      expect(result.text).toContain('commit');
      expect(logged).toHaveLength(1);
      expect(logged[0]?.obj).toMatchObject({ tool: 'commit', opId: 'op-commit-boom' });
    } finally {
      failingServer.close();
    }
  });

  it('rejects an opId reused for a different tool', async () => {
    const s = await seedSession();
    await s.call('record_decision', {
      opId: 'op-shared-001',
      question: 'q?',
      choice: 'c',
      rationale: 'r',
      scope: 'project',
    });
    const reused = await s.call('report_deviation', {
      opId: 'op-shared-001',
      cause: 'x',
      severity: 'info',
      reason: 'y',
    });
    expect(reused.isError).toBe(true);
    expect(reused.text).toContain('already used for record_decision');
    expect(state.db.select().from(schema.deviations).all()).toHaveLength(0);
  });

  it('waits on ask_human until the builder answers', async () => {
    const s = await seedSession();
    const pending = s.call('ask_human', {
      opId: 'op-ask-00001',
      category: 'design',
      question: 'Teal or red?',
      options: [
        { label: 'Teal', description: '' },
        { label: 'Red', description: '' },
      ],
    });
    let card;
    for (let i = 0; i < 50 && !card; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      card = listInbox(state.db, { states: ['OPEN'] })[0];
    }
    if (!card) throw new Error('no card opened');
    inbox.answer(card.id, { choice: 'Teal' });
    expect((await pending).json).toMatchObject({ answer: 'Teal' });
  });

  it('tells a parked ask_human not to ask again', async () => {
    const abort = new AbortController();
    const parkedHandler = createMcpHandler({
      protectedPaths: GUARDED,
      state,
      inbox,
      git,
      log: capturingLogger,
      waitObserverFor: () => undefined,
      sessionSignal: () => abort.signal,
    });
    const parkedServer = serve({ fetch: parkedHandler, hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => parkedServer.once('listening', r));
    try {
      // See the beforeEach cast.
      url = `http://127.0.0.1:${String((parkedServer.address() as AddressInfo).port)}/mcp`;
      const s = await seedSession();
      const pending = s.call('ask_human', {
        opId: 'op-ask-parked',
        category: 'design',
        question: 'Round or square?',
        options: [
          { label: 'Round', description: '' },
          { label: 'Square', description: '' },
        ],
      });
      for (let i = 0; i < 50 && listInbox(state.db, { states: ['OPEN'] }).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      abort.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Do not ask again');
    } finally {
      parkedServer.close();
    }
  });
});

describe('MCP idempotence by opId', () => {
  const rows = {
    decisions: () => state.db.select().from(schema.decisions).all().length,
    proposals: () => state.db.select().from(schema.proposals).all().length,
    deviations: () => state.db.select().from(schema.deviations).all().length,
    evidence: () => state.db.select().from(schema.evidence).all().length,
    handoffs: () => state.db.select().from(schema.handoffs).all().length,
    claims: () => state.db.select().from(schema.claims).all().length,
    inbox: () => listInbox(state.db, {}).length,
  };
  const handoff = {
    objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
    progress: { done: [], notDone: [], nextAction: 'Write d' },
    codeState: { uncommittedSummary: '' },
    reasoning: { decisions: [], tradeOffs: [], rejected: [] },
    validation: { checks: [], environmentProblems: [] },
    continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
  };
  const table: {
    name: string;
    tool: string;
    args: Record<string, unknown>;
    // Rows that exist after the call, keyed by what each call must have created.
    created: Partial<Record<keyof typeof rows, number>>;
  }[] = [
    {
      name: 'record_decision',
      tool: 'record_decision',
      args: { opId: 'op-idem-0001', question: 'q?', choice: 'c', rationale: 'r', scope: 'project' },
      created: { decisions: 1 },
    },
    {
      name: 'propose (one proposal and one card)',
      tool: 'propose',
      args: { opId: 'op-idem-0002', kind: 'new_task', title: 'Add x', body: 'because' },
      created: { proposals: 1, inbox: 1 },
    },
    {
      name: 'report_deviation',
      tool: 'report_deviation',
      args: { opId: 'op-idem-0003', cause: 'x', severity: 'info', reason: 'y' },
      created: { deviations: 1 },
    },
    {
      name: 'record_evidence',
      tool: 'record_evidence',
      args: { opId: 'op-idem-0004', command: 'pnpm test', exitCode: 0, summary: 'ok' },
      created: { evidence: 1 },
    },
    {
      name: 'write_handoff',
      tool: 'write_handoff',
      args: { opId: 'op-idem-0005', ...handoff },
      created: { handoffs: 1 },
    },
    {
      name: 'request_claim (granted)',
      tool: 'request_claim',
      args: { opId: 'op-idem-0006', kind: 'area', name: 'ui', reason: 'badge' },
      // The session's own api claim plus the granted ui claim.
      created: { claims: 2 },
    },
  ];

  it.each(table)('$name runs once for a repeated opId', async ({ tool, args, created }) => {
    const s = await seedSession();
    const first = await s.call(tool, args);
    const second = await s.call(tool, args);
    expect(first.isError).toBe(false);
    expect(second.json).toEqual(first.json);
    for (const [key, expected] of Object.entries(created)) {
      expect(rows[key as keyof typeof rows](), key).toBe(expected);
    }
  });

  it('answers a repeated ask_human from the recorded result without a second card', async () => {
    const s = await seedSession();
    const args = {
      opId: 'op-idem-0007',
      category: 'design',
      question: 'Teal or red?',
      options: [
        { label: 'Teal', description: '' },
        { label: 'Red', description: '' },
      ],
    };
    const pending = s.call('ask_human', args);
    let card;
    for (let i = 0; i < 50 && !card; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      card = listInbox(state.db, { states: ['OPEN'] })[0];
    }
    if (!card) throw new Error('no card opened');
    inbox.answer(card.id, { choice: 'Teal' });
    const first = await pending;
    const second = await s.call('ask_human', args);
    expect(second.json).toEqual(first.json);
    expect(rows.inbox()).toBe(1);
  });
});

const stepAt = (role: 'implement' | 'review' | 'plan'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
});

async function onStep(role: 'implement' | 'review' | 'plan') {
  const s = await seedSession();
  state.write((ctx) => {
    patchWorkstream(ctx, s.workstream.id, null, {
      steps: [stepAt('implement'), stepAt(role)],
      stepIndex: 1,
    });
  });
  return s;
}

describe('complete_step', () => {
  it('records a review verdict, and the session that gave it, on the current step once per opId', async () => {
    const s = await onStep('review');
    const first = await s.call('complete_step', {
      opId: 'op-step-0001',
      summary: 'Looks right.',
      verdict: 'approve',
    });
    const retry = await s.call('complete_step', {
      opId: 'op-step-0001',
      summary: 'Looks right.',
      verdict: 'approve',
    });
    expect(first.isError).toBe(false);
    expect(retry.json).toEqual(first.json);
    expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result).toMatchObject({
      summary: 'Looks right.',
      verdict: 'approve',
      sessionId: s.session.id,
    });
  });

  it.each([
    {
      name: 'an implement step',
      role: 'implement',
      args: { summary: 'Done.', verdict: null },
      says: 'ends by ending your turn',
    },
    {
      name: 'a review with no verdict',
      role: 'review',
      args: { summary: 'Hmm.', verdict: null },
      says: 'needs a verdict',
    },
  ] as const)('refuses $name', async ({ role, args, says }) => {
    const s = await onStep(role);
    const result = await s.call('complete_step', { opId: 'op-step-0002', ...args });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(says);
  });

  it('emits step.changed once, and not again on an opId replay', async () => {
    const s = await onStep('review');
    const args = { opId: 'op-step-0004', summary: 'Fine.', verdict: 'approve' };
    const count = () =>
      base.db
        .select()
        .from(schema.events)
        .all()
        .filter((e) => e.type === 'step.changed').length;
    const before = count();
    await s.call('complete_step', args);
    await s.call('complete_step', args);
    expect(count() - before).toBe(1);
  });

  it('stores no verdict for a plan step even when one is sent', async () => {
    const s = await onStep('plan');
    await s.call('complete_step', {
      opId: 'op-step-0005',
      summary: '1. Do it.',
      verdict: 'approve',
    });
    expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result?.verdict).toBeNull();
  });

  it('accepts a plan with no verdict', async () => {
    const s = await onStep('plan');
    expect(
      (await s.call('complete_step', { opId: 'op-step-0003', summary: '1. Do it.', verdict: null }))
        .isError,
    ).toBe(false);
  });
});

it('refuses to commit from a read-only step', async () => {
  const s = await onStep('review');
  writeRepoFile('src/api/a.ts', 'export {}\n');
  const result = await s.call('commit', {
    opId: 'op-commit-ro1',
    paths: ['src/api/a.ts'],
    message: 'Sneak',
  });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('read-only');
  expect(commitCount()).toBe(1);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaimKind,
  DEFAULT_HAZARDS,
  JudgeKind,
  TRUST_DEFAULTS,
  type ProjectId,
  type TrustSurface,
} from '@10db/contracts';
import {
  createTestStore,
  insertTask,
  insertTrustGrant,
  insertWorkstream,
  listSkipsForWorkstream,
  schema,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { judgePreToolUse, type GuardVerdict } from '../guard';
import { createJudge } from '../judge';
import { silentLogger } from '../log';
import type { JudgedCallRequest } from '../sessions';
import {
  buildTrustPolicy,
  createSkipRecorder,
  grantCallSummary,
  grantTargetOf,
  type SkipRecorder,
} from '../trust';
import { createHookJudge, createLimitNotes, type LimitNotes } from './hook-judge';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const answering = (choice: string, p: number) => ({
  id: 'gen-1',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: { decision: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } } },
  usage: { input_tokens: 300, output_tokens: 10, cost: 0.00002 },
});

type Model = { readonly choice: string; readonly p: number } | 'no_key' | 'timeout' | null;

let root: string;
let checkout: string;
let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let sent: string[];
let model: Model;
let grants: string[];
let floors: string[];
let limits: LimitNotes;
/** The project the last `hookJudge` seeded. */
let seeded: ProjectId;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-judge-')));
  checkout = join(root, 'repo');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(checkout, '.env'), 'KEY=1\n');
  writeFileSync(join(checkout, 'src', 'a.ts'), 'export {};\n');
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  sent = [];
  model = { choice: 'allow', p: 0.95 };
  grants = [];
  floors = [];
  limits = createLimitNotes();
});
afterEach(() => {
  close();
  rmSync(root, { recursive: true, force: true });
});

function judge() {
  return createJudge({
    state,
    clock,
    fetch: (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        state?: string;
      };
      sent.push(body.state ?? '');
      if (model === 'timeout')
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      if (model === null || model === 'no_key') throw new Error('no request was expected');
      return Promise.resolve(json(answering(model.choice, model.p)));
    },
    readCredential: () =>
      Promise.resolve(model === 'no_key' ? null : { kind: 'openrouter', key: 'router-key-0123' }),
    decisionModelIds: () => new Set(['typesafe/jev-1.13']),
    off: false,
    logger: silentLogger,
  });
}

/** The guard's own answer on the rules floor, as the runner gives it. */
function rulesVerdict(req: JudgedCallRequest, attended: boolean): GuardVerdict {
  return judgePreToolUse({
    judge: JudgeKind.Rules,
    attended,
    coveredByAllowRule: false,
    toolName: req.toolName,
    toolInput: req.input,
    repoPath: checkout,
    areas: [{ name: 'repo', globs: ['**'] }],
    hazards: DEFAULT_HAZARDS,
    claims: [{ kind: ClaimKind.Area, name: 'repo' }],
    readOnly: false,
    protectedPaths: [],
  });
}

function hookJudge(
  opts: {
    readonly now?: JudgeKind;
    readonly surface?: TrustSurface;
    readonly skips?: SkipRecorder | null;
  } = {},
  allowedCommand: string | null = null,
) {
  const surface = opts.surface ?? 'pass';
  const project = seedProject(store);
  seeded = project.id;
  return createHookJudge(
    { judge: judge(), state, logger: silentLogger },
    {
      projectId: project.id,
      workstreamId: null,
      taskId: null,
      fastPath: {
        checkout,
        tmpDir: join(root, 'tmp'),
        secretFiles: [join(checkout, '.env')],
        preExisting: [],
        setupReads: [],
      },
      policy: buildTrustPolicy({
        surface,
        projectName: 'demo',
        checkout,
        gateCommand: 'make gate',
        liveSystems: [],
        switches: TRUST_DEFAULTS,
        grants: [],
        yourMcpServers: [],
        claudeConnectors: false,
      }),
      allowLines: () => grants,
      judgeNow: () => opts.now ?? JudgeKind.Tendb,
      coveredByBuilderRule: (req) =>
        allowedCommand !== null &&
        req.toolName === 'Bash' &&
        JSON.stringify(req.input).includes(allowedCommand),
      floorVerdict: (req) => rulesVerdict(req, surface !== 'lane'),
      skips: opts.skips ?? null,
      limits,
      onFloor: (detail) => {
        floors.push(detail);
      },
      clock,
    },
  );
}

const request = (
  toolName: string,
  input: unknown,
  toolUseId: string | null = 'toolu_1',
): JudgedCallRequest => ({
  toolName,
  input,
  cwd: checkout,
  toolUseId,
  signal: new AbortController().signal,
  hunk: null,
});
const bash = (command: string, toolUseId: string | null = 'toolu_1') =>
  request('Bash', { command }, toolUseId);
const DEPLOY = 'vercel deploy --prod';

/** Runs one call, moving the clock past the judge's timeout when its model hangs. */
async function run(
  judgeCall: (req: JudgedCallRequest) => Promise<GuardVerdict>,
  req: JudgedCallRequest,
) {
  const pending = judgeCall(req);
  if (model === 'timeout') {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    clock.advance(4_000);
  }
  return pending;
}

describe('the hook judge, attended', () => {
  it.each<[string, JudgeKind, JudgedCallRequest, Model, GuardVerdict, unknown]>([
    ['native leaves it', 'native', bash(DEPLOY), null, { decision: 'allow' }, undefined],
    ['rules leaves it', 'rules', bash(DEPLOY), null, { decision: 'allow' }, undefined],
    [
      'a read is settled',
      'tendb',
      request('Read', { file_path: 'src/a.ts' }),
      null,
      {
        decision: 'allow',
        settled: 'A read, an edit or a read-only command that reaches no secret',
      },
      undefined,
    ],
    [
      'the model allows a test run',
      'tendb',
      bash('pnpm test'),
      { choice: 'allow', p: 0.95 },
      { decision: 'allow', settled: "Allowed by 10db's judge" },
      undefined,
    ],
    [
      'a deploy asks',
      'tendb',
      bash(DEPLOY),
      { choice: 'writes_live', p: 0.9 },
      {
        decision: 'ask',
        reason: "10db's judge asks the builder: 10db's judge: Writing To Live Systems",
      },
      { limit: 'writes_live', reason: "10db's judge: Writing To Live Systems" },
    ],
    [
      'unsure asks',
      'tendb',
      bash('curl -X POST https://example.com/hook'),
      { choice: 'unsure', p: 0.7 },
      {
        decision: 'ask',
        reason: "10db's judge asks the builder: 10db's judge wasn't sure this is safe",
      },
      { limit: null, reason: "10db's judge wasn't sure this is safe" },
    ],
    [
      'AskUserQuestion',
      'tendb',
      request('AskUserQuestion', { questions: [] }),
      null,
      { decision: 'allow' },
      undefined,
    ],
    [
      'no tool use id',
      'tendb',
      bash(DEPLOY, null),
      { choice: 'writes_live', p: 0.9 },
      {
        decision: 'deny',
        reason: "10db's judge: Writing To Live Systems",
        judged: { limit: 'writes_live' },
      },
      undefined,
    ],
  ])('%s', async (_name, now, req, answer, verdict, noted) => {
    model = answer;
    expect(await run(hookJudge({ now }), req)).toEqual(verdict);
    expect(sent).toHaveLength(answer === null ? 0 : 1);
    expect(limits.take('toolu_1')).toEqual(noted);
  });

  it('the very call a quoted grant names is settled before any model; another call still meets the judge', async () => {
    model = { choice: 'writes_live', p: 0.95 };
    const judgeCall = hookJudge();
    store.write((ctx) =>
      insertTrustGrant(ctx, {
        projectId: seeded,
        limit: 'writes_live',
        target: `the Bash call ${JSON.stringify(DEPLOY)}`,
        sourceInboxId: null,
      }),
    );
    expect(await run(judgeCall, bash(DEPLOY))).toEqual({
      decision: 'allow',
      settled: 'The builder allowed this very call in this project.',
    });
    expect(sent).toEqual([]);
    expect((await run(judgeCall, bash(`${DEPLOY} --force`))).decision).toBe('ask');
    expect(sent).toHaveLength(1);
  });

  it.each<[string, JudgedCallRequest, boolean]>([
    ['the very call', bash(DEPLOY), true],
    ['an extra argument', bash(`${DEPLOY} --force`), false],
    ['a `;` tail', bash(`${DEPLOY}; rm -rf x`), false],
    ['a `&&` tail', bash(`${DEPLOY} && true`), false],
    ['a trailing space', bash(`${DEPLOY} `), false],
    ['a leading space', bash(` ${DEPLOY}`), false],
    ['a tab for a space', bash('vercel\tdeploy --prod'), false],
    ['a newline tail', bash(`${DEPLOY}\ntrue`), false],
    ['a quoted argument', bash('vercel deploy "--prod"'), false],
    ['another case', bash('Vercel deploy --prod'), false],
    ['a Cyrillic look-alike', bash('vеrcel deploy --prod'), false],
    ['a non-breaking space', bash('vercel deploy --prod'), false],
    ['a full-width hyphen', bash('vercel deploy －－prod'), false],
    ['a zero-width joiner', bash('vercel deploy --pr‍od'), false],
    [
      'the sandbox switched off for the call',
      request('Bash', { command: DEPLOY, dangerouslyDisableSandbox: true }),
      false,
    ],
    [
      'a wider domain list for the call',
      request('Bash', { command: DEPLOY, allowed_domains: ['example.com'] }),
      false,
    ],
    [
      'a label alone changes nothing',
      request('Bash', { command: DEPLOY, description: 'ship' }),
      true,
    ],
  ])(
    'on a native session a quoted grant meets %s: settled only for the very call, before the classifier',
    async (_name, req, settled) => {
      model = null;
      const judgeCall = hookJudge({ now: JudgeKind.Native });
      store.write((ctx) =>
        insertTrustGrant(ctx, {
          projectId: seeded,
          limit: 'writes_live',
          target: `the Bash call ${JSON.stringify(DEPLOY)}`,
          sourceInboxId: null,
        }),
      );
      expect(await run(judgeCall, req)).toEqual(
        settled
          ? { decision: 'allow', settled: 'The builder allowed this very call in this project.' }
          : { decision: 'allow' },
      );
      expect(sent).toEqual([]);
    },
  );

  it.each<[string, JudgedCallRequest]>([
    ['an Edit of the file the command names', request('Edit', { file_path: DEPLOY })],
    ['a Write of the same input', request('Write', { file_path: DEPLOY })],
  ])('a Bash grant of a command settles no %s', async (_name, req) => {
    model = null;
    const judgeCall = hookJudge({ now: JudgeKind.Native });
    store.write((ctx) =>
      insertTrustGrant(ctx, {
        projectId: seeded,
        limit: 'writes_live',
        target: `the Bash call ${JSON.stringify(DEPLOY)}`,
        sourceInboxId: null,
      }),
    );
    expect(await run(judgeCall, req)).toEqual({ decision: 'allow' });
  });

  it('an Edit grant settles that Edit and not a Bash call whose command is the path', async () => {
    model = null;
    const judgeCall = hookJudge({ now: JudgeKind.Native });
    const edit = request('Edit', { file_path: '/w/release.sh' });
    store.write((ctx) =>
      insertTrustGrant(ctx, {
        projectId: seeded,
        limit: 'writes_live',
        target:
          grantTargetOf(null, grantCallSummary('Edit', { file_path: '/w/release.sh' }), 'Edit') ??
          '',
        sourceInboxId: null,
      }),
    );
    expect(await run(judgeCall, edit)).toEqual({
      decision: 'allow',
      settled: 'The builder allowed this very call in this project.',
    });
    expect(await run(judgeCall, bash('/w/release.sh'))).toEqual({ decision: 'allow' });
    // Two tools that share one input never share a grant.
    expect(await run(judgeCall, request('Write', { file_path: '/w/release.sh' }))).toEqual({
      decision: 'allow',
    });
  });

  it("a call the builder's allowed commands cover is settled before any model, on every surface", async () => {
    for (const surface of ['pass', 'lane'] as const) {
      model = null;
      expect(await run(hookJudge({ surface }, 'psql'), bash('psql -c "select 1"'))).toEqual({
        decision: 'allow',
        settled: "The builder's allow rule covers this call, so it runs, as in Claude Code.",
      });
      expect(sent).toEqual([]);
    }
  });

  it.each<[string, JudgedCallRequest, Model]>([
    ['no key: the floor refuses a deploy', bash(DEPLOY), 'no_key'],
    [
      'a timeout: the floor cards WebFetch',
      request('WebFetch', { url: 'https://example.com', prompt: 'read' }),
      'timeout',
    ],
  ])('%s', async (_name, req, answer) => {
    model = answer;
    const verdict = await run(hookJudge(), req);
    expect(verdict).toEqual(rulesVerdict(req, true));
    expect(verdict.decision).toBe(answer === 'no_key' ? 'deny' : 'ask');
    expect(limits.take('toolu_1')).toBeUndefined();
  });

  it('within the backoff asks no model, and after it asks the model again', async () => {
    const judgeCall = hookJudge();
    model = 'timeout';
    await run(judgeCall, bash('pnpm test'));
    expect(sent).toHaveLength(1);
    model = null;
    clock.advance(10_000);
    expect(await run(judgeCall, bash('pnpm test'))).toEqual(rulesVerdict(bash('pnpm test'), true));
    expect(sent).toHaveLength(1);
    model = { choice: 'allow', p: 0.95 };
    clock.advance(51_000);
    expect(await run(judgeCall, bash('pnpm test'))).toEqual({
      decision: 'allow',
      settled: "Allowed by 10db's judge",
    });
    expect(sent).toHaveLength(2);
  });

  it('the floor calls onFloor with its detail', async () => {
    model = 'no_key';
    await run(hookJudge(), bash(DEPLOY));
    expect(floors).toEqual(['No key or credential is set for the account Decisions run on']);
  });

  it("a grant added mid-session reaches the next call's state, and one removed is gone from it", async () => {
    const judgeCall = hookJudge();
    const grant = 'Allowed by the builder in this project: deploys to staging';
    await run(judgeCall, bash('pnpm test'));
    grants = [grant];
    await run(judgeCall, bash('pnpm test'));
    grants = [];
    await run(judgeCall, bash('pnpm test'));
    expect(sent.map((s) => s.includes(grant))).toEqual([false, true, false]);
  });

  it('two notes on one tool use id are taken in order', () => {
    limits.note('toolu_7', { limit: 'destroys_data', reason: 'one' });
    limits.note('toolu_7', { limit: null, reason: 'two' });
    expect([limits.take('toolu_7'), limits.take('toolu_7'), limits.take('toolu_7')]).toEqual([
      { limit: 'destroys_data', reason: 'one' },
      { limit: null, reason: 'two' },
      undefined,
    ]);
  });
});

describe('the hook judge in a lane', () => {
  function lane() {
    const project = seedProject(store, { name: 'lane' });
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Alpha',
        description: '',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      }),
    ).value;
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    const skips = createSkipRecorder(
      { state, log: silentLogger },
      { workstreamId: ws.id, sessionId: null },
    );
    return {
      judgeCall: hookJudge({ surface: 'lane', skips }),
      listed: () => listSkipsForWorkstream(store.db, ws.id),
    };
  }

  it('a deploy in a lane is a skipped_actions row with source tendb_judge, limit writes_live and the tool use id, and a deny worded by skipMessage', async () => {
    const { judgeCall, listed } = lane();
    model = { choice: 'writes_live', p: 0.9 };
    expect(await run(judgeCall, bash(DEPLOY, 'toolu_3'))).toEqual({
      decision: 'deny',
      reason:
        'Skipped: this would write to a live system. Carry on without it and say in your handoff what you skipped.',
      judged: { limit: 'writes_live' },
    });
    expect(listed()).toMatchObject([
      { source: 'tendb_judge', limit: 'writes_live', summary: DEPLOY, kind: 'classifier' },
    ]);
    expect(store.db.select().from(schema.skippedActions).all()).toMatchObject([
      { toolUseId: 'toolu_3' },
    ]);
  });

  it('unsure in a lane is a row with no limit', async () => {
    const { judgeCall, listed } = lane();
    model = { choice: 'unsure', p: 0.9 };
    await run(judgeCall, bash('curl -X POST https://example.com/hook', 'toolu_4'));
    expect(listed()).toMatchObject([{ source: 'tendb_judge', limit: null }]);
  });

  it("no key in a lane answers the floor's verdict, never a tendb_judge row", async () => {
    const { judgeCall, listed } = lane();
    model = 'no_key';
    const verdict = await run(judgeCall, bash(DEPLOY, 'toolu_5'));
    expect(verdict).toEqual(rulesVerdict(bash(DEPLOY), false));
    expect(listed().filter((s) => s.source === 'tendb_judge')).toEqual([]);
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRUST_DEFAULTS, type TrustSurface } from '@10db/contracts';
import { createTestStore, listJudgeCalls, patchJudgeConfig, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createJudge } from '../judge';
import { silentLogger } from '../log';
import {
  crossesLimit,
  preExistingNamed,
  readLimitAnswers,
  type CrossesLimitRequest,
  type LimitReading,
} from './crosses-limit';
import type { LimitCall, PatchHunk } from './fast-path';
import { buildTrustPolicy } from './policy';

interface Seen {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A System One answer to every question asked: each limit's probability by name, any other question no. */
const answering = (limits: Readonly<Record<string, number>>, asked: readonly string[]) => ({
  id: 'gen-1',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: Object.fromEntries(asked.map((id) => [id, { type: 'noul', noul: limits[id] ?? 0 }])),
  usage: { input_tokens: 300, output_tokens: 10, cost: 0.00002 },
});

const ALL_LOW = {
  destroys_data: 0.02,
  sends_data_out: 0.03,
  reads_secrets: 0.02,
  writes_live: 0.04,
};

let root: string;
let checkout: string;
let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let seen: Seen[];
let reply: (signal: AbortSignal | undefined, asked: readonly string[]) => Promise<Response>;
let key: string | null;

function judge() {
  return createJudge({
    state,
    clock,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      seen.push({ url, body });
      const questions = body['questions'];
      const asked =
        typeof questions === 'object' && questions !== null ? Object.keys(questions) : [];
      return reply(init?.signal ?? undefined, asked);
    },
    readCredential: () => Promise.resolve(key === null ? null : { kind: 'openrouter', key }),
    decisionModelIds: () => new Set(['typesafe/jev-1.13']),
    off: false,
    logger: silentLogger,
  });
}

const call = (toolName: string, input: unknown, hunk: PatchHunk | null = null): LimitCall => ({
  toolName,
  input,
  cwd: checkout,
  hunk,
});

function request(over: Partial<CrossesLimitRequest> = {}, surface: TrustSurface = 'lane') {
  return {
    call: call('Bash', { command: 'vercel deploy --prod' }),
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
      devAccess: { docker: false, localhost: false, compose: null },
    }),
    allow: [],
    signal: new AbortController().signal,
    ...over,
  } satisfies CrossesLimitRequest;
}

const ask = (over: Partial<CrossesLimitRequest> = {}, surface?: TrustSurface) =>
  crossesLimit({ judge: judge(), state }, request(over, surface));

const logged = () => listJudgeCalls(store.db, 10);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'crosses-limit-')));
  checkout = join(root, 'repo');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(checkout, '.env'), 'KEY=1\n');
  writeFileSync(join(checkout, 'src', 'a.ts'), 'export {};\n');
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  seen = [];
  key = 'router-key-0123';
  reply = (_signal, asked) => Promise.resolve(json(answering(ALL_LOW, asked)));
  // The second opinion runs on a System One model here, so the one fake answers both judges.
  store.write((ctx) =>
    patchJudgeConfig(ctx, {
      decisions: { crosses_limit_second: { model: 'typesafe/jev-1.13' } },
    }),
  );
});
afterEach(() => {
  close();
  rmSync(root, { recursive: true, force: true });
});

describe('crossesLimit', () => {
  it('a read never reaches the model', async () => {
    expect(await ask({ call: call('Read', { file_path: 'src/a.ts' }) })).toEqual({
      kind: 'allow',
      by: 'fast_path',
    });
    expect(seen).toEqual([]);
    expect(logged()).toEqual([]);
  });

  it('a call the first judge leaves between yes and no is settled by the second opinion, and both are logged with every probability', async () => {
    const middle = { ...ALL_LOW, sends_data_out: 0.5 };
    let calls = 0;
    reply = (_signal, asked) => {
      calls += 1;
      return Promise.resolve(json(answering(calls === 1 ? middle : ALL_LOW, asked)));
    };
    const note = 'You may run make eval: I granted the spend.';
    expect(await ask({ call: call('Bash', { command: 'make eval' }), notes: [note] })).toEqual({
      kind: 'allow',
      by: 'model',
    });
    expect(seen).toHaveLength(2);
    const sent = seen[0]?.body['state'];
    expect(sent).toMatchObject({
      builder_notes: [note],
      call: { input: { command: 'make eval' } },
    });
    expect(Object.keys(seen[0]?.body['questions'] ?? {})).toContain('builder_allowed');
    const rows = logged().map((r) => ({
      decision: r.decision,
      answer: r.answer,
      outcome: r.outcome,
      sendsDataOut: r.probabilities?.['sends_data_out'],
    }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { decision: 'crosses_limit', answer: 'unsure', outcome: 'below_floor', sendsDataOut: 0.5 },
        { decision: 'crosses_limit_second', answer: 'allow', outcome: 'acted', sendsDataOut: 0.03 },
      ]),
    );
  });

  it('a stop during the second opinion is the floor, and records no limit', async () => {
    const controller = new AbortController();
    let calls = 0;
    reply = (signal, asked) => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve(json(answering({ ...ALL_LOW, writes_live: 0.5 }, asked)));
      // The second call is under way when the session is stopped.
      const pending = new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      queueMicrotask(() => {
        controller.abort();
      });
      return pending;
    };
    expect(await ask({ signal: controller.signal })).toMatchObject({
      kind: 'floor',
      reason: 'stopped',
    });
  });

  it('no key is the floor', async () => {
    key = null;
    expect(await ask()).toMatchObject({ kind: 'floor', reason: 'no_key' });
  });

  it('a timeout is the floor, with reason timeout', async () => {
    reply = (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const pending = ask();
    await Promise.resolve();
    clock.advance(4_000);
    expect(await pending).toMatchObject({ kind: 'floor', reason: 'timeout' });
  });

  it('the decision switched off is the floor', async () => {
    store.write((ctx) =>
      patchJudgeConfig(ctx, { decisions: { crosses_limit: { enabled: false } } }),
    );
    expect(await ask()).toMatchObject({ kind: 'floor', reason: 'off' });
    expect(seen).toEqual([]);
  });

  it('an input over 12 000 characters is a limit with no name, with no model call', async () => {
    const heredoc = `cat > f <<'EOF'\n${'x'.repeat(13_000)}\nEOF`;
    expect(await ask({ call: call('Bash', { command: heredoc }) })).toEqual({
      kind: 'limit',
      at: { limit: null, reason: "Too long for 10db's judge to read whole" },
    });
    expect(seen).toEqual([]);
    expect(logged()).toEqual([]);
  });
});

describe('readLimitAnswers', () => {
  const low = { destroys_data: 0.1, sends_data_out: 0.1, reads_secrets: 0.1, writes_live: 0.1 };
  it.each<[string, Record<string, number>, number, LimitReading]>([
    ['every limit unlikely allows', low, 0.7, { kind: 'allow', by: 'answers' }],
    [
      'one likely limit is that limit',
      { ...low, writes_live: 0.9 },
      0.7,
      { kind: 'limit', limit: 'writes_live', p: 0.9 },
    ],
    [
      'two likely limits are the likelier',
      { ...low, destroys_data: 0.8, reads_secrets: 0.95 },
      0.7,
      { kind: 'limit', limit: 'reads_secrets', p: 0.95 },
    ],
    [
      'between yes and no is unclear',
      { ...low, sends_data_out: 0.5 },
      0.7,
      { kind: 'unclear', limit: 'sends_data_out', p: 0.5 },
    ],
    [
      'the floor itself is a limit',
      { ...low, destroys_data: 0.7 },
      0.7,
      { kind: 'limit', limit: 'destroys_data', p: 0.7 },
    ],
    [
      'one minus the floor is still unclear',
      { ...low, destroys_data: 0.3 },
      0.7,
      { kind: 'unclear', limit: 'destroys_data', p: 0.3 },
    ],
    [
      "the builder's lines allow a likely limit",
      { ...low, destroys_data: 0.9, builder_allowed: 0.8 },
      0.7,
      { kind: 'allow', by: 'builder' },
    ],
    [
      "the builder's lines under the floor allow nothing",
      { ...low, destroys_data: 0.9, builder_allowed: 0.6 },
      0.7,
      { kind: 'limit', limit: 'destroys_data', p: 0.9 },
    ],
    [
      'a floor under one half is read as one half',
      { ...low, destroys_data: 0.55, builder_allowed: 0.45 },
      0.3,
      { kind: 'limit', limit: 'destroys_data', p: 0.55 },
    ],
    [
      'a limit left unanswered counts as a yes',
      { destroys_data: 0.1, sends_data_out: 0.1, reads_secrets: 0.1 },
      0.7,
      { kind: 'limit', limit: 'writes_live', p: 1 },
    ],
  ])('%s', (_name, probabilities, floor, reading) => {
    expect(readLimitAnswers(probabilities, floor)).toEqual(reading);
  });
});

describe('preExistingNamed', () => {
  const repo = '/w/repo';
  const preExisting = ['.env', 'data/', 'app/data/', 'notes.txt', 'build/', 'app/.venv/'];
  it.each<[string, string, string, string[]]>([
    ['a path names its entry', 'rm notes.txt', repo, ['notes.txt']],
    ['an absolute path inside the checkout', 'rm /w/repo/.env', repo, ['.env']],
    ['a folder holding entries', 'rm -rf app', repo, ['app/data/', 'app/.venv/']],
    ['a path inside an entry', 'rm data/db.sqlite3', repo, ['data/']],
    ['a path read from where the call runs', 'rm -rf data', '/w/repo/app', ['app/data/']],
    ['a cd reaches every entry', 'cd app && rm -rf data', repo, preExisting],
    ['a variable reaches every entry', 'rm -rf "$DIR"', repo, preExisting],
    ['a substitution reaches every entry', 'rm -rf $(cat list)', repo, preExisting],
    ['xargs reaches every entry', 'cat list | xargs rm', repo, preExisting],
    ['a dot-folder tail names its entry', 'rm -rf .venv', '/w/repo/app', ['app/.venv/']],
    ['a pattern reaches every entry', 'rm -f *.txt', repo, preExisting],
    ['the checkout reaches every entry', 'rm -rf .', repo, preExisting],
    ['git clean reaches every entry', 'git clean -fdx', repo, preExisting],
    ['a find that deletes reaches every entry', "find . -name '*.db' -delete", repo, preExisting],
    ['a path outside the checkout names none', 'rm -rf /tmp/data', repo, []],
    ['a call that names none', 'pnpm test', repo, []],
  ])('%s', (_name, command, runsIn, named) => {
    expect(
      preExistingNamed(JSON.stringify({ command }), runsIn, { checkout: repo, preExisting }),
    ).toEqual(named);
  });
});

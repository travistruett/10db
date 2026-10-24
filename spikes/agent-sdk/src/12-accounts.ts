// Spike 12 (accounts spec §10): billing identities per config directory and per keyed kind.
//   identity            two subscription config dirs stay separate and report their own account
//   identity-one        one subscription: a second config dir and the default login work side by side
//   refresh             four long-lived lanes on one config dir across an OAuth token refresh
//   keyed <kind>        bedrock | gateway | api_key: the env names, apiKeySource, apiProvider and model
// Secrets for keyed kinds come from the login Keychain (service 10db-spike, account <kind>), read in
// process and never printed. Emails are masked in all output.
// `refresh` reads the refresh dir's own stored OAuth credential (never the default login's) in process each
// cycle and keeps only its expiry and a short hash of the access token.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { query, type AccountInfo, type CanUseTool, type Options, type SDKMessage, type SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CLAUDE } from './claude.ts';
import { buildChildEnv } from './env.ts';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info, outPath, partial } from './report.ts';

const SPIKE_HOME = join(homedir(), '.10db-spike');
const DIR_A = process.env.SPIKE_DIR_A ?? join(SPIKE_HOME, 'a', 'claude');
const DIR_B = process.env.SPIKE_DIR_B ?? join(SPIKE_HOME, 'b', 'claude');
const denyAll: CanUseTool = async () => ({ behavior: 'deny', message: 'No tools in this probe.' });
const repo = makeFixtureRepo();

function mask(email: string | undefined): string {
  if (!email) return 'none';
  const [user = '', domain = ''] = email.split('@');
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 8);
  return `${user.slice(0, 2)}…@${domain} #${digest}`;
}

type Seen = {
  label: string;
  email: string | undefined;
  organization: string | undefined;
  apiProvider: string | undefined;
  accountKeySource: string | undefined;
  subscriptionType: string | undefined;
  tokenSource: string | undefined;
  initKeySource: string | undefined;
  initModel: string | undefined;
  version: string | undefined;
  resultSubtype: string | undefined;
  error: string | undefined;
};

function printable(s: Seen) {
  return { ...s, email: mask(s.email), organization: s.organization ? `set #${createHash('sha256').update(s.organization).digest('hex').slice(0, 8)}` : 'none' };
}

function options(env: Record<string, string>, extra: Partial<Options> = {}): Options {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('TIMEOUT: probe exceeded 180 s')), 180_000).unref();
  return {
    cwd: repo,
    pathToClaudeCodeExecutable: CLAUDE.path,
    env,
    settingSources: ['project'],
    strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    model: 'haiku',
    effort: 'low',
    maxTurns: 1,
    maxBudgetUsd: 0.5,
    persistSession: false,
    canUseTool: denyAll,
    abortController: controller,
    ...extra,
  };
}

// A not-logged-in turn still ends in a result with subtype 'success'; the error is on the assistant message.
const succeeded = (s: Seen) => s.resultSubtype === 'success' && s.error === undefined;

/** One session: accountInfo before the prompt, then one tiny turn for init and the result. */
async function observe(label: string, env: Record<string, string>, extra: Partial<Options> = {}): Promise<Seen> {
  const q = query({ prompt: 'Reply with the single word ready. Use no tools.', options: options(env, extra) });
  const account: AccountInfo | undefined = await Promise.race([
    q.accountInfo().catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000).unref()),
  ]);
  let init: SDKSystemMessage | undefined;
  let resultSubtype: string | undefined;
  let error: string | undefined;
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') init = m;
      if (m.type === 'result') resultSubtype = m.subtype;
      if (m.type === 'assistant' && m.error !== undefined) error = String(m.error);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    label,
    email: account?.email,
    organization: account?.organization,
    apiProvider: account?.apiProvider,
    accountKeySource: account?.apiKeySource,
    subscriptionType: account?.subscriptionType,
    tokenSource: account?.tokenSource,
    initKeySource: init?.apiKeySource,
    initModel: init?.model,
    version: init?.claude_code_version,
    resultSubtype,
    error,
  };
}

function authStatus(configDir: string | undefined): unknown {
  const env = { ...buildChildEnv(), ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
  try {
    const out = execFileSync(CLAUDE.path, ['auth', 'status', '--json'], { env, encoding: 'utf8' });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    // Keep the shape, mask anything that looks like an email.
    const hide = (k: string, v: unknown) =>
      typeof v !== 'string' ? v : v.includes('@') ? mask(v) : /^org/i.test(k) ? `set #${createHash('sha256').update(v).digest('hex').slice(0, 8)}` : v;
    return JSON.parse(JSON.stringify(parsed, hide));
  } catch (e) {
    return { failed: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

const subEnv = (dir?: string) => ({ ...buildChildEnv(), ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}) });

async function identity(): Promise<void> {
  for (const dir of [DIR_A, DIR_B]) check(`config dir exists: ${dir}`, existsSync(dir), 'sign it in first');
  info('claude version', CLAUDE.version);
  for (const [label, dir] of [['default', undefined], ['A', DIR_A], ['B', DIR_B]] as const) info(`auth status ${label}`, authStatus(dir));

  const def = await observe('default', subEnv());
  const a1 = await observe('A', subEnv(DIR_A));
  const b1 = await observe('B', subEnv(DIR_B));
  for (const s of [def, a1, b1]) info(`seen ${s.label}`, printable(s));
  check('A reports an email', !!a1.email, mask(a1.email));
  check('B reports an email', !!b1.email, mask(b1.email));
  check('A and B report different accounts', !!a1.email && !!b1.email && a1.email !== b1.email, `${mask(a1.email)} vs ${mask(b1.email)}`);
  for (const s of [a1, b1]) {
    check(`${s.label} bills a subscription`, s.initKeySource === 'none' && s.apiProvider === 'firstParty' && !!s.subscriptionType, `${s.initKeySource} / ${s.apiProvider} / ${s.subscriptionType ?? 'none'}`);
    check(`${s.label} turn succeeded`, succeeded(s), s.error ?? s.resultSubtype ?? 'no result');
  }

  // Concurrently, and A again after B signed in: one shared Keychain entry would show B's account on A.
  const [a2, b2] = await Promise.all([observe('A concurrent', subEnv(DIR_A)), observe('B concurrent', subEnv(DIR_B))]);
  check('concurrent A keeps its account', !!a2.email && a2.email === a1.email && succeeded(a2), mask(a2.email));
  check('concurrent B keeps its account', !!b2.email && b2.email === b1.email && succeeded(b2), mask(b2.email));
  const def2 = await observe('default again', subEnv());
  check('the default login is unchanged', def2.email === def.email, `${mask(def.email)} → ${mask(def2.email)}`);
  finish();
}

/** One subscription only: A is signed into the same account as the default login, so emails can't tell them apart. */
async function identityOne(): Promise<void> {
  check(`config dir exists: ${DIR_A}`, existsSync(DIR_A), 'sign it in first');
  info('claude version', CLAUDE.version);
  for (const [label, dir] of [['default', undefined], ['A', DIR_A]] as const) info(`auth status ${label}`, authStatus(dir));

  const def = await observe('default', subEnv());
  const a1 = await observe('A', subEnv(DIR_A));
  for (const s of [def, a1]) {
    info(`seen ${s.label}`, printable(s));
    check(`${s.label} bills a subscription`, s.initKeySource === 'none' && s.apiProvider === 'firstParty' && !!s.subscriptionType, `${s.initKeySource} / ${s.apiProvider} / ${s.subscriptionType ?? 'none'}`);
    check(`${s.label} turn succeeded`, succeeded(s), s.error ?? s.resultSubtype ?? 'no result');
  }
  check('A reports the signed-in account', !!a1.email && a1.email === def.email, `${mask(a1.email)} vs ${mask(def.email)}`);

  const [def2, a2] = await Promise.all([observe('default concurrent', subEnv()), observe('A concurrent', subEnv(DIR_A))]);
  check('concurrent default succeeded', succeeded(def2), def2.error ?? def2.resultSubtype ?? 'no result');
  check('concurrent A succeeded', succeeded(a2), a2.error ?? a2.resultSubtype ?? 'no result');
  info('auth status default after', authStatus(undefined));
  partial('two different accounts stay separate', 'needs a second subscription');
  finish();
}

/** Lines in a debug file that mention an OAuth refresh, bucketed. */
function refreshLines(file: string): { total: number; failed: number; lock: number; sample: string[] } {
  if (!existsSync(file)) return { total: 0, failed: 0, lock: 0, sample: [] };
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => /oauth/i.test(l) && /refresh/i.test(l));
  return {
    total: lines.length,
    failed: lines.filter((l) => /fail|invalid_grant|compromised|waiting for a fresh login/i.test(l)).length,
    lock: lines.filter((l) => /lock/i.test(l)).length,
    sample: lines.slice(-3).map((l) => l.slice(0, 200)),
  };
}

// Only the two fields the probe keeps; everything else in the stored credential is ignored.
const StoredCredential = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1), expiresAt: z.number().int().positive() }),
});

type TokenStamp = { expiresAt: string; expiresAtMs: number; token: string };

/**
 * The stored credential's expiry and a 12-hex sha256 prefix of its access token. On macOS Claude Code keeps a
 * CLAUDE_CONFIG_DIR's credential in the login Keychain under `Claude Code-credentials-<sha256(dir) first 8 hex>`;
 * elsewhere, or when the Keychain is unavailable, in `<dir>/.credentials.json`. Errors never carry the secret.
 */
function readTokenStamp(configDir: string): TokenStamp | { error: string } {
  const rel = relative(SPIKE_HOME, configDir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { error: `refusing to read a credential outside ${SPIKE_HOME}` };
  let raw: string;
  const file = join(configDir, '.credentials.json');
  if (existsSync(file)) {
    raw = readFileSync(file, 'utf8');
  } else {
    const service = `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
    } catch (e) {
      const status = e instanceof Error && 'status' in e ? String(e.status) : 'none';
      const signal = e instanceof Error && 'signal' in e ? String(e.signal) : 'none';
      return { error: `security find-generic-password -s '${service}' failed: status ${status}, signal ${signal}` };
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'stored credential is not JSON' };
  }
  const parsed = StoredCredential.safeParse(json);
  if (!parsed.success) return { error: `stored credential has an unexpected shape at ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const { accessToken, expiresAt } = parsed.data.claudeAiOauth;
  return { expiresAt: new Date(expiresAt).toISOString(), expiresAtMs: expiresAt, token: createHash('sha256').update(accessToken).digest('hex').slice(0, 12) };
}

async function refresh(): Promise<void> {
  const dir = process.env.SPIKE_REFRESH_DIR ?? DIR_A;
  const lanes = Number(process.env.SPIKE_LANES ?? 4);
  const everyMs = Number(process.env.SPIKE_EVERY_S ?? 240) * 1000;
  const deadline = Date.now() + Number(process.env.SPIKE_HOURS ?? 10) * 3_600_000;
  info('refresh setup', { dir, lanes, everyS: everyMs / 1000, hours: Number(process.env.SPIKE_HOURS ?? 10), version: CLAUDE.version });
  mkdirSync(outPath('12-refresh'), { recursive: true });
  const debugFile = (i: number) => outPath(join('12-refresh', `lane-${i}.debug.log`));

  // One streaming conversation per lane, kept open for the whole run.
  type Lane = { push(text: string): void; turns: number; failures: string[] };
  const laneObjs: Lane[] = [];
  for (let i = 0; i < lanes; i++) {
    const pending: string[] = [];
    let wake: (() => void) | undefined;
    const lane: Lane = { turns: 0, failures: [], push: (t) => { pending.push(t); wake?.(); } };
    const input = (async function* () {
      for (;;) {
        const next = pending.shift();
        if (next !== undefined) yield { type: 'user' as const, message: { role: 'user' as const, content: next }, parent_tool_use_id: null, session_id: '' };
        else await new Promise<void>((r) => (wake = r));
      }
    })();
    const q = query({
      prompt: input,
      options: { ...options(subEnv(dir), { maxTurns: 10_000, maxBudgetUsd: 25, extraArgs: { 'debug-file': debugFile(i) } }), abortController: new AbortController() },
    });
    void (async () => {
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) {
          if (m.type === 'result') {
            lane.turns++;
            if (m.subtype !== 'success') lane.failures.push(`${new Date().toISOString()} ${m.subtype}`);
          }
          if (m.type === 'assistant' && m.error !== undefined) lane.failures.push(`${new Date().toISOString()} ${String(m.error)}`);
        }
        lane.failures.push(`${new Date().toISOString()} stream ended`);
      } catch (e) {
        lane.failures.push(`${new Date().toISOString()} ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    laneObjs.push(lane);
  }

  // Stops one cycle after the stored token changes or a refresh line appears, so every lane takes a turn on the new token.
  let cycle = 0;
  let freshFailures = 0;
  let unreadable = 0;
  let refreshedAt: number | undefined;
  let lastStamp: TokenStamp | undefined;
  let tokenChange: string | undefined;
  while (Date.now() < deadline && (refreshedAt === undefined || cycle <= refreshedAt)) {
    cycle++;
    for (const lane of laneObjs) lane.push(`Cycle ${cycle}: reply with the single word ok. Use no tools.`);
    const fresh = await observe(`fresh ${cycle}`, subEnv(dir), { extraArgs: { 'debug-file': outPath(join('12-refresh', `fresh.debug.log`)) } });
    if (!succeeded(fresh)) freshFailures++;
    const logs = [...laneObjs.keys()].map((i) => refreshLines(debugFile(i)));
    const now = new Date();
    const stamp = readTokenStamp(dir);
    if ('error' in stamp) unreadable++;
    info(`cycle ${cycle}`, {
      at: now.toISOString(),
      turns: laneObjs.map((l) => l.turns),
      laneFailures: laneObjs.map((l) => l.failures.length),
      fresh: fresh.resultSubtype ?? fresh.error,
      refreshLines: logs.map((l) => l.total),
      refreshFailures: logs.map((l) => l.failed),
      ...('error' in stamp ? { tokenError: stamp.error } : { expiresAt: stamp.expiresAt, token: stamp.token }),
    });
    if (!('error' in stamp)) {
      if (cycle === 1) info('token expires in', `${((stamp.expiresAtMs - now.getTime()) / 60_000).toFixed(1)} min (at ${stamp.expiresAt})`);
      if (lastStamp && tokenChange === undefined && (stamp.expiresAt !== lastStamp.expiresAt || stamp.token !== lastStamp.token)) {
        tokenChange = `${now.toISOString()} (cycle ${cycle}): expiresAt ${lastStamp.expiresAt} → ${stamp.expiresAt}, token ${lastStamp.token} → ${stamp.token}`;
        info('token changed', tokenChange);
      }
      lastStamp = stamp;
    }
    if (refreshedAt === undefined && (tokenChange !== undefined || logs.some((l) => l.total > 0) || refreshLines(outPath(join('12-refresh', 'fresh.debug.log'))).total > 0)) refreshedAt = cycle;
    await new Promise((r) => setTimeout(r, everyMs));
  }

  const logs = [...laneObjs.keys()].map((i) => refreshLines(debugFile(i)));
  const fresh = refreshLines(outPath(join('12-refresh', 'fresh.debug.log')));
  info('refresh log samples', logs.map((l) => l.sample));
  const sawLines = logs.some((l) => l.total > 0) || fresh.total > 0;
  const lineDetail = `lane lines ${logs.map((l) => l.total).join(',')}, fresh ${fresh.total}`;
  if (tokenChange !== undefined) check('a token refresh happened during the run', true, `stored token changed at ${tokenChange}; ${lineDetail}`);
  else if (sawLines) check('a token refresh happened during the run', true, lineDetail);
  else partial('a token refresh happened during the run', `stored token unchanged (expiresAt ${lastStamp?.expiresAt ?? 'unknown'}) and no refresh lines in any debug log; extend SPIKE_HOURS`);
  check('the stored credential was readable every cycle', unreadable === 0, `${unreadable} of ${cycle} unreadable`);
  check('no lane failed a turn', laneObjs.every((l) => l.failures.length === 0), JSON.stringify(laneObjs.map((l) => l.failures.slice(0, 3))));
  check('no fresh session failed', freshFailures === 0, `${freshFailures} of ${cycle}`);
  check('no refresh failures logged', logs.every((l) => l.failed === 0) && fresh.failed === 0, JSON.stringify(logs.map((l) => l.failed)));
  info('auth status after', authStatus(dir));
  finish();
}

function keychain(account: string): string | undefined {
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', '10db-spike', '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** An empty config dir, so no saved claude.ai login can become the active credential. */
function emptyConfigDir(kind: string): string {
  const dir = join(SPIKE_HOME, `keyed-${kind}`, 'claude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function keyed(kind: string): Promise<void> {
  const model = process.env.SPIKE_MODEL;
  info('claude version', CLAUDE.version);
  const runs: { label: string; env: Record<string, string> }[] = [];
  if (kind === 'bedrock') {
    const region = process.env.SPIKE_AWS_REGION;
    const profile = process.env.SPIKE_AWS_PROFILE;
    const bearer = keychain('bedrock');
    if (!region || (!profile && !bearer)) throw new Error('set SPIKE_AWS_REGION and SPIKE_AWS_PROFILE, or store a bearer token as 10db-spike/bedrock');
    const base = { ...buildChildEnv(), CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: region };
    if (profile) runs.push({ label: 'bedrock profile, empty config dir', env: { ...base, AWS_PROFILE: profile, CLAUDE_CONFIG_DIR: emptyConfigDir(kind) } });
    if (bearer) runs.push({ label: 'bedrock bearer, empty config dir', env: { ...base, AWS_BEARER_TOKEN_BEDROCK: bearer, CLAUDE_CONFIG_DIR: emptyConfigDir(kind) } });
  } else if (kind === 'gateway') {
    const baseUrl = process.env.SPIKE_GATEWAY_URL;
    const token = keychain('gateway');
    if (!baseUrl || !token) throw new Error('set SPIKE_GATEWAY_URL and store the token as 10db-spike/gateway');
    const base = { ...buildChildEnv(), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token };
    runs.push({ label: 'gateway, key unset, empty config dir', env: { ...base, CLAUDE_CONFIG_DIR: emptyConfigDir(kind) } });
    runs.push({ label: 'gateway, key empty string, empty config dir', env: { ...base, ANTHROPIC_API_KEY: '', CLAUDE_CONFIG_DIR: emptyConfigDir(kind) } });
    runs.push({ label: 'gateway, key unset, default config dir (saved login present)', env: base });
  } else if (kind === 'api_key') {
    const key = keychain('api_key');
    if (!key) throw new Error('store the key as 10db-spike/api_key');
    runs.push({ label: 'api key, empty config dir', env: { ...buildChildEnv(), ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: emptyConfigDir(kind) } });
  } else {
    throw new Error(`unknown kind ${kind}`);
  }
  for (const run of runs) {
    const seen = await observe(run.label, run.env, model ? { model } : {});
    info(`seen ${run.label}`, printable(seen));
    check(`${run.label}: turn succeeded`, succeeded(seen), seen.error ?? seen.resultSubtype ?? 'no result');
    if (model) check(`${run.label}: init.model equals the requested model`, seen.initModel === model, `${seen.initModel} vs ${model}`);
  }
  finish();
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'identity') await identity();
else if (mode === 'identity-one') await identityOne();
else if (mode === 'refresh') await refresh();
else if (mode === 'keyed' && arg) await keyed(arg);
else {
  console.error('usage: spike:12 identity | identity-one | refresh | keyed <bedrock|gateway|api_key>');
  process.exit(2);
}

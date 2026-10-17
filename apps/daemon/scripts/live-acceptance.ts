/**
 * The spec §1.3 scenario, live: three tasks on a disposable repo, real Claude Code sessions on the builder's
 * subscription, a forced handoff, a real question answered here or in the UI, a kill -9 mid-step and a
 * restart, then the automatic checks and a results note. Manual; never runs in CI.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  BillingMode,
  Effort,
  HealthResponse,
  InboxItemDto,
  MCP_APPROVAL_DETAIL,
  McpApprovalChoice,
  McpServerReview,
  McpServerStatusDto,
  McpTransport,
  McpVerdict,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { z } from 'zod';
import {
  claudeCodeVersion,
  renderAcceptanceReport,
  runAcceptanceChecks,
  sessionBaselines,
  type AcceptanceCheck,
} from './acceptance-checks';
import {
  DAEMON_STOP_TIMEOUT_MS,
  repoServerEnvKeys,
  stopChild,
  waitForExit,
} from './live-processes';

const Args = z.strictObject({
  model: z.string().min(1).default('sonnet'),
  effort: z.enum(Effort).default(Effort.Medium),
  port: z.coerce.number().int().min(1024).max(65535).default(4327),
  timeoutMinutes: z.coerce.number().int().min(5).max(180).default(60),
});
// `--timeout-minutes=60` becomes { timeoutMinutes: '60' }; Args validates every value.
const argv: unknown = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k?.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), v]),
);
const args = Args.parse(argv);

const root = resolve(import.meta.dirname, '../../..');
const work = mkdtempSync(join(tmpdir(), '10db-live-'));
const repo = join(work, 'repo');
const dataDir = join(work, 'data');
const token = randomBytes(32).toString('base64url');
const url = `http://127.0.0.1:${String(args.port)}`;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const say = (line: string): void => {
  console.log(`[live] ${line}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The repo's own MCP server, passed through to every session once approved: the public Mantine docs
 * server, read from 10db's own .mcp.json so the run always uses the pinned version. It needs no credentials.
 */
const REPO_MCP_SERVER = 'mantine';
const OwnMcp = z.object({
  mcpServers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()) })),
});
const ownServer = OwnMcp.parse(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')))
  .mcpServers[REPO_MCP_SERVER];
if (!ownServer) throw new Error(`10db's .mcp.json declares no ${REPO_MCP_SERVER} server`);
const REPO_MCP_COMMAND = { command: ownServer.command, args: ownServer.args };
const REPO_MCP_CONFIG = { mcpServers: { [REPO_MCP_SERVER]: REPO_MCP_COMMAND } };

const TASKS = [
  {
    title: 'Alpha haiku pair',
    area: 'alpha',
    description:
      'First read reference/sorting.txt and reference/hashing.txt in full, unless a handoff in your briefing says you already have. Then create src/alpha/one.md with a haiku about sorting and commit it with the 10db commit tool. Then create src/alpha/two.md with a haiku about hashing and commit it.',
  },
  {
    title: 'Beta greeting',
    area: 'beta',
    description:
      'Before writing anything, ask the builder with your question tool which greeting to use: Hello or Howdy. Then write src/beta/greeting.md containing only the chosen greeting and commit it.',
  },
  {
    title: 'Gamma notes',
    area: 'gamma',
    description:
      "Use the mantine MCP server's documentation tool to look up the Button component before writing. Then write src/gamma/notes.md listing three short facts about it, and commit it.",
  },
] as const;

/**
 * Alpha reads these before writing, so its first session crosses `handoffPct` with both haikus
 * still to do. A session starts near 2.3% of the 1M window and the small tasks alone stay under
 * 3%; each file adds about 20k tokens (2 points), under the Read tool's per-call token limit.
 */
const REFERENCE_LINES = 700;
const REFERENCES = {
  sorting: [
    'bubble sort compares adjacent items and swaps them when they are out of order.',
    'insertion sort grows a sorted prefix by sliding each new item back into place.',
    'merge sort splits the list in half, sorts each half and merges the two runs.',
    'quicksort partitions around a pivot and recurses into both sides of it.',
    'heapsort builds a max heap and repeatedly moves the largest item to the end.',
    'a stable sort keeps items with equal keys in the order they arrived in.',
    'counting sort tallies small integer keys instead of comparing items at all.',
    'timsort finds runs that are already ordered and merges them by size.',
  ],
  hashing: [
    'a hash function maps a key of any length to a fixed-size number.',
    'a hash table uses that number to pick the bucket that holds the key.',
    'two keys landing in one bucket is a collision, and chaining keeps a list there.',
    'open addressing probes the next free slot instead of keeping a list.',
    'the load factor is the number of keys divided by the number of buckets.',
    'a table resizes and rehashes every key once the load factor grows too high.',
    'a good hash spreads similar keys far apart so buckets stay evenly filled.',
    'lookups take constant time on average when the buckets stay short.',
  ],
} as const;

function referenceText(topic: keyof typeof REFERENCES): string {
  const facts = REFERENCES[topic];
  const lines = Array.from(
    { length: REFERENCE_LINES },
    (_, i) => `${topic} note ${String(i + 1).padStart(4, '0')}: ${facts[i % facts.length] ?? ''}`,
  );
  return `${lines.join('\n')}\n`;
}

function git(...a: string[]): string {
  return execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
}

function makeRepo(): void {
  mkdirSync(join(repo, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(repo, 'src', 'beta'), { recursive: true });
  mkdirSync(join(repo, 'src', 'gamma'), { recursive: true });
  for (const { area } of TASKS) writeFileSync(join(repo, 'src', area, '.gitkeep'), '');
  mkdirSync(join(repo, 'reference'));
  writeFileSync(join(repo, 'reference', 'sorting.txt'), referenceText('sorting'));
  writeFileSync(join(repo, 'reference', 'hashing.txt'), referenceText('hashing'));
  writeFileSync(
    join(repo, 'AGENTS.md'),
    '# Live acceptance repo\n\nA disposable repo for the 10db §1.3 run. Each task owns one folder under src/. Keep files short.\n',
  );
  // Every task runs this same gate, often while the others are still working or parked on a
  // question, so it checks only what must hold at every step: no .md is empty.
  writeFileSync(
    join(repo, 'check.sh'),
    `for f in $(find src -name "*.md"); do [ -s "$f" ] || { echo "empty: $f"; exit 1; }; done\necho "check ok"\n`,
  );
  writeFileSync(join(repo, '.mcp.json'), `${JSON.stringify(REPO_MCP_CONFIG, null, 2)}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.email', 'live@10db.invalid');
  git('config', 'user.name', '10db live acceptance');
  git(
    'add',
    '.mcp.json',
    'AGENTS.md',
    'check.sh',
    'reference/sorting.txt',
    'reference/hashing.txt',
    'src/alpha/.gitkeep',
    'src/beta/.gitkeep',
    'src/gamma/.gitkeep',
  );
  git('commit', '-q', '-m', 'Initial commit');
}

/** Variables that must not reach the daemon from this shell: its own TENDB_* settings and billing switches. */
const DROPPED_ENV = /^(?:TENDB_|ANTHROPIC_|CLAUDE_CODE_USE_|AWS_)/;

/** The daemon being run, so an abort can stop it and, with it, the real Claude sessions it owns. */
let daemon: ChildProcess | null = null;
// Read through a function: TypeScript would otherwise keep the narrowing from before the awaits.
const runningDaemon = (): ChildProcess | null => daemon;

/** Set once an interrupt starts stopping the daemon; the run loop must then do nothing more to it. */
let aborting = false;
const isAborting = (): boolean => aborting;

function startDaemonProcess(): ChildProcess {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !DROPPED_ENV.test(key)),
  );
  const child = spawn(process.execPath, [join(root, 'apps/daemon/dist/daemon.mjs')], {
    env: {
      ...inherited,
      TENDB_DATA_DIR: dataDir,
      TENDB_PORT: String(args.port),
      TENDB_DEV_UI_TOKEN: token,
      TENDB_LOG_LEVEL: 'info',
      // The daemon shuts down when this pipe closes, which is how it learns this script died.
      TENDB_PARENT_STDIN: '1',
    },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  say(`daemon started (pid ${String(child.pid)})`);
  daemon = child;
  return child;
}

async function api<T>(schema: z.ZodType<T>, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  const res = await fetch(`${url}${path}`, { ...init, headers });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${String(res.status)} ${await res.text()}`);
  return schema.parse(await res.json());
}

/**
 * Approves the repo's server through its approval card, the same card and answer the UI uses, before any
 * session starts. This script wrote the .mcp.json itself, so there is nothing a person would learn from
 * reading the card; the run instead checks that the card shows exactly that config before approving it.
 */
async function approveRepoMcp(projectId: string): Promise<void> {
  const review = () =>
    api(z.array(McpServerStatusDto), `/projects/${projectId}/mcp-servers/review`, {
      method: 'POST',
    });
  const [server, ...others] = await review();
  const expected = {
    name: REPO_MCP_SERVER,
    transport: McpTransport.Stdio,
    command: REPO_MCP_COMMAND.command,
    args: REPO_MCP_COMMAND.args,
    url: null,
    env: [],
    headers: [],
    variables: [],
    sensitive: [],
  };
  const shownOf = (r: McpServerReview | undefined) =>
    r && {
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: r.args,
      url: r.url,
      env: r.env,
      headers: r.headers,
      variables: r.variables,
      sensitive: r.sensitive,
    };
  if (
    others.length > 0 ||
    server === undefined ||
    server.inboxId === null ||
    JSON.stringify(shownOf(server)) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `the review doesn't show the .mcp.json this run wrote: ${JSON.stringify(shownOf(server))}`,
    );
  }
  // The card itself, as the UI reads it: its stored review and its `Runs:` line.
  const card = (await api(z.array(InboxItemDto), '/inbox?state=OPEN')).find(
    (c) => c.id === server.inboxId,
  );
  const stored = McpServerReview.safeParse(card?.detail?.[MCP_APPROVAL_DETAIL]);
  const runs = `Runs: ${[REPO_MCP_COMMAND.command, ...REPO_MCP_COMMAND.args].join(' ')}`;
  if (
    !card ||
    !stored.success ||
    JSON.stringify(shownOf(stored.data)) !== JSON.stringify(expected) ||
    !card.body.split('\n').includes(runs)
  ) {
    throw new Error(`the approval card doesn't show exactly "${runs}" with no variables`);
  }
  await api(InboxItemDto, `/inbox/${card.id}/answer`, {
    method: 'POST',
    body: JSON.stringify({ choice: McpApprovalChoice.Approve }),
  });
  if ((await review())[0]?.verdict !== McpVerdict.Approved)
    throw new Error(`${REPO_MCP_SERVER} is still not approved`);
  say(
    `approved ${REPO_MCP_SERVER} (${[REPO_MCP_COMMAND.command, ...REPO_MCP_COMMAND.args].join(' ')}) through its card`,
  );
}

/**
 * The env keys of the repo server the daemon's sessions started, read with `ps -E`, or null while none
 * runs. Only processes below the daemon count: another Claude Code window may run the same server.
 */
function serverEnvKeys(daemonPid: number): string[] | null {
  const ps = (...flags: string[]): string => execFileSync('ps', flags, { encoding: 'utf8' });
  return repoServerEnvKeys({
    tree: ps('-axo', 'pid=,ppid='),
    envListing: ps('-axww', '-E', '-o', 'pid=,command='),
    daemonPid,
  });
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        HealthResponse.parse(await res.json());
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error('the daemon did not answer /health within 20 s');
}

async function answerOpenCards(seen: Set<string>): Promise<void> {
  const cards = await api(z.array(InboxItemDto), '/inbox?state=OPEN');
  for (const card of cards.filter(
    (c) => !seen.has(c.id) && (c.kind === 'question' || c.kind === 'permission'),
  )) {
    seen.add(card.id);
    console.log(`\n[${card.kind}] ${card.title}\n${card.body}`);
    card.options.forEach((o, i) => {
      console.log(`  ${String(i + 1)}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
    });
    const raw = (
      await rl.question(
        'Answer with a number (optionally followed by a note), or press Enter to answer in the UI: ',
      )
    ).trim();
    if (!raw) continue;
    const [num, ...note] = raw.split(' ');
    const option = card.options[Number(num) - 1];
    if (!option) {
      say('not an option; answer it in the UI instead');
      continue;
    }
    await api(InboxItemDto, `/inbox/${card.id}/answer`, {
      method: 'POST',
      body: JSON.stringify(
        note.length > 0 ? { choice: option.label, note: note.join(' ') } : { choice: option.label },
      ),
    });
  }
}

async function main(): Promise<void> {
  say(`work dir: ${work}`);
  makeRepo();
  startDaemonProcess();
  await waitForHealth();
  say(
    `UI: VITE_DAEMON_URL=${url} VITE_DAEMON_TOKEN=${token} pnpm --filter @10db/desktop dev   (then open http://localhost:1420)`,
  );

  const project = await api(ProjectDto, '/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: 'live-acceptance',
      repoPath: repo,
      gateCommand: 'sh check.sh',
      maxLanes: 3,
      model: args.model,
      effort: args.effort,
      billingMode: BillingMode.Subscription,
      // The schema's minimums; Alpha's reference reading carries it past them (spec §1.3 point 2).
      handoffPct: 5,
      nudgePct: 6,
      humanWaitMinutes: 10,
      areas: TASKS.map((t) => ({ name: t.area, globs: [`src/${t.area}/**`] })),
    }),
  });
  await approveRepoMcp(project.id);
  for (const t of TASKS) {
    const task = await api(TaskDto, `/projects/${project.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: t.title,
        description: t.description,
        acceptanceCriteria: ['The file exists, is non-empty and is committed through 10db'],
        areas: [t.area],
      }),
    });
    await api(WorkstreamDto, `/tasks/${task.id}/start`, { method: 'POST', body: '{}' });
  }
  say(
    `three tasks started (${args.model} @ ${args.effort}); the repo's .mcp.json declares ${REPO_MCP_SERVER}, approved`,
  );

  const seen = new Set<string>();
  const deadline = Date.now() + args.timeoutMinutes * 60_000;
  let killed = false;
  let envKeys: string[] | null = null;
  for (;;) {
    if (isAborting()) break;
    if (Date.now() > deadline) {
      say('timed out; running the checks on what happened');
      break;
    }
    if (daemon?.pid !== undefined) envKeys ??= serverEnvKeys(daemon.pid);
    await answerOpenCards(seen);
    const all = await api(z.array(WorkstreamDto), '/workstreams?active=false');
    if (isAborting()) break;
    if (
      !killed &&
      git('log', '--format=%(trailers:key=10db-Op,valueonly)').trim() &&
      all.some((w) => w.state === 'RUNNING')
    ) {
      say(`kill -9 the daemon (pid ${String(daemon?.pid)}) mid-step`);
      daemon?.kill('SIGKILL');
      if (daemon) await waitForExit(daemon);
      killed = true;
      if (isAborting()) break;
      startDaemonProcess();
      await waitForHealth();
      say('daemon restarted; recovery runs at startup');
    }
    if (all.length === TASKS.length && all.every((w) => w.state === 'DONE')) {
      say('all three workstreams are DONE');
      break;
    }
    const failed = all.filter((w) => w.state === 'FAILED');
    if (failed.length > 0) {
      say(`FAILED: ${failed.map((w) => `${w.taskTitle}: ${w.failureReason ?? ''}`).join('; ')}`);
      break;
    }
    await sleep(2_000);
  }

  // An interrupt is already stopping the daemon and exits the process; no checks or note follow it.
  if (isAborting()) return;
  const manual: AcceptanceCheck[] = [];
  const reopened = (
    await rl.question(
      'Close the 10db window (or the browser tab), reopen it, and check the three tasks still show Done with no open question. Did it lose anything? [y = lost something / N = nothing lost]: ',
    )
  )
    .trim()
    .toLowerCase();
  manual.push({
    name: 'window close and reopen',
    ok: reopened !== 'y',
    detail:
      reopened === 'y' ? 'the builder saw lost state' : 'nothing lost (checked by the builder)',
  });

  if (daemon) await stopChild(daemon);
  // One shared log: the engine's lines and the Claude adapter's billing and MCP lines.
  const logPath = join(dataDir, 'logs', 'daemon.log');
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const checks = await runAcceptanceChecks({
    dbPath: join(dataDir, '10db.sqlite'),
    repoPath: repo,
    logText,
    minTasks: TASKS.length,
    mcpServer: REPO_MCP_SERVER,
    mcpServerEnvKeys: envKeys,
    outputs: ['src/alpha/one.md', 'src/alpha/two.md', 'src/beta/greeting.md', 'src/gamma/notes.md'],
  });
  const baseline = sessionBaselines(join(dataDir, '10db.sqlite'));
  const report = renderAcceptanceReport({
    checks,
    manual,
    meta: {
      Date: new Date().toISOString().slice(0, 10),
      Model: `${args.model} @ ${args.effort}`,
      'Claude Code': claudeCodeVersion(logText),
      Node: process.version,
      'Handoff threshold': '5% (nudge 6%)',
      'Repo MCP server': `${REPO_MCP_SERVER} (${REPO_MCP_COMMAND.args.join(' ')}, from the repo's .mcp.json, approved through its card)`,
      'Session baseline context': baseline
        ? `${String(baseline.min)}–${String(baseline.max)}% (first reading of ${String(baseline.sessions)} session(s))`
        : 'not measured',
      // The research notes test rejects home paths; a TMPDIR under the home folder would leak one.
      'Work dir': work.replace(homedir(), '~'),
    },
  });
  const out = join(root, 'docs/architecture/research/m1-live-acceptance.md');
  writeFileSync(out, report);
  for (const c of [...checks, ...manual]) say(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
  say(`wrote ${out}`);
  process.exitCode = [...checks, ...manual].every((c) => c.ok) ? 0 : 1;
}

/** Stops the daemon (and so its Claude sessions) and leaves with a failure. */
const abort = (why: string): void => {
  aborting = true;
  say(`${why}; stopping the daemon`);
  const current = runningDaemon();
  void (current ? stopChild(current) : Promise.resolve()).finally(() => {
    process.exit(1);
  });
};
// In raw mode readline swallows Ctrl-C and emits it here instead of raising SIGINT.
rl.on('SIGINT', () => {
  abort('interrupted');
});
process.on('SIGINT', () => {
  abort('interrupted');
});
process.on('SIGTERM', () => {
  abort('terminated');
});

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rl.close();
  const current = runningDaemon();
  if (current) await stopChild(current, DAEMON_STOP_TIMEOUT_MS);
}

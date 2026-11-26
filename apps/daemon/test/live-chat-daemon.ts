import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ChatDto,
  ConversationDto,
  ConversationItemDto,
  ConversationState,
  InboxItemDto,
  ProjectDto,
  type AccountInput,
} from '@10db/contracts';
import { z } from 'zod';
import { homeOutsideTemp, isolatedGitEnv, TEST_REPO_CONFIG, type TempDir } from './fixtures';

// The real daemon as a child process on a scratch data dir, driven over HTTP: a chat the way the app
// runs it, on whatever account is signed in on this Mac. Manual, never CI (TENDB_LIVE_CLAUDE and
// TENDB_LIVE_CODEX).

/** The variables that would bill another account, or that a test's git isolation set and a daemon must not see. */
const DROPPED_ENV =
  /^(?:TENDB_|ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|CLAUDECODE|CLAUDE_CODE_|GIT_|XDG_CONFIG_HOME$)/;

const DAEMON_DIR = join(import.meta.dirname, '..');
const POLL_MS = 500;
const TOKEN = 'live-chat-token-'.padEnd(40, 'x');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls `read` until it answers something, or fails at the deadline naming what was waited for. */
export async function until<T>(
  what: string,
  timeoutMs: number,
  read: () => Promise<T | null> | T | null,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await sleep(POLL_MS);
  }
}

export interface LiveDaemon {
  readonly work: TempDir;
  readonly repo: string;
  readonly url: string;
  api<T>(
    schema: z.ZodType<T>,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T>;
  /** Everything the daemon printed. */
  output(): string;
  stop(): Promise<void>;
}

export interface LiveDaemonOptions {
  /** The pinned Claude Code to run, in place of the one a daemon fetches into its data dir. */
  readonly claudePath?: string;
  /** Variables the daemon keeps although `DROPPED_ENV` would drop them (a Bedrock account's profile). */
  readonly keepEnv?: readonly string[];
  readonly prepareRepo?: (repo: string) => void;
}

/** Git in a disposable repository, with no config but its own. */
export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' });
}

/** A repository with one commit, and no identity of its own: a commit takes the builder's. */
export function makeLiveRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) gitIn(repo, 'config', key, value);
  writeFileSync(join(repo, 'README.md'), 'A disposable repository for a live check.\n');
  gitIn(
    repo,
    '-c',
    'user.name=live setup',
    '-c',
    'user.email=setup@10db.invalid',
    'add',
    'README.md',
  );
  gitIn(
    repo,
    '-c',
    'user.name=live setup',
    '-c',
    'user.email=setup@10db.invalid',
    'commit',
    '-q',
    '-m',
    'initial commit',
  );
}

/** The builder's own identity, read from their global git config for a comparison and never printed. */
export function builderIdentity(): { name: string; email: string } {
  const read = (key: string): string =>
    execFileSync('git', ['config', '--file', join(homedir(), '.gitconfig'), key], {
      encoding: 'utf8',
      env: isolatedGitEnv(),
    }).trim();
  return { name: read('user.name'), email: read('user.email') };
}

export async function startLiveDaemon(
  prefix: string,
  options: LiveDaemonOptions = {},
): Promise<LiveDaemon> {
  // Outside every temp root: 10db counts /tmp as lane-writable and refuses a checkout there.
  const work = homeOutsideTemp(prefix);
  const repo = join(work.path, 'repo');
  makeLiveRepo(repo);
  options.prepareRepo?.(repo);
  const dataDir = join(work.path, 'data');
  mkdirSync(dataDir);
  const kept = options.keepEnv ?? [];
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !DROPPED_ENV.test(name) || kept.includes(name)),
  );
  const logPath = join(work.path, 'daemon.out');
  writeFileSync(logPath, '');
  const log = createWriteStream(logPath, { flags: 'a' });
  const child: ChildProcess = spawn(join(DAEMON_DIR, 'node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: DAEMON_DIR,
    env: {
      ...inherited,
      TENDB_DATA_DIR: dataDir,
      TENDB_PORT: '0',
      TENDB_DEV_UI_TOKEN: TOKEN,
      TENDB_DEV_UI_ORIGIN: 'http://localhost:1420',
      TENDB_LOG_LEVEL: 'info',
      TENDB_BENCHMARKS: 'off',
      TENDB_CATALOGUE: 'off',
      TENDB_CATALOGUE_SNAPSHOT: join(DAEMON_DIR, 'test/fixtures/catalogue.json'),
      TENDB_JUDGE: 'off',
      TENDB_SLACK: 'off',
      TENDB_TAILSCALE: 'off',
      TENDB_WORKTREE_ROOT: join(work.path, 'worktrees'),
      // The daemon stops when this pipe closes, which is how it learns this test died.
      TENDB_PARENT_STDIN: '1',
      ...(options.claudePath === undefined ? {} : { TENDB_CLAUDE_PATH: options.claudePath }),
      ...Object.fromEntries(
        kept.flatMap((name) => (name in process.env ? [[name, process.env[name]]] : [])),
      ),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const stopped = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const stop = async (): Promise<void> => {
    child.stdin?.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    await stopped;
    clearTimeout(timer);
    // A pinned tool the daemon fetched is read-only, and rm stops at it.
    execFileSync('chmod', ['-R', 'u+w', work.path]);
    work.cleanup();
  };
  const output = (): string => readFileSync(logPath, 'utf8');
  try {
    const url = await until('the daemon to listen', 60_000, () => {
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output());
      return match?.[1] ?? null;
    });
    return {
      work,
      repo,
      url,
      output,
      stop,
      async api(schema, path, init = {}) {
        const res = await fetch(`${url}${path}`, {
          method: init.method ?? 'GET',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
        if (!res.ok)
          throw new Error(
            `${init.method ?? 'GET'} ${path} answered ${String(res.status)}: ${await res.text()}`,
          );
        // The daemon's own answer, checked by the contract's schema; a 204 has no body.
        return schema.parse(res.status === 204 ? undefined : await res.json());
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A project on `repo`, run on the account `accountId` names, or the default account. */
export async function addProject(
  daemon: LiveDaemon,
  accountId: string | null,
): Promise<z.infer<typeof ProjectDto>> {
  return daemon.api(ProjectDto, '/projects', {
    method: 'POST',
    body: {
      name: 'live-check',
      repoPath: daemon.repo,
      defaultRigor: 'light',
      gateCommand: 'true',
      areas: [{ name: 'repo', globs: ['**'] }],
      ...(accountId === null ? {} : { accountId }),
    },
  });
}

export async function addAccount(
  daemon: LiveDaemon,
  input: AccountInput,
): Promise<{ id: string; configDir: string | null }> {
  const created = await daemon.api(
    z.object({ account: z.looseObject({ id: z.string(), configDir: z.string().nullable() }) }),
    '/accounts',
    {
      method: 'POST',
      body: input,
    },
  );
  return created.account;
}

export async function openChat(
  daemon: LiveDaemon,
  projectId: string,
  model: string | null,
): Promise<z.infer<typeof ChatDto>> {
  return daemon.api(ChatDto, '/chats', {
    method: 'POST',
    body: { projectId, model, tabPosition: 0 },
  });
}

const Items = z.object({ items: z.array(ConversationItemDto) });
type Item = z.infer<typeof ConversationItemDto>;

export async function itemsOf(daemon: LiveDaemon, conversationId: string): Promise<Item[]> {
  return (await daemon.api(Items, `/conversations/${conversationId}/items`)).items;
}

/** Sends one message and waits for the turn to end; gives back the items it added. */
export async function sendAndWait(
  daemon: LiveDaemon,
  conversationId: string,
  text: string,
  folder: 'wait' | 'read_only' | null,
  timeoutMs = 300_000,
): Promise<Item[]> {
  const before = (await itemsOf(daemon, conversationId)).length;
  await daemon.api(z.looseObject({}), `/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { text, ...(folder === null ? {} : { folder }) },
  });
  try {
    await until('the turn to start and end', timeoutMs, async () => {
      const state = (await daemon.api(ConversationDto, `/conversations/${conversationId}`)).state;
      const items = await itemsOf(daemon, conversationId);
      const answered = items.slice(before).some((i) => i.kind === 'agent_message');
      const settled = state === ConversationState.IdleWarm || state === ConversationState.IdleCold;
      return settled && answered ? true : null;
    });
  } catch (error) {
    // A turn that never ends: say where it stands, so the cause is visible without a rerun.
    const state = (await daemon.api(ConversationDto, `/conversations/${conversationId}`)).state;
    const items = await itemsOf(daemon, conversationId);
    const cards = await openCards(daemon);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; state ${state}; items ${JSON.stringify(
        items
          .slice(before)
          .map((i) => [
            i.kind,
            'text' in i
              ? i.text.slice(0, 200)
              : i.kind === 'tool_call'
                ? `${i.call.kind} ${i.call.status}`
                : '',
          ]),
      )}; cards ${JSON.stringify(cards.map((c) => [c.kind, c.title]))}; errors ${daemon
        .output()
        .split('\n')
        .filter((line) => /error|warn/i.test(line))
        .slice(-5)
        .join(' | ')
        .slice(0, 1500)}`,
      { cause: error },
    );
  }
  return (await itemsOf(daemon, conversationId)).slice(before);
}

export async function openCards(daemon: LiveDaemon): Promise<z.infer<typeof InboxItemDto>[]> {
  return daemon.api(z.array(InboxItemDto), '/inbox?state=OPEN');
}

/** The MCP tool calls among items, by tool name. */
export function mcpCalls(items: readonly Item[]): { tool: string; status: string; text: string }[] {
  return items.flatMap((item) =>
    item.kind === 'tool_call' && item.call.kind === 'mcp'
      ? [
          {
            tool: item.call.tool,
            status: item.call.status,
            text: [item.call.resultTail, item.call.error, item.call.refusal]
              .filter((part): part is string => typeof part === 'string')
              .join(' | '),
          },
        ]
      : [],
  );
}

/**
 * The Claude Code this Mac runs, resolved from `PATH` (or `TENDB_CLAUDE_PATH`): the live checks run on
 * it so that nothing is fetched into the app's own tools folder.
 */
export function localClaude(): string {
  const set = process.env['TENDB_CLAUDE_PATH'];
  if (set !== undefined && set !== '') return set;
  const found = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
  return realpathSync(found);
}

/**
 * Waits for the daemon to finish fetching and checking its pinned Codex into the scratch data dir: a session that
 * starts first ends with "still being downloaded" and is not retried.
 */
export async function waitForPinnedCodex(daemon: LiveDaemon): Promise<void> {
  const tools = join(daemon.work.path, 'data', 'tools');
  await until('the pinned Codex to be installed', 300_000, () => {
    if (!existsSync(tools)) return null;
    const dir = readdirSync(tools).find((name) => name.startsWith('codex-'));
    return dir !== undefined && existsSync(join(tools, dir, '.pin.json')) ? true : null;
  });
}

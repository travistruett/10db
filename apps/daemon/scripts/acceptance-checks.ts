import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { z } from 'zod';

const run = promisify(execFile);

export interface AcceptanceCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const Count = z.object({ n: z.int() });
const LogLine = z.looseObject({
  msg: z.string().optional(),
  apiKeySource: z.string().optional(),
  apiProvider: z.string().optional(),
  subscriptionType: z.string().optional(),
  claudeCodeVersion: z.string().optional(),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
  passed: z.array(z.object({ name: z.string(), envKeys: z.array(z.string()) })).optional(),
});

function parseLogLines(logText: string): z.infer<typeof LogLine>[] {
  return logText.split('\n').flatMap((raw) => {
    try {
      const parsed = LogLine.safeParse(JSON.parse(raw));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** The Claude Code version the sessions logged, or `unknown`; reading it never fails the run. */
export function claudeCodeVersion(logText: string): string {
  const version = parseLogLines(logText).find(
    (l) => l.msg === 'claude session billing' && l.claudeCodeVersion,
  )?.claudeCodeVersion;
  return version ?? 'unknown';
}

/** What 10db passes a stdio server: `env -i PATH=… HOME=…`, and nothing else. */
const STDIO_ENV_KEYS = ['HOME', 'PATH'];
/**
 * Keys npm (`npx`) and macOS add to a process started with only PATH and HOME, as measured. None
 * of them comes from the session environment.
 */
const LAUNCHER_KEY = /^(?:npm_\w+|COLOR|EDITOR|INIT_CWD|NODE|PWD|SHLVL|_|__CF_USER_TEXT_ENCODING)$/;
/** Credentials that must never reach a repo server unless the builder approved them by name. */
const FORBIDDEN_KEY = /^(?:ANTHROPIC_|CLAUDE|AWS_)/;

/**
 * The environment the running repo server actually had, as `ps -E` showed its keys. Only PATH, HOME and
 * what npm or the OS adds may appear, and never a billing or cloud credential.
 */
export function checkServerEnv(server: string, keys: readonly string[] | null): AcceptanceCheck {
  if (keys === null)
    return check(
      'repo MCP server env',
      false,
      `no ${server} process was seen while sessions ran, so its env was never read`,
    );
  const forbidden = keys.filter((k) => FORBIDDEN_KEY.test(k));
  const unexpected = keys.filter((k) => !STDIO_ENV_KEYS.includes(k) && !LAUNCHER_KEY.test(k));
  const missing = STDIO_ENV_KEYS.filter((k) => !keys.includes(k));
  const ok = forbidden.length === 0 && unexpected.length === 0 && missing.length === 0;
  return check(
    'repo MCP server env',
    ok,
    ok
      ? `${server} ran with ${String(keys.length)} key(s): PATH, HOME and npm's own`
      : `unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`,
  );
}

function check(name: string, ok: boolean, detail: string): AcceptanceCheck {
  return { name, ok, detail };
}

/** The §1.3 checks, read from the database (read-only), the repo's git history and the daemon log. */
export async function runAcceptanceChecks(input: {
  readonly dbPath: string;
  readonly repoPath: string;
  readonly logText: string;
  readonly minTasks: number;
  /** The server the disposable repo's .mcp.json declares and the run approves. */
  readonly mcpServer: string;
  /** The env keys the live run read from the running server's process, or null if it never saw one. */
  readonly mcpServerEnvKeys: readonly string[] | null;
  /** Files the tasks must leave committed and non-empty at HEAD; a task's gate does not check them. */
  readonly outputs: readonly string[];
}): Promise<AcceptanceCheck[]> {
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
  try {
    const count = (sql: string, ...params: unknown[]): number =>
      Count.parse(db.prepare(sql).get(...params)).n;
    const done = count("SELECT count(*) AS n FROM workstreams WHERE state = 'DONE'");
    const total = count('SELECT count(*) AS n FROM workstreams');
    const withoutGate = count(
      "SELECT count(*) AS n FROM workstreams w WHERE w.state = 'DONE' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.workstream_id = w.id AND e.kind = 'gate' AND e.exit_code = 0)",
    );
    const handoffs = count('SELECT count(*) AS n FROM handoffs');
    const answered = count(
      "SELECT count(*) AS n FROM inbox_items WHERE kind = 'question' AND state = 'RESOLVED'",
    );
    const recoveries = count("SELECT count(*) AS n FROM events WHERE type = 'recovery.step'");
    const dupOps = count(
      'SELECT count(*) AS n FROM (SELECT workstream_id, op_id FROM tool_ops GROUP BY workstream_id, op_id HAVING count(*) > 1)',
    );
    // A permission card stores the tool it asks about; "_" is escaped so a name cannot widen the match.
    const gatedCards = count(
      "SELECT count(*) AS n FROM inbox_items WHERE kind = 'permission' AND json_extract(detail, '$.toolName') LIKE ? ESCAPE '\\'",
      `mcp\\_\\_${input.mcpServer.replace(/[\\%_]/g, '\\$&')}\\_\\_%`,
    );
    const events = z
      .object({ n: z.int(), maxSeq: z.int().nullable() })
      .parse(db.prepare('SELECT count(*) AS n, max(seq) AS maxSeq FROM events').get());
    const started = count(
      'SELECT count(*) AS n FROM sessions WHERE provider_session_id IS NOT NULL',
    );

    const { stdout } = await run(
      'git',
      ['log', '--format=%(trailers:key=10db-Op,valueonly,separator=%x2C)'],
      { cwd: input.repoPath },
    );
    const opIds = stdout
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const dupCommits = [...new Set(opIds.filter((id, i) => opIds.indexOf(id) !== i))];
    const missing: string[] = [];
    for (const path of input.outputs) {
      const size = await run('git', ['cat-file', '-s', `HEAD:${path}`], {
        cwd: input.repoPath,
      }).then(
        (r) => Number(r.stdout.trim()),
        () => 0,
      );
      // NaN from unexpected output counts as missing, never as present.
      if (!(size > 0)) missing.push(path);
    }

    const lines = parseLogLines(input.logText);
    const billing = lines.filter((l) => l.msg === 'claude session billing');
    const firstParty = billing.filter(
      (l) =>
        l.apiKeySource === 'none' && l.apiProvider === 'firstParty' && Boolean(l.subscriptionType),
    );
    const failedChecks = input.logText.split('Billing check failed').length - 1;
    // One line per session start: the repo servers the runner passed, with their env keys.
    const starts = lines.filter((l) => l.msg === 'project mcp servers');
    const passedOk = starts.filter((l) =>
      (l.passed ?? []).some(
        (s) => s.name === input.mcpServer && [...s.envKeys].sort().join() === STDIO_ENV_KEYS.join(),
      ),
    );
    // Read once after each session's first turn: init alone often says `pending` while npx downloads.
    const statusLines = lines.filter((l) => l.msg === 'claude session mcp status');
    const reported = statusLines.flatMap((l) =>
      (l.mcpServers ?? []).filter((s) => s.name === input.mcpServer),
    );
    const statuses = [...new Set(reported.map((s) => s.status))].join(', ') || 'none';

    return [
      check(
        'tasks done',
        done >= input.minTasks && done === total,
        `${String(done)} of ${String(total)} workstreams DONE (need ${String(input.minTasks)})`,
      ),
      check(
        'gate evidence',
        done > 0 && withoutGate === 0,
        `${String(withoutGate)} DONE workstream(s) without a passing gate record`,
      ),
      check(
        'task outputs',
        missing.length === 0,
        missing.length === 0
          ? `${String(input.outputs.length)} file(s) committed and non-empty at HEAD`
          : `missing or empty at HEAD: ${missing.join(', ')}`,
      ),
      check('handoff crossed', handoffs >= 1, `${String(handoffs)} handoff(s)`),
      check('question answered', answered >= 1, `${String(answered)} question card(s) resolved`),
      check(
        'recovered after kill -9',
        recoveries >= 1,
        `${String(recoveries)} recovery.step event(s)`,
      ),
      check(
        'no duplicate commits',
        dupCommits.length === 0 && opIds.length >= input.minTasks,
        dupCommits.length === 0
          ? `${String(opIds.length)} op trailer(s), all unique (need at least ${String(input.minTasks)})`
          : `duplicated: ${dupCommits.join(', ')}`,
      ),
      check(
        'no duplicate tool ops',
        dupOps === 0,
        `${String(dupOps)} duplicated (workstream, opId) pair(s)`,
      ),
      check(
        'events replay without gaps',
        events.n > 0 && events.n === (events.maxSeq ?? 0),
        `${String(events.n)} event(s), max seq ${String(events.maxSeq ?? 0)}`,
      ),
      check(
        'subscription billing',
        started > 0 &&
          firstParty.length >= started &&
          firstParty.length === billing.length &&
          failedChecks === 0,
        `${String(firstParty.length)} of ${String(billing.length)} billing line(s) first-party for ${String(started)} started session(s); ${String(failedChecks)} billing failure(s)`,
      ),
      check(
        'repo MCP server approved',
        starts.length >= started && started > 0 && passedOk.length === starts.length,
        `${input.mcpServer} passed, with env ${STDIO_ENV_KEYS.join(' and ')} only, at ${String(passedOk.length)} of ${String(starts.length)} session start(s) for ${String(started)} started session(s)`,
      ),
      check(
        'repo MCP server connected',
        reported.some((s) => s.status === 'connected'),
        `${input.mcpServer} status after the first turn in ${String(reported.length)} of ${String(statusLines.length)} session(s): ${statuses}`,
      ),
      check(
        'repo MCP tool gated',
        gatedCards >= 1,
        `${String(gatedCards)} permission card(s) for mcp__${input.mcpServer}__ tools: repo tool calls reach canUseTool`,
      ),
      checkServerEnv(input.mcpServer, input.mcpServerEnvKeys),
    ];
  } finally {
    db.close();
  }
}

const ContextEvent = z.object({ entityId: z.string(), data: z.string() });
const ContextData = z.looseObject({ percentage: z.number() });

/** Each session's first context reading: what a session starts with, before any work. */
export function sessionBaselines(
  dbPath: string,
): { readonly min: number; readonly max: number; readonly sessions: number } | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = z
      .array(ContextEvent)
      .parse(
        db
          .prepare(
            "SELECT entity_id AS entityId, data FROM events WHERE type = 'session.context' ORDER BY seq",
          )
          .all(),
      );
    const first = new Map<string, number>();
    for (const row of rows) {
      if (first.has(row.entityId)) continue;
      const parsed = ContextData.safeParse(JSON.parse(row.data));
      if (parsed.success) first.set(row.entityId, parsed.data.percentage);
    }
    const readings = [...first.values()];
    return readings.length === 0
      ? null
      : { min: Math.min(...readings), max: Math.max(...readings), sessions: readings.length };
  } finally {
    db.close();
  }
}

/** The results note in the spike-note shape: status first, then one row per check. */
export function renderAcceptanceReport(input: {
  readonly checks: readonly AcceptanceCheck[];
  readonly manual: readonly AcceptanceCheck[];
  readonly meta: Readonly<Record<string, string>>;
}): string {
  const all = [...input.checks, ...input.manual];
  const status = all.every((c) => c.ok) ? 'VERIFIED' : 'FAILED';
  const rows = all.map(
    (c) => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replaceAll('|', '\\|')} |`,
  );
  return [
    '# M1 live acceptance (§1.3 on a disposable repo)',
    '',
    `- **Status:** ${status}`,
    ...Object.entries(input.meta).map(([k, v]) => `- **${k}:** ${v}`),
    '- **Command:** `pnpm live-acceptance`',
    '',
    '## Checks',
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...rows,
    '',
    '## Consequence',
    '',
    status === 'VERIFIED'
      ? 'M1 passes §1.3 on a disposable repo. Next: the same run on the pilot project (M3).'
      : 'M1 does not yet pass §1.3. Each failing row above needs a fix and a rerun before the M1b PR merges.',
    '',
  ].join('\n');
}

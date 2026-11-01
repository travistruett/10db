import { z } from 'zod';

export const LogLevel = {
  Fatal: 'fatal',
  Error: 'error',
  Warn: 'warn',
  Info: 'info',
  Debug: 'debug',
  Trace: 'trace',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

const DaemonEnv = z.object({
  TENDB_DATA_DIR: z.string().min(1).optional(),
  TENDB_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  TENDB_LOG_LEVEL: z.enum(LogLevel).default(LogLevel.Info),
  TENDB_SQLITE_BINDING: z.string().min(1).optional(),
  TENDB_FAKE_SCRIPTS: z.string().min(1).optional(),
  // Development and Playwright only: a fixed UI bearer token instead of a random one per start.
  TENDB_DEV_UI_TOKEN: z.string().min(32).optional(),
  // The one browser origin the API accepts beside the Tauri webview's, opted in by hand: a Vite dev UI,
  // over a throwaway daemon or the installed app's. Exactly `http://<loopback host>:<port>`, the form a
  // browser sends in `Origin`: localhost, 127.0.0.1 or [::1], a port from 1 to 65535, nothing after it.
  // Not port 80: a browser leaves the default port out of `Origin`, so it would never match.
  TENDB_DEV_UI_ORIGIN: z
    .string()
    .regex(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/)
    .refine((origin) => {
      const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
      return port <= 65535 && port !== 80;
    })
    .optional(),
  // Absolute path to the claude binary; otherwise it is found on the login shell's PATH.
  TENDB_CLAUDE_PATH: z.string().startsWith('/').optional(),
  // Where worktrees are made for worktree-mode projects. Absolute: `~` is not expanded.
  TENDB_WORKTREE_ROOT: z.string().startsWith('/').optional(),
  // How many gates (a lane's verify gate, a batch's ship gate) run at once on this machine; the rest
  // wait their turn. Each gate is a whole test suite, so more than one at a time overloads a Mac.
  TENDB_GATE_SLOTS: z.coerce.number().int().min(1).max(64).optional(),
  // Set by the desktop shell: the daemon runs its normal shutdown when stdin reaches EOF, which is how
  // it learns the shell died without a clean Quit.
  TENDB_PARENT_STDIN: z.enum(['0', '1']).optional(),
  // `off` keeps the daemon from reading the Artificial Analysis key and from syncing benchmarks. Set
  // for every daemon that is not the installed app (e2e, live acceptance, `pnpm dev`): the free
  // quota is shared, and a throwaway daemon with no earlier sync would spend it.
  TENDB_BENCHMARKS: z.enum(['on', 'off']).optional(),
  // `off` keeps the daemon from reading the OpenRouter key and from calling OpenRouter: every decision
  // keeps today's rule. Set for every daemon that is not the installed app, as TENDB_BENCHMARKS is.
  TENDB_JUDGE: z.enum(['on', 'off']).optional(),
  // Test only: runs claude-adapter.live.test.ts against the real claude on the builder's subscription.
  TENDB_LIVE_CLAUDE: z.enum(['0', '1']).optional(),
});
export type DaemonEnv = z.infer<typeof DaemonEnv>;

/** Invalid configuration. Lists variable names and problem codes only, never values. */
export class EnvError extends Error {
  override readonly name = 'EnvError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/**
 * What to do about a refused variable, where the fix is not obvious from its name. A bad
 * `TENDB_DEV_UI_ORIGIN` stops the installed app's daemon, and `pnpm dev:factory:enable` is how it got there.
 */
const REMEDIES: Readonly<Partial<Record<string, string>>> = {
  TENDB_DEV_UI_ORIGIN:
    'if pnpm dev:factory:enable or launchctl set it, run pnpm dev:factory:disable, then quit and reopen 10db',
};

/**
 * The data dir alone. A client starts the builder bridge with its own environment, so the bridge
 * must not refuse to start over a daemon variable it never uses; `VAR=` means unset here too.
 */
export function loadDataDirEnv(
  source: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = source['TENDB_DATA_DIR'];
  const parsed = DaemonEnv.shape.TENDB_DATA_DIR.safeParse(value === '' ? undefined : value);
  if (!parsed.success) throw new EnvError(['TENDB_DATA_DIR: invalid']);
  return parsed.data;
}

/** The only module in the daemon that parses environment variables; main passes `process.env`. */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): DaemonEnv {
  // `VAR=` means unset: coercion would turn an empty port into 0 and fail an empty data dir.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = DaemonEnv.safeParse(present);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((issue) => {
        const name = issue.path.join('.');
        const remedy = REMEDIES[name];
        return remedy ? `${name}: ${issue.code} (${remedy})` : `${name}: ${issue.code}`;
      }),
    );
  }
  return parsed.data;
}

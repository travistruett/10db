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
  // Development and Playwright only: one more browser origin the API accepts, for a Vite server on a
  // port other than the Tauri dev port. Loopback http origins only, on a port from 1 to 65535.
  TENDB_DEV_UI_ORIGIN: z
    .string()
    .regex(/^http:\/\/(localhost|127\.0\.0\.1):[1-9]\d{0,4}$/)
    .refine((origin) => Number(origin.slice(origin.lastIndexOf(':') + 1)) <= 65535)
    .optional(),
  // Absolute path to the claude binary; otherwise it is found on the login shell's PATH.
  TENDB_CLAUDE_PATH: z.string().startsWith('/').optional(),
  // Set by the desktop shell: the daemon runs its normal shutdown when stdin reaches EOF, which is how
  // it learns the shell died without a clean Quit.
  TENDB_PARENT_STDIN: z.enum(['0', '1']).optional(),
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

/** The only module in the daemon that parses environment variables; main passes `process.env`. */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): DaemonEnv {
  // `VAR=` means unset: coercion would turn an empty port into 0 and fail an empty data dir.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = DaemonEnv.safeParse(present);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`),
    );
  }
  return parsed.data;
}

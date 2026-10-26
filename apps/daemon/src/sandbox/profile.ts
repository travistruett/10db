import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import { isEqualOrUnder } from './protected-reads';

/** Read-only system locations every toolchain needs, including the root links into `/private`. */
export const SYSTEM_READS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/private/etc',
  '/private/var/db',
  '/private/var/run',
  '/private/var/select',
  '/dev',
  '/opt/homebrew',
  '/Applications/Xcode.app',
  '/tmp',
  '/var',
  '/etc',
] as const;

/** An invalid profile. Names the field, never a value. */
export class SandboxProfileError extends Error {
  override readonly name = 'SandboxProfileError';
  readonly field: string;

  constructor(field: string, code: string) {
    super(`Invalid lane sandbox profile: ${field}: ${code}`);
    this.field = field;
  }
}

// Claude Code drops the whole sandbox, without an error, on a value it can't parse, so a path
// carries no pattern characters and a domain is a plain host or a `*.` wildcard.
const sandboxPath = z
  .string()
  .refine(
    (path) =>
      path.startsWith('/') &&
      !path.startsWith('//') &&
      path === posix.normalize(path) &&
      (path === '/' || !path.endsWith('/')) &&
      !/[*?[{\n]/.test(path),
    'not a plain normalized absolute path',
  );
const sandboxDomain = z.string().regex(/^(\*\.)?[a-z0-9.-]+$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** True for a value every path field of the profile accepts. */
export function isSandboxPath(value: string): boolean {
  return sandboxPath.safeParse(value).success;
}

/** True for a value `network.allowedDomains` accepts. */
export function isSandboxDomain(value: string): boolean {
  return sandboxDomain.safeParse(value).success;
}

/** The settings Claude Code's sandbox takes, with the SDK's field names. */
export const LaneSandboxSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  failIfUnavailable: z.boolean(),
  allowUnsandboxedCommands: z.boolean(),
  allowAppleEvents: z.boolean(),
  autoAllowBashIfSandboxed: z.boolean(),
  filesystem: z.strictObject({
    denyRead: z.array(sandboxPath),
    allowRead: z.array(sandboxPath),
    allowWrite: z.array(sandboxPath),
  }),
  network: z.strictObject({
    allowedDomains: z.array(sandboxDomain),
    allowLocalBinding: z.boolean().optional(),
    allowMachLookup: z.array(z.string().min(1)),
    allowUnixSockets: z.array(sandboxPath),
  }),
  credentials: z.strictObject({
    envVars: z.array(z.strictObject({ name: envName, mode: z.literal('deny') })),
  }),
});
export type LaneSandboxSettings = z.infer<typeof LaneSandboxSettingsSchema>;

export interface LaneProfileInput {
  checkout: string;
  tmpDir: string;
  home: string;
  protectedReads: readonly string[];
  secretFiles: readonly string[];
  toolchainReads: readonly string[];
  packageCacheDir: string;
  allowedDomains: readonly string[];
  readList: readonly string[];
  /** Extra read-only paths, such as a linked worktree's git dirs. */
  extraReads: readonly string[];
  /** Extra writable paths, such as a linked worktree's git dirs. */
  extraWrites: readonly string[];
  loopback: boolean;
  deniedEnvNames: readonly string[];
}

/** Builds the lane's sandbox settings from one input and validates them before they reach Claude Code. */
export function buildLaneProfile(input: LaneProfileInput): LaneSandboxSettings {
  let checkout: string;
  try {
    checkout = realpathSync(input.checkout);
  } catch {
    throw new SandboxProfileError('checkout', 'unreadable');
  }
  const denied = [...input.protectedReads, ...input.secretFiles];
  const isAllowed = (path: string): boolean => !denied.some((root) => isEqualOrUnder(path, root));
  const readable = [
    ...SYSTEM_READS,
    input.tmpDir,
    checkout,
    ...input.toolchainReads,
    input.packageCacheDir,
    ...input.readList,
    ...input.extraReads,
  ].filter(isAllowed);
  const writable = [input.tmpDir, input.packageCacheDir, ...input.extraWrites].filter(isAllowed);
  const candidate: LaneSandboxSettings = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ['/', ...input.protectedReads, ...input.secretFiles],
      allowRead: readable,
      allowWrite: writable,
    },
    network: {
      allowedDomains: [...input.allowedDomains],
      ...(input.loopback ? { allowLocalBinding: true } : {}),
      allowMachLookup: ['com.apple.FSEvents'],
      allowUnixSockets: [input.tmpDir],
    },
    credentials: {
      envVars: input.deniedEnvNames.map((name) => ({ name, mode: 'deny' as const })),
    },
  };
  const parsed = LaneSandboxSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SandboxProfileError(issue?.path.join('.') ?? 'profile', issue?.code ?? 'invalid');
  }
  return parsed.data;
}

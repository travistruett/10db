import { lstatSync, realpathSync } from 'node:fs';
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

/**
 * An invalid profile. `field` names the profile field; the message says what is wrong for the
 * builder, naming the path, host or variable name at fault (never a variable's value).
 */
export class SandboxProfileError extends Error {
  override readonly name = 'SandboxProfileError';
  readonly field: string;

  constructor(field: string, problem: string) {
    super(problem);
    this.field = field;
  }
}

/** The value a validation issue is about, when it is text. */
const shown = (input: unknown): string => (typeof input === 'string' ? input : '');

// Claude Code drops the whole sandbox, without an error, on a value it can't parse, so a path
// carries no pattern characters and a domain is a plain host or a `*.` wildcard.
const sandboxPath = z
  .string()
  .refine(
    (path) =>
      path.startsWith('/') &&
      !path.startsWith('//') &&
      path === posix.normalize(path) &&
      (path === '/' || !path.endsWith('/')),
    {
      error: (issue) =>
        `a path can't be used in the sandbox profile: ${shown(issue.input)} (not a normalized absolute path)`,
      abort: true,
    },
  )
  .refine((path) => !/[*?[\]{}\\\n]/.test(path), {
    error: (issue) =>
      `a path can't be used in the sandbox profile: ${shown(issue.input)} (glob characters, \`\\\` or a newline)`,
  });
const sandboxDomain = z.string().regex(/^(\*\.)?[a-z0-9.-]+$/, {
  error: (issue) =>
    `a host can't be used in the sandbox profile: ${shown(issue.input)} (not a lower-case host or *. wildcard)`,
});
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  error: (issue) => `an env name can't be used in the sandbox profile: ${shown(issue.input)}`,
});

/** True for a value every path field of the profile accepts. */
export function isSandboxPath(value: string): boolean {
  return sandboxPath.safeParse(value).success;
}

/** True for a value `network.allowedDomains` accepts. */
export function isSandboxDomain(value: string): boolean {
  return sandboxDomain.safeParse(value).success;
}

/** The settings Claude Code's sandbox takes, with the SDK's field names. */
const LaneSandboxSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  failIfUnavailable: z.boolean(),
  allowUnsandboxedCommands: z.boolean(),
  allowAppleEvents: z.boolean(),
  autoAllowBashIfSandboxed: z.boolean(),
  filesystem: z.strictObject({
    denyRead: z.array(sandboxPath),
    allowRead: z.array(sandboxPath),
    allowWrite: z.array(sandboxPath),
    denyWrite: z.array(sandboxPath),
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
  /** The checkout's `.env*` files, and the real paths of its `.env*` links. */
  secretFiles: readonly string[];
  /** Toolchain files that can hold a registry token or a key, from `toolchainAccess`. */
  toolchainSecrets: readonly string[];
  toolchainReads: readonly string[];
  allowedDomains: readonly string[];
  readList: readonly string[];
  /** Extra read-only paths, such as a linked worktree's git dirs. */
  extraReads: readonly string[];
  /** Extra writable paths, such as a linked worktree's git dirs. */
  extraWrites: readonly string[];
  /** Exact paths no command may write, even where Claude Code opens their directory for writing. */
  denyWrites: readonly string[];
  loopback: boolean;
  deniedEnvNames: readonly string[];
}

/** A path and, when it differs and exists, its real path, so a link and its target compare alike. */
function spellings(path: string): string[] {
  try {
    const real = realpathSync(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
}

/** A directory itself, not a link to one: a `.env*` link is listed beside the real path it leads to. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A `.env*` link to a directory denies the directory. Denying one that holds what lane commands
 * read, or one inside a toolchain or system location, would leave a lane whose commands fail with no
 * reason given, so the session is refused, naming the link's target. The checkout, the toolchains and
 * the lane's own paths compare by both their spelling and their real path. The system reads compare as
 * written: `/tmp`, `/var` and `/etc` reopen only their links, not what lies under `/private`.
 */
function refuseSecretsOverNeeds(
  secrets: readonly string[],
  needed: readonly string[],
  toolchains: readonly string[],
): void {
  const neededSpellings = [...SYSTEM_READS, ...needed.flatMap(spellings)];
  const rootSpellings = [...SYSTEM_READS, ...toolchains.flatMap(spellings)];
  for (const secret of secrets) {
    const held = neededSpellings.find((path) => isEqualOrUnder(path, secret));
    if (held !== undefined)
      throw new SandboxProfileError(
        'secretFiles',
        `a .env* link in the checkout leads to ${secret}, which holds ${held} that every lane command needs; remove the link or point it at a file`,
      );
    if (!isDirectory(secret)) continue;
    const inside = rootSpellings.find((root) => isEqualOrUnder(secret, root));
    if (inside !== undefined)
      throw new SandboxProfileError(
        'secretFiles',
        `a .env* link in the checkout leads to ${secret}, a directory inside ${inside} that lane commands read; remove the link or point it at a file`,
      );
  }
}

/**
 * A toolchain secret that holds what lane commands read would leave a lane that fails with no reason
 * given. `toolchainAccess` already keeps such paths out of the toolchain reads, so this can only meet
 * the checkout, the temp dir or an extra read, and refuses the session naming both.
 */
function refuseToolchainSecretsOverNeeds(
  secrets: readonly string[],
  needed: readonly string[],
): void {
  const neededSpellings = needed.flatMap(spellings);
  for (const secret of secrets) {
    const held = neededSpellings.find((path) => isEqualOrUnder(path, secret));
    if (held !== undefined)
      throw new SandboxProfileError(
        'toolchainSecrets',
        `a toolchain file that can hold a registry token, ${secret}, holds ${held} that every lane command needs; move it`,
      );
  }
}

/** Builds the lane's sandbox settings from one input and validates them before they reach Claude Code. */
export function buildLaneProfile(input: LaneProfileInput): LaneSandboxSettings {
  let checkout: string;
  try {
    checkout = realpathSync(input.checkout);
  } catch {
    throw new SandboxProfileError('checkout', "the checkout can't be read");
  }
  const laneReads = [input.tmpDir, checkout, ...input.toolchainReads, ...input.extraReads];
  refuseSecretsOverNeeds(input.secretFiles, laneReads, input.toolchainReads);
  refuseToolchainSecretsOverNeeds(input.toolchainSecrets, laneReads);
  const needed = [...SYSTEM_READS, ...laneReads];
  const denied = [...input.protectedReads, ...input.secretFiles, ...input.toolchainSecrets];
  const isAllowed = (path: string): boolean => !denied.some((root) => isEqualOrUnder(path, root));
  const readable = [...needed, ...input.readList].filter(isAllowed);
  const writable = [input.tmpDir, ...input.extraWrites].filter(isAllowed);
  const candidate: LaneSandboxSettings = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ['/', ...input.protectedReads, ...input.secretFiles, ...input.toolchainSecrets],
      allowRead: readable,
      allowWrite: writable,
      denyWrite: [...input.denyWrites],
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
    throw new SandboxProfileError(
      issue?.path.join('.') ?? 'profile',
      issue?.message ?? "the sandbox profile can't be built",
    );
  }
  return parsed.data;
}

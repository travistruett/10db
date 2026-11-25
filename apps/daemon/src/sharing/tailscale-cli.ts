import { execFile } from 'node:child_process';
import { z } from 'zod';

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type TailscaleRun = (args: readonly string[], timeoutMs: number) => Promise<CliResult>;

export const TAILSCALE_CLI_PATHS = [
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
] as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 1024 * 1024;

/** The first path that exists, else null. */
export function findTailscaleCli(exists: (path: string) => boolean): string | null {
  return TAILSCALE_CLI_PATHS.find((path) => exists(path)) ?? null;
}

/**
 * Runs the CLI with no shell and an environment of `PATH` and `HOME` only. A failure to start, a non-zero
 * exit and a timeout all resolve to a result; the promise never rejects.
 */
export function createTailscaleRun(cli: string): TailscaleRun {
  return (args, timeoutMs) =>
    new Promise<CliResult>((resolve) => {
      execFile(
        cli,
        [...args],
        {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr, timedOut: false });
            return;
          }
          // execFile's callback error carries `code` (an exit status or a spawn error name) and `killed`.
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          resolve({
            code: typeof failure.code === 'number' ? failure.code : null,
            stdout,
            stderr: stderr === '' && typeof failure.code === 'string' ? failure.code : stderr,
            timedOut: failure.killed === true && failure.signal === 'SIGTERM',
          });
        },
      );
    });
}

export interface TailscaleSelf {
  readonly running: boolean;
  readonly fqdn: string | null;
  readonly login: string | null;
  readonly tags: readonly string[];
  readonly certDomains: readonly string[];
  readonly version: string;
}

export class TailscaleUnreadableError extends Error {
  override readonly name = 'TailscaleUnreadableError';
}

const StatusJson = z.object({
  BackendState: z.string(),
  Version: z.string().optional(),
  CertDomains: z.array(z.string()).nullish(),
  Self: z
    .object({
      DNSName: z.string().optional(),
      UserID: z.number().optional(),
      Tags: z.array(z.string()).nullish(),
    })
    .nullish(),
  User: z.record(z.string(), z.object({ LoginName: z.string().optional() })).nullish(),
});

const NOT_RUNNING = /not running|is stopped|failed to connect to local|is tailscale running/i;

const NOT_RUNNING_SELF: TailscaleSelf = {
  running: false,
  fqdn: null,
  login: null,
  tags: [],
  certDomains: [],
  version: '',
};

/** Reads `status --json`; a backend that is not running is `running: false`, output that doesn't parse throws. */
export async function readTailscaleSelf(run: TailscaleRun): Promise<TailscaleSelf> {
  const result = await run(['status', '--json'], DEFAULT_TIMEOUT_MS);
  if (result.timedOut) throw new TailscaleUnreadableError('tailscale status timed out');
  if (result.code !== 0 && NOT_RUNNING.test(result.stderr)) return NOT_RUNNING_SELF;
  if (result.code !== 0) {
    throw new TailscaleUnreadableError(`tailscale status exited with ${String(result.code)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new TailscaleUnreadableError('tailscale status output is not JSON');
  }
  const parsed = StatusJson.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new TailscaleUnreadableError(
      `tailscale status output is missing or malformed: ${fields}`,
    );
  }
  const status = parsed.data;
  const running = status.BackendState === 'Running';
  const dnsName = status.Self?.DNSName;
  const userId = status.Self?.UserID;
  return {
    running,
    fqdn: running && dnsName ? dnsName.replace(/\.$/, '') : null,
    login: userId === undefined ? null : (status.User?.[String(userId)]?.LoginName ?? null),
    tags: status.Self?.Tags ?? [],
    certDomains: status.CertDomains ?? [],
    version: status.Version ?? '',
  };
}

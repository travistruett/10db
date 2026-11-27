import { execFile } from 'node:child_process';
import { BlockList, isIP } from 'node:net';
import { DEVICE_LABEL_MAX } from '@10db/contracts';
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

/** How long a pairing waits for the CLI to name the device. */
export const TAILNET_NAME_TIMEOUT_MS = 3_000;

const tailscaleAddresses = new BlockList();
tailscaleAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
tailscaleAddresses.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** Only a bare Tailscale address, so a host name, a port or a value starting with `-` never reaches the CLI. */
function isTailscaleAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 0) return false;
  return tailscaleAddresses.check(value, family === 4 ? 'ipv4' : 'ipv6');
}

const WhoisJson = z.object({
  Node: z
    .object({
      Name: z.string().optional(),
      ComputedName: z.string().optional(),
      Hostinfo: z.object({ Hostname: z.string().optional() }).nullish(),
    })
    .nullish(),
});

function usableName(value: string | undefined): string | null {
  const name = value?.trim() ?? '';
  return name === '' || name.toLowerCase() === 'localhost' ? null : name;
}

/**
 * The name Tailscale has for the machine at `ip`: `Node.Hostinfo.Hostname` unless empty or `localhost`, else
 * `Node.ComputedName`, else the first label of `Node.Name`; trimmed, cut to `DEVICE_LABEL_MAX`, and null when
 * empty. Null too when `ip` isn't a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48, checked with
 * `node:net`'s `isIP` and a `BlockList`, so nothing else, nor a value starting with `-`, reaches the CLI), or the CLI
 * fails, times out or answers something that doesn't parse. It never rejects.
 */
export async function readTailnetName(
  run: TailscaleRun,
  ip: string,
  timeoutMs: number,
): Promise<string | null> {
  if (!isTailscaleAddress(ip)) return null;
  try {
    const result = await run(['whois', '--json', ip], timeoutMs);
    if (result.timedOut || result.code !== 0) return null;
    // The CLI's own output, so it is parsed here and never trusted as typed.
    const parsed = WhoisJson.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) return null;
    const node = parsed.data.Node;
    const name =
      usableName(node?.Hostinfo?.Hostname) ??
      usableName(node?.ComputedName) ??
      usableName(node?.Name?.split('.')[0]);
    return name === null ? null : name.slice(0, DEVICE_LABEL_MAX).trim() || null;
  } catch {
    return null;
  }
}

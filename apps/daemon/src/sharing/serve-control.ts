import type { Logger } from '../log';
import {
  ServeStatus,
  isTendbMapping,
  loopbackMappingOn,
  serveArgs,
  unserveArgs,
} from './serve-mapping';
import type { TailscaleRun } from './tailscale-cli';

const SERVE_TIMEOUT_MS = 10_000;

export class ServeUnreadableError extends Error {
  override readonly name = 'ServeUnreadableError';
}

/** Reads and changes the port mappings of `tailscale serve`, and keeps the last status it read. */
export interface ServeControl {
  /** The last status read; null before the first read, or when the read after a removal failed. */
  current(): ServeStatus | null;
  /** Throws `ServeUnreadableError`. */
  read(cli: string): Promise<ServeStatus>;
  /**
   * Removes 10db's own mapping, and only that. Never throws. True when none of 10db's is left, false when it
   * could not be read or removed.
   */
  removeOwnMapping(port: number): Promise<boolean>;
  /** Runs `serve --bg`; the CLI's complaint, or null. */
  applyMapping(cli: string, port: number): Promise<string | null>;
}

export function createServeControl(deps: {
  readonly cli: () => string | null;
  readonly run: (cli: string) => TailscaleRun;
  readonly log: Logger;
  /** The tailnet name when Tailscale is connected: a mapping is then 10db's only on that name. */
  readonly fqdn: () => string | null;
}): ServeControl {
  let serve: ServeStatus | null = null;

  async function read(cli: string): Promise<ServeStatus> {
    const result = await deps.run(cli)(['serve', 'status', '--json'], SERVE_TIMEOUT_MS);
    if (result.timedOut || result.code !== 0) {
      throw new ServeUnreadableError('tailscale serve status failed');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new ServeUnreadableError('tailscale serve status output is not JSON');
    }
    const parsed = ServeStatus.safeParse(raw);
    if (!parsed.success) throw new ServeUnreadableError('tailscale serve status is malformed');
    serve = parsed.data;
    return parsed.data;
  }

  return {
    current: () => serve,
    read,
    async removeOwnMapping(port) {
      const cli = deps.cli();
      if (cli === null) return false;
      try {
        const status = await read(cli);
        const fqdn = deps.fqdn();
        const own =
          fqdn !== null ? isTendbMapping(status, fqdn, port) : loopbackMappingOn(status, port);
        if (!own) return true;
        const result = await deps.run(cli)(unserveArgs(port), SERVE_TIMEOUT_MS);
        if (result.code !== 0 || result.timedOut) {
          deps.log.warn(
            { timedOut: result.timedOut, stderr: result.stderr.slice(-300) },
            'sharing: could not remove the mapping',
          );
          return false;
        }
        serve = await read(cli).catch(() => null);
        return true;
      } catch (error) {
        deps.log.warn(
          { error: String(error) },
          'sharing: could not read serve to remove the mapping',
        );
        return false;
      }
    },
    async applyMapping(cli, port) {
      const result = await deps.run(cli)(serveArgs(port), SERVE_TIMEOUT_MS);
      if (result.code !== 0 || result.timedOut) {
        return result.timedOut ? 'tailscale serve timed out' : result.stderr.slice(-300);
      }
      return null;
    },
  };
}

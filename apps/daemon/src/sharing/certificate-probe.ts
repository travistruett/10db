import type { Clock } from '../clock';
import type { TailscaleRun } from './tailscale-cli';

export interface CertificateProbe {
  /** The last result, never running the CLI. */
  current(): {
    readonly issued: boolean;
    readonly error: string | null;
    readonly checkedAt: Date | null;
  };
  /** Runs the probe if due: at most once a minute, every 10 minutes after a failure. */
  tick(fqdn: string): Promise<void>;
}

const AFTER_SUCCESS_MS = 60_000;
const AFTER_FAILURE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const STDERR_KEPT = 500;

/**
 * Asks Tailscale for the name's certificate, `cert --cert-file - --key-file -`. Only the exit status and the
 * tail of stderr are kept; stdout holds the private key and is dropped unread.
 */
export function createCertificateProbe(deps: {
  readonly run: TailscaleRun;
  readonly clock: Clock;
}): CertificateProbe {
  let last: { issued: boolean; error: string | null; checkedAt: Date } | null = null;
  let lastPassed = false;
  let failedAfterSuccess = false;
  let running = false;

  return {
    current: () => last ?? { issued: false, error: null, checkedAt: null },
    async tick(fqdn) {
      if (running) return;
      const now = deps.clock.now();
      if (last !== null) {
        const wait = last.issued || failedAfterSuccess ? AFTER_SUCCESS_MS : AFTER_FAILURE_MS;
        if (now.getTime() - last.checkedAt.getTime() < wait) return;
      }
      running = true;
      try {
        const result = await deps.run(
          ['cert', '--cert-file', '-', '--key-file', '-', fqdn],
          PROBE_TIMEOUT_MS,
        );
        const passed = result.code === 0 && !result.timedOut;
        // One failure right after a pass keeps the certificate counted and retries in a minute; a second ends it.
        const keep = !passed && lastPassed;
        lastPassed = passed;
        failedAfterSuccess = keep;
        last = {
          issued: passed || keep,
          error: passed ? null : result.timedOut ? 'timed out' : result.stderr.slice(-STDERR_KEPT),
          checkedAt: deps.clock.now(),
        };
      } finally {
        running = false;
      }
    },
  };
}

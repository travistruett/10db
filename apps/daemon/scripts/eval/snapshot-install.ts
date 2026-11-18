import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

export class SnapshotInstallError extends Error {
  override readonly name = 'SnapshotInstallError';
}

const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline'] as const;

/** Output of the install kept in an error; a failed install's tail names its cause. */
const OUTPUT_LIMIT = 20_000;

/**
 * Installs a case's snapshot with the snapshot's own toolchain. The runner itself runs under its
 * checkout's node, which a base commit may pin differently in `engines`, so the install goes through
 * `mise exec`: mise reads the snapshot's `mise.toml` and puts that node and pnpm first. The snapshot's
 * config is trusted for this one command only (mise refuses an unknown config, and every snapshot is
 * one). Without mise on PATH, pnpm runs as it is.
 *
 * @throws SnapshotInstallError carrying the install's own stdout and stderr when it fails.
 */
export function installSnapshotDependencies(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trusted = [env['MISE_TRUSTED_CONFIG_PATHS'], repo]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(delimiter);
  const options = { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } as const;
  let result = spawnSync('mise', ['exec', '--', 'pnpm', ...INSTALL_ARGS], {
    ...options,
    env: { ...env, MISE_TRUSTED_CONFIG_PATHS: trusted },
  });
  if (isMissing(result.error)) result = spawnSync('pnpm', INSTALL_ARGS, { ...options, env });
  if (result.error === undefined && result.status === 0) return;
  const output = `${result.stdout}${result.stderr}`.trim();
  const clipped = output.length > OUTPUT_LIMIT ? `…${output.slice(-OUTPUT_LIMIT)}` : output;
  const cause =
    result.error?.message ??
    (result.status === null
      ? `killed by ${String(result.signal)}`
      : `exit ${String(result.status)}`);
  throw new SnapshotInstallError(
    `pnpm install failed in the snapshot at ${repo} (${cause})${clipped === '' ? '' : `:\n${clipped}`}`,
  );
}

function isMissing(error: Error | undefined): boolean {
  return error !== undefined && 'code' in error && error.code === 'ENOENT';
}

import type { DaemonEnv } from '../env';
import type { DaemonOptions } from './start';

/** The daemon options the entry point takes from its environment. */
export type EnvDaemonOptions = Pick<
  DaemonOptions,
  | 'port'
  | 'logLevel'
  | 'sandbox'
  | 'uiToken'
  | 'devUiOrigin'
  | 'worktreeRoot'
  | 'limits'
  | 'judgeOff'
  | 'catalogueSync'
  | 'pictures'
>;

/**
 * The reader the benchmark sync gets for the Artificial Analysis key. With `TENDB_BENCHMARKS=off` it
 * never calls `read`, so the sync records `no_key` and makes no request.
 */
export function aaKeyReaderFromEnv(env: DaemonEnv, read: () => string | null): () => string | null {
  return env.TENDB_BENCHMARKS === 'off' ? () => null : read;
}

/** Whether this daemon may talk to Slack: the installed app's does, a throwaway daemon sets `TENDB_SLACK=off`. */
export function slackOnFromEnv(env: DaemonEnv): boolean {
  return env.TENDB_SLACK !== 'off';
}

/** The catalogue file to read when none is stored: the one the environment names, else the release's own. */
export function catalogueSnapshotFromEnv(env: DaemonEnv, bundled: string): string {
  return env.TENDB_CATALOGUE_SNAPSHOT ?? bundled;
}

/**
 * Every real lane and gate runs under the sandbox, and nothing in the environment turns it off. Fake
 * sessions (`TENDB_FAKE_SCRIPTS`) run no commands and write nothing a gate runs, so they and their
 * gates run without it.
 */
export function daemonOptionsFromEnv(env: DaemonEnv): EnvDaemonOptions {
  return {
    port: env.TENDB_PORT,
    logLevel: env.TENDB_LOG_LEVEL,
    sandbox: env.TENDB_FAKE_SCRIPTS ? null : {},
    ...(env.TENDB_DEV_UI_TOKEN ? { uiToken: env.TENDB_DEV_UI_TOKEN } : {}),
    ...(env.TENDB_WORKTREE_ROOT ? { worktreeRoot: env.TENDB_WORKTREE_ROOT } : {}),
    ...(env.TENDB_GATE_SLOTS === undefined ? {} : { limits: { gateSlots: env.TENDB_GATE_SLOTS } }),
    ...(env.TENDB_DEV_UI_ORIGIN ? { devUiOrigin: env.TENDB_DEV_UI_ORIGIN } : {}),
    ...(env.TENDB_JUDGE === 'off' ? { judgeOff: true } : {}),
    catalogueSync: env.TENDB_CATALOGUE !== 'off',
    pictures: { kind: 'pinned' },
  };
}

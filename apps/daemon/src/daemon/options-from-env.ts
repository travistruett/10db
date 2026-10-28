import type { DaemonEnv } from '../env';
import type { DaemonOptions } from './start';

/** The daemon options the entry point takes from its environment. */
export type EnvDaemonOptions = Pick<
  DaemonOptions,
  'port' | 'logLevel' | 'sandbox' | 'uiToken' | 'devUiOrigin' | 'worktreeRoot'
>;

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
    ...(env.TENDB_DEV_UI_ORIGIN ? { devUiOrigin: env.TENDB_DEV_UI_ORIGIN } : {}),
  };
}

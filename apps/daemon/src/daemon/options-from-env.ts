import type { DaemonEnv } from '../env';
import type { DaemonOptions } from './start';

/** The daemon options the entry point takes from its environment. */
export type EnvDaemonOptions = Pick<
  DaemonOptions,
  'port' | 'logLevel' | 'laneSandbox' | 'uiToken' | 'devUiOrigin'
>;

/**
 * Every real lane runs under the lane sandbox, and nothing in the environment turns it off. Fake
 * sessions (`TENDB_FAKE_SCRIPTS`) run no commands, so they run without it.
 */
export function daemonOptionsFromEnv(env: DaemonEnv): EnvDaemonOptions {
  return {
    port: env.TENDB_PORT,
    logLevel: env.TENDB_LOG_LEVEL,
    laneSandbox: env.TENDB_FAKE_SCRIPTS ? null : {},
    ...(env.TENDB_DEV_UI_TOKEN ? { uiToken: env.TENDB_DEV_UI_TOKEN } : {}),
    ...(env.TENDB_DEV_UI_ORIGIN ? { devUiOrigin: env.TENDB_DEV_UI_ORIGIN } : {}),
  };
}

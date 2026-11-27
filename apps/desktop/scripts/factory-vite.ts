export interface ViteCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Where the dev server answers the factory daemon's current address and token (`vite.config.ts`). */
export const FACTORY_CONNECTION_PATH = '/__tendb/factory-connection';

/**
 * Vite over the factory's daemon. The page asks the dev server for the daemon's address and token on every
 * connect (`FACTORY_CONNECTION_PATH`), read fresh from the data directory, so a restarted 10db, with its new
 * token, is followed without restarting Vite. Vite's default CORS lets any localhost page fetch from it, so CORS
 * is off: only the page Vite serves, on its own origin, can read the answer.
 */
export function factoryViteCommand(dataDir: string): ViteCommand {
  return {
    file: 'pnpm',
    args: ['exec', 'vite', '--no-cors'],
    env: { TENDB_FACTORY_DATA_DIR: dataDir, VITE_DAEMON_FACTORY: '1' },
  };
}

/** One message for a Vite that never started. */
export function viteStartFailure(error: Error): string {
  if ('code' in error && error.code === 'ENOENT')
    return 'Could not start Vite: pnpm isn\'t on your PATH. Activate mise in this shell (eval "$(mise activate zsh)") and run this again.';
  return `Could not start Vite through pnpm: ${error.message}`;
}

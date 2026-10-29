import type { FactoryConnection } from './factory-connection';

export interface ViteCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Vite over the factory's daemon. The token is inlined into the module that reads
 * `VITE_DAEMON_TOKEN`, and Vite's default CORS lets any localhost page fetch module source, so CORS is
 * off: only the page Vite serves, on its own origin, can read it.
 */
export function factoryViteCommand(connection: FactoryConnection): ViteCommand {
  return {
    file: 'pnpm',
    args: ['exec', 'vite', '--no-cors'],
    env: { VITE_DAEMON_URL: connection.url, VITE_DAEMON_TOKEN: connection.token },
  };
}

/** One message for a Vite that never started. */
export function viteStartFailure(error: Error): string {
  if ('code' in error && error.code === 'ENOENT')
    return 'Could not start Vite: pnpm isn\'t on your PATH. Activate mise in this shell (eval "$(mise activate zsh)") and run this again.';
  return `Could not start Vite through pnpm: ${error.message}`;
}

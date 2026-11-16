import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TerminalApp, UpstreamError } from '@10db/contracts';

// Sessions spec §7.5: the one place 10db starts the builder's terminal. The webview has no capability for it.

/** How long `open` may take to hand the script to the app. */
const OPEN_TIMEOUT_MS = 30_000;

/** The apps a window opens in, by name; Copy the Command opens nothing. */
export type WindowApp = typeof TerminalApp.Terminal | typeof TerminalApp.ITerm;

const APP_NAMES: Readonly<Record<WindowApp, string>> = {
  [TerminalApp.Terminal]: 'Terminal',
  [TerminalApp.ITerm]: 'iTerm',
};

export type TerminalOpener = (app: WindowApp, script: string, signal: AbortSignal) => Promise<void>;

/** `execFile`, as far as the opener uses it. */
export type RunOpen = (
  file: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeout: number },
) => Promise<unknown>;

const runWithExecFile: RunOpen = (file, args, options) =>
  promisify(execFile)(file, [...args], options);

/** Opens `script` in the app with `/usr/bin/open -a`; a failure says which app and where to choose another. */
export function createOpener(run: RunOpen = runWithExecFile): TerminalOpener {
  return async (app, script, signal) => {
    const name = APP_NAMES[app];
    try {
      await run('/usr/bin/open', ['-a', name, script], { signal, timeout: OPEN_TIMEOUT_MS });
    } catch (error) {
      // An aborted open is 10db stopping, not the app failing.
      if (signal.aborted) throw error;
      throw new UpstreamError(
        `${name} isn't installed or didn't open. Choose another in Settings › Sessions.`,
      );
    }
  };
}

import { TerminalApp, UpstreamError } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { createOpener, type RunOpen } from './opener';

// Security row 7: the app reaches `open -a` only as one of two fixed names, as one argument each.

function recorder(fail?: Error): { run: RunOpen; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args: [...args] });
      return fail === undefined ? Promise.resolve() : Promise.reject(fail);
    },
  };
}

describe('the terminal opener', () => {
  it.each([
    { app: TerminalApp.Terminal, name: 'Terminal' },
    { app: TerminalApp.ITerm, name: 'iTerm' },
  ])('opens the script in $name with /usr/bin/open, each value one argument', async (row) => {
    const { run, calls } = recorder();
    await createOpener(run)(row.app, '/data/a b/takeover.command', new AbortController().signal);
    expect(calls).toEqual([
      { file: '/usr/bin/open', args: ['-a', row.name, '/data/a b/takeover.command'] },
    ]);
  });

  it('says the app could not open it, and how to choose another', async () => {
    const { run } = recorder(new Error('Unable to find application named iTerm'));
    const opened = createOpener(run)(TerminalApp.ITerm, '/x', new AbortController().signal);
    await expect(opened).rejects.toThrow(UpstreamError);
    await expect(opened).rejects.toThrow(
      "iTerm isn't installed or didn't open. Choose another in Settings › Sessions.",
    );
  });

  it('passes the signal on, so quitting 10db stops an open that hangs', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const run: RunOpen = (_file, _args, options) => {
      seen = options.signal;
      return Promise.resolve();
    };
    await createOpener(run)(TerminalApp.Terminal, '/x', controller.signal);
    expect(seen).toBe(controller.signal);
  });
});

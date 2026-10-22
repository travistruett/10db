import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { captureLoginEnv, LOGIN_ENV_MARKER, parseEnvBlock } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('login-env');
});
afterEach(() => {
  dir.cleanup();
});

/** A stand-in for $SHELL: it receives `-l -i -c <script>` and runs the script with /bin/sh. */
function fakeShell(name: string, body: string): string {
  const path = join(dir.path, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const RUN_LAST_ARG = 'for last; do :; done\nexec /bin/sh -c "$last"';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('parseEnvBlock', () => {
  it.each([
    ['no marker', 'PATH=/bin\0', {}],
    [
      'noise before the marker is ignored',
      `Welcome!\nNOISE=1\0${LOGIN_ENV_MARKER}\0PATH=/bin\0HOME=/h\0`,
      { PATH: '/bin', HOME: '/h' },
    ],
    [
      'values may contain = and newlines',
      `${LOGIN_ENV_MARKER}\0A=x=y\0B=line1\nline2\0`,
      { A: 'x=y', B: 'line1\nline2' },
    ],
    [
      'invalid names and empty entries are skipped',
      `${LOGIN_ENV_MARKER}\0=x\0BAD-NAME=1\0\0OK_1=v\0`,
      { OK_1: 'v' },
    ],
  ])('%s', (_name, output, expected) => {
    expect(parseEnvBlock(output)).toEqual(expected);
  });
});

describe('captureLoginEnv', () => {
  it('reads the login environment and ignores whatever the profile prints first', async () => {
    const shell = fakeShell(
      'noisy.sh',
      `echo 'Welcome back! nvm is loading…'\nprintf 'DECOY=1\\0'\nexport FROM_PROFILE=yes\n${RUN_LAST_ARG}`,
    );
    const login = await captureLoginEnv({
      inherited: { PATH: '/usr/bin:/bin', PASSED_IN: 'kept' },
      shell,
    });
    expect(login.source).toBe('login_shell');
    expect(login.warning).toBeNull();
    expect(login.vars['FROM_PROFILE']).toBe('yes');
    expect(login.vars['PASSED_IN']).toBe('kept');
    expect(login.vars['DECOY']).toBeUndefined();
  });

  it('starts the login shell without the variables that name another repository', async () => {
    // A daemon started from a git hook inherits GIT_DIR; a profile's git prompt or plugin must
    // not run against that repository, and the captured environment must not carry it on.
    const seen = join(dir.path, 'profile-env');
    const shell = fakeShell('record.sh', `env > '${seen}'\n${RUN_LAST_ARG}`);
    const login = await captureLoginEnv({
      inherited: {
        PATH: '/usr/bin:/bin',
        GIT_DIR: '/h/b/Projects/other/.git',
        GIT_WORK_TREE: '/h/b/Projects/other',
        GIT_INDEX_FILE: '/h/b/Projects/other/.git/index',
        GIT_SSH_COMMAND: 'ssh -i key',
      },
      shell,
    });
    const profile = readFileSync(seen, 'utf8');
    expect(profile).not.toMatch(/^GIT_(DIR|WORK_TREE|INDEX_FILE)=/m);
    expect(profile).toMatch(/^GIT_SSH_COMMAND=ssh -i key$/m);
    expect(login.source).toBe('login_shell');
    expect(login.vars).not.toHaveProperty('GIT_DIR');
    expect(login.vars['GIT_SSH_COMMAND']).toBe('ssh -i key');
  });

  it('kills a hanging login shell and its children, then falls back to the inherited environment', async () => {
    const pids = join(dir.path, 'pids');
    const shell = fakeShell('hang.sh', `sleep 30 &\necho "$$ $!" > '${pids}'\nwait`);
    const clock = new ManualClock();
    const capture = captureLoginEnv({
      inherited: { PATH: '/usr/bin:/bin', HOME: '/h', UNSET: undefined },
      shell,
      timeoutMs: 1_000,
      clock,
    });
    // The timeout fires only when the test moves the clock, after both processes are running.
    await waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').includes(' '));
    const [shellPid, sleepPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    clock.advance(1_000);
    const login = await capture;
    expect(login.source).toBe('inherited');
    expect(login.vars).toEqual({ PATH: '/usr/bin:/bin', HOME: '/h' });
    expect(login.warning).toMatch(
      /did not finish within 1 s; using the environment 10db was started with/,
    );
    await vi.waitFor(() => {
      expect(alive(shellPid ?? 0)).toBe(false);
      expect(alive(sleepPid ?? 0)).toBe(false);
    });
  });

  it('falls back when the shell exits without printing its environment', async () => {
    const shell = fakeShell('broken.sh', 'echo "syntax error near unexpected token" >&2\nexit 1');
    const login = await captureLoginEnv({ inherited: { PATH: '/bin' }, shell });
    expect(login.source).toBe('inherited');
    expect(login.warning).toMatch(/exited with code 1 without printing its environment/);
  });

  it('falls back when the shell does not exist', async () => {
    const login = await captureLoginEnv({
      inherited: { PATH: '/bin' },
      shell: join(dir.path, 'no-such-shell'),
    });
    expect(login.source).toBe('inherited');
    expect(login.warning).toMatch(/could not start/);
  });

  it('never puts a variable value in the warning', async () => {
    const secret = 'sk-ant-api03-DO-NOT-LEAK';
    const shell = fakeShell('broken.sh', 'exit 3');
    const login = await captureLoginEnv({ inherited: { ANTHROPIC_API_KEY: secret, SHELL: shell } });
    expect(login.warning).not.toContain(secret);
  });
});

/** The real shells with the real flags: detached, no terminal, stdin closed, macOS `env -0`. */
describe.each([
  { shell: '/bin/zsh', profile: '.zshrc' },
  { shell: '/bin/sh', profile: '.profile' },
])('captureLoginEnv with $shell', ({ shell, profile }) => {
  it.skipIf(!existsSync(shell))(
    'captures what the profile exports and drops its banner',
    async () => {
      const home = join(dir.path, 'home');
      mkdirSync(home);
      writeFileSync(
        join(home, profile),
        "echo 'Good morning from the profile'\nexport FROM_REAL_PROFILE=yes\n",
      );
      // ZDOTDIR points zsh at the temp profile; /bin/sh ignores it and reads $HOME/.profile.
      const login = await captureLoginEnv({
        inherited: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home },
        shell,
      });
      expect(login.warning).toBeNull();
      expect(login.source).toBe('login_shell');
      expect(login.vars['FROM_REAL_PROFILE']).toBe('yes');
      expect(Object.values(login.vars).join('\n')).not.toContain('Good morning');
    },
  );
});

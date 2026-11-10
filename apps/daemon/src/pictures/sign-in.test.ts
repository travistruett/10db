import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppUrl, mintId, type ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import { createGateRunner, type GateRequest, type GateRunner } from '../verify';
import type { PageCamera } from './camera';
import { devLoginProblem, parseLoginUrl, signIn, sweepLoginLogs, type SignInDeps } from './sign-in';
import { readStorageState } from './storage-state';

// Workbench spec §10, §13; plan B3: the dev login runs under the gate's runner with no project id, so
// it never turns Docker on; its log holds a token, so it lives under the data directory at 0600 and is
// deleted once read; the storage state it leads to is kept there at 0600.

const APP = AppUrl.parse('http://localhost:8800');
const TOKEN_URL = 'http://localhost:8800/api/auth/dev-login/tok-123/';

describe('devLoginProblem', () => {
  const ran = { exitCode: 0, timedOut: false, aborted: false };
  it.each([
    { name: 'a run that passed', result: ran, problem: null },
    {
      name: 'a run that failed',
      result: { ...ran, exitCode: 3 },
      problem: 'The dev login command failed (exit 3)',
    },
    {
      name: 'a run the sandbox refused Docker',
      result: { ...ran, exitCode: 1, dockerRefused: true },
      problem: 'The dev login needs Docker: turn on Allow Docker in Settings › General',
    },
    {
      name: 'a run that timed out',
      result: { ...ran, exitCode: 124, timedOut: true },
      problem: 'The dev login command did not finish in 60 seconds',
    },
    {
      name: 'a run that was stopped',
      result: { ...ran, exitCode: 130, aborted: true },
      problem: 'The dev login was stopped',
    },
  ])('$name', ({ result, problem }) => {
    expect(devLoginProblem(result)).toBe(problem);
  });
});

describe('parseLoginUrl', () => {
  it.each([
    { name: "ampsio's dev login", output: `${TOKEN_URL}\n`, url: TOKEN_URL },
    {
      name: 'a path, with noise around it',
      output: 'Making a session...\n/api/auth/dev-login/abc/\nDone in 0.4s\n',
      url: 'http://localhost:8800/api/auth/dev-login/abc/',
    },
    {
      name: 'the last of two',
      output: '/first\n  /second  \n',
      url: 'http://localhost:8800/second',
    },
    {
      name: 'another origin',
      output: 'http://127.0.0.1:8800/api/auth/dev-login/abc/\n',
      url: null,
    },
    { name: 'another port', output: 'http://localhost:9000/login\n', url: null },
    { name: 'a host after two slashes', output: '//evil.example/login\n', url: null },
    { name: 'words only', output: 'no session for you\n', url: null },
    { name: 'a file path under a home', output: '/Users/me/app/manage.py\n', url: null },
    { name: 'a file path on Linux', output: '/home/me/app/log.txt\n', url: null },
    { name: 'a temp file', output: '/tmp/dev-login.json\n', url: null },
    {
      name: 'a file path after the address',
      output: '/login/abc/\n/private/var/folders/x/log\n',
      url: 'http://localhost:8800/login/abc/',
    },
    {
      name: 'the same path as a URL on the app',
      output: 'http://localhost:8800/Users/me/\n',
      url: 'http://localhost:8800/Users/me/',
    },
    { name: 'nothing', output: '', url: null },
  ])('$name', ({ output, url }) => {
    expect(parseLoginUrl(APP, output)).toBe(url);
  });
});

let dir: TempDir;
let repo: TempDir;
let projectId: ProjectId;
/** What the gate saw of its log as it started: where it was and its mode. */
let seenLogs: { path: string; mode: number }[];
let opened: string[];

beforeEach(() => {
  dir = tempDir('sign-in');
  repo = tempDir('sign-in-repo');
  projectId = mintId('Project');
  seenLogs = [];
  opened = [];
});
afterEach(() => {
  dir.cleanup();
  repo.cleanup();
});

/** The real gate runner, unsandboxed as daemon tests run it, watched as it is asked to run. */
function watchedGate(requests: GateRequest[]): GateRunner {
  const real = createGateRunner({ sandbox: null, logger: silentLogger });
  return {
    run(request) {
      requests.push(request);
      seenLogs.push({ path: request.logPath, mode: statSync(request.logPath).mode & 0o777 });
      return real.run(request);
    },
  };
}

const camera = (answer: () => Promise<unknown>): Pick<PageCamera, 'signIn'> => ({
  signIn: async (input) => {
    opened.push(input.url);
    return (await answer()) as never;
  },
});

function deps(gate: GateRunner, cam: Pick<PageCamera, 'signIn'>): SignInDeps {
  return {
    gate,
    camera: cam,
    dataDir: dir.path,
    now: () => 1_700_000_000_000,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    rules: () => [],
    checkouts: () => [repo.path],
  };
}

const project = (command: string) => ({
  id: projectId,
  repoPath: repo.path,
  sandboxLoopback: false,
  sandboxDocker: true,
  appUrl: APP,
  devLoginCommand: command,
});

const STATE = {
  cookies: [
    {
      name: 'sessionid',
      value: 'secret',
      domain: 'localhost',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ],
  origins: [],
};

describe('signIn', () => {
  it('opens the printed address, keeps the state private under the data dir, and deletes the log', async () => {
    const requests: GateRequest[] = [];
    const result = await signIn(
      deps(
        watchedGate(requests),
        camera(() => Promise.resolve(STATE)),
      ),
      project(`echo starting; echo '${TOKEN_URL}'; echo done`),
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, state: STATE });
    expect(opened).toEqual([TOKEN_URL]);
    const at = join(dir.path, 'browser', projectId);
    expect(seenLogs).toEqual([{ path: join(at, 'login-1700000000000.log'), mode: 0o600 }]);
    expect(statSync(at).mode & 0o777).toBe(0o700);
    // No project id: the dev login never turns the project's Docker on; the switch goes as stored.
    expect(requests[0]?.project).toEqual({
      repoPath: repo.path,
      sandboxLoopback: false,
      sandboxDocker: true,
    });
    expect(requests[0]?.timeoutMs).toBe(60_000);
    expect(readdirSync(at)).toEqual(['state.json']);
    expect(statSync(join(at, 'state.json')).mode & 0o777).toBe(0o600);
    expect(readStorageState(dir.path, projectId)).toEqual(STATE);
  });

  it.each([
    {
      name: 'a command that fails',
      command: `echo '${TOKEN_URL}'; exit 3`,
      problem: 'The dev login command failed (exit 3)',
    },
    {
      name: 'a command that prints no address',
      command: 'echo hello',
      problem: 'The dev login command printed no address on http://localhost:8800',
    },
  ])('says why after $name, keeps no state and deletes the log', async ({ command, problem }) => {
    const result = await signIn(
      deps(
        watchedGate([]),
        camera(() => Promise.resolve(STATE)),
      ),
      project(command),
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: false, problem });
    expect(opened).toEqual([]);
    expect(readdirSync(join(dir.path, 'browser', projectId))).toEqual([]);
    expect(readStorageState(dir.path, projectId)).toBeNull();
  });

  it('says why when the browser could not sign in, never naming the address', async () => {
    const result = await signIn(
      deps(
        watchedGate([]),
        camera(() => Promise.reject(new Error(`left the app's address at ${TOKEN_URL}`))),
      ),
      project(`echo '${TOKEN_URL}'`),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('tok-123');
    expect(readdirSync(join(dir.path, 'browser', projectId))).toEqual([]);
  });

  it("removes a dev login's log a stopped daemon left, and keeps the state", () => {
    const at = join(dir.path, 'browser', projectId);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'login-1700000000000.log'), `${TOKEN_URL}\n`);
    writeFileSync(join(at, 'state.json'), JSON.stringify(STATE));
    expect(sweepLoginLogs(dir.path)).toBe(1);
    expect(readdirSync(at)).toEqual(['state.json']);
    expect(sweepLoginLogs(join(dir.path, 'none'))).toBe(0);
  });

  it('reads a stored state back, and no state from a file that is not one', () => {
    expect(readStorageState(dir.path, projectId)).toBeNull();
    const at = join(dir.path, 'browser', projectId);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'state.json'), '{"cookies": "no"}');
    expect(readStorageState(dir.path, projectId)).toBeNull();
    expect(readFileSync(join(at, 'state.json'), 'utf8')).toContain('cookies');
  });
});

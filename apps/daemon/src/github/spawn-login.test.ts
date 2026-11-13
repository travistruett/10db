import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { spawnGhLogin } from './spawn-login';
import type { GhLoginChild } from './login';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

function scriptedGh(body: string): { gh: string; out: string } {
  const dir = tempDir('gh-login');
  dirs.push(dir);
  const gh = join(dir.path, 'gh');
  writeFileSync(gh, `#!/bin/sh\n${body}\n`);
  chmodSync(gh, 0o755);
  return { gh, out: dir.path };
}

function run(child: GhLoginChild): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    let text = '';
    child.onOutput((stream, chunk) => {
      text += `${stream}:${chunk}`;
    });
    child.onExit((code) => {
      resolve({ code, text });
    });
  });
}

describe('spawnGhLogin', () => {
  it('runs gh auth login --web with stdin closed, no browser of gh, and both streams reported', async () => {
    const { gh, out } = scriptedGh(
      [
        'printf "%s\\n" "$@" > "$OUT/args"',
        'printf "%s" "${GH_BROWSER-unset}" > "$OUT/gh-browser"',
        'printf "%s" "${BROWSER-unset}" > "$OUT/browser"',
        'if read line; then echo open > "$OUT/stdin"; else echo closed > "$OUT/stdin"; fi',
        'echo "! First copy your one-time code: ABCD-1234" >&2',
        'echo "to stdout"',
        'exit 3',
      ].join('\n'),
    );
    const child = spawnGhLogin({ git: '/usr/bin/git' })(gh, {
      OUT: out,
      PATH: '/usr/bin:/bin',
      BROWSER: '/Applications/Some.app',
      GIT_DIR: '/elsewhere/.git',
    });
    const ended = await run(child);
    expect(ended.code).toBe(3);
    expect(ended.text).toContain('stderr:! First copy your one-time code: ABCD-1234');
    expect(ended.text).toContain('stdout:to stdout');
    expect(readFileSync(join(out, 'args'), 'utf8').trim().split('\n')).toEqual([
      'auth',
      'login',
      '--web',
      '--hostname',
      'github.com',
      '--git-protocol',
      'https',
      '--skip-ssh-key',
    ]);
    expect(readFileSync(join(out, 'stdin'), 'utf8').trim()).toBe('closed');
    expect(readFileSync(join(out, 'gh-browser'), 'utf8')).toBe('/usr/bin/true');
    expect(readFileSync(join(out, 'browser'), 'utf8')).toBe('unset');
  });
  it('reports a gh that cannot start as an exit with no code', async () => {
    const ended = await run(spawnGhLogin({ git: '/usr/bin/git' })('/nonexistent/gh', {}));
    expect(ended.code).toBeNull();
  });
  it('kill stops a gh that is waiting', async () => {
    // exec, so the waiting gh is one process as the real gh is: a shell's child would hold the pipes open.
    const { gh } = scriptedGh('exec sleep 30');
    const child = spawnGhLogin({ git: '/usr/bin/git' })(gh, { PATH: '/usr/bin:/bin' });
    const ended = run(child);
    child.kill('SIGTERM');
    expect((await ended).code).toBeNull();
  });
});

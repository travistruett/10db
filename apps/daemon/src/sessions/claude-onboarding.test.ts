import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homeOutsideTemp } from '../../test/fixtures';
import { markOnboarded } from './claude-onboarding';
import { TakeoverRefusedError } from './takeover-command';

// A terminal Claude Code on an account's own directory starts past its first-run screens and trusts the folder.

let home: ReturnType<typeof homeOutsideTemp>;
afterEach(() => {
  home.cleanup();
});

function world(): { configDir: string; cwd: string; file: string } {
  home = homeOutsideTemp('onboarding');
  const configDir = join(home.path, 'claude');
  const cwd = join(home.path, 'repo');
  mkdirSync(configDir);
  mkdirSync(cwd);
  return { configDir, cwd, file: join(configDir, '.claude.json') };
}

const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

describe('markOnboarded', () => {
  it('keeps every other key, and marks the folder and its real path', async () => {
    const { configDir, cwd, file } = world();
    const real = join(home.path, 'real');
    mkdirSync(real);
    const via = join(home.path, 'via');
    symlinkSync(real, via);
    writeFileSync(
      file,
      JSON.stringify({
        userID: 'u1',
        projects: { [cwd]: { allowedTools: ['x'] }, '/other': { hasTrustDialogAccepted: false } },
      }),
    );
    await markOnboarded(configDir, via);
    expect(read(file)).toEqual({
      userID: 'u1',
      hasCompletedOnboarding: true,
      projects: {
        [cwd]: { allowedTools: ['x'] },
        '/other': { hasTrustDialogAccepted: false },
        [via]: { hasTrustDialogAccepted: true },
        [realpathSync(real)]: { hasTrustDialogAccepted: true },
      },
    });
  });

  it('creates a missing file with mode 600', async () => {
    const { configDir, cwd, file } = world();
    await markOnboarded(configDir, cwd);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(read(file)).toMatchObject({ hasCompletedOnboarding: true });
  });

  it('does not rewrite a marked file', async () => {
    const { configDir, cwd, file } = world();
    await markOnboarded(configDir, cwd);
    const long = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, long, long);
    await markOnboarded(configDir, cwd);
    expect(statSync(file).mtime.getTime()).toBe(long.getTime());
  });

  it('refuses a link in the file’s place, leaving its target', async () => {
    const { configDir, cwd, file } = world();
    const target = join(home.path, 'target.json');
    writeFileSync(target, '{"keep":true}');
    symlinkSync(target, file);
    await expect(markOnboarded(configDir, cwd)).rejects.toBeInstanceOf(TakeoverRefusedError);
    expect(readFileSync(target, 'utf8')).toBe('{"keep":true}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('refuses a file that is not JSON, leaving it as it is', async () => {
    const { configDir, cwd, file } = world();
    writeFileSync(file, 'not json');
    await expect(markOnboarded(configDir, cwd)).rejects.toBeInstanceOf(TakeoverRefusedError);
    expect(readFileSync(file, 'utf8')).toBe('not json');
  });
});

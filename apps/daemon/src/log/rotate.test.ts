import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { rotateLogFile } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('rotate');
});
afterEach(() => {
  dir.cleanup();
});

describe('rotateLogFile', () => {
  it('leaves a small file alone', () => {
    const path = join(dir.path, 'daemon.log');
    writeFileSync(path, 'small');
    rotateLogFile(path, 100, 3);
    expect(readFileSync(path, 'utf8')).toBe('small');
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('shifts numbered copies and drops the oldest beyond keep', () => {
    const path = join(dir.path, 'daemon.log');
    writeFileSync(path, 'current-'.repeat(20));
    writeFileSync(`${path}.1`, 'one');
    writeFileSync(`${path}.2`, 'two');
    rotateLogFile(path, 100, 2);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('current-');
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('one');
    expect(existsSync(`${path}.3`)).toBe(false);
  });
});

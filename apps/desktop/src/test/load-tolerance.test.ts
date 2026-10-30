import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

// The gate runs beside other lanes and Docker, so the Mac is often saturated (load average 116 on
// 10 cores). A render that takes 20 ms idle can take seconds then; no test may depend on it being
// quick. Passing tests return as soon as their condition holds, so a long deadline costs nothing.
const MIN_ASYNC_WAIT_MS = 10_000;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('load tolerance', () => {
  it('testing-library waits at least 10 s for an async query', () => {
    expect(getConfig().asyncUtilTimeout).toBeGreaterThanOrEqual(MIN_ASYNC_WAIT_MS);
  });

  it('vitest lets a test and a hook outlast that wait', () => {
    const { testTimeout, hookTimeout } = config.test ?? {};
    expect(testTimeout).toBeGreaterThan(MIN_ASYNC_WAIT_MS);
    expect(hookTimeout).toBeGreaterThan(MIN_ASYNC_WAIT_MS);
  });

  it('no test passes a shorter wait of its own to a query', () => {
    const offenders: string[] = [];
    for (const file of testFiles(join(import.meta.dirname, '..'))) {
      if (file.endsWith('load-tolerance.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\btimeout:\s*([\d_]+)/g)) {
        const ms = Number((match[1] ?? '').replaceAll('_', ''));
        if (ms < MIN_ASYNC_WAIT_MS) offenders.push(`${file}: timeout ${String(ms)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

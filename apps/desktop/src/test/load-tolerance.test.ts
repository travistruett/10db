import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getConfig, screen } from '@testing-library/react';
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

  it('a query still finds an element that a busy machine renders 2.5 s late', async () => {
    // The gate failures waited 1.2 to 2.9 s. This reproduces that delay in-process, with a timer
    // rather than load, so the check never adds load to the Mac it runs on.
    const late = setTimeout(() => {
      const note = document.createElement('p');
      note.textContent = 'Rendered late';
      document.body.append(note);
    }, 2500);
    try {
      expect((await screen.findByText('Rendered late')).tagName).toBe('P');
    } finally {
      clearTimeout(late);
      document.body.replaceChildren();
    }
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

  // vi.useFakeTimers({ shouldAdvanceTime: true }) moves the fake clock with real time too, so an
  // assertion made "N ms before a timer fires" holds only if the machine responds within N ms.
  // This guard can't measure those margins from the source, so each file that uses the option is
  // listed here once a reviewer has checked that it keeps seconds of slack around every timer.
  // Add a file only after making that check. Prefer driving the clock by hand where you can.
  const REVIEWED_SHOULD_ADVANCE_TIME = new Set([
    // 2 s of slack before the second save and 1.5 s after it, around the 4 s "Saved" timer.
    'views/settings/project-general-form.test.tsx',
  ]);

  it('every test that lets real time move fake timers is reviewed for slack', () => {
    const root = join(import.meta.dirname, '..');
    const unreviewed = testFiles(root)
      .filter((file) => !file.endsWith('load-tolerance.test.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('shouldAdvanceTime'))
      .map((file) => relative(root, file))
      .filter((file) => !REVIEWED_SHOULD_ADVANCE_TIME.has(file));
    expect(unreviewed).toEqual([]);
  });
});

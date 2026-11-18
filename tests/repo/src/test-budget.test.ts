import { describe, expect, it } from 'vitest';
import { checkTestBudget } from './test-budget';

/** A unified diff of one test file: `added` new cases and `removed` deleted ones. */
function fileDiff(path: string, added: number, removed = 0): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,0 @@',
    ...Array.from({ length: removed }, (_, n) => `-  it('was ${String(n)}', () => {`),
    ...Array.from({ length: added }, (_, n) => `+  it('does ${String(n)}', () => {`),
    '+    expect(1).toBe(1);',
  ].join('\n');
}

describe('checkTestBudget', () => {
  it.each([
    {
      name: '20 new cases on 400 code lines, with no reason, fail',
      diff: fileDiff('apps/daemon/src/x.test.ts', 20),
      code: 400,
      body: '',
      ok: false,
      says: ['20', 'budget is 3', 'Test-budget:', 'e2e'],
    },
    {
      name: 'the same with a Test-budget line in a CRLF body pass',
      diff: fileDiff('apps/daemon/src/x.test.ts', 20),
      code: 400,
      body: 'x\r\nTest-budget: why\r\n',
      ok: true,
      says: [],
    },
    {
      name: 'e2e specs and tests under apps/desktop/e2e do not count',
      diff: [
        fileDiff('apps/desktop/e2e/loop.spec.ts', 20),
        fileDiff('apps/desktop/e2e/flow.test.ts', 20),
      ].join('\n'),
      code: 0,
      body: '',
      ok: true,
      says: [],
    },
    {
      name: 'removing 10 and adding 5 nets out under the budget',
      diff: fileDiff('packages/db/src/x.test.ts', 5, 10),
      code: 0,
      body: null,
      ok: true,
      says: [],
    },
  ])('$name', ({ diff, code, body, ok, says }) => {
    const result = checkTestBudget({ diff, codeLines: code, body });
    expect(result.ok).toBe(ok);
    for (const text of says) expect(result.message).toContain(text);
  });
});

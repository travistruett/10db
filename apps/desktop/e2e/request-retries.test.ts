import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Playwright retries only ECONNRESET, and only when a request sets maxRetries. A read can reuse a keep-alive
// socket the daemon closed after its idle timeout, and a POST must never be retried: the daemon may have
// applied it already.
const dir = import.meta.dirname;
const RETRIES = /\bmaxRetries\s*:/;

interface RequestCall {
  /** The file and line of the call, for the failure message. */
  where: string;
  /** The call's arguments, from the opening parenthesis through the matching close. */
  args: string;
}

/** The text from the `(` at `open` through its matching `)`. No call's arguments hold a parenthesis in a string. */
function argumentsOf(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** Every `request.<method>(` call in the e2e specs and helpers; this harness's own tests are not requests. */
function requestCalls(method: 'get' | 'post'): RequestCall[] {
  const calls: RequestCall[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(new RegExp(`\\brequest\\.${method}\\(`, 'g'))) {
      const start = match.index;
      calls.push({
        where: `${file}:${String(text.slice(0, start).split('\n').length)}`,
        args: argumentsOf(text, start + match[0].length - 1),
      });
    }
  }
  return calls;
}

describe('the e2e request fixture', () => {
  it('gives every read a retry, so a socket the daemon closed while idle does not fail the spec', () => {
    const reads = requestCalls('get');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((call) => !RETRIES.test(call.args)).map((call) => call.where)).toEqual([]);
  });

  it('gives no POST a retry', () => {
    const posts = requestCalls('post');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.filter((call) => RETRIES.test(call.args)).map((call) => call.where)).toEqual([]);
  });
});

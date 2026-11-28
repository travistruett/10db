import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { RESET_RETRIES, withResetRetries } from './retrying-request';

// Playwright retries only ECONNRESET, and only when a request sets maxRetries. A request can reuse a
// keep-alive socket the daemon closed after its idle timeout, so every spec's API request, a write
// included, takes the retry from the shared request fixture rather than from each call.
const dir = import.meta.dirname;
const RETRIES = /\bmaxRetries\s*:/;

interface Sent {
  method: string;
  url: string;
  options: { maxRetries?: number; data?: unknown } | undefined;
}

/** A request context that records each request, standing in for the one Playwright makes. */
function recordingContext(): { request: APIRequestContext; sent: Sent[] } {
  const sent: Sent[] = [];
  const send = (method: string) => (url: string, options?: Sent['options']) => {
    sent.push({ method, url, options });
    return Promise.resolve({ ok: () => true });
  };
  const request = {
    delete: send('delete'),
    fetch: send('fetch'),
    get: send('get'),
    head: send('head'),
    patch: send('patch'),
    post: send('post'),
    put: send('put'),
    dispose: () => Promise.resolve(),
  };
  // A fake with only the members under test, in place of Playwright's own context.
  return { request: request as unknown as APIRequestContext, sent };
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

describe('the e2e request fixture', () => {
  it('retries a reset connection on every method, and lets a call set its own retries', async () => {
    const { request, sent } = recordingContext();
    const retrying = withResetRetries(request);
    await retrying.get('/a');
    await retrying.post('/b', { data: { x: 1 } });
    await retrying.patch('/c');
    await retrying.put('/d');
    await retrying.delete('/e');
    await retrying.head('/f');
    await retrying.fetch('/g');
    await retrying.get('/h', { maxRetries: 0 });
    await retrying.dispose();

    expect(sent.map((call) => [call.method, call.options?.maxRetries])).toEqual([
      ['get', RESET_RETRIES],
      ['post', RESET_RETRIES],
      ['patch', RESET_RETRIES],
      ['put', RESET_RETRIES],
      ['delete', RESET_RETRIES],
      ['head', RESET_RETRIES],
      ['fetch', RESET_RETRIES],
      ['get', 0],
    ]);
    expect(sent[1]?.options?.data).toEqual({ x: 1 });
  });

  it('is the only test every spec runs on, so a new spec gets the retry', () => {
    const own: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.spec.ts')) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@playwright\/test'/gu)) {
        if (/\btest\b/u.test(match[1] ?? '')) own.push(file);
      }
    }
    expect(own).toEqual([]);
  });

  it('gives every route.fetch a retry, since it reuses the same keep-alive sockets', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      for (const match of text.matchAll(/\broute\.fetch\(/gu)) {
        seen += 1;
        const args = argumentsOf(text, match.index + match[0].length - 1);
        if (!RETRIES.test(args)) {
          missing.push(`${file}:${String(text.slice(0, match.index).split('\n').length)}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

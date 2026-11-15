import { describe, expect, it } from 'vitest';
import { connectionFrom, httpApi, TendbError } from './index';

const files = (map: Record<string, string>) => (path: string) => {
  const text = map[path];
  if (text === undefined) throw new Error('ENOENT');
  return text;
};

describe('connectionFrom', () => {
  const rows: { name: string; files: Record<string, string>; message: string }[] = [
    { name: 'no daemon.json', files: {}, message: "10db isn't running" },
    {
      name: 'no ui-token',
      files: { '/app/daemon.json': '{"port":1}' },
      message: "10db isn't running",
    },
    {
      name: 'a non-integer port',
      files: { '/app/daemon.json': '{"port":"x"}', '/app/ui-token': 't' },
      message: 'daemon.json has no port',
    },
  ];
  it.each(rows)('says so for $name', ({ files: f, message }) => {
    expect(() => connectionFrom('/app', files(f))).toThrow(message);
  });

  const tokens: { name: string; token: string }[] = [
    { name: 'an empty token', token: '\n' },
    { name: 'a token with a space inside', token: 'to ken' },
    { name: 'a token with a newline inside', token: 'to\nken' },
    { name: 'a token with a control character', token: 'to\u0007ken' },
  ];
  it.each(tokens)("says 10db isn't running for $name", ({ token }) => {
    const f = files({ '/app/daemon.json': '{"port":1}', '/app/ui-token': token });
    expect(() => connectionFrom('/app', f)).toThrow("10db isn't running");
  });

  it('reads the port and trims the token', () => {
    const conn = connectionFrom(
      '/app',
      files({ '/app/daemon.json': '{"port":4321}', '/app/ui-token': 'tok\n' }),
    );
    expect(conn).toEqual({ base: 'http://127.0.0.1:4321', token: 'tok' });
  });
});

describe('httpApi', () => {
  const conn = { base: 'http://127.0.0.1:1', token: 'tok' };
  function fake(status: number, body: string) {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const impl: typeof fetch = (input, init) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body,
      });
      return Promise.resolve(new Response(body, { status }));
    };
    return { impl, seen };
  }

  it('sends the version header only when given', async () => {
    const withVersion = fake(200, '{"a":1}');
    expect(await httpApi(conn, 'v1', withVersion.impl)('GET', '/x')).toEqual({ a: 1 });
    expect(withVersion.seen[0]?.headers['x-10db-skill-version']).toBe('v1');
    expect(withVersion.seen[0]?.headers['authorization']).toBe('Bearer tok');
    const without = fake(200, '');
    expect(await httpApi(conn, null, without.impl)('GET', '/x')).toBeNull();
    expect(without.seen[0]?.headers).not.toHaveProperty('x-10db-skill-version');
  });

  it('sends a JSON body with its content type', async () => {
    const f = fake(200, '{}');
    await httpApi(conn, null, f.impl)('POST', '/x', { a: 1 });
    expect(f.seen[0]?.headers['content-type']).toBe('application/json');
    expect(f.seen[0]?.body).toBe('{"a":1}');
  });

  it('turns a 401 into the token message', async () => {
    const f = fake(401, 'no');
    await expect(httpApi(conn, null, f.impl)('GET', '/x')).rejects.toThrow(
      'refused the token (401)',
    );
  });

  it('turns a 409 skill_version into its message verbatim', async () => {
    const f = fake(409, JSON.stringify({ error: 'skill_version', message: 'Restart 10db.' }));
    await expect(httpApi(conn, 'v1', f.impl)('GET', '/x')).rejects.toMatchObject({
      message: 'Restart 10db.',
    });
  });

  it('keeps the status on any other failure', async () => {
    const f = fake(404, 'gone');
    const error = await httpApi(conn, null, f.impl)('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TendbError);
    expect(error).toMatchObject({ status: 404, message: 'GET /x failed with 404: gone' });
  });

  it('says 10db may be closed, and the Codex sandbox hint, when the fetch fails', async () => {
    const impl: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const error = await httpApi(conn, null, impl)('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TendbError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain(
      "Couldn't reach 10db at http://127.0.0.1:1. Is the app open? daemon.json may be stale.",
    );
    expect(message).toContain(
      'In Codex, the sandbox may block localhost: allow network access for this session.',
    );
  });
});

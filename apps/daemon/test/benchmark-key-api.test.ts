import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { BenchmarkStatusDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import { AA_KEY_ACCOUNT, keychainWith } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { tempDir, waitForAsync } from './fixtures';

const KEY = 'aa-0123456789abcdef-NEVER-SHOWN';
const QUIET = { caffeinate: () => null, watch: false } as const;

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let aaRequests: { key: string | null }[];
let aaStatus: number;
/** While set, an AA request waits for it, so a sync can be held open. */
let aaGate: Promise<void> | null;

beforeEach(() => {
  data = tempDir('benchmark key api');
  daemon = null;
  aaRequests = [];
  aaStatus = 200;
  aaGate = null;
});
afterEach(async () => {
  await daemon?.stop();
  data.cleanup();
});

/** `security` as a boundary double: `-i` writes land in `items`, and every call is counted. */
function securityDouble(opts: { refuseWrites?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: (readonly string[])[] = [];
  const exec = (
    _cmd: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ): string => {
    calls.push(args);
    if (args[0] === '-i') {
      if (opts.refuseWrites === true) throw Object.assign(new Error('denied'), { status: 36 });
      const match = /-a "([^"]+)" -w "([^"]*)"/.exec(
        typeof options.input === 'string' ? options.input : '',
      );
      if (match?.[1] !== undefined && match[2] !== undefined) items.set(match[1], match[2]);
      return '';
    }
    const account = args[args.indexOf('-a') + 1] ?? '';
    if (args[0] === 'delete-generic-password') {
      if (!items.delete(account)) throw Object.assign(new Error('not found'), { status: 44 });
      return '';
    }
    const value = items.get(account);
    if (value === undefined) throw Object.assign(new Error('not found'), { status: 44 });
    return `${value}\n`;
  };
  return { exec, items, calls };
}

async function start(
  opts: { security?: ReturnType<typeof securityDouble>; benchmarksOff?: boolean } = {},
) {
  const security = opts.security ?? securityDouble();
  const keychain = keychainWith(security.exec);
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    keychain,
    // The entry point reads the key from the Keychain unless the daemon was started with the switch off.
    aaKey: opts.benchmarksOff === true ? () => null : () => keychain.read(AA_KEY_ACCOUNT),
    ...(opts.benchmarksOff === true ? { benchmarksOff: true } : {}),
    fetch: async (_input, init) => {
      aaRequests.push({ key: new Headers(init?.headers).get('x-api-key') });
      await aaGate;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            pagination: { has_more: false },
            data: [{ slug: 'some-model', name: 'Some', model_creator: { name: 'Lab' } }],
          }),
          { status: aaStatus },
        ),
      );
    },
    ...QUIET,
  });
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon?.url ?? ''}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${daemon?.token ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { api: apiClient(daemon.url, daemon.token), raw, security };
}

describe('PUT /benchmarks/key', () => {
  it('writes the Keychain item, starts a sync with that key and answers a status with the key set', async () => {
    const { api, security } = await start();
    const status = await api.put('/benchmarks/key', BenchmarkStatusDto, { key: `  ${KEY}  ` });
    expect(status).toMatchObject({ keyConfigured: true, off: false });
    expect(security.items.get(AA_KEY_ACCOUNT)).toBe(KEY);
    await waitForAsync(async () =>
      (await api.get('/benchmarks/status', BenchmarkStatusDto)).outcome === 'ok' ? true : undefined,
    );
    expect(aaRequests.at(-1)).toEqual({ key: KEY });
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      keyConfigured: true,
      outcome: 'ok',
      syncing: false,
    });
  });

  it('keeps the key it was given when AA refuses it, and says so in the status', async () => {
    aaStatus = 401;
    const { api } = await start();
    await api.put('/benchmarks/key', BenchmarkStatusDto, { key: KEY });
    const status = await waitForAsync(async () => {
      const s = await api.get('/benchmarks/status', BenchmarkStatusDto);
      return s.outcome === 'unauthorized' ? s : undefined;
    });
    expect(status).toMatchObject({ keyConfigured: true, syncing: false });
  });

  it.each([
    ['blank', { key: '   ' }],
    ['with a space', { key: 'aa abc' }],
    ['with an extra field', { key: KEY, extra: 1 }],
  ])('refuses a key that is %s, writing nothing', async (_name, body) => {
    const { raw, security } = await start();
    const res = await raw('PUT', '/benchmarks/key', body);
    expect(res.status).toBe(400);
    expect(security.items.size).toBe(0);
  });

  it('answers 409 and starts no sync when the Keychain refuses the write', async () => {
    const { raw } = await start({ security: securityDouble({ refuseWrites: true }) });
    const before = aaRequests.length;
    const res = await raw('PUT', '/benchmarks/key', { key: KEY });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(AA_KEY_ACCOUNT);
    expect(aaRequests.length).toBe(before);
  });

  it('is refused 409 with TENDB_BENCHMARKS=off, and never touches the Keychain', async () => {
    const { raw, security } = await start({ benchmarksOff: true });
    const res = await raw('PUT', '/benchmarks/key', { key: KEY });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Started with TENDB_BENCHMARKS=off');
    expect(security.calls).toEqual([]);
  });
});

describe('PUT /benchmarks/key during a running sync', () => {
  it('checks the new key with a sync of its own, after the one that read the old key', async () => {
    const { api, security } = await start();
    let release: () => void = () => undefined;
    aaGate = new Promise((resolve) => {
      release = resolve;
    });
    await api.put('/benchmarks/key', BenchmarkStatusDto, { key: 'aa-old-key-not-a-secret' });
    await waitForAsync(() => Promise.resolve(aaRequests.length > 0 ? true : undefined));
    await api.put('/benchmarks/key', BenchmarkStatusDto, { key: KEY });
    expect(security.items.get(AA_KEY_ACCOUNT)).toBe(KEY);
    release();
    await waitForAsync(() => Promise.resolve(aaRequests.length >= 2 ? true : undefined));
    expect(aaRequests.map((r) => r.key)).toEqual(['aa-old-key-not-a-secret', KEY]);
  });
});

describe('DELETE /benchmarks/key', () => {
  it('removes the Keychain item and answers a status with no key', async () => {
    const { api, raw, security } = await start();
    await api.put('/benchmarks/key', BenchmarkStatusDto, { key: KEY });
    const res = await raw('DELETE', '/benchmarks/key');
    expect(res.status).toBe(200);
    expect(BenchmarkStatusDto.parse(await res.json())).toMatchObject({ keyConfigured: false });
    expect(security.items.has(AA_KEY_ACCOUNT)).toBe(false);
  });

  it('clears a refused key from the status, so nothing is left asking for a new one', async () => {
    aaStatus = 401;
    const { api, raw } = await start();
    await api.put('/benchmarks/key', BenchmarkStatusDto, { key: KEY });
    await waitForAsync(async () =>
      (await api.get('/benchmarks/status', BenchmarkStatusDto)).outcome === 'unauthorized'
        ? true
        : undefined,
    );
    const requests = aaRequests.length;
    await raw('DELETE', '/benchmarks/key');
    await waitForAsync(async () =>
      (await api.get('/benchmarks/status', BenchmarkStatusDto)).outcome === 'no_key'
        ? true
        : undefined,
    );
    expect(aaRequests.length).toBe(requests);
  });

  it('is refused 409 with TENDB_BENCHMARKS=off, and never touches the Keychain', async () => {
    const { raw, security } = await start({ benchmarksOff: true });
    const res = await raw('DELETE', '/benchmarks/key');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Started with TENDB_BENCHMARKS=off');
    expect(security.calls).toEqual([]);
  });
});

describe('GET /benchmarks/status', () => {
  it('reads whether the key is set from the Keychain now, not from the last sync', async () => {
    const security = securityDouble();
    const { api } = await start({ security });
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      keyConfigured: false,
    });
    security.items.set(AA_KEY_ACCOUNT, KEY);
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      keyConfigured: true,
    });
    security.items.delete(AA_KEY_ACCOUNT);
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      keyConfigured: false,
    });
  });

  it('with TENDB_BENCHMARKS=off says off and no key, without reading the Keychain', async () => {
    const security = securityDouble();
    security.items.set(AA_KEY_ACCOUNT, KEY);
    const { api } = await start({ security, benchmarksOff: true });
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      keyConfigured: false,
      off: true,
    });
    expect(security.calls).toEqual([]);
  });
});

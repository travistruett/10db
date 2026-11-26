import { createTestStore, setAppSetting } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createSocketRegistry } from '../devices';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import type { ShareListenResult } from './share-listener';
import { createSharingService } from './sharing-service';
import type { CliResult, TailscaleRun } from './tailscale-cli';

const FQDN = 'mac.tail1234.ts.net';
const PORT = 4319;
const KEY = `${FQDN}:${String(PORT)}`;

const TENDB_SERVE = {
  TCP: { [String(PORT)]: { HTTPS: true } },
  Web: { [KEY]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${String(PORT)}` } } } },
};
const ELSEWHERE_SERVE = {
  TCP: { [String(PORT)]: { HTTPS: true } },
  Web: { [KEY]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
};
const TAILSCALE_STATUS = {
  BackendState: 'Running',
  Version: '1.104.7',
  CertDomains: [FQDN],
  Self: { DNSName: `${FQDN}.`, UserID: 1, Tags: null },
  User: { '1': { LoginName: 'me@example.com' } },
};

const ok = (stdout = ''): CliResult => ({ code: 0, stdout, stderr: '', timedOut: false });

let state: StateStore;
let closeStore: () => void;
let order: string[];
let calls: string[];
let serveJson: unknown;
let listenCalls: number;
let failUnserve: boolean;

/** A Tailscale that answers status, tracks serve mappings and records every call. */
const run: TailscaleRun = (args) => {
  const line = args.join(' ');
  calls.push(line);
  if (line === 'status --json') return Promise.resolve(ok(JSON.stringify(TAILSCALE_STATUS)));
  if (line === 'serve status --json') return Promise.resolve(ok(JSON.stringify(serveJson)));
  if (args[0] === 'serve' && args[1] === '--bg') {
    serveJson = TENDB_SERVE;
    return Promise.resolve(ok());
  }
  if (args[0] === 'serve' && args[2] === 'off') {
    order.push('unserve');
    if (failUnserve) {
      return Promise.resolve({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    }
    serveJson = {};
    return Promise.resolve(ok());
  }
  return Promise.resolve(ok());
};

function make() {
  const sockets = createSocketRegistry();
  sockets.add(
    { scope: 'full', deviceId: null, listener: 'share' },
    {
      close: () => {
        order.push('closeListener');
      },
    },
  );
  const listen = (): Promise<ShareListenResult> => {
    listenCalls += 1;
    return Promise.resolve({
      ok: true,
      listener: {
        port: PORT,
        close: () => {
          order.push('close');
          return Promise.resolve();
        },
      },
    });
  };
  return createSharingService({
    state,
    clock: new ManualClock(),
    log: silentLogger,
    cli: () => '/usr/local/bin/tailscale',
    run: () => run,
    listen,
    sockets,
    mainPort: () => 4318,
  });
}

beforeEach(() => {
  const created = createTestStore();
  closeStore = created.close;
  state = createStateStore(created.store, createEventBus());
  order = [];
  calls = [];
  serveJson = {};
  listenCalls = 0;
  failUnserve = false;
});
afterEach(() => {
  closeStore();
});

describe('the sharing service', () => {
  it('shares only its own mapping and unserves before it closes', async () => {
    const service = make();
    service.status();
    await service.start();
    expect(calls.some((call) => call.startsWith('cert'))).toBe(false);

    await service.requestCertificate();
    expect(calls.filter((call) => call.startsWith('cert'))).toHaveLength(1);

    const shared = await service.set({ enabled: true, port: PORT });
    expect(shared.state).toBe('ready');
    expect(calls).toContain(`serve --bg --https=${String(PORT)} http://127.0.0.1:${String(PORT)}`);

    await service.stop();
    expect(order).toEqual(['unserve', 'closeListener', 'close']);
  });

  it('never removes a mapping that points elsewhere', async () => {
    const service = make();
    await service.requestCertificate();
    serveJson = ELSEWHERE_SERVE;
    await expect(service.set({ enabled: true, port: PORT })).rejects.toThrow(/already maps/);
    await service.set({ enabled: false });
    await service.stop();
    expect(order).not.toContain('unserve');
    expect(listenCalls).toBe(0);
  });

  it('does not listen at start with Funnel on the port', async () => {
    const service = make();
    await service.requestCertificate();
    state.write((ctx) => {
      setAppSetting(ctx, 'sharing.enabled', true);
      setAppSetting(ctx, 'sharing.port', PORT);
    });
    serveJson = { ...TENDB_SERVE, AllowFunnel: { [KEY]: true } };
    await service.start();
    expect(listenCalls).toBe(0);
    expect(service.status().state).toBe('paused');
    expect(order).not.toContain('unserve');
  });

  it('leaves the CLI alone when this daemon never shared', async () => {
    const service = make();
    await service.stop();
    expect(calls).toEqual([]);
  });

  it('retries an unserve that failed on Stop at the next start', async () => {
    const first = make();
    await first.requestCertificate();
    await first.set({ enabled: true, port: PORT });
    failUnserve = true;
    await first.set({ enabled: false });
    expect(serveJson).toEqual(TENDB_SERVE);
    failUnserve = false;
    await first.stop();

    await make().start();
    expect(serveJson).toEqual({});
  });

  it('restores a lost mapping when Share is pressed again', async () => {
    const service = make();
    await service.requestCertificate();
    await service.set({ enabled: true, port: PORT });
    serveJson = {};
    const again = await service.set({ enabled: true, port: PORT });
    expect(again.state).toBe('ready');
    expect(serveJson).toEqual(TENDB_SERVE);
    expect(listenCalls).toBe(1);
  });
});

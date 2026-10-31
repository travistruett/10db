import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanePermissionsDto } from '@10db/contracts';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('lane permissions');
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  data.cleanup();
});

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<unknown> {
  const res = await fetch(`${daemon.url}/settings/lane-permissions`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return LanePermissionsDto.parse(await res.json());
}

describe('the lane permission setting', () => {
  it('starts on, and keeps what the builder sets', async () => {
    expect(await call('GET')).toEqual({ autoMode: true });
    expect(await call('PUT', { autoMode: false })).toEqual({ autoMode: false });
    expect(await call('GET')).toEqual({ autoMode: false });
    expect(await call('PUT', { autoMode: true })).toEqual({ autoMode: true });
    expect(await call('GET')).toEqual({ autoMode: true });
  });
});

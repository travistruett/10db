import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { aaKeyReaderFromEnv, daemonOptionsFromEnv } from './options-from-env';

describe('daemonOptionsFromEnv', () => {
  it('sandboxes every lane of a daemon that runs real Claude Code sessions', () => {
    expect(daemonOptionsFromEnv(loadEnv({})).sandbox).toEqual({});
  });

  it('runs fake sessions, which run no commands, unsandboxed', () => {
    expect(
      daemonOptionsFromEnv(loadEnv({ TENDB_FAKE_SCRIPTS: '/tmp/book.json' })).sandbox,
    ).toBeNull();
  });

  it.each([
    ['TENDB_LANE_SANDBOX', 'off'],
    ['TENDB_LANE_SANDBOX_LOOPBACK', 'on'],
    ['TENDB_LANE_PERMISSION_MODE', 'auto'],
  ])('lets no %s=%s turn the sandbox off or choose a permission mode', (name, value) => {
    const options = daemonOptionsFromEnv(loadEnv({ [name]: value }));
    expect(options.sandbox).toEqual({});
    expect(options).not.toHaveProperty('permissionModeOverride');
  });

  it('carries the port, log level and dev UI settings', () => {
    const token = 'a'.repeat(43);
    expect(
      daemonOptionsFromEnv(
        loadEnv({
          TENDB_PORT: '0',
          TENDB_LOG_LEVEL: 'warn',
          TENDB_DEV_UI_TOKEN: token,
          TENDB_DEV_UI_ORIGIN: 'http://localhost:51234',
        }),
      ),
    ).toEqual({
      port: 0,
      logLevel: 'warn',
      sandbox: {},
      uiToken: token,
      devUiOrigin: 'http://localhost:51234',
    });
  });

  it('passes TENDB_GATE_SLOTS as the gate slot limit, and leaves the default when unset', () => {
    expect(daemonOptionsFromEnv(loadEnv({ TENDB_GATE_SLOTS: '2' })).limits).toEqual({
      gateSlots: 2,
    });
    expect(daemonOptionsFromEnv(loadEnv({}))).not.toHaveProperty('limits');
  });

  it('passes TENDB_WORKTREE_ROOT as worktreeRoot, and omits it when unset', () => {
    expect(daemonOptionsFromEnv(loadEnv({ TENDB_WORKTREE_ROOT: '/var/wt' })).worktreeRoot).toBe(
      '/var/wt',
    );
    expect(daemonOptionsFromEnv(loadEnv({}))).not.toHaveProperty('worktreeRoot');
  });

  it.each([
    ['absent', {}, 'real-key'],
    ['on', { TENDB_BENCHMARKS: 'on' }, 'real-key'],
    ['off', { TENDB_BENCHMARKS: 'off' }, null],
  ])(
    'reads the benchmark key from the keychain when TENDB_BENCHMARKS is %s',
    (_name, source, expected) => {
      let reads = 0;
      const reader = aaKeyReaderFromEnv(loadEnv(source), () => {
        reads += 1;
        return 'real-key';
      });
      expect(reader()).toBe(expected);
      expect(reads).toBe(expected === null ? 0 : 1);
    },
  );
});

import { describe, expect, it } from 'vitest';
import {
  createPinnedAdapter,
  createUnavailableAdapter,
  type AdapterSource,
  type SessionAdapter,
} from './index';

const probe = {
  accountId: 'acc_1',
  label: 'Claude plan',
  kind: 'claude_subscription',
  identity: null,
  env: {},
  cwd: '/tmp',
} as unknown as Parameters<SessionAdapter['probeAccount']>[0];

describe('createPinnedAdapter', () => {
  it('refuses with the reason while the copy is not ready, and runs on it once it is', async () => {
    let source: AdapterSource = {
      ready: false,
      message: 'Claude Code 2.1.302 is being downloaded',
    };
    const built: string[] = [];
    const adapter = createPinnedAdapter(
      () => source,
      (path) => {
        built.push(path);
        return {
          ...createUnavailableAdapter('unused'),
          probeAccount: () => Promise.reject(new Error(`ran ${path}`)),
        };
      },
    );
    await expect(adapter.probeAccount(probe)).rejects.toThrow('being downloaded');
    expect(built).toEqual([]);
    source = { ready: true, path: '/data/tools/claude/claude' };
    await expect(adapter.probeAccount(probe)).rejects.toThrow('ran /data/tools/claude/claude');
    await expect(adapter.probeAccount(probe)).rejects.toThrow('ran /data/tools/claude/claude');
    expect(built).toEqual(['/data/tools/claude/claude']);
  });

  it('stops running on a copy once it is refused', async () => {
    let source: AdapterSource = { ready: true, path: '/data/tools/codex/bin/codex' };
    const adapter = createPinnedAdapter(
      () => source,
      () => ({
        ...createUnavailableAdapter('unused'),
        probeAccount: () => Promise.reject(new Error('ran')),
      }),
    );
    await expect(adapter.probeAccount(probe)).rejects.toThrow('ran');
    source = { ready: false, message: 'Codex 0.167.0 was refused: its files changed' };
    await expect(adapter.probeAccount(probe)).rejects.toThrow('was refused: its files changed');
  });
});

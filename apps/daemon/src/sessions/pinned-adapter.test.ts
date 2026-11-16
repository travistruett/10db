import { describe, expect, it } from 'vitest';
import { silentLogger } from '../log';
import {
  claudeCapabilities,
  claudeTakeoverNotes,
  codexCapabilities,
  codexTakeoverNotes,
  createClaudeAdapter,
  createCodexAdapter,
  createPinnedAdapter,
  createUnavailableAdapter,
  TakeoverRefusedError,
  type AdapterSource,
  type AgentAdapter,
  type TakeoverSpec,
} from './index';

const probe = {
  accountId: 'acc_1',
  label: 'Claude plan',
  kind: 'claude_subscription',
  identity: null,
  env: {},
  cwd: '/tmp',
} as unknown as Parameters<AgentAdapter['probeAccount']>[0];

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
          ...createUnavailableAdapter('unused', (a) => codexCapabilities(a.kind)),
          probeAccount: () => Promise.reject(new Error(`ran ${path}`)),
        };
      },
      (a) => codexCapabilities(a.kind),
    );
    await expect(adapter.probeAccount(probe)).rejects.toThrow('being downloaded');
    expect(adapter.capabilities({ kind: 'codex_signin' }, null)).toEqual(
      codexCapabilities('codex_signin'),
    );
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
        ...createUnavailableAdapter('unused', (a) => codexCapabilities(a.kind)),
        probeAccount: () => Promise.reject(new Error('ran')),
      }),
      (a) => codexCapabilities(a.kind),
    );
    await expect(adapter.probeAccount(probe)).rejects.toThrow('ran');
    source = { ready: false, message: 'Codex 0.167.0 was refused: its files changed' };
    await expect(adapter.probeAccount(probe)).rejects.toThrow('was refused: its files changed');
  });
});

const takeoverSpec = (kind: TakeoverSpec['kind']): Omit<TakeoverSpec, 'binary'> => ({
  kind,
  cwd: '/work/repo',
  providerSessionId: 'abc-123',
  model: 'm',
  effort: 'high',
  launch: {
    set: {},
    unset: [],
    unsetPrefixes: [],
    keychain: [],
    apiKeyHelperAccount: null,
    scrub: false,
    model: 'm',
  },
  pluginDirs: [],
  instructionsFile: null,
  mcpConfigFile: null,
  codexServers: [],
  sealedEnvFile: null,
  web: false,
});

describe('a pinned adapter’s takeover', () => {
  const adapters = [
    {
      name: 'Claude',
      kind: 'claude_subscription',
      build: (path: string) =>
        createClaudeAdapter({ claudePath: path, pluginDir: '/h', logger: silentLogger }),
      capabilities: (a: { kind: TakeoverSpec['kind'] }) => claudeCapabilities(a.kind, null),
      notes: claudeTakeoverNotes,
    },
    {
      name: 'Codex',
      kind: 'codex_signin',
      build: (path: string) => createCodexAdapter({ codexPath: path, logger: silentLogger }),
      capabilities: (a: { kind: TakeoverSpec['kind'] }) => codexCapabilities(a.kind),
      notes: codexTakeoverNotes,
    },
  ] as const;

  it.each(adapters)(
    'runs $name’s command on the ready copy, and says why when it is not ready',
    (row) => {
      let source: AdapterSource = { ready: true, path: '/data/tools/agent' };
      const adapter = createPinnedAdapter(() => source, row.build, row.capabilities, row.notes);
      expect(adapter.takeoverCommand(takeoverSpec(row.kind)).argv[0]).toBe('/data/tools/agent');
      for (const message of [
        'Claude Code 2.1.302 is being downloaded',
        'it was refused: files changed',
      ]) {
        source = { ready: false, message };
        expect(() => adapter.takeoverCommand(takeoverSpec(row.kind))).toThrow(
          new TakeoverRefusedError(message),
        );
      }
    },
  );

  it.each(adapters)('tells the notes of $name while its copy is still being fetched', (row) => {
    const adapter = createPinnedAdapter(
      () => ({ ready: false, message: 'being downloaded' }),
      row.build,
      row.capabilities,
      row.notes,
    );
    const notes = adapter.takeoverNotes({ kind: row.kind });
    expect(notes).toEqual(row.notes());
    expect(notes.length).toBeGreaterThan(0);
  });

  it('gives the notes each harness has: Codex’s first screen and skills gap, Claude’s settings line', () => {
    expect(codexTakeoverNotes()).toEqual([
      'Codex asks how to open the folder first: choose Open restricted.',
      "Codex in your terminal doesn't get your skills folders.",
    ]);
    expect(claudeTakeoverNotes().join(' ')).toContain('not loaded');
  });
});

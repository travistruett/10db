import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { DeniedBy, JudgeKind, TRUST_DEFAULTS, TrustSurface } from '@10db/contracts';
import { createTestStore, seedProject } from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOXED } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createHookJudge, createLimitNotes } from '../inbox';
import { createJudge } from '../judge';
import { silentLogger } from '../log';
import { buildTrustPolicy } from '../trust';
import { chatFolderInUse, judgeChatCall, type ChatPlace } from '../chat';
import { judgeShapeCall, type ShapeAccess } from '../shape';
import { codexHomes } from './codex-home';
import {
  guardCalls,
  judgeHookCall,
  openGuardSocket,
  patchPaths,
  type GuardAnswer,
  type GuardSocket,
  type HookInput,
} from './codex-guard';
import type { ClaudeDenial } from './claude-tool-calls';
import type { LaneSessionSpec } from './types';

type Spec = Pick<LaneSessionSpec, 'preToolUse' | 'canUseTool' | 'judgeCall'>;

const ALLOW_ALL: Spec = {
  preToolUse: () => ({ decision: 'allow' }),
  canUseTool: () => Promise.resolve({ behavior: 'allow' }),
};
const NEVER = new AbortController().signal;

describe('guardCalls', () => {
  it.each([
    ['Bash', { command: 'ls' }, [{ toolName: 'Bash', input: { command: 'ls' }, hunk: null }]],
    [
      'mcp__10db__commit',
      { message: 'x' },
      [{ toolName: 'mcp__10db__commit', input: { message: 'x' }, hunk: null }],
    ],
    [
      'mcp__10db__no_arguments',
      undefined,
      [{ toolName: 'mcp__10db__no_arguments', input: {}, hunk: null }],
    ],
    ['Bash', 'not an object', null],
    ['Bash', {}, null],
    ['Bash', { command: 3 }, null],
    ['Bash', { cmd: 'git push' }, null],
    ['Bash', { command: ['git', 'push'] }, null],
    ['view_image', { path: 'a.png' }, null],
    ['write_stdin', {}, null],
    ['anything_new', {}, null],
  ])('%s', (tool_name, tool_input, expected) => {
    expect(guardCalls({ tool_name, tool_input })).toEqual(expected);
  });

  it('turns a patch into one Edit per path, a move into both', () => {
    const command = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '*** Move to: src/b.ts',
      '@@',
      '-x',
      '+y',
      '*** Add File: c.ts',
      '+z',
      '*** End Patch',
    ].join('\n');
    expect(
      guardCalls({ tool_name: 'apply_patch', tool_input: { command }, cwd: '/work/copy' }),
    ).toEqual([
      { toolName: 'Edit', input: { file_path: '/work/copy/src/a.ts' }, hunk: 'move' },
      { toolName: 'Edit', input: { file_path: '/work/copy/src/b.ts' }, hunk: 'move' },
      { toolName: 'Edit', input: { file_path: '/work/copy/c.ts' }, hunk: 'add' },
    ]);
  });

  it.each([
    ['Add File is add', '*** Add File: a.ts\n+x', ['add']],
    ['Update File is update', '*** Update File: a.ts\n@@\n-x\n+y', ['update']],
    ['Delete File is delete', '*** Delete File: a.ts', ['delete']],
    [
      'Update File with Move to is move',
      '*** Update File: a.ts\n*** Move to: b.ts',
      ['move', 'move'],
    ],
  ])('%s', (_name, command, hunks) => {
    const calls = guardCalls({ tool_name: 'apply_patch', tool_input: { command } });
    expect(calls?.map((c) => c.hunk)).toEqual(hunks);
  });

  it('Bash has no hunk', () => {
    expect(guardCalls({ tool_name: 'Bash', tool_input: { command: 'ls' } })?.[0]?.hunk).toBeNull();
  });

  it('leaves a patch path alone when the hook gave no cwd', () => {
    expect(
      guardCalls({ tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.ts' } }),
    ).toEqual([{ toolName: 'Edit', input: { file_path: 'a.ts' }, hunk: 'add' }]);
  });

  it.each([
    ['an unknown marker', '*** Add File: a.ts\n*** Frobnicate: b'],
    ['an indented unknown marker', '*** Add File: a.ts\n  *** Rename File: b'],
  ])('refuses a patch with %s', (_name, command) => {
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command } })).toBeNull();
  });

  it('refuses a line it does not know in an Update hunk', () => {
    const command = '*** Update File: a.ts\n@@\n-b\n*** Frobnicate: c';
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command } })).toBeNull();
  });

  it('refuses an environment line, which 10db has no use for', () => {
    const command = '*** Environment ID: x\n*** Add File: a.ts';
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command } })).toBeNull();
  });

  it('reads a long run of interior whitespace quickly', () => {
    const command = `*** Add File: a.ts\n+x${' '.repeat(400_000)}y`;
    const started = performance.now();
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command } })).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('accepts the markers Codex defines', () => {
    const command = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-x',
      '+y',
      '*** End of File',
      '*** End Patch',
    ].join('\n');
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command } })).toHaveLength(1);
  });

  it('refuses a patch whose command is not text', () => {
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command: 3 } })).toBeNull();
  });
});

describe('patchPaths', () => {
  it.each([
    ['add', '*** Add File: a.ts', ['a.ts']],
    ['update and move', '*** Update File: a.ts\n*** Move to: b.ts', ['a.ts', 'b.ts']],
    ['delete', '*** Delete File: a.ts', ['a.ts']],
    ['two files', '*** Add File: a.ts\n+x\n*** Update File: b.ts', ['a.ts', 'b.ts']],
    ['a header-looking body line', '*** Add File: a.ts\n+*** Add File: evil.ts', ['a.ts']],
    ['no paths', '*** Begin Patch\n*** End Patch', []],
    [
      'a space lead',
      '*** Add File: ok.ts\n+ok\n  *** Add File: .claude/settings.json',
      ['ok.ts', '.claude/settings.json'],
    ],
    ['a tab lead', '*** Add File: ok.ts\n\t*** Add File: b.ts', ['ok.ts', 'b.ts']],
    ['a CR lead', '*** Add File: ok.ts\n\r*** Add File: b.ts', ['ok.ts', 'b.ts']],
    ['an NBSP lead', '*** Add File: ok.ts\n\u00a0*** Add File: b.ts', ['ok.ts', 'b.ts']],
    ['a NEL lead', '*** Add File: ok.ts\n\u0085*** Add File: b.ts', ['ok.ts', 'b.ts']],
    ['a hidden delete', '*** Add File: ok.ts\n  *** Delete File: seed.txt', ['ok.ts', 'seed.txt']],
    ['a hidden update', '*** Add File: ok.ts\n  *** Update File: seed.txt', ['ok.ts', 'seed.txt']],
    [
      'an indented first hunk',
      '*** Begin Patch\n  *** Add File: a.ts\n*** Add File: b.ts',
      ['a.ts', 'b.ts'],
    ],
    ['a trailing NEL', '*** Add File: secret.ts\u0085', ['secret.ts']],
    ['two spaces after Add', '*** Add File:  a.ts', [' a.ts']],
    ['two spaces after Update', '*** Update File:  a.ts', [' a.ts']],
    ['two spaces after Delete', '*** Delete File:  a.ts', [' a.ts']],
    ['two spaces after Move', '*** Update File: a.ts\n*** Move to:  b.ts', ['a.ts', ' b.ts']],
    [
      'trailing spaces on Move',
      '*** Update File: a.ts\n*** Move to: b.ts \u0085 ',
      ['a.ts', 'b.ts'],
    ],
    ['a leading FEFF', '*** Add File: \uFEFFa.ts', ['\uFEFFa.ts']],
    ['a trailing FEFF', '*** Add File: a.ts\uFEFF', ['a.ts\uFEFF']],
    ['a markdown rule as context', '*** Update File: a.ts\n@@\n a\n ***\n-b\n+B', ['a.ts']],
    ['bold text as context', '*** Update File: a.ts\n@@\n *** Bold line\n-b\n+B', ['a.ts']],
    ['a banner as context', '*** Update File: a.ts\n@@\n  *** WARNING ***\n-b\n+B', ['a.ts']],
    ['an added rule above a context rule', '*** Update File: a.ts\n@@\n+***\n ***\n-b', ['a.ts']],
    [
      'a header-looking context line',
      '*** Update File: a.ts\n@@\n *** Add File: elsewhere.txt\n-b',
      ['a.ts'],
    ],
    [
      'a hidden header after an Add hunk',
      '*** Add File: ok.ts\n+x\n *** Add File: hidden.ts',
      ['ok.ts', 'hidden.ts'],
    ],
    [
      'a hidden header after a Delete hunk',
      '*** Delete File: ok.ts\n *** Add File: hidden.ts',
      ['ok.ts', 'hidden.ts'],
    ],
    [
      'a column-0 header after an Update hunk',
      '*** Update File: a.ts\n@@\n-b\n*** Add File: c.ts',
      ['a.ts', 'c.ts'],
    ],
    ['CRLF', '*** Add File: a.ts\r\n+x\r\n*** Add File: b.ts\r\n', ['a.ts', 'b.ts']],
  ])('%s', (_name, patch, expected) => {
    expect(patchPaths(patch)).toEqual(expected);
    expect(guardCalls({ tool_name: 'apply_patch', tool_input: { command: patch } })).not.toBeNull();
  });
});

describe('judgeHookCall', () => {
  it('says a patch it cannot read was not read, not that the tool is banned', async () => {
    const hook: HookInput = { tool_name: 'apply_patch', tool_input: { command: '*** Bogus' } };
    expect(await judgeHookCall(ALLOW_ALL, hook, NEVER)).toMatchObject({
      allow: false,
      reason: '10db could not read this patch, so it was refused.',
    });
  });

  it('gives a reason of only NEL a fixed one', async () => {
    const spec: Spec = { ...ALLOW_ALL, preToolUse: () => ({ decision: 'deny', reason: '\u0085' }) };
    const answer = await judgeHookCall(
      spec,
      { tool_name: 'Bash', tool_input: { command: 'x' } },
      NEVER,
    );
    expect(answer.allow ? '' : answer.reason).toBe('10db refused this call.');
  });

  it('gives a refusal with an empty reason a fixed one, since Codex runs a deny without a reason', async () => {
    const spec: Spec = { ...ALLOW_ALL, preToolUse: () => ({ decision: 'deny', reason: '  ' }) };
    const answer = await judgeHookCall(
      spec,
      { tool_name: 'Bash', tool_input: { command: 'x' } },
      NEVER,
    );
    expect(answer).toMatchObject({ allow: false });
    expect(answer.allow ? '' : answer.reason.trim()).not.toBe('');
  });

  const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

  // Sessions spec §5.5: Plan's thread on Codex is read-only. Its patch reaches Plan's own guard through the hook
  // as one Edit per path, which Plan refuses, whatever the sandbox would have done with it.
  it.each([
    ['adds a file', '*** Add File: notes.md\n+x'],
    ['updates one', '*** Update File: src/a.ts\n@@\n-x\n+y'],
    ['deletes one', '*** Delete File: src/a.ts'],
  ])('refuses a patch in Plan’s thread that %s', async (_name, change) => {
    const access: ShapeAccess = {
      checkout: '/w/repo',
      home: '/Users/b',
      protectedReads: [],
      filesDir: '/d/shapes/s1',
      sandboxRoots: [],
    };
    const plan: Spec = {
      ...ALLOW_ALL,
      preToolUse: (req) =>
        judgeShapeCall({ toolName: req.toolName, toolInput: req.input, cwd: req.cwd }, access),
    };
    const hook: HookInput = {
      tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n${change}\n*** End Patch` },
      cwd: '/w/repo',
    };
    const answer = await judgeHookCall(plan, hook, NEVER);
    expect(answer).toMatchObject({ allow: false });
    expect(answer.allow ? '' : answer.reason).toContain('Plan writes no code');
  });

  // The hook's `tool_use_id` is the item's id, so a refusal is told with it for the item's tool call to carry.
  describe('who refused a call', () => {
    const call: HookInput = { ...bash('make'), tool_use_id: 'call-9' };
    const told = async (spec: Spec, hook: HookInput) => {
      const denials: [string, ClaudeDenial][] = [];
      await judgeHookCall(spec, hook, NEVER, (id, denial) => denials.push([id, denial]));
      return denials;
    };
    it.each<[string, Spec, ClaudeDenial | null]>([
      [
        "the guard's deny is 10db's",
        { ...ALLOW_ALL, preToolUse: () => ({ decision: 'deny', reason: 'no' }) },
        { by: DeniedBy.TenDb, reason: 'no', limit: null, soft: null },
      ],
      [
        "a lane judge's limit is the judge's, final",
        {
          ...ALLOW_ALL,
          judgeCall: () =>
            Promise.resolve({
              decision: 'deny',
              reason: 'skipped',
              judged: { limit: 'writes_live' },
            }),
        },
        { by: DeniedBy.Judge, reason: 'skipped', limit: 'writes_live', soft: false },
      ],
      [
        "a card's Deny is the builder's",
        {
          preToolUse: () => ({ decision: 'ask', reason: 'unread' }),
          canUseTool: () =>
            Promise.resolve({ behavior: 'deny', message: 'card said no', by: DeniedBy.Builder }),
        },
        { by: DeniedBy.Builder, reason: 'card said no', limit: null, soft: null },
      ],
      ['an allowed call is told of nothing', ALLOW_ALL, null],
    ])('%s', async (_name, spec, expected) => {
      const denials = await told(spec, call);
      expect(denials).toEqual(expected === null ? [] : [['call-9', expected]]);
    });

    it('tells nothing for a call Codex gave no id', async () => {
      const spec: Spec = { ...ALLOW_ALL, preToolUse: () => ({ decision: 'deny', reason: 'no' }) };
      expect(await told(spec, bash('make'))).toEqual([]);
    });
  });

  it('allows on allow', async () => {
    expect(await judgeHookCall(ALLOW_ALL, bash('ls'), NEVER)).toEqual({ allow: true });
  });

  it('refuses on deny with the guard reason', async () => {
    const spec: Spec = {
      ...ALLOW_ALL,
      preToolUse: () => ({ decision: 'deny', reason: 'git push is refused' }),
    };
    expect(await judgeHookCall(spec, bash('git push'), NEVER)).toEqual({
      allow: false,
      reason: 'git push is refused',
      interrupt: false,
    });
  });

  it('on ask waits for canUseTool and passes it the call', async () => {
    const seen: unknown[] = [];
    const guarded: unknown[] = [];
    const spec: Spec = {
      preToolUse: (req) => {
        guarded.push(req);
        return { decision: 'ask', reason: 'unread' };
      },
      canUseTool: (req) => {
        seen.push({ ...req, signal: undefined });
        return Promise.resolve({ behavior: 'deny', message: 'card said no', by: 'builder' });
      },
    };
    const hook: HookInput = { ...bash('make'), tool_use_id: 'call-1', cwd: '/work' };
    expect(await judgeHookCall(spec, hook, NEVER)).toEqual({
      allow: false,
      reason: 'card said no',
      interrupt: false,
    });
    expect(seen).toEqual([
      {
        toolName: 'Bash',
        input: { command: 'make' },
        toolUseId: 'call-1',
        escalated: false,
        signal: undefined,
        cwd: '/work',
      },
    ]); // The guard hears the call's id too, which a skip of it is recorded by.
    expect(guarded).toEqual([
      { toolName: 'Bash', input: { command: 'make' }, cwd: '/work', toolUseId: 'call-1' },
    ]);
  });

  // A Codex hook can't change a call: a guard allow that rewrites one still lets Codex run what it sent.
  it("allows a call the guard's allow rewrites, which Codex then runs as it sent it", async () => {
    const spec: Spec = {
      ...ALLOW_ALL,
      preToolUse: () => ({ decision: 'allow', updatedInput: { command: 'echo safe' } }),
    };
    expect(await judgeHookCall(spec, bash('echo raw'), NEVER)).toEqual({ allow: true });
  });

  it('allows an asked call that canUseTool allows, ignoring updatedInput', async () => {
    const spec: Spec = {
      preToolUse: () => ({ decision: 'ask', reason: 'unread' }),
      canUseTool: () => Promise.resolve({ behavior: 'allow', updatedInput: { command: 'rm' } }),
    };
    expect(await judgeHookCall(spec, bash('make'), NEVER)).toEqual({ allow: true });
  });

  // Codex would run its own copy of a call 10db already ran for the builder, so the hook refuses it
  // with what ran: the agent reads the result instead of retrying.
  it('answers a call 10db ran for the builder with what it ran, how it ended and what it printed', async () => {
    const spec: Spec = {
      preToolUse: () => ({ decision: 'ask', reason: 'a commit' }),
      canUseTool: () =>
        Promise.resolve({
          behavior: 'allow',
          updatedInput: { command: "printf '%s' 'done'; exit 1" },
          ranForBuilder: { command: 'git commit -m x', exitCode: 1, output: 'nothing to commit\n' },
        }),
    };
    const answer = await judgeHookCall(spec, bash("git commit -m x # it's ready"), NEVER);
    expect(answer).toEqual({
      allow: false,
      reason:
        '10db ran this for the builder: git commit -m x\nIt ended with exit code 1 and printed:\nnothing to commit\n',
      interrupt: false,
    });
  });

  it('refuses and asks to interrupt when canUseTool says interrupt', async () => {
    const spec: Spec = {
      preToolUse: () => ({ decision: 'ask', reason: 'unread' }),
      canUseTool: () =>
        Promise.resolve({ behavior: 'deny', message: 'stop', interrupt: true, by: '10db' }),
    };
    expect(await judgeHookCall(spec, bash('make'), NEVER)).toEqual({
      allow: false,
      reason: 'stop',
      interrupt: true,
    });
  });

  it('refuses a patch from a chat whose turn does not hold Your folder, naming the holder', async () => {
    const access: ShapeAccess = {
      checkout: '/repo',
      home: '/home',
      protectedReads: [],
      filesDir: '/files',
      sandboxRoots: [],
    };
    const folder = (holds: boolean): ChatPlace => ({
      place: 'here',
      holds: () => holds,
      current: () => true,
      writable: false,
      heldBy: () => 'the task ‘Bump vite’',
      root: '/repo',
      checkout: '/repo',
      firstChange: () => undefined,
    });
    const spec: Spec = {
      ...ALLOW_ALL,
      preToolUse: (call) => judgeChatCall(call, access, folder(false)),
    };
    const hook = {
      tool_name: 'apply_patch',
      tool_input: { command: '*** Add File: new.ts\n+x' },
      cwd: '/repo',
    };
    expect(await judgeHookCall(spec, hook, NEVER)).toMatchObject({
      allow: false,
      reason: chatFolderInUse('the task ‘Bump vite’'),
    });
  });

  it('refuses the whole patch when one path is refused', async () => {
    const spec: Spec = {
      ...ALLOW_ALL,
      preToolUse: ({ input }) =>
        JSON.stringify(input).includes('secret')
          ? { decision: 'deny', reason: 'protected path' }
          : { decision: 'allow' },
    };
    const command = '*** Add File: ok.ts\n*** Add File: secret.ts';
    expect(
      await judgeHookCall(spec, { tool_name: 'apply_patch', tool_input: { command } }, NEVER),
    ).toMatchObject({ allow: false, reason: 'protected path' });
  });

  it.each([
    ['an unknown tool', { tool_name: 'view_image', tool_input: {} }],
    ['a patch with no path', { tool_name: 'apply_patch', tool_input: { command: 'nothing' } }],
  ])('refuses %s', async (_name, hook) => {
    const answer = await judgeHookCall(ALLOW_ALL, hook, NEVER);
    expect(answer.allow).toBe(false);
  });

  it('refuses a call once the session has ended', async () => {
    const ended = new AbortController();
    ended.abort();
    expect((await judgeHookCall(ALLOW_ALL, bash('ls'), ended.signal)).allow).toBe(false);
  });
});

// The real script against a real socket. A short path under /tmp keeps the socket under the 104-byte limit.
describe.skipIf(SANDBOXED || !existsSync('/usr/bin/curl'))(
  'the guard socket and hook script',
  () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    async function shortDir(): Promise<string> {
      const dir = await mkdtemp('/tmp/g8-');
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      return dir;
    }

    async function scriptPath(): Promise<string> {
      const dir = await shortDir();
      const checkout = join(dir, 'c');
      await mkdir(checkout);
      await codexHomes()(join(dir, 'h'), 'chatgpt').prepare(checkout);
      return join(dir, 'h', 'guard-hook.sh');
    }

    async function listen(
      judge: (hook: HookInput, signal: AbortSignal) => Promise<GuardAnswer>,
    ): Promise<GuardSocket> {
      const socket = await openGuardSocket(join(await shortDir(), 's.sock'), judge);
      cleanups.push(() => socket.close());
      return socket;
    }

    function runScript(
      script: string,
      socketPath: string,
      maxSeconds: string,
    ): Promise<{ exit: number | null; stdout: string; stderr: string }> {
      return new Promise((done, fail) => {
        const child = spawn('/bin/sh', [script], {
          env: {
            PATH: '/usr/bin:/bin',
            TENDB_GUARD_SOCKET: socketPath,
            TENDB_GUARD_MAX_SECONDS: maxSeconds,
          },
        });
        let stdout = '';
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.on('error', fail);
        child.on('close', (exit) => {
          done({ exit, stdout, stderr });
        });
        child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
      });
    }

    const untilAborted = (_hook: HookInput, signal: AbortSignal): Promise<GuardAnswer> =>
      new Promise((done) => {
        signal.addEventListener('abort', () => {
          done({ allow: false, reason: 'aborted', interrupt: false });
        });
      });

    it.each<[string, 'allow' | 'deny' | 'none' | 'closed' | 'throw' | 'never', object]>([
      ['an allowed call', 'allow', { exit: 0, stdout: '' }],
      ['a refused call', 'deny', { exit: 0 }],
      ['no socket', 'none', { exit: 2 }],
      ['a closed socket', 'closed', { exit: 2 }],
      ['a daemon error', 'throw', { exit: 2 }],
      ['a slow answer past --max-time', 'never', { exit: 2 }],
    ])('hook script: %s', async (_name, mode, expected) => {
      const script = await scriptPath();
      const judges = {
        allow: () => Promise.resolve<GuardAnswer>({ allow: true }),
        deny: () =>
          Promise.resolve<GuardAnswer>({ allow: false, reason: 'no way', interrupt: false }),
        throw: () => Promise.reject(new Error('boom')),
        never: untilAborted,
        none: untilAborted,
        closed: untilAborted,
      };
      let path = join(await shortDir(), 'absent.sock');
      if (mode !== 'none') {
        const socket = await listen(judges[mode]);
        path = socket.path;
        if (mode === 'closed') await socket.close();
      }
      const result = await runScript(script, path, mode === 'never' ? '1' : '5');
      expect(result).toMatchObject(expected);
      // Codex blocks on exit 2 only with a reason on stderr.
      if (result.exit === 2) expect(result.stderr.trim()).not.toBe('');
      if (mode === 'deny') {
        expect(JSON.parse(result.stdout)).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'no way',
          },
        });
      }
    });

    it('answers 500 to a request that fails the schema', async () => {
      let judged = false;
      const socket = await listen(() => {
        judged = true;
        return Promise.resolve({ allow: true });
      });
      const status = await new Promise<number | undefined>((done, fail) => {
        const req = request(
          { socketPath: socket.path, path: '/pre-tool-use', method: 'POST' },
          (res) => {
            res.resume();
            done(res.statusCode);
          },
        );
        req.on('error', fail);
        req.end('{"tool_input":{}}');
      });
      expect(status).toBe(500);
      expect(judged).toBe(false);
    });

    it('refuses a call waiting on a card when the socket closes', async () => {
      const script = await scriptPath();
      let waiting: () => void = () => undefined;
      const isWaiting = new Promise<void>((done) => {
        waiting = done;
      });
      const spec: Spec = {
        preToolUse: () => ({ decision: 'ask', reason: 'unread' }),
        canUseTool: (req) =>
          new Promise((done) => {
            req.signal.addEventListener('abort', () => {
              done({ behavior: 'deny', message: 'session ended', by: '10db' });
            });
            waiting();
          }),
      };
      const socket = await listen((hook, signal) => judgeHookCall(spec, hook, signal));
      const running = runScript(script, socket.path, '30');
      await isWaiting;
      await socket.close();
      expect((await running).exit).toBe(2);
    });

    it('binds over a stale socket file', async () => {
      const path = join(await shortDir(), 's.sock');
      await writeFile(path, 'left behind');
      const socket = await openGuardSocket(path, () => Promise.resolve({ allow: true }));
      cleanups.push(() => socket.close());
      const script = await scriptPath();
      expect(await runScript(script, path, '5')).toMatchObject({ exit: 0, stdout: '' });
    });
  },
);

describe('judgeHookCall with the session judge', () => {
  const deploy: HookInput = {
    tool_name: 'Bash',
    tool_input: { command: 'vercel deploy --prod' },
    tool_use_id: 'call_1',
    cwd: '/work/copy',
  };
  const judging = (
    judgeCall: NonNullable<Spec['judgeCall']>,
    guard: ReturnType<Spec['preToolUse']> = { decision: 'allow' },
    canUseTool: Spec['canUseTool'] = ALLOW_ALL.canUseTool,
  ): Spec => ({ preToolUse: () => guard, canUseTool, judgeCall });

  it('a bare allow goes to judgeCall and its deny stands', async () => {
    const judgeCall = vi.fn<NonNullable<Spec['judgeCall']>>(() =>
      Promise.resolve({ decision: 'deny', reason: 'a deploy' }),
    );
    expect(await judgeHookCall(judging(judgeCall), deploy, NEVER)).toMatchObject({
      allow: false,
      reason: 'a deploy',
    });
    expect(judgeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        toolUseId: 'call_1',
        cwd: '/work/copy',
        hunk: null,
      }),
    );
  });

  it('a settled allow never reaches judgeCall', async () => {
    const judgeCall = vi.fn<NonNullable<Spec['judgeCall']>>();
    const spec = judging(judgeCall, { decision: 'allow', settled: 'reads only' });
    expect(await judgeHookCall(spec, deploy, NEVER)).toEqual({ allow: true });
    expect(judgeCall).not.toHaveBeenCalled();
  });

  it('a guard deny never reaches judgeCall', async () => {
    const judgeCall = vi.fn<NonNullable<Spec['judgeCall']>>();
    const spec = judging(judgeCall, { decision: 'deny', reason: 'no' });
    expect(await judgeHookCall(spec, deploy, NEVER)).toMatchObject({ allow: false, reason: 'no' });
    expect(judgeCall).not.toHaveBeenCalled();
  });

  it("judgeCall's ask reaches canUseTool with the same tool use id", async () => {
    const canUseTool = vi.fn<Spec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'deny', message: 'the builder said no', by: 'builder' }),
    );
    const spec = judging(
      () => Promise.resolve({ decision: 'ask', reason: 'a limit' }),
      { decision: 'allow' },
      canUseTool,
    );
    expect(await judgeHookCall(spec, deploy, NEVER)).toMatchObject({
      allow: false,
      reason: 'the builder said no',
    });
    expect(canUseTool).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'call_1' }));
  });

  // A chat on Codex reaches 10db's judge through the hook: its tools that send work out or merge are read by the
  // model, never settled by the fast path.
  it.each(['push_branch', 'open_pull_request', 'merge_pull_request'])(
    "asks 10db's model before a Codex chat's %s runs",
    async (name) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-judged-')));
      const { store, close } = createTestStore();
      const asked: string[] = [];
      try {
        const state = createStateStore(store, createEventBus());
        const judgeCall = createHookJudge(
          {
            state,
            logger: silentLogger,
            judge: createJudge({
              state,
              clock: new ManualClock(),
              fetch: (_input, init) => {
                asked.push(typeof init?.body === 'string' ? init.body : '');
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      id: 'gen-1',
                      model: 'typesafe/jev-1.13-20260917',
                      provider: 'TypeSafe',
                      answers: {
                        decision: {
                          type: 'choice',
                          choice: 'writes_live',
                          confidence: 0.95,
                          probabilities: { writes_live: 0.95 },
                        },
                      },
                      usage: { input_tokens: 300, output_tokens: 10, cost: 0.00002 },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                  ),
                );
              },
              readCredential: () => Promise.resolve({ kind: 'openrouter', key: 'router-key-0123' }),
              decisionModelIds: () => new Set(['typesafe/jev-1.13']),
              off: false,
              logger: silentLogger,
            }),
          },
          {
            projectId: seedProject(store).id,
            workstreamId: null,
            taskId: null,
            fastPath: {
              checkout: root,
              tmpDir: root,
              secretFiles: [],
              preExisting: [],
              setupReads: [],
            },
            policy: buildTrustPolicy({
              surface: TrustSurface.Chat,
              projectName: 'demo',
              checkout: root,
              gateCommand: null,
              liveSystems: [],
              switches: TRUST_DEFAULTS,
              grants: [],
              yourMcpServers: [],
              claudeConnectors: false,
              devAccess: { docker: false, localhost: false, compose: null },
            }),
            allowLines: () => [],
            builderNotes: [],
            judgeNow: () => JudgeKind.Tendb,
            coveredByBuilderRule: () => false,
            floorVerdict: () => ({ decision: 'ask', reason: 'rules' }),
            skips: null,
            limits: createLimitNotes(),
            onFloor: () => undefined,
            clock: new ManualClock(),
          },
        );
        const spec: Spec = {
          preToolUse: () => ({ decision: 'allow' }),
          canUseTool: () =>
            Promise.resolve({ behavior: 'deny', message: 'the builder said no', by: 'builder' }),
          judgeCall,
        };
        const answer = await judgeHookCall(
          spec,
          {
            tool_name: `mcp__10db__${name}`,
            tool_input: {},
            tool_use_id: 'call_1',
            cwd: root,
          },
          NEVER,
        );
        expect(answer).toMatchObject({ allow: false, reason: 'the builder said no' });
        expect(asked).toHaveLength(1);
      } finally {
        close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("a judgeCall that throws denies, naming 10db's guard", async () => {
    const spec = judging(() => Promise.reject(new Error('judge down')));
    expect(await judgeHookCall(spec, deploy, NEVER)).toMatchObject({
      allow: false,
      reason: "10db's guard failed: judge down",
    });
  });

  it("no judgeCall leaves today's answer", async () => {
    expect(await judgeHookCall(ALLOW_ALL, deploy, NEVER)).toEqual({ allow: true });
  });

  it('a patch of two files runs judgeCall for each, and the first deny refuses the patch', async () => {
    const judgeCall = vi.fn<NonNullable<Spec['judgeCall']>>((req) =>
      Promise.resolve(
        req.hunk === 'delete'
          ? { decision: 'deny', reason: 'deletes data' }
          : { decision: 'allow' },
      ),
    );
    const command =
      '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: data.db\n*** End Patch';
    expect(
      await judgeHookCall(
        judging(judgeCall),
        { tool_name: 'apply_patch', tool_input: { command }, tool_use_id: 'call_2', cwd: '/w' },
        NEVER,
      ),
    ).toMatchObject({ allow: false, reason: 'deletes data' });
    expect(judgeCall.mock.calls.map(([req]) => [req.input, req.hunk])).toEqual([
      [{ file_path: '/w/a.ts' }, 'add'],
      [{ file_path: '/w/data.db' }, 'delete'],
    ]);
  });
});

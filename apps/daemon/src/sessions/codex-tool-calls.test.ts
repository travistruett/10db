import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_TAIL_CHARS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  codexPlanSteps,
  codexToolCalls,
  withCommandOutput,
  type ItemTimes,
} from './codex-tool-calls';

const STARTED = Date.parse('2026-11-12T10:00:00.000Z');
const running: ItemTimes = { startedAtMs: STARTED, completedAtMs: null };
const finished: ItemTimes = { startedAtMs: STARTED, completedAtMs: STARTED + 250 };

const command = (over: Record<string, unknown> = {}) => ({
  type: 'commandExecution',
  id: 'cmd_1',
  command: 'pnpm test',
  cwd: '/repo',
  status: 'inProgress',
  commandActions: [{ type: 'unknown', command: 'pnpm test' }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...over,
});

const fileChange = (changes: unknown[], status = 'inProgress') => ({
  type: 'fileChange',
  id: 'fc_1',
  changes,
  status,
});

const DIFF = '@@ -1,2 +1,2 @@\n a\n-b\n+B\n';

describe('codexToolCalls', () => {
  it.each<[string, unknown, ItemTimes, Record<string, unknown>[]]>([
    [
      'a running command',
      command(),
      running,
      [
        {
          id: 'cmd_1',
          harnessTool: 'command',
          kind: 'command',
          status: 'running',
          title: 'pnpm test',
          command: 'pnpm test',
          cwd: '/repo',
          outputTail: '',
          outputBytes: 0,
          exitCode: null,
          startedAt: '2026-11-12T10:00:00.000Z',
          durationMs: null,
        },
      ],
    ],
    [
      'a command completed with exit 0 is done, its output the tail',
      command({ status: 'completed', exitCode: 0, aggregatedOutput: 'ok é', durationMs: 240 }),
      finished,
      [{ status: 'done', exitCode: 0, outputTail: 'ok é', outputBytes: 5, durationMs: 240 }],
    ],
    [
      'a command completed with a non-zero exit is failed',
      command({ status: 'completed', exitCode: 2 }),
      finished,
      [{ status: 'failed', exitCode: 2 }],
    ],
    ['a failed command', command({ status: 'failed' }), finished, [{ status: 'failed' }]],
    [
      'an interrupted command',
      command({ status: 'interrupted' }),
      finished,
      [{ status: 'failed' }],
    ],
    [
      'a declined command is denied, with no denier Codex can name',
      command({ status: 'declined' }),
      finished,
      [{ status: 'denied', refusal: null, deniedBy: null }],
    ],
    ['an unknown status, running', command({ status: 'paused' }), running, [{ status: 'running' }]],
    ['an unknown status, finished', command({ status: 'paused' }), finished, [{ status: 'done' }]],
    [
      'a command that is one read is a read',
      command({
        command: 'cat src/a.ts',
        commandActions: [{ type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' }],
      }),
      running,
      [{ kind: 'read', harnessTool: 'command', path: 'src/a.ts', range: null }],
    ],
    [
      'a command that is one search is a search',
      command({
        command: 'rg TODO src',
        commandActions: [{ type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' }],
      }),
      running,
      [{ kind: 'search', harnessTool: 'command', pattern: 'TODO', paths: ['src'] }],
    ],
    [
      'a search with no query is named by its command',
      command({
        command: 'rg',
        commandActions: [{ type: 'search', command: 'rg', query: null, path: null }],
      }),
      running,
      [{ kind: 'search', pattern: 'rg', paths: null }],
    ],
    [
      'a command of two reads stays a command',
      command({
        commandActions: [
          { type: 'read', command: 'cat a', name: 'a', path: 'a' },
          { type: 'read', command: 'cat b', name: 'b', path: 'b' },
        ],
      }),
      running,
      [{ kind: 'command' }],
    ],
    [
      'a file change is one edit per file, with hunks from its diff',
      fileChange([
        { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: DIFF },
        { path: 'b.ts', kind: { type: 'delete' }, diff: 'gone\n' },
      ]),
      running,
      [
        {
          id: 'fc_1:0',
          harnessTool: 'apply_patch',
          kind: 'edit',
          path: 'a.ts',
          change: 'update',
          movePath: null,
          hunks: [
            { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, before: 'a\nb', after: 'a\nB' },
          ],
          addedLines: 1,
          removedLines: 1,
        },
        { id: 'fc_1:1', kind: 'edit', path: 'b.ts', change: 'delete', removedLines: 1 },
      ],
    ],
    [
      'an add whose diff is the plain text shows it as added',
      fileChange([{ path: 'new.ts', kind: { type: 'add' }, diff: 'export const a = 1;\n' }]),
      running,
      [
        {
          kind: 'edit',
          change: 'add',
          hunks: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              before: '',
              after: 'export const a = 1;',
            },
          ],
          addedLines: 1,
        },
      ],
    ],
    [
      'an update with a move path is a move',
      fileChange([{ path: 'a.ts', kind: { type: 'update', move_path: 'b.ts' }, diff: 'x' }]),
      running,
      [{ change: 'move', movePath: 'b.ts', title: 'a.ts → b.ts', hunks: [] }],
    ],
    [
      'a declined patch is denied',
      fileChange([{ path: 'a.ts', kind: { type: 'add' }, diff: 'x' }], 'declined'),
      finished,
      [{ status: 'denied' }],
    ],
    [
      'an MCP call keeps its result text and error',
      {
        type: 'mcpToolCall',
        id: 'mcp_1',
        server: 'docs',
        tool: 'search',
        status: 'completed',
        arguments: { q: 'zod' },
        result: { content: [{ type: 'text', text: 'found' }, { type: 'image' }] },
        error: null,
        durationMs: 30,
      },
      finished,
      [
        {
          harnessTool: 'docs.search',
          kind: 'mcp',
          server: 'docs',
          tool: 'search',
          argumentsPreview: '{"q":"zod"}',
          resultTail: 'found',
          error: null,
          status: 'done',
        },
      ],
    ],
    [
      'a failed MCP call carries its error',
      {
        type: 'mcpToolCall',
        id: 'mcp_1',
        server: 'docs',
        tool: 'search',
        status: 'failed',
        arguments: null,
        result: null,
        error: { message: 'no such tool' },
        durationMs: null,
      },
      finished,
      [{ status: 'failed', resultTail: null, error: 'no such tool' }],
    ],
    [
      'a web search with an opened page',
      {
        type: 'webSearch',
        id: 'ws_1',
        query: 'zod 4',
        action: { type: 'openPage', url: 'https://zod.dev' },
        results: null,
      },
      running,
      [{ harnessTool: 'web_search', kind: 'web', query: 'zod 4', url: 'https://zod.dev' }],
    ],
    [
      'a spawned agent is a subagent',
      {
        type: 'collabAgentToolCall',
        id: 'ca_1',
        tool: 'spawnAgent',
        status: 'inProgress',
        prompt: 'Review it',
        model: 'gpt-5.5',
      },
      running,
      [
        {
          harnessTool: 'spawnAgent',
          kind: 'subagent',
          agent: 'subagent',
          promptPreview: 'Review it',
          model: 'gpt-5.5',
        },
      ],
    ],
    [
      'another agent tool is other',
      { type: 'collabAgentToolCall', id: 'ca_2', tool: 'wait', status: 'inProgress', prompt: null },
      running,
      [{ harnessTool: 'wait', kind: 'other', name: 'wait' }],
    ],
    [
      'a dynamic tool is other, named by its tool',
      {
        type: 'dynamicToolCall',
        id: 'dt_1',
        tool: 'lookup',
        arguments: { a: 1 },
        status: 'completed',
      },
      finished,
      [{ harnessTool: 'lookup', kind: 'other', name: 'lookup', inputPreview: '{"a":1}' }],
    ],
    [
      'an image view is a read',
      { type: 'imageView', id: 'iv_1', path: 'shot.png' },
      running,
      [{ harnessTool: 'view_image', kind: 'read', path: 'shot.png' }],
    ],
    [
      'an agent message is no tool call',
      { type: 'agentMessage', id: 'm', text: 'hi' },
      running,
      [],
    ],
    ['a command with no id is none', command({ id: undefined }), running, []],
  ])('%s', (_name, item, times, expected) => {
    const calls = codexToolCalls(item, times);
    expect(calls).toHaveLength(expected.length);
    expect(calls).toMatchObject(expected);
  });
});

describe('withCommandOutput', () => {
  const [cmd] = codexToolCalls(command(), running);

  it('keeps the last 4,096 characters of 10,000, and counts every byte', () => {
    if (cmd === undefined) throw new Error('no call');
    const once = withCommandOutput(cmd, 'a'.repeat(6000));
    const twice = withCommandOutput(once, 'é'.repeat(4000));
    expect(twice).toMatchObject({
      outputTail: `${'a'.repeat(OUTPUT_TAIL_CHARS - 4000)}${'é'.repeat(4000)}`,
      outputBytes: 6000 + 8000,
    });
  });

  it('leaves an edit as it is', () => {
    const [edit] = codexToolCalls(
      fileChange([{ path: 'a.ts', kind: { type: 'add' }, diff: 'x' }]),
      running,
    );
    if (edit === undefined) throw new Error('no call');
    expect(withCommandOutput(edit, 'more')).toEqual(edit);
  });
});

describe('codexPlanSteps', () => {
  it('names each status as the session does, an unknown one pending', () => {
    expect(
      codexPlanSteps([
        { step: 'Read', status: 'completed' },
        { step: 'Write', status: 'inProgress' },
        { step: 'Test', status: 'pending' },
        { step: 'Ship', status: 'blocked' },
      ]),
    ).toEqual([
      { text: 'Read', status: 'completed' },
      { text: 'Write', status: 'in_progress' },
      { text: 'Test', status: 'pending' },
      { text: 'Ship', status: 'pending' },
    ]);
  });
});

const Fixture = z.array(z.looseObject({ item: z.looseObject({ type: z.string() }) }));

describe('every item the pinned Codex can send', () => {
  const payloads = ['ItemStartedNotification', 'ItemCompletedNotification'].flatMap((name) =>
    Fixture.parse(
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, 'codex-generated', 'fixtures', `${name}.json`),
          'utf8',
        ),
      ),
    ),
  );

  it.each(['commandExecution', 'fileChange', 'mcpToolCall'])(
    'maps each sampled %s to the calls it holds',
    (type) => {
      const items = payloads.filter((p) => p.item.type === type).map((p) => p.item);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const calls = codexToolCalls(item, finished);
        const changes = z.looseObject({ changes: z.array(z.unknown()) }).safeParse(item);
        if (type === 'fileChange') {
          expect(calls).toHaveLength(changes.success ? changes.data.changes.length : 0);
          for (const call of calls) expect(call).toMatchObject({ kind: 'edit' });
        } else expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          switch (call.kind) {
            case 'command':
              expect(call.command).not.toBe('');
              break;
            case 'read':
            case 'edit':
              expect(call.path).not.toBe('');
              break;
            case 'search':
              expect(call.pattern).not.toBe('');
              break;
            case 'mcp':
              expect(call.server).not.toBe('');
              expect(call.tool).not.toBe('');
              break;
            case 'subagent':
            case 'web':
            case 'other':
              throw new Error(`${type} mapped to ${call.kind}`);
          }
        }
      }
    },
  );
});

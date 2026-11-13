import { describe, expect, it } from 'vitest';
import { LimitName } from './trust-policy';
import { OUTPUT_TAIL_CHARS, ToolCallView } from './tool-call-view';

const common = {
  id: 'toolu_1',
  harnessTool: 'Bash',
  status: 'done',
  title: 'pnpm test',
  startedAt: '2026-11-12T10:00:00.000Z',
  durationMs: 120,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
} as const;

const command = {
  ...common,
  kind: 'command',
  command: 'pnpm test',
  cwd: '/repo',
  outputTail: 'ok\n',
  outputBytes: 3,
  exitCode: 0,
} as const;

const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, before: 'a', after: 'b' };

const valid: readonly [string, object][] = [
  ['a command', command],
  [
    'an edit',
    {
      ...common,
      harnessTool: 'Edit',
      kind: 'edit',
      path: 'src/a.ts',
      change: 'update',
      movePath: null,
      hunks: [hunk],
      addedLines: 1,
      removedLines: 1,
      truncated: false,
    },
  ],
  [
    'a read',
    {
      ...common,
      harnessTool: 'Read',
      kind: 'read',
      path: 'src/a.ts',
      range: { offset: 0, limit: null },
    },
  ],
  [
    'a search',
    {
      ...common,
      harnessTool: 'Grep',
      kind: 'search',
      pattern: 'TODO',
      paths: null,
      matchCount: null,
    },
  ],
  [
    'an mcp call',
    {
      ...common,
      harnessTool: 'mcp__10db__commit',
      kind: 'mcp',
      server: '10db',
      tool: 'commit',
      argumentsPreview: '{}',
      resultTail: null,
      error: null,
    },
  ],
  [
    'a subagent',
    {
      ...common,
      harnessTool: 'Task',
      kind: 'subagent',
      agent: 'reviewer',
      promptPreview: 'Review it',
      model: null,
    },
  ],
  ['a web call', { ...common, harnessTool: 'WebSearch', kind: 'web', query: 'zod 4', url: null }],
  [
    'another tool',
    { ...common, harnessTool: 'Skill', kind: 'other', name: 'Skill', inputPreview: '{}' },
  ],
  [
    'a call the judge denied softly',
    {
      ...command,
      status: 'denied',
      deniedBy: 'judge',
      limit: LimitName.WritesLive,
      soft: true,
      refusal: 'it deploys',
    },
  ],
];

const invalid: readonly [string, object][] = [
  [
    'an output tail one past the cap',
    { ...command, outputTail: 'x'.repeat(OUTPUT_TAIL_CHARS + 1) },
  ],
  ['an unknown kind', { ...command, kind: 'shell' }],
  [
    'an edit with no hunks',
    {
      ...common,
      kind: 'edit',
      path: 'a.ts',
      change: 'update',
      movePath: null,
      addedLines: 0,
      removedLines: 0,
      truncated: false,
    },
  ],
  ['a start time that is not ISO', { ...command, startedAt: 'yesterday' }],
  ['a negative duration', { ...command, durationMs: -1 }],
  ['an unknown denier', { ...command, status: 'denied', deniedBy: 'agent' }],
  [
    'a limit on a denial that is not the judge',
    { ...command, status: 'denied', deniedBy: '10db', limit: LimitName.DestroysData, soft: null },
  ],
];

describe('ToolCallView', () => {
  it.each(valid)('%s parses and round-trips', (_name, view) => {
    expect(ToolCallView.parse(view)).toEqual(view);
  });

  it.each(invalid)('refuses %s', (_name, view) => {
    expect(ToolCallView.safeParse(view).success).toBe(false);
  });
});

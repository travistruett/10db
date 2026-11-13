import type { ToolCallView } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  claudeToolTarget,
  codexCommandTarget,
  codexPatchTarget,
  titled,
  toolCallActivity,
  toolCallTarget,
  type UntitledToolCall,
} from './tool-target';

// Workbench spec §4.3: a working page's live line names the file a tool aims at, and counts only the
// files a turn writes.

describe('claudeToolTarget', () => {
  it.each<{ name: string; tool: string; input: unknown; target: string | null; written: string[] }>(
    [
      {
        name: 'a Write writes its file',
        tool: 'Write',
        input: { file_path: 'src/settings/page.tsx', content: 'x' },
        target: 'src/settings/page.tsx',
        written: ['src/settings/page.tsx'],
      },
      {
        name: 'an Edit writes its file',
        tool: 'Edit',
        input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        target: 'src/a.ts',
        written: ['src/a.ts'],
      },
      {
        name: 'a MultiEdit writes its file',
        tool: 'MultiEdit',
        input: { file_path: 'src/a.ts', edits: [] },
        target: 'src/a.ts',
        written: ['src/a.ts'],
      },
      {
        name: 'a NotebookEdit writes its notebook',
        tool: 'NotebookEdit',
        input: { notebook_path: 'n.ipynb', new_source: '' },
        target: 'n.ipynb',
        written: ['n.ipynb'],
      },
      {
        name: 'a Read aims at its file and writes none',
        tool: 'Read',
        input: { file_path: 'src/a.ts' },
        target: 'src/a.ts',
        written: [],
      },
      {
        name: 'a Grep aims at its pattern and writes none',
        tool: 'Grep',
        input: { pattern: 'useForm' },
        target: 'useForm',
        written: [],
      },
      {
        name: 'a Bash command is named by its first word, leaving out the variables it sets',
        tool: 'Bash',
        input: { command: 'CI=1 pnpm test --filter desktop' },
        target: 'pnpm',
        written: [],
      },
      {
        name: 'an MCP tool aims at nothing it names',
        tool: 'mcp__10db__commit',
        input: { message: 'x' },
        target: null,
        written: [],
      },
      {
        name: 'a Write whose input has no path aims at nothing',
        tool: 'Write',
        input: { content: 'x' },
        target: null,
        written: [],
      },
    ],
  )('$name', ({ tool, input, target, written }) => {
    expect(claudeToolTarget(tool, input)).toEqual({ name: tool, target, written });
  });
});

describe('Codex tool targets', () => {
  it('names a command by its first word, writing nothing', () => {
    expect(codexCommandTarget('  git status --short')).toEqual({
      name: 'command',
      target: 'git',
      written: [],
    });
  });

  it('names a patch by its first file, writing every file it changes', () => {
    expect(codexPatchTarget(['src/a.ts', 'src/b.ts'])).toEqual({
      name: 'apply_patch',
      target: 'src/a.ts',
      written: ['src/a.ts', 'src/b.ts'],
    });
  });
});

const base = {
  id: 'call_1',
  status: 'running',
  startedAt: '2026-11-12T00:00:00.000Z',
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
} as const;

type UntitledEdit = Extract<UntitledToolCall, { kind: 'edit' }>;

const edit = (path: string, more: Partial<UntitledEdit> = {}): UntitledEdit => ({
  ...base,
  harnessTool: 'Edit',
  kind: 'edit',
  path,
  change: 'update',
  movePath: null,
  hunks: [],
  addedLines: 0,
  removedLines: 0,
  truncated: false,
  ...more,
});

const long = `src/${'a'.repeat(396)}`;

describe('toolCallTarget', () => {
  it.each<{
    name: string;
    call: UntitledToolCall;
    title: string;
    target: string | null;
    written: string[];
  }>([
    {
      name: 'a command is titled by its first line and named by its first word past its variables',
      call: {
        ...base,
        harnessTool: 'Bash',
        kind: 'command',
        command: 'CI=1 pnpm test\necho done',
        cwd: null,
        outputTail: '',
        outputBytes: 0,
        exitCode: null,
      },
      title: 'CI=1 pnpm test',
      target: 'pnpm',
      written: [],
    },
    {
      name: 'an edit writes its file',
      call: edit('src/a.ts'),
      title: 'src/a.ts',
      target: 'src/a.ts',
      written: ['src/a.ts'],
    },
    {
      name: 'a move writes both paths',
      call: edit('a.ts', { change: 'move', movePath: 'b.ts' }),
      title: 'a.ts → b.ts',
      target: 'a.ts',
      written: ['a.ts', 'b.ts'],
    },
    {
      name: 'a notebook edit writes its notebook',
      call: edit('n.ipynb', { harnessTool: 'NotebookEdit' }),
      title: 'n.ipynb',
      target: 'n.ipynb',
      written: ['n.ipynb'],
    },
    {
      name: 'a read aims at its file and writes none',
      call: { ...base, harnessTool: 'Read', kind: 'read', path: 'src/a.ts', range: null },
      title: 'src/a.ts',
      target: 'src/a.ts',
      written: [],
    },
    {
      name: 'a search aims at its pattern',
      call: {
        ...base,
        harnessTool: 'Glob',
        kind: 'search',
        pattern: '**/*.ts',
        paths: null,
        matchCount: null,
      },
      title: '**/*.ts',
      target: '**/*.ts',
      written: [],
    },
    {
      name: 'an mcp call is titled by server and tool and aims at nothing',
      call: {
        ...base,
        harnessTool: 'mcp__10db__commit',
        kind: 'mcp',
        server: '10db',
        tool: 'commit',
        argumentsPreview: '{}',
        resultTail: null,
        error: null,
      },
      title: '10db.commit',
      target: null,
      written: [],
    },
    {
      name: 'a subagent is titled by its agent',
      call: {
        ...base,
        harnessTool: 'Task',
        kind: 'subagent',
        agent: 'reviewer',
        promptPreview: 'Review it',
        model: null,
      },
      title: 'reviewer',
      target: null,
      written: [],
    },
    {
      name: 'a web search is titled and aimed by its query',
      call: { ...base, harnessTool: 'WebSearch', kind: 'web', query: 'zod 4', url: null },
      title: 'zod 4',
      target: 'zod 4',
      written: [],
    },
    {
      name: 'a web fetch is titled and aimed by its url',
      call: {
        ...base,
        harnessTool: 'WebFetch',
        kind: 'web',
        query: null,
        url: 'https://example.com',
      },
      title: 'https://example.com',
      target: 'https://example.com',
      written: [],
    },
    {
      name: 'a web call with neither is titled by its tool',
      call: { ...base, harnessTool: 'WebSearch', kind: 'web', query: null, url: null },
      title: 'WebSearch',
      target: null,
      written: [],
    },
    {
      name: 'another tool is titled by its name',
      call: { ...base, harnessTool: 'Skill', kind: 'other', name: 'Skill', inputPreview: '{}' },
      title: 'Skill',
      target: null,
      written: [],
    },
    {
      name: 'a 400-character path is cut to 300 as a target and 120 as a title',
      call: { ...base, harnessTool: 'Read', kind: 'read', path: long, range: null },
      title: long.slice(0, 120),
      target: long.slice(0, 300),
      written: [],
    },
  ])('$name', ({ call, title, target, written }) => {
    const view: ToolCallView = titled(call);
    expect(view.title).toBe(title);
    expect(toolCallTarget(view)).toEqual({ name: call.harnessTool, target, written });
    const activity = toolCallActivity(view);
    expect(activity.summary).toBe(`${call.harnessTool} ${title}`.slice(0, 200));
    expect(activity.tool).toEqual(toolCallTarget(view));
  });
});

import { ToolCallView } from '@10db/contracts';
import type { ToolEntry } from '../conversation';

// Tool calls as an adapter reports them, one builder per kind. Each is checked against the
// contract's schema, so a fixture can't hold a call no adapter could send.

type Call<K extends ToolCallView['kind']> = Extract<ToolCallView, { kind: K }>;

const COMMON = {
  status: 'done',
  title: '',
  startedAt: '2026-11-13T10:00:00.000Z',
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
} as const;

function checked<K extends ToolCallView['kind']>(call: Call<K>): Call<K> {
  ToolCallView.parse(call);
  return call;
}

export function commandCall(over: Partial<Call<'command'>> = {}): Call<'command'> {
  return checked({
    ...COMMON,
    id: 'c1',
    harnessTool: 'Bash',
    kind: 'command',
    command: 'pnpm vitest run src/api',
    cwd: null,
    outputTail: 'ok',
    outputBytes: 2,
    exitCode: 0,
    durationMs: 9_000,
    ...over,
  });
}

export function editCall(over: Partial<Call<'edit'>> = {}): Call<'edit'> {
  return checked({
    ...COMMON,
    id: 'e1',
    harnessTool: 'Edit',
    kind: 'edit',
    path: 'src/api/client.ts',
    change: 'update',
    movePath: null,
    hunks: [],
    addedLines: 4,
    removedLines: 2,
    truncated: false,
    ...over,
  });
}

export function readCall(over: Partial<Call<'read'>> = {}): Call<'read'> {
  return checked({
    ...COMMON,
    id: 'r1',
    harnessTool: 'Read',
    kind: 'read',
    path: 'src/router.tsx',
    range: null,
    ...over,
  });
}

export function searchCall(over: Partial<Call<'search'>> = {}): Call<'search'> {
  return checked({
    ...COMMON,
    id: 's1',
    harnessTool: 'Grep',
    kind: 'search',
    pattern: 'retry',
    paths: null,
    matchCount: null,
    ...over,
  });
}

export function mcpCall(over: Partial<Call<'mcp'>> = {}): Call<'mcp'> {
  return checked({
    ...COMMON,
    id: 'm1',
    harnessTool: 'mcp__github__get_pr',
    kind: 'mcp',
    server: 'github',
    tool: 'get_pr',
    argumentsPreview: '{"number":12}',
    resultTail: null,
    error: null,
    ...over,
  });
}

export function subagentCall(over: Partial<Call<'subagent'>> = {}): Call<'subagent'> {
  return checked({
    ...COMMON,
    id: 'a1',
    harnessTool: 'Task',
    kind: 'subagent',
    agent: 'explorer',
    promptPreview: 'find the retry code',
    model: null,
    durationMs: 60_000,
    ...over,
  });
}

export function webCall(over: Partial<Call<'web'>> = {}): Call<'web'> {
  return checked({
    ...COMMON,
    id: 'w1',
    harnessTool: 'WebSearch',
    kind: 'web',
    query: 'q',
    url: null,
    ...over,
  });
}

export function otherCall(over: Partial<Call<'other'>> = {}): Call<'other'> {
  return checked({
    ...COMMON,
    id: 'o1',
    harnessTool: 'propose_plan',
    kind: 'other',
    title: 'propose_plan',
    name: 'propose_plan',
    inputPreview: 'x',
    ...over,
  });
}

/** A tool entry for `call`, keyed by its id. */
export function toolEntry(call: ToolCallView): ToolEntry {
  return { kind: 'tool', id: call.id, call };
}

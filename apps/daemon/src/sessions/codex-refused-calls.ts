import type { ToolCallView } from '@10db/contracts';
import type { ClaudeDenial } from './claude-tool-calls';
import { guardCalls, type HookInput } from './codex-guard';
import { codexToolCalls, withDenial } from './codex-tool-calls';
import { PatchHunk } from '../trust';

/**
 * Codex reports no thread item for a call its hook refused, so the refusal has no call to carry it. This
 * builds the call from the hook's own input, as a declined item would have read, with who refused it and
 * why. It keeps the item's id, so an item Codex does report for the same call replaces it. A tool 10db
 * does not read gives none.
 */
export function refusedToolCalls(
  hook: HookInput,
  denial: ClaudeDenial,
  atMs: number,
  seq: number,
): readonly ToolCallView[] {
  const calls = refusedCallsOf(hook, denial, atMs);
  const id = hook.tool_use_id;
  if (!id?.startsWith(CODE_MODE_ITEM)) return calls;
  return calls.map((call) => ({
    ...call,
    id: `${call.id}#${String(seq)}`,
    parentId: id,
    title: `${IN_SCRIPT}: ${call.title}`.slice(0, TITLE_MAX),
    refusal: call.refusal === null ? null : `Refused inside a code-mode script. ${call.refusal}`,
  }));
}

/**
 * The prefix of the item id Codex gives a code-mode script, whose nested calls all carry it. Unverified: it is
 * what a live check saw, and no research note records it. A call outside code mode that carried such an id
 * would show twice, once from the hook's input and once as the item Codex reports.
 */
const CODE_MODE_ITEM = 'exec-';
const IN_SCRIPT = 'In a code-mode script';
/** The longest title a view keeps. */
const TITLE_MAX = 120;

function refusedCallsOf(
  hook: HookInput,
  denial: ClaudeDenial,
  atMs: number,
): readonly ToolCallView[] {
  const id = hook.tool_use_id;
  if (id === undefined || id === '') return [];
  const times = { startedAtMs: atMs, completedAtMs: atMs };
  const declined = { id, status: 'declined' };
  const calls = guardCalls(hook);
  if (calls === null) return [];
  const first = calls[0];
  if (hook.tool_name === 'Bash' && first !== undefined) {
    const command = first.input['command'];
    if (typeof command !== 'string') return [];
    return codexToolCalls(
      {
        ...declined,
        type: 'commandExecution',
        command,
        cwd: hook.cwd ?? null,
        commandActions: [],
        aggregatedOutput: '',
        exitCode: null,
      },
      times,
    ).map((call) => withDenial(call, denial));
  }
  if (hook.tool_name === 'apply_patch') {
    const changes = calls.flatMap((call) => {
      const path = call.input['file_path'];
      if (typeof path !== 'string') return [];
      const type =
        call.hunk === PatchHunk.Add ? 'add' : call.hunk === PatchHunk.Delete ? 'delete' : 'update';
      return [{ path, kind: { type }, diff: '' }];
    });
    return codexToolCalls({ ...declined, type: 'fileChange', changes }, times).map((call) =>
      withDenial(call, denial),
    );
  }
  if (hook.tool_name.startsWith('mcp__')) {
    const [, server, ...tool] = hook.tool_name.split('__');
    if (server === undefined || server === '' || tool.length === 0) return [];
    return codexToolCalls(
      {
        ...declined,
        type: 'mcpToolCall',
        server,
        tool: tool.join('__'),
        arguments: first?.input ?? {},
      },
      times,
    ).map((call) => withDenial(call, denial));
  }
  return [];
}

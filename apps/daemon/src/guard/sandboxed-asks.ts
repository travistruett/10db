import type { HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { startsEndlessBackgroundLoop } from './background-loops';
import { hazardHit } from './hazards';
import {
  shellScripts,
  withoutRedirections,
  stringField,
  type FileAccessJudge,
  type GuardVerdict,
} from './judge';
import { leadingWords, parseShell } from './shell-words';

/** The Monitor input keys a card-free call may carry; any other (`ws`, or one added later) is asked about. */
export const MONITOR_INPUT_KEYS: ReadonlySet<string> = new Set([
  'command',
  'description',
  'timeout_ms',
]);

/** A PreToolUse answer that hands the call to the broker, which raises a card or applies a stored rule. */
export interface SandboxedAsk {
  readonly decision: 'ask';
  readonly reason: string;
}

/** What a PreToolUse hook answers: the guard's allow or deny, or a sandboxed lane's ask. */
export type PreToolUseVerdict = GuardVerdict | SandboxedAsk;

const READ_FAMILY: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_FAMILY: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const ToolInput = z.record(z.string(), z.unknown());
const ask = (reason: string): SandboxedAsk => ({ decision: 'ask', reason });

/**
 * Whether Claude Code runs a Bash call in the background itself (`run_in_background`). Anything but
 * an absent or false flag counts, so a spelling Claude Code reads as true is never missed: a value
 * it refuses fails the call before it runs, so asking about it costs nothing.
 */
export function runsInBackground(input: Readonly<Record<string, unknown>>): boolean {
  const flag = input['run_in_background'];
  return flag !== undefined && flag !== null && flag !== false && flag !== 'false';
}

/** Tools that reach a host or an MCP server from Claude Code's own process. */
const OUT_OF_PROXY_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'WebSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** A call to a tool whose traffic does not pass through the sandbox's network proxy. */
function actsOutsideSandboxProxy(toolName: string): boolean {
  if (OUT_OF_PROXY_TOOLS.has(toolName)) return true;
  return toolName.startsWith('mcp__') && !toolName.startsWith('mcp__10db__');
}

/** A character that makes the shell replace a word with text 10db cannot read from the command. */
const EXPANDING = /[$`*?[~{}]/;
/** A program name written out in plain text. */
const PLAIN_PROGRAM = /^(?:[A-Za-z0-9_@+%,:./-]+|\[\[?)$/;
/** Programs whose arguments come from their input, so a hazard program behind them has its words unread. */
const FEEDS_ARGUMENTS: ReadonlySet<string> = new Set(['xargs']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh']);
const MAX_DEPTH = 3;

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/**
 * A fail-closed reading of one command: a program that is not plain text, a hazard program followed
 * by a word the shell expands, or a wrapper that runs a hazard program, each of which could spell a
 * hazard 10db cannot see. Everything else is left to `hazardHit`.
 */
function unreadableHazard(
  command: string,
  hazardPrograms: ReadonlySet<string>,
  depth = 0,
): string | null {
  for (const segment of parseShell(command).segments) {
    const words = withoutRedirections(leadingWords(segment.words).command);
    const [head = ''] = words;
    // Assignments before the program are not the program.
    const at = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const program = at < 0 ? '' : (words[at] ?? '');
    const rest = at < 0 ? [] : words.slice(at + 1);
    if (program !== '' && !PLAIN_PROGRAM.test(program)) {
      return `The program "${program}" is not written out, so 10db cannot tell what it runs.`;
    }
    const name = baseName(program);
    // A hazard program anywhere in the command line (behind env, command, nice...) with a word the
    // shell expands after it: the expansion could select a hazard form.
    const at2 = [program, ...rest].findIndex((word) => hazardPrograms.has(baseName(word)));
    if (at2 >= 0 && [program, ...rest].slice(at2 + 1).some((word) => EXPANDING.test(word))) {
      return `A program with hazard forms is followed by a word the shell expands.`;
    }
    if (FEEDS_ARGUMENTS.has(name) && rest.some((word) => hazardPrograms.has(baseName(word)))) {
      return `"${name}" feeds a program with hazard forms its arguments.`;
    }
    if (head === '') continue;
    if (depth < MAX_DEPTH) {
      const documents = SHELLS.has(baseName(program)) ? segment.hereDocuments : [];
      const inner = [...segment.nested, ...documents, ...shellScripts(words)];
      for (const body of inner) {
        const found = unreadableHazard(body, hazardPrograms, depth + 1);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/** The command's reason to ask: a hazard it runs, a loop that never ends, or text too deep to scan. */
function commandAsk(
  command: string,
  background: boolean,
  hazards: readonly HazardDef[],
): SandboxedAsk | null {
  try {
    const hit = hazardHit(command, hazards);
    if (hit !== null) return ask(`This command runs the "${hit.name}" hazard.`);
    if (startsEndlessBackgroundLoop(command, { background })) {
      return ask('This command runs something that never ends in the background.');
    }
    const programs = new Set(
      hazards.flatMap((hazard) => hazard.commands.map((c) => baseName(c.split(' ')[0] ?? ''))),
    );
    const unreadable = unreadableHazard(command, programs);
    if (unreadable !== null) return ask(unreadable);
  } catch (cause) {
    // A command nested deeply enough to overflow the stack is one nothing can read.
    if (cause instanceof Error && cause.name === 'RangeError') {
      return ask('This command is too deeply nested for 10db to read.');
    }
    throw cause;
  }
  return null;
}

/**
 * What a sandboxed lane's PreToolUse hook hands to the broker. In auto mode Claude Code's classifier
 * settles every call no rule asks about, and it never reaches the broker, so the calls that need a
 * card are named here: a hazard command, a background loop with no end, a Monitor call with an input
 * key beyond command, description and timeout_ms (`ws` opens a socket from Claude Code's own process,
 * outside the sandbox's network proxy), and the tools that act outside that proxy (WebFetch,
 * WebSearch and repo MCP tools), and the file tools, which the sandbox does not bound: a read outside
 * what lanes may read and a write to a Claude Code configuration path. The broker then applies stored
 * rules and raises today's cards.
 */
export function sandboxedAsk(
  req: { readonly toolName: string; readonly input: unknown },
  hazards: readonly HazardDef[],
  fileAccess?: FileAccessJudge,
): SandboxedAsk | null {
  if (fileAccess !== undefined && READ_FAMILY.has(req.toolName)) {
    const reason = fileAccess.readAsk(req.toolName, req.input);
    return reason === null ? null : ask(reason);
  }
  if (fileAccess !== undefined && EDIT_FAMILY.has(req.toolName)) {
    const path = stringField(req.input, 'file_path') ?? stringField(req.input, 'notebook_path');
    const reason =
      path === null ? 'The path of this edit could not be read.' : fileAccess.writeAsk(path);
    return reason === null ? null : ask(reason);
  }
  if (actsOutsideSandboxProxy(req.toolName)) {
    return ask(`${req.toolName} acts outside the sandbox's network proxy.`);
  }
  if (req.toolName !== 'Bash' && req.toolName !== 'Monitor') return null;
  const input = ToolInput.safeParse(req.input);
  if (!input.success) return ask(`${req.toolName} input was not understood.`);
  if (req.toolName === 'Monitor') {
    const extra = Object.keys(input.data).find((key) => !MONITOR_INPUT_KEYS.has(key));
    if (extra !== undefined) return ask(`Monitor input carries "${extra}".`);
  }
  const command = input.data['command'];
  if (typeof command !== 'string') return ask(`${req.toolName} carried no command to read.`);
  return commandAsk(command, runsInBackground(input.data), hazards);
}

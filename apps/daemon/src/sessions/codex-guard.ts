import { chmod, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { SessionSpec } from './types';

/** What Codex's `PreToolUse` hook sends: the keys 10db reads, with the rest passed over. */
export const HookInput = z.looseObject({
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string().optional(),
  cwd: z.string().optional(),
});
export type HookInput = z.infer<typeof HookInput>;

/** One call as the guard judges it. */
export interface GuardCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

const InputRecord = z.record(z.string(), z.unknown());
const BashInput = z.looseObject({ command: z.string() });
const PatchInput = z.looseObject({ command: z.string() });

const PATCH_HEADERS = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '];

/** Lines of a patch that carry no path. */
const PATCH_MARKERS = ['*** Begin Patch', '*** End Patch', '*** End of File'];

/** Codex trims a line before it reads a hunk header, and its trim strips U+0085 where JavaScript's does not. */
const edgeSpace = /^[\s\u0085]+|[\s\u0085]+$/g;

interface ReadPatch {
  readonly paths: readonly string[];
  /** A line starts with `***` and is no marker Codex defines, so 10db cannot say what it does. */
  readonly unknownMarker: boolean;
}

function readPatch(patch: string): ReadPatch {
  const paths: string[] = [];
  let unknownMarker = false;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(edgeSpace, '');
    if (!line.startsWith('***')) continue;
    const header = PATCH_HEADERS.find((prefix) => line.startsWith(prefix));
    if (header !== undefined) {
      const path = line.slice(header.length).replace(edgeSpace, '');
      if (path !== '') paths.push(path);
    } else if (!PATCH_MARKERS.includes(line)) unknownMarker = true;
  }
  return { paths, unknownMarker };
}

/** Every path a patch adds, updates, deletes or moves, in order. */
export function patchPaths(patch: string): readonly string[] {
  return readPatch(patch).paths;
}

/**
 * The calls the guard judges for one hook call. A patch is one `Edit` per path, resolved against the
 * hook's `cwd`; `null` is a tool 10db doesn't know, input it cannot read or a patch it cannot read
 * fully, which is refused.
 */
export function guardCalls(hook: HookInput): readonly GuardCall[] | null {
  const name = hook.tool_name;
  if (name === 'Bash') {
    const input = BashInput.safeParse(hook.tool_input);
    return input.success ? [{ toolName: name, input: input.data }] : null;
  }
  if (name === 'apply_patch') {
    const input = PatchInput.safeParse(hook.tool_input);
    if (!input.success) return null;
    const { paths, unknownMarker } = readPatch(input.data.command);
    if (unknownMarker) return null;
    return paths.map((path) => ({
      toolName: 'Edit',
      input: { file_path: hook.cwd === undefined ? path : resolve(hook.cwd, path) },
    }));
  }
  if (name.startsWith('mcp__')) {
    const input = InputRecord.safeParse(hook.tool_input ?? {});
    return input.success ? [{ toolName: name, input: input.data }] : null;
  }
  return null;
}

export type GuardAnswer =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string; readonly interrupt: boolean };

const NO_REASON = '10db refused this call.';

/** Codex runs a call whose `deny` has no reason, so a refusal always carries one. */
const refuse = (reason: string, interrupt = false): GuardAnswer => ({
  allow: false,
  reason: reason.trim() === '' ? NO_REASON : reason,
  interrupt,
});

/**
 * Runs the session's guard and broker over one hook call. Every call a patch holds must pass; a tool
 * 10db doesn't know, and a patch that names no path, are refused rather than read as nothing to judge.
 */
export async function judgeHookCall(
  spec: Pick<SessionSpec, 'preToolUse' | 'canUseTool'>,
  hook: HookInput,
  signal: AbortSignal,
): Promise<GuardAnswer> {
  const calls = guardCalls(hook);
  if (calls === null) return refuse(`10db does not allow the tool "${hook.tool_name}" in a lane.`);
  if (calls.length === 0)
    return refuse('10db found no file path in this patch, so it was refused.');
  for (const call of calls) {
    if (signal.aborted) return refuse('The session ended before this call was checked.');
    const verdict = spec.preToolUse({
      toolName: call.toolName,
      input: call.input,
      ...(hook.cwd === undefined ? {} : { cwd: hook.cwd }),
    });
    if (verdict.decision === 'deny') return refuse(verdict.reason);
    if (verdict.decision === 'allow') continue;
    // A Codex hook cannot change a call, so the broker's `updatedInput` is not used.
    const decision = await spec.canUseTool({
      toolName: call.toolName,
      input: call.input,
      toolUseId: hook.tool_use_id ?? null,
      escalated: false,
      signal,
      ...(hook.cwd === undefined ? {} : { cwd: hook.cwd }),
    });
    if (decision.behavior === 'deny') return refuse(decision.message, decision.interrupt === true);
  }
  return signal.aborted
    ? refuse('The session ended before this call was checked.')
    : { allow: true };
}

export interface GuardSocket {
  readonly path: string;
  close(): Promise<void>;
}

/** The most of a hook call's body the socket reads. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const MODE_SOCKET = 0o600;

class BodyTooLarge extends Error {
  override readonly name = 'BodyTooLarge';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge('the hook call is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, body === '' ? {} : { 'content-type': 'application/json' });
  res.end(body);
}

function denyBody(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Listens on the Unix socket `path` for the guard hook's posts. An allowed call answers 200 with an
 * empty body, a refused one a `deny` document, and anything else (a bad request, a judge that throws)
 * 500, which the hook script's `curl --fail` turns into exit 2. A file already at `path` is removed:
 * a session's socket path is its own. Closing aborts every call still being judged.
 */
export async function openGuardSocket(
  path: string,
  judge: (hook: HookInput, signal: AbortSignal) => Promise<GuardAnswer>,
  onError: (code: string) => void = () => undefined,
): Promise<GuardSocket> {
  const closed = new AbortController();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || req.url !== '/pre-tool-use') {
      send(res, 404, '');
      return;
    }
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    try {
      const hook = HookInput.parse(JSON.parse(await readBody(req)));
      const answer = await judge(hook, AbortSignal.any([closed.signal, gone.signal]));
      send(res, 200, answer.allow ? '' : denyBody(answer.reason));
    } catch {
      send(res, 500, '');
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await rm(path, { force: true });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
      done();
    });
  });
  // A failed accept (too many open files) emits `error`; unhandled it would end the daemon.
  server.on('error', (error: NodeJS.ErrnoException) => {
    onError(error.code ?? error.name);
  });
  try {
    await chmod(path, MODE_SOCKET);
  } catch (error) {
    server.close();
    throw error;
  }

  return {
    path,
    close: async () => {
      closed.abort();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
        server.closeAllConnections();
      });
      await rm(path, { force: true });
    },
  };
}

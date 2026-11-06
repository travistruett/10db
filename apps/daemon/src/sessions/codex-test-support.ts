import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { CodexChild, CodexSpawn } from './codex-rpc';

/** The error form of a script entry or of what a function entry returns; anything else is the result itself. */
const ErrorEntry = z.object({ error: z.object({ code: z.number(), message: z.string() }) });

/** One line the client writes, as the fake reads it. */
const RpcLine = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

/** A message the client wrote to the fake server's stdin. */
export type Rpc = z.infer<typeof RpcLine>;

/**
 * What the fake answers a method with: a result, `{ error }`, or a function of the params returning
 * either, or a promise of one.
 */
export type ScriptEntry = unknown;

/** A script entry that is a function of the params. */
function isHandler(entry: ScriptEntry): entry is (params: unknown) => unknown {
  return typeof entry === 'function';
}

export interface FakeAppServer {
  readonly child: CodexChild;
  readonly spawn: CodexSpawn;
  sent(): Rpc[];
  /** Pushes a notification from the server. */
  notify(method: string, params: unknown): void;
  /** Writes a raw line to stdout, as the server would. */
  writeLine(line: string): void;
  /** Writes raw bytes to stdout, for a line split across chunks. */
  writeBytes(bytes: Uint8Array): void;
  /** Whether the client has killed the child. */
  killed(): boolean;
  /** Writes text to stderr. */
  writeStderr(text: string): void;
  exit(code: number | null): void;
}

/**
 * Stands in for `codex app-server` at the process boundary. A request is answered from `script`
 * by method name; a method the script lacks is answered with -32601, as the server does.
 */
export function fakeAppServer(script: Readonly<Record<string, ScriptEntry>>): FakeAppServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Rpc[] = [];
  let wasKilled = false;
  const exitListeners: ((code: number | null) => void)[] = [];
  const reply = (message: object): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  const requests = createInterface({ input: stdin });
  // A test may destroy stdin with an error; the interface would otherwise rethrow it.
  requests.on('error', () => undefined);
  /** Answers `id` with `answer`: its error when it is `{ error }`, else as the result. */
  const answer = (id: number | string, answer: unknown): void => {
    const failure = ErrorEntry.safeParse(answer);
    reply(failure.success ? { id, error: failure.data.error } : { id, result: answer });
  };

  requests.on('line', (line) => {
    const parsed = RpcLine.safeParse(JSON.parse(line));
    if (!parsed.success) return;
    const message = parsed.data;
    sent.push(message);
    if (message.id === undefined || message.method === undefined) return;
    const id = message.id;
    if (!Object.hasOwn(script, message.method)) {
      reply({ id, error: { code: -32601, message: `no script for ${message.method}` } });
      return;
    }
    const entry = script[message.method];
    if (!isHandler(entry)) {
      answer(id, entry);
      return;
    }
    void Promise.resolve(entry(message.params)).then((result) => {
      answer(id, result);
    });
  });

  const child: CodexChild = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    kill: () => {
      wasKilled = true;
      return true;
    },
    once: (_event, listener) => {
      exitListeners.push(listener);
      return child;
    },
  };

  return {
    child,
    spawn: () => child,
    sent: () => [...sent],
    notify: (method, params) => {
      reply({ method, params });
    },
    writeLine: (line) => {
      stdout.write(`${line}\n`);
    },
    writeBytes: (bytes) => {
      stdout.write(bytes);
    },
    killed: () => wasKilled,
    writeStderr: (text) => {
      stderr.write(text);
    },
    exit: (code) => {
      for (const listener of exitListeners) listener(code);
    },
  };
}

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { CodexChild, CodexSpawn } from './codex-rpc';

/** A message the client wrote to the fake server's stdin. */
export interface Rpc {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
}

/** The error form of a script entry; any other non-function entry is the result itself. */
const ErrorEntry = z.object({ error: z.object({ code: z.number(), message: z.string() }) });

/** What the fake answers a method with: a result, `{ error }`, or a function of the params returning a result. */
export type ScriptEntry = unknown;

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
  requests.on('line', (line) => {
    const message = JSON.parse(line) as Rpc;
    sent.push(message);
    if (message.id === undefined || message.method === undefined) return;
    const id = message.id;
    if (!Object.hasOwn(script, message.method)) {
      reply({ id, error: { code: -32601, message: `no script for ${message.method}` } });
      return;
    }
    const entry = script[message.method];
    if (typeof entry !== 'function') {
      const failure = ErrorEntry.safeParse(entry);
      reply(failure.success ? { id, error: failure.data.error } : { id, result: entry });
      return;
    }
    void Promise.resolve((entry as (params: unknown) => unknown)(message.params)).then((result) => {
      reply({ id, result });
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

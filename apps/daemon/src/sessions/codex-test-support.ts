import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { CodexChild, CodexSpawn } from './codex-rpc';

/** A message the client wrote to the fake server's stdin. */
export interface Rpc {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
}

/** What the fake answers a method with: a result, or a function of the params, or an error. */
export type ScriptEntry =
  | { readonly error: { readonly code: number; readonly message: string } }
  | ((params: unknown) => unknown);

export interface FakeAppServer {
  readonly child: CodexChild;
  readonly spawn: CodexSpawn;
  sent(): Rpc[];
  /** Pushes a notification from the server. */
  notify(method: string, params: unknown): void;
  /** Writes a raw line to stdout, as the server would. */
  writeLine(line: string): void;
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
  const exitListeners: ((code: number | null) => void)[] = [];
  const reply = (message: object): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  createInterface({ input: stdin }).on('line', (line) => {
    const message = JSON.parse(line) as Rpc;
    sent.push(message);
    if (message.id === undefined || message.method === undefined) return;
    const id = message.id;
    const entry = script[message.method];
    if (entry === undefined) {
      reply({ id, error: { code: -32601, message: `no script for ${message.method}` } });
      return;
    }
    if (typeof entry !== 'function') {
      reply({ id, error: entry.error });
      return;
    }
    void Promise.resolve(entry(message.params)).then((result) => {
      reply({ id, result });
    });
  });

  const child: CodexChild = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    kill: () => true,
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
    writeStderr: (text) => {
      stderr.write(text);
    },
    exit: (code) => {
      for (const listener of exitListeners) listener(code);
    },
  };
}

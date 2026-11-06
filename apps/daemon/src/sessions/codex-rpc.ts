import { spawn } from 'node:child_process';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { Logger } from '../log';

/** The part of a child process the client uses, so a test can stand in for `codex`. */
export interface CodexChild {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}

export type CodexSpawn = (codexPath: string, env: Readonly<Record<string, string>>) => CodexChild;

const STDERR_TAIL_CHARS = 4096;
const METHOD_NOT_FOUND = -32601;

/** An error answer from the app-server, or a call that could not be answered. */
export class CodexRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
  }
}

/** The code of a `CodexRpcError` that did not come from the server. */
const CLIENT_ERROR_CODE = 0;

export interface CodexRpc {
  call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (n: { method: string; params: unknown }) => void): void;
  readonly exited: Promise<{ readonly code: number | null; readonly stderr: string }>;
  close(): void;
}

const Message = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

interface Pending {
  /** Checks an answer against the call's schema and settles the call with it. */
  readonly accept: (raw: unknown) => void;
  readonly reject: (error: Error) => void;
}

export function createCodexRpc(child: CodexChild, log: Pick<Logger, 'warn'>): CodexRpc {
  const pending = new Map<number, Pending>();
  const handlers: ((n: { method: string; params: unknown }) => void)[] = [];
  let nextId = 1;
  let stderr = '';
  let closed = false;

  const send = (message: object): void => {
    if (closed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  // A write to a child that has gone is an error event on stdin; unhandled it would end the daemon.
  // Killing the child brings its exit, which settles every open call.
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    log.warn({ code: error.code }, 'writing to codex app-server failed');
    child.kill();
  });

  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });

  const handleLine = (line: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      log.warn({ length: line.length }, 'codex app-server wrote a line that is not JSON');
      return;
    }
    const parsed = Message.safeParse(json);
    if (!parsed.success) {
      log.warn({ length: line.length }, 'codex app-server wrote a message of an unknown shape');
      return;
    }
    const message = parsed.data;
    if (message.method !== undefined && message.id !== undefined) {
      send({
        id: message.id,
        error: { code: METHOD_NOT_FOUND, message: `10db does not answer ${message.method}` },
      });
      return;
    }
    if (message.method !== undefined) {
      for (const handler of handlers) handler({ method: message.method, params: message.params });
      return;
    }
    if (typeof message.id !== 'number') return;
    const call = pending.get(message.id);
    if (call === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      call.reject(new CodexRpcError(message.error.message, message.error.code));
      return;
    }
    call.accept(message.result);
  };

  // Lines end at "\n" only: readline also splits on U+2028 and U+2029, which JSON leaves raw in strings.
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.length > 0) handleLine(line);
    }
  });

  const exited = new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolve) => {
      child.once('exit', (code) => {
        closed = true;
        const tail = stderr;
        for (const call of pending.values()) {
          call.reject(
            new CodexRpcError(
              `codex app-server exited (${String(code)}): ${tail}`,
              CLIENT_ERROR_CODE,
            ),
          );
        }
        pending.clear();
        resolve({ code, stderr: tail });
      });
    },
  );

  return {
    call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
      if (closed) {
        return Promise.reject(
          new CodexRpcError('codex app-server is not running', CLIENT_ERROR_CODE),
        );
      }
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          accept: (raw) => {
            const result = schema.safeParse(raw);
            if (result.success) resolve(result.data);
            else {
              reject(
                new CodexRpcError(
                  `the answer did not match its schema: ${result.error.message}`,
                  CLIENT_ERROR_CODE,
                ),
              );
            }
          },
          reject,
        });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send(params === undefined ? { method } : { method, params });
    },
    onNotification(handler) {
      handlers.push(handler);
    },
    exited,
    close() {
      child.kill();
    },
  };
}

/**
 * Runs the real `codex app-server`; its environment is exactly `env`. A program that cannot start
 * is reported as an exit with a null code and the reason on stderr, like any other end.
 */
export const spawnAppServer: CodexSpawn = (codexPath, env) => {
  const child = spawn(codexPath, ['app-server', '--stdio', '--strict-config'], {
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = new PassThrough();
  child.stderr.pipe(stderr, { end: false });
  const listeners: ((code: number | null) => void)[] = [];
  let ended = false;
  const end = (code: number | null): void => {
    if (ended) return;
    ended = true;
    for (const listener of listeners) listener(code);
  };
  child.on('exit', end);
  child.on('error', (error: NodeJS.ErrnoException) => {
    stderr.write(`${error.code ?? 'error'}: ${error.message}\n`, () => {
      end(null);
    });
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr,
    kill: () => child.kill(),
    once: (_event, listener) => {
      listeners.push(listener);
      return child;
    },
  };
};

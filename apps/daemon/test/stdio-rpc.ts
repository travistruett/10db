import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';

const Message = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});
export type RpcMessage = z.infer<typeof Message>;

/** A child speaking line-delimited JSON-RPC on stdio, driven by hand so framing and ids are checked as sent. */
export interface StdioRpc {
  readonly child: ChildProcess;
  /** Sends a request with the next id and waits for the message that carries it. */
  request(method: string, params?: unknown): Promise<{ id: number; message: RpcMessage }>;
  notify(method: string, params?: unknown): void;
  /** Everything the child wrote to stdout that was not one JSON-RPC message per line (must stay empty). */
  readonly strayStdout: string[];
  stderr(): string;
  close(): Promise<void>;
}

export function spawnStdioRpc(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): StdioRpc {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const strayStdout: string[] = [];
  const waiting = new Map<number, (message: RpcMessage) => void>();
  let buffer = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let parsed: RpcMessage;
      try {
        parsed = Message.parse(JSON.parse(line));
      } catch {
        strayStdout.push(line);
        continue;
      }
      if (typeof parsed.id === 'number') waiting.get(parsed.id)?.(parsed);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors += chunk;
  });
  let nextId = 0;
  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  return {
    child,
    strayStdout,
    stderr: () => errors,
    request(method, params) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`no answer to ${method} (id ${String(id)}); stderr:\n${errors}`));
        }, 30_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve({ id, message });
        });
        send({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) {
      send({ method, ...(params === undefined ? {} : { params }) });
    },
    close() {
      const exited = new Promise<void>((done) => {
        if (child.exitCode !== null) done();
        else
          child.once('exit', () => {
            done();
          });
      });
      child.stdin.end();
      setTimeout(() => {
        child.kill('SIGTERM');
      }, 5_000).unref();
      return exited;
    },
  };
}

/** The MCP handshake: initialize, then the initialized notification. */
export async function initialize(rpc: StdioRpc): Promise<RpcMessage> {
  const { message } = await rpc.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '0' },
  });
  rpc.notify('notifications/initialized');
  return message;
}

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodexRpcError, createCodexRpc } from './codex-rpc';
import { fakeAppServer } from './codex-test-support';

const Echo = z.object({ value: z.string() });

function warnings(): { log: { warn: (o: object, m?: string) => void }; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      warn: (_o, m) => {
        lines.push(m ?? '');
      },
    },
  };
}

describe('createCodexRpc', () => {
  it('matches answers to calls whatever order they arrive in', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const server = fakeAppServer({
      slow: async () => {
        await firstHeld;
        return { value: 'slow' };
      },
      fast: () => {
        releaseFirst();
        return { value: 'fast' };
      },
    });
    const rpc = createCodexRpc(server.child, warnings().log);
    const slow = rpc.call('slow', {}, Echo);
    const fast = rpc.call('fast', {}, Echo);
    await expect(fast).resolves.toEqual({ value: 'fast' });
    await expect(slow).resolves.toEqual({ value: 'slow' });
  });

  it('rejects with CodexRpcError on an error response', async () => {
    const server = fakeAppServer({ boom: { error: { code: -32000, message: 'nope' } } });
    const rpc = createCodexRpc(server.child, warnings().log);
    const error = await rpc.call('boom', {}, Echo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error).toMatchObject({ name: 'CodexRpcError', code: -32000, message: 'nope' });
  });

  it('rejects a response its schema refuses', async () => {
    const server = fakeAppServer({ odd: () => ({ value: 7 }) });
    const rpc = createCodexRpc(server.child, warnings().log);
    await expect(rpc.call('odd', {}, Echo)).rejects.toBeInstanceOf(CodexRpcError);
  });

  it('logs a line that is not JSON and keeps reading', async () => {
    const server = fakeAppServer({ ok: () => ({ value: 'fine' }) });
    const seen = warnings();
    const rpc = createCodexRpc(server.child, seen.log);
    const notes: string[] = [];
    rpc.onNotification((n) => notes.push(n.method));
    server.writeLine('this is not json');
    server.notify('thread/started', {});
    await expect(rpc.call('ok', {}, Echo)).resolves.toEqual({ value: 'fine' });
    expect(seen.lines).toHaveLength(1);
    expect(notes).toEqual(['thread/started']);
  });

  it('refuses a server request with -32601 and carries on', async () => {
    const server = fakeAppServer({ ok: () => ({ value: 'fine' }) });
    const rpc = createCodexRpc(server.child, warnings().log);
    server.writeLine(
      JSON.stringify({ id: 'srv-1', method: 'item/commandExecution/requestApproval' }),
    );
    await expect(rpc.call('ok', {}, Echo)).resolves.toEqual({ value: 'fine' });
    const refusal = server.sent().find((m) => m.id === 'srv-1');
    expect(refusal).toMatchObject({ id: 'srv-1', error: { code: -32601 } });
  });

  it('rejects every open call when the child exits, with the end of its stderr', async () => {
    const server = fakeAppServer({ never: () => new Promise(() => undefined) });
    const rpc = createCodexRpc(server.child, warnings().log);
    const results = Promise.allSettled([rpc.call('never', {}, Echo), rpc.call('never', {}, Echo)]);
    // The client's own stderr listener is registered first, so it has run once this one does.
    const stderrRead = new Promise<void>((resolve) => {
      server.child.stderr.once('data', () => {
        resolve();
      });
    });
    server.writeStderr('first line\nthe real reason');
    await stderrRead;
    server.exit(3);
    const settled = await results;
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      if (s.status === 'rejected') expect(String(s.reason)).toContain('the real reason');
    }
    await expect(rpc.exited).resolves.toMatchObject({ code: 3 });
    expect((await rpc.exited).stderr).toContain('the real reason');
  });
});

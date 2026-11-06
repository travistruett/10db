import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CodexRpcError, createCodexRpc, spawnAppServer } from './codex-rpc';
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

  it('answers a call with a plain result in the script', async () => {
    const server = fakeAppServer({ plain: { value: 'plain' } });
    const rpc = createCodexRpc(server.child, warnings().log);
    await expect(rpc.call('plain', {}, Echo)).resolves.toEqual({ value: 'plain' });
  });

  it('keeps a message that holds U+2028 and U+2029 whole', async () => {
    const server = fakeAppServer({});
    const seen = warnings();
    const rpc = createCodexRpc(server.child, seen.log);
    const notes: unknown[] = [];
    rpc.onNotification((n) => notes.push(n.params));
    server.notify('thread/started', { cwd: 'a\u2028b\u2029c' });
    server.notify('after', {});
    await vi.waitFor(() => {
      expect(notes).toHaveLength(2);
    });
    expect(notes[0]).toEqual({ cwd: 'a\u2028b\u2029c' });
    expect(seen.lines).toEqual([]);
  });

  it('reads a multi-byte character that straddles two chunks', async () => {
    const server = fakeAppServer({});
    const rpc = createCodexRpc(server.child, warnings().log);
    const notes: unknown[] = [];
    rpc.onNotification((n) => notes.push(n.params));
    const bytes = Buffer.from(
      `${JSON.stringify({ method: 'm', params: { text: 'caf\u00e9 \u{1f600}' } })}\n`,
    );
    const cut = bytes.indexOf(0xf0) + 2;
    server.writeBytes(bytes.subarray(0, cut));
    server.writeBytes(bytes.subarray(cut));
    await vi.waitFor(() => {
      expect(notes).toHaveLength(1);
    });
    expect(notes[0]).toEqual({ text: 'caf\u00e9 \u{1f600}' });
  });

  it('survives a write to a stdin that fails, and kills the child', async () => {
    const server = fakeAppServer({});
    const seen = warnings();
    const rpc = createCodexRpc(server.child, seen.log);
    server.child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await vi.waitFor(() => {
      expect(server.killed()).toBe(true);
    });
    expect(() => {
      rpc.notify('initialized');
    }).not.toThrow();
    expect(seen.lines).toHaveLength(1);
  });
});

describe('spawnAppServer', () => {
  it('reports a program that cannot start as an exit, without crashing', async () => {
    const child = spawnAppServer('/nonexistent/codex', {});
    const rpc = createCodexRpc(child, warnings().log);
    const answer = rpc.call('initialize', {}, Echo).catch((e: unknown) => e);
    const exit = await rpc.exited;
    expect(exit.code).toBeNull();
    expect(exit.stderr).toContain('ENOENT');
    expect(await answer).toBeInstanceOf(CodexRpcError);
  });
});

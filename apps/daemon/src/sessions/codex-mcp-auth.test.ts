import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { CODEX_MCP_STATUS_WAIT_MS, McpAuthState, readCodexMcpAuth } from './codex-mcp-auth';
import type { CodexCall } from './codex-account-read';

interface Row {
  name: string;
  authStatus: string;
}

/** A fake app-server's `mcpServerStatus/list`: each call answers the next page, or the next scripted list. */
function server(pages: readonly (readonly Row[])[]) {
  const calls: unknown[] = [];
  let index = 0;
  const call: CodexCall = (method, params, schema) => {
    calls.push({ method, params });
    const page = pages[Math.min(index, pages.length - 1)] ?? [];
    index += 1;
    return Promise.resolve(schema.parse({ data: page, nextCursor: null }));
  };
  return { call, calls };
}

const names = ['linear', 'notion'];

describe('readCodexMcpAuth', () => {
  it.each<[string, string, McpAuthState]>([
    ['oAuth', 'oAuth', McpAuthState.SignedIn],
    ['bearerToken', 'bearerToken', McpAuthState.SignedIn],
    ['notLoggedIn', 'notLoggedIn', McpAuthState.NotSignedIn],
    ['unsupported', 'unsupported', McpAuthState.NotOAuth],
  ])('reads %s as %s', async (_name, authStatus, expected) => {
    const { call, calls } = server([[{ name: 'linear', authStatus }]]);
    const read = await readCodexMcpAuth(call, 'thr_1', ['linear'], new ManualClock());
    expect(read).toEqual({ linear: expected });
    expect(calls).toEqual([
      { method: 'mcpServerStatus/list', params: { threadId: 'thr_1', detail: 'toolsAndAuthOnly' } },
    ]);
  });

  it('reads every server of a page', async () => {
    const { call } = server([
      [
        { name: 'linear', authStatus: 'oAuth' },
        { name: 'notion', authStatus: 'notLoggedIn' },
      ],
    ]);
    const read = await readCodexMcpAuth(call, 'thr_1', names, new ManualClock());
    expect(read).toEqual({ linear: McpAuthState.SignedIn, notion: McpAuthState.NotSignedIn });
  });

  it('follows nextCursor across pages', async () => {
    const asked: unknown[] = [];
    const call: CodexCall = (_method, params, schema) => {
      asked.push(params);
      const first = asked.length === 1;
      return Promise.resolve(
        schema.parse({
          data: [
            first
              ? { name: 'linear', authStatus: 'oAuth' }
              : { name: 'notion', authStatus: 'notLoggedIn' },
          ],
          nextCursor: first ? 'c2' : null,
        }),
      );
    };
    const read = await readCodexMcpAuth(call, 'thr_1', names, new ManualClock());
    expect(read).toEqual({ linear: McpAuthState.SignedIn, notion: McpAuthState.NotSignedIn });
    expect(asked[1]).toMatchObject({ cursor: 'c2' });
  });

  it('asks again every 250 ms for a name that reads unknown', async () => {
    const clock = new ManualClock();
    const { call, calls } = server([
      [{ name: 'linear', authStatus: 'unknown' }],
      [{ name: 'linear', authStatus: 'notLoggedIn' }],
    ]);
    const read = readCodexMcpAuth(call, 'thr_1', ['linear'], clock);
    await vi.waitFor(() => {
      expect(clock.pendingTimers()).toBeGreaterThan(0);
    });
    clock.advance(250);
    expect(await read).toEqual({ linear: McpAuthState.NotSignedIn });
    expect(calls).toHaveLength(2);
  });

  it('reads unknown past the deadline', async () => {
    const clock = new ManualClock();
    const { call } = server([[{ name: 'linear', authStatus: 'unknown' }]]);
    const read = readCodexMcpAuth(call, 'thr_1', ['linear'], clock);
    for (let waited = 0; waited < CODEX_MCP_STATUS_WAIT_MS; waited += 250) {
      await vi.waitFor(() => {
        expect(clock.pendingTimers()).toBeGreaterThan(0);
      });
      clock.advance(250);
    }
    expect(await read).toEqual({ linear: McpAuthState.Unknown });
  });

  it('stops following a cursor the server repeats, so a looping server never hangs the read', async () => {
    let asked = 0;
    const call: CodexCall = (_method, _params, schema) => {
      asked += 1;
      if (asked > 20) return Promise.reject(new Error('followed a repeated cursor'));
      return Promise.resolve(
        schema.parse({ data: [{ name: 'linear', authStatus: 'oAuth' }], nextCursor: 'same' }),
      );
    };
    const read = await readCodexMcpAuth(call, 'thr_1', ['linear'], new ManualClock());
    expect(read).toEqual({ linear: McpAuthState.SignedIn });
    expect(asked).toBeLessThanOrEqual(3);
  });
});

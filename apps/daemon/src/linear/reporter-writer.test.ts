import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { YourSessionServer } from '../sessions';
import {
  authorizedLinearServer,
  createLinearCommentWriter,
  LinearWriteError,
} from './reporter-writer';

// The writer against a real MCP endpoint standing in for Linear's: only its save_comment tool, answering as
// Linear does, with the request's Authorization noted.

let server: ReturnType<typeof serve>;
let url: string;
let seen: { authorization: string | null; args: { issueId: string; body: string } }[] = [];
let answer: { isError: boolean; text: string } = { isError: false, text: '{"id":"c-9"}' };

beforeEach(async () => {
  seen = [];
  answer = { isError: false, text: '{"id":"c-9"}' };
  server = serve({
    fetch: async (req: Request) => {
      const mcp = new McpServer({ name: 'linear', version: '0.0.0' });
      mcp.registerTool(
        'save_comment',
        { inputSchema: { issueId: z.string(), body: z.string() } },
        (args) => {
          seen.push({ authorization: req.headers.get('authorization'), args });
          return {
            isError: answer.isError,
            content: [{ type: 'text' as const, text: answer.text }],
          };
        },
      );
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  // serve() on a TCP port reports an AddressInfo once listening.
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});

afterEach(() => {
  server.close();
});

describe('the Linear comment writer', () => {
  it('writes the comment with the sign-in it was given and answers the id Linear returned', async () => {
    const writer = createLinearCommentWriter({ url, headers: { Authorization: 'Bearer k' } });
    await expect(writer.postComment({ issueId: 'iss-1', body: 'Hello there' })).resolves.toBe(
      'c-9',
    );
    expect(seen).toEqual([
      { authorization: 'Bearer k', args: { issueId: 'iss-1', body: 'Hello there' } },
    ]);
  });

  it('says what Linear refused with, and answers no id when Linear gave none', async () => {
    const writer = createLinearCommentWriter({ url, headers: { Authorization: 'Bearer k' } });
    answer = { isError: true, text: 'Issue not found' };
    await expect(writer.postComment({ issueId: 'iss-1', body: 'x' })).rejects.toThrow(
      new LinearWriteError('Issue not found'),
    );
    answer = { isError: false, text: 'saved' };
    await expect(writer.postComment({ issueId: 'iss-1', body: 'x' })).resolves.toBeNull();
  });

  it('is offered only a Linear entry whose headers carry an Authorization', () => {
    const entry = (u: string, headers: Record<string, string> | null): YourSessionServer => ({
      connect: { type: 'http', url: u, headers },
      claudeName: null,
      claudeOAuth: null,
      codex: {
        enabledTools: null,
        disabledTools: [],
        startupTimeoutSec: null,
        toolTimeoutSec: null,
      },
    });
    const linear = 'https://mcp.linear.app/mcp';
    expect(authorizedLinearServer({ a: entry(linear, null) })).toBeNull();
    expect(authorizedLinearServer({ a: entry(linear, { 'X-Other': '1' }) })).toBeNull();
    expect(
      authorizedLinearServer({ a: entry('https://other.test/mcp', { Authorization: 'x' }) }),
    ).toBeNull();
    expect(authorizedLinearServer({ a: entry(linear, { authorization: 'Bearer k' }) })).toEqual({
      url: linear,
      headers: { authorization: 'Bearer k' },
    });
  });
});

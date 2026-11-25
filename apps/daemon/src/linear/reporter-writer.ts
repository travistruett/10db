import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { YourSessionServer } from '../sessions';
import { isLinearServer } from './lane-reads';

// 10db's own write of a reporter comment, through the account's Linear server. It needs a sign-in 10db can
// present itself: a Linear entry of the builder's whose headers carry an Authorization. An account whose Linear is
// an OAuth sign-in held by its agent, or a claude.ai connector, has no such header, so its comment is written by
// the agent's own `save_comment` call, which the reporter's guard holds to the text 10db built.

/** Linear's tool that writes a comment. */
const SAVE_COMMENT = 'save_comment';
/** How long Linear has to answer one write. */
const WRITE_TIMEOUT_MS = 30_000;

export class LinearWriteError extends Error {
  override readonly name = 'LinearWriteError';
}

/** What Linear answers a written comment with: its id, which 10db records on the row. */
const SavedComment = z.object({ id: z.string().min(1) });

export interface LinearCommentWriter {
  /** Writes one comment on a Linear issue (by Linear's own id); answers the comment's id, or null when Linear gave none. */
  postComment(input: { readonly issueId: string; readonly body: string }): Promise<string | null>;
}

const hasAuthorization = (headers: Readonly<Record<string, string>> | null): boolean =>
  headers !== null && Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');

/** The first of the builder's Linear servers 10db can sign in to itself, or null. */
export function authorizedLinearServer(
  servers: Readonly<Record<string, YourSessionServer>>,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } | null {
  for (const { connect } of Object.values(servers)) {
    if (!('url' in connect) || connect.type !== 'http') continue;
    if (
      isLinearServer(connect.url) &&
      connect.headers !== null &&
      hasAuthorization(connect.headers)
    )
      return { url: connect.url, headers: connect.headers };
  }
  return null;
}

/** Writes through Linear's MCP server over HTTP with the given headers, one short connection per comment. */
export function createLinearCommentWriter(server: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}): LinearCommentWriter {
  return {
    async postComment({ issueId, body }) {
      const client = new Client({ name: '10db-linear-reporter', version: '0.0.0' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: { ...server.headers } },
          }),
        );
        const result = await client.callTool(
          { name: SAVE_COMMENT, arguments: { issueId, body } },
          undefined,
          { timeout: WRITE_TIMEOUT_MS },
        );
        const text = (Array.isArray(result.content) ? result.content : [])
          .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('');
        if (result.isError === true)
          throw new LinearWriteError(text.slice(0, 500) || 'Linear refused the comment');
        try {
          const saved = SavedComment.safeParse(JSON.parse(text));
          return saved.success ? saved.data.id : null;
        } catch {
          return null;
        }
      } catch (error) {
        if (error instanceof LinearWriteError) throw error;
        throw new LinearWriteError(error instanceof Error ? error.message : String(error));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

/**
 * A comment write that did not answer an id. `refused` is true only when Linear certainly wrote nothing: it
 * answered an error, or the connection failed before the write was sent. A timeout or a dropped connection after
 * the send is not refused: Linear may have written the comment, so it is never written again.
 */
export class LinearWriteError extends Error {
  override readonly name = 'LinearWriteError';
  readonly refused: boolean;
  /** Linear refused 10db's sign-in (401 or 403): a sign-in, not a retry, fixes it. Always refused too. */
  readonly signedOut: boolean;
  constructor(message: string, refused: boolean, signedOut = false) {
    super(message);
    this.refused = refused;
    this.signedOut = signedOut;
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Linear turned the sign-in away: an OAuth refusal, or an HTTP 401 or 403 from its server. */
const signInRefused = (error: unknown): boolean =>
  error instanceof UnauthorizedError ||
  (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403));

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
export function createLinearCommentWriter(
  server: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  },
  timeoutMs: number = WRITE_TIMEOUT_MS,
): LinearCommentWriter {
  return {
    async postComment({ issueId, body }) {
      const client = new Client({ name: '10db-linear-reporter', version: '0.0.0' });
      try {
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: { headers: { ...server.headers } },
            }),
          );
        } catch (error) {
          throw new LinearWriteError(
            `Could not reach Linear: ${messageOf(error)}`,
            true,
            signInRefused(error),
          );
        }
        let result: Awaited<ReturnType<Client['callTool']>>;
        try {
          result = await client.callTool(
            { name: SAVE_COMMENT, arguments: { issueId, body } },
            undefined,
            { timeout: timeoutMs },
          );
        } catch (error) {
          // A refused sign-in is an answer before the write ran, so Linear certainly wrote nothing.
          if (signInRefused(error)) throw new LinearWriteError(messageOf(error), true, true);
          throw new LinearWriteError(messageOf(error), false);
        }
        const text = (Array.isArray(result.content) ? result.content : [])
          .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('');
        if (result.isError === true)
          throw new LinearWriteError(text.slice(0, 500) || 'Linear refused the comment', true);
        try {
          const saved = SavedComment.safeParse(JSON.parse(text));
          return saved.success ? saved.data.id : null;
        } catch {
          return null;
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

import type { ChatId } from '@10db/contracts';
import type { DaemonConnection } from './connection';

// The chat routes the typed client does not carry yet: search and the title row's pull request and merge steps. Each returns the raw response, which its caller parses with the route's contract through
// `readJson`. When `AppType` has them, a caller moves to `client.chats[...]` and this file goes.

function request(
  conn: DaemonConnection,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly query?: Readonly<Record<string, string>>; readonly json?: unknown } = {},
  signal?: AbortSignal,
): Promise<Response> {
  const url = new URL(path, conn.url);
  for (const [name, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(name, value);
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export const chatRoutes = {
  search: (conn: DaemonConnection, q: string, after: string | null, signal?: AbortSignal) =>
    request(
      conn,
      'GET',
      '/chats/search',
      { query: { q, ...(after === null ? {} : { after }) } },
      signal,
    ),
  pullRequest: (conn: DaemonConnection, chatId: ChatId) =>
    request(conn, 'POST', `/chats/${chatId}/pull-request`),
  merge: (conn: DaemonConnection, chatId: ChatId) =>
    request(conn, 'POST', `/chats/${chatId}/merge`),
};

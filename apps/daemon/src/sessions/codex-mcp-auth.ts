import { z } from 'zod';
import type { Clock } from '../clock';
import type { CodexCall } from './codex-account-read';

/** Codex's own deadline for an MCP server's status; a name still reading `unknown` then is not known. */
export const CODEX_MCP_STATUS_WAIT_MS = 5_000;
/** What a caller that bounds the whole read waits: past the read's own wait, so its answer is not lost to a tie. */
export const CODEX_MCP_STATUS_BOUND_MS = CODEX_MCP_STATUS_WAIT_MS + 1_000;
/** How often a name that reads `unknown` is asked again. */
const UNKNOWN_RETRY_MS = 250;

/** Whether a server's OAuth sign-in holds in an account's home. */
export const McpAuthState = {
  SignedIn: 'signed_in',
  NotSignedIn: 'not_signed_in',
  NotOAuth: 'not_oauth',
  Unknown: 'unknown',
} as const;
export type McpAuthState = (typeof McpAuthState)[keyof typeof McpAuthState];

const ListMcpServerStatusResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      name: z.string(),
      authStatus: z.enum(['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth']),
    }),
  ),
  nextCursor: z.string().nullish(),
});

/** What an `authStatus` means for sign-in; null while Codex has not yet worked it out. */
function stateOf(
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth',
): McpAuthState | null {
  switch (authStatus) {
    case 'oAuth':
    case 'bearerToken':
      return McpAuthState.SignedIn;
    case 'notLoggedIn':
      return McpAuthState.NotSignedIn;
    case 'unsupported':
      return McpAuthState.NotOAuth;
    case 'unknown':
      return null;
  }
}

/** Every server's `authStatus` on a thread, following `nextCursor`. */
async function listStatuses(
  call: CodexCall,
  threadId: string,
): Promise<Map<string, McpAuthState | null>> {
  const found = new Map<string, McpAuthState | null>();
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof ListMcpServerStatusResponse> = await call(
      'mcpServerStatus/list',
      { threadId, detail: 'toolsAndAuthOnly', ...(cursor === null ? {} : { cursor }) },
      ListMcpServerStatusResponse,
    );
    for (const server of page.data) found.set(server.name, stateOf(server.authStatus));
    const next: string | null = page.nextCursor ?? null;
    // A server that repeats a cursor would be followed forever.
    cursor = next === cursor ? null : next;
  } while (cursor !== null);
  return found;
}

/**
 * Whether each named server is signed in, as Codex reports it on `threadId`, which must carry the servers.
 * A name that reads `unknown` is asked again every 250 ms until `CODEX_MCP_STATUS_WAIT_MS`, then reads
 * `unknown`. A failed call is the caller's to handle; it never means a state.
 */
export async function readCodexMcpAuth(
  call: CodexCall,
  threadId: string,
  names: readonly string[],
  clock: Clock,
): Promise<Readonly<Record<string, McpAuthState>>> {
  const started = clock.now().getTime();
  const read: Record<string, McpAuthState> = {};
  let waiting = [...names];
  for (;;) {
    const statuses = await listStatuses(call, threadId);
    waiting = waiting.filter((name) => {
      const state = statuses.get(name) ?? null;
      if (state === null) return true;
      read[name] = state;
      return false;
    });
    if (waiting.length === 0) break;
    if (clock.now().getTime() - started >= CODEX_MCP_STATUS_WAIT_MS) break;
    await new Promise<void>((resolve) => {
      clock.setTimeout(resolve, UNKNOWN_RETRY_MS);
    });
  }
  for (const name of waiting) read[name] = McpAuthState.Unknown;
  return read;
}

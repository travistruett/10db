import { Agent } from 'undici';

// Node's fetch offers HTTP/2 by default, and an aborted HTTP/2 request can leave a stream that spins
// the main thread forever or throws from a socket timer. This agent offers HTTP/1.1 only, so the
// daemon never opens an HTTP/2 session.
// The cast: Node types `dispatcher` from its bundled undici's types, which differ from the npm
// package's in declarations only. The ALPN test proves the built-in fetch honours this agent.
const dispatcher = new Agent({ allowH2: false }) as unknown as NonNullable<
  RequestInit['dispatcher']
>;

/** The daemon's `fetch` for every outbound call: HTTP/1.1 only. */
export const outboundFetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher });

import { z } from 'zod';

// Socket-level failures of an outbound call. `EPIPE` is left out: it is also what a closed stdout
// or child pipe raises, which is not an outbound call.
const SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const Coded = z.object({ code: z.string().optional(), cause: z.unknown().optional() });

const isTransportCode = (code: string): boolean =>
  code.startsWith('UND_ERR_') || code.startsWith('ERR_HTTP2_') || SOCKET_CODES.has(code);

/**
 * Whether `error` is a failed outbound connection: one of the HTTP client's own errors, an HTTP/2
 * session error or a socket error, on the error itself or on its `cause` (a failed fetch rejects
 * with a `TypeError` whose cause carries the code).
 */
export function isOutboundTransportError(error: unknown): boolean {
  const coded = Coded.safeParse(error);
  if (!coded.success) return false;
  if (coded.data.code !== undefined && isTransportCode(coded.data.code)) return true;
  const cause = Coded.safeParse(coded.data.cause);
  return cause.success && cause.data.code !== undefined && isTransportCode(cause.data.code);
}

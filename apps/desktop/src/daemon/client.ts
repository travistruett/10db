import { refusalText } from '@10db/contracts';
import type { AppType } from '@10db/daemon';
import { hc } from 'hono/client';
import { z } from 'zod';
import type { DaemonConnection } from './connection';

/** The typed Hono client for one daemon connection; every call carries the UI token. */
export function createDaemonClient(conn: DaemonConnection) {
  return hc<AppType>(conn.url, { headers: { Authorization: `Bearer ${conn.token}` } });
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;

/** A non-2xx answer from the daemon; `message` is the daemon's own explanation. */
export class DaemonRequestError extends Error {
  override readonly name = 'DaemonRequestError';
  // Declared fields, not parameter properties: erasableSyntaxOnly rejects those (TS1294).
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const ErrorBody = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

function errorMessage(status: number, body: unknown): string {
  const parsed = ErrorBody.safeParse(body);
  if (!parsed.success) return `The daemon answered HTTP ${String(status)}`;
  const { message, issues, error } = parsed.data;
  if (message) return message;
  if (issues && issues.length > 0) return refusalText(issues);
  return error ?? `The daemon answered HTTP ${String(status)}`;
}

/** Parses a daemon response with its contract schema; throws `DaemonRequestError` on non-2xx. */
export async function readJson<S extends z.ZodType>(
  res: Pick<Response, 'ok' | 'status' | 'json'>,
  schema: S,
): Promise<z.output<S>> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new DaemonRequestError(res.status, body, errorMessage(res.status, body));
  return schema.parse(body);
}

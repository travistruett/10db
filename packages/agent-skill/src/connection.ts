import { join } from 'node:path';
import { z } from 'zod';
import { SKILL_VERSION_HEADER } from '@10db/contracts';
import { TendbError } from './errors';

export interface Connection {
  base: string;
  token: string;
}

export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The app's data directory on macOS, where its daemon writes `daemon.json` and `ui-token`. */
export const MACOS_APP_DIR_SEGMENTS = ['Library', 'Application Support', '10db'] as const;

export const appDirIn = (home: string): string => join(home, ...MACOS_APP_DIR_SEGMENTS);

const DaemonFile = z.object({ port: z.int() });
// The header value must survive HTTP: no whitespace or control characters anywhere.
const Token = z
  .string()
  .trim()
  .regex(/^[^\s\p{Cc}]+$/u);

/** Where the running app listens and the token it takes, read from its data directory. */
export function connectionFrom(appDir: string, readFile: (path: string) => string): Connection {
  let raw: unknown;
  let tokenText: string;
  try {
    raw = JSON.parse(readFile(join(appDir, 'daemon.json')));
    tokenText = readFile(join(appDir, 'ui-token'));
  } catch {
    throw new TendbError(
      `10db isn't running: no daemon.json or ui-token in ${appDir}. Open the 10db app.`,
    );
  }
  const token = Token.safeParse(tokenText);
  if (!token.success) {
    throw new TendbError(`10db isn't running: no usable ui-token in ${appDir}. Open the 10db app.`);
  }
  const file = DaemonFile.safeParse(raw);
  if (!file.success) throw new TendbError('daemon.json has no port. Restart the 10db app.');
  return { base: `http://127.0.0.1:${String(file.data.port)}`, token: token.data };
}

const SkillVersionRefusal = z.object({ error: z.literal('skill_version'), message: z.string() });

/**
 * The API over HTTP. The token goes only in the Authorization header. A refusal because the skill is not
 * the version the app ships carries its own message, which is shown as it is.
 */
export function httpApi(
  conn: Connection,
  skillVersion: string | null,
  fetchImpl: typeof fetch = fetch,
): Api {
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await fetchImpl(conn.base + path, {
        method,
        headers: {
          authorization: `Bearer ${conn.token}`,
          ...(skillVersion === null ? {} : { [SKILL_VERSION_HEADER]: skillVersion }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TendbError(
        `Couldn't reach 10db at ${conn.base}. Is the app open? daemon.json may be stale. ` +
          'In Codex, the sandbox may block localhost: allow network access for this session.',
      );
    }
    const text = await res.text();
    if (res.status === 401) {
      throw new TendbError('10db refused the token (401). Restart the app or rerun.', 401);
    }
    if (res.status === 409) {
      const refusal = SkillVersionRefusal.safeParse(parseJson(text));
      if (refusal.success) throw new TendbError(refusal.data.message, 409);
    }
    if (!res.ok) {
      throw new TendbError(
        `${method} ${path} failed with ${String(res.status)}: ${text}`,
        res.status,
      );
    }
    if (text === '') return null;
    const parsed = parseJson(text);
    if (parsed === undefined) {
      throw new TendbError(
        `${method} ${path} answered something that isn't JSON: ${text.slice(0, 200)}`,
      );
    }
    return parsed;
  };
}

/** The JSON in `text`, or undefined when it isn't. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

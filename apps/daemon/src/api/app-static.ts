import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/** The page every address without a file of its own gets: the served app routes by itself. */
const APP_PAGE = 'app.html';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * What the served app may load. No inline script: the page's one script and the worker are files of its own.
 * Mantine writes inline styles, as in the window. The stream is a secure WebSocket to the host that served the
 * page, named by the request's own Host, which the share listener's host guard has already checked.
 */
export function appContentSecurityPolicy(host: string | undefined): string {
  const socket = host === undefined ? '' : ` wss://${host}`;
  return [
    "default-src 'self'",
    `connect-src 'self'${socket}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The file under `dir` that a `/app/...` path names, never one outside it; null when it names none. */
function fileUnder(dir: string, appPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(appPath);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  if (relative.split(sep).includes('..') || relative.includes('\0')) return null;
  return join(dir, relative);
}

async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Serves the built served app (`dist-app/`) for `GET /app/*`: a file the build made, else the app's page for
 * an address the app routes itself (an address with a file extension that is not there is a 404). Hashed files
 * are cached for good; the page and the worker are always asked for again, so a new build reaches the phone.
 * With no build on disk it answers 404.
 */
export function serveApp(dir: string | null): MiddlewareHandler {
  return async (c) => {
    const notFound = () => c.json({ error: 'not_found' }, 404);
    if (dir === null) return notFound();
    const appPath = c.req.path.replace(/^\/app\/?/, '');
    const wanted = appPath === '' ? null : fileUnder(dir, appPath);
    if (appPath !== '' && wanted === null) return notFound();
    const found = wanted === null ? null : await readFileIfPresent(wanted);
    const isPage = found === null;
    if (isPage && extname(appPath) !== '') return notFound();
    const body = found ?? (await readFileIfPresent(join(dir, APP_PAGE)));
    if (body === null) return notFound();
    const type = isPage
      ? 'text/html; charset=utf-8'
      : (MEDIA_TYPES[extname(appPath)] ?? 'application/octet-stream');
    const hashed = !isPage && appPath.startsWith('assets/');
    return c.body(new Uint8Array(body), 200, {
      'content-type': type,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-security-policy': appContentSecurityPolicy(c.req.header('host')),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(appPath === 'sw.js' ? { 'service-worker-allowed': '/app/' } : {}),
    });
  };
}

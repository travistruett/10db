import { execFile } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppUrl } from '@10db/contracts';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { tempDir, waitForAsync, type TempDir } from '../../test/fixtures';
import { systemClock } from '../clock';
import { loadEnv } from '../env';
import { downloadFile, ensurePinned, extractZipWithTar } from '../environment';
import { defaultDataDir } from '../runtime-files';
import type { Logger } from '../log';
import { createLedgerSweep, systemProcessTable, type LedgerSweep } from '../sandbox';
import { BROWSER_PIN } from './browser-pin';
import { createBrowserHost, type BrowserHost } from './browser-host';
import { ShotOutcome, type PageCamera } from './camera';
import { launchChromium } from './playwright';
import { createPlaywrightCamera } from './playwright-camera';

// What only the real headless shell can prove (plan A4): that it sends loopback through the daemon's
// proxy under `<-loopback>`, WebSockets by CONNECT; that a redirect of a document or a subresource to
// another loopback port never reaches it; that no UDP goes around the proxy; that its renderer runs
// sandboxed; that its temp profile keeps no cookie of the app; and that the overlays are recognised.

const live = loadEnv(process.env).TENDB_LIVE_BROWSER === '1';
const run = promisify(execFile);

const SPELLINGS = ['localhost', '127.0.0.1', '[::1]'] as const;
/** The dev login's session cookie: a value unique enough to find in any file the browser writes. */
const COOKIE_MARKER = 'dev-session-5f0c2a9e7b1d4c3a';
const VIEWPORT = { width: 800, height: 600 };

/** A logger that keeps every line it is given. */
function recordingLogger(lines: string[]): Logger {
  const write =
    (level: string) =>
    (obj: object, msg?: string): void => {
      lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`);
    };
  const logger: Logger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
  };
  return logger;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no port'));
      else resolve(address.port);
    });
  });
}

/** The "daemon": another loopback port, on IPv4 and IPv6, that counts every connection made to it. */
async function countingDaemon(): Promise<{ port: number; hits: string[]; close(): void }> {
  const hits: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''}`);
    res.end('daemon');
  };
  const v4 = createServer(handler);
  const v6 = createServer(handler);
  for (const server of [v4, v6]) {
    server.on('connection', () => {
      hits.push('connection');
    });
  }
  // The same port on both loopbacks, so every spelling of loopback reaches it.
  for (let attempt = 0; ; attempt += 1) {
    const port = await listen(v4, '127.0.0.1', 0);
    try {
      await listen(v6, '::1', port);
      return {
        port,
        hits,
        close: () => {
          v4.close();
          v6.close();
        },
      };
    } catch (error) {
      v4.close();
      if (attempt > 5) throw error;
    }
  }
}

function page(body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}<style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`;
}

/** The app: pages for each outcome, and redirects to the daemon's port. */
function appHandler(daemonPort: number, udpPort: number) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://app.invalid');
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const toDaemon = (spelling: string, path: string): void => {
      res.writeHead(302, { location: `http://${spelling}:${String(daemonPort)}${path}` });
      res.end();
    };
    const [, first = '', second = ''] = url.pathname.split('/');
    switch (first) {
      case 'clean':
        html(page('<h1>People</h1><p>Ada, Grace, Barbara</p>'));
        return;
      case 'next-overlay':
        html(
          page(
            '<h1>People</h1>',
            `<script>addEventListener('DOMContentLoaded', () => {
              const portal = document.createElement('nextjs-portal');
              document.body.append(portal);
              portal.attachShadow({ mode: 'open' }).innerHTML =
                '<div data-nextjs-dialog role="dialog">Build Error<br>Module not found: Can\\'t resolve ./missing</div>';
            });</script>`,
          ),
        );
        return;
      case 'next-badge':
        html(
          page(
            '<h1>People</h1>',
            `<script>addEventListener('DOMContentLoaded', () => {
              const portal = document.createElement('nextjs-portal');
              document.body.append(portal);
              portal.attachShadow({ mode: 'open' }).innerHTML = '<div data-nextjs-toast>1 Issue</div>';
            });</script>`,
          ),
        );
        return;
      case 'vite-overlay':
        html(
          page(
            '<h1>People</h1>',
            `<script>addEventListener('DOMContentLoaded', () => {
              const overlay = document.createElement('vite-error-overlay');
              document.body.append(overlay);
              overlay.attachShadow({ mode: 'open' }).innerHTML =
                '<div class="backdrop"><div class="window"><pre class="message">[plugin:vite:import-analysis] Failed to resolve import "./missing"</pre></div></div>';
            });</script>`,
          ),
        );
        return;
      case 'loop':
        html(
          page(
            '<h1>Busy</h1>',
            "<script>addEventListener('load', () => { setTimeout(() => { for (;;) {} }, 50); });</script>",
          ),
        );
        return;
      case 'boom':
        html(page('<h1>Internal Server Error</h1>'), 500);
        return;
      case 'moved':
        res.writeHead(302, { location: '/clean' });
        res.end();
        return;
      case 'away':
        toDaemon(decodeURIComponent(second), '/stolen-document');
        return;
      case 'hop':
        // /hop/<spelling>/<kind>: a subresource redirected to the daemon's port.
        toDaemon(decodeURIComponent(second), `/stolen-${url.pathname.split('/')[3] ?? ''}`);
        return;
      case 'reach': {
        const spelling = decodeURIComponent(second);
        const daemon = `${spelling}:${String(daemonPort)}`;
        const hop = `/hop/${encodeURIComponent(spelling)}`;
        html(
          page(
            `<h1>Reach</h1>
            <img src="${hop}/img"><script src="${hop}/script"></script>
            <img src="http://${daemon}/direct-img">
            <img src="/slow">`,
            `<script>
              fetch('${hop}/fetch').catch(() => {});
              fetch('http://${daemon}/direct-fetch').catch(() => {});
              try { new WebSocket('ws://${daemon}/direct-ws'); } catch {}
            </script>`,
          ),
        );
        return;
      }
      case 'ws-ok':
        html(
          page(
            '<h1>Socket</h1><img src="/slow">',
            `<script>new WebSocket('ws://' + location.host + '/sock');</script>`,
          ),
        );
        return;
      case 'webrtc':
        html(
          page(
            '<h1>RTC</h1><img src="/slow">',
            `<script>
              const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${String(udpPort)}' }] });
              pc.createDataChannel('x');
              pc.createOffer().then((offer) => pc.setLocalDescription(offer));
            </script>`,
          ),
        );
        return;
      case 'slow':
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'image/gif' });
          res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
        }, 2_000);
        return;
      case 'login':
        res.writeHead(302, {
          location: '/whoami',
          'set-cookie': `session=${COOKIE_MARKER}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
        });
        res.end();
        return;
      case 'login-download':
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="session.bin"',
        });
        res.end('not a page');
        return;
      case 'login-away':
        toDaemon('localhost', '/stolen-login');
        return;
      case 'whoami':
        if ((req.headers.cookie ?? '').includes(`session=${COOKIE_MARKER}`)) {
          html(page('<h1>Signed in</h1>'));
        } else {
          res.writeHead(302, { location: '/signin' });
          res.end();
        }
        return;
      case 'signin':
        html(page('<h1>Sign in</h1>'));
        return;
      default:
        html(page('<h1>Not found</h1>'), 404);
    }
  };
}

/** Every process running `exe`, with its arguments. */
async function browserProcesses(exe: string): Promise<{ pid: number; args: string }[]> {
  const { stdout } = await run('/bin/ps', ['-axww', '-o', 'pid=,args='], {
    env: { LC_ALL: 'C' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), args: m[2] ?? '' }))
    .filter((p) => p.args.startsWith(exe));
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const path = join(dir, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...filesUnder(path));
    else if (info.isFile()) found.push(path);
  }
  return found;
}

describe.skipIf(!live)('the pinned browser, live', () => {
  let dir: TempDir;
  let exe: string;
  let sweep: LedgerSweep;
  let camera: PageCamera;
  let host: BrowserHost<Browser>;
  let daemon: Awaited<ReturnType<typeof countingDaemon>>;
  let app: Server;
  let appUrl: AppUrl;
  let udp: UdpSocket;
  let udpPackets: number;
  let wsOpened: number;
  const logs: string[] = [];

  beforeAll(async () => {
    // The pinned build, fetched into the live tests' own folder and checked against BROWSER_PIN.
    // The live tests' own tools folder, beside the app's, as the agents' live tests use: a newer pin
    // tested here never touches the copy the running app runs.
    exe = await ensurePinned(join(defaultDataDir(), 'live-tests'), BROWSER_PIN, {
      download: downloadFile,
      extract: extractZipWithTar,
    });
    dir = tempDir('browser-live');
    const ledgerRoot = join(dir.path, 'files');
    mkdirSync(ledgerRoot);
    sweep = createLedgerSweep(ledgerRoot, { table: systemProcessTable });
    const logger = recordingLogger(logs);
    host = createBrowserHost({
      dataDir: join(dir.path, 'data'),
      ledgers: { sweep, root: ledgerRoot },
      processes: { table: systemProcessTable },
      clock: systemClock,
      logger,
      launch: launchChromium,
      ensure: () => Promise.resolve(exe),
    });
    camera = createPlaywrightCamera(host, logger);
    daemon = await countingDaemon();
    udpPackets = 0;
    udp = createSocket('udp4');
    udp.on('message', () => {
      udpPackets += 1;
    });
    await new Promise<void>((resolve) => {
      udp.bind(0, '127.0.0.1', resolve);
    });
    app = createServer(appHandler(daemon.port, udp.address().port));
    wsOpened = 0;
    const sockets = new WebSocketServer({ noServer: true });
    app.on('upgrade', (req, socket, head) => {
      sockets.handleUpgrade(req, socket, head, (ws) => {
        wsOpened += 1;
        ws.send('hi');
      });
    });
    appUrl = `http://127.0.0.1:${String(await listen(app, '127.0.0.1', 0))}`;
  }, 15 * 60_000);

  afterAll(async () => {
    await camera.close();
    sweep.stop();
    daemon.close();
    app.close();
    udp.close();
    dir.cleanup();
  });

  const shoot = (
    route: string,
    storageState: Parameters<PageCamera['shoot']>[0]['storageState'] = null,
  ) =>
    camera.shoot({
      appUrl,
      route,
      viewport: VIEWPORT,
      theme: 'default',
      storageState,
      devUi: null,
      signal: new AbortController().signal,
    });

  it('shoots a clean page, the same bytes twice', async () => {
    const first = await shoot('/clean');
    const second = await shoot('/clean');
    expect(first.outcome).toBe(ShotOutcome.Clean);
    expect(first.png?.length).toBeGreaterThan(1000);
    expect(
      Buffer.from(first.png ?? [])
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(Buffer.from(second.png ?? []).equals(Buffer.from(first.png ?? []))).toBe(true);
  }, 120_000);

  it.each([
    ['Next’s error dialog', '/next-overlay', ShotOutcome.Overlay, /Module not found/],
    ['Vite’s error overlay', '/vite-overlay', ShotOutcome.Overlay, /Failed to resolve import/],
  ])(
    'recognises %s, with its text',
    async (_name, route, outcome, text) => {
      const shot = await shoot(route);
      expect(shot.outcome).toBe(outcome);
      expect(shot.overlayText).toMatch(text);
      expect(shot.png).not.toBeNull();
    },
    60_000,
  );

  it('takes Next’s issue badge alone for a clean page', async () => {
    expect((await shoot('/next-badge')).outcome).toBe(ShotOutcome.Clean);
  }, 60_000);

  it('calls a document that answered 500 failed', async () => {
    const shot = await shoot('/boom');
    expect(shot).toMatchObject({
      outcome: ShotOutcome.Failed,
      png: null,
      reason: 'the page answered 500',
    });
  }, 60_000);

  it('calls a same-origin redirect elsewhere', async () => {
    expect((await shoot('/moved')).outcome).toBe(ShotOutcome.Elsewhere);
  }, 60_000);

  it.each(SPELLINGS)(
    'calls a document redirected to another port by %s failed, and that port sees nothing',
    async (spelling) => {
      const shot = await shoot(`/away/${encodeURIComponent(spelling)}`);
      expect(shot.outcome).toBe(ShotOutcome.Failed);
      expect(shot.reason).toMatch(/^left the app's address for http:\/\//);
      expect(daemon.hits).toEqual([]);
      // The hop reached the proxy, which refused it: loopback goes through the proxy.
      expect(
        logs.some((l) => l.includes(`${spelling}:${String(daemon.port)}/stolen-document`)),
      ).toBe(true);
    },
    60_000,
  );

  it.each(SPELLINGS)(
    'never lets an image, script, fetch or WebSocket reach another port by %s, redirected or not',
    async (spelling) => {
      const shot = await shoot(`/reach/${encodeURIComponent(spelling)}`);
      expect(shot.outcome).toBe(ShotOutcome.Clean);
      expect(daemon.hits).toEqual([]);
      for (const kind of ['img', 'script', 'fetch']) {
        expect(
          logs.some((l) => l.includes(`${spelling}:${String(daemon.port)}/stolen-${kind}`)),
        ).toBe(true);
      }
    },
    60_000,
  );

  it('tunnels the app’s own WebSocket through the proxy', async () => {
    const before = wsOpened;
    expect((await shoot('/ws-ok')).outcome).toBe(ShotOutcome.Clean);
    expect(wsOpened).toBeGreaterThan(before);
    // By CONNECT: the proxy refuses an upgrade sent any other way.
    const appAuthority = new URL(appUrl).host;
    expect(logs.some((l) => l.includes('opened a tunnel') && l.includes(appAuthority))).toBe(true);
  }, 60_000);

  it('sends no UDP around the proxy', async () => {
    expect((await shoot('/webrtc')).outcome).toBe(ShotOutcome.Clean);
    expect(udpPackets).toBe(0);
  }, 60_000);

  it('refuses a sign-in that redirects to another port, which sees nothing', async () => {
    await expect(
      camera.signIn({ appUrl, url: '/login-away', signal: new AbortController().signal }),
    ).rejects.toThrow(/left the app's address/);
    expect(daemon.hits).toEqual([]);
  }, 60_000);

  it('runs its renderer sandboxed', async () => {
    // A renderer lives only while a page is open: this one loads an image that takes 2 s.
    const pending = shoot('/ws-ok');
    const renderers = await waitForAsync(async () => {
      const found = (await browserProcesses(exe)).filter((p) => p.args.includes('--type=renderer'));
      return found.length > 0 ? found : undefined;
    }, 10_000);
    const all = await browserProcesses(exe);
    expect((await pending).outcome).toBe(ShotOutcome.Clean);
    // Playwright asked for no --no-sandbox, and Chromium hands each sandboxed child its seatbelt.
    expect(all.filter((p) => p.args.includes('--no-sandbox'))).toEqual([]);
    expect(renderers.filter((p) => !p.args.includes('--seatbelt-client='))).toEqual([]);
  }, 60_000);

  it('settles a shot and a sign-in of a page that never stops running, and shoots again after', async () => {
    const hasty = createPlaywrightCamera(host, recordingLogger(logs), { deadlineMs: 8_000 });
    const started = Date.now();
    const shot = await hasty.shoot({
      appUrl,
      route: '/loop',
      viewport: VIEWPORT,
      theme: 'default',
      storageState: null,
      devUi: null,
      signal: new AbortController().signal,
    });
    expect(shot).toMatchObject({ outcome: ShotOutcome.Failed, png: null });
    expect(shot.reason).toMatch(/did not settle/);
    await expect(
      hasty.signIn({ appUrl, url: '/loop', signal: new AbortController().signal }),
    ).rejects.toThrow(/did not settle/);
    expect(Date.now() - started).toBeLessThan(40_000);
    expect((await shoot('/clean')).outcome).toBe(ShotOutcome.Clean);
  }, 90_000);

  it('stops a shot aborted at any moment, long before its page would have loaded', async () => {
    // Launched already: a launch under way runs to its end.
    await shoot('/clean');
    for (const delay of [0, 2, 5, 10, 20, 40]) {
      const controller = new AbortController();
      const started = Date.now();
      const shot = camera.shoot({
        appUrl,
        route: '/ws-ok',
        viewport: VIEWPORT,
        theme: 'default',
        storageState: null,
        devUi: null,
        signal: controller.signal,
      });
      setTimeout(() => {
        controller.abort();
      }, delay);
      await expect(shot).rejects.toThrow(/abort/i);
      // The page holds its load for 2 s; an abort that went unseen would wait it out.
      expect(Date.now() - started).toBeLessThan(1_500);
    }
    const aborted = new AbortController();
    aborted.abort();
    await expect(camera.signIn({ appUrl, url: '/login', signal: aborted.signal })).rejects.toThrow(
      /abort/i,
    );
  }, 60_000);

  it("lets 10db's own dev UI read the daemon with the token it is handed, and write nothing", async () => {
    // The "daemon" answers a read only with the token, as the dev UI's token is held; the "dev UI" draws
    // what the fragment hands it, as 10db's own does: a read, then a write the proxy must refuse.
    const hits: string[] = [];
    let devUiOrigin = '';
    let daemonUrl = '';
    const daemon = createServer((req, res) => {
      hits.push(`${req.method ?? ''} ${req.url ?? ''} ${req.headers.authorization ?? '-'}`);
      res.setHeader('access-control-allow-origin', devUiOrigin);
      res.setHeader('access-control-allow-headers', 'authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.end(req.headers.authorization === 'Bearer dev-ui-token' ? 'projects' : 'no');
    });
    const devUi = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        page(
          '<h1 id="out">Connecting</h1>',
          `<script>
            // Handed nothing, it tries the daemon anyway, which the browser must refuse.
            const handed = location.hash.startsWith('#tendb=')
              ? JSON.parse(decodeURIComponent(location.hash.slice('#tendb='.length)))
              : { url: '${daemonUrl}', token: 'guessed' };
            const auth = { authorization: 'Bearer ' + handed.token };
            fetch(handed.url + '/projects', { headers: auth })
              .then((r) => r.text())
              .then((t) => { document.getElementById('out').textContent = t; });
            fetch(handed.url + '/passes', { method: 'POST', headers: auth }).catch(() => undefined);
          </script>`,
        ),
      );
    });
    const daemonPort = await listen(daemon, '127.0.0.1', 0);
    const devUiPort = await listen(devUi, '127.0.0.1', 0);
    devUiOrigin = `http://127.0.0.1:${String(devUiPort)}`;
    daemonUrl = `http://127.0.0.1:${String(daemonPort)}`;
    const shootDevUi = (handed: boolean) =>
      camera.shoot({
        appUrl: devUiOrigin,
        route: '/settings',
        viewport: VIEWPORT,
        theme: 'default',
        storageState: null,
        devUi: handed ? { url: daemonUrl, token: 'dev-ui-token' } : null,
        signal: new AbortController().signal,
      });
    try {
      expect((await shootDevUi(true)).outcome).toBe(ShotOutcome.Clean);
      expect(hits).toContain('GET /projects Bearer dev-ui-token');
      expect(hits.filter((hit) => !hit.startsWith('GET ') && !hit.startsWith('OPTIONS '))).toEqual(
        [],
      );
      // Any other app is shot as before: the daemon sees nothing of it.
      hits.length = 0;
      await shootDevUi(false);
      expect(hits).toEqual([]);
    } finally {
      daemon.close();
      devUi.close();
    }
  }, 60_000);

  it('says the app did not answer, for a shot and for a sign-in', async () => {
    const closed = createServer();
    const port = await listen(closed, '127.0.0.1', 0);
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve();
      });
    });
    const gone = `http://127.0.0.1:${String(port)}`;
    const shot = await camera.shoot({
      appUrl: gone,
      route: '/clean',
      viewport: VIEWPORT,
      theme: 'default',
      storageState: null,
      devUi: null,
      signal: new AbortController().signal,
    });
    expect(shot).toMatchObject({ outcome: ShotOutcome.NoAnswer, reason: 'the app did not answer' });
    await expect(
      camera.signIn({ appUrl: gone, url: '/login', signal: new AbortController().signal }),
    ).rejects.toThrow('the app did not answer');
  }, 60_000);

  it('names a failed sign-in without its token, in the error and in the log', async () => {
    const marker = 'MARKER-IN-QUERY';
    const failure = await camera
      .signIn({
        appUrl,
        url: `/login-download?token=${marker}`,
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/the dev login's address did not load/);
    expect(String(failure)).not.toContain(marker);
    expect(logs.filter((l) => l.includes(marker))).toEqual([]);
  }, 60_000);

  it('signs in, shoots signed in, and keeps the session out of its profile on disk', async () => {
    const state = await camera.signIn({
      appUrl,
      url: `${appUrl}/login`,
      signal: new AbortController().signal,
    });
    expect(state.cookies.find((c) => c.name === 'session')?.value).toBe(COOKIE_MARKER);
    // Signed out, the app sends the page to its sign-in; signed in, it shows it.
    expect((await shoot('/whoami')).outcome).toBe(ShotOutcome.Elsewhere);
    const shot = await shoot('/whoami', state);
    expect(shot.outcome).toBe(ShotOutcome.Clean);
    const processes = await browserProcesses(exe);
    // The launch's temp profile holds no cookie of the app: every shot is a fresh in-memory context.
    const profiles = new Set(
      processes.flatMap((p) => /--user-data-dir=(\S+)/.exec(p.args)?.[1] ?? []),
    );
    expect(profiles.size).toBe(1);
    const files = [...profiles].flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => readFileSync(f).includes(COOKIE_MARKER))).toEqual([]);
  }, 60_000);

  it('leaves no browser process once closed', async () => {
    await shoot('/clean');
    expect((await browserProcesses(exe)).length).toBeGreaterThan(0);
    await camera.close();
    expect(await browserProcesses(exe)).toEqual([]);
  }, 60_000);
});

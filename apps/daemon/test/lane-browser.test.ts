import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mintId, type BrowserAnswer } from '@10db/contracts';
import { createEventBus, createStateStore } from '../src/events';
import { createBrowserLaunches } from '../src/pictures';
import { systemClock } from '../src/clock';
import {
  createLaneBrowsers,
  type LaneBrowsers,
  type LaneBrowserSession,
  type PortReaders,
} from '../src/lane-browser';
import { browserTools } from '../src/mcp/browser-tools';
import { createLedgerSweep, systemProcessTable } from '../src/sandbox';
import { silentLogger } from '../src/log';
import { createTestStore } from '@10db/db';

const STARTED = 'Thu Oct 30 12:00:00 2026';
const LANE_PID = 4000;
const OTHER_PID = 9000;

interface Counted {
  readonly server: Server;
  readonly port: number;
  readonly requests: string[];
}

async function serve(): Promise<Counted> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

let root: string;
let a: Counted;
let b: Counted;
let browsers: LaneBrowsers;
let closeStore: () => void;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-lane-browser-')));
  a = await serve();
  b = await serve();
});

afterEach(async () => {
  await browsers.close();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const s of [a, b]) await new Promise((resolve) => s.server.close(resolve));
  closeStore();
  rmSync(root, { recursive: true, force: true });
});

it('a lane browser reaches the server its lane started and is refused one that is not its own', async () => {
  const ledgerRoot = join(root, 'ledgers');
  mkdirSync(ledgerRoot);
  const exe = realpathSync(process.execPath);
  const processes = { table: systemProcessTable, ownPid: process.pid };
  const readers: PortReaders = {
    listeners: (port) =>
      Promise.resolve([{ pid: port === a.port ? LANE_PID : OTHER_PID, address: '127.0.0.1' }]),
    acceptors: (_address, port) => Promise.resolve([port === a.port ? LANE_PID : OTHER_PID]),
    // The lane's own process (its claude) and a stranger's: only the first is in the session's ledger.
    table: () =>
      Promise.resolve([
        { pid: 1, ppid: 0, pgid: 1, startedAt: STARTED },
        { pid: LANE_PID, ppid: 1, pgid: LANE_PID, startedAt: STARTED },
        { pid: OTHER_PID, ppid: 1, pgid: OTHER_PID, startedAt: STARTED },
      ]),
    compose: null,
  };
  const sweep = createLedgerSweep(ledgerRoot, { ...processes, intervalMs: 3_600_000 });
  browsers = createLaneBrowsers({
    dataDir: root,
    ledgers: { sweep, root: ledgerRoot },
    processes,
    launches: createBrowserLaunches(),
    build: { ready: () => Promise.resolve(exe), fetching: () => false },
    // A browser that is a real child process of the daemon, whose page loads go through the proxy it is
    // launched with, in the absolute form a browser sends, as the real one does.
    launch: (options) => {
      const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(child);
      const proxy = /--proxy-server=http:\/\/127\.0\.0\.1:(\d+)/.exec(options.args.join(' '))?.[1];
      const answer = (status: number | null, refused: string[]): BrowserAnswer => ({
        page: { url: 'about:blank', title: '', status },
        pages: [],
        snapshot: null,
        snapshotCut: false,
        refused,
        dialogs: [],
        notes: [],
      });
      const driver = {
        open: (url: string) =>
          new Promise<BrowserAnswer>((resolve, reject) => {
            const req = request(
              {
                host: '127.0.0.1',
                port: Number(proxy),
                method: 'GET',
                path: url,
                headers: { host: new URL(url).host },
              },
              (res) => {
                res.resume();
                resolve(answer(res.statusCode ?? null, []));
              },
            );
            req.on('error', reject);
            req.end();
          }),
        snapshot: () => Promise.resolve(answer(200, [])),
        act: () => Promise.resolve(answer(200, [])),
        upload: () => Promise.resolve(answer(200, [])),
        screenshot: () => Promise.reject(new Error('no screenshot in this test')),
        isConnected: () => !child.killed,
        close: () => {
          child.kill('SIGKILL');
          return Promise.resolve();
        },
      };
      return Promise.resolve(driver);
    },
    readers,
    daemonPort: () => null,
    clock: systemClock,
    logger: silentLogger,
  });

  const { store, close } = createTestStore(() => new Date());
  closeStore = close;
  const session: LaneBrowserSession = {
    sessionId: mintId('Session'),
    projectId: mintId('Project'),
    taskId: mintId('Task'),
    workstreamId: mintId('Workstream'),
    copy: root,
    tempDir: root,
    fileAccess: {
      checkout: root,
      home: root,
      protectedReads: [],
      readList: [],
      configDir: root,
      providerSessionId: null,
      sandboxTemp: { roots: [root], own: root },
    },
    registeredCheckouts: [],
    loopback: true,
    docker: false,
    members: () => [{ pid: LANE_PID, startedAt: STARTED, pgid: LANE_PID }],
  };
  const tools = browserTools({
    state: createStateStore(store, createEventBus()),
    dataDir: root,
    laneBrowser: { browsers, sessionOf: () => session },
    pictures: undefined,
    sessionId: session.sessionId,
    signal: undefined,
  });
  const open = tools.find((tool) => tool.name === 'browser_open');
  if (open === undefined) throw new Error('browser_open is not offered');

  const own = await open.run({ url: `http://127.0.0.1:${String(a.port)}/` });
  expect(own).toMatchObject({ page: { status: 200 } });
  expect(a.requests).toEqual(['/']);

  const other = await open.run({ url: `http://127.0.0.1:${String(b.port)}/` });
  expect(other).toMatchObject({ page: { status: 403 } });
  expect(b.requests).toEqual([]);
});

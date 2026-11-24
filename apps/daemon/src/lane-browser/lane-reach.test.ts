import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, systemClock } from '../clock';
import { systemProcessTable, type ProcessMember } from '../sandbox';
import {
  laneProxyTarget,
  laneUrlTarget,
  portVerdict,
  type PortJudgement,
  type PortReadings,
  type PortSession,
} from './lane-reach';
import { createPortOwner, systemPortReaders, type PortReaders } from './port-owner';
import type { LaneBrowserSession } from './session';

const port = (p: number) => ({ kind: 'port', port: p });
const refused = { kind: 'refused' };

describe('laneUrlTarget', () => {
  it.each<[string, string, object]>([
    ['http', 'http://localhost:3000/', port(3000)],
    ['https default port', 'https://localhost/', port(443)],
    ['http default port', 'http://127.0.0.1/x', port(80)],
    ['ipv6 loopback', 'http://[::1]:8080/', port(8080)],
    // `URL` lowers the host, so the uppercase spelling is the same name.
    ['uppercase localhost', 'http://LOCALHOST:3000/', port(3000)],
    ['file', 'file:///etc/passwd', refused],
    ['view-source', 'view-source:http://localhost:3000/', refused],
    ['chrome', 'chrome://settings', refused],
    ['filesystem', 'filesystem:http://localhost:3000/x', refused],
    ['javascript', 'javascript:alert(1)', refused],
    ['data', 'data:text/html,hi', refused],
    ['blob', 'blob:http://localhost:3000/x', refused],
    ['0.0.0.0', 'http://0.0.0.0:3000/', refused],
    ['127.0.0.2', 'http://127.0.0.2:3000/', refused],
    ['mapped ipv4', 'http://[::ffff:127.0.0.1]:3000/', refused],
    ['a localhost subdomain', 'http://app.localhost:3000/', refused],
    ['a decimal address', 'http://2130706433:3000/', refused],
    ['a hex address', 'http://0x7f.1:3000/', refused],
    ['a name', 'http://example.com/', refused],
    ['userinfo', 'http://user:pw@localhost:3000/', refused],
    ['port 0', 'http://localhost:0/', refused],
    ['not an address', 'localhost:3000', refused],
  ])('%s', (_name, raw, expected) => {
    expect(laneUrlTarget(raw)).toMatchObject(expected);
  });
});

describe('laneProxyTarget', () => {
  it.each<[string, string, string, object]>([
    ['CONNECT with a port', 'CONNECT', 'localhost:3000', port(3000)],
    ['CONNECT port 80 as written', 'CONNECT', '127.0.0.1:80', port(80)],
    ['CONNECT ipv6', 'CONNECT', '[::1]:5173', port(5173)],
    ['CONNECT without a port', 'CONNECT', 'localhost', refused],
    ['CONNECT to a name', 'CONNECT', 'example.com:443', refused],
    ['CONNECT with userinfo', 'CONNECT', 'a@localhost:3000', refused],
    ['absolute http', 'GET', 'http://localhost:3000/a?b=1', port(3000)],
    ['absolute http with userinfo', 'GET', 'http://u@localhost:3000/', refused],
    ['origin-form', 'GET', '/a', refused],
    ['absolute https', 'GET', 'https://localhost:3000/', refused],
  ])('%s', (_name, method, target, expected) => {
    expect(laneProxyTarget({ method, target })).toMatchObject(expected);
  });
});

const session = (over: Partial<PortSession> = {}): PortSession => ({
  members: new Set(['100:t0']),
  browserPids: new Set([900]),
  copy: '/work/copy',
  tempDir: '/work/tmp',
  registeredCheckouts: ['/home/me/app'],
  loopback: true,
  ...over,
});
const chain = (...pids: [number, string][]) => pids.map(([pid, startedAt]) => ({ pid, startedAt }));
const mine = chain([200, 't1'], [100, 't0'], [1, 'x']);
const others = chain([300, 't2'], [250, 't9'], [1, 'x']);
type Readings = Omit<PortReadings, 'acceptors'> & { acceptors?: PortReadings['acceptors'] };
// Unless a row says otherwise, the acceptor is the process lsof showed listening.
const judge = (given: Readings, s: PortSession = session(), p = 3000): PortJudgement => {
  const readings: PortReadings = {
    ...given,
    acceptors:
      given.acceptors ??
      (given.listeners === 'unread' ? [] : given.listeners.map((l) => ({ chain: l.chain }))),
  };
  return portVerdict({
    port: p,
    daemonPort: 7433,
    proxyPorts: new Set([4444]),
    session: s,
    readings,
  });
};
const owned = (connectTo: string) => ({ kind: 'owned', connectTo });
const dir = (workingDir: string | null, hostIp: string) => ({ workingDir, hostIp });

describe('portVerdict: fixed refusals', () => {
  it('refuses the daemon and a proxy before reading', () => {
    expect(judge({ listeners: 'unread', compose: null }, session(), 7433)).toMatchObject(refused);
    expect(judge({ listeners: 'unread', compose: null }, session(), 4444)).toMatchObject({
      kind: 'refused',
      why: "4444 is a lane browser's proxy",
    });
  });
  it('says which reading failed or that nothing listens', () => {
    expect(judge({ listeners: 'unread', compose: null })).toMatchObject({
      why: 'the listeners on 3000 could not be read',
    });
    expect(judge({ listeners: [], compose: null })).toMatchObject({
      why: 'nothing listens on 3000',
    });
  });
});

describe('portVerdict: the ledger rule', () => {
  const listener = (address: string, c = mine) => ({ address, chain: c });
  it.each<[string, Readings, Partial<PortSession>, object]>([
    [
      'a chain reaching a member',
      { listeners: [listener('127.0.0.1')], compose: null },
      {},
      owned('127.0.0.1'),
    ],
    [
      'another session only',
      { listeners: [listener('127.0.0.1', others)], compose: null },
      {},
      refused,
    ],
    [
      'a browser pid in the chain',
      { listeners: [listener('127.0.0.1', chain([900, 'b'], [100, 't0']))], compose: null },
      {},
      refused,
    ],
    [
      'loopback off',
      { listeners: [listener('127.0.0.1')], compose: null },
      { loopback: false },
      refused,
    ],
    [
      'a pid reused with another start time',
      { listeners: [listener('127.0.0.1', chain([100, 'later']))], compose: null },
      {},
      refused,
    ],
    [
      'a member listener beside a non-member one',
      { listeners: [listener('127.0.0.1'), listener('*', others)], compose: null },
      {},
      { kind: 'refused', why: "3000 is shared with a server that isn't this lane's" },
    ],
    [
      'a wildcard lane listener beside an unseen 127.0.0.1 that accepts first',
      {
        listeners: [listener('*')],
        acceptors: [{ chain: chain([5, 'r'], [1, 'x']) }],
        compose: null,
      },
      {},
      { kind: 'refused', why: 'another process answers on port 3000' },
    ],
    [
      "a cluster child that accepts for its listening parent is the lane's own server",
      {
        listeners: [listener('*')],
        acceptors: [{ chain: chain([201, 't1'], [100, 't0']) }],
        compose: null,
      },
      {},
      owned('127.0.0.1'),
    ],
    [
      "a listener and a second holder that is not the lane's",
      {
        listeners: [listener('*')],
        acceptors: [{ chain: mine }, { chain: others }],
        compose: null,
      },
      {},
      refused,
    ],
    [
      'no acceptor in time',
      { listeners: [listener('127.0.0.1')], acceptors: 'unaccepted', compose: null },
      {},
      { kind: 'refused', why: '3000 did not accept in time' },
    ],
    [
      'a failed probe',
      { listeners: [listener('127.0.0.1')], acceptors: 'unread', compose: null },
      {},
      refused,
    ],
    [
      'before the probe',
      { listeners: [listener('*')], acceptors: 'pending', compose: null },
      {},
      { kind: 'probe', connectTo: '127.0.0.1' },
    ],
    [
      'a socket bound to another address',
      { listeners: [listener('192.168.1.5')], compose: null },
      {},
      refused,
    ],
    ['only ::1', { listeners: [listener('[::1]')], compose: null }, {}, owned('::1')],
    [
      'ipv4 and ::1',
      { listeners: [listener('[::1]'), listener('127.0.0.1')], compose: null },
      {},
      owned('127.0.0.1'),
    ],
    ['a wildcard', { listeners: [listener('*')], compose: null }, {}, owned('127.0.0.1')],
  ])('%s', (_name, readings, over, expected) => {
    expect(judge(readings, session(over))).toMatchObject(expected);
  });
});

describe('portVerdict: the compose rule', () => {
  const foreign = [{ address: '*', chain: others }];
  const loopbackForeign = [{ address: '127.0.0.1', chain: others }];
  it.each<[string, Readings, object]>([
    [
      'a dir in the copy',
      { listeners: foreign, compose: [dir('/work/copy/app', '127.0.0.1')] },
      owned('127.0.0.1'),
    ],
    [
      'a dir in the temp dir',
      { listeners: foreign, compose: [dir('/work/tmp/x', '127.0.0.1')] },
      owned('127.0.0.1'),
    ],
    [
      'a registered checkout',
      { listeners: foreign, compose: [dir('/home/me/app/stack', '127.0.0.1')] },
      refused,
    ],
    ['elsewhere', { listeners: foreign, compose: [dir('/srv/other', '127.0.0.1')] }, refused],
    [
      '0.0.0.0 with no loopback listener',
      { listeners: foreign, compose: [dir('/work/copy', '0.0.0.0')] },
      owned('127.0.0.1'),
    ],
    [
      '0.0.0.0 beside a 127.0.0.1 listener',
      { listeners: loopbackForeign, compose: [dir('/work/copy', '0.0.0.0')] },
      { kind: 'refused', why: "3000 is shared with a server that isn't this lane's" },
    ],
    [
      ':: beside 0.0.0.0',
      { listeners: foreign, compose: [dir('/work/copy', '0.0.0.0'), dir('/work/copy', '::')] },
      owned('127.0.0.1'),
    ],
    [':: alone', { listeners: foreign, compose: [dir('/work/copy', '::')] }, refused],
    [
      'another address',
      { listeners: foreign, compose: [dir('/work/copy', '192.168.1.5')] },
      refused,
    ],
    ['no label', { listeners: foreign, compose: [dir(null, '127.0.0.1')] }, refused],
    [
      'unanswered',
      { listeners: foreign, compose: 'unanswered' },
      { why: 'Docker did not answer in 5 s' },
    ],
    [
      'a wildcard publication whose acceptor is not a listener',
      {
        listeners: foreign,
        acceptors: [{ chain: chain([5, 'r'], [1, 'x']) }],
        compose: [dir('/work/copy', '0.0.0.0')],
      },
      { kind: 'refused', why: 'another process answers on port 3000' },
    ],
    ['docker off', { listeners: foreign, compose: null }, refused],
  ])('%s', (_name, readings, expected) => {
    expect(judge(readings)).toMatchObject(expected);
  });
});

describe('createPortOwner', () => {
  const lane = (): LaneBrowserSession => {
    const members: ProcessMember[] = [{ pid: 100, startedAt: 't0', pgid: 100 }];
    return {
      copy: '/work/copy',
      tempDir: '/work/tmp',
      registeredCheckouts: [],
      loopback: true,
      docker: false,
      members: () => members,
    } as unknown as LaneBrowserSession;
  };
  const setup = () => {
    const clock = new ManualClock();
    let owner = 200;
    let reads = 0;
    let listening = true;
    const readers: PortReaders = {
      acceptors: () => Promise.resolve([owner]),
      listeners: () => {
        reads += 1;
        return Promise.resolve(listening ? [{ pid: owner, address: '127.0.0.1' }] : []);
      },
      table: () =>
        Promise.resolve([
          { pid: 200, ppid: 100, pgid: 100, startedAt: 't1' },
          { pid: 100, ppid: 1, pgid: 100, startedAt: 't0' },
          { pid: 300, ppid: 1, pgid: 300, startedAt: 't2' },
        ]),
      compose: null,
    };
    const portOwner = createPortOwner(
      {
        clock,
        readers,
        daemonPort: () => 7433,
        proxyPorts: () => new Set(),
        browserPids: () => new Set(),
      },
      lane(),
    );
    return {
      clock,
      portOwner,
      give: (pid: number) => (owner = pid),
      reads: () => reads,
      silence: () => (listening = false),
    };
  };

  it('keeps a verdict 5 s, then reads again so a port that changed hands is refused', async () => {
    const { clock, portOwner, give, reads } = setup();
    expect((await portOwner.check(3000)).kind).toBe('owned');
    give(300);
    expect((await portOwner.check(3000)).kind).toBe('owned');
    expect(reads()).toBe(1);
    clock.advance(5_001);
    expect((await portOwner.check(3000)).kind).toBe('refused');
  });

  it('refuses the twenty-first fresh check in a minute but still answers cached ones', async () => {
    const { portOwner, silence } = setup();
    silence();
    for (let p = 4000; p < 4020; p += 1) await portOwner.check(p);
    const verdict = await portOwner.check(5000);
    expect(verdict.kind).toBe('refused');
    expect(verdict.kind === 'refused' ? verdict.why : '').toContain('20 ports in a minute');
    expect(await portOwner.check(4000)).toMatchObject({ why: 'nothing listens on 4000' });
  });
});

// The readers call macOS's /usr/sbin/lsof and `ps -o lstart`; the daemon runs only on macOS.
describe.skipIf(process.platform !== 'darwin')(
  'createPortOwner against a real server and the real readers',
  () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    async function freePort(): Promise<number> {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      await new Promise((resolve) => server.close(resolve));
      return port;
    }

    async function serve(port: number): Promise<void> {
      const child = spawn(
        process.execPath,
        ['-e', `require('node:http').createServer().listen(${String(port)}); console.log('up')`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      children.push(child);
      await new Promise((resolve) => child.stdout.once('data', resolve));
    }

    const ownerFor = (members: () => readonly ProcessMember[]) => {
      const lane = {
        copy: '/work/copy',
        tempDir: '/work/tmp',
        registeredCheckouts: [],
        loopback: true,
        docker: false,
        members,
      } as unknown as LaneBrowserSession;
      return createPortOwner(
        {
          clock: systemClock,
          readers: systemPortReaders(
            process.env['HOME'] ?? '',
            process.env,
            systemProcessTable,
            systemClock,
          ),
          daemonPort: () => null,
          proxyPorts: () => new Set(),
          browserPids: () => new Set(),
        },
        lane,
      );
    };

    it("owns a listening server of the lane and refuses one that is not a member's descendant", async () => {
      const port = await freePort();
      await serve(port);
      const me = (await systemProcessTable()).find((row) => row.pid === process.pid);
      if (me === undefined) throw new Error('the test process is not in the process table');
      const mine = ownerFor(() => [{ pid: me.pid, startedAt: me.startedAt, pgid: me.pgid }]);
      expect(await mine.check(port)).toEqual({ kind: 'owned', connectTo: '127.0.0.1' });
      const stranger = ownerFor(() => [{ pid: 1, startedAt: 'launchd', pgid: 1 }]);
      expect(await stranger.check(port)).toMatchObject({ kind: 'refused' });
    });
  },
);

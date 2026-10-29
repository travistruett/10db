import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DaemonEvent,
  EventType,
  NetworkHostDto,
  ProjectDto,
  TaskDto,
  WorkstreamId,
  mintId,
  type ProjectId,
} from '@10db/contracts';
import { insertPermissionRule, listPermissionRules } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { createGit } from '../src/git';
import { storableRule } from '../src/permissions';
import { createGateSandbox } from '../src/sandbox';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, FAKE_SRT, SANDBOXED, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('network hosts');
  repo = createTempRepo();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function send(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function seedProject(): Promise<ProjectDto> {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
}

const hostsPath = (projectId: string) => `/projects/${projectId}/network-hosts`;
const hostPath = (projectId: string, host: string) =>
  `${hostsPath(projectId)}/${encodeURIComponent(host)}`;
const listHosts = async (projectId: string) =>
  z.array(NetworkHostDto).parse((await send('GET', hostsPath(projectId))).body);
const eventsAfter = (seq: number) =>
  api().get(`/events?after=${String(seq)}`, z.array(DaemonEvent));
const head = async () => (await api().get('/events/head', z.object({ seq: z.number() }))).seq;

const ERROR_BODY = z.object({ error: z.string(), message: z.string() });

describe('POST /projects/:id/network-hosts: which hosts are accepted', () => {
  it.each([
    { name: 'a host', input: 'index.crates.io', stored: 'index.crates.io' },
    { name: 'a second host', input: 'static.crates.io', stored: 'static.crates.io' },
    { name: 'a wildcard', input: '*.crates.io', stored: '*.crates.io' },
    { name: 'upper case, folded', input: 'Index.Crates.IO', stored: 'index.crates.io' },
    {
      name: 'padded with spaces, trimmed',
      input: '  registry.npmjs.org ',
      stored: 'registry.npmjs.org',
    },
    { name: 'a public address', input: '192.0.2.7', stored: '192.0.2.7' },
  ])('accepts $name and stores what a card answer stores', async ({ input, stored }) => {
    const project = await seedProject();
    const res = await send('POST', hostsPath(project.id), { host: input });
    expect(res.status).toBe(201);
    expect(NetworkHostDto.parse(res.body).host).toBe(stored);
    // The rule is the one the card's Always allow stores for the same host.
    expect(storableRule('SandboxNetworkAccess', stored)).toEqual({
      toolName: 'SandboxNetworkAccess',
      pattern: stored,
    });
    expect(
      listPermissionRules(daemon.state.db, project.id, null).map((r) => [
        r.toolName,
        r.pattern,
        r.workstreamId,
        r.sourceInboxId,
      ]),
    ).toEqual([['SandboxNetworkAccess', stored, null, null]]);
  });

  it.each([
    { name: 'the wildcard alone', input: '*', message: /too broad/ },
    { name: 'a bare top-level domain', input: 'com', message: /too broad/ },
    { name: 'a wildcard over a top-level domain', input: '*.com', message: /too broad/ },
    { name: 'a wildcard with nothing after it', input: '*.', message: /too broad/ },
    { name: 'localhost', input: 'localhost', message: /Allow localhost/ },
    { name: 'a name under localhost', input: 'app.localhost', message: /Allow localhost/ },
    { name: 'a wildcard under localhost', input: '*.localhost', message: /Allow localhost/ },
    { name: 'the IPv4 loopback address', input: '127.0.0.1', message: /Allow localhost/ },
    { name: 'another IPv4 loopback address', input: '127.5.5.5', message: /Allow localhost/ },
    { name: 'the IPv6 loopback address', input: '::1', message: /Allow localhost/ },
    { name: 'the bracketed IPv6 loopback address', input: '[::1]', message: /Allow localhost/ },
    { name: 'the unspecified address', input: '0.0.0.0', message: /Allow localhost/ },
    { name: 'a shortened loopback address', input: '127.1', message: /can't be listed/ },
    { name: 'a hex loopback address', input: '0x7f.0.0.1', message: /can't be listed/ },
    { name: 'an octal loopback address', input: '0177.0.0.1', message: /can't be listed/ },
    { name: 'a whole-number loopback address', input: '2130706433', message: /can't be listed/ },
    { name: 'a shortened unspecified address', input: '0.0', message: /can't be listed/ },
    { name: 'a wildcard over addresses', input: '*.0.0', message: /can't be listed/ },
    { name: 'another 0.x address', input: '0.1.2.3', message: /Allow localhost/ },
    { name: 'the metadata address', input: '169.254.169.254', message: /link-local/ },
    { name: 'a wildcard over a shared suffix', input: '*.co.uk', message: /too broad/ },
    { name: 'a wildcard over a hosting suffix', input: '*.github.io', message: /too broad/ },
    {
      name: 'a label over 63 characters',
      input: `${'a'.repeat(64)}.com`,
      message: /can't be listed/,
    },
    {
      name: 'a name over 253 characters',
      input: `${'a.'.repeat(130)}com`,
      message: /can't be listed/,
    },
    { name: 'a name with an underscore', input: 'my_service', message: /can't be listed/ },
    { name: 'an IPv6 address', input: 'fe80::1', message: /can't be listed/ },
    { name: 'a URL', input: 'https://index.crates.io', message: /can't be listed/ },
    { name: 'a host with a port', input: 'index.crates.io:443', message: /can't be listed/ },
    { name: 'a host with a path', input: 'crates.io/api', message: /can't be listed/ },
    { name: 'a host with a space', input: 'index crates.io', message: /can't be listed/ },
    { name: 'a wildcard in the middle', input: 'index.*.io', message: /can't be listed/ },
    { name: 'an empty label', input: 'index..crates.io', message: /can't be listed/ },
    { name: 'a leading dot', input: '.crates.io', message: /can't be listed/ },
    { name: 'a trailing dot', input: 'crates.io.', message: /can't be listed/ },
    { name: 'a blank host', input: '   ', message: /Enter a host/ },
  ])('refuses $name with a message', async ({ input, message }) => {
    const project = await seedProject();
    const before = await head();
    const res = await send('POST', hostsPath(project.id), { host: input });
    expect(res.status).toBe(400);
    expect(ERROR_BODY.parse(res.body).message).toMatch(message);
    expect(await listHosts(project.id)).toEqual([]);
    expect(listPermissionRules(daemon.state.db, project.id, null)).toEqual([]);
    expect(await eventsAfter(before)).toEqual([]);
  });

  it('refuses a body without a host', async () => {
    const project = await seedProject();
    expect((await send('POST', hostsPath(project.id), {})).status).toBe(400);
  });
});

describe('network hosts of a project', () => {
  it('lists what was added, in the order added, and emits one event per change', async () => {
    const project = await seedProject();
    const before = await head();
    await send('POST', hostsPath(project.id), { host: 'index.crates.io' });
    await send('POST', hostsPath(project.id), { host: 'static.crates.io' });

    expect((await listHosts(project.id)).map((h) => h.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
    const events = (await eventsAfter(before)).filter(
      (e) => e.type === EventType.NetworkHostsChanged,
    );
    expect(events.map((e) => [e.entityType, e.entityId])).toEqual([
      ['network_hosts', project.id],
      ['network_hosts', project.id],
    ]);
  });

  it('answers a duplicate with the existing host and adds no rule and no event', async () => {
    const project = await seedProject();
    const first = NetworkHostDto.parse(
      (await send('POST', hostsPath(project.id), { host: 'index.crates.io' })).body,
    );
    const before = await head();

    const again = await send('POST', hostsPath(project.id), { host: 'INDEX.crates.io' });

    expect(again.status).toBe(200);
    expect(NetworkHostDto.parse(again.body)).toEqual(first);
    expect(listPermissionRules(daemon.state.db, project.id, null)).toHaveLength(1);
    expect(await eventsAfter(before)).toEqual([]);
  });

  it('removes a host, with an event, and a second remove is a 404', async () => {
    const project = await seedProject();
    await send('POST', hostsPath(project.id), { host: 'index.crates.io' });
    await send('POST', hostsPath(project.id), { host: '*.crates.io' });
    const before = await head();

    const removed = await send('DELETE', hostPath(project.id, '*.crates.io'));

    expect(removed.status).toBe(200);
    expect(NetworkHostDto.parse(removed.body).host).toBe('*.crates.io');
    expect((await listHosts(project.id)).map((h) => h.host)).toEqual(['index.crates.io']);
    expect((await eventsAfter(before)).map((e) => e.type)).toEqual([EventType.NetworkHostsChanged]);
    const again = await send('DELETE', hostPath(project.id, '*.crates.io'));
    expect(again.status).toBe(404);
  });

  it("lists a card answer's project rule, and removing the host removes every copy", async () => {
    const project = await seedProject();
    const rule = (workstreamId: WorkstreamId | null) =>
      daemon.state.write((ctx) =>
        insertPermissionRule(ctx, {
          projectId: project.id,
          workstreamId,
          toolName: 'SandboxNetworkAccess',
          pattern: 'index.crates.io',
          sourceInboxId: null,
        }),
      );
    rule(null);
    rule(null);
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 't',
      acceptanceCriteria: ['x'],
      areas: ['src'],
      dependsOn: [],
    });
    const started = z
      .object({ id: WorkstreamId })
      .parse((await send('POST', `/tasks/${task.id}/start`, {})).body);
    rule(started.id);
    daemon.state.write((ctx) =>
      insertPermissionRule(ctx, {
        projectId: project.id,
        workstreamId: null,
        toolName: 'Bash',
        pattern: 'cargo build',
        sourceInboxId: null,
      }),
    );

    expect((await listHosts(project.id)).map((h) => h.host)).toEqual(['index.crates.io']);
    expect((await send('DELETE', hostPath(project.id, 'index.crates.io'))).status).toBe(200);
    expect(await listHosts(project.id)).toEqual([]);
    // Only network rules go; the project's other rules stay.
    expect(listPermissionRules(daemon.state.db, project.id, null).map((r) => r.toolName)).toEqual([
      'Bash',
    ]);
  });

  it('keeps hosts apart per project', async () => {
    const one = await seedProject();
    const other = await api().post('/projects', ProjectDto, {
      name: 'other',
      repoPath: createOtherRepo(),
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    await send('POST', hostsPath(one.id), { host: 'index.crates.io' });
    expect(await listHosts(other.id)).toEqual([]);
    expect((await send('DELETE', hostPath(other.id, 'index.crates.io'))).status).toBe(404);
    expect(await listHosts(one.id)).toHaveLength(1);
  });

  it.each(['GET', 'POST', 'DELETE'] as const)(
    '%s answers 404 for an unknown project',
    async (m) => {
      const id: ProjectId = mintId('Project');
      const path = m === 'DELETE' ? hostPath(id, 'index.crates.io') : hostsPath(id);
      const res = await send(m, path, m === 'POST' ? { host: 'index.crates.io' } : undefined);
      expect(res.status).toBe(404);
    },
  );

  // The lane temp dir needs a short root under the shared `/tmp`, which no sandbox can write.
  it.skipIf(SANDBOXED)("opens the gate sandbox's allowedDomains to an added host", async () => {
    const project = await seedProject();
    await send('POST', hostsPath(project.id), { host: 'index.crates.io' });
    await send('POST', hostsPath(project.id), { host: 'static.crates.io' });

    const root = realpathSync(mkdtempSync('/tmp/nh-'));
    try {
      const home = join(root, 'home');
      const tmpRoot = join(root, 't');
      mkdirSync(home);
      mkdirSync(tmpRoot);
      const git = createGit();
      const sandbox = createGateSandbox({
        home,
        dataDir: join(home, 'data'),
        loginConfigDir: join(home, '.claude'),
        tmpRoot,
        gitDirs: (path) => git.gitDirs(path),
        systemPrefixes: [],
        runtime: FAKE_SRT,
      });
      const run = await sandbox.forRun({
        project: { repoPath: repo.path, sandboxLoopback: false },
        env: { PATH: '/usr/bin:/bin', HOME: home },
        rules: listPermissionRules(daemon.state.db, project.id, null),
        checkouts: [repo.path],
        command: 'true',
      });
      try {
        const file = run.args[run.args.indexOf('--settings') + 1] ?? '';
        const settings = z
          .object({ network: z.object({ allowedDomains: z.array(z.string()) }) })
          .parse(JSON.parse(readFileSync(file, 'utf8')));
        expect(settings.network.allowedDomains).toEqual(['index.crates.io', 'static.crates.io']);
      } finally {
        await run.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createOtherRepo(): string {
  const other = createTempRepo();
  cleanups.push(() => {
    other.cleanup();
  });
  return other.path;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

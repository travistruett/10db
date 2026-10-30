import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DaemonEvent,
  FolderInspectResult,
  NetworkHostDto,
  ProjectDto,
  mintId,
} from '@10db/contracts';
import { getAppSetting, insertPermissionRule, listPermissionRules } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('network host sources');
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

function writeInRepo(name: string, text: string): void {
  const path = join(repo.path, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const CRATES = 'source = "registry+https://github.com/rust-lang/crates.io-index"\n';

async function createProject(): Promise<ProjectDto> {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
}

const hostsPath = (projectId: string) => `/projects/${projectId}/network-hosts`;
const listHosts = async (projectId: string) =>
  z.array(NetworkHostDto).parse((await send('GET', hostsPath(projectId))).body);
const head = async () => (await api().get('/events/head', z.object({ seq: z.number() }))).seq;
const eventsAfter = (seq: number) =>
  api().get(`/events?after=${String(seq)}`, z.array(DaemonEvent));

describe('hosts found when a project is added', () => {
  it('allows the registries the lockfiles and settings name, each with its file', async () => {
    writeInRepo('Cargo.lock', CRATES);
    writeInRepo('.npmrc', 'registry=https://npm.corp.example.com/\n');

    const project = await createProject();

    const hosts = await listHosts(project.id);
    expect(hosts.map((h) => [h.host, h.source])).toEqual([
      ['npm.corp.example.com', { kind: 'file', file: '.npmrc' }],
      ['index.crates.io', { kind: 'file', file: 'Cargo.lock' }],
      ['static.crates.io', { kind: 'file', file: 'Cargo.lock' }],
    ]);
    // The same project-wide rules a card's Allow for the project stores, so lanes and gates read them.
    expect(
      listPermissionRules(daemon.state.db, project.id, null).map((r) => [
        r.toolName,
        r.pattern,
        r.workstreamId,
        r.sourceInboxId,
        r.foundIn,
      ]),
    ).toEqual([
      ['SandboxNetworkAccess', 'npm.corp.example.com', null, null, '.npmrc'],
      ['SandboxNetworkAccess', 'index.crates.io', null, null, 'Cargo.lock'],
      ['SandboxNetworkAccess', 'static.crates.io', null, null, 'Cargo.lock'],
    ]);
  });

  it('allows nothing for a project whose files name no registry', async () => {
    const project = await createProject();
    expect(await listHosts(project.id)).toEqual([]);
  });

  it('keeps the token in a private registry URL out of the rules, the settings and the events', async () => {
    writeInRepo(
      '.npmrc',
      'registry=https://deploy:s3cr3t-token@npm.corp.example.com:8443/t/s3cr3t-token/\n//npm.corp.example.com/:_authToken=s3cr3t-token\n',
    );

    const project = await createProject();

    expect((await listHosts(project.id)).map((h) => h.host)).toEqual(['npm.corp.example.com']);
    const stored = JSON.stringify([
      listPermissionRules(daemon.state.db, project.id, null),
      getAppSetting(daemon.state.db, `network-hosts-found:${project.id}`) ?? null,
      await eventsAfter(0),
    ]);
    expect(stored).not.toMatch(/s3cr3t|deploy|8443/);
  });

  it('is listed with the folder before it is added, with where each host came from', async () => {
    writeInRepo('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n');
    const result = FolderInspectResult.parse(
      (await send('POST', '/folders/inspect', { path: repo.path })).body,
    );
    expect(result.ok && result.inspection.registryHosts).toEqual([
      { host: 'rubygems.org', file: 'Gemfile.lock' },
    ]);
  });
});

describe('where an allowed host came from', () => {
  it('says a typed host was added by the builder and a card’s rule came from a card', async () => {
    const project = await createProject();
    await send('POST', hostsPath(project.id), { host: 'typed.example.com' });
    daemon.state.write((ctx) =>
      insertPermissionRule(ctx, {
        projectId: project.id,
        workstreamId: null,
        toolName: 'SandboxNetworkAccess',
        pattern: 'card.example.com',
        sourceInboxId: mintId('InboxItem'),
      }),
    );

    expect((await listHosts(project.id)).map((h) => [h.host, h.source])).toEqual([
      ['typed.example.com', { kind: 'builder' }],
      ['card.example.com', { kind: 'card' }],
    ]);
  });
});

describe('POST /projects/:id/network-hosts/scan: looking again', () => {
  const FoundList = z.array(z.object({ host: z.string(), file: z.string() }).strict());

  it('lists the hosts the files now name that are not allowed, each with its file, and allows none', async () => {
    writeInRepo('Cargo.lock', CRATES);
    const project = await createProject();
    // A lane in a shared checkout can write any file: looking again must not turn that into a rule.
    writeInRepo('.npmrc', '@x:registry=https://exfil.example.net/\n');
    writeInRepo('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n');
    const before = await head();
    const rulesBefore = listPermissionRules(daemon.state.db, project.id, null);
    const readingBefore = getAppSetting(daemon.state.db, `network-hosts-found:${project.id}`);

    const res = await send('POST', `${hostsPath(project.id)}/scan`);

    expect(res.status).toBe(200);
    expect(FoundList.parse(res.body)).toEqual([
      { host: 'exfil.example.net', file: '.npmrc' },
      { host: 'rubygems.org', file: 'Gemfile.lock' },
    ]);
    expect(listPermissionRules(daemon.state.db, project.id, null)).toEqual(rulesBefore);
    expect((await listHosts(project.id)).map((h) => h.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
    // The reading a lane's card consults stays the one made when the project was added.
    expect(getAppSetting(daemon.state.db, `network-hosts-found:${project.id}`)).toEqual(
      readingBefore,
    );
    expect(await eventsAfter(before)).toEqual([]);
  });

  it('allows a found host only once the builder allows it by name, as added by them', async () => {
    const project = await createProject();
    writeInRepo('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n');
    expect(FoundList.parse((await send('POST', `${hostsPath(project.id)}/scan`)).body)).toEqual([
      { host: 'rubygems.org', file: 'Gemfile.lock' },
    ]);
    expect(await listHosts(project.id)).toEqual([]);

    const allowed = await send('POST', hostsPath(project.id), { host: 'rubygems.org' });

    expect(allowed.status).toBe(201);
    expect((await listHosts(project.id)).map((h) => [h.host, h.source])).toEqual([
      ['rubygems.org', { kind: 'builder' }],
    ]);
    expect(FoundList.parse((await send('POST', `${hostsPath(project.id)}/scan`)).body)).toEqual([]);
  });

  it('answers nothing when the files name nothing that is not allowed', async () => {
    writeInRepo('Cargo.lock', CRATES);
    const project = await createProject();

    const res = await send('POST', `${hostsPath(project.id)}/scan`);

    expect(FoundList.parse(res.body)).toEqual([]);
  });

  it('lists a host the builder removed again, without allowing it', async () => {
    writeInRepo('Cargo.lock', CRATES);
    const project = await createProject();
    await send('DELETE', `${hostsPath(project.id)}/static.crates.io`);

    const res = await send('POST', `${hostsPath(project.id)}/scan`);

    expect(FoundList.parse(res.body)).toEqual([{ host: 'static.crates.io', file: 'Cargo.lock' }]);
    expect((await listHosts(project.id)).map((h) => h.host)).toEqual(['index.crates.io']);
  });

  it('answers 404 for an unknown project', async () => {
    const res = await send('POST', `${hostsPath(mintId('Project'))}/scan`);
    expect(res.status).toBe(404);
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountCreatedDto,
  AccountDto,
  JudgeKind,
  LiveSystemsDto,
  ProjectDto,
  ProjectTrustDto,
  TRUST_DEFAULTS,
  TrustGrantDto,
  TrustSettingsDto,
  type TrustOverrides,
  type TrustSwitches,
} from '@10db/contracts';
import { insertTrustGrant } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, FAKE_SRT, homeOutsideTemp, SANDBOXED, type TempDir } from './fixtures';

// Settings › Trust (trust spec §6, §9): app-wide switches with a per-project override, the builder's
// installed plugins, and a preview of what comes along into a project's next session.

let base: string;
let homeDir: TempDir;
let home: string;
let repo: TempDir;
let other: TempDir;
let daemon: RunningDaemon;

/** A builder home with one skill and one plugin Claude Code has installed and switched off. */
function writeHome(): void {
  const skill = join(home, '.claude/skills/s');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: s\ndescription: a skill\n---\n');
  const plugin = join(home, '.claude/plugins/cache/m/p/1.2.0');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'p@m': [
          {
            scope: 'user',
            installPath: plugin,
            version: '1.2.0',
            installedAt: '2026-11-01T00:00:00.000Z',
            lastUpdated: '2026-11-01T00:00:00.000Z',
            gitCommitSha: 'abc',
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(home, '.claude/settings.json'),
    JSON.stringify({ enabledPlugins: { 'p@m': false } }),
  );
}

beforeEach(async () => {
  // A short base: a lane temp directory's whole path must fit the sandbox's limit.
  base = realpathSync(mkdtempSync('/tmp/sbt-'));
  // Outside every temp root, which 10db counts as lane-writable and leaves the builder's files out of.
  homeDir = homeOutsideTemp('sbt');
  home = join(homeDir.path, 'home');
  mkdirSync(home);
  writeHome();
  repo = createTempRepo();
  other = createTempRepo();
  const systemTempRoots = [join(base, 'sys')];
  for (const dir of systemTempRoots) mkdirSync(dir);
  daemon = await startDaemonWithProfiles({
    dataDir: join(base, 'data'),
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    sandbox: {
      tmpRoot: join(base, 't'),
      codexLaneTempRoot: join(base, 'l'),
      filesRoot: join(base, 'r'),
      systemTempRoots,
      runtime: FAKE_SRT,
    },
    builderHome: home,
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  other.cleanup();
  rmSync(base, { recursive: true, force: true });
  homeDir.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

const project = async (path: string, name: string) =>
  api().post('/projects', ProjectDto, {
    name,
    repoPath: path,
    gateCommand: 'true',
    defaultRigor: 'light',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

async function send(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const settings = async (method: 'GET' | 'PUT', body?: TrustSwitches) =>
  TrustSettingsDto.parse(await (await send(method, '/settings/trust', body)).json());

const projectTrust = async (id: string, method: 'GET' | 'PUT', body?: TrustOverrides) =>
  ProjectTrustDto.parse(await (await send(method, `/projects/${id}/trust`, body)).json());

const liveSystems = async (id: string) =>
  LiveSystemsDto.parse(await (await send('GET', `/projects/${id}/live-systems`)).json());

/** An account whose new tasks run `model`: the balanced tier is the implement role's default. */
const accountOn = async (body: object, model: string) =>
  (
    await api().post('/accounts', AccountCreatedDto, {
      ...body,
      settings: {
        ...('settings' in body && typeof body.settings === 'object' ? body.settings : {}),
        tierOverrides: { balanced: model },
      },
    })
  ).account;

describe.skipIf(SANDBOXED)('Settings › Trust over HTTP', () => {
  it('starts with every switch on and lists the installed plugin with its Claude state', async () => {
    expect(await settings('GET')).toEqual({
      switches: TRUST_DEFAULTS,
      plugins: [{ id: 'p@m', name: 'p', version: '1.2.0', enabledInClaude: false, on: false }],
      judges: [expect.objectContaining({ judge: JudgeKind.Native, why: null })],
      tendbReady: false,
      mcpServers: [],
      mcpNotice: null,
    });
  });

  it('keeps the switches the builder sets', async () => {
    const off = { ...TRUST_DEFAULTS, web: false, plugins: { 'p@m': true } };
    const saved = await settings('PUT', off);
    expect(saved.switches).toEqual(off);
    expect(saved.plugins[0]).toMatchObject({ id: 'p@m', enabledInClaude: false, on: true });
    expect((await settings('GET')).switches).toEqual(off);
    // With Your plugins off none comes along, whatever its own switch says.
    const none = await settings('PUT', { ...off, yourPlugins: false });
    expect(none.plugins[0]).toMatchObject({ id: 'p@m', on: false });
  });

  it("a project's override shows in its effective switches and not in another project's", async () => {
    const one = await project(repo.path, 'one');
    const two = await project(other.path, 'two');
    const saved = await projectTrust(one.id, 'PUT', { yourSkills: false });
    expect(saved.overrides).toEqual({ yourSkills: false });
    expect(saved.effective).toEqual({ ...TRUST_DEFAULTS, yourSkills: false });
    expect(saved.preview.skills).toEqual([]);
    const theirs = await projectTrust(two.id, 'GET');
    expect(theirs.overrides).toEqual({});
    expect(theirs.effective).toEqual(TRUST_DEFAULTS);
  });

  it("the project's preview lists the skill, and a skill linked into a checkout as left out with its reason", async () => {
    const one = await project(repo.path, 'one');
    // A skill folder in another registered checkout, which a lane can write.
    const two = await project(other.path, 'two');
    const inCheckout = join(two.repoPath, 'lane-skill');
    mkdirSync(inCheckout);
    writeFileSync(
      join(inCheckout, 'SKILL.md'),
      '---\nname: lane\ndescription: lane written\n---\n',
    );
    symlinkSync(inCheckout, join(home, '.claude/skills/lane'));
    // A skill folder directly in the home: refused by where it lies in the builder's home, which the
    // sandbox judges by as the setup was found in.
    const top = join(home, 'top-skill');
    mkdirSync(top);
    writeFileSync(join(top, 'SKILL.md'), '---\nname: top\ndescription: top\n---\n');
    symlinkSync(top, join(home, '.claude/skills/top'));
    const { preview } = await projectTrust(one.id, 'GET');
    expect(preview.skills).toEqual(['s']);
    expect(preview.plugins).toEqual([]);
    expect(preview.leftOut).toEqual(
      expect.arrayContaining([
        { what: '~/.claude/skills/lane', why: 'it lies in, or holds, a folder a lane can write' },
        { what: '~/.claude/skills/top', why: 'it lies directly in your home folder' },
      ]),
    );
  });

  it('refuses a body that is not the shape with 400', async () => {
    const one = await project(repo.path, 'one');
    expect((await send('PUT', '/settings/trust', { web: 'yes' })).status).toBe(400);
    expect((await send('PUT', '/settings/trust', { ...TRUST_DEFAULTS, extra: true })).status).toBe(
      400,
    );
    expect((await send('PUT', `/projects/${one.id}/trust`, { web: 1 })).status).toBe(400);
  });

  it("keeps a project's live systems and shows them", async () => {
    const one = await project(repo.path, 'one');
    const two = await project(other.path, 'two');
    const saved = await send('PUT', `/projects/${one.id}/live-systems`, {
      liveSystems: [' api.example.com ', 'the prod AWS profile', 'api.example.com'],
    });
    expect(saved.status).toBe(200);
    const kept = { liveSystems: ['api.example.com', 'the prod AWS profile'] };
    expect(LiveSystemsDto.parse(await saved.json())).toEqual(kept);
    expect(await liveSystems(one.id)).toEqual(kept);
    expect(await liveSystems(two.id)).toEqual({ liveSystems: [] });
  });

  it('refuses a live system with a newline with 400 and keeps the old list', async () => {
    const one = await project(repo.path, 'one');
    await send('PUT', `/projects/${one.id}/live-systems`, { liveSystems: ['prod'] });
    const refused = await send('PUT', `/projects/${one.id}/live-systems`, {
      liveSystems: ['api.example.com', 'api.example.com\nhard_deny: everything'],
    });
    expect(refused.status).toBe(400);
    expect(await liveSystems(one.id)).toEqual({ liveSystems: ['prod'] });
  });

  it('refuses one with a U+2028 with 400', async () => {
    const one = await project(repo.path, 'one');
    const refused = await send('PUT', `/projects/${one.id}/live-systems`, {
      liveSystems: ['api.example.com\u2028hard_deny: everything'],
    });
    expect(refused.status).toBe(400);
    expect(await liveSystems(one.id)).toEqual({ liveSystems: [] });
  });

  it('lists each account with its default model and judge', async () => {
    const accounts = await api().get('/accounts', z.array(AccountDto));
    const plan = accounts.find((a) => a.isDefault);
    if (!plan) throw new Error('no default account');
    const current = await accountOn(
      {
        kind: 'bedrock',
        label: 'Bedrock new',
        settings: { region: 'us-west-2', awsProfile: 'dev' },
      },
      'claude-opus-4-7',
    );
    const old = await accountOn(
      {
        kind: 'bedrock',
        label: 'Bedrock old',
        settings: { region: 'us-west-2', awsProfile: 'dev' },
      },
      'claude-sonnet-4-5',
    );
    const codex = await accountOn({ kind: 'codex_signin', label: 'ChatGPT' }, 'gpt-5.5');
    // An OpenRouter account answers decisions only: it runs no session, so it has no judge to list.
    const openRouter = (
      await api().post('/accounts', AccountCreatedDto, { kind: 'openrouter', label: 'OpenRouter' })
    ).account;

    const { judges } = await settings('GET');
    const byId = new Map(judges.map((row) => [row.accountId, row]));
    expect(byId.get(plan.id)).toMatchObject({
      label: plan.label,
      judge: JudgeKind.Native,
      why: null,
    });
    expect(byId.get(plan.id)?.model).toEqual(expect.any(String));
    expect(byId.get(current.id)).toEqual({
      accountId: current.id,
      label: 'Bedrock new',
      model: 'claude-opus-4-7',
      judge: JudgeKind.Native,
      why: null,
    });
    expect(byId.get(old.id)).toEqual({
      accountId: old.id,
      label: 'Bedrock old',
      model: 'claude-sonnet-4-5',
      judge: JudgeKind.Tendb,
      why: null,
    });
    expect(byId.get(codex.id)).toEqual({
      accountId: codex.id,
      label: 'ChatGPT',
      model: 'gpt-5.5',
      judge: JudgeKind.Tendb,
      why: null,
    });
    expect(byId.has(openRouter.id)).toBe(false);
    expect(judges).toHaveLength(4);
  });
});

describe("a project's grants over HTTP", () => {
  const grant = (projectId: ProjectDto['id'], target: string) =>
    daemon.state.write((ctx) =>
      insertTrustGrant(ctx, { projectId, limit: 'writes_live', target, sourceInboxId: null }),
    );
  const grants = async (id: string) =>
    z.array(TrustGrantDto).parse(await (await send('GET', `/projects/${id}/trust-grants`)).json());

  it("lists a project's grants and removes one", async () => {
    const one = await project(repo.path, 'one');
    const kept = grant(one.id, 'deploys to staging with vercel');
    expect(await grants(one.id)).toEqual([kept]);
    const removed = await send('DELETE', `/projects/${one.id}/trust-grants/${kept.id}`);
    expect(removed.status).toBe(204);
    expect(await grants(one.id)).toEqual([]);
  });

  it("removing another project's grant is 404", async () => {
    const one = await project(repo.path, 'one');
    const two = await project(other.path, 'two');
    const kept = grant(one.id, 'deploys');
    expect((await send('DELETE', `/projects/${two.id}/trust-grants/${kept.id}`)).status).toBe(404);
    expect(await grants(one.id)).toEqual([kept]);
  });

  it("trust settings say whether 10db's judge is ready", async () => {
    expect((await settings('GET')).tendbReady).toBe(false);
  });
});

describe("the builder's MCP servers over HTTP", () => {
  const writeServers = (servers: Record<string, unknown>): void => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ primaryApiKey: 'sk-canary', mcpServers: servers }),
    );
  };
  const DOCS = {
    type: 'http',
    url: 'https://docs.example/mcp',
    headers: { Authorization: 'Bearer sk-canary' },
  };
  const approve = (key: string, configHash: string | null) =>
    send('POST', '/settings/trust/mcp-servers/approve', { key, configHash });
  const serverOf = async (name: string) => {
    const found = (await settings('GET')).mcpServers.find((s) => s.name === name);
    if (!found) throw new Error(`${name} is not listed`);
    return found;
  };

  it('lists a new server from ~/.claude.json with its header names and no secret', async () => {
    writeServers({ docs: DOCS });
    const raw = JSON.stringify(await (await send('GET', '/settings/trust')).json());
    expect(raw).not.toContain('sk-canary');
    expect(await serverOf('docs')).toMatchObject({
      state: 'new',
      on: false,
      transport: 'http',
      url: 'https://docs.example/mcp',
      headerNames: ['Authorization'],
      sendsNoHeaders: false,
    });
  });

  it('a server whose name has a space is listed left out, and the page loads', async () => {
    writeServers({
      'two words': { command: 'x' },
      ok: { type: 'http', url: 'https://ok.example/mcp' },
    });
    expect(await serverOf('two words')).toMatchObject({
      state: 'left_out',
      reason: "Its name can't be an MCP server name.",
    });
    expect((await serverOf('ok')).state).toBe('new');
  });

  it("an entry that can't be read is listed left out, and the page loads", async () => {
    writeServers({ broken: { type: 'http' }, ok: { type: 'http', url: 'https://ok.example/mcp' } });
    expect(await serverOf('broken')).toMatchObject({ state: 'left_out', transport: null });
    expect((await serverOf('ok')).state).toBe('new');
  });

  it('approves with the hash it showed, and the server is on', async () => {
    writeServers({ docs: DOCS });
    const shown = await serverOf('docs');
    const response = await approve(shown.key, shown.configHash);
    expect(response.status).toBe(200);
    expect(await serverOf('docs')).toMatchObject({ state: 'approved', on: true });
  });

  it('refuses a stale hash with 409 and stores nothing', async () => {
    writeServers({ docs: DOCS });
    const shown = await serverOf('docs');
    writeServers({ docs: { ...DOCS, url: 'https://elsewhere.example/mcp' } });
    const response = await approve(shown.key, shown.configHash);
    expect(response.status).toBe(409);
    expect((await serverOf('docs')).state).toBe('new');
  });

  it('refuses to approve a server it cannot run', async () => {
    writeServers({ 'two words': { command: 'x' } });
    const shown = await serverOf('two words');
    expect((await approve(shown.key, shown.configHash ?? 'f'.repeat(64))).status).toBe(409);
  });

  it("a project's override turns one server off there only", async () => {
    writeServers({ docs: DOCS });
    const shown = await serverOf('docs');
    await approve(shown.key, shown.configHash);
    const one = await project(repo.path, 'one');
    const two = await project(other.path, 'two');
    const off = { mcpServers: { [shown.key]: false } };
    expect((await projectTrust(one.id, 'PUT', off)).effective.mcpServers).toEqual({
      [shown.key]: false,
    });
    expect((await projectTrust(two.id, 'GET')).effective.mcpServers).toEqual({});
  });
});

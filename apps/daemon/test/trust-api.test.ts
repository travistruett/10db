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
  TrustSettingsDto,
  type TrustOverrides,
  type TrustSwitches,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, FAKE_SRT, SANDBOXED, type TempDir } from './fixtures';

// Settings › Trust (trust spec §6, §9): app-wide switches with a per-project override, the builder's
// installed plugins, and a preview of what comes along into a project's next session.

let base: string;
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
  home = join(base, 'home');
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
});

const api = () => apiClient(daemon.url, daemon.token);

const project = async (path: string, name: string) =>
  api().post('/projects', ProjectDto, {
    name,
    repoPath: path,
    gateCommand: 'true',
    flowId: await quickFlowId(api()),
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

async function send(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Response> {
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
    const gateway = await accountOn(
      { kind: 'gateway', label: 'Gateway', settings: { baseUrl: 'https://gateway.example.com' } },
      'claude-opus-5-5',
    );
    const codex = await accountOn({ kind: 'codex_signin', label: 'ChatGPT' }, 'gpt-5.5');

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
      judge: JudgeKind.Rules,
      why: "Auto mode doesn't run on this model on this account.",
    });
    expect(byId.get(gateway.id)).toEqual({
      accountId: gateway.id,
      label: 'Gateway',
      model: 'claude-opus-5-5',
      judge: JudgeKind.Rules,
      why: "Auto mode doesn't run through a gateway account yet.",
    });
    expect(byId.get(codex.id)).toEqual({
      accountId: codex.id,
      label: 'ChatGPT',
      model: 'gpt-5.5',
      judge: JudgeKind.Rules,
      why: 'Codex has no judge in 10db yet.',
    });
    expect(judges).toHaveLength(5);
  });
});

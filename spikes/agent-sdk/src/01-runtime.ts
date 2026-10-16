// Spike 1: the SDK drives the installed claude. settingSources: ['project'], which M1b uses, loads the repo's
// own settings and CLAUDE.md, and no user or local settings, plugins, skills, hooks or MCP servers. Every check
// reads SDK data or a marker file, never the model's answer.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE } from './claude.ts';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info } from './report.ts';
import { baseOptions, openConversation } from './session.ts';

const denyAll: CanUseTool = async () => ({ behavior: 'deny', message: 'No tools in this probe.' });
const repo = makeFixtureRepo({ 'CLAUDE.md': 'This is the spike fixture repository.\n' });
const marker = (name: string): string => join(repo, name);
// A SessionStart command hook that leaves a marker file proves which settings files were loaded.
const hookSettings = (file: string) => ({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker(file)}'` }] }] },
});
mkdirSync(join(repo, '.claude'), { recursive: true });
writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(hookSettings('project-loaded')));
writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify(hookSettings('local-loaded')));
const userDir = join(homedir(), '.claude');
const userSkills = existsSync(join(userDir, 'skills')) ? readdirSync(join(userDir, 'skills')) : [];
info('user skills on disk', userSkills);

async function observe(label: string, settingSources: NonNullable<Options['settingSources']>) {
  rmSync(marker('project-loaded'), { force: true });
  rmSync(marker('local-loaded'), { force: true });
  const conv = openConversation(baseOptions(repo, { maxTurns: 1, canUseTool: denyAll, settingSources }));
  const turn = await conv.send('Reply with the single word ready. Use no tools.');
  const usage = await conv.q.getContextUsage({ detail: 'summary' }).catch(() => undefined);
  const run = await conv.close();
  const seen = {
    init: run.init,
    turnError: turn.error === undefined ? null : String(turn.error),
    memoryFiles: (usage?.memoryFiles ?? []).map((f) => f.path),
    projectHook: existsSync(marker('project-loaded')),
    localHook: existsSync(marker('local-loaded')),
    hookFrames: run.messages.filter((m) => m.type === 'system' && String(m.subtype).startsWith('hook_')).length,
  };
  info(`${label}`, { ...seen, init: undefined, skills: run.init?.skills, plugins: run.init?.plugins, mcp: run.init?.mcp_servers });
  return seen;
}

// The M1b configuration.
const m1b = await observe("['project']", ['project']);
const init = m1b.init;
check('init received', init !== undefined, init ? `model=${init.model}` : 'no init message');
check('claude version matches installed binary', init?.claude_code_version !== undefined && CLAUDE.version.startsWith(init.claude_code_version), `${init?.claude_code_version} vs ${CLAUDE.version}`);
// Plugins compiled into the binary report path 'builtin' and load under every settingSources value; only user
// or marketplace plugins would be a leak.
const builtinPlugins = (init?.plugins ?? []).filter((p) => p.path === 'builtin');
info('built-in plugins (always loaded)', builtinPlugins.map((p) => p.name));
check('no user or marketplace plugins loaded', init !== undefined && init.plugins.length === builtinPlugins.length, JSON.stringify(init?.plugins.filter((p) => p.path !== 'builtin') ?? null));
check('no MCP servers loaded (strictMcpConfig)', (init?.mcp_servers.length ?? -1) === 0, JSON.stringify(init?.mcp_servers ?? null));
const leakedSkills = (init?.skills ?? []).filter((s) => userSkills.includes(s));
check('no user skills loaded', leakedSkills.length === 0, JSON.stringify(leakedSkills));
check('no user CLAUDE.md loaded', m1b.memoryFiles.every((p) => !p.startsWith(userDir)), JSON.stringify(m1b.memoryFiles));
check('project CLAUDE.md loaded', m1b.memoryFiles.some((p) => p.includes(basename(repo)) && p.endsWith('CLAUDE.md')), JSON.stringify(m1b.memoryFiles));
check('project settings loaded (project hook ran)', m1b.projectHook, `hook frames: ${m1b.hookFrames}`);
check('local settings excluded (local hook did not run)', !m1b.localHook, 'settings.local.json can switch billing, so it must never load');

// Controls: [] excludes the project too; ['project', 'local'] proves the local canary can fire.
const none = await observe('[]', []);
check('[]: project settings excluded', !none.projectHook, `hook frames: ${none.hookFrames}`);
check('[]: project CLAUDE.md excluded', none.memoryFiles.every((p) => !p.includes(basename(repo))), JSON.stringify(none.memoryFiles));
const withLocal = await observe("['project','local']", ['project', 'local']);
check('control: the local canary fires when local is loaded', withLocal.localHook, 'if this fails, the local-exclusion check above proves nothing');

// M1b's billing preflight calls accountInfo() before it sends any prompt. Open a session, send nothing, and time
// the answer; only the billing fields are logged, never the email or organization.
{
  const conv = openConversation(baseOptions(repo, { maxTurns: 1, canUseTool: denyAll }));
  const t0 = performance.now();
  const account = await Promise.race([
    conv.q.accountInfo().catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000).unref()),
  ]);
  const ms = Math.round(performance.now() - t0);
  const run = await conv.close();
  info('accountInfo before any prompt', { ms, apiProvider: account?.apiProvider ?? null, subscriptionType: account?.subscriptionType ?? null, initSeen: run.init !== undefined, messages: run.messages.length, cost: run.result?.total_cost_usd ?? null });
  check('accountInfo answers before any prompt is sent (within 15 s)', account?.apiProvider === 'firstParty' && (account.subscriptionType ?? '') !== '', `${ms} ms`);
}
finish();

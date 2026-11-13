import { describe, expect, it } from 'vitest';
import { TRUST_DEFAULTS } from '@10db/contracts';
import type { LaneSandboxSpec } from '../sandbox';
import { buildTrustPolicy } from '../trust';
import { renderClaudeAutoMode } from './claude-auto-mode';
import {
  claudeQueryOptions,
  type ClaudeProfile,
  type ClaudeProfileSetup,
} from './claude-query-options';
import { SKILL_NAMES_LINE } from './setup-prompt';
import type { LanePermissionMode } from './types';

/** A read-only lane sandbox as Plan's session gets it; the profile's values are only carried through. */
const sandbox: LaneSandboxSpec = {
  settings: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ['/'],
      allowRead: ['/repo'],
      allowWrite: ['/private/tmp/10db-x'],
      denyWrite: ['/repo', '/repo/.git'],
    },
    network: {
      allowedDomains: [],
      allowMachLookup: ['com.apple.FSEvents'],
      allowUnixSockets: ['/private/tmp/10db-x'],
    },
    credentials: { envVars: [] },
  },
  checkout: '/repo',
  env: { CLAUDE_CODE_TMPDIR: '/private/tmp/10db-x', GIT_CONFIG_GLOBAL: '/dev/null' },
  shellEnv: {},
  disallowedTools: ['Read(//h/.claude.json)'],
  askRules: ['Edit(//repo/.mcp.json)'],
};

/** The rules a lane's policy renders for auto mode; the profile carries them through. */
const rendered = renderClaudeAutoMode(
  buildTrustPolicy({
    surface: 'lane',
    projectName: 'demo',
    checkout: '/repo',
    gateCommand: 'make gate',
    liveSystems: [],
    switches: TRUST_DEFAULTS,
  }),
);

const noSetup: ClaudeProfileSetup = { instructions: null, plugins: [] };
const withSetup: ClaudeProfileSetup = { instructions: 'Use pnpm.', plugins: ['/setup/yours'] };
const lane = (permissionMode: LanePermissionMode, setup = noSetup): ClaudeProfile => ({
  kind: 'lane',
  allowedTools: ['Read', 'mcp__10db__*'],
  permissionMode,
  pluginDir: '/harness',
  autoMode: rendered,
  setup,
});
const explore = (setup = noSetup): ClaudeProfile => ({
  kind: 'explore',
  systemPrompt: 'You are Shape.',
  tools: ['Read', 'Grep'],
  allowedTools: ['Read'],
  disallowedTools: ['Edit'],
  agents: { scope: { description: 'Scope', prompt: 'Review', tools: ['Read'] } },
  setup,
});
const harness = [{ type: 'local', path: '/harness' }];
const agents = {
  scope: { description: 'Scope', prompt: 'Review', tools: ['Read'], model: 'inherit' },
};
const preset = { type: 'preset', preset: 'claude_code', append: 'You are Shape.' };
const sandboxedLane = {
  settingSources: [],
  strictMcpConfig: true,
  settings: {
    autoCompactEnabled: true,
    permissions: { ask: sandbox.askRules },
    autoMode: rendered,
  },
  sandbox: sandbox.settings,
  disallowedTools: sandbox.disallowedTools,
  plugins: harness,
  allowedTools: ['Read', 'mcp__10db__*'],
};
const setupPrompt = `Use pnpm.\n\n${SKILL_NAMES_LINE}`;

describe('claudeQueryOptions', () => {
  it.each([
    {
      name: 'lane, unsandboxed: project settings, the plugin, default mode even when auto is asked',
      profile: lane('auto'),
      sandbox: null,
      want: {
        settingSources: ['project'],
        strictMcpConfig: true,
        settings: { autoCompactEnabled: true },
        plugins: harness,
        allowedTools: ['Read', 'mcp__10db__*'],
        permissionMode: 'default',
        sandboxEnv: {},
      },
    },
    {
      name: 'lane, sandboxed in auto mode: no settings file, the classifier rules, the scrub off',
      profile: lane('auto'),
      sandbox,
      want: {
        ...sandboxedLane,
        permissionMode: 'auto',
        sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' },
      },
    },
    {
      name: 'lane, sandboxed in default mode: the scrub on, and the rendered rules too, as today',
      profile: lane('default'),
      sandbox,
      want: {
        ...sandboxedLane,
        permissionMode: 'default',
        sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
      },
    },
    {
      name: 'lane with a setup: its instructions as the custom prompt, its plugin dirs after the harness',
      profile: lane('auto', withSetup),
      sandbox,
      want: {
        ...sandboxedLane,
        systemPrompt: { type: 'custom', prompt: setupPrompt },
        plugins: [...harness, { type: 'local', path: '/setup/yours' }],
        permissionMode: 'auto',
        sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' },
      },
    },
    {
      name: 'explore, unsandboxed',
      profile: explore(),
      sandbox: null,
      want: {
        settingSources: [],
        strictMcpConfig: true,
        settings: { autoCompactEnabled: true },
        systemPrompt: preset,
        tools: ['Read', 'Grep'],
        allowedTools: ['Read'],
        disallowedTools: ['Edit'],
        agents,
        permissionMode: 'default',
        sandboxEnv: {},
      },
    },
    {
      name: 'explore, sandboxed: ask rules but no classifier rules, the scrub on',
      profile: explore(),
      sandbox,
      want: {
        settingSources: [],
        strictMcpConfig: true,
        settings: { autoCompactEnabled: true, permissions: { ask: sandbox.askRules } },
        sandbox: sandbox.settings,
        systemPrompt: preset,
        tools: ['Read', 'Grep'],
        allowedTools: ['Read'],
        disallowedTools: ['Edit', ...sandbox.disallowedTools],
        agents,
        permissionMode: 'default',
        sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
      },
    },
    {
      name: 'explore with a setup: its instructions after Plan’s prompt, its plugin dirs alone',
      profile: explore(withSetup),
      sandbox,
      want: {
        settingSources: [],
        strictMcpConfig: true,
        settings: { autoCompactEnabled: true, permissions: { ask: sandbox.askRules } },
        sandbox: sandbox.settings,
        systemPrompt: { ...preset, append: `You are Shape.\n\n${setupPrompt}` },
        plugins: [{ type: 'local', path: '/setup/yours' }],
        tools: ['Read', 'Grep'],
        allowedTools: ['Read'],
        disallowedTools: ['Edit', ...sandbox.disallowedTools],
        agents,
        permissionMode: 'default',
        sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
      },
    },
  ])('$name', ({ profile, sandbox: s, want }) => {
    expect(claudeQueryOptions(profile, s)).toEqual(want);
  });

  it.each([
    ['unsandboxed', null],
    ['sandboxed', sandbox],
  ])(
    'never gives the explore profile project settings, auto mode or the harness plugin dir (%s)',
    (_name, s) => {
      const options = claudeQueryOptions(explore(withSetup), s);
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe('default');
      expect(options.plugins ?? []).not.toContainEqual({ type: 'local', path: '/harness' });
      expect(options).not.toHaveProperty('settings.autoMode');
    },
  );

  it('leaves sandbox and disallowedTools out of an unsandboxed lane', () => {
    const options = claudeQueryOptions(lane('auto'), null);
    expect(options).not.toHaveProperty('sandbox');
    expect(options).not.toHaveProperty('disallowedTools');
  });
});

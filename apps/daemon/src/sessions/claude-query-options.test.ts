import { describe, expect, it } from 'vitest';
import { TRUST_DEFAULTS } from '@10db/contracts';
import type { LaneSandboxSpec } from '../sandbox';
import { buildTrustPolicy } from '../trust';
import { renderClaudeAutoMode, type ClaudeAutoModeSettings } from './claude-auto-mode';
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
    grants: [],
    yourMcpServers: [],
    claudeConnectors: false,
  }),
);

const noSetup: ClaudeProfileSetup = { instructions: null, plugins: [] };
const withSetup: ClaudeProfileSetup = { instructions: 'Use pnpm.', plugins: ['/setup/yours'] };
const lane = (
  permissionMode: LanePermissionMode,
  setup = noSetup,
  transcriptDays?: number,
): ClaudeProfile => ({
  kind: 'lane',
  allowedTools: ['Read', 'mcp__10db__*'],
  permissionMode,
  pluginDir: '/harness',
  autoMode: rendered,
  setup,
  ...(transcriptDays === undefined ? {} : { transcriptDays }),
});
const explore = (
  setup = noSetup,
  autoMode: ClaudeAutoModeSettings | null = null,
): ClaudeProfile => ({
  kind: 'explore',
  systemPrompt: 'You are Shape.',
  tools: ['Read', 'Grep'],
  allowedTools: ['Read'],
  disallowedTools: ['Edit'],
  agents: { scope: { description: 'Scope', prompt: 'Review', tools: ['Read'] } },
  setup,
  autoMode,
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
    // Every profile streams its partial messages, the deltas the session reports.
    expect(claudeQueryOptions(profile, s)).toEqual({ ...want, includePartialMessages: true });
  });

  it.each([
    ['unsandboxed', null],
    ['sandboxed', sandbox],
  ])(
    'gives the explore profile on a rules or 10db judge default mode and no auto mode rules (%s)',
    (_name, s) => {
      const options = claudeQueryOptions(explore(withSetup), s);
      expect(options.permissionMode).toBe('default');
      expect(options).not.toHaveProperty('settings.autoMode');
    },
  );

  it.each([
    ['unsandboxed', null],
    ['sandboxed', sandbox],
  ])(
    'runs the explore profile on a native judge in auto mode, under the attended policy (%s)',
    (_name, s) => {
      const options = claudeQueryOptions(explore(withSetup, rendered), s);
      expect(options.permissionMode).toBe('auto');
      expect(options.settings).toMatchObject({ autoMode: rendered });
      expect(rendered.allow[0]).toBe('$defaults');
      expect(rendered.soft_deny[0]).toBe('$defaults');
      if (s !== null)
        expect(options.sandboxEnv).toMatchObject({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' });
    },
  );

  it.each([
    ['unsandboxed, rules', null, null],
    ['sandboxed, rules', sandbox, null],
    ['unsandboxed, native', null, rendered],
    ['sandboxed, native', sandbox, rendered],
  ] as const)(
    'never gives the explore profile project settings or the harness plugin dir (%s)',
    (_name, s, autoMode) => {
      const options = claudeQueryOptions(explore(withSetup, autoMode), s);
      expect(options.settingSources).toEqual([]);
      expect(options.plugins ?? []).not.toContainEqual({ type: 'local', path: '/harness' });
    },
  );

  // Sessions spec §7.2: a chat that edits keeps file history so the builder can rewind; Plan and a lane don't.
  it.each([
    ['a chat', { ...explore(), fileCheckpointing: true }, true],
    ['Plan', explore(), false],
    ['a lane', lane('auto'), false],
  ] as const)('turns file checkpointing on for %s only when it edits: %s', (_who, profile, on) => {
    const options = claudeQueryOptions(profile, sandbox);
    expect('enableFileCheckpointing' in options && options.enableFileCheckpointing).toBe(on);
  });

  // An eval run keeps its lanes' transcripts whatever the builder's own cleanupPeriodDays says.
  it.each([
    ['sandboxed', sandbox],
    ['unsandboxed', null],
  ])('pins a lane transcript retention inline only when one is given (%s)', (_name, s) => {
    const kept = claudeQueryOptions(lane('auto', noSetup, 30), s);
    expect(kept.settings).toMatchObject({ cleanupPeriodDays: 30 });
    expect(claudeQueryOptions(lane('auto'), s)).not.toHaveProperty('settings.cleanupPeriodDays');
  });

  it('leaves sandbox and disallowedTools out of an unsandboxed lane', () => {
    const options = claudeQueryOptions(lane('auto'), null);
    expect(options).not.toHaveProperty('sandbox');
    expect(options).not.toHaveProperty('disallowedTools');
  });
});

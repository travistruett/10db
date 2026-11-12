import { TRUST_DEFAULTS, type TrustSwitches } from '@10db/contracts';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { planSessionSetup, type SessionSetupPlan } from './plan';

let root: TempDir;
let home: string;
let checkout: string;

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function plugin(name: string, mcp: boolean): Record<string, string> {
  const installPath = join(home, `.claude/plugins/cache/m/${name}/1`);
  write(join(installPath, '.claude-plugin/plugin.json'), JSON.stringify({ name }));
  write(join(installPath, 'skills/x/SKILL.md'), '---\nname: x\n---\n');
  if (mcp) write(join(installPath, '.mcp.json'), '{"mcpServers":{}}');
  return { scope: 'user', installPath, version: '1' };
}

beforeEach(() => {
  root = tempDir('setup-plan');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  write(join(home, '.claude/CLAUDE.md'), 'yours');
  write(join(home, '.claude/skills/s/SKILL.md'), '---\nname: s\n---\n');
  write(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'p@m': [plugin('p', false)],
        'q@m': [plugin('q', true)],
        'r@m': [plugin('r', false)],
      },
    }),
  );
  write(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'r@m': false } }));
  write(join(checkout, 'AGENTS.md'), 'agents');
  write(join(checkout, '.claude/skills/ps/SKILL.md'), '---\nname: ps\n---\n');
});

afterEach(() => {
  root.cleanup();
});

interface Summary {
  instructions: readonly string[];
  skills: string[];
  plugins: string[];
  projectFiles: string[];
  leftOut: string[];
}

function summary(plan: SessionSetupPlan): Summary {
  return {
    instructions: plan.instructions.sources,
    skills: plan.input.skills.map((s) => s.name),
    plugins: plan.input.plugins.map((p) => p.id),
    projectFiles: plan.input.projectFiles.map((f) => f.relative),
    leftOut: plan.leftOut.map((l) => `${l.what}: ${l.why}`),
  };
}

function plan(switches: Partial<TrustSwitches> = {}): Summary {
  return summary(
    planSessionSetup({
      home,
      checkout,
      switches: { ...TRUST_DEFAULTS, ...switches },
      laneWritable: [checkout],
    }),
  );
}

const MCP_NOTE = "q@m's MCP servers: until 10db runs your MCP servers (T6)";

const ALL: Summary = {
  instructions: ['AGENTS.md', '~/.claude/CLAUDE.md'],
  skills: ['s'],
  plugins: ['p@m', 'q@m'],
  projectFiles: ['skills/ps/SKILL.md'],
  leftOut: [MCP_NOTE],
};

describe('planSessionSetup', () => {
  it('all on loads all', () => {
    expect(plan()).toEqual(ALL);
  });

  it.each<[string, Partial<TrustSwitches>, Partial<Summary>]>([
    [
      'projectInstructions',
      { projectInstructions: false },
      { instructions: ['~/.claude/CLAUDE.md'] },
    ],
    ['yourInstructions', { yourInstructions: false }, { instructions: ['AGENTS.md'] }],
    ['yourSkills', { yourSkills: false }, { skills: [] }],
    ['yourPlugins', { yourPlugins: false }, { plugins: [], leftOut: [] }],
    ['projectSkills', { projectSkills: false }, { projectFiles: [] }],
  ])('each switch off drops only its kind: %s', (_name, switches, changed) => {
    expect(plan(switches)).toEqual({ ...ALL, ...changed });
  });

  it('a plugin off in Claude Code stays off unless switched on here', () => {
    expect(plan().plugins).not.toContain('r@m');
    expect(plan({ plugins: { 'r@m': true } }).plugins).toEqual(['p@m', 'q@m', 'r@m']);
  });

  it('a plugin switched off here stays off though Claude Code has it on', () => {
    expect(plan({ plugins: { 'p@m': false } }).plugins).toEqual(['q@m']);
  });

  it('a plugin list that can’t be read is one note and no plugins', () => {
    write(join(home, '.claude/plugins/installed_plugins.json'), '{"version": 1}');
    expect(plan()).toEqual({
      ...ALL,
      plugins: [],
      leftOut: ["Claude Code's plugin list: Claude Code's plugin list is not a shape 10db reads"],
    });
  });

  it('a plugin with a .mcp.json gets the MCP left-out item, one without gets none', () => {
    const installPath = join(home, '.claude/plugins/cache/m/p/1');
    write(
      join(installPath, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'p', mcpServers: { s: { command: 'x' } } }),
    );
    expect(plan().leftOut).toEqual([
      "p@m's MCP servers: until 10db runs your MCP servers (T6)",
      MCP_NOTE,
    ]);
  });
});

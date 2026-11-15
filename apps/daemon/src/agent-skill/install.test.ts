import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkillLinkState, AgentSkillTool } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAgentSkill, installedSkillDir, skillLinkPaths } from './install';

let root: string;
let home: string;
let shipped: string;

function writeShipped(version: string): void {
  mkdirSync(shipped, { recursive: true });
  writeFileSync(join(shipped, 'SKILL.md'), `skill ${version}`);
  writeFileSync(join(shipped, 'tendb.mjs'), `cli ${version}`);
  writeFileSync(join(shipped, 'VERSION'), `${version}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-skill-'));
  home = join(root, 'home');
  shipped = join(root, 'shipped');
  mkdirSync(home);
  writeShipped('0123456789ab');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const claudePath = () => join(home, '.claude', 'skills', '10db-task');
const agentsPath = () => join(home, '.agents', 'skills', '10db-task');

interface LinkRow {
  readonly name: string;
  /** Builds what the row has at the Claude Code link path. */
  readonly arrange: () => void;
  readonly state: AgentSkillLinkState;
  /** The link's text afterwards, or null when the path is not a link. */
  readonly linkText: (() => string) | null;
  readonly target: (() => string) | null;
}

const ours = () => installedSkillDir(home);

const rows: readonly LinkRow[] = [
  {
    name: 'missing parent',
    arrange: () => undefined,
    state: AgentSkillLinkState.Linked,
    linkText: ours,
    target: null,
  },
  {
    name: 'missing',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    },
    state: AgentSkillLinkState.Linked,
    linkText: ours,
    target: null,
  },
  {
    name: 'ours',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      mkdirSync(ours(), { recursive: true });
      symlinkSync(ours(), claudePath());
    },
    state: AgentSkillLinkState.Linked,
    linkText: ours,
    target: null,
  },
  {
    name: 'relative to ours',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      mkdirSync(ours(), { recursive: true });
      symlinkSync('../../.10db/skills/10db-task', claudePath());
    },
    state: AgentSkillLinkState.Linked,
    linkText: () => '../../.10db/skills/10db-task',
    target: null,
  },
  {
    name: 'dangling',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      symlinkSync(join(root, 'deleted'), claudePath());
    },
    state: AgentSkillLinkState.Linked,
    linkText: ours,
    target: null,
  },
  {
    name: 'relative dangling',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      symlinkSync('../../gone', claudePath());
    },
    state: AgentSkillLinkState.Linked,
    linkText: ours,
    target: null,
  },
  {
    name: 'elsewhere',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      mkdirSync(join(root, 'mine'));
      symlinkSync(join(root, 'mine'), claudePath());
    },
    state: AgentSkillLinkState.PointsElsewhere,
    linkText: () => join(root, 'mine'),
    target: () => join(root, 'mine'),
  },
  {
    name: 'in the way folder',
    arrange: () => {
      mkdirSync(claudePath(), { recursive: true });
      writeFileSync(join(claudePath(), 'SKILL.md'), 'builder');
    },
    state: AgentSkillLinkState.InTheWay,
    linkText: null,
    target: null,
  },
  {
    name: 'in the way file',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      writeFileSync(claudePath(), 'builder');
    },
    state: AgentSkillLinkState.InTheWay,
    linkText: null,
    target: null,
  },
];

describe('installAgentSkill links', () => {
  it.each(rows)('$name', (row) => {
    row.arrange();
    const result = installAgentSkill(home, shipped);

    const link = result.links.find((l) => l.tool === AgentSkillTool.ClaudeCode);
    expect(link).toEqual({
      tool: AgentSkillTool.ClaudeCode,
      path: claudePath(),
      state: row.state,
      target: row.target?.() ?? null,
    });
    if (row.linkText) {
      expect(readlinkSync(claudePath())).toBe(row.linkText());
    } else if (row.name === 'in the way folder') {
      expect(readFileSync(join(claudePath(), 'SKILL.md'), 'utf8')).toBe('builder');
    } else {
      expect(readFileSync(claudePath(), 'utf8')).toBe('builder');
    }
    // The other tool's path is judged on its own.
    expect(readlinkSync(agentsPath())).toBe(ours());
    expect(existsSync(join(ours(), 'SKILL.md'))).toBe(true);
  });

  it('follows a skills dir that is itself a link, as the builder made it', () => {
    mkdirSync(join(root, 'dotfiles-skills'));
    mkdirSync(join(home, '.claude'));
    symlinkSync(join(root, 'dotfiles-skills'), join(home, '.claude', 'skills'));
    installAgentSkill(home, shipped);
    expect(lstatSync(join(home, '.claude', 'skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'dotfiles-skills', '10db-task'))).toBe(ours());
  });

  it('tries each link even when the other failed, and keeps the first error', () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'skills'), 'a file where the skills dir should be');
    const result = installAgentSkill(home, shipped);
    expect(result.error?.name).toBe('AgentSkillInstallError');
    expect(result.links.map((l) => [l.tool, l.state])).toEqual([
      [AgentSkillTool.ClaudeCode, AgentSkillLinkState.Missing],
      [AgentSkillTool.Codex, AgentSkillLinkState.Linked],
    ]);
    expect(readlinkSync(agentsPath())).toBe(ours());
  });

  it('names both link paths under the home', () => {
    expect(skillLinkPaths(home)).toEqual([
      { tool: AgentSkillTool.ClaudeCode, path: claudePath() },
      { tool: AgentSkillTool.Codex, path: agentsPath() },
    ]);
  });
});

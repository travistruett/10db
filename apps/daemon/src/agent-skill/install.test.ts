import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkillLinkState, AgentSkillTool } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installAgentSkill,
  installedSkillDir,
  skillLinkPaths,
  uninstallAgentSkill,
} from './install';

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
  try {
    chmodSync(join(root, 'locked'), 0o700);
  } catch {
    // Only the unreadable-folder row made it.
  }
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
    name: 'link into an unreadable folder',
    arrange: () => {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      mkdirSync(join(root, 'locked', 'inner'), { recursive: true });
      symlinkSync(join(root, 'locked', 'inner'), claudePath());
      chmodSync(join(root, 'locked'), 0o000);
    },
    state: AgentSkillLinkState.PointsElsewhere,
    linkText: () => join(root, 'locked', 'inner'),
    target: () => join(root, 'locked', 'inner'),
  },
  {
    name: 'relative link inside a symlinked skills folder',
    arrange: () => {
      mkdirSync(join(root, 'dotfiles', 'claude-skills'), { recursive: true });
      mkdirSync(join(root, 'dotfiles', 'agent-skills', '10db-task'), { recursive: true });
      mkdirSync(join(home, '.claude'));
      symlinkSync(join(root, 'dotfiles', 'claude-skills'), join(home, '.claude', 'skills'));
      symlinkSync('../agent-skills/10db-task', claudePath());
    },
    state: AgentSkillLinkState.PointsElsewhere,
    linkText: () => '../agent-skills/10db-task',
    target: () => '../agent-skills/10db-task',
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

const skillsDir = () => join(home, '.10db', 'skills');
const copyFiles = () => readdirSync(ours()).sort();

function writeCopy(dir: string, version: string | null, extra: readonly string[] = []): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `old ${version ?? 'none'}`);
  writeFileSync(join(dir, 'tendb.mjs'), `old ${version ?? 'none'}`);
  if (version !== null) writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  for (const name of extra) writeFileSync(join(dir, name), 'stale');
}

describe('installAgentSkill copy', () => {
  it('writes nothing when the installed version matches', () => {
    installAgentSkill(home, shipped);
    const before = statSync(join(ours(), 'SKILL.md')).mtimeMs;
    const dirBefore = statSync(ours()).ino;
    installAgentSkill(home, shipped);
    expect(statSync(join(ours(), 'SKILL.md')).mtimeMs).toBe(before);
    expect(statSync(ours()).ino).toBe(dirBefore);
  });

  it('replaces a copy of another version whole, dropping its stale files', () => {
    writeCopy(ours(), 'aaaaaaaaaaaa', ['stale.txt']);
    installAgentSkill(home, shipped);
    expect(copyFiles()).toEqual(['SKILL.md', 'VERSION', 'tendb.mjs']);
    expect(readFileSync(join(ours(), 'SKILL.md'), 'utf8')).toBe('skill 0123456789ab');
    expect(readdirSync(skillsDir())).toEqual(['10db-task']);
  });

  it.each([
    { name: 'half-written: no VERSION, leftover temp', version: null, leftovers: ['.10db-task-x'] },
    {
      name: 'new written, old still in',
      version: 'aaaaaaaaaaaa',
      leftovers: ['.10db-task-new-b'],
    },
    {
      name: 'matching VERSION, tendb.mjs missing',
      version: '0123456789ab',
      leftovers: [],
      remove: 'tendb.mjs',
    },
    {
      name: 'matching VERSION, SKILL.md missing',
      version: '0123456789ab',
      leftovers: [],
      remove: 'SKILL.md',
    },
  ])('$name ends whole and current', ({ version, leftovers, remove }) => {
    writeCopy(ours(), version);
    if (remove) rmSync(join(ours(), remove));
    for (const name of leftovers) writeCopy(join(skillsDir(), name), 'bbbbbbbbbbbb');
    installAgentSkill(home, shipped);
    expect(copyFiles()).toEqual(['SKILL.md', 'VERSION', 'tendb.mjs']);
    expect(readFileSync(join(ours(), 'tendb.mjs'), 'utf8')).toBe('cli 0123456789ab');
    expect(readdirSync(skillsDir())).toEqual(['10db-task']);
  });

  it('old moved aside, new not in: no copy, an -old- and a -new- folder', () => {
    writeCopy(join(skillsDir(), '.10db-task-old-a'), 'aaaaaaaaaaaa');
    writeCopy(join(skillsDir(), '.10db-task-new-b'), null);
    installAgentSkill(home, shipped);
    expect(copyFiles()).toEqual(['SKILL.md', 'VERSION', 'tendb.mjs']);
    expect(readdirSync(skillsDir())).toEqual(['10db-task']);
  });
});

describe('uninstallAgentSkill', () => {
  it('removes its links and the copy', () => {
    installAgentSkill(home, shipped);
    uninstallAgentSkill(home);
    expect(existsSync(ours())).toBe(false);
    expect(() => lstatSync(claudePath())).toThrow();
    expect(() => lstatSync(agentsPath())).toThrow();
  });

  it('removes a relative link that resolves to the copy', () => {
    installAgentSkill(home, shipped);
    rmSync(claudePath());
    symlinkSync('../../.10db/skills/10db-task', claudePath());
    uninstallAgentSkill(home);
    expect(() => lstatSync(claudePath())).toThrow();
  });

  it('keeps a link to elsewhere and a real folder, and still removes the copy', () => {
    mkdirSync(join(root, 'mine'));
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(root, 'mine'), claudePath());
    installAgentSkill(home, shipped);
    rmSync(agentsPath());
    mkdirSync(agentsPath(), { recursive: true });
    writeFileSync(join(agentsPath(), 'SKILL.md'), 'builder');
    uninstallAgentSkill(home);
    expect(readlinkSync(claudePath())).toBe(join(root, 'mine'));
    expect(readFileSync(join(agentsPath(), 'SKILL.md'), 'utf8')).toBe('builder');
    expect(existsSync(ours())).toBe(false);
  });

  it('removes a link to the copy after the copy was deleted by hand', () => {
    installAgentSkill(home, shipped);
    rmSync(ours(), { recursive: true });
    uninstallAgentSkill(home);
    expect(() => lstatSync(claudePath())).toThrow();
    expect(() => lstatSync(agentsPath())).toThrow();
  });

  it('is a no-op the second time and on a home that never had it', () => {
    uninstallAgentSkill(home);
    installAgentSkill(home, shipped);
    uninstallAgentSkill(home);
    uninstallAgentSkill(home);
    expect(existsSync(ours())).toBe(false);
  });
});

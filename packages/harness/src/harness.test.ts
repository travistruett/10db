import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HARNESS_PLUGIN_DIR,
  listSkills,
  MAX_SKILL_BYTES,
  readPluginManifest,
  SKILL_NAMES,
  SkillManifestError,
} from './index';

describe('harness plugin', () => {
  it('ships a plugin manifest at the path the daemon injects', () => {
    expect(existsSync(join(HARNESS_PLUGIN_DIR, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('has a valid manifest named 10db-harness', () => {
    expect(readPluginManifest().name).toBe('10db-harness');
  });
});

describe('craft skills', () => {
  const skills = listSkills();

  it('ships exactly the five craft skills', () => {
    expect(skills.map((s) => s.name)).toEqual([...SKILL_NAMES].sort());
  });

  it.each(SKILL_NAMES)('%s stays under the per-skill size cap', (name) => {
    const skill = skills.find((s) => s.name === name);
    expect(skill?.bytes).toBeGreaterThan(200);
    expect(skill?.bytes).toBeLessThan(MAX_SKILL_BYTES);
  });

  it.each(SKILL_NAMES)('%s describes when to use it', (name) => {
    expect(skills.find((s) => s.name === name)?.description).toMatch(/^Use when /);
  });

  it('names each skill after its directory', () => {
    for (const skill of skills)
      expect(existsSync(join(HARNESS_PLUGIN_DIR, 'skills', skill.name, 'SKILL.md'))).toBe(true);
  });
});

describe('listSkills on a malformed plugin dir', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function pluginWith(skillDir: string, content: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-skills-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'skills', skillDir), { recursive: true });
    if (content !== undefined) writeFileSync(join(dir, 'skills', skillDir, 'SKILL.md'), content);
    return dir;
  }

  const body = '\n# Body\n';
  const rejected: { name: string; skillDir: string; content: string | undefined }[] = [
    { name: 'no frontmatter', skillDir: 'a', content: '# Just a body\n' },
    { name: 'missing name', skillDir: 'a', content: `---\ndescription: Use when x\n---\n${body}` },
    { name: 'missing description', skillDir: 'a', content: `---\nname: a\n---\n${body}` },
    {
      name: 'quoted value',
      skillDir: 'a',
      content: `---\nname: a\ndescription: "Use when x"\n---\n${body}`,
    },
    {
      name: 'block scalar',
      skillDir: 'a',
      content: `---\nname: a\ndescription: >\n  Use when x\n---\n${body}`,
    },
    {
      name: 'directory and name differ',
      skillDir: 'a',
      content: `---\nname: b\ndescription: Use when x\n---\n${body}`,
    },
    { name: 'skill directory without SKILL.md', skillDir: 'drafts', content: undefined },
  ];

  it.each(rejected)('rejects $name with a SkillManifestError', ({ skillDir, content }) => {
    const dir = pluginWith(skillDir, content);
    let thrown: unknown;
    try {
      listSkills(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SkillManifestError);
    expect(thrown).toMatchObject({ name: 'SkillManifestError' });
  });

  it('accepts a well-formed skill', () => {
    const dir = pluginWith('a', `---\nname: a\ndescription: Use when x\n---\n${body}`);
    expect(listSkills(dir).map((s) => s.name)).toEqual(['a']);
  });

  it('returns nothing when there is no skills directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-skills-'));
    dirs.push(dir);
    expect(listSkills(dir)).toEqual([]);
  });
});

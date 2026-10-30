import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Sentences that tell an agent to run the gate. 10db runs the gate after each implement step, so a
 * sentence that says not to, or that 10db runs it, is fine. The daemon's brief test holds the same check.
 */
function gateInstructions(text: string): string[] {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .split(/(?<=[.!?:;])\s+/)
    .filter((s) => !/\bnever\b|\bnot\b|\bdon't\b|10db (already )?r[au]ns?\b/i.test(s))
    .filter((s) =>
      /make gate|GATE PASS|\b(re-?)?run\b[^.]*\bgate\b|\bexecute\b[^.]*\bgate\b/i.test(s),
    );
}

describe('the gate in the plugin', () => {
  it.each([
    ['Run make gate before you end your turn.', true],
    ['Done means `make gate` printed `GATE PASS`.', true],
    ['Rerun `make gate` until it passes.', true],
    ['Run the full gate before you end your turn.', true],
    ["Run the project's gate command before you say the work is done.", true],
    ['If you find a problem, fix it, then re-run the gate.', true],
    ['Never run the full gate: 10db runs it after your step.', false],
    ['10db already ran the gate; your shell can only read.', false],
    ['Run only the test you changed.', false],
  ])('the check reads %j as an instruction to run the gate: %s', (sentence, caught) => {
    expect(gateInstructions(sentence).length > 0).toBe(caught);
  });

  const files = [
    ...SKILL_NAMES.map((name) => join(HARNESS_PLUGIN_DIR, 'skills', name, 'SKILL.md')),
    ...readdirSync(join(HARNESS_PLUGIN_DIR, 'personas')).map((f) =>
      join(HARNESS_PLUGIN_DIR, 'personas', f),
    ),
  ];

  it.each(files)('%s never tells the agent to run the gate', (file) => {
    expect(gateInstructions(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

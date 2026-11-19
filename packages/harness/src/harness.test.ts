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
import { SKILL_NAMES } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HARNESS_PLUGIN_DIR,
  listSkills,
  MAX_SKILL_BYTES,
  readPluginManifest,
  readSkillBody,
  SkillManifestError,
} from './index';

describe('the shipped harness plugin', () => {
  it('ships its manifest where the daemon injects it and exactly the five craft skills, each small, described and named after its directory', () => {
    expect(existsSync(join(HARNESS_PLUGIN_DIR, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(readPluginManifest().name).toBe('10db-harness');
    const skills = listSkills();
    expect(skills.map((s) => s.name)).toEqual([...SKILL_NAMES].sort());
    for (const name of SKILL_NAMES) {
      const skill = skills.find((s) => s.name === name);
      expect.soft(skill?.bytes, `${name} size`).toBeGreaterThan(200);
      expect.soft(skill?.bytes, `${name} size`).toBeLessThan(MAX_SKILL_BYTES);
      expect.soft(skill?.description, `${name} description`).toMatch(/^Use when /);
    }
    for (const skill of skills)
      expect
        .soft(
          existsSync(join(HARNESS_PLUGIN_DIR, 'skills', skill.name, 'SKILL.md')),
          `${skill.name} directory`,
        )
        .toBe(true);
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

  it('rejects a malformed skill with a SkillManifestError', () => {
    for (const { name, skillDir, content } of rejected) {
      const dir = pluginWith(skillDir, content);
      let thrown: unknown;
      try {
        listSkills(dir);
      } catch (error) {
        thrown = error;
      }
      expect.soft(thrown, name).toBeInstanceOf(SkillManifestError);
      expect.soft(thrown, name).toMatchObject({ name: 'SkillManifestError' });
    }
  });

  it('accepts a well-formed skill, and returns nothing when there is no skills directory', () => {
    const dir = pluginWith('a', `---\nname: a\ndescription: Use when x\n---\n${body}`);
    expect(listSkills(dir).map((s) => s.name)).toEqual(['a']);
    const empty = mkdtempSync(join(tmpdir(), 'harness-skills-'));
    dirs.push(empty);
    expect(listSkills(empty)).toEqual([]);
  });
});

describe('readSkillBody', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('gives each shipped skill without its frontmatter', () => {
    for (const name of SKILL_NAMES) {
      const body = readSkillBody(name);
      expect.soft(body, name).not.toBeNull();
      expect.soft(body, name).not.toMatch(/^---/);
      expect.soft(body, name).not.toContain(`name: ${name}`);
      expect.soft(body?.length, name).toBeGreaterThan(100);
    }
  });

  it('reads from the directory it is given, and gives null for a name that is no skill there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-body-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'skills', 'planning'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'planning', 'SKILL.md'),
      '---\nname: planning\ndescription: Use when x\n---\n\n# Plan\nStep one.\n',
    );
    expect(readSkillBody('planning', dir)).toBe('# Plan\nStep one.');
    for (const [what, name] of [
      ['a name that is not a craft skill', 'drafts'],
      ['a path out of the skills directory', '../personas/planner'],
      ['a craft skill the directory lacks', 'handoff'],
    ] as const)
      expect.soft(readSkillBody(name, dir), `${what}: ${name}`).toBeNull();
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
  it('reads a sentence as an instruction to run the gate only when it tells the agent to', () => {
    for (const [sentence, caught] of [
      ['Run make gate before you end your turn.', true],
      ['Done means `make gate` printed `GATE PASS`.', true],
      ['Rerun `make gate` until it passes.', true],
      ['Run the full gate before you end your turn.', true],
      ["Run the project's gate command before you say the work is done.", true],
      ['If you find a problem, fix it, then re-run the gate.', true],
      ['Never run the full gate: 10db runs it after your step.', false],
      ['10db already ran the gate; your shell can only read.', false],
      ['Run only the test you changed.', false],
    ] as const)
      expect.soft(gateInstructions(sentence).length > 0, sentence).toBe(caught);
  });

  it('never tells the agent to run the gate in a skill or a persona', () => {
    const files = [
      ...SKILL_NAMES.map((name) => join(HARNESS_PLUGIN_DIR, 'skills', name, 'SKILL.md')),
      ...readdirSync(join(HARNESS_PLUGIN_DIR, 'personas')).map((f) =>
        join(HARNESS_PLUGIN_DIR, 'personas', f),
      ),
    ];
    for (const file of files)
      expect.soft(gateInstructions(readFileSync(file, 'utf8')), file).toEqual([]);
  });
});

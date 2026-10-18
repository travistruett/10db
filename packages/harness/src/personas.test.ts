import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PERSONA_BYTES,
  PERSONA_KEYS,
  PersonaManifestError,
  readDefaultPersonas,
  SKILL_NAMES,
} from './index';

describe('default personas', () => {
  it('ships one persona per role, each small, with instructions', () => {
    const personas = readDefaultPersonas();
    expect(personas.map((p) => p.key)).toEqual([...PERSONA_KEYS]);
    expect(new Set(personas.map((p) => p.role))).toEqual(
      new Set(['plan', 'plan_review', 'implement', 'review', 'qa']),
    );
    for (const p of personas) {
      expect(p.instructions.length, p.key).toBeGreaterThan(200);
      // Plugin text names 10db's tools in full (packages/harness/AGENTS.md).
      expect(p.instructions, p.key).not.toMatch(
        /`(complete_step|ask_human|commit|write_handoff|report_deviation)`/,
      );
      for (const skill of p.skills) expect(SKILL_NAMES, `${p.key} skill ${skill}`).toContain(skill);
      expect(Buffer.byteLength(p.instructions), p.key).toBeLessThan(MAX_PERSONA_BYTES);
      expect(p.tools, p.key).toBe(p.role === 'implement' ? 'edit' : 'read_only');
    }
  });
});

describe('malformed persona files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function pluginWith(file: string, text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'persona-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'personas'));
    writeFileSync(join(dir, 'personas', file), text);
    return dir;
  }
  const body = `\n${'Read the change carefully. '.repeat(12)}\n`;

  it.each([
    { name: 'no frontmatter', file: 'a.md', text: body },
    {
      name: 'an unknown role',
      file: 'a.md',
      text: `---\nname: A\nrole: boss\ntools: edit\n---${body}`,
    },
    {
      name: 'a reviewer that edits',
      file: 'a.md',
      text: `---\nname: A\nrole: review\ntools: edit\n---${body}`,
    },
    {
      name: 'a file name that is not a key',
      file: 'Big Name.md',
      text: `---\nname: A\nrole: qa\ntools: read_only\n---${body}`,
    },
    {
      name: 'an empty body',
      file: 'a.md',
      text: '---\nname: A\nrole: qa\ntools: read_only\n---\n',
    },
    {
      name: 'a body over the cap',
      file: 'a.md',
      text: `---\nname: A\nrole: qa\ntools: read_only\n---\n${'x'.repeat(MAX_PERSONA_BYTES)}`,
    },
    {
      name: 'a skill the harness does not ship',
      file: 'a.md',
      text: `---\nname: A\nrole: qa\ntools: read_only\nskills: telepathy\n---${body}`,
    },
  ])('rejects $name', ({ file, text }) => {
    expect(() => readDefaultPersonas(pluginWith(file, text))).toThrow(PersonaManifestError);
  });
});

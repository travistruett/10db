import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_PLUGIN_DIR,
  listSkills,
  MAX_SKILL_BYTES,
  readPluginManifest,
  SKILL_NAMES,
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

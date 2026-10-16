import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_PLUGIN_DIR, readPluginManifest } from './index';

describe('harness plugin', () => {
  it('ships a plugin manifest at the path the daemon injects', () => {
    expect(existsSync(join(HARNESS_PLUGIN_DIR, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('has a valid manifest named 10db-harness', () => {
    expect(readPluginManifest().name).toBe('10db-harness');
  });
});

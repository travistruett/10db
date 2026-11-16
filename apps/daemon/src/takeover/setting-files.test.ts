import { describe, expect, it } from 'vitest';
import { settingFilesChanged } from './setting-files';

// Sessions spec §7.5: the project files Open in Terminal won't load, named in the popover so the builder
// isn't surprised that a hook or a setting they changed has no effect.

const CHECKOUT = '/work/shop';

describe('settingFilesChanged', () => {
  it.each([
    {
      name: 'a settings file',
      changed: ['.claude/settings.json'],
      kept: ['.claude/settings.json'],
    },
    {
      name: 'the local settings file and .mcp.json',
      changed: ['.claude/settings.local.json', '.mcp.json', 'src/a.ts'],
      kept: ['.claude/settings.local.json', '.mcp.json'],
    },
    {
      name: 'a case-folded spelling, as the file system reads it',
      changed: ['.Claude/Settings.JSON'],
      kept: ['.Claude/Settings.JSON'],
      darwinOnly: true,
    },
    {
      name: 'a decomposed spelling of a protected name',
      changed: ['.claude/skills/café/SKILL.md'],
      kept: ['.claude/skills/café/SKILL.md'],
    },
    {
      name: 'a deep file in a protected folder',
      changed: ['.claude/hooks/a/b/c/pre.sh'],
      kept: ['.claude/hooks/a/b/c/pre.sh'],
    },
    {
      name: 'the .codex folder',
      changed: ['.codex/config.toml', '.codex/hooks/x'],
      kept: ['.codex/config.toml', '.codex/hooks/x'],
    },
    {
      name: 'names that only look like them',
      changed: [
        '.claude/settings.jsonx',
        '.claude/hooksy/a',
        'docs/.claude/settings.json',
        '.codexrc',
        'src/.mcp.json',
      ],
      kept: [],
    },
    { name: 'nothing changed', changed: [], kept: [] },
  ])('keeps $name', ({ changed, kept, darwinOnly }) => {
    if (darwinOnly === true && process.platform !== 'darwin') return;
    expect(settingFilesChanged(changed, CHECKOUT)).toEqual(kept);
  });
});

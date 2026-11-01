import { describe, expect, it } from 'vitest';
import {
  isSettingsSectionKey,
  SETTINGS_SECTIONS,
  SettingsGroup,
  SettingsSectionKey,
} from './sections';

describe('settings sections', () => {
  it('lists every key once, project sections first', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual([
      'general',
      'board-columns',
      'areas',
      'network-hosts',
      'billing',
      'team',
      'routing-rules',
      'keep-awake',
      'lane-permissions',
      'accounts',
      'decisions',
      'models',
      'personas-and-flows',
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.key)).size).toBe(
      Object.values(SettingsSectionKey).length,
    );
  });

  it('names its groups project and global', () => {
    expect(SettingsGroup).toEqual({ Project: 'project', Global: 'global' });
  });

  it.each([
    { key: 'general', planned: false },
    { key: 'board-columns', planned: false },
    { key: 'areas', planned: false },
    { key: 'network-hosts', planned: false },
    { key: 'billing', planned: false },
    { key: 'keep-awake', planned: false },
    { key: 'lane-permissions', planned: false },
    { key: 'team', planned: true },
    { key: 'routing-rules', planned: true },
    { key: 'accounts', planned: false },
    { key: 'decisions', planned: false },
    { key: 'models', planned: true },
    { key: 'personas-and-flows', planned: true },
  ])('marks $key planned: $planned', ({ key, planned }) => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === key)?.planned !== null).toBe(planned);
  });

  it.each([
    { value: 'general', ok: true },
    { value: 'accounts', ok: true },
    { value: 'General', ok: false },
    { value: 'nope', ok: false },
  ])('recognizes $value as a section: $ok', ({ value, ok }) => {
    expect(isSettingsSectionKey(value)).toBe(ok);
  });
});

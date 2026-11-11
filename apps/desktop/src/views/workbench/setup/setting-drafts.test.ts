import { SettingField, type SettingSuggestion } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { settingDrafts, settingsPatch, tickedSettings, type SettingDraft } from './setting-drafts';

const SUGGESTED: SettingSuggestion[] = [
  { field: SettingField.AppUrl, value: 'http://localhost:8800', source: 'from compose' },
  { field: SettingField.DevLoginCommand, value: 'make login', source: 'from run.sh' },
  { field: SettingField.ChangedCheckCommand, value: 'pnpm lint', source: 'from package.json' },
  {
    field: SettingField.SandboxDocker,
    value: true,
    source: 'the gate runs docker',
    note: 'warning',
  },
];

const edit = (drafts: SettingDraft[], field: SettingField, change: Partial<SettingDraft>) =>
  drafts.map((d) => (d.field === field ? { ...d, ...change } : d));

describe('settingDrafts', () => {
  it('ticks every suggestion with its value', () => {
    expect(settingDrafts(SUGGESTED).map((d) => [d.field, d.ticked, d.value])).toEqual([
      [SettingField.AppUrl, true, 'http://localhost:8800'],
      [SettingField.DevLoginCommand, true, 'make login'],
      [SettingField.ChangedCheckCommand, true, 'pnpm lint'],
      [SettingField.SandboxDocker, true, ''],
    ]);
  });
});

describe('settingsPatch', () => {
  it.each([
    {
      name: 'every ticked row',
      drafts: settingDrafts(SUGGESTED),
      patch: {
        appUrl: 'http://localhost:8800',
        devLoginCommand: 'make login',
        changedCheckCommand: 'pnpm lint',
        sandboxDocker: true,
      },
      count: 4,
    },
    {
      name: 'an edited value, trimmed',
      drafts: edit(settingDrafts(SUGGESTED.slice(0, 1)), SettingField.AppUrl, {
        value: ' http://localhost:3000 ',
      }),
      patch: { appUrl: 'http://localhost:3000' },
      count: 1,
    },
    {
      name: 'an unticked row is left out, Docker included (no opt-out)',
      drafts: edit(
        edit(settingDrafts(SUGGESTED), SettingField.SandboxDocker, { ticked: false }),
        SettingField.DevLoginCommand,
        { ticked: false },
      ),
      patch: { appUrl: 'http://localhost:8800', changedCheckCommand: 'pnpm lint' },
      count: 2,
    },
    {
      name: 'a ticked row emptied is left out',
      drafts: edit(settingDrafts(SUGGESTED.slice(2, 3)), SettingField.ChangedCheckCommand, {
        value: '  ',
      }),
      patch: {},
      count: 0,
    },
  ])('$name', ({ drafts, patch, count }) => {
    expect(settingsPatch(drafts)).toEqual(patch);
    expect(tickedSettings(drafts)).toBe(count);
  });
});

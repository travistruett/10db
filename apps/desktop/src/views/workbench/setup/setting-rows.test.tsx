import { SettingField, type SettingSuggestion } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../../../test/theme';
import { settingDrafts, settingsPatch } from './setting-drafts';
import { SettingRows } from './setting-rows';

const SUGGESTED: SettingSuggestion[] = [
  {
    field: SettingField.AppUrl,
    value: 'http://localhost:8800',
    source: 'from docker-compose.yml: proxy publishes 8800',
    note: 'Nothing answered there just now: start your dev server',
  },
  { field: SettingField.ChangedCheckCommand, value: 'pnpm lint', source: 'from web/package.json' },
  {
    field: SettingField.SandboxDocker,
    value: true,
    source: 'the gate command runs docker',
    note: 'Docker can mount any host folder into a container.',
  },
];

function Harness() {
  const [drafts, setDrafts] = useState(() => settingDrafts(SUGGESTED));
  return (
    <>
      <output aria-label="patch">{JSON.stringify(settingsPatch(drafts))}</output>
      <SettingRows
        drafts={drafts}
        onChange={(field, change) => {
          setDrafts((list) => list.map((d) => (d.field === field ? { ...d, ...change } : d)));
        }}
      />
    </>
  );
}

/** The patch Apply would send, as the harness shows it. */
const patch = (): unknown => JSON.parse(screen.getByLabelText('patch').textContent);

describe('SettingRows', () => {
  it('shows each suggestion ticked, with its value, where it was found and its note', () => {
    renderWithTheme(<Harness />);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'App address' }).checked).toBe(
      true,
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'App address value' }).value).toBe(
      'http://localhost:8800',
    );
    expect(screen.getByText('from docker-compose.yml: proxy publishes 8800')).toBeTruthy();
    expect(screen.getByText('Nothing answered there just now: start your dev server')).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Check after each turn' }).checked,
    ).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Allow Docker value' })).toBeNull();
  });

  it('edits a value and unticks a row, and the patch follows', () => {
    renderWithTheme(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'App address value' }), {
      target: { value: 'http://localhost:3000' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check after each turn' }));
    expect(patch()).toEqual({ appUrl: 'http://localhost:3000', sandboxDocker: true });
  });

  it("shows Docker's warning while it is ticked, and not once it is unticked", () => {
    renderWithTheme(<Harness />);
    expect(screen.getByText('Docker can mount any host folder into a container.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow Docker' }));
    expect(screen.queryByText('Docker can mount any host folder into a container.')).toBeNull();
    expect(patch()).toEqual({
      appUrl: 'http://localhost:8800',
      changedCheckCommand: 'pnpm lint',
    });
  });
});

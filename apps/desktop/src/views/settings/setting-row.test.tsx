import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { SettingRow, SettingsCard } from './setting-row';

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);

describe('SettingRow', () => {
  it('puts the control beside the text', () => {
    wrap(
      <SettingRow label="Name" description="What it is called">
        <input aria-label="Name field" />
      </SettingRow>,
    );
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('What it is called')).toBeTruthy();
    const control = screen.getByLabelText('Name field');
    expect(control.parentElement?.parentElement?.contains(screen.getByText('Name'))).toBe(true);
    expect(control.parentElement?.contains(screen.getByText('Name'))).toBe(false);
  });

  it('stacks a wide control under the text', () => {
    wrap(
      <SettingRow label="Commands" stacked>
        <textarea aria-label="Commands field" />
      </SettingRow>,
    );
    const control = screen.getByLabelText('Commands field');
    // Stacked: the control and the text share one parent.
    expect(control.parentElement?.contains(screen.getByText('Commands'))).toBe(true);
  });
});

describe('SettingsCard', () => {
  it('skips null rows without doubling dividers', () => {
    wrap(
      <SettingsCard title="Card">
        <SettingRow label="One">
          <input aria-label="one" />
        </SettingRow>
        {null}
        <SettingRow label="Two">
          <input aria-label="two" />
        </SettingRow>
      </SettingsCard>,
    );
    expect(screen.getByRole('heading', { name: 'Card', level: 5 })).toBeTruthy();
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });
});

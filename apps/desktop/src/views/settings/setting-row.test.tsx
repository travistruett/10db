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

describe('SettingRow description', () => {
  it.each([
    { name: 'a plain input', control: <input aria-label="Field" />, stacked: false },
    {
      name: 'a textarea in a stacked row',
      control: <textarea aria-label="Field" />,
      stacked: true,
    },
    {
      name: 'a group of radios',
      control: (
        <div role="radiogroup" aria-label="Field">
          <input type="radio" aria-label="One" />
        </div>
      ),
      stacked: false,
    },
  ])('links its line to the control: $name', ({ control, stacked }) => {
    wrap(
      <SettingRow label="Name" description="What it is called" stacked={stacked}>
        {control}
      </SettingRow>,
    );
    const target = screen.getByLabelText('Field');
    const id = target.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toBe('What it is called');
  });

  it('keeps a description the control already has', () => {
    wrap(
      <SettingRow label="Name" description="What it is called">
        <input aria-label="Field" aria-describedby="own" />
      </SettingRow>,
    );
    const ids = (screen.getByLabelText('Field').getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toContain('own');
    expect(ids).toHaveLength(2);
  });

  it('adds nothing without a description', () => {
    wrap(
      <SettingRow label="Name">
        <input aria-label="Field" />
      </SettingRow>,
    );
    expect(screen.getByLabelText('Field').hasAttribute('aria-describedby')).toBe(false);
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

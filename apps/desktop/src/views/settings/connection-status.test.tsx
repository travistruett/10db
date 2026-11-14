import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../../test/theme';
import { ConnectionStatus } from './connection-status';

describe('ConnectionStatus', () => {
  it.each([
    { tone: 'works', color: 'teal' },
    { tone: 'needs-you', color: 'yellow' },
    { tone: 'off', color: 'gray' },
  ] as const)('shows $tone as a $color dot beside its words', ({ tone, color }) => {
    renderWithTheme(<ConnectionStatus tone={tone} label="Signed in as ada" />);
    expect(screen.getByText('Signed in as ada')).toBeTruthy();
    const dot = screen.getByTestId('connection-dot');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.getAttribute('data-color')).toBe(color);
    expect(dot.style.background).toBe(`var(--mantine-color-${color}-filled)`);
  });
});

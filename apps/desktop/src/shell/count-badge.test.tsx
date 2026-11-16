import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CountBadge, CountTone } from './count-badge';

describe('CountBadge', () => {
  it.each([
    { name: 'neutral by default', tone: CountTone.Neutral, variant: 'light' },
    { name: 'filled when it needs the builder', tone: CountTone.Attention, variant: 'filled' },
  ])('$name', ({ tone, variant }) => {
    render(
      <MantineProvider>
        {tone === CountTone.Neutral ? (
          <CountBadge count={3} />
        ) : (
          <CountBadge count={3} tone={tone} />
        )}
      </MantineProvider>,
    );
    const badge = screen.getByText('3').closest('.mantine-Badge-root');
    expect(badge?.getAttribute('data-variant')).toBe(variant);
  });

  it('reads the phrase, not the bare number, to assistive tech', () => {
    render(
      <MantineProvider>
        <CountBadge count={2} tone={CountTone.Attention} phrase="2 open cards" />
      </MantineProvider>,
    );
    expect(screen.getByText('2 open cards')).toBeTruthy();
    expect(screen.getByText('2').getAttribute('aria-hidden')).toBe('true');
  });
});

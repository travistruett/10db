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

  it.each([
    { count: 99, cap: 99, shown: '99' },
    { count: 100, cap: 99, shown: '99+' },
    { count: 1234, cap: undefined, shown: '1234' },
  ])('shows $count as $shown with a cap of $cap', ({ count, cap, shown }) => {
    render(
      <MantineProvider>
        {cap === undefined ? <CountBadge count={count} /> : <CountBadge count={count} cap={cap} />}
      </MantineProvider>,
    );
    expect(screen.getByText(shown)).toBeTruthy();
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

  it("draws an attention count in the theme's primary colour", () => {
    render(
      <MantineProvider theme={{ primaryColor: 'grape' }}>
        <CountBadge count={4} tone={CountTone.Attention} />
      </MantineProvider>,
    );
    const badge = screen.getByText('4').closest('.mantine-Badge-root');
    expect(badge?.getAttribute('style')).toContain('grape');
  });
});

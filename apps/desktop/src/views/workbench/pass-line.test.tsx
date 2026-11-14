import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { askItem, PASS_NOW, pagesByStatus, passViewDto } from '../../test/pass-fixtures';
import { renderWithTheme } from '../../test/theme';
import { PassLine } from './pass-line';

describe('PassLine', () => {
  it.each([
    { name: 'pages waiting on the builder', asks: true, line: 'Settings pass · 3 waiting' },
    { name: 'its question answered', asks: false, line: 'Settings pass · 2 waiting' },
  ])('names the pass and what waits, and opens it: $name', ({ asks, line }) => {
    const pages = pagesByStatus();
    const onOpen = vi.fn();
    renderWithTheme(
      <PassLine
        view={passViewDto({ pages: [pages.ready, pages.asks, pages.failed, pages.working] })}
        inbox={asks ? [askItem(pages.asks)] : []}
        now={Date.parse(PASS_NOW)}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: line }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says a pass with nothing waiting by its name alone', () => {
    const { working } = pagesByStatus();
    renderWithTheme(
      <PassLine
        view={passViewDto({ pages: [working] })}
        inbox={[]}
        now={Date.parse(PASS_NOW)}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Settings pass' })).toBeTruthy();
  });
});

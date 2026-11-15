import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { ContextRing } from './context-ring';

describe('ContextRing', () => {
  it('says the percent used, rounded, with any more lines after it', () => {
    renderWithTheme(<ContextRing percent={41.4} more={['$0.42 so far']} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      '41% of the context used. $0.42 so far',
    );
  });

  it('draws nothing before the agent has reported any use', () => {
    renderWithTheme(<ContextRing percent={null} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

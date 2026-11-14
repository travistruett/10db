import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourcedNumber } from './sourced-number';

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);

describe('SourcedNumber', () => {
  it('describes its number with the source, for a screen reader', () => {
    wrap(<SourcedNumber text="41.5" source="Artificial Analysis" />);
    const described = screen.getByText('41.5').getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described ?? '')?.textContent).toBe('Artificial Analysis');
  });

  it('is the text alone with no source', () => {
    wrap(<SourcedNumber text="—" source={null} />);
    expect(screen.getByText('—').getAttribute('aria-describedby')).toBeNull();
  });
});

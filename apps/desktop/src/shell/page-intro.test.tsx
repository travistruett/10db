import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageTabs } from './page-intro';

describe('PageTabs', () => {
  // Factory forgot the project Metrics chose by itself when the open tab was clicked again, so Live stayed narrowed.
  it('tells the page only about a tab that changes', () => {
    const onChange = vi.fn();
    render(
      <MantineProvider>
        <PageTabs
          label="Factory view"
          tabs={[
            { value: 'live', label: 'Live' },
            { value: 'metrics', label: 'Metrics' },
          ]}
          value="metrics"
          onChange={onChange}
        />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Live' }));
    expect(onChange).toHaveBeenCalledWith('live');
  });
});

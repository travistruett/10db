import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ViewBoundary } from './view-boundary';

const shouldCrash = vi.fn(() => true);

function Flaky() {
  if (shouldCrash()) throw new Error('kaboom');
  return <p>Back to normal</p>;
}

describe('ViewBoundary', () => {
  it('contains a crash to the view and recovers on reload', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <MantineProvider>
        <ViewBoundary name="Factory">
          <Flaky />
        </ViewBoundary>
      </MantineProvider>,
    );
    expect(screen.getByText('Something went wrong in Factory.')).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    shouldCrash.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reload view' }));
    expect(screen.getByText('Back to normal')).toBeTruthy();
    quiet.mockRestore();
  });
});

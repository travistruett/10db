import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_LOADING_DELAY_MS, PageLoading, PageLoadingShape } from './page-loading';

const skeletons = () => document.querySelectorAll('.mantine-Skeleton-root');

describe('PageLoading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { shape: PageLoadingShape.List, rows: 2, drawn: 6 },
    { shape: PageLoadingShape.Cards, rows: 2, drawn: 6 },
    { shape: PageLoadingShape.Lines, rows: 3, drawn: 3 },
  ])('draws nothing for a quick load, then $rows $shape rows', ({ shape, rows, drawn }) => {
    render(
      <MantineProvider>
        <PageLoading shape={shape} rows={rows} label="Loading the pages" />
      </MantineProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(PAGE_LOADING_DELAY_MS - 1);
    });
    expect(skeletons()).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status', { name: 'Loading the pages' })).toBeTruthy();
    expect(skeletons()).toHaveLength(drawn);
  });
});

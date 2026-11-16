import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './page-header';

function renderHeader(header: React.ReactElement) {
  return render(<MantineProvider>{header}</MantineProvider>);
}

describe('PageHeader', () => {
  it('draws every row it is given, title first', () => {
    renderHeader(
      <PageHeader
        title="Inbox"
        titleAside={<span>Synced</span>}
        description="Things that need you"
        actions={<button type="button">Do it</button>}
        toolbar={<span>Tabs</span>}
      />,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Inbox' });
    expect(screen.getByText('Synced')).toBeTruthy();
    expect(screen.getByText('Things that need you')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Do it' })).toBeTruthy();
    expect(screen.getByText('Tabs')).toBeTruthy();
    // The title row holds the title and the actions; the byline and toolbar follow it.
    const titleRow = heading.parentElement?.parentElement;
    expect(titleRow?.contains(screen.getByRole('button', { name: 'Do it' }))).toBe(true);
    expect(titleRow?.contains(screen.getByText('Things that need you'))).toBe(false);
  });

  it('takes no space for rows that are absent', () => {
    const { container } = renderHeader(<PageHeader title="Board" />);
    expect(screen.getByRole('heading', { name: 'Board' })).toBeTruthy();
    // Only the title row is drawn.
    expect(container.querySelector('p')).toBeNull();
    const stack = screen.getByRole('heading').parentElement?.parentElement?.parentElement;
    expect(stack?.children).toHaveLength(1);
    expect(screen.getByRole('heading').parentElement?.parentElement?.children).toHaveLength(1);
  });
});

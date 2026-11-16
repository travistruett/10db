import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './page-header';

function renderHeader(header: React.ReactElement) {
  const { container } = render(<MantineProvider>{header}</MantineProvider>);
  // The header is the one element the provider's own style tags sit beside.
  const root = container.querySelector(':scope > div');
  if (root === null) throw new Error('PageHeader drew nothing');
  return root;
}

describe('PageHeader', () => {
  it('draws every row it is given: title and actions, then byline, then toolbar', () => {
    const header = renderHeader(
      <PageHeader
        title="Inbox"
        titleAside={<span>Synced</span>}
        description="Things that need you"
        actions={<button type="button">Do it</button>}
        toolbar={<span>Tabs</span>}
      />,
    );
    const [titleRow, byline, toolbar] = header.children;
    expect(header.children).toHaveLength(3);
    expect(titleRow?.contains(screen.getByRole('heading', { level: 2, name: 'Inbox' }))).toBe(true);
    expect(titleRow?.contains(screen.getByText('Synced'))).toBe(true);
    expect(titleRow?.contains(screen.getByRole('button', { name: 'Do it' }))).toBe(true);
    expect(byline?.textContent).toBe('Things that need you');
    expect(toolbar?.textContent).toBe('Tabs');
  });

  it('takes no space for rows that are absent', () => {
    const header = renderHeader(<PageHeader title="Board" />);
    expect(header.children).toHaveLength(1);
    expect(header.textContent).toBe('Board');
  });

  it('gives a text byline its whole text as a tooltip, since it is cut to one line', () => {
    renderHeader(<PageHeader title="Knowledge" description="A long byline" />);
    expect(screen.getByText('A long byline').getAttribute('title')).toBe('A long byline');
  });
});

import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageIntro } from './page-intro';

function renderIntro(intro: React.ReactElement) {
  const { container } = render(<MantineProvider>{intro}</MantineProvider>);
  // The intro is the one element the provider's own style tags sit beside.
  return container.querySelector(':scope > div');
}

describe('PageIntro', () => {
  it('draws the byline, then the toolbar', () => {
    const intro = renderIntro(
      <PageIntro description="Things that need you" toolbar={<span>Tabs</span>} />,
    );
    expect(intro?.children).toHaveLength(2);
    expect(intro?.children[0]?.textContent).toBe('Things that need you');
    expect(intro?.children[1]?.textContent).toBe('Tabs');
  });

  it('takes no space for rows that are absent', () => {
    expect(renderIntro(<PageIntro />)).toBeNull();
    expect(renderIntro(<PageIntro toolbar={<span>Tabs</span>} />)?.children).toHaveLength(1);
  });

  it.each([
    {
      name: 'a text byline has its whole text',
      description: 'A long byline',
      title: 'A long byline',
    },
    { name: 'a byline of markup has none', description: <em>A long byline</em>, title: null },
  ])('tooltip, since the byline is cut to one line: $name', ({ description, title }) => {
    const intro = renderIntro(<PageIntro description={description} />);
    expect(intro?.children[0]?.getAttribute('title')).toBe(title);
  });
});

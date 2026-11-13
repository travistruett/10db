import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { Markdown } from './index';

// Markdown an agent or a planning effort wrote is drawn, never trusted: no image, frame or script
// loads, and no link navigates the window. Links render as their text and address until the opener
// that confirms before it opens exists.

/** Draws `text` and answers the element that holds it, without the theme's style tags. */
function draw(text: string): HTMLElement {
  renderWithTheme(
    <div data-testid="markdown">
      <Markdown text={text} />
    </div>,
  );
  return screen.getByTestId('markdown');
}

/** What every row holds: nothing that fetches, runs or navigates. */
function expectInert(container: HTMLElement): void {
  expect(
    container.querySelectorAll('img, iframe, script, video, audio, link, object'),
  ).toHaveLength(0);
  expect(container.querySelectorAll('[src]')).toHaveLength(0);
  expect(container.querySelectorAll('a, [href]')).toHaveLength(0);
}

/** The text a reader sees, with runs of white space as one space. */
const text = (c: HTMLElement): string => c.textContent.replace(/\s+/g, ' ');

const MERMAID = ['```mermaid', 'graph TD; A-->B', '```'].join('\n');

describe('hostile markdown', () => {
  it.each<[string, string, (c: HTMLElement) => void]>([
    [
      'image beacon',
      '![x](https://evil.example/b.png)',
      (c) => {
        expect(text(c)).toContain('Image not shown: x');
      },
    ],
    [
      'reference image',
      '![x][r]\n\n[r]: https://evil.example/b.png',
      (c) => {
        expect(text(c)).toContain('Image not shown: x');
      },
    ],
    [
      'raw img shows as its text',
      '<img src="https://evil.example/b.png">',
      (c) => {
        expect(text(c)).toContain('<img src="https://evil.example/b.png">');
      },
    ],
    [
      'data image',
      '![d](data:image/png;base64,iVBORw0KGgo=)',
      (c) => {
        expect(text(c)).toContain('Image not shown: d');
      },
    ],
    [
      'javascript link',
      '[click](javascript:alert(1))',
      (c) => {
        expect(text(c)).toContain('click');
        expect(text(c)).not.toContain('javascript');
      },
    ],
    [
      'http link',
      '[plain](http://plain.example/)',
      (c) => {
        expect(text(c)).toContain('plain');
      },
    ],
    [
      'script shows as its text',
      '<script>alert(1)</script>',
      (c) => {
        expect(text(c)).toContain('<script>alert(1)</script>');
      },
    ],
    [
      'iframe shows as its text',
      '<iframe src="https://evil.example"></iframe>',
      (c) => {
        expect(text(c)).toContain('<iframe src="https://evil.example"></iframe>');
      },
    ],
    [
      'raw anchor shows as its text',
      '<a href="https://evil.example">raw</a>',
      (c) => {
        expect(text(c)).toContain('<a href="https://evil.example">raw</a>');
      },
    ],
    [
      'angle brackets in prose stay',
      'Reach <host> on <fqdn>; it answers Promise<void>.',
      (c) => {
        expect(text(c)).toContain('Reach <host> on <fqdn>; it answers Promise<void>.');
      },
    ],
    [
      'an html block shows as its text',
      '<div>\nkept\n</div>\n\nafter',
      (c) => {
        expect(text(c)).toContain('<div> kept </div>');
        expect(text(c)).toContain('after');
      },
    ],
    [
      'the text docs and https://ok.example/a show; no link',
      '[docs](https://ok.example/a)',
      (c) => {
        expect(text(c)).toContain('docs (https://ok.example/a)');
      },
    ],
    [
      'an autolink shows its address once; no link',
      'see https://ok.example/b',
      (c) => {
        expect(text(c)).toContain('see https://ok.example/b');
        expect(c.textContent.match(/ok\.example/g)).toHaveLength(1);
      },
    ],
    [
      'dollars',
      'costs $5 and $6, or $$x$$',
      (c) => {
        expect(text(c)).toContain('costs $5 and $6, or $$x$$');
        expect(c.querySelectorAll('math, .katex')).toHaveLength(0);
      },
    ],
    [
      'mermaid fence',
      MERMAID,
      (c) => {
        expect(c.querySelector('pre')?.textContent).toContain('graph TD; A-->B');
        expect(c.querySelectorAll('svg')).toHaveLength(0);
      },
    ],
  ])('%s', (_, input, also) => {
    const container = draw(input);
    expectInert(container);
    also(container);
  });
});

describe('markdown elements', () => {
  it('draws headings at their levels', () => {
    draw('# Title\n\n### Small');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' }).tagName).toBe('H1');
    expect(screen.getByRole('heading', { level: 3, name: 'Small' }).tagName).toBe('H3');
  });

  it('draws a list of two items', () => {
    draw('- a\n- b');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('draws inline code as code', () => {
    const c = draw('call `x` now');
    expect(c.querySelector('code')?.textContent).toBe('x');
    expect(c.querySelector('pre')).toBeNull();
  });

  it('draws a GFM table with its header cells', () => {
    draw('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(screen.getByRole('table').tagName).toBe('TABLE');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['a', 'b']);
  });

  it('draws a blockquote', () => {
    const c = draw('> q');
    expect(c.querySelector('blockquote')?.textContent).toContain('q');
  });

  it('draws a fence cut short as a code block, without its backticks', () => {
    const c = draw('Here:\n```ts\nconst a =');
    expect(c.querySelector('pre code')?.textContent).toContain('const a =');
    expect(text(c)).not.toContain('```');
  });
});

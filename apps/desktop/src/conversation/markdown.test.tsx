import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { Markdown } from './index';
import { LinkConfirmHost } from './link-confirm';
import { MarkdownBoundary } from './markdown-boundary';

// Markdown an agent or a planning effort wrote is drawn, never trusted: no image, frame or script
// loads, and no link navigates the window. An `https:` link reads as a link and opens only after the
// builder confirms its host, and its address is never in the page, so no middle-click, context menu
// or drag opens it unasked; every other link is its text.

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
  expect(container.querySelectorAll('[href]')).toHaveLength(0);
}

/** The links a reader can follow, by their accessible name and the address their title shows. */
const links = (c: HTMLElement): [string, string | null][] =>
  within(c)
    .queryAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('title')]);

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
        expect(links(c)).toEqual([]);
      },
    ],
    [
      'http link',
      '[plain](http://plain.example/)',
      (c) => {
        expect(text(c)).toContain('plain');
        expect(links(c)).toEqual([]);
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
        expect(links(c)).toEqual([]);
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
      'https link',
      '[docs](https://ok.example/a)',
      (c) => {
        expect(links(c)).toEqual([['docs', 'https://ok.example/a']]);
      },
    ],
    [
      'autolink',
      'see https://ok.example/b',
      (c) => {
        expect(links(c)).toEqual([['https://ok.example/b', 'https://ok.example/b']]);
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

describe('a link', () => {
  afterEach(() => {
    clearMocks();
    // clearMocks empties the internals but leaves the object, which is what isTauri looks for.
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.restoreAllMocks();
  });

  it("opens through the shell's confirming command in Tauri, never the opener plugin", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return true;
    });
    draw('[docs](https://ok.example/a)');
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    await vi.waitFor(() => {
      expect(calls).toEqual([{ cmd: 'open_web_link', args: { url: 'https://ok.example/a' } }]);
    });
  });

  it('is focusable and opens on Enter, with no address in the page to open unasked', async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return true;
    });
    const c = draw('[docs](https://ok.example/a)');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(c.querySelectorAll('[href]')).toHaveLength(0);
    expect(link.getAttribute('title')).toBe('https://ok.example/a');
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(calls).toEqual([{ cmd: 'open_web_link', args: { url: 'https://ok.example/a' } }]);
    });
  });

  it('asks in a browser, naming the address host and not the link text, before it opens', async () => {
    const open = vi.spyOn(window, 'open');
    renderWithTheme(<LinkConfirmHost />);
    draw('[github.com](https://evil.example/x)');
    fireEvent.click(screen.getByRole('link', { name: 'github.com' }));
    await screen.findByText('Open evil.example in your browser?');
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
});

describe('a document too deep or too long to draw', () => {
  it.each<[string, string]>([
    ['quotes 5000 deep', `${'>'.repeat(5000)} x`],
    ['lists 1000 deep', `${'- '.repeat(1000)}x`],
    ['over 512 Ki', `${'word '.repeat(110_000)}tail`],
  ])('%s shows whole as plain text', (_, input) => {
    const c = draw(input);
    expect(c.querySelector('pre')?.textContent).toBe(input);
    expect(text(c)).toContain('Shown as plain text');
    expect(c.querySelectorAll('blockquote, ul, li')).toHaveLength(0);
  });

  it('a drawing that throws shows the text plain, and the next text draws again', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Fails(): never {
      throw new RangeError('Maximum call stack size exceeded');
    }
    const { rerender } = renderWithTheme(
      <div data-testid="markdown">
        <MarkdownBoundary text="> kept">
          <Fails />
        </MarkdownBoundary>
      </div>,
    );
    const c = screen.getByTestId('markdown');
    expect(c.querySelector('pre')?.textContent).toBe('> kept');
    expect(text(c)).toContain('Shown as plain text');
    rerender(
      <div data-testid="markdown">
        <MarkdownBoundary text="next">
          <span>drawn</span>
        </MarkdownBoundary>
      </div>,
    );
    expect(text(screen.getByTestId('markdown'))).toBe('drawn');
    quiet.mockRestore();
  });
});

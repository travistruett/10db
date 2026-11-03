import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../test/daemon';
import { theme } from '../../../theme';
import { AttachmentView } from './attachment-view';
import { MOCKUP_CSP, refusingLoader } from './safe-render';

/** The renderers need no daemon: Mantine alone. */
const renderWithDaemon = (ui: ReactElement): void => {
  render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      {ui}
    </MantineProvider>,
  );
};

// Shape spec §10.3: everything the session writes can be shaped by a pasted document, so nothing it
// attaches runs code or reaches the network. A mockup with a script and a fetch, a chart with data.url
// and a Mermaid click directive each render inert.

/** Every request that leaves the page, whatever its host; none should. */
let reached: string[];
beforeEach(() => {
  reached = [];
  server.use(
    http.all('*', ({ request }) => {
      reached.push(request.url);
      return HttpResponse.text('', { status: 404 });
    }),
  );
});

/** jsdom does no layout; Mermaid measures text and boxes, so give every SVG element a size. */
function measureSvg(): void {
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>;
  proto['getBBox'] = () => ({ x: 0, y: 0, width: 80, height: 20 });
  proto['getComputedTextLength'] = () => 80;
}

const decode = (src: string): string =>
  decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));

describe('a mockup', () => {
  const html =
    '<h1>Cards</h1><script>fetch("http://127.0.0.1:4999/projects").then(r => r.text())</script>' +
    '<img src="https://evil.example/x.png"><a href="https://evil.example">out</a>';

  it('renders in an iframe sandboxed with no permissions, through srcdoc', () => {
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mockup', html }} title="Cards" />);
    const frame = screen.getByTitle('Mockup: Cards');
    expect(frame.tagName).toBe('IFRAME');
    // An empty sandbox: no allow-scripts, no allow-same-origin, nothing else.
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('src')).toBeNull();
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain(html);
    expect(doc.indexOf(`content="${MOCKUP_CSP}"`)).toBeGreaterThan(-1);
    expect(doc.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(doc.indexOf(html));
  });

  it('runs no script and reaches nothing from the page', () => {
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mockup', html }} title="Cards" />);
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(document.querySelector('img[src^="https://"]')).toBeNull();
    expect(reached).toEqual([]);
  });

  it('has a policy that refuses every load but inline styles and data images', () => {
    expect(MOCKUP_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  });
});

describe('a chart', () => {
  it('with data.url is not drawn, says why, and loads nothing', async () => {
    renderWithDaemon(
      <AttachmentView
        // A spec that came round the schema: the renderer checks it again.
        attachment={
          {
            kind: 'chart',
            spec: { mark: 'bar', data: { url: 'https://evil.example/data.json' } },
          } as never
        }
        title="Load"
      />,
    );
    expect(await screen.findByText(/names a URL, so it isn’t drawn/)).toBeTruthy();
    expect(document.querySelector('svg.marks, img[alt^="Chart"]')).toBeNull();
    expect(reached).toEqual([]);
  });

  it('draws inline data.values as an image, which runs nothing', async () => {
    renderWithDaemon(
      <AttachmentView
        attachment={{
          kind: 'chart',
          spec: {
            mark: 'bar',
            data: { values: [{ a: 'x', b: 1 }] },
            encoding: {
              x: { field: 'a', type: 'nominal' },
              y: { field: 'b', type: 'quantitative' },
            },
          },
        }}
        title="Load"
      />,
    );
    const img = await screen.findByRole('img', { name: 'Chart: Load' });
    expect(img.tagName).toBe('IMG');
    expect(decode(img.getAttribute('src') ?? '')).toContain('<svg');
    expect(reached).toEqual([]);
  });

  it('has a loader that refuses every load, by URL or file', async () => {
    await expect(refusingLoader.load('https://evil.example/x.json')).rejects.toThrow(
      /loads nothing/,
    );
    await expect(
      refusingLoader.sanitize('data.json', { context: 'dataflow', response: 'json' }),
    ).rejects.toThrow(/loads nothing/);
    await expect(refusingLoader.http('https://evil.example/x.json', {})).rejects.toThrow(
      /loads nothing/,
    );
    await expect(refusingLoader.file('/etc/passwd')).rejects.toThrow(/loads nothing/);
  });
});

describe('a Mermaid diagram', () => {
  beforeEach(measureSvg);

  it('with click directives renders as an image: no link, no handler, no script', async () => {
    const source = [
      'flowchart LR',
      '  A[Start] --> B[Ship]',
      '  click A "https://evil.example" "Go"',
      '  click B call alert("hi")',
      '  click A href "javascript:alert(1)"',
    ].join('\n');
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Flow" />);
    const img = await screen.findByRole('img', { name: 'Diagram: Flow' });
    expect(img.tagName).toBe('IMG');
    const svg = decode(img.getAttribute('src') ?? '');
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/javascript:/i);
    expect(svg).not.toMatch(/\son\w+=/i);
    expect(svg).not.toMatch(/<script/i);
    expect(document.querySelector('a[href], [onclick]')).toBeNull();
    expect(reached).toEqual([]);
  });

  it('says so when the source does not parse, and shows nothing it made', async () => {
    renderWithDaemon(
      <AttachmentView
        attachment={{ kind: 'mermaid', source: 'flowchart LR\n  A -->' }}
        title="Bad"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/couldn’t be drawn/)).toBeTruthy();
    });
  });
});

import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// vega-embed reads usermeta.embedOptions out of the spec and merges it over the caller's options
// (deep-merging into the caller's loader object). ChartSpec lets usermeta through, so a chart's own
// JSON must not be able to change how it is drawn.
describe('a chart whose usermeta.embedOptions tries to change how it is drawn', () => {
  const chart = (
    embedOptions: Record<string, unknown>,
  ): ComponentProps<typeof AttachmentView>['attachment'] =>
    ({
      kind: 'chart',
      spec: {
        mark: 'bar',
        usermeta: { embedOptions },
        data: { values: [{ a: 'x', b: 1 }] },
        encoding: {
          x: { field: 'a', type: 'nominal' },
          y: { field: 'b', type: 'quantitative' },
        },
      },
    }) as never;

  const styleElements = (): HTMLStyleElement[] =>
    Array.from(document.querySelectorAll('style')).filter(
      (el) =>
        el.id === 'vega-embed-style' ||
        el.textContent.includes('display:none') ||
        el.textContent.includes('vega-embed'),
    );

  beforeEach(() => {
    document.getElementById('vega-embed-style')?.remove();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cannot replace the loader: a loader option leaves the refusing loader refusing', async () => {
    renderWithDaemon(
      <AttachmentView
        attachment={chart({
          loader: { load: 1, http: 1, baseURL: 'http://127.0.0.1:4999/' },
        })}
        title="Loader"
      />,
    );
    await screen.findByRole('img', { name: 'Chart: Loader' });
    expect(typeof refusingLoader.load).toBe('function');
    await expect(refusingLoader.load('http://127.0.0.1:4999/x.json')).rejects.toThrow(
      /loads nothing/,
    );
    await expect(refusingLoader.http('http://127.0.0.1:4999/x.json', {})).rejects.toThrow(
      /loads nothing/,
    );
    expect(Object.keys(refusingLoader).sort()).toEqual(['file', 'http', 'load', 'sanitize']);
    expect(reached).toEqual([]);
  });

  it('cannot change the loader for a later chart', async () => {
    const { unmount } = render(
      <MantineProvider theme={theme} defaultColorScheme="dark">
        <AttachmentView
          attachment={chart({ loader: { load: 1, baseURL: 'http://127.0.0.1:4999/' } })}
          title="First"
        />
      </MantineProvider>,
    );
    await screen.findByRole('img', { name: 'Chart: First' });
    unmount();
    // A later chart with no usermeta of its own draws with the loader as the first chart left it.
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
        title="Second"
      />,
    );
    await screen.findByRole('img', { name: 'Chart: Second' });
    expect(typeof refusingLoader.load).toBe('function');
    expect(Object.isFrozen(refusingLoader)).toBe(true);
    expect(reached).toEqual([]);
  });

  it('adds no style element when defaultStyle is true', async () => {
    renderWithDaemon(<AttachmentView attachment={chart({ defaultStyle: true })} title="Style" />);
    await screen.findByRole('img', { name: 'Chart: Style' });
    expect(styleElements()).toEqual([]);
    expect(document.getElementById('vega-embed-style')).toBeNull();
  });

  // A regression guard, not a case the fix turned green: vega-embed 7.3.0 rewrites a usermeta
  // defaultStyle string to false itself. Later versions may not.
  it('adds no style element for a defaultStyle string', async () => {
    renderWithDaemon(
      <AttachmentView
        attachment={chart({ defaultStyle: 'body { display:none }' })}
        title="Style"
      />,
    );
    await screen.findByRole('img', { name: 'Chart: Style' });
    expect(styleElements()).toEqual([]);
    expect(document.getElementById('vega-embed-style')).toBeNull();
  });

  it('adds no style element for a chart that says nothing either', async () => {
    renderWithDaemon(<AttachmentView attachment={chart({})} title="Plain" />);
    await screen.findByRole('img', { name: 'Chart: Plain' });
    expect(document.getElementById('vega-embed-style')).toBeNull();
  });

  it('is drawn without a patch that adds a data URL, and reaches no URL', async () => {
    renderWithDaemon(
      <AttachmentView
        attachment={chart({
          // No `url` key in the JSON, so ChartSpec doesn't see it; the patch swaps inline data for one.
          patch: [
            { op: 'remove', path: '/data/0/values' },
            { op: 'add', path: '/data/0/url', value: 'http://127.0.0.1:4999/projects' },
          ],
        })}
        title="Patch"
      />,
    );
    const img = await screen.findByRole('img', { name: 'Chart: Patch' });
    const svg = decode(img.getAttribute('src') ?? '');
    expect(svg).toContain('<svg');
    // Vega logs a refused load and draws on, with no data: the bar is there only if the patch wasn't applied.
    expect(svg).toMatch(/class="mark-rect role-mark marks"[^>]*><path/);
    expect(reached).toEqual([]);
  });

  it('is drawn without a config loaded from a URL, and reaches no URL', async () => {
    renderWithDaemon(
      <AttachmentView
        attachment={chart({ config: 'http://127.0.0.1:4999/config.json' })}
        title="Config"
      />,
    );
    await screen.findByRole('img', { name: 'Chart: Config' });
    expect(reached).toEqual([]);
  });

  it('is drawn without ast: false, which would compile expressions to code', async () => {
    // The window's CSP has no unsafe-eval, jsdom has no CSP: refuse generated code as the window would.
    const refuseCode = (): never => {
      throw new EvalError('Refused to generate code: the CSP has no unsafe-eval');
    };
    vi.stubGlobal('Function', new Proxy(Function, { apply: refuseCode, construct: refuseCode }));
    renderWithDaemon(<AttachmentView attachment={chart({ ast: false })} title="Ast" />);
    await screen.findByRole('img', { name: 'Chart: Ast' });
    expect(reached).toEqual([]);
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

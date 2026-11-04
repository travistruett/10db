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

  // At 'strict' Mermaid draws into a temporary element in document.body (it needs layout), so anything
  // in it that loads would load while it is drawn. Watch the body for any such element.
  /** Starts watching document.body; the returned function stops and lists the loaders seen. */
  function watchLoaders(): () => string[] {
    const seen: string[] = [];
    const loads = (el: Element): void => {
      const tag = el.tagName.toLowerCase();
      const url =
        el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? el.getAttribute('src');
      // A data: URL fetches nothing (the finished diagram is shown as one); anything else would.
      if (
        (tag === 'image' || tag === 'img' || tag === 'iframe') &&
        url !== null &&
        !url.startsWith('data:')
      ) {
        seen.push(`<${tag} ${url}>`);
      }
      // Mermaid's own CSS has url(#gradient); only a url() to something else, or an @import, loads.
      const css = el.textContent;
      const external = /@import|url\(\s*["']?(?!#)/i.exec(css);
      if (tag === 'style' && external !== null) {
        seen.push(`<style … ${css.slice(Math.max(0, external.index - 20), external.index + 60)}>`);
      }
    };
    const scan = (node: Node): void => {
      if (!(node instanceof Element)) return;
      loads(node);
      node.querySelectorAll('*').forEach(loads);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach(scan);
        scan(record.target);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    // The image shape also does `new Image().src = url` on an element that is never in the document,
    // which loads just the same, so watch every HTMLImageElement's src being set.
    const proto = HTMLImageElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'src');
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get() {
        return original?.get?.call(this) as string;
      },
      set(value: string) {
        if (!value.startsWith('data:')) seen.push(`new Image().src = ${value}`);
        original?.set?.call(this, value);
      },
    });
    return () => {
      if (original) Object.defineProperty(proto, 'src', original);
      observer.takeRecords().forEach((record) => {
        record.addedNodes.forEach(scan);
        scan(record.target);
      });
      observer.disconnect();
      return seen;
    };
  }

  it('with an image shape is not drawn, and puts nothing that loads into the document', async () => {
    const stop = watchLoaders();
    const source = [
      'flowchart LR',
      '  A@{ img: "https://evil.example/pixel.png", label: "Hi" }',
    ].join('\n');
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Pic" />);
    await waitFor(() => {
      expect(screen.getByText(/couldn’t be drawn/)).toBeTruthy();
    });
    expect(stop()).toEqual([]);
    expect(reached).toEqual([]);
  });

  it('with a directive turning HTML labels on draws no HTML label into the document', async () => {
    const stop = watchLoaders();
    const source = [
      '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%',
      'flowchart LR',
      '  A["<img src=\'https://evil.example/pixel.png\'>"] --> B[Ship]',
    ].join('\n');
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Html" />);
    await screen.findByRole('img', { name: 'Diagram: Html' });
    expect(stop()).toEqual([]);
    expect(reached).toEqual([]);
  });

  it('with front-matter turning HTML labels on draws no HTML label into the document', async () => {
    const stop = watchLoaders();
    const source = [
      '---',
      'config:',
      '  htmlLabels: true',
      '  flowchart:',
      '    htmlLabels: true',
      '  themeCSS: "g { background: url(https://evil.example/t.png) }"',
      '---',
      'flowchart LR',
      '  A["<img src=\'https://evil.example/pixel.png\'>"] --> B[Ship]',
    ].join('\n');
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Front" />);
    await screen.findByRole('img', { name: 'Diagram: Front' });
    expect(stop()).toEqual([]);
    expect(reached).toEqual([]);
  });

  // Each of these would load a URL in the temporary element, or before it: none may reach the drawing.
  it.each([
    // The image shape's block is YAML: a `}` in a quoted string does not end it, and escapes decode.
    [
      'an image shape after a quoted }',
      /has an image/,
      'flowchart LR\n  A@{ label: "}", img: "https://evil.example/p.png" }',
    ],
    [
      'an image shape with an escaped key',
      /has an image/,
      String.raw`flowchart LR
  A@{ "\x69mg": "https://evil.example/p.png" }`,
    ],
    [
      'a sequence actor icon',
      /has an image/,
      'sequenceDiagram\n  participant A\n  properties A: {"icon": "https://evil.example/p.png"}',
    ],
    [
      'an architecture text icon, a kind that is not drawn',
      /This kind of diagram/,
      'architecture-beta\n  service a "<img src=https://evil.example/p.png>"[A]',
    ],
    ['a kind that is not drawn, C4', /This kind of diagram/, 'C4Context\n  Person(a, "A")'],
    [
      'a state classDef with a url()',
      /style names a URL/,
      'stateDiagram-v2\n  classDef bad mask-image:url(https://evil.example/m.png)\n  [*] --> A:::bad',
    ],
    [
      // A flowchart's and an ER diagram's grammar has no bracket in a style: these never parse.
      'a flowchart classDef with a url()',
      /Parse error/,
      'flowchart LR\n  classDef bad fill:url(https://evil.example/m.png)\n  A:::bad --> B',
    ],
    [
      'a flowchart style with a url()',
      /Parse error/,
      'flowchart LR\n  A --> B\n  style A fill:url(https://evil.example/m.png)',
    ],
    [
      'a linkStyle with a url()',
      /Parse error/,
      'flowchart LR\n  A --> B\n  linkStyle 0 stroke:url(https://evil.example/m.png)',
    ],
    [
      'an ER style with a url()',
      /Lexical error/,
      'erDiagram\n  A ||--o{ B : has\n  style A fill:url(https://evil.example/m.png)',
    ],
    [
      'a class style with a url()',
      /style names a URL/,
      'classDiagram\n  class A\n  style A fill:url(https://evil.example/m.png)',
    ],
    [
      'a url() with a CSS escape',
      /style names a URL/,
      String.raw`stateDiagram-v2
  classDef bad mask-image:\75 r\l(https://evil.example/m.png)
  [*] --> A:::bad`,
    ],
    [
      'an image-set()',
      /style names a URL/,
      'stateDiagram-v2\n  classDef bad mask-image:image-set("https://evil.example/m.png" 1x)\n  [*] --> A:::bad',
    ],
    [
      'a vendor-prefixed image-set()',
      /style names a URL/,
      'stateDiagram-v2\n  classDef bad mask-image:-webkit-image-set("https://evil.example/m.png" 1x)\n  [*] --> A:::bad',
    ],
    ['a label that is a bare url()', /style names a URL/, 'sequenceDiagram\n  A->>B: url(id)'],
    [
      'a url() split by a directive Mermaid removes',
      /style names a URL/,
      'stateDiagram-v2\n  classDef bad mask-image:ur%%{init: {}}%%l(https://evil.example/m.png)\n  [*] --> A:::bad',
    ],
  ])('with %s is not drawn and loads nothing', async (_name, why, source) => {
    const stop = watchLoaders();
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="No" />);
    expect((await screen.findByText(/couldn’t be drawn/)).textContent).toMatch(why);
    expect(stop()).toEqual([]);
    expect(reached).toEqual([]);
  });

  // These draw, with what would load left out of the temporary element.
  it.each([
    [
      'KaTeX in a flowchart label',
      'flowchart LR\n  A["$$x$$<img src=https://evil.example/p.png>"] --> B',
    ],
    [
      'KaTeX in a class label',
      'classDiagram\n  class A["$$x$$<img src=https://evil.example/p.png>"]',
    ],
    [
      'KaTeX in a sequence message',
      'sequenceDiagram\n  A->>B: $$x$$<img src=https://evil.example/p.png>',
    ],
    [
      'KaTeX in a state description',
      'stateDiagram-v2\n  A: $$x$$<img src=https://evil.example/p.png>',
    ],
    [
      'a fontFamily directive',
      '%%{init: {"fontFamily": "x;background:url(https://evil.example/f.png)"}}%%\nflowchart LR\n  A --> B',
    ],
    [
      'a themeVariables directive',
      '%%{init: {"themeVariables": {"fontFamily": "x;background:url(https://evil.example/f.png)"}}}%%\nflowchart LR\n  A --> B',
    ],
    [
      'an escaped fontFamily in front-matter',
      String.raw`---
config:
  fontFamily: "x;background:ur\x6c(https://evil.example/f.png)"
---
flowchart LR
  A --> B`,
    ],
    [
      'a directive that loosens the sanitizer',
      '%%{init: {"dompurifyConfig": {"ALLOWED_TAGS": ["img"], "ALLOWED_ATTR": ["src"]}}}%%\nclassDiagram\n  class A["$$x$$<img src=https://evil.example/p.png>"]',
    ],
  ])('with %s draws and loads nothing', async (_name, source) => {
    const stop = watchLoaders();
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Yes" />);
    await screen.findByRole('img', { name: 'Diagram: Yes' });
    expect(stop()).toEqual([]);
    expect(reached).toEqual([]);
  });

  // A browser with MathML gets KaTeX's real output, which jsdom can't reach without this stub: without
  // it every case above draws "MathML is unsupported". The finished SVG is parsed as XML, as an <img>
  // parses it, so the formula has to be MathML there, not just text in a string.
  describe('with KaTeX in a browser that has MathML', () => {
    beforeEach(() => {
      // Mermaid only checks that the global exists.
      vi.stubGlobal('MathMLElement', Element);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const drawnMath = async (source: string): Promise<Document> => {
      renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Math" />);
      const img = await screen.findByRole('img', { name: 'Diagram: Math' });
      const svg = decode(img.getAttribute('src') ?? '');
      expect(svg).not.toMatch(/evil\.example/);
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      expect(parsed.querySelector('parsererror')).toBeNull();
      return parsed;
    };
    const MATHML = 'http://www.w3.org/1998/Math/MathML';

    it.each([
      ['a class label', 'classDiagram\n  class A["$$x^2$$<img src=https://evil.example/p.png>"]'],
      [
        'a sequence message',
        'sequenceDiagram\n  A->>B: $$x^2$$<img src=https://evil.example/p.png>',
      ],
    ])('%s draws the formula and loads nothing', async (_name, source) => {
      const stop = watchLoaders();
      const parsed = await drawnMath(source);
      const power = parsed.getElementsByTagNameNS(MATHML, 'msup')[0];
      expect(power?.textContent).toBe('x2');
      expect(stop()).toEqual([]);
      expect(reached).toEqual([]);
    });

    // With HTML labels off these kinds never reach KaTeX: the label is SVG text, so it shows the source.
    it.each([
      [
        'a flowchart label',
        'flowchart LR\n  A["$$x^2$$<img src=https://evil.example/p.png>"] --> B',
      ],
      ['a state description', 'stateDiagram-v2\n  A: $$x^2$$<img src=https://evil.example/p.png>'],
    ])('%s shows the formula as text and loads nothing', async (_name, source) => {
      const stop = watchLoaders();
      const parsed = await drawnMath(source);
      expect(parsed.querySelector('text')?.textContent).toContain('$$x^2$$');
      expect(stop()).toEqual([]);
      expect(reached).toEqual([]);
    });

    it('keeps what shapes a formula', async () => {
      const parsed = await drawnMath(
        String.raw`classDiagram
  class A["$$\frac{a}{b} \sqrt{c} \begin{matrix}1 & 2\end{matrix}$$"]`,
      );
      for (const tag of ['mfrac', 'msqrt', 'mtable', 'mtr']) {
        expect(parsed.getElementsByTagNameNS(MATHML, tag)).toHaveLength(1);
      }
      expect(parsed.getElementsByTagNameNS(MATHML, 'mtd')).toHaveLength(2);
    });

    it('leaves out the MathML that names a URL', async () => {
      const stop = watchLoaders();
      const parsed = await drawnMath(
        'classDiagram\n  class A["$$x$$<math><mi href=https://evil.example/l style=color:red>y</mi><mglyph src=https://evil.example/p.png></mglyph></math>"]',
      );
      expect(parsed.getElementsByTagName('mglyph')).toHaveLength(0);
      // By tag: a <math> written in a label has no xmlns, so it isn't in the MathML namespace here.
      const named = Array.from(parsed.getElementsByTagName('mi'));
      expect(named.map((el) => el.textContent)).toEqual(['x', 'y']);
      expect(named.flatMap((el) => el.getAttributeNames())).toEqual(
        expect.not.arrayContaining(['href', 'style']),
      );
      expect(stop()).toEqual([]);
      expect(reached).toEqual([]);
    });
  });

  // Refusing is about what a diagram does, not what its words say.
  it.each([
    ['a method named getUrl', 'classDiagram\n  class Api {\n    +getUrl() String\n  }'],
    ['a message naming loadImage', 'sequenceDiagram\n  A->>B: loadImage(id)'],
    ['a message naming resolveSrc', 'sequenceDiagram\n  A->>B: resolveSrc(id)'],
    ['a shape whose label says img', 'flowchart LR\n  A@{ label: "An img tag" }'],
    ['a shape from the shape list', 'flowchart LR\n  A@{ shape: rounded, label: "Hi" }'],
    ['a label that mentions an image', 'flowchart LR\n  A["Resize the image (large)"] --> B'],
    ['a plain style', 'flowchart LR\n  A --> B\n  style A fill:#f9f,stroke:#333'],
    [
      'a line break in a label',
      String.raw`sequenceDiagram
  A->>B: one\ntwo`,
    ],
    ['a sequence diagram', 'sequenceDiagram\n  A->>B: hello'],
    ['a class diagram', 'classDiagram\n  class A {\n    +int id\n  }\n  A <|-- B'],
    ['a state diagram', 'stateDiagram-v2\n  [*] --> A\n  A --> [*]'],
    ['an old state diagram', 'stateDiagram\n  [*] --> A'],
    ['an ER diagram', 'erDiagram\n  A ||--o{ B : has'],
    ['a Gantt chart', 'gantt\n  title Plan\n  section One\n  Task :a1, 2026-01-01, 3d'],
    ['a pie chart', 'pie title Load\n  "a" : 1\n  "b" : 2'],
  ])('draws %s', async (_name, source) => {
    renderWithDaemon(<AttachmentView attachment={{ kind: 'mermaid', source }} title="Fine" />);
    expect(await screen.findByRole('img', { name: 'Diagram: Fine' })).toBeTruthy();
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

import { ChartSpec } from '@10db/contracts';
import mermaid from 'mermaid';
import type { Loader } from 'vega';
import embed from 'vega-embed';
import { expressionInterpreter } from 'vega-interpreter';
import type { TopLevelSpec } from 'vega-lite';

// Shape spec §10.3. What the session attaches can be shaped by a pasted document, so nothing it
// writes runs code or reaches the network:
// - a mockup renders in an iframe with an empty sandbox, through srcdoc, under MOCKUP_CSP;
// - a chart is Vega-Lite with inline data.values only, checked again here, drawn with a loader that
//   refuses every load and Vega's interpreter (the window's CSP has no unsafe-eval);
// - a diagram is Mermaid at securityLevel 'strict', of a kind we know, refused if it names an image.
// A chart and a diagram are drawn to an SVG string and shown as an <img>: an SVG image runs no script,
// follows no link and loads nothing.

/** The mockup document's policy: no script, no network, no frame; inline styles and data images only. */
export const MOCKUP_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** The srcdoc for a mockup: its policy first, before anything the mockup holds. */
export function mockupDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${MOCKUP_CSP}"><meta charset="utf-8"></head><body>${html}</body></html>`;
}

const refuse = (): Promise<never> =>
  Promise.reject(new Error('A chart loads nothing: its data is inline in data.values'));

/** Vega's loader, with every way to load something refused. Frozen: nothing can rewrite it. */
export const refusingLoader: Loader = Object.freeze({
  load: refuse,
  sanitize: refuse,
  http: refuse,
  file: refuse,
});

/** An SVG string as an image source. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Why a chart isn't drawn, or null when its spec is inline-only. */
export function chartRefusal(spec: unknown): string | null {
  return ChartSpec.safeParse(spec).success
    ? null
    : 'This chart names a URL, so it isn’t drawn. A chart carries its data inline.';
}

/** Draws a Vega-Lite chart to SVG, offscreen, with nothing loaded and no expression compiled to code. */
export async function chartSvg(spec: Readonly<Record<string, unknown>>): Promise<string> {
  const refusal = chartRefusal(spec);
  if (refusal !== null) throw new Error(refusal);
  // Vega-Embed writes into the spec it is given; it gets a copy, so the view's spec stays as checked.
  const copy = structuredClone(spec) as unknown as TopLevelSpec;
  // Vega-Embed merges usermeta.embedOptions over ours (loader, defaultStyle, patch, config, ast...), and
  // ChartSpec lets usermeta through. Nothing in a chart's own JSON may change how it is drawn.
  Reflect.deleteProperty(copy, 'usermeta');
  const result = await embed(document.createElement('div'), copy, {
    mode: 'vega-lite',
    renderer: 'none',
    actions: false,
    tooltip: false,
    hover: false,
    // No <style> in the app document's head (a detached element falls back to it).
    defaultStyle: false,
    // This draw's own loader, frozen: vega-embed can't write into one a later chart will use.
    loader: Object.freeze({ ...refusingLoader }),
    ast: true,
    expr: expressionInterpreter,
  });
  try {
    return await result.view.toSVG();
  } finally {
    result.finalize();
  }
}

let diagrams = 0;

// At 'strict' Mermaid draws into a temporary element appended to document.body (it needs layout to
// measure text) and removes it afterwards. While it is there, anything in it that loads does, and
// `pnpm dev` and `pnpm dev:factory` have no CSP to stop it. What keeps a diagram from loading, as of
// Mermaid 12.2:
// - Only DRAWN_KINDS are drawn. Their ways to name an image were read in Mermaid's source; another kind
//   (C4's sprites, architecture's text icon) has its own, and is refused until someone reads it. Check
//   this list when Mermaid is bumped.
// - In those kinds an image is a flowchart image shape or a sequence actor's icon. Both are looked for
//   in the parsed diagram, not the text: an image shape's block is YAML, so its text can hide the key.
// - Every string Mermaid writes as HTML passes its sanitizer, even with HTML labels off (KaTeX turns
//   them back on for one label): LABEL_HTML keeps only tags and attributes that load nothing.
// - CSS from the diagram's text (classDef, style, linkStyle) reaches a <style> or a style attribute, and
//   a kind has several routes to it, so the text itself may not hold a CSS function that loads.
// - Config reaches the same places, so its keys are secured: see SECURE_KEYS.

/** The values of `Diagram.type` whose ways to load something are known. */
const DRAWN_KINDS: ReadonlySet<string> = new Set([
  'flowchart-v2',
  'sequence',
  'class',
  'classDiagram',
  'state',
  'stateDiagram',
  'er',
  'gantt',
  'pie',
]);

const SECURE_KEYS = [
  // Mermaid's own list.
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  // Ours: a directive or front-matter may not turn HTML labels on, loosen LABEL_HTML, or add to the
  // stylesheet. A secured key goes wherever it sits, so `flowchart.htmlLabels` goes too.
  'htmlLabels',
  'dompurifyConfig',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
];

/** What Mermaid's sanitizer lets into a label: text formatting, and no attribute that names a URL or CSS. */
const LABEL_HTML = {
  ALLOWED_TAGS: [
    'b',
    'br',
    'code',
    'div',
    'em',
    'i',
    'p',
    's',
    'span',
    'strong',
    'sub',
    'sup',
    'u',
  ],
  ALLOWED_ATTR: ['class'],
};

/** The CSS that fetches: the functions that take a URL (a function name has no space before its bracket), and two at-rules. */
const CSS_LOAD = /(?:url|src|image|image-set|cross-fade)\(|@import|@font-face/i;

/** Text with CSS's backslash escapes undone: `\75 r\l(` is `url(` to a stylesheet. */
function withoutCssEscapes(text: string): string {
  return text.replace(
    /\\(?:([0-9a-f]{1,6})\s?|(.))/gis,
    (_, hex: string | undefined, char: string) => {
      if (hex === undefined) return char;
      const code = Number.parseInt(hex, 16);
      return code > 0x10ffff ? '�' : String.fromCodePoint(code);
    },
  );
}

/** The parts of a parsed diagram's db that name an image. Only a flowchart and a sequence have these. */
interface ImageSources {
  readonly getVertices?: () => ReadonlyMap<string, { readonly img?: string }>;
  readonly getActors?: () => ReadonlyMap<
    string,
    { readonly properties?: Readonly<Record<string, unknown>> }
  >;
}

/** Why a diagram isn't drawn, or null when it has nothing that loads. Throws when it doesn't parse. */
async function diagramRefusal(source: string): Promise<string | null> {
  // `mermaid.parse`, its replacement, gives the diagram's type but not the parsed db we need to read.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  if (!DRAWN_KINDS.has(diagram.type))
    return 'This kind of diagram isn’t drawn. Use a flowchart, sequence, class, state, ER, Gantt or pie diagram.';
  const db = diagram.db as ImageSources;
  const images = [
    ...Array.from(db.getVertices?.().values() ?? [], (vertex) => vertex.img),
    ...Array.from(db.getActors?.().values() ?? [], (actor) => actor.properties?.['icon']),
  ];
  if (images.some((image) => image !== undefined))
    return 'This diagram has an image, which names a URL, so it isn’t drawn.';
  // `diagram.text`, not the source: Mermaid removes a directive from the middle of a word before it
  // parses, and a directive or front-matter holds config, which SECURE_KEYS covers.
  if (CSS_LOAD.test(withoutCssEscapes(diagram.text)))
    return 'This diagram’s style names a URL, so it isn’t drawn.';
  return null;
}

async function drawDiagram(source: string, dark: boolean): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    dompurifyConfig: LABEL_HTML,
    secure: SECURE_KEYS,
    theme: dark ? 'dark' : 'default',
  });
  const refusal = await diagramRefusal(source);
  if (refusal !== null) throw new Error(refusal);
  diagrams += 1;
  const id = `shape-diagram-${String(diagrams)}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // A draw that throws leaves its temporary element in the body; take it out.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

let lastDraw: Promise<unknown> = Promise.resolve();

/**
 * Draws a Mermaid diagram to SVG at securityLevel 'strict', with SVG text labels, one at a time: two
 * parses at once share Mermaid's parser, so a diagram could be checked against another's db.
 */
export function mermaidSvg(source: string, dark: boolean): Promise<string> {
  const drawn = lastDraw.then(() => drawDiagram(source, dark));
  lastDraw = drawn.catch(() => undefined);
  return drawn;
}

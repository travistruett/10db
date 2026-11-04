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
// - a diagram is Mermaid at securityLevel 'strict'.
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

/** Draws a Mermaid diagram to SVG at securityLevel 'strict', with SVG text labels (no HTML in it). */
export async function mermaidSvg(source: string, dark: boolean): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: dark ? 'dark' : 'default',
  });
  diagrams += 1;
  const { svg } = await mermaid.render(`shape-diagram-${String(diagrams)}`, source);
  return svg;
}

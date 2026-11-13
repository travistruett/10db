# Agent output renders as hardened markdown through one component, with fences highlighted in Selenized

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-02-the-shape-view.md`

## Decision

Agent output in Plan renders as markdown, and so will Sessions and the Workbench as they move onto the
conversation kit. It renders through `apps/desktop/src/conversation/markdown.tsx` alone, which is the only place
streamdown is configured:

- GFM only: no math, no Mermaid and no highlighter plugin, so none of streamdown's own lazy chunks ever loads.
- Raw HTML is shown as its text and never rendered.
- The tree is sanitized, then 10db's own step (`rehype-agent-safety.ts`) replaces every image with "Image not shown:
  {alt}" and unwraps every link that is not `https:`. rehype-harden runs after it.
- An `https:` link has no `href`. A click or Enter opens it through `openWebLink` after a confirm that names the
  parsed host (`decisions/2026-11-13-the-opener-opens-confirmed-https-links.md`).
- A reply cut mid-fence or mid-list closes its open syntax (`parseIncompleteMarkdown`).
- A text past `MARKDOWN_MAX_LENGTH`, or one the parser can't draw, shows whole as plain text.

Fences draw as Mantine's `CodeHighlight` with a Shiki adapter. Shiki runs on `shiki/core` with its JavaScript regex
engine, and each grammar is imported lazily from a fixed list keyed in a `Map`. The two themes are built in code
from 10db's Selenized values (`selenized-shiki.ts`). Mantine's adapter hands Shiki its own GitHub theme objects for
"light" and "dark", so 10db's adapter asks for the Selenized themes by name instead.

## Why

Agent replies are written as markdown, and reading them as plain text loses their structure (sessions spec S10).
Research T4 §1 found streamdown's harden defaults permissive, so 10db narrows them itself and decides what the
builder reads in its own step. Agent text is untrusted, so nothing in it may fetch, run or navigate. The window's
CSP allows neither WebAssembly nor eval, which Shiki's Oniguruma engine needs. `e2e/window-csp.spec.ts` checks that
a fence highlights under that policy in WebKit and that none of streamdown's own chunks is requested.

The streamdown spike (sessions spec §16, check 5) passed in WebKit. A 20k-token reply grew at 50 ms frames inside
the virtualized list, and in streamdown's streaming mode a frame took 17 ms at the median and 28 ms at p95. In the
static mode M3 uses for stored messages it took 44 ms and 80 ms, since every frame parses the whole text. A
300-row tool turn took 11 ms and 18 ms. Turned down: react-markdown with rehype-sanitize and `remend`, the fallback
if the spike had failed.

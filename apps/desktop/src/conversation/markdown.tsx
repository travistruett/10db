import { harden } from 'rehype-harden';
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from 'streamdown';
import { useMemo } from 'react';
import { MarkdownBoundary } from './markdown-boundary';
import { MARKDOWN_ELEMENTS } from './markdown-elements';
import { markdownFits } from './markdown-fits';
import { PlainMarkdown } from './markdown-plain';
import { rehypeAgentSafety, remarkHtmlAsText } from './rehype-agent-safety';

// The one place markdown is drawn. Raw HTML is shown as its text, the tree is sanitized, and 10db's
// own step drops images and every link that is not `https:`; harden is set to the same rule. A text
// too long or nested too deeply to draw is shown plain (`markdown-fits.ts`). GFM only: no math, no
// Mermaid and no highlighter, so none of streamdown's lazy chunks ever loads.

const MARKDOWN_REMARK_PLUGINS: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...[defaultRemarkPlugins['gfm'], defaultRemarkPlugins['codeMeta']].filter((p) => p !== undefined),
  remarkHtmlAsText,
];

const MARKDOWN_REHYPE_PLUGINS: NonNullable<StreamdownProps['rehypePlugins']> = [
  ...[defaultRehypePlugins['sanitize']].filter((p) => p !== undefined),
  rehypeAgentSafety,
  [
    harden,
    {
      // Links stay https-only because of 10db's own step above, which has already unwrapped every
      // other link; harden, set to the same rule, is not relied on as a second wall.
      allowedLinkPrefixes: ['https://'],
      allowedProtocols: ['https'],
      allowedImagePrefixes: [],
      allowDataImages: false,
    },
  ],
];

/**
 * Draws `text` as markdown, or shows it whole as plain text when it is too long or nested too deeply
 * to draw, or when drawing it throws.
 */
export function Markdown({ text }: { readonly text: string }) {
  const fits = useMemo(() => markdownFits(text), [text]);
  if (!fits) return <PlainMarkdown text={text} />;
  return (
    <MarkdownBoundary text={text}>
      <Streamdown
        mode="static"
        parseIncompleteMarkdown
        skipHtml
        controls={false}
        linkSafety={{ enabled: false }}
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={MARKDOWN_ELEMENTS}
      >
        {text}
      </Streamdown>
    </MarkdownBoundary>
  );
}

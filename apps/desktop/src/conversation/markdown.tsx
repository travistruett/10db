import { harden } from 'rehype-harden';
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from 'streamdown';
import { MarkdownBoundary } from './markdown-boundary';
import { MARKDOWN_ELEMENTS } from './markdown-elements';
import { PlainMarkdown } from './markdown-plain';
import { rehypeAgentSafety, remarkHtmlAsText } from './rehype-agent-safety';

// The one place markdown is drawn. Raw HTML is shown as its text, the tree is sanitized, and 10db's
// own step drops images and every link that is not `https:`; harden runs after it. A text longer
// than MARKDOWN_MAX_LENGTH is shown plain, and one the parser can't draw (it recurses, so a text
// nested thousands deep exhausts the stack) falls to `MarkdownBoundary`, which shows it plain too.
// GFM only: no math, no Mermaid and no highlighter, so none of streamdown's lazy chunks ever loads.

/** The longest text drawn as markdown, in UTF-16 code units; a longer one shows whole as plain text. */
const MARKDOWN_MAX_LENGTH = 512 * 1024;

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
      // Links stay https-only because 10db's own step above has already unwrapped every other link;
      // harden is not a second wall. Its narrowest setting is `*`: a prefix such as `https://` makes it
      // demand a default origin and throw on every draw, and an invented origin would let it accept
      // relative links resolved against that origin.
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: [],
      allowDataImages: false,
    },
  ],
];

/** Draws `text` as markdown, or shows it whole as plain text when it is too long or drawing it throws. */
export function Markdown({ text }: { readonly text: string }) {
  if (text.length > MARKDOWN_MAX_LENGTH) return <PlainMarkdown text={text} />;
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

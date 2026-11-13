import { harden } from 'rehype-harden';
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from 'streamdown';
import { MARKDOWN_ELEMENTS } from './markdown-elements';
import { rehypeAgentSafety, remarkHtmlAsText } from './rehype-agent-safety';

// The one place markdown is drawn. Raw HTML is shown as its text, the tree is sanitized, 10db's own step drops
// images and unsafe links, and harden allows no image and only `https:` links. GFM only: no math, no
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
      // Harden's prefixes are origins, so `*` with no image prefix is the narrowest it takes: no image
      // passes, and a link must be http or https. 10db's step above has already left only https links.
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: [],
      allowDataImages: false,
    },
  ],
];

export function Markdown({ text }: { readonly text: string }) {
  return (
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
  );
}

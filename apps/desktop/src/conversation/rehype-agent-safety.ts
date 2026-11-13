import type { ExtraProps } from 'streamdown';

// 10db's own steps over drawn markdown. Before the tree is built, raw HTML becomes text, so it is
// shown as written and never rendered. After it is sanitized and before rehype-harden, every image
// becomes a line saying it was not shown, and every link that is not `https:` becomes its text.
// Harden then stays as the second wall, and what the builder reads is decided here.

type HastElement = NonNullable<ExtraProps['node']>;
type HastChild = HastElement['children'][number];

const isHttps = (href: unknown): boolean => typeof href === 'string' && href.startsWith('https://');

function blockedImage(image: HastElement): HastElement {
  const alt = image.properties.alt;
  return {
    type: 'element',
    tagName: 'span',
    properties: { dataBlocked: 'image' },
    children: [{ type: 'text', value: `Image not shown: ${typeof alt === 'string' ? alt : ''}` }],
  };
}

/** A parent's children with its images replaced and its unsafe links unwrapped, nested ones too. */
function cleaned(children: readonly HastChild[]): HastChild[] {
  const out: HastChild[] = [];
  const queue = [...children];
  for (let child = queue.shift(); child !== undefined; child = queue.shift()) {
    if (child.type !== 'element') out.push(child);
    else if (child.tagName === 'img') out.push(blockedImage(child));
    else if (child.tagName === 'a' && !isHttps(child.properties.href))
      queue.unshift(...child.children);
    else out.push(child);
  }
  return out;
}

/** The rehype plugin: walks the tree with a stack, so a deep document can't exhaust the call stack. */
export function rehypeAgentSafety() {
  return (tree: { children: HastChild[] }): void => {
    const stack: { children: HastChild[] }[] = [tree];
    for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
      parent.children = cleaned(parent.children);
      for (const child of parent.children) if (child.type === 'element') stack.push(child);
    }
  };
}

/** A markdown (mdast) node, as far as showing raw HTML as text needs it. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Parents whose children are blocks, where raw HTML becomes a paragraph of its text. */
const FLOW_PARENTS: ReadonlySet<string> = new Set([
  'root',
  'blockquote',
  'listItem',
  'footnoteDefinition',
]);

/**
 * The remark plugin: every raw HTML node, block or inline, becomes text with the same value, so
 * `<host>` or `Promise<void>` reads as written and no markup is ever rendered. Walks with a stack.
 */
export function remarkHtmlAsText() {
  return (tree: MarkdownNode): void => {
    const stack: MarkdownNode[] = [tree];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const children = node.children;
      if (children === undefined) continue;
      const flow = FLOW_PARENTS.has(node.type);
      node.children = children.map((child): MarkdownNode => {
        if (child.type !== 'html') return child;
        const text = { type: 'text', value: child.value ?? '' };
        return flow ? { type: 'paragraph', children: [text] } : text;
      });
      for (const child of node.children) stack.push(child);
    }
  };
}

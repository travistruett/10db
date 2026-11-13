import { Anchor, Code, List, Table, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Components, ExtraProps } from 'streamdown';
import { openWebLink } from '../desktop/tauri';
import classes from './markdown.module.css';

// One Mantine element per markdown tag. A link never navigates the window: a click asks the
// builder to confirm its host, then opens it in the browser (`openWebLink`), and its address is
// never in the page.

/** A heading, marked with the source line it starts on so a view can scroll to a section. */
function Heading(props: {
  readonly order: 1 | 2 | 3 | 4 | 5 | 6;
  readonly size: number;
  readonly node: ExtraProps['node'];
  readonly children: ReactNode;
}) {
  return (
    <Title
      order={props.order}
      fz={props.size}
      fw={600}
      c="bright"
      mt="sm"
      mb={4}
      data-line={props.node?.position?.start.line}
    >
      {props.children}
    </Title>
  );
}

/** A line in place of an image, which is never drawn. */
function NotShown({ children }: { readonly children: ReactNode }) {
  return (
    <Text span size="xs" c="dimmed">
      {children}
    </Text>
  );
}

function open(href: string): void {
  openWebLink(href).catch((error: unknown) => {
    console.warn('10db: the link did not open', error);
  });
}

/**
 * An `https:` link (10db's safety step has unwrapped every other kind). Its address lives only in
 * this closure and in its title, never in an `href`, so a middle-click, a context menu's Open or a
 * drag has nothing to open; a click or Enter asks the builder through `openWebLink`.
 */
function Link({ href, children }: { readonly href: unknown; readonly children: ReactNode }) {
  if (typeof href !== 'string') return <>{children}</>;
  return (
    <Anchor
      role="link"
      tabIndex={0}
      title={href}
      style={{ cursor: 'pointer' }}
      onClick={(event) => {
        event.preventDefault();
        open(href);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        open(href);
      }}
    >
      {children}
    </Anchor>
  );
}

export const MARKDOWN_ELEMENTS: Components = {
  p: ({ children }) => (
    <Text size="sm" lh={1.6} my={6}>
      {children}
    </Text>
  ),
  h1: ({ node, children }) => (
    <Heading order={1} size={17} node={node}>
      {children}
    </Heading>
  ),
  h2: ({ node, children }) => (
    <Heading order={2} size={15} node={node}>
      {children}
    </Heading>
  ),
  h3: ({ node, children }) => (
    <Heading order={3} size={14} node={node}>
      {children}
    </Heading>
  ),
  h4: ({ node, children }) => (
    <Heading order={4} size={14} node={node}>
      {children}
    </Heading>
  ),
  h5: ({ node, children }) => (
    <Heading order={5} size={14} node={node}>
      {children}
    </Heading>
  ),
  h6: ({ node, children }) => (
    <Heading order={6} size={14} node={node}>
      {children}
    </Heading>
  ),
  ul: ({ children }) => (
    <List size="sm" className={classes['list']}>
      {children}
    </List>
  ),
  ol: ({ children }) => (
    <List type="ordered" size="sm" className={classes['list']}>
      {children}
    </List>
  ),
  li: ({ children }) => <List.Item>{children}</List.Item>,
  inlineCode: ({ children }) => <Code>{children}</Code>,
  pre: ({ children }) => (
    <Code block my={6}>
      {children}
    </Code>
  ),
  code: ({ children }) => <code>{children}</code>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  // 10db's safety step marks the line it puts in place of an image.
  span: ({ node, children }) =>
    node?.properties['dataBlocked'] === 'image' ? (
      <NotShown>{children}</NotShown>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <NotShown>{`Image not shown: ${alt ?? ''}`}</NotShown>,
  table: ({ children }) => (
    <Table fz="sm" withRowBorders my={6}>
      {children}
    </Table>
  ),
  thead: ({ children }) => <Table.Thead>{children}</Table.Thead>,
  tbody: ({ children }) => <Table.Tbody>{children}</Table.Tbody>,
  tr: ({ children }) => <Table.Tr>{children}</Table.Tr>,
  th: ({ children }) => <Table.Th>{children}</Table.Th>,
  td: ({ children }) => <Table.Td>{children}</Table.Td>,
  blockquote: ({ children }) => <blockquote className={classes['quote']}>{children}</blockquote>,
};

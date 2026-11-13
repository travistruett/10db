import { Code, List, Table, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Components } from 'streamdown';
import classes from './markdown.module.css';

// One Mantine element per markdown tag. A link is drawn as its text and its address, never an
// anchor: nothing in drawn markdown navigates the window until the opener that confirms exists.

function Heading(props: {
  readonly order: 1 | 2 | 3 | 4 | 5 | 6;
  readonly size: number;
  readonly children: ReactNode;
}) {
  return (
    <Title order={props.order} fz={props.size} fw={600} c="bright" mt="sm" mb={4}>
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

function LinkText({ href, children }: { readonly href: unknown; readonly children: ReactNode }) {
  // An autolink's text is its address, so the address is shown once.
  const address = typeof href === 'string' && href !== children ? href : null;
  return (
    <>
      {children}
      {address !== null && (
        <Text span size="xs" c="dimmed">
          {` (${address})`}
        </Text>
      )}
    </>
  );
}

export const MARKDOWN_ELEMENTS: Components = {
  p: ({ children }) => (
    <Text size="sm" lh={1.6} my={6}>
      {children}
    </Text>
  ),
  h1: ({ children }) => (
    <Heading order={1} size={17}>
      {children}
    </Heading>
  ),
  h2: ({ children }) => (
    <Heading order={2} size={15}>
      {children}
    </Heading>
  ),
  h3: ({ children }) => (
    <Heading order={3} size={14}>
      {children}
    </Heading>
  ),
  h4: ({ children }) => (
    <Heading order={4} size={14}>
      {children}
    </Heading>
  ),
  h5: ({ children }) => (
    <Heading order={5} size={14}>
      {children}
    </Heading>
  ),
  h6: ({ children }) => (
    <Heading order={6} size={14}>
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
  a: ({ href, children }) => <LinkText href={href}>{children}</LinkText>,
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

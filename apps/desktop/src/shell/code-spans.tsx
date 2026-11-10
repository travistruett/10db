import { Code } from '@mantine/core';
import { Fragment } from 'react';

/**
 * Text that names paths and commands in backticks, as the daemon writes notices and cards: each
 * backtick pair is drawn as code and the backticks dropped. An unpaired or empty pair stays as typed.
 * Only text and `Code` are drawn, never markup, so text from agents and tools stays text.
 */
export function CodeSpans({ text }: { readonly text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, index) => {
        const key = `${String(index)}:${part}`;
        if (index % 2 === 0) return <Fragment key={key}>{part}</Fragment>;
        // A backtick with no partner after it, or a pair around nothing, is the text itself.
        if (index === parts.length - 1) return <Fragment key={key}>{`\`${part}`}</Fragment>;
        if (part === '') return <Fragment key={key}>``</Fragment>;
        return <Code key={key}>{part}</Code>;
      })}
    </>
  );
}

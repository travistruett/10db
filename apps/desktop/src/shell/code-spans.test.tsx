import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { CodeSpans } from './code-spans';

describe('CodeSpans', () => {
  it.each<{ name: string; text: string; shown: string; code: string[] }>([
    {
      name: 'a path in backticks is code, the backticks gone',
      text: 'People changed shared `src/ui/button.ts`.',
      shown: 'People changed shared src/ui/button.ts.',
      code: ['src/ui/button.ts'],
    },
    {
      name: 'each pair is its own code',
      text: 'Run `pnpm test` in `apps/web`',
      shown: 'Run pnpm test in apps/web',
      code: ['pnpm test', 'apps/web'],
    },
    {
      name: 'an unpaired backtick stays as typed',
      text: 'Kept `a` and one ` left',
      shown: 'Kept a and one ` left',
      code: ['a'],
    },
    { name: 'no backticks, plain text', text: 'Signing off…', shown: 'Signing off…', code: [] },
    { name: 'an empty pair stays as typed', text: 'a `` b', shown: 'a `` b', code: [] },
    {
      name: 'markup in a span is text',
      text: 'see `<b>bold</b>`',
      shown: 'see <b>bold</b>',
      code: ['<b>bold</b>'],
    },
  ])('$name', ({ text, shown, code }) => {
    const { container } = renderWithTheme(
      <p>
        <CodeSpans text={text} />
      </p>,
    );
    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe(shown);
    expect([...container.querySelectorAll('code')].map((element) => element.textContent)).toEqual(
      code,
    );
    expect(container.querySelector('b')).toBeNull();
  });
});

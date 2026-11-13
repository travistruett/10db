import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { CodeBlock } from './code-block';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

/** The colors a block's tokens are drawn in. */
const colorsIn = (block: HTMLElement): Set<string> =>
  new Set([...block.querySelectorAll<HTMLElement>('pre span[style]')].map((s) => s.style.color));

describe('CodeBlock', () => {
  it.each([
    ['sh', 'echo "hi" # note'],
    ['zsh', 'echo "hi" # note'],
    ['md', '# Title\n\n*em* and `code`'],
    ['yml', 'key: value # note'],
    ['rs', 'fn main() { let a = 1; }'],
    ['py', 'def f():\n    return 1  # note'],
    ['TS', 'const a: number = 1;'],
  ])('highlights a %s fence through its grammar', async (language, code) => {
    renderWithTheme(
      <div data-testid="block">
        <CodeBlock code={code} language={language} />
      </div>,
    );
    await waitFor(() => {
      expect(colorsIn(screen.getByTestId('block')).size).toBeGreaterThan(1);
    });
  });

  it.each(['klingon', 'constructor', '__proto__', 'toString'])(
    'draws a %s fence plain, with no error',
    async (language) => {
      const error = vi.spyOn(console, 'error');
      renderWithTheme(
        <>
          <div data-testid="small">
            <CodeBlock code="const a: number = 1;" language="ts" />
          </div>
          <div data-testid="other">
            <CodeBlock code="const a: number = 1;" language={language} />
          </div>
        </>,
      );
      await waitFor(() => {
        expect(colorsIn(screen.getByTestId('small')).size).toBeGreaterThan(1);
      });
      expect(colorsIn(screen.getByTestId('other')).size).toBeLessThanOrEqual(1);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a line past the line limit', `${'const a = 1; '.repeat(200)}\n`],
    ['code past the size limit', 'const a = 1;\n'.repeat(4_000)],
  ])('draws %s plain, never highlighted', async (_name, code) => {
    renderWithTheme(
      <>
        <div data-testid="small">
          <CodeBlock code="const a: number = 1;" language="ts" />
        </div>
        <div data-testid="big">
          <CodeBlock code={code} language="ts" />
        </div>
      </>,
    );
    // The small block highlighting shows the grammar has loaded for both.
    await waitFor(() => {
      expect(colorsIn(screen.getByTestId('small')).size).toBeGreaterThan(1);
    });
    expect(colorsIn(screen.getByTestId('big')).size).toBeLessThanOrEqual(1);
    expect(screen.getByTestId('big').querySelector('pre')?.textContent).toContain('const a = 1;');
  });

  it('labels a ts fence, highlights it, and copies its code', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = renderWithTheme(
      <CodeBlock code={'const a: number = 1;'} language="ts" />,
    );
    expect(screen.getByText('ts')).toBeTruthy();
    // Highlighted: its tokens are drawn in more than one color.
    await waitFor(() => {
      const colors = [...container.querySelectorAll<HTMLElement>('pre span[style]')].map(
        (span) => span.style.color,
      );
      expect(new Set(colors).size).toBeGreaterThan(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const a: number = 1;');
  });

  it('shows no label with no language', () => {
    const { container } = renderWithTheme(<CodeBlock code="plain" language={null} />);
    expect(container.querySelector('pre')?.textContent).toContain('plain');
    expect(screen.queryByText('text')).toBeNull();
  });
});

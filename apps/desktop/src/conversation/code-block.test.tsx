import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { CodeBlock } from './code-block';
import { SHIKI_LANGUAGES } from './shiki';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('the fence languages', () => {
  it.each([
    ['ts', 'typescript'],
    ['sh', 'shellscript'],
    ['zsh', 'shellscript'],
    ['md', 'markdown'],
    ['yml', 'yaml'],
    ['rs', 'rust'],
  ])('%s loads the %s grammar', async (alias, module) => {
    const load = SHIKI_LANGUAGES.get(alias);
    expect(load).toBe(SHIKI_LANGUAGES.get(module));
    const grammar = await load?.();
    expect(grammar?.default.map((g) => g.name)).toContain(module);
  });

  it.each(['klingon', 'constructor', '__proto__', 'toString'])('%s loads nothing', (name) => {
    expect(SHIKI_LANGUAGES.get(name)).toBeUndefined();
  });
});

describe('CodeBlock', () => {
  it('labels a ts fence, highlights it, and copies its code', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = renderWithTheme(
      <CodeBlock code={'const a: number = 1;'} language="ts" />,
    );
    expect(screen.getByText('ts')).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('pre span[style*="color"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const a: number = 1;');
  });

  it('draws an unknown language as plain text, with no error', () => {
    const error = vi.spyOn(console, 'error');
    const { container } = renderWithTheme(<CodeBlock code="nuqneH" language="klingon" />);
    expect(container.querySelector('pre')?.textContent).toContain('nuqneH');
    expect(error).not.toHaveBeenCalled();
  });

  it('shows no label with no language', () => {
    const { container } = renderWithTheme(<CodeBlock code="plain" language={null} />);
    expect(container.querySelector('pre')?.textContent).toContain('plain');
    expect(screen.queryByText('text')).toBeNull();
  });
});

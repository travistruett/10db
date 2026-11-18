import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { Markdown } from './index';
import { LinkConfirmHost } from './link-confirm';

// An `https:` link in markdown opens only after the builder confirms its host, and its address is
// never in the page, so no middle-click, context menu or drag opens it unasked.

/** Draws `text` and answers the element that holds it, without the theme's style tags. */
function draw(text: string): HTMLElement {
  renderWithTheme(
    <div data-testid="markdown">
      <Markdown text={text} />
    </div>,
  );
  return screen.getByTestId('markdown');
}

describe('a link', () => {
  afterEach(() => {
    clearMocks();
    // clearMocks empties the internals but leaves the object, which is what isTauri looks for.
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.restoreAllMocks();
  });

  it("opens through the shell's confirming command in Tauri, never the opener plugin", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return true;
    });
    draw('[docs](https://ok.example/a)');
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    await vi.waitFor(() => {
      expect(calls).toEqual([{ cmd: 'open_web_link', args: { url: 'https://ok.example/a' } }]);
    });
  });

  it('is focusable and opens on Enter, with no address in the page to open unasked', async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return true;
    });
    const c = draw('[docs](https://ok.example/a)');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(c.querySelectorAll('[href]')).toHaveLength(0);
    expect(link.getAttribute('title')).toBe('https://ok.example/a');
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(calls).toEqual([{ cmd: 'open_web_link', args: { url: 'https://ok.example/a' } }]);
    });
  });

  it('ignores a held Enter, and asks once while a confirm is open', async () => {
    const calls: string[] = [];
    let answer: (open: boolean) => void = () => undefined;
    mockIPC((cmd) => {
      calls.push(cmd);
      // The native confirm stays open until the test answers it.
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    draw('[docs](https://ok.example/a)');
    const link = screen.getByRole('link', { name: 'docs' });
    fireEvent.keyDown(link, { key: 'Enter', repeat: true });
    expect(calls).toEqual([]);
    fireEvent.click(link);
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(calls).toEqual(['open_web_link']);
    });
    answer(false);
    await vi.waitFor(() => {
      fireEvent.click(link);
      expect(calls).toEqual(['open_web_link', 'open_web_link']);
    });
    answer(false);
  });

  it('asks in a browser, naming the address host and not the link text, before it opens', async () => {
    const open = vi.spyOn(window, 'open');
    renderWithTheme(<LinkConfirmHost />);
    draw('[github.com](https://evil.example/x)');
    fireEvent.click(screen.getByRole('link', { name: 'github.com' }));
    await screen.findByText('Open evil.example in your browser?');
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
});

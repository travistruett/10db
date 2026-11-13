import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkConfirmHost } from '../conversation/link-confirm';
import { renderWithTheme } from '../test/theme';
import { openWebLink } from './tauri';

afterEach(() => {
  clearMocks();
  // clearMocks empties the internals but leaves the object, which is what isTauri looks for.
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.restoreAllMocks();
});

describe('openWebLink in Tauri', () => {
  it("asks the shell's own command, which confirms natively, and never the opener plugin", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return true;
    });
    await openWebLink('https://ok.example/a');
    expect(calls).toEqual([{ cmd: 'open_web_link', args: { url: 'https://ok.example/a' } }]);
  });
});

describe('openWebLink in a browser', () => {
  /** A window of its own whose opener is set, as a real pop-up's is until the app clears it. */
  function stubOpen() {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    if (frame.contentWindow === null) throw new Error('the test page has no frame window');
    const popup = frame.contentWindow;
    popup.opener = window;
    return { open: vi.spyOn(window, 'open').mockReturnValue(popup), popup };
  }

  it('asks with the parsed host, and Cancel opens nothing', async () => {
    const { open } = stubOpen();
    renderWithTheme(<LinkConfirmHost />);
    const done = openWebLink('https://ok.example/a');
    await screen.findByText('Open ok.example in your browser?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await done;
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the address once on Open, cut off from the app', async () => {
    const { open, popup } = stubOpen();
    renderWithTheme(<LinkConfirmHost />);
    const done = openWebLink('https://ok.example/a');
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await done;
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://ok.example/a', '_blank');
    expect(popup.opener).toBeNull();
  });

  it.each([
    ['http', 'http://ok.example/'],
    ['javascript', 'javascript:alert(1)'],
    ['a user name', 'https://github.com@evil.example/'],
    ['not an address', 'not a url'],
  ])('refuses %s before it asks', async (_name, url) => {
    const { open } = stubOpen();
    renderWithTheme(<LinkConfirmHost />);
    await expect(openWebLink(url)).rejects.toMatchObject({ name: 'WebLinkRefusedError' });
    expect(screen.queryByText(/in your browser\?/)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

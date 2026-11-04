import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Root } from './root';

// A page opened with a `render` parameter is a frame the window draws a screen in. If its address
// does not parse, it must not become the app under the UI token.

describe('Root', () => {
  it('draws nothing, and asks the daemon for nothing, when a frame address does not parse', () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const makeApp = vi.fn(() => <div>the app</div>);
    const { container } = render(
      <Root
        search="?render=token&daemon=http%3A%2F%2Flocalhost%3A4317&project=nope&screen=board"
        app={makeApp}
      />,
    );
    expect(container.innerHTML).toBe('');
    expect(makeApp).not.toHaveBeenCalled();
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('draws nothing for an empty render parameter', () => {
    const makeApp = vi.fn(() => <div>the app</div>);
    const { container } = render(<Root search="?render=" app={makeApp} />);
    expect(container.innerHTML).toBe('');
    expect(makeApp).not.toHaveBeenCalled();
  });

  it('draws the app for a page that is not a frame', () => {
    const { getByText } = render(<Root search="" app={() => <div>the app</div>} />);
    expect(getByText('the app')).toBeTruthy();
  });
});

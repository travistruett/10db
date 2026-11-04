import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Root } from './root';

// A page opened with a `render` parameter is a frame the window draws a screen in. If its address
// does not parse, it must not become the app under the UI token, and it tells its parent why at once.

let heard: { source?: string; kind?: string; reason?: string }[];
const listen = (event: MessageEvent): void => {
  const data = event.data as { source?: string };
  if (data.source === 'tendb-screen') heard.push(data);
};
beforeEach(() => {
  heard = [];
  window.addEventListener('message', listen);
});
afterEach(() => {
  window.removeEventListener('message', listen);
});

describe('Root', () => {
  it('refuses to its parent, naming the bad address and leaking no token, when a frame address does not parse', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    render(
      <Root
        search="?render=secret-token&daemon=http%3A%2F%2Flocalhost%3A4317&project=nope&screen=board"
        app={() => <div>the app</div>}
      />,
    );
    await waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard[0]).toMatchObject({ source: 'tendb-screen', kind: 'refused' });
    const reason = heard[0]?.reason ?? '';
    expect(reason).toContain('address');
    expect(reason).toContain('daemon=http://localhost:4317');
    expect(reason).toContain('project=nope');
    expect(reason).not.toContain('secret-token');
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('keeps the bad value and the advice inside the 300 characters a refusal takes, with real-length ids on the task screen', async () => {
    const id = (prefix: string): string => `${prefix}_01a1a490-526d-7115-9bb2-d21c0d0d3271`;
    expect(id('prj')).toHaveLength(40);
    const search = new URLSearchParams({
      render: 'secret-token',
      daemon: 'http://localhost:4317',
      project: id('prj'),
      screen: 'task',
      shape: id('shp'),
      task: id('tsk'),
    }).toString();
    render(<Root search={`?${search}`} app={() => <div>the app</div>} />);
    await waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    const reason = heard[0]?.reason ?? '';
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).toContain('daemon=http://localhost:4317');
    expect(reason).toContain(`task=${id('tsk')}`);
    expect(reason).toContain('http://127.0.0.1:<port>');
    expect(reason.endsWith('.')).toBe(true);
  });

  it('keeps the advice and stays inside 300 characters when every value is as long as it may be', async () => {
    const long = 'x'.repeat(200);
    const search = new URLSearchParams({
      render: 'secret-token',
      daemon: long,
      project: long,
      screen: long,
      shape: long,
      task: long,
    }).toString();
    render(<Root search={`?${search}`} app={() => <div>the app</div>} />);
    await waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    const reason = heard[0]?.reason ?? '';
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).toContain('http://127.0.0.1:<port>');
    expect(reason).toContain('daemon=xxx');
  });

  it('says nothing to its parent for a page that is not a frame', () => {
    render(<Root search="" app={() => <div>the app</div>} />);
    expect(heard).toEqual([]);
  });

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

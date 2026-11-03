import { mintId } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shapeQueries from './daemon/shape-queries';
import { baseHandlers, eventStream, renderApp, server } from './test/daemon';

beforeEach(() => {
  server.use(...baseHandlers(), eventStream.addEventListener('connection', () => undefined));
  // The crash is the point: the view's own behaviour is tested elsewhere. The test setup has
  // already loaded the router and the view, so a module mock would not reach them; a spy does.
  vi.spyOn(shapeQueries, 'useShapeView').mockImplementation(() => {
    throw new Error('kaboom');
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Plan routes', () => {
  it('name the view Plan when it crashes on a new conversation', async () => {
    const { router } = renderApp('/shape');
    expect(await screen.findByText('Something went wrong in Plan.')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/shape');
  });

  it('name the view Plan when it crashes on a past conversation', async () => {
    const path = `/shape/${mintId('Shape')}`;
    const { router } = renderApp(path);
    expect(await screen.findByText('Something went wrong in Plan.')).toBeTruthy();
    expect(router.state.location.pathname).toBe(path);
  });
});

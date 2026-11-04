import { mintId, type ScreenRenderRequest } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { frameUrl, parseRenderParams } from './render-params';

// Shape spec §5.5: the app draws a screen in a hidden frame of itself. What the frame is told is in
// its URL, and it believes only what a screen can be: a known screen, the daemon's own loopback
// address and a token.

const projectId = mintId('Project');
const shapeId = mintId('Shape');
const taskId = mintId('Task');

const request = (over: Partial<ScreenRenderRequest> = {}): ScreenRenderRequest => ({
  id: 'req-1',
  screen: 'board',
  projectId,
  shapeId,
  width: 1200,
  height: 900,
  token: 'render-token',
  ...over,
});
const roundTrip = (over: Partial<ScreenRenderRequest> = {}, daemon = 'http://127.0.0.1:4999') =>
  parseRenderParams(new URL(frameUrl('tauri://localhost', request(over), daemon)).search);

describe('the frame’s URL', () => {
  it('is the app’s own address, so the frame is the app and nothing else', () => {
    expect(frameUrl('tauri://localhost', request(), 'http://127.0.0.1:4999')).toMatch(
      /^tauri:\/\/localhost\/\?/,
    );
    expect(frameUrl('http://localhost:1420', request(), 'http://127.0.0.1:4999')).toMatch(
      /^http:\/\/localhost:1420\/\?/,
    );
  });

  it('carries the screen, the project, the token and the daemon, and reads back as them', () => {
    expect(roundTrip()).toEqual({
      token: 'render-token',
      daemon: 'http://127.0.0.1:4999',
      projectId,
      screen: 'board',
      path: '/board',
    });
  });

  it('opens each screen at its route: Plan as this conversation, a task’s drawer on the Board', () => {
    expect(roundTrip({ screen: 'factory' })?.path).toBe('/factory');
    expect(roundTrip({ screen: 'inbox' })?.path).toBe('/inbox');
    expect(roundTrip({ screen: 'plan' })?.path).toBe(`/shape/${shapeId}`);
    expect(roundTrip({ screen: 'task', taskId })?.path).toBe(`/board?task=${taskId}`);
  });
});

describe('what the frame believes', () => {
  const good = new URL(frameUrl('tauri://localhost', request(), 'http://127.0.0.1:4999')).search;

  it('is not a render frame without the token, the project or a screen', () => {
    expect(parseRenderParams('')).toBeNull();
    expect(parseRenderParams('?render=1')).toBeNull();
    const without = (key: string): string => {
      const params = new URLSearchParams(good);
      params.delete(key);
      return `?${params.toString()}`;
    };
    for (const key of ['render', 'daemon', 'project', 'screen']) {
      expect(parseRenderParams(without(key)), key).toBeNull();
    }
  });

  it('takes only the daemon’s own loopback address, never another host', () => {
    for (const daemon of [
      'https://example.com',
      'http://localhost:4999',
      'http://127.0.0.1.evil.test:4999',
      'http://user@127.0.0.1:4999',
      'http://127.0.0.1',
      'javascript:alert(1)',
      'not a url',
    ])
      expect(roundTrip({}, daemon), daemon).toBeNull();
  });

  it('takes only a known screen, a task with a task id, and ids that are ids', () => {
    expect(roundTrip({ screen: 'settings' as never })).toBeNull();
    expect(roundTrip({ screen: 'task' })).toBeNull();
    expect(roundTrip({ projectId: 'prj_x' })).toBeNull();
    expect(roundTrip({ screen: 'plan', shapeId: '../x' })).toBeNull();
  });
});

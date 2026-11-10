import { describe, expect, it } from 'vitest';
import { AppUrl } from './entities';
import { mintId } from './ids';
import {
  PageRoute,
  PicturesStatusDto,
  routeUrl,
  SCREENS_MATRIX_DEFAULT,
  ScreensMatrix,
  TaskScreensDto,
} from './task-screens';

const APP = AppUrl.parse('http://localhost:8800');

const ROUTES = [
  { name: 'a path', route: '/people', url: 'http://localhost:8800/people' },
  { name: 'the root', route: '/', url: 'http://localhost:8800/' },
  {
    name: 'a query, kept',
    route: '/people?tab=all&x=1',
    url: 'http://localhost:8800/people?tab=all&x=1',
  },
  { name: 'dots stay on the app', route: '/a/../b', url: 'http://localhost:8800/b' },
  { name: 'another origin', route: 'http://127.0.0.1:9000/people', url: null },
  { name: 'a scheme', route: 'http:/people', url: null },
  { name: 'a host after two slashes', route: '//evil.example/people', url: null },
  { name: 'a backslash', route: '/\\evil.example', url: null },
  { name: 'a space', route: '/people list', url: null },
  { name: 'a tab', route: '/people\tlist', url: null },
  { name: 'a control character', route: '/people\u0000', url: null },
  { name: 'a fragment', route: '/people#top', url: null },
  { name: 'a relative path', route: 'people', url: null },
  { name: 'too long', route: `/${'a'.repeat(512)}`, url: null },
];

describe('PageRoute and routeUrl', () => {
  it.each(ROUTES)('$name', ({ route, url }) => {
    expect(PageRoute.safeParse(route).success).toBe(url !== null);
    expect(routeUrl(APP, route)).toBe(url);
  });

  it('answers no address on another loopback origin', () => {
    expect(routeUrl(AppUrl.parse('http://127.0.0.1:8800'), '/people')).toBe(
      'http://127.0.0.1:8800/people',
    );
  });
});

const MATRICES = [
  { name: 'the default', matrix: SCREENS_MATRIX_DEFAULT, ok: true },
  {
    name: 'two viewports and two themes: four pictures',
    matrix: {
      viewports: [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ],
      themes: ['light', 'dark'],
    },
    ok: true,
  },
  {
    name: 'three viewports and two themes: six pictures',
    matrix: {
      viewports: [
        { width: 1440, height: 900 },
        { width: 768, height: 1024 },
        { width: 390, height: 844 },
      ],
      themes: ['light', 'dark'],
    },
    ok: false,
  },
  {
    name: 'no viewport',
    matrix: { viewports: [], themes: ['default'] },
    ok: false,
  },
  {
    name: 'a viewport named twice',
    matrix: {
      viewports: [
        { width: 1440, height: 900 },
        { width: 1440, height: 900 },
      ],
      themes: ['default'],
    },
    ok: false,
  },
  {
    name: 'a theme named twice',
    matrix: { viewports: [{ width: 1440, height: 900 }], themes: ['dark', 'dark'] },
    ok: false,
  },
  {
    name: 'a viewport too narrow',
    matrix: { viewports: [{ width: 319, height: 900 }], themes: ['default'] },
    ok: false,
  },
  {
    name: 'a viewport too tall',
    matrix: { viewports: [{ width: 1440, height: 2401 }], themes: ['default'] },
    ok: false,
  },
];

describe('ScreensMatrix', () => {
  it.each(MATRICES)('$name', ({ matrix, ok }) => {
    expect(ScreensMatrix.safeParse(matrix).success).toBe(ok);
  });

  it('names the cap when there are too many pictures', () => {
    const parsed = ScreensMatrix.safeParse(MATRICES[2]?.matrix);
    expect(parsed.error?.issues[0]?.message).toMatch(/at most 4 pictures/);
  });
});

describe('the screens of a task and the pictures status', () => {
  it('reads a task with a before and a turn picture', () => {
    const taskId = mintId('Task');
    const screen = {
      id: mintId('TaskScreen'),
      taskId,
      turnId: null,
      turnSeq: null,
      kind: 'before',
      route: '/people',
      viewport: { width: 1440, height: 900 },
      theme: 'default',
      width: 1440,
      height: 900,
      size: 1234,
      sha256: 'a'.repeat(64),
      keptSha: null,
      createdAt: '2026-11-10T12:00:00.000Z',
    };
    const turn = {
      ...screen,
      id: mintId('TaskScreen'),
      kind: 'turn',
      turnId: mintId('PassTurn'),
      turnSeq: 2,
    };
    expect(
      TaskScreensDto.parse({ taskId, screens: [screen, turn], fromGoal: [] }).screens,
    ).toHaveLength(2);
  });

  it('reads each state of the browser and the last sign-in', () => {
    for (const state of ['off', 'fetching', 'ready', 'refused'])
      expect(
        PicturesStatusDto.safeParse({ browser: { state, problem: null }, signIn: null }).success,
      ).toBe(true);
    expect(
      PicturesStatusDto.parse({
        browser: { state: 'ready', problem: null },
        signIn: { problem: 'the dev login printed no address', at: '2026-11-10T12:00:00.000Z' },
      }).signIn?.problem,
    ).toBe('the dev login printed no address');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AreaRole, type AreaDef } from '@10db/contracts';
import {
  createTestStore,
  getAppSetting,
  getProject,
  patchProject,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capturingLogger, createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { PAGE_LABELS_GUESSED_KEY, guessPageLabelsOnce } from './page-label-guess';

/** A code-routed app whose nav calls `/shape` "Plan" and `/board` "Board". */
const APP: Record<string, string> = {
  'package.json': '{ "name": "web" }\n',
  'src/router.tsx': `import { createRootRoute, createRoute } from '@tanstack/react-router';
import { BoardPage } from './views/board/board-page';
import { ShapePage } from './views/shape/shape-page';
const root = createRootRoute({});
const boardRoute = createRoute({ getParentRoute: () => root, path: '/board', component: BoardPage });
const shapeRoute = createRoute({ getParentRoute: () => root, path: '/shape', component: ShapePage });
export const routeTree = root.addChildren([boardRoute, shapeRoute]);
`,
  'src/views/board/board-page.tsx': 'export function BoardPage() { return null; }\n',
  'src/views/shape/shape-page.tsx': 'export function ShapePage() { return null; }\n',
  'src/shell/app-layout.tsx': `const NAV = [
  { to: '/board', label: 'Board' },
  { to: '/shape', label: 'Plan' },
];
export function AppLayout() { return NAV; }
`,
};

const shape: AreaDef = {
  name: 'shape',
  globs: ['src/views/shape/**'],
  role: AreaRole.Page,
  route: '/shape',
};
const board: AreaDef = {
  name: 'board',
  globs: ['src/views/board/**'],
  role: AreaRole.Page,
  route: '/board',
  label: 'Work',
};
const rest: AreaDef = { name: 'app', globs: ['src/shell/**', 'src/router.tsx', '*'] };

let repo: TempDir;
let store: Store;
let close: () => void;
let state: StateStore;
beforeEach(() => {
  repo = createTempRepo();
  for (const [file, text] of Object.entries(APP)) {
    mkdirSync(dirname(join(repo.path, file)), { recursive: true });
    writeFileSync(join(repo.path, file), text);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
  git('add', '.');
  git('commit', '-q', '-m', 'app');
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
});
afterEach(() => {
  close();
  repo.cleanup();
});

describe('guessPageLabelsOnce', () => {
  it('labels an unlabelled page from the nav, keeps a label the builder set, and never guesses a project again', async () => {
    const project = seedProject(store, { repoPath: repo.path, areas: [shape, board, rest] });
    const logger = capturingLogger();
    await guessPageLabelsOnce({ state, git: createGit(), logger });

    const labels = () =>
      Object.fromEntries(getProject(state.db, project.id).areas.map((a) => [a.name, a.label]));
    expect(labels()).toEqual({ shape: 'Plan', board: 'Work', app: undefined });
    expect(getAppSetting(state.db, PAGE_LABELS_GUESSED_KEY)).toEqual([project.id]);

    // The builder clears the label: a later start leaves it cleared.
    state.write((ctx) => {
      patchProject(ctx, project.id, { areas: [shape, board, rest] });
    });
    await guessPageLabelsOnce({ state, git: createGit(), logger });
    expect(labels()).toEqual({ shape: undefined, board: 'Work', app: undefined });
    expect(logger.lines()).toEqual([]);
  });

  it('tries a project whose repository it cannot read again at the next start', async () => {
    const project = seedProject(store, {
      repoPath: join(repo.path, 'missing'),
      areas: [shape, board, rest],
    });
    const logger = capturingLogger();
    await guessPageLabelsOnce({ state, git: createGit(), logger });

    expect(getProject(state.db, project.id).areas.find((a) => a.name === 'shape')?.label).toBe(
      undefined,
    );
    expect(getAppSetting(state.db, PAGE_LABELS_GUESSED_KEY)).toBe(undefined);
    expect(logger.lines().join('\n')).toContain('page labels not guessed');
  });
});

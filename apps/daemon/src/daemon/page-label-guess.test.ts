import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AreaRole, type AreaDef, type ProjectId } from '@10db/contracts';
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
import {
  PAGE_LABELS_PENDING_KEY,
  guessPendingPageLabels,
  seedPendingPageLabels,
  type PageLabelGuessDeps,
} from './page-label-guess';
import { createServices } from './services';

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

/** Only the project patch runs here, and it reads the state store, so that is the real one. */
function builderServices() {
  // A cast at a test boundary: saving a project's areas touches nothing else of the deps.
  return createServices({ state, daemonPort: () => null } as unknown as Parameters<
    typeof createServices
  >[0]);
}

const labels = (id: ProjectId) =>
  Object.fromEntries(getProject(state.db, id).areas.map((a) => [a.name, a.label]));

describe('page label guesses', () => {
  it('label an unlabelled page of a listed project from the nav, keep a label the builder set, and run once', async () => {
    const project = seedProject(store, { repoPath: repo.path, areas: [shape, board, rest] });
    seedPendingPageLabels(state);
    const logger = capturingLogger();
    await guessPendingPageLabels({ state, git: createGit(), logger });

    expect(labels(project.id)).toEqual({ shape: 'Plan', board: 'Work', app: undefined });
    expect(getAppSetting(state.db, PAGE_LABELS_PENDING_KEY)).toEqual([]);

    // The builder clears the label: a later start leaves it cleared.
    state.write((ctx) => {
      patchProject(ctx, project.id, { areas: [shape, board, rest] });
    });
    seedPendingPageLabels(state);
    await guessPendingPageLabels({ state, git: createGit(), logger });
    expect(labels(project.id)).toEqual({ shape: undefined, board: 'Work', app: undefined });
    expect(logger.lines()).toEqual([]);
  });

  it('never label a project added after the list was made', async () => {
    seedPendingPageLabels(state);
    const project = seedProject(store, { repoPath: repo.path, areas: [shape, board, rest] });
    seedPendingPageLabels(state);
    await guessPendingPageLabels({ state, git: createGit(), logger: capturingLogger() });
    expect(labels(project.id)).toEqual({ shape: undefined, board: 'Work', app: undefined });
  });

  it.each([
    ['before the start reads git', false],
    ['while the start reads git', true],
  ])('leave areas the builder saved %s as saved', async (_name, midRead) => {
    const project = seedProject(store, { repoPath: repo.path, areas: [shape, board, rest] });
    seedPendingPageLabels(state);
    const save = () => builderServices().patchProject(project.id, { areas: [shape, board, rest] });
    const real = createGit();
    const git: PageLabelGuessDeps['git'] = {
      survey: async (...args) => {
        if (midRead) await save();
        return real.survey(...args);
      },
      surveyTexts: (...args) => real.surveyTexts(...args),
    };
    if (!midRead) await save();
    await guessPendingPageLabels({ state, git, logger: capturingLogger() });
    expect(labels(project.id)).toEqual({ shape: undefined, board: 'Work', app: undefined });
    expect(getAppSetting(state.db, PAGE_LABELS_PENDING_KEY)).toEqual([]);
  });

  it('keep a project whose repository it cannot read for the next start', async () => {
    const project = seedProject(store, {
      repoPath: join(repo.path, 'missing'),
      areas: [shape, board, rest],
    });
    seedPendingPageLabels(state);
    const logger = capturingLogger();
    await guessPendingPageLabels({ state, git: createGit(), logger });

    expect(labels(project.id)['shape']).toBe(undefined);
    expect(getAppSetting(state.db, PAGE_LABELS_PENDING_KEY)).toEqual([project.id]);
    expect(logger.lines().join('\n')).toContain('page labels not guessed');
  });
});

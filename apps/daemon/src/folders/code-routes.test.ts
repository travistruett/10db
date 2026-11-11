import { describe, expect, it } from 'vitest';
import { codeRoutes, routerFiles } from './code-routes';
import { NO_ALIASES, readPathAliases } from './import-graph';

const VIEWS = [
  'ui/src/views/board/board-view.tsx',
  'ui/src/views/inbox/inbox-view.tsx',
  'ui/src/views/settings/settings-view.tsx',
  'ui/src/views/review/review-view.tsx',
  'ui/src/views/shared.tsx',
  'ui/src/pages/people/index.tsx',
];

interface Row {
  readonly name: string;
  readonly router: string;
  readonly pages: readonly { name: string; folder: string; route?: string }[];
  readonly unrouted?: readonly string[];
}

describe('codeRoutes', () => {
  it.each<Row>([
    {
      name: 'TanStack route objects, through a component defined in the file',
      router: `
import { createRoute } from '@tanstack/react-router';
import { BoardView } from './views/board/board-view';
import { InboxView } from '@/views/inbox/inbox-view';
function BoardPage() {
  return (<Boundary name="Board"><BoardView /></Boundary>);
}
const boardRoute = createRoute({ getParentRoute: () => root, path: '/board', validateSearch: (s) => { return {}; }, component: BoardPage });
const inboxRoute = createRoute({
  path: "/inbox",
  component: InboxView,
});`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'React Router JSX with element and component',
      router: `
import Board from './views/board/board-view';
import { InboxView as Inbox } from './views/inbox/inbox-view';
const People = lazy(() => import('./pages/people'));
export const App = () => (
  <Routes>
    <Route path="/board" element={<Board />} />
    <Route path='/inbox' component={Inbox} />
    <Route path="/people" element={<People />} />
  </Routes>
);`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
        { name: 'people', folder: 'ui/src/pages/people', route: '/people' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'the shortest static path wins; a page with only a parameter path gets no route',
      router: `
import { BoardView } from './views/board/board-view';
import { SettingsView } from './views/settings/settings-view';
const routes = [
  { path: '/board/archive', Component: BoardView },
  { path: '/board', element: <BoardView /> },
  { path: '/board/:id', component: BoardView },
  { path: '/settings/$section', component: SettingsView },
];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
        { name: 'settings', folder: 'ui/src/views/settings' },
      ],
      unrouted: ['ui/src/views/inbox', 'ui/src/views/review'],
    },
    {
      name: 'a route to a module directly in views, or to a package, is no page',
      router: `
import { Shared } from './views/shared';
import { Thing } from 'some-package';
const a = createRoute({ path: '/shared', component: Shared });
const b = createRoute({ path: '/thing', component: Thing });`,
      pages: [],
    },
  ])('$name', ({ router, pages, unrouted }) => {
    const files = [...VIEWS, 'ui/src/router.tsx'];
    const found = codeRoutes({
      files,
      routers: new Map([['ui/src/router.tsx', router]]),
      aliases: readPathAliases({
        path: 'ui/tsconfig.json',
        text: '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      }),
    });
    expect(found.pages).toEqual(pages);
    expect(found.unrouted.map((u) => u.folder)).toEqual(unrouted ?? []);
  });

  it('names each unrouted view folder with why', () => {
    const found = codeRoutes({
      files: [...VIEWS, 'ui/src/main.tsx'],
      routers: new Map([
        [
          'ui/src/main.tsx',
          `import { B } from './views/board/board-view';\n<Route path="/b" element={<B/>} />`,
        ],
      ]),
      aliases: NO_ALIASES,
    });
    expect(found.unrouted).toContainEqual({
      name: 'review',
      folder: 'ui/src/views/review',
      reason: 'no route shows it',
    });
  });
});

describe('codeRoutes over a hostile router file', () => {
  it.each([
    { name: 'unclosed route objects', text: `{ path: "/x", `.repeat(20_000) },
    { name: 'unclosed Route tags', text: '<Route path="/x" element={'.repeat(10_000) },
    {
      name: 'routes to one local component',
      text: `function A() {}\n${'{ path: "/a", component: A },'.repeat(8_000)}`,
    },
    {
      name: 'routes to many components defined nowhere',
      text: Array.from(
        { length: 8_000 },
        (_, i) => `{ path: "/a", component: C${String(i)} },`,
      ).join(''),
    },
  ])('reads $name in linear time', ({ text }) => {
    const started = performance.now();
    codeRoutes({
      files: VIEWS,
      routers: new Map([['ui/src/router.tsx', text]]),
      aliases: NO_ALIASES,
    });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('routerFiles', () => {
  it('finds router, routes, App and main files under the unit’s source folder', () => {
    expect(
      routerFiles(
        [
          'ui/src/router.tsx',
          'ui/src/app/routes.ts',
          'ui/src/App.jsx',
          'ui/src/main.tsx',
          'ui/src/main.css',
          'ui/vite.config.ts',
          'ui/scripts/main.ts',
          'other/src/router.tsx',
        ],
        'ui',
      ),
    ).toEqual(['ui/src/router.tsx', 'ui/src/app/routes.ts', 'ui/src/App.jsx', 'ui/src/main.tsx']);
  });
});

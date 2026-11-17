import { describe, expect, it } from 'vitest';
import { codeRoutes, navFiles, routerFiles } from './code-routes';
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
  /** The text of a nav file beside the router, read for labels only. */
  readonly nav?: string;
  readonly pages: readonly { name: string; folder: string; route?: string; label?: string }[];
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
      name: 'a comment in a route object, holding brackets and quotes, is read past',
      router: `
import { InboxView } from './views/inbox/inbox-view';
const inbox = createRoute({
  path: '/inbox',
  // \`inbox\` opens a card (a link from elsewhere) and isn't { closed
  /* nor is this ( one */
  component: InboxView,
});`,
      pages: [{ name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' }],
      unrouted: ['ui/src/views/board', 'ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a page named only by a parameter path takes the longest static prefix the router defines',
      router: `
import { SettingsView } from './views/settings/settings-view';
const index = createRoute({ path: '/settings', beforeLoad: () => { throw redirect({ to: '/settings/general' }); } });
const deep = createRoute({ path: '/settings/team', beforeLoad: () => undefined });
const section = createRoute({ path: '/settings/$section', component: SettingsView });
const other = createRoute({ path: '/settings/team/$member/$tab', component: SettingsView });`,
      pages: [{ name: 'settings', folder: 'ui/src/views/settings', route: '/settings/team' }],
      unrouted: ['ui/src/views/board', 'ui/src/views/inbox', 'ui/src/views/review'],
    },
    {
      name: 'a nested relative path joins its parent route, in JSX, children and getParentRoute',
      router: `
import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
import { SettingsView } from './views/settings/settings-view';
export const App = () => (
  <Routes>
    <Route path="/admin" element={<Shell />}>
      <Route path="board" element={<BoardView />} />
    </Route>
  </Routes>
);
const routes = [{ path: '/mail', children: [{ path: 'inbox', component: InboxView }] }];
const team = createRoute({ getParentRoute: () => root, path: '/team' });
const settings = createRoute({ getParentRoute: () => team, path: 'settings', component: SettingsView });`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/admin/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/mail/inbox' },
        { name: 'settings', folder: 'ui/src/views/settings', route: '/team/settings' },
      ],
      unrouted: ['ui/src/views/review'],
    },
    {
      name: 'an apostrophe in JSX text hides no later route',
      router: `
import { InboxView } from './views/inbox/inbox-view';
const Note = () => <p>Don't panic</p>;
const inbox = createRoute({ path: '/inbox', component: InboxView });
const tag = <Route path="/inbox2" element={<InboxView />} />;`,
      pages: [{ name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' }],
      unrouted: ['ui/src/views/board', 'ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a </Routes> or </RouteGuard> closes no Route, and a tag too long to read still nests',
      router: `
import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
export const App = () => (
  <Route path="/admin" element={<Shell />}>
    <Routes></Routes>
    <RouteGuard></RouteGuard>
    <Route path="x" element={<Wide />} data-pad="${'a'.repeat(5000)}"></Route>
    <Route path="board" element={<BoardView />} />
  </Route>
);
const tail = <Route path="/inbox" element={<InboxView />} />;`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/admin/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: "a nav array like the app shell's gives each route its label",
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });`,
      nav: `const NAV = [
  { to: '/board', label: 'Board', icon: IconLayoutKanban },
  { to: '/inbox', label: 'Mail and questions', icon: IconInbox },
] as const;`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board', label: 'Board' },
        {
          name: 'inbox',
          folder: 'ui/src/views/inbox',
          route: '/inbox',
          label: 'Mail and questions',
        },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'no label in the nav, or one for another route, gives a page none',
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });`,
      nav: `const NAV = [{ to: '/board' }, { to: '/elsewhere', label: 'Elsewhere' }, { label: 'Lost' }];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'two routes on one line, a label before its path, path and href keys',
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });`,
      nav: `const NAV = [{ to: '/board', label: 'Work' }, { label: 'Mail', href: '/inbox' }];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board', label: 'Work' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox', label: 'Mail' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a nav that names its path `route` gives the label too',
      router: `import { BoardView } from './views/board/board-view';
const a = createRoute({ path: '/board', component: BoardView });`,
      nav: `const ITEMS = { board: { section: 'board', label: 'Work', route: '/board' } };`,
      pages: [{ name: 'board', folder: 'ui/src/views/board', route: '/board', label: 'Work' }],
      unrouted: ['ui/src/views/inbox', 'ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a label that is not a plain string of 1-40 characters, or sits in another object, is no guess',
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });`,
      nav: `const NAV = [
  { to: '/board', label: t('board') },
  { to: '/inbox', label: '${'x'.repeat(41)}' },
  { to: '/inbox', children: [{ label: 'Nested' }] },
];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a label with escaped quotes, and a route written with a trailing slash',
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });`,
      nav: `const NAV = [{ to: '/board/', label: 'Bob\\'s \\"work\\"' }];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board', label: 'Bob\'s "work"' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: "two labels for one route: the nav file's beats another file's, whichever is read first",
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });
const OTHER = [{ to: '/board', label: 'From the router' }, { to: '/inbox', label: 'Router inbox' }];`,
      nav: `const NAV = [{ to: '/board', label: 'From the nav' }];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board', label: 'From the nav' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox', label: 'Router inbox' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a label in the router file itself, past strings and comments that hold brackets',
      router: `import { BoardView } from './views/board/board-view';
import { InboxView } from './views/inbox/inbox-view';
const a = createRoute({ path: '/board', component: BoardView });
const b = createRoute({ path: '/inbox', component: InboxView });
// { to: '/board', label: 'In a comment' }
const text = "{ to: '/inbox', label: 'In a string' }";
const NAV = [{ to: '/inbox', label: 'Real' }];`,
      pages: [
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox', label: 'Real' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a component with its own const before the view it renders still shows that view',
      router: `
import { InboxView } from './views/inbox/inbox-view';
function InboxPage() {
  const search = useSearch();
  const navigate = useNavigate();
  return (<ViewBoundary name="Inbox"><InboxView search={search} onSearch={navigate} /></ViewBoundary>);
}
const inbox = createRoute({ path: '/inbox', component: InboxPage });`,
      pages: [{ name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' }],
      unrouted: ['ui/src/views/board', 'ui/src/views/review', 'ui/src/views/settings'],
    },
    {
      name: 'a component declared inside another function is still read, and its inner consts are not components',
      router: `
import { InboxView } from './views/inbox/inbox-view';
import { BoardView } from './views/board/board-view';
export function Routes() {
  const base = useBase();
  function InboxPage() {
    const search = useSearch();
    return <InboxView search={search} />;
  }
  const BoardPage = () => <BoardView />;
  return [
    createRoute({ path: '/inbox', component: InboxPage }),
    createRoute({ path: '/board', component: BoardPage }),
  ];
}`,
      pages: [
        { name: 'inbox', folder: 'ui/src/views/inbox', route: '/inbox' },
        { name: 'board', folder: 'ui/src/views/board', route: '/board' },
      ],
      unrouted: ['ui/src/views/review', 'ui/src/views/settings'],
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
  ])('$name', ({ router, nav, pages, unrouted }) => {
    const files = [...VIEWS, 'ui/src/router.tsx'];
    const found = codeRoutes({
      files,
      routers: new Map([['ui/src/router.tsx', router]]),
      ...(nav === undefined ? {} : { navs: new Map([['ui/src/app-layout.tsx', nav]]) }),
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
      name: 'a run of Route tags with no end',
      text: '<Route '.repeat(70_000),
    },
    {
      name: 'Route tags left open with no closing one',
      text: '<Route path="/a" element={<A/>}>'.repeat(16_000),
    },
    { name: 'unclosed nav objects', text: `{ to: "/a", label: "A", `.repeat(20_000) },
    { name: 'nav objects nested deep', text: `${'{a:'.repeat(20_000)}{ to: "/a", label: "A" }` },
    { name: 'quotes never closed', text: `{ to: "/a", label: '` + "'x".repeat(30_000) },
    {
      name: 'a route of slashes not at its end',
      text: `{ to: "${'/'.repeat(80_000)}x", label: "A" }`,
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

  it('joins relative paths under deep plain objects in linear time', () => {
    const text = `${'{a:'.repeat(20_000)}[${"{path:'a'},".repeat(4_000)}]${'}'.repeat(20_000)}`;
    const started = performance.now();
    codeRoutes({
      files: VIEWS,
      routers: new Map([['ui/src/router.tsx', text]]),
      aliases: NO_ALIASES,
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads Route tags nested 30,000 deep in linear time', () => {
    // Linear reads this in tens of milliseconds even under load; joining every path, quadratic, takes seconds.
    const started = performance.now();
    const found = codeRoutes({
      files: VIEWS,
      routers: new Map([['ui/src/router.tsx', '<Route path="aaaa">'.repeat(30_000)]]),
      aliases: NO_ALIASES,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(found.pages).toEqual([]);
  });
});

describe('navFiles', () => {
  it('finds source files named like a layout, nav, rail, sidebar, menu or shell, besides the routers', () => {
    expect(
      navFiles(
        [
          'ui/src/shell/app-layout.tsx',
          'ui/src/components/Sidebar.tsx',
          'ui/src/menu.ts',
          'ui/src/shell/rail-items.ts',
          'ui/src/navigate.ts',
          'ui/src/MainNavigation.tsx',
          'ui/src/nav.test.tsx',
          'ui/src/nav.stories.tsx',
          'ui/src/__tests__/nav.tsx',
          'ui/e2e/nav.ts',
          'ui/src/main.tsx',
          'ui/src/router.tsx',
          'ui/src/layout.css',
          'ui/src/views/board/board.tsx',
          'other/src/nav.tsx',
        ],
        'ui',
      ),
    ).toEqual([
      'ui/src/menu.ts',
      'ui/src/MainNavigation.tsx',
      'ui/src/shell/app-layout.tsx',
      'ui/src/components/Sidebar.tsx',
      'ui/src/shell/rail-items.ts',
    ]);
  });

  it('reads at most 20 of them, the shallowest first', () => {
    const many = Array.from({ length: 100 }, (_, i) => `ui/src/deep${String(i)}/nav.tsx`);
    const found = navFiles([...many, 'ui/src/layout.tsx'], 'ui');
    expect(found).toHaveLength(20);
    expect(found[0]).toBe('ui/src/layout.tsx');
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
    ).toEqual(['ui/src/router.tsx', 'ui/src/App.jsx', 'ui/src/main.tsx', 'ui/src/app/routes.ts']);
  });

  it('reads at most 20 of them, the shallowest first', () => {
    const many = Array.from({ length: 100 }, (_, i) => `ui/src/deep${String(i)}/router.tsx`);
    const found = routerFiles([...many, 'ui/src/main.tsx'], 'ui');
    expect(found).toHaveLength(20);
    expect(found[0]).toBe('ui/src/main.tsx');
  });
});

import { matchesGlob } from 'node:path';
import { PathPattern } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { AreaCandidateKind, deriveAreaCandidates, mergeCoupledCandidates } from './area-candidates';

const covered = (globs: readonly string[], file: string) =>
  globs.some((glob) => matchesGlob(file, glob));

const files = (dir: string, names: readonly string[]) => names.map((name) => `${dir}/${name}`);

/** Every tracked file matches the globs of exactly one candidate, and a project accepts each glob. */
function expectEachFileInOneCandidate(tracked: readonly string[], context = ''): void {
  const candidates = deriveAreaCandidates(tracked);
  for (const file of tracked)
    expect(
      candidates.filter((c) => covered(c.globs, file)).map((c) => c.label),
      `${context}${file}`,
    ).toHaveLength(1);
  for (const glob of candidates.flatMap((c) => c.globs))
    expect(PathPattern.safeParse(glob).success, `${context}${glob}`).toBe(true);
  expect(
    candidates.reduce((sum, c) => sum + c.files, 0),
    context,
  ).toBe(tracked.length);
}

/** xorshift32: the same layouts on every run, so a failure names a seed that shows it again. */
function seeded(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % below;
  };
}

const LAYOUT_FOLDERS = ['a', 'b', 'src', 'app', 'lib', '.x', '.y', '(g)', '(h)', '[id]'] as const;
const LAYOUT_NAMES = ['f.ts', 'page.tsx', '.env', '.keep', 'package.json'] as const;

/** Up to 40 files up to five folders deep, from names that make packages, routes and dot folders. */
function randomLayout(seed: number): string[] {
  const pick = seeded(seed);
  const tracked = new Set<string>();
  for (let n = pick(40); n >= 0; n -= 1) {
    const folders = Array.from({ length: pick(6) }, () => LAYOUT_FOLDERS[pick(10)] ?? 'a');
    tracked.add([...folders, LAYOUT_NAMES[pick(5)] ?? 'f.ts'].join('/'));
  }
  return [...tracked].sort();
}

/** This repository's layout, thinned: two apps, three packages, tests, docs and root config. */
const WORKSPACE = [
  'AGENTS.md',
  'Makefile',
  'package.json',
  'pnpm-workspace.yaml',
  '.gitignore',
  '.editorconfig',
  ...files('apps/daemon', ['package.json', '.env.example', 'src/a.ts', 'src/b.ts', 'test/c.ts']),
  ...files('apps/desktop', ['package.json', 'src/app.tsx', 'src/view.tsx', 'src-tauri/main.rs']),
  ...files('packages/contracts', ['package.json', 'src/a.ts', 'src/b.ts']),
  ...files('packages/db', ['package.json', 'src/schema.ts', 'drizzle/0000.sql']),
  ...files('packages/harness', ['package.json', 'skills/x/SKILL.md', 'hooks/y.mjs']),
  ...files('tests/repo', ['package.json', 'src/rules.test.ts']),
  ...files('docs', ['a.md', 'b.md', 'c.md']),
  ...files('.github', ['workflows/ci.yml', 'workflows/release.yml', 'CODEOWNERS']),
  '.10db/pr-scopes.json',
];

describe('deriveAreaCandidates', () => {
  it('makes one candidate for each app and each package of a workspace', () => {
    const candidates = deriveAreaCandidates(WORKSPACE);
    const units = candidates.filter((c) => c.kind === AreaCandidateKind.Unit).map((c) => c.label);
    expect(units.sort()).toEqual([
      'apps/daemon',
      'apps/desktop',
      'packages/contracts',
      'packages/db',
      'packages/harness',
      'tests/repo',
    ]);
  });

  it('keeps the globs of the units apart', () => {
    const candidates = deriveAreaCandidates(WORKSPACE);
    const daemon = candidates.find((c) => c.label === 'apps/daemon');
    expect(daemon?.globs).toContain('apps/daemon/**');
    expect(covered(daemon?.globs ?? [], 'apps/daemon/src/a.ts')).toBe(true);
    expect(covered(daemon?.globs ?? [], 'apps/desktop/src/app.tsx')).toBe(false);
    expect(covered(daemon?.globs ?? [], 'packages/db/src/schema.ts')).toBe(false);
  });

  it('gives every file to a candidate, dotfiles and dot folders included', () => {
    const candidates = deriveAreaCandidates(WORKSPACE);
    for (const file of WORKSPACE) {
      const owners = candidates.filter((c) => covered(c.globs, file));
      expect(owners.length, file).toBeGreaterThanOrEqual(1);
    }
  });

  it('puts the files at the top of the repository in a candidate of their own', () => {
    const candidates = deriveAreaCandidates(WORKSPACE);
    const top = candidates.find((c) => c.kind === AreaCandidateKind.Rest);
    expect(top?.globs).toContain('*');
    expect(covered(top?.globs ?? [], '.gitignore')).toBe(true);
    expect(covered(top?.globs ?? [], '.10db/pr-scopes.json')).toBe(true);
  });

  it('counts the files of each candidate', () => {
    const candidates = deriveAreaCandidates(WORKSPACE);
    expect(candidates.find((c) => c.label === 'apps/daemon')?.files).toBe(5);
    expect(candidates.find((c) => c.label === 'docs')?.files).toBe(3);
  });

  it('splits a Next.js app by route group and screen, and keeps lib apart', () => {
    const screens = ['decisions', 'memos', 'settings', 'strategy'];
    const tracked = [
      'frontend/package.json',
      'frontend/next.config.ts',
      'frontend/lib/a.ts',
      'frontend/lib/b.ts',
      'frontend/lib/c.ts',
      'frontend/app/layout.tsx',
      'frontend/app/(marketing)/page.tsx',
      'frontend/app/(marketing)/pricing/page.tsx',
      'frontend/app/(marketing)/about/page.tsx',
      ...screens.flatMap((s) => [
        `frontend/app/(product)/app/${s}/page.tsx`,
        `frontend/app/(product)/app/${s}/panel.tsx`,
      ]),
      'frontend/app/(product)/app/layout.tsx',
      'backend/pyproject.toml',
      'backend/app/main.py',
      'backend/app/models.py',
      'backend/tests/test_main.py',
    ];
    const candidates = deriveAreaCandidates(tracked);
    const labels = candidates.map((c) => c.label);
    for (const screen of screens) expect(labels).toContain(`frontend/app/(product)/app/${screen}`);
    expect(labels).toContain('frontend/app/(marketing)');
    expect(labels).toContain('frontend/lib');
    expect(labels).toContain('backend');
    const memos = candidates.find((c) => c.label === 'frontend/app/(product)/app/memos');
    expect(memos?.globs).toEqual(['frontend/app/(product)/app/memos/**']);
    for (const file of tracked)
      expect(candidates.filter((c) => covered(c.globs, file)).length, file).toBe(1);
  });

  it.each([
    { name: 'in a package of a workspace', app: 'web', top: ['package.json'] },
    { name: 'at the top of a repository that is one package', app: '', top: [] },
  ])('splits a Next.js app whose routes are under src/app: $name', ({ app, top }) => {
    const at = (path: string) => (app === '' ? path : `${app}/${path}`);
    const tracked = [
      ...top,
      at('package.json'),
      at('src/index.css'),
      at('src/app/layout.tsx'),
      ...['a', 'b', 'c'].map((screen) => at(`src/app/(shop)/${screen}/page.tsx`)),
      ...['button', 'card', 'menu'].map((name) => at(`src/components/${name}.tsx`)),
      at('src/lib/x.ts'),
    ];
    const labels = deriveAreaCandidates(tracked).map((c) => c.label);
    expect(labels).toContain(at('src/components'));
    for (const screen of ['a', 'b', 'c']) expect(labels).toContain(at(`src/app/(shop)/${screen}`));
    expectEachFileInOneCandidate(tracked);
  });

  it('splits a repository that is one package by its top folders', () => {
    const tracked = [
      'package.json',
      'README.md',
      ...files('src', ['a.ts', 'b.ts', 'c.ts']),
      ...files('test', ['a.test.ts', 'b.test.ts', 'c.test.ts']),
      ...files('docs', ['x.md', 'y.md', 'z.md']),
    ];
    const labels = deriveAreaCandidates(tracked).map((c) => c.label);
    expect(labels).toContain('src');
    expect(labels).toContain('test');
    expect(labels).toContain('docs');
  });

  it('folds small folders into the top-level candidate', () => {
    const tracked = ['package.json', 'tiny/one.txt', ...files('src', ['a.ts', 'b.ts', 'c.ts'])];
    const candidates = deriveAreaCandidates(tracked);
    expect(candidates.map((c) => c.label)).not.toContain('tiny');
    const top = candidates.find((c) => c.kind === AreaCandidateKind.Rest);
    expect(covered(top?.globs ?? [], 'tiny/one.txt')).toBe(true);
  });

  it('answers no candidate for a repository with no files', () => {
    expect(deriveAreaCandidates([])).toEqual([]);
  });

  it('leaves out the top of a repository that holds no file of its own', () => {
    const tracked = [
      ...files('packages/a', ['package.json', 'x.ts']),
      ...files('packages/b', ['package.json', 'y.ts']),
    ];
    const candidates = deriveAreaCandidates(tracked);
    expect(candidates.map((c) => c.label).sort()).toEqual(['packages/a', 'packages/b']);
  });

  it('gives every candidate a file and a glob when a route group holds no file of its own', () => {
    const screens = ['decisions', 'memos', 'settings'];
    const tracked = [
      'frontend/package.json',
      'frontend/app/layout.tsx',
      ...screens.map((s) => `frontend/app/(product)/app/${s}/page.tsx`),
    ];
    const candidates = deriveAreaCandidates(tracked);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.files, candidate.label).toBeGreaterThan(0);
      expect(candidate.globs.length, candidate.label).toBeGreaterThan(0);
    }
    for (const file of tracked)
      expect(candidates.filter((c) => covered(c.globs, file)).length, file).toBe(1);
  });

  it("matches a dynamic screen's own files with its globs, and no sibling's", () => {
    const app = 'frontend/app/(product)/app';
    const tracked = [
      'frontend/package.json',
      'frontend/app/layout.tsx',
      `${app}/[orgId]/page.tsx`,
      `${app}/[orgId]/settings/page.tsx`,
      `${app}/[orgId]/.env.local`,
      `${app}/o/page.tsx`,
      `${app}/memos/page.tsx`,
    ];
    const candidates = deriveAreaCandidates(tracked);
    const screen = candidates.find((c) => c.label === `${app}/[orgId]`);
    expect(screen?.files).toBe(3);
    for (const file of tracked.filter((f) => f.startsWith(`${app}/[orgId]/`)))
      expect(covered(screen?.globs ?? [], file), file).toBe(true);
    expect(covered(screen?.globs ?? [], `${app}/o/page.tsx`)).toBe(false);
  });

  // Each row holds folders whose names glob syntax reads, beside the folders that syntax would match.
  it.each([
    {
      name: 'Next.js dynamic segments',
      tracked: [
        'web/package.json',
        'web/app/layout.tsx',
        ...files('web/app/(shop)', ['[id]/page.tsx', 'i/page.tsx', 'd/page.tsx']),
        ...files('web/app/(shop)', ['[...slug]/page.tsx', '[[...slug]]/page.tsx']),
        ...files('web/app/(shop)', ['[]/page.tsx', '[id]/.hidden/x.ts', '[id]/.env']),
      ],
    },
    {
      name: 'wildcards and extglobs',
      tracked: [
        ...files('x*y', ['a.ts', 'b.ts', 'c.ts']),
        ...files('x?y', ['a.ts', 'b.ts', 'c.ts']),
        ...files('xzy', ['a.ts', 'b.ts', 'c.ts']),
        ...files('@(x)', ['a.ts', 'b.ts', 'c.ts']),
        ...files('!(x)', ['a.ts', 'b.ts', 'c.ts']),
        ...files('+(x)', ['a.ts', 'b.ts', 'c.ts']),
        ...files('x', ['a.ts', 'b.ts', 'c.ts']),
        'small*/one.ts',
        'small?/one.ts',
        'smallz/one.ts',
      ],
    },
    {
      name: 'braces, literal and expanding',
      tracked: [
        ...files('{{cookiecutter.slug}}', ['a.py', 'b.py', 'c.py']),
        ...files('{a,b}', ['a.ts', 'b.ts', 'c.ts']),
        ...files('{1..3}', ['a.ts', 'b.ts', 'c.ts']),
        ...files('a', ['a.ts', 'b.ts', 'c.ts']),
        ...files('2', ['a.ts', 'b.ts', 'c.ts']),
      ],
    },
    {
      name: 'names no exact glob passes as a path pattern',
      tracked: [
        ...files('a[b', ['a.ts', 'b.ts', 'c.ts']),
        ...files('c]d', ['a.ts', 'b.ts', 'c.ts']),
        ...files('back\\slash', ['a.ts', 'b.ts', 'c.ts']),
        ...files('c:drive', ['a.ts', 'b.ts', 'c.ts']),
        ...files('ab', ['a.ts', 'b.ts', 'c.ts']),
        ...files('cd', ['a.ts', 'b.ts', 'c.ts']),
      ],
    },
  ])(
    'gives every file to exactly one candidate, with globs a project accepts: $name',
    ({ tracked }) => {
      expectEachFileInOneCandidate(tracked);
    },
  );

  // Node's matcher lets no `*` or `**` match a name that starts with a dot, so each row puts dotfiles
  // and dot folders at one or more dot folders' depth below where a candidate starts.
  it.each([
    {
      name: 'a dotfile in a dot folder of a package',
      tracked: [
        'package.json',
        ...files('apps/web', ['package.json', 'src/a.ts', '.storybook/main.ts']),
        'apps/web/.storybook/.eslintrc.json',
      ],
    },
    {
      name: 'dot folders inside dot folders of a package',
      tracked: [
        ...files('apps/web', ['package.json', '.a/d.ts', '.a/.b/c.ts', '.a/.b/.c']),
        ...files('apps/web', ['x/.y/z/.w/v.ts', 'x/.y/.env']),
        ...files('apps/api', ['package.json', 'src/a.ts']),
      ],
    },
    {
      name: 'a small folder folded into the top of the repository',
      tracked: ['package.json', 'config/.a/.b', ...files('src', ['a.ts', 'b.ts', 'c.ts'])],
    },
    {
      name: 'a folder of its own',
      tracked: [
        ...files('docs', ['a.md', 'b.md', '.vitepress/config.ts', '.vitepress/.cache/deps.json']),
        ...files('src', ['a.ts', 'b.ts', 'c.ts']),
      ],
    },
    {
      name: 'a screen of a route group',
      tracked: [
        ...files('web', ['package.json', 'app/layout.tsx']),
        ...files('web/app/(shop)', ['a/page.tsx', 'b/page.tsx', 'c/page.tsx', 'a/.x/.y']),
      ],
    },
  ])(
    'gives every file to exactly one candidate, however deep its dot folders: $name',
    ({ tracked }) => {
      expectEachFileInOneCandidate(tracked);
    },
  );

  it('gives every file to exactly one candidate in layouts made at random', () => {
    for (let seed = 1; seed <= 400; seed += 1)
      expectEachFileInOneCandidate(randomLayout(seed), `seed ${String(seed)}: `);
  });

  it('gives a folder one glob for the dotfiles of all its subfolders', () => {
    const tracked = files('docs', ['x.md', 'a/.gitkeep', 'b/.gitkeep', 'c/d/.gitkeep']);
    const docs = deriveAreaCandidates(tracked).find((c) => c.label === 'docs');
    expect(docs?.globs).toEqual(['docs/**', 'docs/**/.*']);
    expect(covered(docs?.globs ?? [], 'docs/e/.gitkeep')).toBe(true);
  });
});

describe('mergeCoupledCandidates', () => {
  const folders = (names: readonly string[]) =>
    names.flatMap((name) => files(name, ['a.ts', 'b.ts', 'c.ts']));

  it('merges folders that nearly always change in the same commits', () => {
    const tracked = [...folders(['alpha', 'beta', 'gamma'])];
    const candidates = deriveAreaCandidates(tracked);
    const commits = [
      ...Array.from({ length: 6 }, () => ['alpha/a.ts', 'beta/a.ts']),
      ['gamma/a.ts'],
      ['gamma/b.ts'],
    ];
    const merged = mergeCoupledCandidates(candidates, commits);
    const pair = merged.find((c) => c.globs.includes('alpha/**'));
    expect(pair?.globs).toContain('beta/**');
    expect(pair?.files).toBe(6);
    expect(merged.some((c) => c.label === 'gamma')).toBe(true);
  });

  it('counts a commit file in the folder that holds it, a dotfile or a file since removed', () => {
    const candidates = deriveAreaCandidates(folders(['alpha', 'beta', 'gamma']));
    const commits = Array.from({ length: 6 }, (_, n) => [
      `alpha/.config/removed-${String(n)}.json`,
      'beta/.env',
    ]);
    const merged = mergeCoupledCandidates(candidates, commits);
    expect(merged.map((c) => c.label)).toContain('alpha + beta');
  });

  it('merges dynamic screens that nearly always change in the same commits', () => {
    const candidates = deriveAreaCandidates(folders(['[orgId]', '[teamId]', 'gamma']));
    const commits = Array.from({ length: 6 }, () => ['[orgId]/a.ts', '[teamId]/b.ts']);
    const merged = mergeCoupledCandidates(candidates, commits);
    expect(merged.map((c) => c.label)).toContain('[orgId] + [teamId]');
  });

  it('never merges two units, however often they change together', () => {
    const candidates = deriveAreaCandidates(WORKSPACE);
    const commits = Array.from({ length: 20 }, () => [
      'apps/daemon/src/a.ts',
      'packages/contracts/src/a.ts',
    ]);
    const merged = mergeCoupledCandidates(candidates, commits);
    expect(merged.map((c) => c.label).sort()).toEqual(candidates.map((c) => c.label).sort());
  });

  it('ignores a commit that touches many candidates', () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    const candidates = deriveAreaCandidates(folders(names));
    const sweep = names.map((n) => `${n}/a.ts`);
    const merged = mergeCoupledCandidates(
      candidates,
      Array.from({ length: 10 }, () => sweep),
    );
    expect(merged).toHaveLength(candidates.length);
  });

  it('leaves candidates alone when there is no history', () => {
    const candidates = deriveAreaCandidates(folders(['alpha', 'beta']));
    expect(mergeCoupledCandidates(candidates, [])).toEqual(candidates);
  });
});

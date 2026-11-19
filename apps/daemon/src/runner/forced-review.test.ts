import { DEFAULT_HAZARDS, type HazardDef, type KindDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { forcedReview } from './forced-review';

const file = (path: string, added: number | null, removed: number | null) => ({
  path,
  added,
  removed,
});
const files = (n: number) => Array.from({ length: n }, (_, i) => file(`f${String(i)}.ts`, 1, 1));
const security = { key: 'security', alwaysReviewed: true };
const ui = { key: 'ui', alwaysReviewed: false };

interface Row {
  name: string;
  kinds?: Pick<KindDto, 'key' | 'alwaysReviewed'>[];
  files: ReturnType<typeof files>;
  hazards?: HazardDef[];
  want: string | null;
}

function check(rows: readonly Row[]): void {
  for (const { name, kinds, files: changed, want, hazards } of rows) {
    expect
      .soft(forcedReview(kinds ?? [], { files: changed }, hazards ?? DEFAULT_HAZARDS), name)
      .toBe(want);
  }
}

describe('forcedReview', () => {
  it('forces review for an always-reviewed kind, more than 15 files, more than 400 lines or a binary file, and names it', () => {
    check([
      {
        name: 'a kind that is always reviewed forces review, and is named',
        kinds: [security],
        files: files(1),
        want: 'an always-reviewed kind (security)',
      },
      {
        name: 'one always-reviewed kind among others forces review',
        kinds: [ui, security],
        files: files(1),
        want: 'an always-reviewed kind (security)',
      },
      { name: '16 files force review', files: files(16), want: '16 changed files' },
      {
        name: '401 lines force review',
        files: [file('a.ts', 201, 200)],
        want: '401 changed lines',
      },
      {
        name: 'a binary file forces review',
        files: [file('a.png', null, null)],
        want: 'a binary file (a.png)',
      },
      {
        name: 'a text file beside a binary one forces review',
        files: [file('a.ts', 1, 1), file('b.bin', null, null)],
        want: 'a binary file (b.bin)',
      },
    ]);
  });

  it('forces review for a change to a manifest, lockfile, migration, CI, agent file or project hazard, in hidden folders too', () => {
    check([
      ...[
        'package.json',
        'apps/web/package.json',
        'pnpm-lock.yaml',
        'apps/web/pnpm-lock.yaml',
        'package-lock.json',
        'yarn.lock',
        'Cargo.toml',
        'src-tauri/Cargo.toml',
        'src-tauri/Cargo.lock',
        'go.mod',
        'pyproject.toml',
        'uv.lock',
        'packages/db/drizzle/0001_x.sql',
        'db/migrations/001.sql',
        '.github/workflows/ci.yml',
        '.github/CODEOWNERS',
        '.claude/settings.json',
        'AGENTS.md',
        'apps/daemon/AGENTS.md',
        'CLAUDE.md',
        'docs/CLAUDE.md',
        '.codex/rules/default.rules',
        'tools/.scripts/package.json',
        '.tools/package.json',
        'a/.b/.c/pnpm-lock.yaml',
        'tools/.scripts/Cargo.lock',
        'tools/.db/migrations/001.sql',
        'packages/.db/drizzle/0001_x.sql',
        'tools/.hidden/AGENTS.md',
      ].map((path) => ({
        name: `a change to ${path} forces review`,
        files: [file('a.ts', 1, 1), file(path, 1, 1)],
        want: `changes \`${path}\``,
      })),
      {
        name: "a path in the project's own hazard forces review",
        files: [file('contracts/api.ts', 1, 1)],
        hazards: [{ name: 'contracts', globs: ['contracts/**'], commands: [] }],
        want: 'changes `contracts/api.ts`',
      },
      {
        name: "a path in a hidden folder of the project's own hazard forces review",
        files: [file('contracts/.gen/api.ts', 1, 1)],
        hazards: [{ name: 'contracts', globs: ['contracts/**'], commands: [] }],
        want: 'changes `contracts/.gen/api.ts`',
      },
    ]);
  });

  it('forces nothing for a small plain change, kinds not always reviewed, or 15 files and 400 lines', () => {
    check([
      { name: 'a small plain change forces nothing', files: files(3), want: null },
      {
        name: 'kinds that are not always reviewed force nothing',
        kinds: [ui],
        files: files(1),
        want: null,
      },
      { name: '15 files force nothing', files: files(15), want: null },
      { name: '400 lines force nothing', files: [file('a.ts', 200, 200)], want: null },
      {
        name: 'an ordinary file in a hidden folder forces nothing',
        files: [file('tools/.scripts/run.ts', 1, 1), file('.eslintrc.js', 1, 1)],
        want: null,
      },
      {
        name: 'an ordinary source file and a README force nothing',
        files: [file('src/a.ts', 1, 1), file('README.md', 1, 1)],
        want: null,
      },
    ]);
  });
});

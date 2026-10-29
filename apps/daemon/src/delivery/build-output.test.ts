import { describe, expect, it } from 'vitest';
import { isBuildOutput } from './build-output';

describe('isBuildOutput', () => {
  it.each<{ name: string; file: string; output: boolean }>([
    { name: "the typecheck's build info", file: 'tsconfig.tsbuildinfo', output: true },
    {
      name: "a package's build info",
      file: 'apps/daemon/tsconfig.build.tsbuildinfo',
      output: true,
    },
    { name: "eslint's cache", file: '.eslintcache', output: true },
    { name: "a package's eslint cache", file: 'apps/web/.eslintcache', output: true },
    { name: 'a hand-made .env', file: '.env', output: false },
    { name: 'local settings', file: '.claude/settings.local.json', output: false },
    { name: 'a personal mise file', file: 'mise.local.toml', output: false },
    { name: 'a log the builder may still need', file: 'debug.log', output: false },
    // A wholly ignored output directory never reaches here: git lists it as one entry.
    { name: 'a file under a directory named dist', file: 'dist/out.js', output: false },
    {
      name: 'a local env file in a tracked directory named coverage',
      file: 'packages/coverage/.env.local',
      output: false,
    },
    { name: 'a capitalised suffix', file: 'tsconfig.TSBUILDINFO', output: false },
    { name: 'build info that is not the suffix', file: 'notes.tsbuildinfo.md', output: false },
    { name: 'a name that only ends like the cache', file: 'my.eslintcache', output: false },
  ])('$name ($file): $output', ({ file, output }) => {
    expect(isBuildOutput(file)).toBe(output);
  });
});

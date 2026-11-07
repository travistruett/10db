import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace';

/** Non-test source that must never name a model: the catalogue and the accounts' lists say which exist. */
const SOURCE = [
  'apps/*/src/**/*.{ts,tsx}',
  'apps/daemon/scripts/**/*.ts',
  'packages/*/src/**/*.{ts,tsx}',
];

/** Test code and the helpers only tests import, which name models freely. */
const TEST_CODE =
  /\.test\.tsx?$|(^|[-/])fixtures?\.tsx?$|-fixtures?\.tsx?$|-test-support\.ts$|\/test\//;

/** A Claude Code alias, or an ID in the shape of Anthropic's, OpenAI's, Google's or Meta's. */
const MODEL_NAME =
  /\b(opus|sonnet|haiku|fable|claude-(?:opus|sonnet|haiku|fable|[0-9])[a-z0-9.-]*|chatgpt-[0-9][a-z0-9.-]*|gpt-(?:[0-9]|oss)[a-z0-9.-]*|o[0-9](?:-[a-z0-9.-]+)?|gemini-[a-z0-9.-]+|llama-?[0-9][a-z0-9.-]*)\b/gi;

interface Allowed {
  readonly file: string;
  /** The names the file may hold, lowercase. */
  readonly names: readonly string[];
  readonly reason: string;
}

/** Where a model name is the point of the code, each with why. */
const ALLOWED: readonly Allowed[] = [
  {
    file: 'apps/daemon/src/shape/confinement.ts',
    names: ['opus', 'fable', 'sonnet', 'haiku'],
    reason:
      'the aliases Claude Code’s own Agent tool takes: they are its vocabulary, not a model 10db chose',
  },
];

function namesIn(file: string): Set<string> {
  return new Set(
    [...readFileSync(`${repoRoot}/${file}`, 'utf8').matchAll(MODEL_NAME)].map((m) =>
      m[0].toLowerCase(),
    ),
  );
}

const sources = globSync(SOURCE, { cwd: repoRoot })
  .filter((file) => !TEST_CODE.test(file) && !file.includes('node_modules'))
  .sort();

describe('model names in source', () => {
  it('names no model outside the allowlist: the catalogue says which exist', () => {
    const stray = sources.flatMap((file) => {
      const allowed = new Set(ALLOWED.find((entry) => entry.file === file)?.names);
      return [...namesIn(file)]
        .filter((name) => !allowed.has(name))
        .map((name) => `${file}: ${name}`);
    });
    expect(stray).toEqual([]);
  });

  it.each(ALLOWED)('still needs its allowlist entry for $file ($reason)', ({ file, names }) => {
    expect(sources).toContain(file);
    expect([...namesIn(file)].sort()).toEqual([...names].sort());
  });
});

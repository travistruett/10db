import { createShikiAdapter, type CodeHighlightAdapter } from '@mantine/code-highlight';
import type { LanguageRegistration } from 'shiki/core';
import { SELENIZED_SHIKI_THEMES } from './selenized-shiki';

// Fences highlight through Shiki's core with its JavaScript regex engine: the window's CSP allows
// neither WebAssembly nor eval, which the Oniguruma engine needs. Each grammar loads on first use.
// Mantine's adapter hands Shiki its own GitHub theme objects for "light" and "dark", and any other
// scheme name through as a theme name, so `selenizedAdapter` asks for the Selenized themes by name.

type GrammarModule = Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  sql: () => import('@shikijs/langs/sql'),
  rust: () => import('@shikijs/langs/rust'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  diff: () => import('@shikijs/langs/diff'),
} as const satisfies Record<string, () => GrammarModule>;

const ALIASES = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  md: 'markdown',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
} as const satisfies Record<string, keyof typeof GRAMMARS>;

/**
 * A fence's language to the lazy import of its grammar. A Map, since the language is the agent's
 * text and a plain object would answer `constructor` or `__proto__`.
 */
const SHIKI_LANGUAGES: ReadonlyMap<string, () => GrammarModule> = new Map([
  ...Object.entries(GRAMMARS),
  ...Object.entries(ALIASES).map(([alias, name]) => [alias, GRAMMARS[name]] as const),
]);

/** The Shiki theme name for each of Mantine's color schemes. */
const THEME_OF_SCHEME = { dark: 'selenized-dark', light: 'selenized-light' } as const;

async function loadShiki() {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ]);
  return createHighlighterCore({
    themes: [...SELENIZED_SHIKI_THEMES],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}

const base = createShikiAdapter(loadShiki, {
  resolveLanguage: (language: string) => SHIKI_LANGUAGES.get(language.toLowerCase()),
});

/** Mantine's Shiki adapter, drawing in the Selenized theme of the current scheme. */
export const shikiAdapter: CodeHighlightAdapter = {
  ...base,
  getHighlighter: (ctx) => {
    const highlight = base.getHighlighter(ctx);
    return (input) =>
      highlight({
        ...input,
        colorScheme: input.colorScheme === 'light' ? THEME_OF_SCHEME.light : THEME_OF_SCHEME.dark,
      });
  },
};

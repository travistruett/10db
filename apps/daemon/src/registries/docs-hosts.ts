import { z } from 'zod';
import type { PackageFileFormat } from './package-file-formats';

/**
 * The documentation host of well-known npm packages, by package name or by `@scope/`. It is 10db's
 * own table, not a reading of what a manifest says about itself: a lane can write `package.json`, so
 * a `homepage` or a URL in it never reaches a read list. All a lane can do is name a package, and
 * that picks a host from this table.
 */
export const DOCS_HOSTS_BY_PACKAGE: Readonly<Record<string, string>> = {
  '@angular/': 'angular.dev',
  '@mantine/': 'mantine.dev',
  '@mui/': 'mui.com',
  '@playwright/': 'playwright.dev',
  '@prisma/': 'www.prisma.io',
  '@reduxjs/': 'redux.js.org',
  '@sveltejs/': 'svelte.dev',
  '@tanstack/': 'tanstack.com',
  '@tauri-apps/': 'tauri.app',
  astro: 'docs.astro.build',
  axios: 'axios-http.com',
  'drizzle-kit': 'orm.drizzle.team',
  'drizzle-orm': 'orm.drizzle.team',
  electron: 'www.electronjs.org',
  esbuild: 'esbuild.github.io',
  eslint: 'eslint.org',
  express: 'expressjs.com',
  fastify: 'fastify.dev',
  hono: 'hono.dev',
  jest: 'jestjs.io',
  lodash: 'lodash.com',
  msw: 'mswjs.io',
  next: 'nextjs.org',
  nuxt: 'nuxt.com',
  playwright: 'playwright.dev',
  pnpm: 'pnpm.io',
  prettier: 'prettier.io',
  prisma: 'www.prisma.io',
  react: 'react.dev',
  'react-dom': 'react.dev',
  redux: 'redux.js.org',
  rollup: 'rollupjs.org',
  storybook: 'storybook.js.org',
  svelte: 'svelte.dev',
  tailwindcss: 'tailwindcss.com',
  typescript: 'www.typescriptlang.org',
  vite: 'vite.dev',
  vitest: 'vitest.dev',
  vue: 'vuejs.org',
  webpack: 'webpack.js.org',
  zod: 'zod.dev',
};

/** Every npm package has a page here, and JavaScript's own reference is here. */
const NPM_GENERAL_HOSTS = ['www.npmjs.com', 'developer.mozilla.org'] as const;

const Dependencies = z.record(z.string(), z.unknown());
const Manifest = z.looseObject({
  dependencies: Dependencies.optional().catch(undefined),
  devDependencies: Dependencies.optional().catch(undefined),
  peerDependencies: Dependencies.optional().catch(undefined),
  optionalDependencies: Dependencies.optional().catch(undefined),
});

function parseManifest(text: string): z.infer<typeof Manifest> | null {
  try {
    return Manifest.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

function docsHostOf(name: string): string | undefined {
  const slash = name.indexOf('/');
  const key = name.startsWith('@') && slash > 0 ? name.slice(0, slash + 1) : name;
  return Object.hasOwn(DOCS_HOSTS_BY_PACKAGE, key) ? DOCS_HOSTS_BY_PACKAGE[key] : undefined;
}

/**
 * The documentation hosts of the dependencies a `package.json` names: the hosts of the npm world, and
 * the table's host for each package it knows. Only the names of dependencies are read.
 */
export function docsHostsOfPackageJson(text: string): string[] {
  const manifest = parseManifest(text);
  if (manifest === null) return [];
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  const hosts = names.flatMap((name) => docsHostOf(name) ?? []);
  return [...new Set([...NPM_GENERAL_HOSTS, ...hosts])];
}

/** The files that say which dependencies a project has, and where those are documented. */
export const DOCS_FORMATS: readonly PackageFileFormat[] = [
  { path: 'package.json', hosts: docsHostsOfPackageJson },
  { path: 'Cargo.toml', hosts: () => ['docs.rs'] },
  { path: 'go.mod', hosts: () => ['pkg.go.dev'] },
  { path: 'pyproject.toml', hosts: () => ['pypi.org'] },
  { path: 'requirements.txt', hosts: () => ['pypi.org'] },
];

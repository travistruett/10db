import { hostOfUrl } from './host-of-url';

/*
 * The files are read on the daemon's only thread and a lane may have written them, so every pattern
 * here takes time linear in the text. Wherever two repeated parts of a pattern can meet, no character
 * matches both, so a failed match never tries another split of the same run. A pattern run at every
 * line start of a file (the `m` flag) never opens with `\s*`, which matches a line end too: tried at
 * each line of a run of blank lines, it would read to the end of the run every time. It opens with
 * `[ \t]*` or a word.
 */

/** What a file's reader is told about the folder it lies in. */
export interface FolderContext {
  /** True when an `.npmrc` or `.yarnrc.yml` in this folder or the project root names a registry. */
  readonly npmRegistryNamed: boolean;
}

/** One kind of file that names hosts, read as text and never run. */
export interface PackageFileFormat {
  /** The file's path relative to the folder it is read from. */
  readonly path: string;
  /** The hosts the file names, as host names with no port, path or credentials. */
  hosts(text: string, folder: FolderContext): string[];
}

const CRATES_INDEX = 'https://github.com/rust-lang/crates.io-index';
/** The two hosts cargo reads crates.io through: the sparse index and the downloads. */
const CRATES_HOSTS = ['index.crates.io', 'static.crates.io'] as const;
const PYPI_HOSTS = ['pypi.org', 'files.pythonhosted.org'] as const;

/** Group 1 of every match of `pattern` (which must be global). */
function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

function hostsOfUrls(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    const host = hostOfUrl(url);
    return host === null ? [] : [host];
  });
}

/** A cargo registry or source: crates.io in either form is the two hosts cargo reads, others their own host. */
function cargoHosts(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    if (url.replace(/^registry\+/, '').replace(/\/$/, '') === CRATES_INDEX)
      return [...CRATES_HOSTS];
    const host = hostOfUrl(url);
    if (host === null) return [];
    return host === 'index.crates.io' ? [...CRATES_HOSTS] : [host];
  });
}

/** A `key = value` line of an INI file, and the indented lines that continue its value. */
function iniValues(text: string, keys: ReadonlySet<string>): string[] {
  const values: string[] = [];
  let reading = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s+\S/.test(line) && reading) {
      values.push(line.trim());
      continue;
    }
    // The value is cut off the line, not matched: in a line holding a lone carriage return, which `.`
    // stops at, `\s*(.*)$` tries every split of the spaces before the value, reading on each time.
    const key = /^([\w.-]+)\s*[=:]/.exec(line);
    reading = key?.[1] !== undefined && keys.has(key[1].toLowerCase());
    if (reading && key !== null) values.push(line.slice(key[0].length).trim());
  }
  return values.flatMap((value) => value.split(/[\s,]+/)).filter((token) => token !== '');
}

/** A TOML line with its `#` comment removed; a `#` inside a quoted string stays. */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** A table's name as its header holds it: a dotted name of words, quotes and spaces. */
const TABLE_NAME = /^[\w.\-"' ]+$/;

/**
 * The name in a TOML table header, `[name]` or `[[name]]`, or null when the line is not one. A header
 * holds a dotted name only, so an array of arrays on its own line is not one. The spaces around the
 * name are trimmed off before it is checked: a pattern that weighed where they end against a name
 * that may hold spaces would backtrack over a line of them.
 */
function tableHeader(line: string): string | null {
  const trimmed = line.trim();
  const brackets = trimmed.startsWith('[[') && trimmed.endsWith(']]') ? 2 : 1;
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || trimmed.length <= 2 * brackets) {
    return null;
  }
  const name = trimmed.slice(brackets, -brackets).trim();
  return TABLE_NAME.test(name) ? name : null;
}

/**
 * The lines of each table `inTable` chooses, without comments, one body per table: from its header to
 * the next (`''` names the lines before the first header). Lines of other tables are not kept.
 */
function chosenTables(text: string, inTable: (name: string) => boolean): string[] {
  const bodies: string[] = [];
  let lines: string[] | null = inTable('') ? [] : null;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw);
    const name = tableHeader(line);
    if (name === null) {
      lines?.push(line);
      continue;
    }
    if (lines !== null && lines.length > 0) bodies.push(lines.join('\n'));
    lines = inTable(name) ? [] : null;
  }
  if (lines !== null && lines.length > 0) bodies.push(lines.join('\n'));
  return bodies;
}

const TOML_STRING = String.raw`"[^"\n]*"|'[^'\n]*'`;
/**
 * A `key = value` pair whose value is a string or an array of strings, over several lines if need be:
 * at the start of a line, after a dotted key's `.`, or inside an inline table such as
 * `corp = { index = "…" }` or `index = [{ name = "corp", url = "…" }]`.
 */
const TOML_PAIR = new RegExp(
  String.raw`(?:^|[\s{,.])([\w-]+)\s*=\s*(${TOML_STRING}|\[\s*(?:(?:${TOML_STRING})\s*(?:,\s*)?)*\])`,
  'g',
);

/** The string values, or the strings of the array values, of the keys named in the tables chosen. */
function tomlUrls(
  text: string,
  inTable: (name: string) => boolean,
  keys: ReadonlySet<string>,
): string[] {
  return chosenTables(text, inTable)
    .flatMap((body) => [...body.matchAll(TOML_PAIR)])
    .flatMap(([, key, value]) =>
      key !== undefined && value !== undefined && keys.has(key)
        ? [...value.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((m) => m[1] ?? m[2] ?? '')
        : [],
    );
}

const anyTable = (): boolean => true;

const npmDefault = (folder: FolderContext): string[] =>
  folder.npmRegistryNamed ? [] : ['registry.npmjs.org'];

const NPM_URL = /"resolved"\s*:\s*"([^"]+)"/g;
const PNPM_URL = /\b(?:tarball|repo)\s*:\s*["']?([^\s"',}]+)/g;
const YARN_URL = /^[ \t]*resolved:?[ \t]+"?([^"\s]+)/gm;
const CARGO_SOURCE = /^[ \t]*source[ \t]*=[ \t]*"([^"\r\n]+)"/gm;
/** The `.cargo/config.toml` keys that hold a registry, a replaced source or a git URL, in any table. */
const CARGO_KEYS: ReadonlySet<string> = new Set(['index', 'registry', 'git']);
const UV_URL = /\b(?:registry|url|git)\s*=\s*"([^"]+)"/g;
const POETRY_URL = /^url[ \t]*=[ \t]*"([^"\r\n]+)"/gm;
const GEM_REMOTE = /^[ \t]*remote:[ \t]*(\S+)/gm;
const NPMRC_REGISTRY = /^[ \t]*(?:@[\w.-]+:)?registry[ \t]*=[ \t]*(\S+)/gm;
/** The key of an `.npmrc` setting for one registry, `//host/path/:setting=`; its value is never read. */
const NPMRC_REGISTRY_KEY = /^[ \t]*\/\/([^\s=]+)[ \t]*=/gm;
/** An `.npmrc` `registry=` with no scope: the registry npm and pnpm fetch every package from. */
const NPMRC_DEFAULT_REGISTRY = /^[ \t]*registry[ \t]*=[ \t]*\S/m;
/** Every `npmRegistryServer` of a `.yarnrc.yml`: the top-level one and those under `npmScopes`. */
const YARNRC_REGISTRY = /^[ \t]*npmRegistryServer[ \t]*:[ \t]*["']?([^"'\s]+)/gm;
/** Only an unindented `npmRegistryServer` replaces the default; a scoped one serves its scope alone. */
const YARNRC_DEFAULT_REGISTRY = /^npmRegistryServer[ \t]*:[ \t]*["']?[^"'\s]/m;

/**
 * The registry an `.npmrc` key such as `//npm.example.com/path/:_authToken` is a setting for, as
 * `//host`, or null when the key is not of that form. The key is taken apart with string operations:
 * a pattern that weighed where the host ends against where the setting's name starts would backtrack.
 */
function npmrcKeyRegistry(key: string): string | null {
  const colon = key.lastIndexOf(':');
  if (colon === -1 || !/^[\w-]+$/.test(key.slice(colon + 1))) return null;
  const host = key.slice(0, key.search(/[/:]/));
  return host === '' ? null : `//${host}`;
}

const PIP_KEYS: ReadonlySet<string> = new Set(['index-url', 'extra-index-url', 'find-links']);
const PIP_HOST_KEYS: ReadonlySet<string> = new Set(['trusted-host']);
const PYPROJECT_SECTIONS: ReadonlySet<string> = new Set([
  'tool.uv',
  'tool.uv.index',
  'tool.uv.pip',
  'tool.poetry.source',
  'tool.pdm.source',
]);
const UV_TOML_SECTIONS: ReadonlySet<string> = new Set(['', 'index', 'pip']);
const INDEX_KEYS: ReadonlySet<string> = new Set([
  'url',
  'index-url',
  'extra-index-url',
  'find-links',
]);

/** The settings files, read before the lockfiles in the same folder. */
export const CONFIG_FORMATS: readonly PackageFileFormat[] = [
  {
    path: '.npmrc',
    hosts: (text) =>
      hostsOfUrls([
        ...captures(text, NPMRC_REGISTRY),
        ...captures(text, NPMRC_REGISTRY_KEY).flatMap((key) => npmrcKeyRegistry(key) ?? []),
      ]),
  },
  { path: '.yarnrc.yml', hosts: (text) => hostsOfUrls(captures(text, YARNRC_REGISTRY)) },
  { path: '.cargo/config.toml', hosts: (text) => cargoHosts(tomlUrls(text, anyTable, CARGO_KEYS)) },
  { path: '.cargo/config', hosts: (text) => cargoHosts(tomlUrls(text, anyTable, CARGO_KEYS)) },
  {
    path: 'pip.conf',
    hosts: (text) => [
      ...hostsOfUrls(iniValues(text, PIP_KEYS)),
      ...hostsOfUrls(iniValues(text, PIP_HOST_KEYS).map((h) => `https://${h}`)),
    ],
  },
  {
    path: 'pip.ini',
    hosts: (text) => [
      ...hostsOfUrls(iniValues(text, PIP_KEYS)),
      ...hostsOfUrls(iniValues(text, PIP_HOST_KEYS).map((h) => `https://${h}`)),
    ],
  },
  {
    path: 'pyproject.toml',
    hosts: (text) => hostsOfUrls(tomlUrls(text, (t) => PYPROJECT_SECTIONS.has(t), INDEX_KEYS)),
  },
  {
    path: 'uv.toml',
    hosts: (text) => hostsOfUrls(tomlUrls(text, (t) => UV_TOML_SECTIONS.has(t), INDEX_KEYS)),
  },
];

/** The lockfiles and toolchain files. */
export const LOCK_FORMATS: readonly PackageFileFormat[] = [
  {
    path: 'package-lock.json',
    hosts: (text, folder) => [...npmDefault(folder), ...hostsOfUrls(captures(text, NPM_URL))],
  },
  {
    path: 'npm-shrinkwrap.json',
    hosts: (text, folder) => [...npmDefault(folder), ...hostsOfUrls(captures(text, NPM_URL))],
  },
  {
    path: 'pnpm-lock.yaml',
    hosts: (text, folder) => [...npmDefault(folder), ...hostsOfUrls(captures(text, PNPM_URL))],
  },
  {
    path: 'yarn.lock',
    hosts: (text, folder) => [
      ...(folder.npmRegistryNamed ? [] : ['registry.yarnpkg.com']),
      ...hostsOfUrls(captures(text, YARN_URL)),
    ],
  },
  { path: 'Cargo.lock', hosts: (text) => cargoHosts(captures(text, CARGO_SOURCE)) },
  {
    path: 'uv.lock',
    hosts: (text) => hostsOfUrls(captures(text, UV_URL)),
  },
  {
    path: 'poetry.lock',
    hosts: (text) => [...PYPI_HOSTS, ...hostsOfUrls(captures(text, POETRY_URL))],
  },
  { path: 'Gemfile.lock', hosts: (text) => hostsOfUrls(captures(text, GEM_REMOTE)) },
  { path: 'go.sum', hosts: () => ['proxy.golang.org', 'sum.golang.org'] },
  { path: 'rust-toolchain.toml', hosts: () => ['static.rust-lang.org'] },
  { path: 'rust-toolchain', hosts: () => ['static.rust-lang.org'] },
  { path: '.nvmrc', hosts: () => ['nodejs.org'] },
  { path: '.node-version', hosts: () => ['nodejs.org'] },
];

/**
 * True when the text of an `.npmrc` or `.yarnrc.yml` names a default registry: an `.npmrc`
 * `registry=` with no scope, or a top-level `npmRegistryServer`. A scoped one doesn't count.
 */
export function namesNpmRegistry(text: string): boolean {
  return NPMRC_DEFAULT_REGISTRY.test(text) || YARNRC_DEFAULT_REGISTRY.test(text);
}

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './workspace';

const script = join(repoRoot, 'scripts/release/fetch-catalogue.mjs');

const model = (id: string) => ({ id, name: id, cost: { input: 1, output: 5 } });
const provider = (id: string) => ({ id: `${id}-provider`, models: { [id]: model(id) } });
/** models.dev's shape: a provider per key, and others the daemon does not keep. */
const document = (over: Record<string, unknown> = {}) => ({
  anthropic: provider('claude-x'),
  openai: provider('gpt-x'),
  'amazon-bedrock': provider('anthropic.claude-x'),
  openrouter: provider('vendor/x'),
  mistral: provider('mistral-x'),
  ...over,
});

let server: Server;
let base = '';
/** What the next request is answered with. */
let reply: { status: number; body: string } = { status: 200, body: '' };
let dir = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-catalogue-'));
  server = createServer((_request, response) => {
    response.statusCode = reply.status;
    response.end(reply.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  base =
    typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : '';
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

function run(args: readonly string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => {
      done({ status, stderr });
    });
  });
}

let counter = 0;
const outFile = () => join(dir, `snapshot-${String(++counter)}.json`);

describe('fetch-catalogue.mjs', () => {
  it('writes the four providers the daemon keeps, and the others by name only', async () => {
    reply = { status: 200, body: JSON.stringify(document()) };
    const out = outFile();
    const result = await run([out, base]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    // The daemon names a Bedrock model's maker by the providers the document lists, so the snapshot keeps every
    // key, with nothing under the ones it does not read.
    expect(Object.keys(written).sort()).toEqual(
      ['amazon-bedrock', 'anthropic', 'mistral', 'openai', 'openrouter'].sort(),
    );
    expect(written['mistral']).toEqual({});
    expect(written['anthropic']).toEqual(provider('claude-x'));
  });

  it.each<{ name: string; status: number; body: string; message: RegExp }>([
    { name: 'the request fails', status: 500, body: 'down', message: /500/ },
    { name: 'the answer is not JSON', status: 200, body: '<html>', message: /not JSON/ },
    { name: 'the answer is a list', status: 200, body: '[]', message: /not an object/ },
    {
      name: 'a provider is missing',
      status: 200,
      body: JSON.stringify({ ...document(), openai: undefined }),
      message: /openai/,
    },
    {
      name: 'a provider has no models',
      status: 200,
      body: JSON.stringify(document({ anthropic: { models: {} } })),
      message: /anthropic/,
    },
    {
      name: 'a provider’s models are not entries with an ID',
      status: 200,
      body: JSON.stringify(document({ openrouter: { models: { x: { name: 'no id' } } } })),
      message: /openrouter/,
    },
    {
      name: 'a provider’s models all lack a name, which the daemon would reject',
      status: 200,
      body: JSON.stringify(document({ openai: { models: { x: { id: 'x' } } } })),
      message: /openai/,
    },
  ])('fails the build and writes nothing when $name', async ({ status, body, message }) => {
    reply = { status, body };
    const out = outFile();
    const result = await run([out, base]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });

  it('says how to call it when it has no output path', async () => {
    const result = await run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});

describe('what the release carries of the catalogue', () => {
  const providersIn = (text: string, pattern: RegExp): string[] => {
    const list = pattern.exec(text)?.[1] ?? '';
    return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
  };

  it('keeps the providers the daemon reads, no more and no fewer', () => {
    expect(
      providersIn(readRepoFile('scripts/release/fetch-catalogue.mjs'), /PROVIDERS = \[([^\]]*)\]/),
    ).toEqual(
      providersIn(
        readRepoFile('apps/daemon/src/catalogue/source.ts'),
        /CATALOGUE_PROVIDERS = \[([^\]]*)\]/,
      ),
    );
  });

  it('writes the snapshot where the daemon reads it, beside its bundle, from this build only', () => {
    const file = /CATALOGUE_SNAPSHOT_FILE = '([^']+)'/.exec(
      readRepoFile('apps/daemon/src/catalogue/snapshot.ts'),
    )?.[1];
    expect(file).toBe('catalogue-snapshot.json');
    // The release fetches outside the bundle dir and names the file to the daemon's build step.
    expect(readRepoFile('scripts/release/build-macos.sh')).toContain(
      `export TENDB_RELEASE_CATALOGUE_SNAPSHOT="$out/${file ?? ''}"`,
    );
    // That the step carries it, and only it, apps/daemon/test/bundle.test.ts checks through the real build.
    expect(readRepoFile('apps/daemon/scripts/build.ts')).toContain(
      'TENDB_RELEASE_CATALOGUE_SNAPSHOT',
    );
  });

  it('fetches before the build and lets a failed fetch stop it', () => {
    const build = readRepoFile('scripts/release/build-macos.sh');
    const fetch = build.indexOf('fetch-catalogue.mjs');
    expect(fetch).toBeGreaterThan(0);
    expect(fetch).toBeLessThan(build.indexOf('tauri build'));
    expect(build).toMatch(/set -euo pipefail/);
  });

  it('keeps the snapshot out of the repository', () => {
    expect(readRepoFile('.gitignore')).toMatch(/^apps\/desktop\/src-tauri\/resources\/$/m);
  });
});

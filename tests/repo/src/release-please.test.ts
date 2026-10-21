import { join } from 'node:path';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { environmentOf, readWorkflow, releaseWorkflowPaths, stepsOf } from './workflow-yaml';
import { readRepoFile, repoRoot } from './workspace';

interface ReleasePleaseConfig {
  readonly packages: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly [option: string]: unknown;
}

// The file is repo-owned and the tests below pin its options.
const config = JSON.parse(readRepoFile('release-please-config.json')) as ReleasePleaseConfig;
const options: Readonly<Record<string, unknown>> = { ...config, ...config.packages['.'] };
const ignorePath = join(repoRoot, '.prettierignore');

async function prettierClean(path: string, text: string): Promise<boolean> {
  const filepath = join(repoRoot, path);
  if ((await prettier.getFileInfo(filepath, { ignorePath })).ignored) return true;
  const resolved = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.check(text, { ...resolved, filepath });
}

describe('release-please config', () => {
  it('releases the root package only', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(options['release-type']).toBe('node');
  });

  it('tags plain vX.Y.Z, which is what release.yml listens for', () => {
    expect(options['include-component-in-tag']).toBe(false);
    expect(options['include-v-in-tag']).toBe(true);
  });

  it('starts at 0.1.0, and a breaking change before 1.0 bumps the minor version', () => {
    expect(options['initial-version']).toBe('0.1.0');
    expect(options['bump-minor-pre-major']).toBe(true);
  });

  it('creates a draft release and its tag at once', () => {
    expect(options['draft']).toBe(true);
    expect(options['force-tag-creation']).toBe(true);
  });

  it('titles the Release PR as a Conventional Commit with an allowed scope', () => {
    expect(options['pull-request-title-pattern']).toBe('chore(repo): release ${version}');
  });

  it('bumps the desktop app version files with the root version', () => {
    expect(options['extra-files']).toEqual([
      { type: 'json', path: 'apps/desktop/src-tauri/tauri.conf.json', jsonpath: '$.version' },
      { type: 'toml', path: 'apps/desktop/src-tauri/Cargo.toml', jsonpath: '$.package.version' },
      {
        type: 'toml',
        path: 'apps/desktop/src-tauri/Cargo.lock',
        jsonpath: "$.package[?(@.name.value == 'tendb-desktop')].version",
      },
    ]);
  });
});

describe('files release-please rewrites', () => {
  it.each([
    'package.json',
    '.release-please-manifest.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  ])('%s stays Prettier-clean after release-please re-serializes it', async (path) => {
    const rewritten = `${JSON.stringify(JSON.parse(readRepoFile(path)), null, 2)}\n`;
    expect(await prettierClean(path, rewritten), `${path}: list it in .prettierignore`).toBe(true);
  });

  it('keeps CHANGELOG.md out of Prettier, because release-please writes * bullets', async () => {
    expect(
      (await prettier.getFileInfo(join(repoRoot, 'CHANGELOG.md'), { ignorePath })).ignored,
    ).toBe(true);
  });
});

describe('release-please workflow', () => {
  const workflow = readWorkflow(releaseWorkflowPaths.releasePlease);
  const job = workflow.jobs['release-please'];
  const steps = stepsOf(job);
  const appToken = steps.find(
    (step) => step.uses?.startsWith('actions/create-github-app-token@') === true,
  );
  const releasePlease = steps.find(
    (step) => step.uses?.startsWith('googleapis/release-please-action@') === true,
  );

  it('runs on pushes to main only', () => {
    expect(workflow.on).toEqual({ push: { branches: ['main'] } });
  });

  it('reads the bot key only inside the main-only release-bot environment', () => {
    expect(environmentOf(job)).toBe('release-bot');
  });

  it('grants GITHUB_TOKEN nothing, because the app token does the work', () => {
    expect(workflow.permissions).toEqual({});
    expect(job?.permissions).toEqual({});
  });

  it('mints a 10db-release-bot token with only the permissions release-please needs', () => {
    expect(appToken?.with).toEqual({
      'client-id': '${{ secrets.RELEASE_BOT_CLIENT_ID }}',
      'private-key': '${{ secrets.RELEASE_BOT_PRIVATE_KEY }}',
      'permission-contents': 'write',
      'permission-issues': 'write',
      'permission-pull-requests': 'write',
    });
  });

  it('passes that token to release-please', () => {
    expect(appToken?.id).toBe('app-token');
    expect(releasePlease?.with).toEqual({ token: '${{ steps.app-token.outputs.token }}' });
  });
});
